// Cadence / period math for compliance readings + PM checks.
//
// A reading or check "satisfies" a period_key. Completion = a row exists for
// the CURRENT period. PM "overdue" = the cadence interval elapsed since the
// last pass-check (or it was never checked and the grace window passed).
//
// All boundaries are computed in the property's local timezone (default
// America/Chicago, matching the rest of the app — see src/lib/utils.ts).

import { APP_TIMEZONE } from '@/lib/utils';
import type { ReadingCadence, PmCadence } from './types';

/** Local wall-clock parts for `now` in `tz`. */
function tzParts(now: Date, tz: string): { y: number; m: number; d: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(fmt.find((p) => p.type === t)?.value ?? 0);
  const hour = get('hour');
  return { y: get('year'), m: get('month'), d: get('day'), hour: hour === 24 ? 0 : hour };
}

/** ISO-8601 week number + week-year for a local Y/M/D. */
function isoWeek(y: number, m: number, d: number): { weekYear: number; week: number } {
  // Work in UTC to avoid DST drift; we only use the date parts.
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const ftDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { weekYear: date.getUTCFullYear(), week };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The period_key a fresh reading would be filed under, for a given cadence. */
export function currentReadingPeriodKey(
  cadence: ReadingCadence,
  now: Date = new Date(),
  tz: string = APP_TIMEZONE,
): string {
  const { y, m, d, hour } = tzParts(now, tz);
  switch (cadence) {
    case 'per_shift':
      // Two shifts split at local noon. Pool tests etc. are typically logged
      // AM and again PM; each shift is its own bucket.
      return `${y}-${pad(m)}-${pad(d)}:${hour < 12 ? 'AM' : 'PM'}`;
    case 'daily':
      return `${y}-${pad(m)}-${pad(d)}`;
    case 'weekly': {
      const { weekYear, week } = isoWeek(y, m, d);
      return `${weekYear}-W${pad(week)}`;
    }
    case 'monthly':
      return `${y}-${pad(m)}`;
  }
}

/** The period_key a fresh PM check would be filed under, for a given cadence. */
export function currentPmPeriodKey(
  cadence: PmCadence,
  now: Date = new Date(),
  tz: string = APP_TIMEZONE,
): string {
  const { y, m } = tzParts(now, tz);
  switch (cadence) {
    case 'monthly':
      return `${y}-${pad(m)}`;
    case 'quarterly':
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case 'annual':
      return `${y}`;
  }
}

/** Short human label for the current reading period. */
export function readingPeriodLabel(cadence: ReadingCadence, now: Date = new Date(), tz: string = APP_TIMEZONE): string {
  if (cadence === 'per_shift') {
    const { hour } = tzParts(now, tz);
    return hour < 12 ? 'this shift (AM)' : 'this shift (PM)';
  }
  if (cadence === 'daily') return 'today';
  if (cadence === 'weekly') return 'this week';
  return 'this month';
}

export function pmPeriodLabel(cadence: PmCadence): string {
  if (cadence === 'monthly') return 'this month';
  if (cadence === 'quarterly') return 'this quarter';
  return 'this year';
}

/**
 * The period_key for the period immediately BEFORE the current one. Used for
 * calendar-based overdue: a task is overdue when the current period has no pass
 * AND the previous period was also missed (i.e. ≥1 full period has lapsed).
 *
 * Calendar-based — NOT a rolling "last check + N days" interval. A monthly
 * check done Jan 31 is "due" through February (current period = Feb, prev =
 * Jan = done) and flips to "overdue" at the March rollover (prev = Feb =
 * missed). The rolling model used to hide a fully-lapsed period for a variable
 * extra window depending on the day-of-month of the last check.
 */
export function previousPmPeriodKey(
  cadence: PmCadence,
  now: Date = new Date(),
  tz: string = APP_TIMEZONE,
): string {
  const { y, m } = tzParts(now, tz);
  if (cadence === 'monthly') {
    const pm = m === 1 ? 12 : m - 1;
    const py = m === 1 ? y - 1 : y;
    return `${py}-${pad(pm)}`;
  }
  if (cadence === 'quarterly') {
    const q = Math.floor((m - 1) / 3) + 1;
    const pq = q === 1 ? 4 : q - 1;
    const py = q === 1 ? y - 1 : y;
    return `${py}-Q${pq}`;
  }
  return `${y - 1}`; // annual
}

/** ISO timestamp of when the NEXT period begins (informational next-due). */
export function pmNextDueISO(
  cadence: PmCadence,
  now: Date = new Date(),
  tz: string = APP_TIMEZONE,
): string {
  const { y, m } = tzParts(now, tz);
  if (cadence === 'monthly') {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return `${ny}-${pad(nm)}-01T00:00:00Z`;
  }
  if (cadence === 'quarterly') {
    const q = Math.floor((m - 1) / 3) + 1;
    const nextStartMonth = q === 4 ? 1 : q * 3 + 1;
    const ny = q === 4 ? y + 1 : y;
    return `${ny}-${pad(nextStartMonth)}-01T00:00:00Z`;
  }
  return `${y + 1}-01-01T00:00:00Z`; // annual
}

/** Map a completion ratio (0-1) to the app's 70/30 Good/Low/Critical status. */
export function ratioToStatus(ratio: number): 'good' | 'low' | 'critical' {
  if (ratio >= 0.7) return 'good';
  if (ratio >= 0.3) return 'low';
  return 'critical';
}
