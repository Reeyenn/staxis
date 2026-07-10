// Settings → Activity Log date-range math, extracted from page.tsx so the
// custom-range regression tests in src/lib/__tests__ can exercise it.
//
// Server contract (src/lib/activity-log/query.ts): occurred_at >= from AND
// occurred_at < to — the `to` bound is EXCLUSIVE. Every range must therefore
// end at local midnight of the day AFTER its last included day (the presets'
// `tomorrow`). The custom range used to send midnight at the START of the
// chosen end date — parsed as UTC via new Date('YYYY-MM-DD'), no less — which
// excluded the entire end day and made same-day custom ranges always return
// "No events".

import { parseLocalDate } from '@/lib/format-date';

export type DateRangeKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'custom';

export interface RangeBounds { from: string; to: string; }

/** `now` defaults to the wall clock; injectable only so tests can pin it. */
export function rangeFor(
  key: DateRangeKey,
  customFrom?: string,
  customTo?: string,
  now: Date = new Date(),
): RangeBounds {
  const startOf = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const today = startOf(now);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  switch (key) {
    case 'today':     return { from: today.toISOString(), to: tomorrow.toISOString() };
    case 'yesterday': {
      const y = new Date(today); y.setDate(today.getDate() - 1);
      return { from: y.toISOString(), to: today.toISOString() };
    }
    case 'last7': {
      const f = new Date(today); f.setDate(today.getDate() - 7);
      return { from: f.toISOString(), to: tomorrow.toISOString() };
    }
    case 'last30': {
      const f = new Date(today); f.setDate(today.getDate() - 30);
      return { from: f.toISOString(), to: tomorrow.toISOString() };
    }
    case 'custom':
    default: {
      // parseLocalDate → local midnight (never the UTC-midnight shift of
      // new Date('YYYY-MM-DD')).
      const fromDate = customFrom ? parseLocalDate(customFrom) : null;
      const toDate = customTo ? parseLocalDate(customTo) : null;
      const from = fromDate ?? new Date(today.getTime() - 7 * 86400000);
      // Include the WHOLE selected end day under the end-exclusive contract:
      // bound at local midnight of the following day.
      let toExclusive = tomorrow;
      if (toDate) {
        toExclusive = new Date(toDate);
        toExclusive.setDate(toExclusive.getDate() + 1);
      }
      return { from: from.toISOString(), to: toExclusive.toISOString() };
    }
  }
}
