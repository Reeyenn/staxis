// ════════════════════════════════════════════════════════════════════════════
// THE business date. One implementation, in one file.
//
// A hotel's day does not end at midnight — it ends when night audit runs. A
// 2:15am folio posting belongs to the night that is closing, not the morning
// that is starting. Every hotel picks its own hour
// (properties.business_date_cutoff_hour, 0-6); 0 means "the plain calendar day
// in the hotel's own timezone", which is exactly what the app did before this
// file existed, so a hotel on 0 sees no number change.
//
// TWO DIFFERENT QUESTIONS, TWO DIFFERENT FUNCTIONS:
//
//   businessDate(property, instant)
//     "Which business day is this MOMENT in?" — legitimate for an observation
//     (a reading of the live counts is a fact about a moment) and for deciding
//     which day the nightly seal should close.
//
//   businessDateFromReport(printed)
//     "Which business day does this REPORT say it covers?" — the ONLY
//     sanctioned path for a PMS-sourced daily accounting fact. Revenue for
//     "Tuesday" is whatever the report headed Tuesday says, full stop. Deriving
//     it from when the email arrived is how a hotel ends up with two Tuesdays,
//     or none.
//
// WHY THE MATH LOOKS LIKE THIS: format → inspect → calendar-add, never a UTC
// round-trip. src/lib/schedule/local-date.ts exists because a noon-UTC anchor
// plus a UTC day-add silently skipped a calendar date at Pacific/Kiritimati
// (UTC+14). The same trap applies here, so the same discipline does:
// Intl.DateTimeFormat gives us the hotel's local date AND hour directly, and
// the cutoff shift is a pure calendar decrement on a YYYY-MM-DD string.
//
// The mirror of this lives in SQL as staxis_business_date() (migration 0343),
// which the observation-stamping triggers call. Both do wall-clock arithmetic,
// so they agree.
// ════════════════════════════════════════════════════════════════════════════

import { addDaysInTz } from '@/lib/schedule/local-date';

export const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The shape businessDate() needs. Matches the `properties` row columns so a
 *  caller can pass the row straight through. */
export type BusinessDateProperty = {
  timezone: string | null;
  business_date_cutoff_hour?: number | null;
};

/** Throws unless `value` is a well-formed, real YYYY-MM-DD calendar date.
 *  Used at every boundary where a date arrives from outside (a parsed report,
 *  an operator, a query param). */
export function assertBusinessDateFormat(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !BUSINESS_DATE_RE.test(value)) {
    throw new Error(`business date must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  const [y, m, d] = value.split('-').map(Number);
  // Reject 2026-02-31 and friends: Date.UTC rolls them forward silently, which
  // would turn a garbled report into a plausible-looking wrong day.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y
    || probe.getUTCMonth() !== m - 1
    || probe.getUTCDate() !== d
  ) {
    throw new Error(`business date is not a real calendar date: ${value}`);
  }
}

/** Non-throwing form of assertBusinessDateFormat. */
export function isBusinessDate(value: unknown): value is string {
  try {
    assertBusinessDateFormat(value);
    return true;
  } catch {
    return false;
  }
}

/** Clamp a stored cutoff to the DB's own domain (smallint 0-6). A row written
 *  before the CHECK existed, or a hand-edited value, degrades to 0 rather than
 *  shifting every date by a garbage amount. */
function normalizeCutoff(hour: number | null | undefined): number {
  if (typeof hour !== 'number' || !Number.isFinite(hour)) return 0;
  const h = Math.trunc(hour);
  if (h < 0 || h > 6) return 0;
  return h;
}

/** The hotel's local calendar date + local hour for an instant. Falls back to
 *  UTC on a missing/invalid timezone rather than throwing — matching
 *  propertyLocalToday(), because a bad tz string must never take a write down. */
function localDateAndHour(instant: Date, timezone: string | null): { date: string; hour: number } {
  const build = (tz: string) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(instant);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    // Intl renders midnight as "24" in some ICU versions with hour12:false.
    const rawHour = parseInt(get('hour'), 10);
    const hour = Number.isFinite(rawHour) ? rawHour % 24 : 0;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
  };
  if (!timezone || !timezone.trim()) return build('UTC');
  try {
    return build(timezone);
  } catch {
    return build('UTC');
  }
}

/**
 * Which business day an instant falls in, for one property.
 *
 * cutoff 0 → the plain local calendar date (today's behavior everywhere).
 * cutoff 3 → 02:15 local returns YESTERDAY; 03:00 local returns today.
 */
export function businessDate(property: BusinessDateProperty, instant: Date): string {
  const cutoff = normalizeCutoff(property.business_date_cutoff_hour);
  const { date, hour } = localDateAndHour(instant, property.timezone);
  if (cutoff === 0 || hour >= cutoff) return date;
  return addDaysInTz(date, -1);
}

/**
 * The business date a PMS report states on its face. THE ONLY SANCTIONED PATH
 * for a daily accounting fact.
 *
 * It does no arithmetic on purpose: there is nothing to compute. Whatever the
 * report printed is the answer, and the job here is only to refuse a value
 * that is not a real date — because the alternative to refusing is storing a
 * number against a day that does not exist.
 */
export function businessDateFromReport(printed: string): string {
  const trimmed = typeof printed === 'string' ? printed.trim() : printed;
  assertBusinessDateFormat(trimmed);
  return trimmed;
}
