// useScheduleData — data layer for the unified Schedule tab.
//
// Server truth: scheduled_shifts over a rolling window (realtime, one
// channel), presets + time-off (realtime), templates + week sign-offs
// (fetched via /api/staff-schedule/*).
//
// Editing model: the board edits an optimistic per-day override
// (`overrides[date]`), then persists through POST /api/staff-schedule/fill
// (bulk replace-day semantics — also what Fill applies and Undo use). An
// override stays up until the realtime refetch catches up and deep-equals
// it (no flash), with two early-drop paths: save failure (revert to server
// truth) and server-side skips (approved time-off / departed staff — the
// server's result is intentionally different from what we showed).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  subscribeToScheduledShifts, subscribeToTimeOffRequests, subscribeToShiftPresets,
} from '@/lib/db';
import type { ScheduledShift, ShiftPreset, StaffMember, TimeOffRequest, StaffDepartment } from '@/types';
import {
  addDaysYmd, sundayOf, toMin, toHHMM, sameShiftSet, ymdToday,
  type BoardShift,
} from '@/lib/schedule-board';
import { asDeptKey } from '../_tokens';

const WEEKS_BACK = 12;        // initial history window
const WEEKS_AHEAD = 8;        // planning horizon
const MAX_WEEKS_BACK = 30;    // arrows stop here (~7 months)
const UNDO_MAX = 30;

export interface TemplateShift {
  staffId: string;
  department: StaffDepartment;
  startMin: number;
  endMin: number;
}
export interface ScheduleTemplate {
  id: string;
  scope: 'day' | 'week';
  name: string;
  payload: TemplateShift[] | TemplateShift[][];
}

export interface FillResult {
  inserted: number;
  updated: number;
  deleted: number;
  skippedTimeOff: number;
  skippedUnknown: number;
}

/**
 * Everything the schedule surface needs from its data source. The real tab
 * implements it with Supabase + /api/staff-schedule; the public demo page
 * implements the same shape entirely in memory.
 */
export type ScheduleData = ReturnType<typeof useScheduleData>;

interface DayEntry { date: string; shifts: BoardShift[] }

function freshNonce(): number {
  return Date.now() + Math.floor(Math.random() * 1000);
}

export function useScheduleData(propertyId: string | null, staff: StaffMember[]) {
  // ── Today + rolling window ────────────────────────────────────────────
  const [today, setToday] = useState<string>(() => ymdToday());
  useEffect(() => {
    const t = setInterval(() => {
      const now = ymdToday();
      setToday(prev => (prev === now ? prev : now));
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const thisSunday = sundayOf(today);
  const [weeksBack, setWeeksBack] = useState(WEEKS_BACK);
  const windowStart = addDaysYmd(thisSunday, -7 * weeksBack);
  const windowEnd = addDaysYmd(thisSunday, 7 * WEEKS_AHEAD + 6);
  const extendBack = useCallback(() => {
    setWeeksBack(w => Math.min(MAX_WEEKS_BACK, w + 4));
  }, []);
  const canExtendBack = weeksBack < MAX_WEEKS_BACK;

  // ── Realtime: shifts in window, presets, time-off ─────────────────────
  const [serverShifts, setServerShifts] = useState<ScheduledShift[]>([]);
  const [presets, setPresets] = useState<ShiftPreset[]>([]);
  const [tor, setTor] = useState<TimeOffRequest[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!propertyId) {
      setServerShifts([]); setPresets([]); setTor([]); setLoading(false);
      return;
    }
    setLoading(true);
    const unsubs = [
      subscribeToScheduledShifts('', propertyId, windowStart, windowEnd, rows => {
        setServerShifts(rows);
        setLoading(false);
      }),
      subscribeToShiftPresets('', propertyId, setPresets),
      subscribeToTimeOffRequests('', propertyId, setTor),
    ];
    return () => { unsubs.forEach(u => { try { u(); } catch { /* ignore */ } }); };
  }, [propertyId, windowStart, windowEnd]);

  // ── Server day map (assigned shifts only), stable name order ──────────
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of staff) m.set(s.id, s.name);
    return (id: string) => m.get(id) ?? '—';
  }, [staff]);

  const serverDayMap = useMemo(() => {
    const map: Record<string, BoardShift[]> = {};
    for (const s of serverShifts) {
      if (s.kind !== 'shift' || !s.staffId) continue;
      const startMin = toMin(s.startTime);
      let endMin = toMin(s.endTime);
      if (endMin <= startMin) endMin = 24 * 60; // legacy overnight rows: clamp at midnight
      (map[s.shiftDate] ??= []).push({
        id: s.id,
        staffId: s.staffId,
        dept: asDeptKey(s.department),
        startMin,
        endMin,
        note: s.note ?? null,
      });
    }
    for (const date of Object.keys(map)) {
      map[date].sort((a, b) => nameOf(a.staffId).localeCompare(nameOf(b.staffId)));
    }
    return map;
  }, [serverShifts, nameOf]);

  // ── Optimistic per-day overrides ──────────────────────────────────────
  // liveOv is the SYNCHRONOUS source of truth for local edits — saves fired
  // in the same tick as a mutation must see it immediately (React state
  // flushes too late; reading state here once shipped an empty day to the
  // server right after "Add staff"). `overrides` is its render mirror.
  const liveOv = useRef<Record<string, BoardShift[]>>({});
  const [overrides, setOverrides] = useState<Record<string, BoardShift[]>>({});
  const syncOv = useCallback(() => setOverrides({ ...liveOv.current }), []);
  const serverDayMapRef = useRef(serverDayMap);
  serverDayMapRef.current = serverDayMap;
  const pendingSaves = useRef(new Map<string, number>());
  // Outstanding 8s reconcile-failsafe timers (see saveDays). Tracked so a
  // property switch or unmount can cancel them — otherwise a stale timer
  // fires clearOverrides on already-reset state.
  const failsafeTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  // Bumped on every property switch. A saveDays call whose POST resolves
  // AFTER the switch must not arm a fresh failsafe timer (the cleanup below
  // already ran), or it would wipe the NEW property's optimistic edits 8s in.
  const saveGeneration = useRef(0);
  const gestureActive = useRef(false);
  const undoStack = useRef<DayEntry[][]>([]);
  const [undoCount, setUndoCount] = useState(0);

  // Property switch → drop another hotel's local edits and undo history.
  useEffect(() => {
    liveOv.current = {};
    setOverrides({});
    pendingSaves.current.clear();
    gestureActive.current = false;
    undoStack.current = [];
    setUndoCount(0);
    saveGeneration.current += 1;
    // Cancel any in-flight reconcile-failsafe timers from the prior property
    // (runs on propertyId change and on unmount). Copy the ref into a local
    // so the cleanup reads a stable value — the Set identity never changes.
    const timers = failsafeTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, [propertyId]);

  /** Current truth for a day: local overlay if present, else server. */
  const getDay = useCallback((date: string): BoardShift[] => {
    return overrides[date] ?? serverDayMap[date] ?? [];
  }, [overrides, serverDayMap]);
  /** Same, but reading the synchronous overlay (for saves/snapshots). */
  const getDayLive = useCallback((date: string): BoardShift[] => {
    return liveOv.current[date] ?? serverDayMapRef.current[date] ?? [];
  }, []);

  // Reconcile: once the refetch catches up to an override, drop it.
  useEffect(() => {
    const dates = Object.keys(liveOv.current);
    if (dates.length === 0) return;
    let dropped = false;
    for (const date of dates) {
      if (gestureActive.current) continue;
      if ((pendingSaves.current.get(date) ?? 0) > 0) continue;
      const server = serverDayMap[date] ?? [];
      if (sameShiftSet(liveOv.current[date], server)) {
        delete liveOv.current[date];
        dropped = true;
      }
    }
    if (dropped) syncOv();
  }, [serverDayMap, syncOv]);

  const clearOverrides = useCallback((dates: string[]) => {
    for (const d of dates) delete liveOv.current[d];
    syncOv();
  }, [syncOv]);

  const setDayLocal = useCallback((date: string, next: BoardShift[] | ((cur: BoardShift[]) => BoardShift[])) => {
    const cur = liveOv.current[date] ?? serverDayMapRef.current[date] ?? [];
    liveOv.current[date] = typeof next === 'function' ? next(cur) : next;
    syncOv();
  }, [syncOv]);

  const beginGesture = useCallback(() => { gestureActive.current = true; }, []);
  const endGesture = useCallback(() => { gestureActive.current = false; }, []);

  // ── Persistence: bulk replace-days ────────────────────────────────────
  // The fill endpoint takes ≤7 days per call; bigger writes (auto-repeat
  // across upcoming weeks, undo of one) go out as sequential week chunks.
  const saveDays = useCallback(async (entries: DayEntry[]): Promise<FillResult> => {
    if (!propertyId) throw new Error('No property selected');
    const genAtStart = saveGeneration.current;
    for (const e of entries) {
      pendingSaves.current.set(e.date, (pendingSaves.current.get(e.date) ?? 0) + 1);
    }
    try {
      const data: FillResult = { inserted: 0, updated: 0, deleted: 0, skippedTimeOff: 0, skippedUnknown: 0 };
      for (let i = 0; i < entries.length; i += 7) {
        const chunk = entries.slice(i, i + 7);
        const res = await fetchWithAuth('/api/staff-schedule/fill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hotelId: propertyId,
            days: chunk.map(e => ({
              date: e.date,
              shifts: e.shifts.map(s => ({
                staffId: s.staffId,
                department: s.dept,
                startTime: toHHMM(s.startMin),
                endTime: toHHMM(Math.min(s.endMin, 24 * 60 - 1)),
                note: s.note ?? null,
                ...(s.overrideTimeOff ? { overrideTimeOff: true } : {}),
              })),
            })),
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || 'Save failed');
        const part = (body?.data ?? {}) as Partial<FillResult>;
        data.inserted += part.inserted ?? 0;
        data.updated += part.updated ?? 0;
        data.deleted += part.deleted ?? 0;
        data.skippedTimeOff += part.skippedTimeOff ?? 0;
        data.skippedUnknown += part.skippedUnknown ?? 0;
      }
      // Server intentionally diverged (time-off / departed staff): show its
      // truth as soon as the refetch lands instead of pinning our version.
      if ((data.skippedTimeOff ?? 0) > 0 || (data.skippedUnknown ?? 0) > 0) {
        clearOverrides(entries.map(e => e.date));
      } else if (saveGeneration.current === genAtStart) {
        // Failsafe: never leave an override pinned forever if the refetch
        // and the override disagree for reasons we didn't anticipate.
        // Skipped when the property changed mid-flight — this save's dates
        // belong to the OLD property, and clearing them 8s from now would
        // wipe the new property's fresh optimistic edits instead.
        const dates = entries.map(e => e.date);
        const handle = setTimeout(() => {
          failsafeTimers.current.delete(handle);
          const stillPending = dates.some(d => (pendingSaves.current.get(d) ?? 0) > 0);
          if (!stillPending && !gestureActive.current) clearOverrides(dates);
        }, 8000);
        failsafeTimers.current.add(handle);
      }
      return data;
    } catch (e) {
      clearOverrides(entries.map(e2 => e2.date)); // revert to server truth
      throw e;
    } finally {
      for (const e of entries) {
        const n = (pendingSaves.current.get(e.date) ?? 1) - 1;
        if (n <= 0) pendingSaves.current.delete(e.date);
        else pendingSaves.current.set(e.date, n);
      }
    }
  }, [propertyId, clearOverrides]);

  /** Persist the current local state of a single day (gesture end). */
  const commitDay = useCallback((date: string) => {
    return saveDays([{ date, shifts: getDayLive(date) }]);
  }, [saveDays, getDayLive]);

  /** Optimistically replace whole days (Fill / template / undo) and save. */
  const applyDays = useCallback((entries: DayEntry[], animate: boolean) => {
    const nonce = freshNonce();
    for (const e of entries) {
      liveOv.current[e.date] = e.shifts.map((s, i) => ({
        ...s,
        ...(animate ? { anim: true, nonce: nonce + i } : {}),
      }));
    }
    syncOv();
    return saveDays(entries);
  }, [saveDays, syncOv]);

  // ── Undo (client-side snapshots, replayed through saveDays) ───────────
  const pushUndo = useCallback((dates: string[]) => {
    undoStack.current.push(dates.map(date => ({
      date,
      shifts: getDayLive(date).map(s => ({ ...s, anim: undefined, nonce: undefined })),
    })));
    if (undoStack.current.length > UNDO_MAX) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  }, [getDayLive]);

  const undo = useCallback((): Promise<FillResult> | null => {
    const snap = undoStack.current.pop();
    if (!snap) return null;
    setUndoCount(undoStack.current.length);
    return applyDays(snap, true);
  }, [applyDays]);

  // ── Templates ─────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<ScheduleTemplate[]>([]);
  useEffect(() => {
    if (!propertyId) { setTemplates([]); return; }
    let dead = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/staff-schedule/templates?hotelId=${propertyId}`);
        const body = await res.json().catch(() => ({}));
        if (!dead && res.ok) setTemplates(body?.data?.templates ?? []);
      } catch { /* template list is non-critical; Fill modal shows empty state */ }
    })();
    return () => { dead = true; };
  }, [propertyId]);

  const saveTemplate = useCallback(async (
    scope: 'day' | 'week', name: string, payload: TemplateShift[] | TemplateShift[][],
  ) => {
    if (!propertyId) throw new Error('No property selected');
    const res = await fetchWithAuth('/api/staff-schedule/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotelId: propertyId, scope, name, payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || 'Failed to save template');
    const t = body?.data?.template as ScheduleTemplate;
    setTemplates(prev => [...prev, t]);
    return t;
  }, [propertyId]);

  const deleteTemplate = useCallback(async (id: string) => {
    if (!propertyId) return;
    const res = await fetchWithAuth(`/api/staff-schedule/templates?hotelId=${propertyId}&id=${id}`, { method: 'DELETE' });
    if (res.ok) setTemplates(prev => prev.filter(t => t.id !== id));
  }, [propertyId]);

  // ── Week sign-offs ("Finish week") ────────────────────────────────────
  const [doneWeeks, setDoneWeeks] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!propertyId) { setDoneWeeks(new Set()); return; }
    let dead = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/staff-schedule/week-done?hotelId=${propertyId}`);
        const body = await res.json().catch(() => ({}));
        if (!dead && res.ok) setDoneWeeks(new Set<string>(body?.data?.weeks ?? []));
      } catch { /* sign-offs are cosmetic; default to none */ }
    })();
    return () => { dead = true; };
  }, [propertyId]);

  const setWeekDone = useCallback(async (weekStart: string, done: boolean) => {
    if (!propertyId) return;
    setDoneWeeks(prev => {
      const next = new Set(prev);
      if (done) next.add(weekStart); else next.delete(weekStart);
      return next;
    });
    try {
      const res = await fetchWithAuth('/api/staff-schedule/week-done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hotelId: propertyId, weekStart, done }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      setDoneWeeks(prev => { // roll back the optimistic flip
        const next = new Set(prev);
        if (done) next.delete(weekStart); else next.add(weekStart);
        return next;
      });
      throw new Error('Could not save the week sign-off');
    }
  }, [propertyId]);

  // ── Time-off ──────────────────────────────────────────────────────────
  const pendingTor = useMemo(
    () => tor.filter(r => r.status === 'pending')
      .sort((a, b) => a.requestDate.localeCompare(b.requestDate)),
    [tor],
  );
  const decidedTor = useMemo(
    () => tor.filter(r => r.status === 'approved' || r.status === 'denied')
      .sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0))
      .slice(0, 30),
    [tor],
  );
  /** Approved future-facing requests — the board warns before scheduling over one. */
  const approvedTor = useMemo(
    () => tor.filter(r => r.status === 'approved'),
    [tor],
  );

  const decideTor = useCallback(async (id: string, decision: 'approve' | 'deny', denyReason?: string) => {
    if (!propertyId) return;
    const res = await fetchWithAuth('/api/staff-schedule/time-off', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotelId: propertyId, id, decision, ...(denyReason ? { denyReason } : {}) }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || 'Update failed');
    }
  }, [propertyId]);

  // ── Per-date shift counts (week boxes / strips) ───────────────────────
  const countByDate = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [date, list] of Object.entries(serverDayMap)) m[date] = list.length;
    for (const [date, list] of Object.entries(overrides)) m[date] = list.length;
    return m;
  }, [serverDayMap, overrides]);

  return {
    today, windowStart, windowEnd, extendBack, canExtendBack, loading,
    presets, nameOf,
    getDay, countByDate,
    setDayLocal, beginGesture, endGesture, commitDay, applyDays,
    pushUndo, undo, undoCount,
    templates, saveTemplate, deleteTemplate,
    doneWeeks, setWeekDone,
    pendingTor, decidedTor, approvedTor, decideTor,
  };
}
