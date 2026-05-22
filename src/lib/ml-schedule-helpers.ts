/**
 * ML Schedule Helpers — P6 integration utilities
 *
 * Small utilities for the Schedule tab to consume ML predictions + confidence ranges.
 * Imported by ScheduleTab.tsx to fetch and format ML data for the UI.
 */

// Browser-callable: imported by ScheduleTab.tsx (a client component).
// MUST use the regular `supabase` client — supabase-admin would pull
// SUPABASE_SERVICE_ROLE_KEY into the client bundle and crash at module
// load. RLS on the ML tables enforces owner-only reads.
import { supabase } from '@/lib/supabase';
import { logErr } from './db/_common';
import { APP_TIMEZONE } from './utils';

/**
 * Compute tomorrow's date as YYYY-MM-DD in the given IANA timezone.
 *
 * Defaults to APP_TIMEZONE (Comfort Suites' Central Time) for backward
 * compatibility. When a property has a different timezone (e.g. a Florida
 * hotel on America/New_York), callers should pass `properties.timezone`
 * so the predicted "tomorrow" matches when the scraper rolls its date.
 */
function getTomorrowDateStr(tz: string = APP_TIMEZONE): string {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const tomorrow = new Date(local);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toISOString().split('T')[0];
}

/**
 * Honest model-state classification surfaced to the UI tile / tooltip.
 *
 * Derived from the Python optimizer's `inputs_snapshot` keys:
 *   - `'fitted'`              — L1 demand AND L2 supply trained from this hotel
 *   - `'warming-up'`          — any backing layer is `algorithm='cold-start-cohort-prior'`
 *                               (cohort benchmark, not learned-from-this-hotel)
 *   - `'capacity-unavailable'` — L1 fitted but < 10 supply predictions for
 *                               this date → optimizer dropped to L1-only path;
 *                               recommendation is from aggregate demand only,
 *                               no per-room model ran
 *
 * Backward-compat: rows written before Phase 1.2 don't carry these keys.
 * Default to `'warming-up'` (fail-honest, not fail-AI).
 */
export type OptimizerModelKind = 'fitted' | 'warming-up' | 'capacity-unavailable';

export interface OptimizerInputsSnapshot {
  l1_is_cold_start?: unknown;
  l2_any_cold_start?: unknown;
  used_l2_supply?: unknown;
  l2_prediction_count?: unknown;
  l1_algorithm?: unknown;
  l2_algorithms?: unknown;
  both_layers_cold_start?: unknown;
}

export function parseInputsSnapshot(raw: unknown): OptimizerInputsSnapshot {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as OptimizerInputsSnapshot;
  }
  // Some Supabase writers stringify JSONB; tolerate both shapes.
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function deriveModelKind(snap: OptimizerInputsSnapshot): {
  modelKind: OptimizerModelKind;
  warmupReason: string | null;
} {
  // Treat missing keys as warming-up (fail-honest). Old rows from before
  // Phase 1.2 will hit this branch and the UI will downgrade to "Industry
  // estimate · learning" — better than mislabeling them "AI recommendation".
  const hasKeys =
    snap.l1_is_cold_start !== undefined ||
    snap.l2_any_cold_start !== undefined ||
    snap.used_l2_supply !== undefined;
  if (!hasKeys) {
    return { modelKind: 'warming-up', warmupReason: 'pre-phase-1.2 row (kind metadata absent)' };
  }

  const l1Cold = snap.l1_is_cold_start === true;
  const l2Cold = snap.l2_any_cold_start === true;
  const usedL2 = snap.used_l2_supply === true;
  const l2Count = typeof snap.l2_prediction_count === 'number' ? snap.l2_prediction_count : 0;

  if (!usedL2) {
    return {
      modelKind: 'capacity-unavailable',
      warmupReason: `L1 ${l1Cold ? 'cold-start' : 'fitted'}; L2 capacity model unavailable (${l2Count} supply predictions)`,
    };
  }
  if (l1Cold || l2Cold) {
    const l1Note = l1Cold ? 'cold-start' : 'fitted';
    const l2Note = l2Cold ? 'cold-start' : 'fitted';
    return { modelKind: 'warming-up', warmupReason: `L1 ${l1Note}; L2 ${l2Note}` };
  }
  return { modelKind: 'fitted', warmupReason: null };
}

/**
 * Fetch the active optimizer result for tomorrow (the recommended headcount).
 * Returns null if no active model exists or the row is older than 24h.
 *
 * Phase 1.3 (2026-05-22): now exposes `modelKind` derived from the
 * Python optimizer's `inputs_snapshot` so the Schedule tab can branch
 * the headline label between "AI recommendation" (fitted) and "Industry
 * estimate · learning" (warming-up or capacity-unavailable). Bug this
 * fixes: prior to Phase 1, the tile said "AI recommendation" for cold-start
 * hotels whose recommendations were industry-benchmark cohort priors.
 *
 * Codex post-merge review 2026-05-13 (N2): the 24h `ran_at` gate prevents
 * this helper from surfacing stale rows. Combined with the optimizer cron
 * being un-paused at Phase M3.1, returns the freshest row per property.
 */
export async function getActiveOptimizerForTomorrow(
  propertyId: string,
  tz?: string,
): Promise<{
  recommendedHeadcount: number;
  completionProbabilityCurve: Array<{ headcount: number; p: number }>;
  modelKind: OptimizerModelKind;
  warmupReason: string | null;
} | null> {
  try {
    const tomorrow = getTomorrowDateStr(tz);
    const freshnessIso = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { data, error } = await supabase
      .from('optimizer_results')
      .select('recommended_headcount, completion_probability_curve, inputs_snapshot, ran_at')
      .eq('property_id', propertyId)
      .eq('date', tomorrow)
      .gte('ran_at', freshnessIso)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    // completion_probability_curve is stored as JSONB; Supabase types it
    // as `unknown`. Narrow to a permissive row shape before mapping so a
    // schema drift doesn't blow up with a runtime TypeError — defaults
    // protect the consumer (the UI confidence tooltip).
    const rawCurve = (data.completion_probability_curve ?? []) as unknown;
    const curveRows: Array<{ headcount?: unknown; p?: unknown }> =
      Array.isArray(rawCurve) ? (rawCurve as Array<{ headcount?: unknown; p?: unknown }>) : [];

    const snap = parseInputsSnapshot(data.inputs_snapshot);
    const { modelKind, warmupReason } = deriveModelKind(snap);

    return {
      recommendedHeadcount: data.recommended_headcount as number,
      completionProbabilityCurve: curveRows.map(row => ({
        headcount: typeof row.headcount === 'number' ? row.headcount : 0,
        p: typeof row.p === 'number' ? row.p : 0,
      })),
      modelKind,
      warmupReason,
    };
  } catch (err) {
    logErr('getActiveOptimizerForTomorrow', err);
    return null;
  }
}

/**
 * Fetch the active demand prediction for tomorrow (confidence range).
 * Returns p80/p95 headcount boundaries for Maria's confidence tooltip.
 *
 * Codex post-merge review 2026-05-13 (Phase 2.2 + 2.4): no current
 * consumer in src/. Kept (rather than deleted) because the matching
 * Python writer was just added in inference/demand.py — the ScheduleTab
 * "p80 confidence band" UI is the natural next consumer. If still
 * uncalled in 6 months, delete.
 */
export async function getActiveDemandForTomorrow(
  propertyId: string,
  tz?: string,
): Promise<{
  predictedHeadcountP80: number;
  predictedHeadcountP95: number;
} | null> {
  try {
    const tomorrow = getTomorrowDateStr(tz);
    const { data, error } = await supabase
      .from('demand_predictions')
      .select('predicted_headcount_p80, predicted_headcount_p95')
      .eq('property_id', propertyId)
      .eq('date', tomorrow)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      predictedHeadcountP80: Math.ceil(data.predicted_headcount_p80 as number) || 1,
      predictedHeadcountP95: Math.ceil(data.predicted_headcount_p95 as number) || 1,
    };
  } catch (err) {
    logErr('getActiveDemandForTomorrow', err);
    return null;
  }
}

// Codex post-merge review 2026-05-13 (Phase 2.2): `getActiveModelRunInfo`
// and `getActiveSupplyPredictionsForTomorrow` were P6 ScheduleTab
// scaffolding that never landed. Both had zero callers in src/. Deleted
// to avoid load-bearing-dead-code drift. Git history preserves the
// implementation if someone needs it back; the right re-introduction
// point is when the ScheduleTab UI actually wires the consumer.

/**
 * Fetch supply predictions for tomorrow as a Map of "${roomNumber}:${staffId}" → predicted_minutes_p50.
 * Used to override static room-minute estimates in autoAssign.
 *
 * NOTE (2026-05-13): currently unused. Kept because autoAssignRooms is
 * the natural consumer once supply-prediction-overrides land in
 * ScheduleTab. Delete if still uncalled in 6 months.
 */
export async function getActiveSupplyPredictionsForTomorrow(
  propertyId: string,
  tz?: string,
): Promise<Map<string, number>> {
  try {
    const tomorrow = getTomorrowDateStr(tz);
    const { data, error } = await supabase
      .from('supply_predictions')
      .select('room_number, staff_id, predicted_minutes_p50')
      .eq('property_id', propertyId)
      .eq('date', tomorrow);

    if (error) throw error;

    const map = new Map<string, number>();
    for (const row of data ?? []) {
      const key = `${row.room_number}:${row.staff_id}`;
      map.set(key, Math.ceil(Number(row.predicted_minutes_p50 || 0)));
    }
    return map;
  } catch (err) {
    logErr('getActiveSupplyPredictionsForTomorrow', err);
    return new Map();
  }
}

/**
 * Format a date for the ML pill tooltip: "last trained May 1"
 */
export function formatTrainedDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Format MAE in minutes for the tooltip. If null, returns a placeholder.
 */
export function formatMae(mae: number | null): string {
  if (mae === null) return '—';
  return `${Math.round(mae)} min`;
}
