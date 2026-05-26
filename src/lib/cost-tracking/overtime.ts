/**
 * Pure helpers for overtime classification + ISO-week extraction.
 *
 * Lives separately from the API route so the cron path (when we
 * eventually add one) and the route can share the same logic — and
 * so the tests don't need to mock fetch / supabase.
 */

export type OvertimeLevel = 'none' | 'approaching' | 'over';

export const APPROACHING_OT_HOURS = 35;
export const DEFAULT_OT_THRESHOLD_HOURS = 40;

export function classifyOvertimeLevel(
  netHours: number,
  thresholdHours: number,
): OvertimeLevel {
  if (!Number.isFinite(netHours) || netHours < 0) return 'none';
  if (netHours >= thresholdHours) return 'over';
  if (netHours >= APPROACHING_OT_HOURS) return 'approaching';
  return 'none';
}

/**
 * ISO 8601 week, with year resolution for week-belongs-to-prior-year
 * edge cases (e.g. Dec 31 may belong to the next year's W01).
 * Matches Postgres `EXTRACT(ISOYEAR FROM …)` + `EXTRACT(WEEK FROM …)`
 * — which is what the staff_weekly_hours_view in migration 0229 uses.
 */
export function isoWeekParts(d: Date): { isoYear: number; isoWeek: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const isoYear = t.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil((((t.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return { isoYear, isoWeek };
}
