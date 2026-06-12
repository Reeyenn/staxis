// useDemoScheduleData — in-memory stand-in for useScheduleData that powers
// the public /demo/schedule page. Same ScheduleData shape, zero backend:
// a sample 10-person roster with weekly patterns (history fully staffed,
// this week planned, future weeks empty so Fill has something to do).
// Every interaction works — drag, fill, templates, undo, time-off — and
// nothing persists anywhere.

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ShiftPreset, StaffMember, TimeOffRequest, StaffDepartment } from '@/types';
import {
  addDaysYmd, sundayOf, ymdToday, parseYmd, toMin,
  type BoardShift,
} from '@/lib/schedule-board';
import type { ScheduleData, ScheduleTemplate, TemplateShift, FillResult } from './useScheduleData';

const WEEKS_BACK = 12;
const WEEKS_AHEAD = 8;
const UNDO_MAX = 30;

const ZERO_FILL: FillResult = { inserted: 0, updated: 0, deleted: 0, skippedTimeOff: 0, skippedUnknown: 0 };

// ── sample roster ───────────────────────────────────────────────────────────
function demoStaff(id: string, name: string, department: StaffDepartment): StaffMember {
  return {
    id, name, department,
    language: 'en', isSenior: false, scheduledToday: false,
    weeklyHours: 0, maxWeeklyHours: 40, isActive: true,
  };
}

export const DEMO_STAFF: StaffMember[] = [
  demoStaff('demo-brenda', 'Brenda Marquez', 'housekeeping'),
  demoStaff('demo-diego', 'Diego Ruiz', 'housekeeping'),
  demoStaff('demo-carla', 'Carla Sandoval', 'housekeeping'),
  demoStaff('demo-yesenia', 'Yesenia Pineda', 'housekeeping'),
  demoStaff('demo-marco', 'Marco Tovar', 'housekeeping'),
  demoStaff('demo-aisha', 'Aisha Khan', 'front_desk'),
  demoStaff('demo-tom', 'Tom Becker', 'front_desk'),
  demoStaff('demo-priya', 'Priya Nair', 'front_desk'),
  demoStaff('demo-luis', 'Luis Garza', 'maintenance'),
  demoStaff('demo-sam', 'Sam Whitfield', 'maintenance'),
];

const DEMO_PRESETS: ShiftPreset[] = ([
  ['demo-hk-am', 'Morning', 'housekeeping', '08:00', '16:00', 0],
  ['demo-hk-mid', 'Mid', 'housekeeping', '10:00', '18:00', 1],
  ['demo-hk-pm', 'Evening', 'housekeeping', '13:00', '21:00', 2],
  ['demo-fd-am', 'Open', 'front_desk', '07:00', '15:00', 0],
  ['demo-fd-pm', 'Close', 'front_desk', '15:00', '23:00', 1],
  ['demo-mt-day', 'Day', 'maintenance', '09:00', '17:00', 0],
] as const).map(([id, name, department, startTime, endTime, sortOrder]) => ({
  id, name, department, startTime, endTime, sortOrder,
  propertyId: 'demo', createdAt: new Date(0), updatedAt: new Date(0),
}));

// Weekly pattern per person: preset id by day-of-week (0=Sun..6=Sat).
const PATTERNS: Record<string, (string | null)[]> = {
  'demo-brenda': [null, 'demo-hk-am', 'demo-hk-am', 'demo-hk-am', 'demo-hk-am', 'demo-hk-am', null],
  'demo-diego': [null, 'demo-hk-am', 'demo-hk-am', 'demo-hk-mid', 'demo-hk-am', 'demo-hk-am', 'demo-hk-am'],
  'demo-carla': ['demo-hk-mid', null, 'demo-hk-mid', 'demo-hk-mid', 'demo-hk-mid', null, 'demo-hk-mid'],
  'demo-yesenia': ['demo-hk-pm', 'demo-hk-pm', 'demo-hk-pm', null, 'demo-hk-pm', 'demo-hk-pm', null],
  'demo-marco': [null, null, 'demo-hk-am', null, 'demo-hk-am', null, null],
  'demo-aisha': [null, 'demo-fd-am', 'demo-fd-am', 'demo-fd-am', 'demo-fd-am', 'demo-fd-am', null],
  'demo-tom': ['demo-fd-pm', 'demo-fd-pm', 'demo-fd-pm', null, 'demo-fd-pm', 'demo-fd-pm', 'demo-fd-pm'],
  'demo-priya': [null, null, 'demo-fd-am', 'demo-fd-pm', null, 'demo-fd-am', 'demo-fd-am'],
  'demo-luis': [null, 'demo-mt-day', 'demo-mt-day', 'demo-mt-day', 'demo-mt-day', 'demo-mt-day', null],
  'demo-sam': [null, null, null, 'demo-mt-day', null, null, 'demo-mt-day'],
};

const PRESET_BY_ID = new Map(DEMO_PRESETS.map(p => [p.id, p]));
const DEPT_BY_STAFF = new Map(DEMO_STAFF.map(s => [s.id, s.department as StaffDepartment]));

/** The pattern-derived roster for a date (stable ids → stable React keys). */
function patternFor(date: string): BoardShift[] {
  const dow = parseYmd(date).getDay();
  const out: BoardShift[] = [];
  for (const s of DEMO_STAFF) {
    const pid = PATTERNS[s.id]?.[dow];
    if (!pid) continue;
    const p = PRESET_BY_ID.get(pid)!;
    out.push({
      id: `seed-${s.id}-${date}`,
      staffId: s.id,
      dept: DEPT_BY_STAFF.get(s.id)!,
      startMin: toMin(p.startTime),
      endMin: toMin(p.endTime),
    });
  }
  return out;
}

interface DayEntry { date: string; shifts: BoardShift[] }

export function useDemoScheduleData(): ScheduleData {
  const today = useMemo(() => ymdToday(), []);
  const thisSunday = sundayOf(today);
  const thisSaturday = addDaysYmd(thisSunday, 6);

  const [weeksBack, setWeeksBack] = useState(WEEKS_BACK);
  const windowStart = addDaysYmd(thisSunday, -7 * weeksBack);
  const windowEnd = addDaysYmd(thisSunday, 7 * WEEKS_AHEAD + 6);
  const extendBack = useCallback(() => setWeeksBack(w => Math.min(30, w + 4)), []);

  // Edited days overlay the pattern; future weeks default to empty so the
  // Fill flow has real work to show off.
  const live = useRef<Record<string, BoardShift[]>>({});
  const [dayMap, setDayMap] = useState<Record<string, BoardShift[]>>({});
  const syncDays = useCallback(() => setDayMap({ ...live.current }), []);

  const fallbackFor = useCallback((date: string): BoardShift[] => {
    return date <= thisSaturday ? patternFor(date) : [];
  }, [thisSaturday]);

  const getDay = useCallback((date: string): BoardShift[] => {
    return dayMap[date] ?? fallbackFor(date);
  }, [dayMap, fallbackFor]);

  const getLive = useCallback((date: string): BoardShift[] => {
    return live.current[date] ?? fallbackFor(date);
  }, [fallbackFor]);

  const setDayLocal = useCallback((date: string, next: BoardShift[] | ((cur: BoardShift[]) => BoardShift[])) => {
    const cur = getLive(date);
    live.current[date] = typeof next === 'function' ? next(cur) : next;
    syncDays();
  }, [getLive, syncDays]);

  const beginGesture = useCallback(() => { /* in-memory — nothing to guard */ }, []);
  const endGesture = useCallback(() => { /* in-memory — nothing to flush */ }, []);
  const commitDay = useCallback((_date: string) => Promise.resolve(ZERO_FILL), []);

  const applyDays = useCallback((entries: DayEntry[], animate: boolean) => {
    const nonce = Date.now();
    for (const e of entries) {
      live.current[e.date] = e.shifts.map((s, i) => ({
        ...s,
        ...(animate ? { anim: true, nonce: nonce + i } : {}),
      }));
    }
    syncDays();
    return Promise.resolve(ZERO_FILL);
  }, [syncDays]);

  // ── undo ──────────────────────────────────────────────────────────────
  const undoStack = useRef<DayEntry[][]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const pushUndo = useCallback((dates: string[]) => {
    undoStack.current.push(dates.map(date => ({
      date,
      shifts: getLive(date).map(s => ({ ...s, anim: undefined, nonce: undefined })),
    })));
    if (undoStack.current.length > UNDO_MAX) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  }, [getLive]);
  const undo = useCallback((): Promise<FillResult> | null => {
    const snap = undoStack.current.pop();
    if (!snap) return null;
    setUndoCount(undoStack.current.length);
    return applyDays(snap, true);
  }, [applyDays]);

  // ── templates (in-memory) ─────────────────────────────────────────────
  const [templates, setTemplates] = useState<ScheduleTemplate[]>([]);
  const tplSeq = useRef(0);
  const saveTemplate = useCallback(async (
    scope: 'day' | 'week', name: string, payload: TemplateShift[] | TemplateShift[][],
  ): Promise<ScheduleTemplate> => {
    const t: ScheduleTemplate = { id: `demo-tpl-${++tplSeq.current}`, scope, name, payload };
    setTemplates(prev => [...prev, t]);
    return t;
  }, []);
  const deleteTemplate = useCallback(async (id: string) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
  }, []);

  // ── week sign-offs (in-memory) ────────────────────────────────────────
  const [doneWeeks, setDoneWeeks] = useState<Set<string>>(new Set());
  const setWeekDone = useCallback(async (weekStart: string, done: boolean) => {
    setDoneWeeks(prev => {
      const next = new Set(prev);
      if (done) next.add(weekStart); else next.delete(weekStart);
      return next;
    });
  }, []);

  // ── time-off (two pending requests to play with) ──────────────────────
  const [tor, setTor] = useState<TimeOffRequest[]>(() => [
    {
      id: 'demo-tor-1', propertyId: 'demo', staffId: 'demo-carla',
      requestDate: addDaysYmd(today, 1), reason: 'Doctor appt', status: 'pending',
      submittedAt: new Date(), decidedAt: null, decidedBy: null, denyReason: null,
    },
    {
      id: 'demo-tor-2', propertyId: 'demo', staffId: 'demo-priya',
      requestDate: addDaysYmd(today, 3), reason: 'Family', status: 'pending',
      submittedAt: new Date(), decidedAt: null, decidedBy: null, denyReason: null,
    },
  ]);
  const pendingTor = useMemo(() => tor.filter(r => r.status === 'pending'), [tor]);
  const decidedTor = useMemo(
    () => tor.filter(r => r.status !== 'pending')
      .sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0)),
    [tor],
  );
  const decideTor = useCallback(async (id: string, decision: 'approve' | 'deny', denyReason?: string) => {
    const req = tor.find(r => r.id === id);
    setTor(prev => prev.map(r => r.id === id
      ? { ...r, status: decision === 'approve' ? 'approved' : 'denied', decidedAt: new Date(), denyReason: denyReason ?? null }
      : r));
    // Mirror the real behavior: approving time off pulls their shift that day.
    if (decision === 'approve' && req) {
      const cur = getLive(req.requestDate);
      live.current[req.requestDate] = cur.filter(s => s.staffId !== req.staffId);
      syncDays();
    }
  }, [tor, getLive, syncDays]);

  // ── per-date counts for the week boxes ────────────────────────────────
  const countByDate = useMemo(() => {
    const m: Record<string, number> = {};
    for (let d = windowStart; d <= windowEnd; d = addDaysYmd(d, 1)) {
      m[d] = (dayMap[d] ?? fallbackFor(d)).length;
    }
    return m;
  }, [dayMap, windowStart, windowEnd, fallbackFor]);

  const nameOf = useCallback((id: string) => DEMO_STAFF.find(s => s.id === id)?.name ?? '—', []);

  return {
    today, windowStart, windowEnd, extendBack, canExtendBack: weeksBack < 30, loading: false,
    presets: DEMO_PRESETS, nameOf,
    getDay, countByDate,
    setDayLocal, beginGesture, endGesture, commitDay, applyDays,
    pushUndo, undo, undoCount,
    templates, saveTemplate, deleteTemplate,
    doneWeeks, setWeekDone,
    pendingTor, decidedTor, decideTor,
  };
}
