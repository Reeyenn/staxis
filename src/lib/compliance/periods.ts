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

/** Days in the cadence interval — used for PM next-due / overdue math. */
function pmIntervalDays(cadence: PmCadence): number {
  if (cadence === 'monthly') return 31;
  if (cadence === 'quarterly') return 92;
  return 366;
}

/**
 * Compute PM overdue state.
 *
 *   - Never checked → overdue once the grace window (one cadence interval
 *     from the task's creation) has passed.
 *   - Otherwise → overdue when more than one cadence interval has elapsed
 *     since the last PASS check.
 *
 * `lastPassAt` is the most recent passing check (fails don't reset the clock).
 */
export function pmOverdue(
  cadence: PmCadence,
  lastPassAt: string | null,
  createdAt: string | null,
  now: Date = new Date(),
): { overdue: boolean; nextDueISO: string | null } {
  const intervalMs = pmIntervalDays(cadence) * 24 * 3600 * 1000;
  const anchor = lastPassAt ?? createdAt;
  if (!anchor) return { overdue: false, nextDueISO: null };
  const anchorMs = new Date(anchor).getTime();
  if (!Number.isFinite(anchorMs)) return { overdue: false, nextDueISO: null };
  const nextDue = anchorMs + intervalMs;
  return { overdue: now.getTime() > nextDue, nextDueISO: new Date(nextDue).toISOString() };
}

/** Map a completion ratio (0-1) to the app's 70/30 Good/Low/Critical status. */
export function ratioToStatus(ratio: number): 'good' | 'low' | 'critical' {
  if (ratio >= 0.7) return 'good';
  if (ratio >= 0.3) return 'low';
  return 'critical';
}
