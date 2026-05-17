// useWeekShifts — read-only week-of-shifts view derived from shift_confirmations.
//
// The new Schedule grid (manager) and My Shifts strip (staff) both display a
// 7-day Mon→Sun snapshot of who's working. The existing data layer only knows
// about *next-day* SMS confirmations (`shift_confirmations` rows keyed by
// (property_id, staff_id, shift_date)) — there is no separate "weekly
// schedule" table yet. So we treat the union of confirmation rows in the
// visible week as ground truth: a row in {sent, confirmed} = scheduled,
// `declined` = explicitly off (rendered as empty cell), missing = day off.
//
// The hook is read-only. The week-grid header buttons ("Publish week",
// "Copy last week") are disabled in this pass; persisting a forward-looking
// weekly schedule is deferred to a follow-up that introduces a proper
// scheduled_shifts table.

import { useEffect, useState } from 'react';
import type { ShiftConfirmation } from '@/types';
import { subscribeToShiftConfirmations } from '@/lib/db';

export type WeekDayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAY_KEYS: readonly WeekDayKey[] = ['mon','tue','wed','thu','fri','sat','sun'];
export const DAY_LABELS: Record<WeekDayKey, string> = {
  mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun',
};

export interface WeekDay {
  key: WeekDayKey;
  label: string;        // 'Mon'
  date: string;         // YYYY-MM-DD
  dateLabel: string;    // 'May 11'
  dayNum: string;       // '11'
  today: boolean;
  tomorrow: boolean;
  past: boolean;        // strictly before today
}

export type WeekShiftCell =
  | { kind: 'shift'; label: string; hrs: number; status: 'sent' | 'confirmed' }
  | { kind: 'declined'; label: string }
  | { kind: 'off' };

export interface WeekShiftsResult {
  /** Day-index 0..6 metadata (Mon..Sun) for the requested week. */
  days: WeekDay[];
  /** Per-staff [Mon..Sun] cells. Missing staff keys mean no rows in the week. */
  byStaff: Record<string, WeekShiftCell[]>;
  loading: boolean;
}

// ── Date helpers ──────────────────────────────────────────────────────────
// We compute the Monday-anchored week for a reference date. Everything is
// done in local time (browser TZ); the housekeeping app already uses local
// dates throughout (formatDisplayDate, addDays in staff/page.tsx).
function ymd(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Returns YYYY-MM-DD of the Monday on or before `reference`. */
export function mondayOf(reference: Date | string): string {
  const ref = typeof reference === 'string' ? parseYmd(reference) : reference;
  const dow = ref.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const back = dow === 0 ? 6 : dow - 1;
  const mon = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - back);
  return ymd(mon);
}

/** Add n days to a YYYY-MM-DD date. */
export function addDays(date: string, n: number): string {
  const d = parseYmd(date);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function buildDays(weekStart: string): WeekDay[] {
  const today = ymd(new Date());
  const tomorrow = addDays(today, 1);
  return DAY_KEYS.map((key, i) => {
    const date = addDays(weekStart, i);
    const dt = parseYmd(date);
    return {
      key,
      label: DAY_LABELS[key],
      date,
      dateLabel: `${MONTH_SHORT[dt.getMonth()]} ${dt.getDate()}`,
      dayNum: String(dt.getDate()),
      today: date === today,
      tomorrow: date === tomorrow,
      past: date < today,
    };
  });
}

function emptyWeek(): WeekShiftCell[] {
  return Array.from({ length: 7 }, () => ({ kind: 'off' as const }));
}

function bucketRows(rows: ShiftConfirmation[], days: WeekDay[]): Record<string, WeekShiftCell[]> {
  const byStaff: Record<string, WeekShiftCell[]> = {};
  for (const r of rows) {
    const dayIdx = days.findIndex(d => d.date === r.shiftDate);
    if (dayIdx === -1) continue;
    if (!byStaff[r.staffId]) byStaff[r.staffId] = emptyWeek();
    if (r.status === 'declined') {
      byStaff[r.staffId][dayIdx] = { kind: 'declined', label: 'Declined' };
    } else if (r.status === 'confirmed' || r.status === 'sent' || r.status === 'pending') {
      // 'pending' is the legacy alias for 'sent' (link out, no reply yet).
      const status: 'sent' | 'confirmed' = r.status === 'confirmed' ? 'confirmed' : 'sent';
      byStaff[r.staffId][dayIdx] = { kind: 'shift', label: 'Shift', hrs: 8, status };
    }
  }
  return byStaff;
}

/**
 * Subscribes to shift_confirmations for the 7-day window starting at
 * `weekStart` (a YYYY-MM-DD Monday). Returns one cell per day per staff.
 *
 * The existing realtime subscription helper streams *one date at a time*,
 * so we spin up 7 parallel subscriptions and reduce. This isn't ideal but
 * it's a strict superset of what the current schedule tab already does
 * (one per visible date) and keeps the data layer untouched.
 */
export function useWeekShifts(
  propertyId: string | null,
  weekStart: string,
): WeekShiftsResult {
  const days = buildDays(weekStart);
  const [perDay, setPerDay] = useState<Record<string, ShiftConfirmation[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!propertyId) { setPerDay({}); setLoading(false); return; }
    setLoading(true);
    setPerDay({});
    let arrived = 0;
    const unsubs = days.map(d => {
      return subscribeToShiftConfirmations('', propertyId, d.date, (rows) => {
        setPerDay(prev => ({ ...prev, [d.date]: rows }));
        arrived += 1;
        if (arrived >= days.length) setLoading(false);
      });
    });
    return () => { unsubs.forEach(u => { try { u(); } catch { /* ignore */ } }); };
    // We intentionally re-run on weekStart change; days is recomputed from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, weekStart]);

  const allRows = Object.values(perDay).flat();
  const byStaff = bucketRows(allRows, days);

  return { days, byStaff, loading };
}
