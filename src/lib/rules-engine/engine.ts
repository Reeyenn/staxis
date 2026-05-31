/**
 * Engine orchestrator. The public surface is just two functions:
 *
 *   runRulesEngineForProperty(propertyId, opts)
 *   runRulesEngineForAllProperties(opts)
 *
 * The flow for one property:
 *   1. Build the property context (timezone, business_date, day_of_week).
 *   2. Build a RoomContext per room with overlapping reservations or
 *      a PMS HK plan entry for today.
 *   3. Evaluate every rule against each context (pure functions).
 *   4. Merge the fires into a MergedTaskSpec.
 *   5. Partition into three write buckets:
 *        - insert : no existing row (bulk INSERT with ON CONFLICT DO NOTHING)
 *        - update : existing row whose status is engine-mutable (per-row
 *                   UPDATE with a `status IN (mutable)` filter — atomic)
 *        - bump   : existing row whose status is not mutable (bulk UPDATE
 *                   of only last_evaluated_at)
 *      The per-row UPDATE in the `update` bucket closes the TOCTOU race
 *      that bulk upsert had: a housekeeper marking a task in_progress
 *      between the SELECT and the write can no longer be clobbered, because
 *      the WHERE clause filters them out at the row-lock level.
 *
 * Idempotency: identical inputs produce identical rows (same dedupe_key,
 * same cleaning_type, same rules_fired). Re-running on stable PMS state
 * is a no-op from the data perspective (only last_evaluated_at moves).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { fetchCleanTimeStandardsIndex } from '@/lib/clean-time-standards-server';

import {
  ENGINE_MUTABLE_STATUSES,
  type TaskStatus,
} from '@/types/cleaning-tasks';

import { buildPropertyContext, buildRoomContexts } from './context';
import {
  contextToTaskRow,
  mergePartials,
  newEngineRunId,
  type CleaningTaskUpsertRow,
} from './merger';
import { evaluateRoomRules } from './rules';

export interface RoomEngineOutcome {
  room_number: string;
  outcome: 'upserted' | 'skipped_in_progress' | 'no_task' | 'error';
  cleaning_type?: string;
  priority?: string;
  rules_fired?: string[];
  error?: string;
}

export interface PropertyRunResult {
  property_id: string;
  business_date: string;
  engine_run_id: string;
  rooms_evaluated: number;
  /** Rows that landed in the DB on this run — incremented only AFTER the
   *  INSERT / UPDATE returns success. A queued-but-not-written row never
   *  counts. (Post-merge sweep fix: Codex Finding #5.) */
  tasks_upserted: number;
  tasks_skipped_in_progress: number;
  rooms_no_task: number;
  errors: Array<{ room_number: string; error: string }>;
  duration_ms: number;
  /** Per-room outcomes — included only when opts.verbose is true. */
  outcomes: RoomEngineOutcome[];
  dry_run: boolean;
}

export interface EngineOptions {
  /** Override "now" for testing. */
  now?: Date;
  /** When true, evaluate rules but do not write to the database. */
  dryRun?: boolean;
  /** When true, return per-room outcomes alongside the summary. */
  verbose?: boolean;
}

export async function runRulesEngineForProperty(
  propertyId: string,
  opts: EngineOptions = {},
): Promise<PropertyRunResult> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const verbose = opts.verbose === true;
  const engineRunId = newEngineRunId();

  const prop = await buildPropertyContext(propertyId, now);
  if (!prop) {
    return {
      property_id: propertyId,
      business_date: '',
      engine_run_id: engineRunId,
      rooms_evaluated: 0,
      tasks_upserted: 0,
      tasks_skipped_in_progress: 0,
      rooms_no_task: 0,
      errors: [{ room_number: '*', error: 'property not found' }],
      duration_ms: Date.now() - t0,
      outcomes: [],
      dry_run: dryRun,
    };
  }

  const roomContexts = await buildRoomContexts(prop);
  // Manager-set Clean Times standards (migration 0244). Fetched once per
  // property run and handed to the merger so newly-created tasks use the
  // property's edited base minutes. Degrades to {} (→ legacy static
  // defaults) if the table isn't present yet or the read errors.
  const cleanTimeIndex = await fetchCleanTimeStandardsIndex(propertyId);
  const dedupeKeys = roomContexts.map(
    (c) => `${c.room_number}::${prop.business_date}`,
  );
  const existingByKey = await fetchExistingTaskStatuses(propertyId, dedupeKeys);

  let skippedInProgress = 0;
  let noTask = 0;
  const errors: Array<{ room_number: string; error: string }> = [];
  const outcomes: RoomEngineOutcome[] = [];
  const rowsToInsert: CleaningTaskUpsertRow[] = [];
  const rowsToUpdate: CleaningTaskUpsertRow[] = [];
  const keysToBump: string[] = [];
  // Verbose outcomes for the update bucket are filled in AFTER the DB call,
  // because the atomic UPDATE can drop rows (status changed to non-mutable
  // between the SELECT and the UPDATE) — we only know the real outcome
  // post-write. Map dedupe_key → planned outcome so we can patch later.
  const pendingUpdateOutcomes = new Map<string, RoomEngineOutcome>();

  for (const ctx of roomContexts) {
    try {
      const fires = evaluateRoomRules(ctx);
      const spec = mergePartials(fires, ctx, cleanTimeIndex);
      if (!spec) {
        noTask++;
        if (verbose) {
          outcomes.push({ room_number: ctx.room_number, outcome: 'no_task' });
        }
        continue;
      }

      const dedupeKey = `${ctx.room_number}::${prop.business_date}`;
      const existing = existingByKey.get(dedupeKey);
      if (
        existing &&
        !ENGINE_MUTABLE_STATUSES.includes(existing.status as TaskStatus)
      ) {
        skippedInProgress++;
        keysToBump.push(dedupeKey);
        if (verbose) {
          outcomes.push({
            room_number: ctx.room_number,
            outcome: 'skipped_in_progress',
            cleaning_type: spec.cleaning_type,
          });
        }
        continue;
      }

      const row = contextToTaskRow(ctx, spec, engineRunId);
      if (existing) {
        rowsToUpdate.push(row);
      } else {
        rowsToInsert.push(row);
      }
      if (verbose) {
        pendingUpdateOutcomes.set(dedupeKey, {
          room_number: ctx.room_number,
          outcome: 'upserted',
          cleaning_type: spec.cleaning_type,
          priority: spec.priority,
          rules_fired: spec.rules_fired.map((r) => r.id),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ room_number: ctx.room_number, error: msg });
      if (verbose) {
        outcomes.push({
          room_number: ctx.room_number,
          outcome: 'error',
          error: msg,
        });
      }
    }
  }

  let upserted = 0;
  if (!dryRun) {
    // ─── Bucket 1: INSERT new rows ─────────────────────────────────────
    // ON CONFLICT DO NOTHING (`ignoreDuplicates: true`) handles the race
    // where another process inserted a row in the window between our
    // SELECT and our INSERT.
    if (rowsToInsert.length > 0) {
      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from('cleaning_tasks')
        .upsert(rowsToInsert, {
          onConflict: 'property_id,dedupe_key',
          ignoreDuplicates: true,
        })
        .select('dedupe_key');
      if (insertErr) {
        log.error('[rules-engine] insert failed', {
          propertyId,
          engineRunId,
          error: insertErr.message,
          rowCount: rowsToInsert.length,
        });
        errors.push({
          room_number: '*',
          error: `cleaning_tasks insert failed: ${insertErr.message}`,
        });
      } else {
        const insertedKeys = new Set(
          ((inserted ?? []) as Array<{ dedupe_key: string }>).map((r) => r.dedupe_key),
        );
        upserted += insertedKeys.size;
        if (verbose) {
          for (const row of rowsToInsert) {
            const planned = pendingUpdateOutcomes.get(row.dedupe_key);
            if (planned) outcomes.push(planned);
          }
        }
      }
    }

    // ─── Bucket 2: per-row UPDATE with status filter ───────────────────
    // Atomic at the row-lock level. If a housekeeper marked the task
    // `in_progress` between our SELECT and this UPDATE, the WHERE clause
    // excludes the row and 0 rows are updated — we then fall through to
    // bumping last_evaluated_at, never overwriting their progress.
    const mutableStatuses: string[] = [...ENGINE_MUTABLE_STATUSES];
    for (const row of rowsToUpdate) {
      const updateFields = {
        cleaning_type: row.cleaning_type,
        priority: row.priority,
        due_by: row.due_by,
        estimated_minutes: row.estimated_minutes,
        requires_inspection: row.requires_inspection,
        extras: row.extras,
        notes: row.notes,
        rules_fired: row.rules_fired,
        rule_inputs: row.rule_inputs,
        status: row.status,
        source_pms_reservation_id: row.source_pms_reservation_id,
        source_engine_run_id: row.source_engine_run_id,
        source_property_timezone: row.source_property_timezone,
        scheduled_at: row.scheduled_at,
        last_evaluated_at: row.last_evaluated_at,
      };
      const { data: updatedRows, error: updateErr } = await supabaseAdmin
        .from('cleaning_tasks')
        .update(updateFields)
        .eq('property_id', row.property_id)
        .eq('dedupe_key', row.dedupe_key)
        .in('status', mutableStatuses)
        .select('id');
      if (updateErr) {
        log.error('[rules-engine] update failed', {
          propertyId,
          engineRunId,
          dedupe_key: row.dedupe_key,
          error: updateErr.message,
        });
        errors.push({
          room_number: row.room_number,
          error: `cleaning_tasks update failed: ${updateErr.message}`,
        });
        continue;
      }
      if (!updatedRows || updatedRows.length === 0) {
        // Race: status changed to non-mutable between SELECT and UPDATE.
        // Fall through to bump-only path so the human's progress is
        // preserved AND the task still appears "evaluated this run".
        skippedInProgress++;
        keysToBump.push(row.dedupe_key);
        if (verbose) {
          outcomes.push({
            room_number: row.room_number,
            outcome: 'skipped_in_progress',
            cleaning_type: row.cleaning_type,
          });
        }
        continue;
      }
      upserted++;
      if (verbose) {
        const planned = pendingUpdateOutcomes.get(row.dedupe_key);
        if (planned) outcomes.push(planned);
      }
    }

    // ─── Bucket 3: bump last_evaluated_at only ─────────────────────────
    if (keysToBump.length > 0) {
      const nowIso = now.toISOString();
      const { error: bumpErr } = await supabaseAdmin
        .from('cleaning_tasks')
        .update({ last_evaluated_at: nowIso })
        .eq('property_id', propertyId)
        .in('dedupe_key', keysToBump);
      if (bumpErr) {
        log.warn('[rules-engine] last_evaluated_at bump failed', {
          propertyId,
          engineRunId,
          error: bumpErr.message,
        });
      }
    }
  } else {
    // Dry-run: pretend all queued rows wrote successfully so the response
    // reflects the rules' planned output without touching the DB.
    upserted = rowsToInsert.length + rowsToUpdate.length;
    if (verbose) {
      for (const row of [...rowsToInsert, ...rowsToUpdate]) {
        const planned = pendingUpdateOutcomes.get(row.dedupe_key);
        if (planned) outcomes.push(planned);
      }
    }
  }

  return {
    property_id: propertyId,
    business_date: prop.business_date,
    engine_run_id: engineRunId,
    rooms_evaluated: roomContexts.length,
    tasks_upserted: upserted,
    tasks_skipped_in_progress: skippedInProgress,
    rooms_no_task: noTask,
    errors,
    duration_ms: Date.now() - t0,
    outcomes: verbose ? outcomes : [],
    dry_run: dryRun,
  };
}

async function fetchExistingTaskStatuses(
  propertyId: string,
  dedupeKeys: string[],
): Promise<Map<string, { id: string; status: string }>> {
  const map = new Map<string, { id: string; status: string }>();
  if (dedupeKeys.length === 0) return map;

  const { data, error } = await supabaseAdmin
    .from('cleaning_tasks')
    .select('id, dedupe_key, status')
    .eq('property_id', propertyId)
    .in('dedupe_key', dedupeKeys);
  if (error) throw error;

  for (const row of (data ?? []) as Array<{
    id: string;
    dedupe_key: string;
    status: string;
  }>) {
    map.set(row.dedupe_key, { id: row.id, status: row.status });
  }
  return map;
}

export async function runRulesEngineForAllProperties(
  opts: EngineOptions = {},
): Promise<PropertyRunResult[]> {
  const { data, error } = await supabaseAdmin.from('properties').select('id');
  if (error) throw error;

  const results: PropertyRunResult[] = [];
  for (const row of (data ?? []) as Array<{ id: string }>) {
    if (!row.id) continue;
    try {
      results.push(await runRulesEngineForProperty(row.id, opts));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({
        property_id: row.id,
        business_date: '',
        engine_run_id: '',
        rooms_evaluated: 0,
        tasks_upserted: 0,
        tasks_skipped_in_progress: 0,
        rooms_no_task: 0,
        errors: [{ room_number: '*', error: msg }],
        duration_ms: 0,
        outcomes: [],
        dry_run: opts.dryRun === true,
      });
    }
  }
  return results;
}
