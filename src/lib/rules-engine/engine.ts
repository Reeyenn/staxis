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
 *   5. Partition into canonical plan write buckets:
 *        - insert/update : one property-scoped RPC batch, with a status
 *                          guard that never overwrites started workflow
 *        - bump          : canonical heartbeat for non-mutable plans
 *      The RPC locks the complete affected component set before mutation,
 *      closing the TOCTOU race that direct legacy-table writes carried.
 *
 * Idempotency: identical inputs produce identical canonical rows (same
 * dedupe_key, same cleaning_type, same rules_fired). Re-running on stable
 * PMS state is a no-op from the data perspective (only the heartbeat moves).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { runWithConcurrency } from '@/lib/parallel';
import { isSectionEnabled, type EnabledSections } from '@/lib/sections/registry';
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

export type CanonicalPlanOutcome =
  | 'upserted'
  | 'skipped_in_progress'
  | 'unchanged'
  | 'ignored';

/** Map the canonical RPC contract to the engine's user-facing counters. */
export function classifyCanonicalPlanOutcome(outcome: string): CanonicalPlanOutcome {
  if (outcome === 'inserted' || outcome === 'updated') return 'upserted';
  if (outcome === 'skipped_non_mutable') return 'skipped_in_progress';
  if (outcome === 'unchanged') return 'unchanged';
  return 'ignored';
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
    // The canonical batch below handles inserts and mutable updates together.

    const planRows = [...rowsToInsert, ...rowsToUpdate];
    if (planRows.length > 0) {
      const { data: persisted, error: persistErr } = await supabaseAdmin.rpc(
        'upsert_room_work_plan',
        { p_property_id: propertyId, p_rows: planRows },
      );
      if (persistErr) {
        log.error('[rules-engine] canonical plan upsert failed', {
          propertyId,
          engineRunId,
          error: persistErr.message,
          rowCount: planRows.length,
        });
        errors.push({
          room_number: '*',
          error: `room_work plan upsert failed: ${persistErr.message}`,
        });
      } else {
        const persistedRows = (persisted ?? []) as Array<{
          dedupe_key: string;
          outcome: string;
        }>;
        const submittedByKey = new Map(planRows.map((row) => [row.dedupe_key, row]));
        for (const result of persistedRows) {
          const row = submittedByKey.get(result.dedupe_key);
          if (!row) continue;
          const canonicalOutcome = classifyCanonicalPlanOutcome(result.outcome);
          if (canonicalOutcome === 'upserted') {
            upserted++;
            if (verbose) {
              const planned = pendingUpdateOutcomes.get(row.dedupe_key);
              if (planned) outcomes.push(planned);
            }
          } else if (canonicalOutcome === 'skipped_in_progress') {
            // A mutable row can become non-mutable while the RPC waits for
            // its row lock. Preserve the old race outcome without touching
            // the human's workflow state.
            skippedInProgress++;
            if (verbose) {
              outcomes.push({
                room_number: row.room_number,
                outcome: 'skipped_in_progress',
                cleaning_type: row.cleaning_type,
              });
            }
          }
        }
      }
    }

    // ─── Existing-work heartbeat ────────────────────────────────────────
    if (keysToBump.length > 0) {
      const { error: bumpErr } = await supabaseAdmin.rpc(
        'touch_room_work_plan',
        {
          p_property_id: propertyId,
          p_date: prop.business_date,
          p_dedupe_keys: keysToBump,
        },
      );
      if (bumpErr) {
        log.warn('[rules-engine] canonical plan heartbeat failed', {
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
    .from('room_work_plan_v1')
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
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, enabled_sections');
  if (error) throw error;
  // Section gate (WP6): a hotel with Housekeeping off pauses cleaning-task
  // generation. Fail-open — only an explicit `false` skips (null/missing ⇒ runs).
  const rows = (
    (data ?? []) as Array<{ id: string; enabled_sections: EnabledSections }>
  ).filter((r) => r.id && isSectionEnabled(r.enabled_sections, 'housekeeping'));

  // Bounded concurrency (cap 5) instead of a serial for-await. At fleet scale a
  // strictly-serial loop (~5 DB round-trips/property) exceeds the 60s function
  // cap and, because the order is stable, silently starves the SAME tail hotels
  // every tick (their cleaning tasks never generate). Each per-property run is
  // independent + idempotent + property-scoped, so running ~5 at a time is safe
  // and finishes the fleet well inside the budget (most properties early-return).
  // (Audit fix 2026-06-18; full sharding across cron invocations remains a
  // follow-up for very large fleets.)
  const outcomes = await runWithConcurrency(
    rows,
    (row) => runRulesEngineForProperty(row.id, opts),
    5,
  );
  return outcomes.map((o) =>
    o.ok
      ? o.value
      : {
          property_id: o.input.id,
          business_date: '',
          engine_run_id: '',
          rooms_evaluated: 0,
          tasks_upserted: 0,
          tasks_skipped_in_progress: 0,
          rooms_no_task: 0,
          errors: [{ room_number: '*', error: o.error instanceof Error ? o.error.message : String(o.error) }],
          duration_ms: 0,
          outcomes: [],
          dry_run: opts.dryRun === true,
        },
  );
}
