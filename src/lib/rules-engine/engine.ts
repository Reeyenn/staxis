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
 *   5. Skip rooms whose existing task is already past `scheduled`/`ready_now`
 *      (in_progress, paused, completed, …) — the engine NEVER clobbers
 *      a task a human has started.
 *   6. Bulk upsert the rest into cleaning_tasks on (property_id, dedupe_key).
 *   7. Bump last_evaluated_at on the in-progress rows we skipped, so
 *      they appear "fresh" in operations dashboards.
 *
 * Idempotency: identical inputs produce identical rows (same dedupe_key,
 * same cleaning_type, same rules_fired). Re-running on stable PMS state
 * is a no-op from the data perspective (only last_evaluated_at moves).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

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
  const dedupeKeys = roomContexts.map(
    (c) => `${c.room_number}::${prop.business_date}`,
  );
  const existingByKey = await fetchExistingTaskStatuses(propertyId, dedupeKeys);

  let upserted = 0;
  let skippedInProgress = 0;
  let noTask = 0;
  const errors: Array<{ room_number: string; error: string }> = [];
  const outcomes: RoomEngineOutcome[] = [];
  const rowsToUpsert: CleaningTaskUpsertRow[] = [];
  const keysToBump: string[] = [];

  for (const ctx of roomContexts) {
    try {
      const fires = evaluateRoomRules(ctx);
      const spec = mergePartials(fires, ctx);
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
      rowsToUpsert.push(row);
      upserted++;
      if (verbose) {
        outcomes.push({
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

  if (!dryRun) {
    if (rowsToUpsert.length > 0) {
      const { error: upsertErr } = await supabaseAdmin
        .from('cleaning_tasks')
        .upsert(rowsToUpsert, { onConflict: 'property_id,dedupe_key' });
      if (upsertErr) {
        log.error('[rules-engine] upsert failed', {
          propertyId,
          engineRunId,
          error: upsertErr.message,
          rowCount: rowsToUpsert.length,
        });
        errors.push({
          room_number: '*',
          error: `cleaning_tasks upsert failed: ${upsertErr.message}`,
        });
      }
    }
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
