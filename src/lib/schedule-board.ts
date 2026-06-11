// schedule-board — pure helpers for the unified Staff → Schedule tab.
//
// Everything here is date/time math and formatting with zero React or
// Supabase dependencies so it stays unit-testable. The tab's calendar is
// Sunday-keyed (weeks run Sun–Sat, per the design); all dates are local
// YYYY-MM-DD strings, all in-day times are minutes since midnight.

import type { ShiftPreset, StaffDepartment } from '@/types';

// ─── Minutes ↔ HH:MM ↔ display ─────────────────────────────────────────────

export function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h)) return 0;
  return h * 60 + (m || 0);
}

export function toHHMM(min: number): string {
  const m = Math.max(0, Math.min(24 * 60, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 480 → '8a' · 510 → '8:30a' · 720 → '12p' */
export function fmtMin(min: number): string {
  const h = Math.floor(min / 60), mm = min % 60;
  const ap = h >= 12 ? 'p' : 'a';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return mm ? `${h12}:${String(mm).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}

export function fmtMinRange(s: number, e: number): string {
  return `${fmtMin(s)}–${fmtMin(e)}`;
}

/** 'HH:MM' → 8a / 8:30a (string-time flavor, used by My Shifts). */
export function fmtTime(t: string): string {
  return fmtMin(toMin(t));
}

export function fmtRange(start: string, end: string): string {
  return `${fmtTime(start)}–${fmtTime(end)}`;
}

// ─── Local-date strings ─────────────────────────────────────────────────────

export function ymdOf(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function ymdToday(): string {
  return ymdOf(new Date());
}

export function addDaysYmd(date: string, n: number): string {
  const d = parseYmd(date);
  d.setDate(d.getDate() + n);
  return ymdOf(d);
}

/** YYYY-MM-DD of the Sunday on or before the given date. */
export function sundayOf(reference: Date | string): string {
  const ref = typeof reference === 'string' ? parseYmd(reference) : reference;
  const sun = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - ref.getDay());
  return ymdOf(sun);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86_400_000);
}

// ─── Calendar labels (EN / ES) ──────────────────────────────────────────────

export type Lang = 'en' | 'es';

const DOW_SHORT: Record<Lang, string[]> = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  es: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
};
const DOW_FULL: Record<Lang, string[]> = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  es: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
};
const MON_SHORT: Record<Lang, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
};

export interface DayInfo {
  date: string;     // YYYY-MM-DD
  dow: string;      // Mon
  dowFull: string;  // Monday
  dayNum: number;   // 8
  mon: string;      // Jun
  today: boolean;
  tomorrow: boolean;
  yesterday: boolean;
  past: boolean;
}

export function dayInfo(date: string, todayYmd: string, lang: Lang): DayInfo {
  const d = parseYmd(date);
  const dow = d.getDay();
  return {
    date,
    dow: DOW_SHORT[lang][dow],
    dowFull: DOW_FULL[lang][dow],
    dayNum: d.getDate(),
    mon: MON_SHORT[lang][d.getMonth()],
    today: date === todayYmd,
    tomorrow: date === addDaysYmd(todayYmd, 1),
    yesterday: date === addDaysYmd(todayYmd, -1),
    past: date < todayYmd,
  };
}

export interface WeekInfo {
  start: string;    // Sunday YYYY-MM-DD
  days: DayInfo[];  // 7 entries Sun..Sat
  label: string;    // 'Jun 7–13' | 'Jun 28 – Jul 4'
  current: boolean;
  past: boolean;
}

/** 'Jun 7–13' within one month, 'Jun 28 – Jul 4' across months. */
export function weekLabel(start: string, lang: Lang): string {
  const a = parseYmd(start);
  const b = parseYmd(addDaysYmd(start, 6));
  const am = MON_SHORT[lang][a.getMonth()], bm = MON_SHORT[lang][b.getMonth()];
  return am === bm
    ? `${am} ${a.getDate()}–${b.getDate()}`
    : `${am} ${a.getDate()} – ${bm} ${b.getDate()}`;
}

/** Sun-keyed week windows covering [windowStart, windowEnd]. */
export function buildWeeks(
  windowStart: string, windowEnd: string, todayYmd: string, lang: Lang,
): WeekInfo[] {
  const out: WeekInfo[] = [];
  const thisWeek = sundayOf(todayYmd);
  for (let ws = sundayOf(windowStart); ws <= windowEnd; ws = addDaysYmd(ws, 7)) {
    const days = Array.from({ length: 7 }, (_, i) => dayInfo(addDaysYmd(ws, i), todayYmd, lang));
    out.push({
      start: ws,
      days,
      label: weekLabel(ws, lang),
      current: ws === thisWeek,
      past: ws < thisWeek,
    });
  }
  return out;
}

// ─── Departments / board geometry ──────────────────────────────────────────

export const BOARD_DEPTS: StaffDepartment[] = ['housekeeping', 'front_desk', 'maintenance'];
export const BOARD_START_MIN = 6 * 60;   // 6:00
export const BOARD_END_MIN = 22 * 60;    // 22:00

/** Fallback default shift per department when a property has no presets. */
export const DEFAULT_DEPT_TIMES: Record<StaffDepartment, { s: number; e: number }> = {
  housekeeping: { s: 8 * 60, e: 16 * 60 },
  front_desk: { s: 7 * 60, e: 15 * 60 },
  maintenance: { s: 9 * 60, e: 17 * 60 },
  other: { s: 9 * 60, e: 17 * 60 },
};

/** A department's default shift = its first preset, else the static fallback. */
export function deptDefaultTimes(
  dept: StaffDepartment, presets: ShiftPreset[],
): { s: number; e: number } {
  const p = presets.find(x => x.department === dept);
  if (p) {
    const s = toMin(p.startTime), e = toMin(p.endTime);
    if (e > s) return { s, e };
  }
  return DEFAULT_DEPT_TIMES[dept];
}

/** All preset start (or end) boundaries for a department, as minutes. */
export function presetBoundaries(
  dept: StaffDepartment, presets: ShiftPreset[], which: 'start' | 'end',
): number[] {
  return presets
    .filter(p => p.department === dept)
    .map(p => toMin(which === 'start' ? p.startTime : p.endTime));
}

/**
 * Snap a dragged minute value toward the department's saved shift times
 * (within `thresh` minutes), otherwise to a `step`-minute grid.
 */
export function snapMin(min: number, candidates: number[], step = 15, thresh = 22): number {
  let best: number | null = null, bd = thresh;
  for (const c of candidates) {
    const d = Math.abs(c - min);
    if (d <= bd) { bd = d; best = c; }
  }
  return best != null ? best : Math.round(min / step) * step;
}

/**
 * Board range for a day: the standard 6:00–22:00 window, stretched to whole
 * hours when existing shifts fall outside it (e.g. a front-desk close at
 * 11p) so nothing renders cut off or gets mangled by drag-clamping.
 */
export function boardRange(shifts: { startMin: number; endMin: number }[]): { start: number; end: number } {
  let start = BOARD_START_MIN, end = BOARD_END_MIN;
  for (const s of shifts) {
    if (s.startMin < start) start = Math.floor(s.startMin / 60) * 60;
    if (s.endMin > end) end = Math.ceil(s.endMin / 60) * 60;
  }
  return { start: Math.max(0, start), end: Math.min(24 * 60, end) };
}

/** Hour ticks for the axis: every 3h inside the range. */
export function boardTicks(startMin: number, endMin: number): number[] {
  const out: number[] = [];
  for (let m = Math.ceil(startMin / 180) * 180; m <= endMin; m += 180) out.push(m);
  return out;
}

// ─── Board shift model ──────────────────────────────────────────────────────

/** One editable block on the day board / one chip in the week roster. */
export interface BoardShift {
  id: string;                 // server row id, or a local temp id pre-save
  staffId: string;
  dept: StaffDepartment;
  startMin: number;
  endMin: number;
  /** Entrance-animation flags (client-only). */
  anim?: boolean;
  nonce?: number;
}

/** Equality on what the server persists — id/anim flags ignored. */
export function sameShiftSet(a: BoardShift[], b: BoardShift[]): boolean {
  if (a.length !== b.length) return false;
  const key = (s: BoardShift) => `${s.staffId}:${s.dept}:${s.startMin}:${s.endMin}`;
  const as = a.map(key).sort(), bs = b.map(key).sort();
  return as.every((k, i) => k === bs[i]);
}

/** 'Brenda Marquez' → 'Brenda M.' */
export function shortName(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length <= 1) return p[0] ?? '—';
  return `${p[0]} ${p[p.length - 1][0]}.`;
}
