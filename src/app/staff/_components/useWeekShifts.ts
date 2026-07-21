// useWeekShifts — week-of-shifts view backed by `scheduled_shifts`
// (migration 0147), with `time_off_requests` joined for the employee's
// request history. Shift row status is the draft/published visibility gate.
//
// Returns:
//   • days[]            — Mon..Sun metadata for the visible week
//   • byStaff{}         — per-staff [Mon..Sun] assigned-shift cells
//   • openShifts[]      — kind='open' rows in the visible week
//   • torPending{}      — pending TOR rows in the visible week, indexed
//                         by `${staffId}:${date}` for cell pin lookup
//   • torByStaff{}      — all TOR for the visible week, indexed by
//                         staffId (used by the My Shifts time-off card)

import { useCallback, useEffect, useState } from 'react';
import {
  subscribeToScheduledShifts, subscribeToTimeOffRequests,
} from '@/lib/db';
import type {
  ScheduledShift, TimeOffRequest,
} from '@/types';

const INITIAL_SNAPSHOT_TIMEOUT_MS = 8_000;

export type WeekDayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAY_KEYS: readonly WeekDayKey[] = ['mon','tue','wed','thu','fri','sat','sun'];
export const DAY_LABELS: Record<WeekDayKey, string> = {
  mon:'Mon', tue:'Tue', wed:'Wed', thu:'Thu', fri:'Fri', sat:'Sat', sun:'Sun',
};

export interface WeekDay {
  key: WeekDayKey;
  label: string;
  date: string;       // YYYY-MM-DD
  dateLabel: string;  // 'May 11'
  dayNum: string;     // '11'
  today: boolean;
  tomorrow: boolean;
  past: boolean;
}

export type WeekShiftCell =
  | { kind: 'shift'; shift: ScheduledShift }
  | { kind: 'off' };

export interface WeekShiftsResult {
  days: WeekDay[];
  byStaff: Record<string, WeekShiftCell[]>;
  openShifts: ScheduledShift[];
  torPending: Record<string, TimeOffRequest>;
  torByStaff: Record<string, TimeOffRequest[]>;
  loading: boolean;
  loadError: string | null;
  retry: () => void;
}

// ── Date helpers ──────────────────────────────────────────────────────────
function ymd(d: Date): string {
  return d.toLocaleDateString('en-CA');
}
function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** YYYY-MM-DD of the Monday on or before `reference`. */
export function mondayOf(reference: Date | string): string {
  const ref = typeof reference === 'string' ? parseYmd(reference) : reference;
  const dow = ref.getDay(); // 0=Sun
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

export function useWeekShifts(
  propertyId: string | null,
  weekStart: string,
  staffId: string | null,
): WeekShiftsResult {
  const days = buildDays(weekStart);
  const weekEnd = days[6].date;

  const [shifts, setShifts] = useState<ScheduledShift[]>([]);
  const [tor, setTor] = useState<TimeOffRequest[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const requestedKey = propertyId && staffId
    ? `${propertyId}:${weekStart}:${weekEnd}:${staffId}`
    : null;
  const loading = requestedKey !== null && loadedKey !== requestedKey && !loadError;
  const retry = useCallback(() => setRetryNonce(n => n + 1), []);

  useEffect(() => {
    if (!propertyId || !staffId || !requestedKey) {
      setShifts([]); setTor([]);
      setLoadedKey(null);
      setLoadError(null);
      return;
    }
    const subscriptionKey = requestedKey;
    let cancelled = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set(['shifts', 'tor']);
    const done = (part: string) => {
      if (cancelled || settled) return;
      pending.delete(part);
      if (pending.size === 0) {
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        setLoadedKey(subscriptionKey);
      }
    };
    const fail = () => {
      if (cancelled || settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      setLoadError('Could not load your shifts. Check your connection and try again.');
    };
    setShifts([]); setTor([]);
    setLoadedKey(null);
    setLoadError(null);
    timeoutId = setTimeout(fail, INITIAL_SNAPSHOT_TIMEOUT_MS);
    const unSubs = [
      subscribeToScheduledShifts('', propertyId, weekStart, weekEnd, (rows) => {
        setShifts(rows);
        done('shifts');
      }, fail),
      subscribeToTimeOffRequests('', propertyId, (rows) => {
        setTor(rows);
        done('tor');
      }, staffId, fail),
    ];
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      unSubs.forEach(u => { try { u(); } catch { /* ignore */ } });
    };
  }, [propertyId, weekStart, weekEnd, staffId, requestedKey, retryNonce]);

  const snapshotReady = loadedKey === requestedKey;
  const visibleShifts = snapshotReady ? shifts : [];
  const visibleTor = snapshotReady ? tor : [];

  // Bucket assigned shifts per (staff, day). Open shifts collected separately.
  const byStaff: Record<string, WeekShiftCell[]> = {};
  const openShifts: ScheduledShift[] = [];
  for (const s of visibleShifts) {
    if (s.kind === 'open') { openShifts.push(s); continue; }
    if (!s.staffId) continue;
    const dayIdx = days.findIndex(d => d.date === s.shiftDate);
    if (dayIdx === -1) continue;
    if (!byStaff[s.staffId]) byStaff[s.staffId] = emptyWeek();
    byStaff[s.staffId][dayIdx] = { kind: 'shift', shift: s };
  }

  // TOR indices scoped to the visible week.
  const torPending: Record<string, TimeOffRequest> = {};
  const torByStaff: Record<string, TimeOffRequest[]> = {};
  for (const r of visibleTor) {
    if (r.requestDate >= weekStart && r.requestDate <= weekEnd && r.status === 'pending') {
      torPending[`${r.staffId}:${r.requestDate}`] = r;
    }
    if (!torByStaff[r.staffId]) torByStaff[r.staffId] = [];
    torByStaff[r.staffId].push(r);
  }

  return {
    days, byStaff, openShifts, torPending, torByStaff,
    loading, loadError, retry,
  };
}
