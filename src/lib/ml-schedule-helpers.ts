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
 * Fetch the active optimizer result for tomorrow (the recommended headcount).
 * Returns null if no active model exists or the row is older than 24h.
 *
 * Codex post-merge review 2026-05-13 (N2): the optimizer cron is currently
 * paused (`src/app/api/cron/ml-run-inference/route.ts` returns
 * `{status:'skipped'}` for the optimizer stage). Anything in the
 * `optimizer_results` table from before the pause is now stale. The 24h
 * `ran_at` gate prevents this helper from surfacing those rows. Combined
 * with the paused cron, the function returns null until the cron is
 * re-enabled — better than silently showing months-old recommendations.
 */
export async function getActiveOptimizerForTomorrow(
  propertyId: string,
  tz?: string,
): Promise<{
  recommendedHeadcount: number;
  completionProbabilityCurve: Array<{ headcount: number; p: number }>;
} | null> {
  try {
    const tomorrow = getTomorrowDateStr(tz);
    const freshnessIso = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { data, error } = await supabase
      .from('optimizer_results')
      .select('recommended_headcount, completion_probability_curve, ran_at')
      .eq('property_id', propertyId)
      .eq('date', tomorrow)
      .gte('ran_at', freshnessIso)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      recommendedHeadcount: data.recommended_headcount as number,
      completionProbabilityCurve: (
        (data.completion_probability_curve as any[]) ?? []
      ).map((row: any) => ({
        headcount: row.headcount ?? 0,
        p: row.p ?? 0,
      })),
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
