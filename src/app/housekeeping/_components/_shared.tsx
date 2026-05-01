// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers for housekeeping tabs.
//
// Lifted out of the per-tab files on 2026-04-27 to kill the duplication
// from the initial monolith split. Anything used by 2+ tabs lives here.
// Tab-local helpers (e.g. PerformanceTab's ViewMode) stay in their tab files.
//
// Naming: this file IS .tsx because it exports React components
// (HKInitials, PaceBadge, RankBadge, StatPill, FrequencySlider,
// PublicAreasModal). Helpers + types + components are tightly coupled
// at this scale — one file is simpler than splitting across .ts / .tsx.
// ═══════════════════════════════════════════════════════════════════════════

'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { Modal } from '@/components/ui/Modal';
import { DraftNumberInput } from '@/components/DraftNumberInput';
import { useSyncContext } from '@/contexts/SyncContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import {
  subscribeToRooms, subscribeToAllRooms, updateRoom, addRoom,
  addStaffMember, updateStaffMember, deleteStaffMember,
  getRoomsForDate, getPublicAreas, setPublicArea, deletePublicArea,
  updateProperty,
  getDeepCleanConfig, setDeepCleanConfig, getDeepCleanRecords,
  markRoomDeepCleaned, assignRoomDeepClean, completeRoomDeepClean,
  subscribeToPlanSnapshot,
  subscribeToShiftConfirmations,
  subscribeToScheduleAssignments,
  saveScheduleAssignments,
  subscribeToDashboardNumbers,
  getDashboardForDate,
  subscribeToWorkOrders,
} from '@/lib/db';
import type { PlanSnapshot, ScheduleAssignments, CsvRoomSnapshot, DashboardNumbers } from '@/lib/db';
import { dashboardFreshness, DASHBOARD_STALE_MINUTES } from '@/lib/db';
import { getPublicAreasDueToday, calcPublicAreaMinutes, autoAssignRooms, getOverdueRooms, calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { getDefaultPublicAreas } from '@/lib/defaults';
import type { PublicArea } from '@/types';
import { todayStr, errToString } from '@/lib/utils';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, RoomStatus, RoomType, RoomPriority, StaffMember, DeepCleanRecord, DeepCleanConfig, ShiftConfirmation, ConfirmationStatus, WorkOrder } from '@/types';
import { format, subDays } from 'date-fns';
import {
  Calendar, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CheckCircle2, Clock,
  AlertTriangle, Users, Send, Zap, BedDouble, Plus, Pencil, Trash2, Star, Check,
  Trophy, TrendingUp, TrendingDown, Minus, Upload, Settings,
  Search, XCircle, Home, ArrowRightLeft, Sparkles, Ban, RefreshCw,
  Link2, Copy,
} from 'lucide-react';

// ─── Tab config ──────────────────────────────────────────────────────────────

export type TabKey = 'rooms' | 'schedule' | 'deepclean' | 'performance';

export const TABS: { key: TabKey; label: string; labelEs: string }[] = [
  { key: 'rooms',       label: 'Rooms',        labelEs: 'Habitaciones'   },
  { key: 'schedule',    label: 'Schedule',     labelEs: 'Horario'        },
  { key: 'deepclean',   label: 'Deep Clean',   labelEs: 'Limpieza Prof.' },
  { key: 'performance', label: 'Performance',  labelEs: 'Rendimiento'    },
];

// ─── Schedule helpers ─────────────────────────────────────────────────────────

export function schedTodayStr(): string {
  return new Date().toLocaleDateString('en-CA');
}

export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.toLocaleDateString('en-CA');
}

// Always default to today. Maria uses the arrow keys to flip to tomorrow
// when she's planning the next day's crew — auto-jumping at 1pm was
// confusing because she'd open the page expecting today's numbers and get
// tomorrow instead. Manual navigation beats clever defaults here.
export function defaultShiftDate(): string {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * Short, human-friendly stamp for a CSV pull time.
 * "Today 6:02 AM" if the pull happened today, otherwise "Fri 7:02 PM".
 * Keeps Maria oriented at a glance — she always knows how fresh the room list is.
 */
export function formatPulledAt(iso: string | null, lang: 'en' | 'es'): string {
  if (!iso) return '';
  const d = new Date(iso);
  const todayLocal = new Intl.DateTimeFormat('en-CA').format(new Date());
  const thenLocal = new Intl.DateTimeFormat('en-CA').format(d);
  const time = d.toLocaleTimeString(lang === 'es' ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' });
  if (thenLocal === todayLocal) {
    return `${lang === 'es' ? 'Hoy' : 'Today'} ${time}`;
  }
  const weekday = d.toLocaleDateString(lang === 'es' ? 'es' : 'en', { weekday: 'short' });
  return `${weekday} ${time}`;
}

export function formatDisplayDate(dateStr: string, lang: 'en' | 'es'): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

export function isEligible(s: StaffMember, date: string): boolean {
  if (s.isActive === false) return false;
  // Schedule tab is housekeeping-only — don't surface front-desk,
  // maintenance, or managers in Add Staff / Auto Assign. Staff page
  // treats undefined as 'housekeeping', so we mirror that here.
  const dept = s.department ?? 'housekeeping';
  if (dept !== 'housekeeping') return false;
  if (s.schedulePriority === 'excluded') return false;
  if (s.vacationDates?.includes(date)) return false;
  const maxHrs = s.maxWeeklyHours ?? 40;
  if ((s.weeklyHours ?? 0) >= maxHrs) return false;
  return true;
}

export const PRIORITY_ORDER = { priority: 0, normal: 1, excluded: 2 } as const;

/**
 * Derive synthetic Room[] from a planSnapshot (CSV data).
 * This is the ONLY source the Schedule tab reads from — no rooms-collection dependency.
 *   - C/O stayType → checkout
 *   - OCC + Stay stayType → stayover
 *   - everything else → skipped (arrivals, vacants, OOO don't need HK assignment)
 */
export function snapshotToShiftRooms(snap: PlanSnapshot | null, pid: string): Room[] {
  if (!snap?.rooms) return [];
  const out: Room[] = [];
  for (const r of snap.rooms) {
    let type: RoomType | null = null;
    if (r.stayType === 'C/O') type = 'checkout';
    else if (r.stayType === 'Stay') type = 'stayover';
    if (!type) continue;
    out.push({
      id: `${snap.date}_${r.number}`,
      number: r.number,
      type,
      priority: 'standard' as RoomPriority,
      status: 'dirty' as RoomStatus,
      date: snap.date,
      propertyId: pid,
      assignedTo: r.housekeeper ?? undefined,
      // Carry the stayover cycle day through so the UI can label S1 vs S2
      // (light vs full clean) on both the unassigned pool and crew tiles.
      stayoverDay: typeof r.stayoverDay === 'number' ? r.stayoverDay : undefined,
    });
  }
  return out;
}

export function autoSelectEligible(staff: StaffMember[], date: string, alreadyInPool: Set<string>): StaffMember[] {
  return staff
    .filter(s => isEligible(s, date) && !alreadyInPool.has(s.id))
    .sort((a, b) => {
      // Priority staff first, then normal
      const aPri = PRIORITY_ORDER[a.schedulePriority ?? 'normal'];
      const bPri = PRIORITY_ORDER[b.schedulePriority ?? 'normal'];
      if (aPri !== bPri) return aPri - bPri;
      // Fewer hours worked this week = prefer (stay under 40h)
      const aHrs = a.weeklyHours ?? 0;
      const bHrs = b.weeklyHours ?? 0;
      if (aHrs !== bHrs) return aHrs - bHrs;
      const aDays = a.daysWorkedThisWeek ?? 0;
      const bDays = b.daysWorkedThisWeek ?? 0;
      if (aDays !== bDays) return aDays - bDays;
      if (a.isSenior !== b.isSenior) return a.isSenior ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}


// ─── Staff colors for assignment mode ──────────────────────────────────────

export const STAFF_COLORS = [
  '#2563EB', '#DC2626', '#16A34A', '#9333EA', '#EA580C', '#0891B2', '#CA8A04', '#DB2777', '#4F46E5', '#059669'
];

// ─── Performance helpers ──────────────────────────────────────────────────────

export function toDate(ts: unknown): Date | null {
  if (!ts) return null;
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate();
  }
  const d = new Date(ts as string | number | Date);
  return isNaN(d.getTime()) ? null : d;
}

export function fmtMins(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function HKInitials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/);
  const ini = parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
  return (
    <div style={{
      width: '40px', height: '40px', borderRadius: '11px', flexShrink: 0,
      background: 'var(--amber-dim)', border: '1px solid var(--amber-border)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '13px',
      color: 'var(--amber)', letterSpacing: '0.02em',
    }}>
      {ini}
    </div>
  );
}

export interface HKLive {
  staffId: string; name: string; totalAssigned: number; done: number;
  checkoutsDone: number; stayoversDone: number;
  checkoutsAssigned: number; stayoversAssigned: number;
  avgCleanMins: number | null; roomsPerHr: number | null;
  shiftStart: Date | null; shiftEnd: Date | null;
  pace: 'ahead' | 'on_pace' | 'behind' | 'not_started';
}

export function buildLive(rooms: Room[], coMins: number, soMins: number, nowMs: number): HKLive[] {
  const byStaff = new Map<string, { name: string; rooms: Room[] }>();
  for (const r of rooms) {
    if (!r.assignedTo) continue;
    if (!byStaff.has(r.assignedTo)) {
      byStaff.set(r.assignedTo, { name: r.assignedName ?? r.assignedTo, rooms: [] });
    }
    byStaff.get(r.assignedTo)!.rooms.push(r);
  }
  const results: HKLive[] = [];
  for (const [staffId, { name, rooms: hkRooms }] of byStaff) {
    const done = hkRooms.filter(r => r.status === 'clean' || r.status === 'inspected');
    const checkoutsDone = done.filter(r => r.type === 'checkout').length;
    const stayoversDone = done.filter(r => r.type === 'stayover').length;
    const checkoutsAssigned = hkRooms.filter(r => r.type === 'checkout').length;
    const stayoversAssigned = hkRooms.filter(r => r.type === 'stayover').length;
    const timed = done.map(r => {
      const s = toDate(r.startedAt); const e = toDate(r.completedAt);
      if (!s || !e) return null;
      return (e.getTime() - s.getTime()) / 60_000;
    }).filter((m): m is number => m !== null && m > 0);
    const avgCleanMins = timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
    const starts = hkRooms.map(r => toDate(r.startedAt)).filter((d): d is Date => d !== null);
    const ends = done.map(r => toDate(r.completedAt)).filter((d): d is Date => d !== null);
    const shiftStart = starts.length > 0 ? new Date(Math.min(...starts.map(d => d.getTime()))) : null;
    const shiftEnd = ends.length > 0 ? new Date(Math.max(...ends.map(d => d.getTime()))) : null;
    let roomsPerHr: number | null = null;
    if (shiftStart && done.length > 0) {
      const hrs = (nowMs - shiftStart.getTime()) / 3_600_000;
      if (hrs > 0) roomsPerHr = Math.round((done.length / hrs) * 10) / 10;
    }
    let pace: HKLive['pace'] = 'not_started';
    if (shiftStart && hkRooms.length > 0) {
      const totalAssignedMins = checkoutsAssigned * coMins + stayoversAssigned * soMins;
      if (totalAssignedMins > 0) {
        const elapsedMins = (nowMs - shiftStart.getTime()) / 60_000;
        const expectedDone = (elapsedMins / totalAssignedMins) * hkRooms.length;
        if (done.length >= expectedDone + 1.5) pace = 'ahead';
        else if (done.length < expectedDone - 1.5) pace = 'behind';
        else pace = 'on_pace';
      }
    }
    results.push({ staffId, name, totalAssigned: hkRooms.length, done: done.length, checkoutsDone, stayoversDone, checkoutsAssigned, stayoversAssigned, avgCleanMins, roomsPerHr, shiftStart, shiftEnd, pace });
  }
  return results.sort((a, b) => b.done - a.done);
}

export interface HKHistory {
  staffId: string; name: string; totalDone: number; checkoutsDone: number;
  stayoversDone: number; avgCleanMins: number | null; daysActive: number; avgPerDay: number;
}

export function buildHistory(roomsByDate: Room[][]): HKHistory[] {
  const byStaff = new Map<string, { name: string; done: number; checkouts: number; stayovers: number; timed: number[]; days: Set<string> }>();
  for (const dayRooms of roomsByDate) {
    for (const r of dayRooms) {
      if (!r.assignedTo) continue;
      if (r.status !== 'clean' && r.status !== 'inspected') continue;
      if (!byStaff.has(r.assignedTo)) byStaff.set(r.assignedTo, { name: r.assignedName ?? r.assignedTo, done: 0, checkouts: 0, stayovers: 0, timed: [], days: new Set() });
      const entry = byStaff.get(r.assignedTo)!;
      entry.done += 1; entry.days.add(r.date);
      if (r.type === 'checkout') entry.checkouts += 1;
      if (r.type === 'stayover') entry.stayovers += 1;
      const s = toDate(r.startedAt); const e = toDate(r.completedAt);
      if (s && e) { const mins = (e.getTime() - s.getTime()) / 60_000; if (mins > 0) entry.timed.push(mins); }
    }
  }
  const results: HKHistory[] = [];
  for (const [staffId, entry] of byStaff) {
    const avgCleanMins = entry.timed.length > 0 ? Math.round(entry.timed.reduce((a, b) => a + b, 0) / entry.timed.length) : null;
    const daysActive = entry.days.size;
    const avgPerDay = daysActive > 0 ? Math.round((entry.done / daysActive) * 10) / 10 : 0;
    results.push({ staffId, name: entry.name, totalDone: entry.done, checkoutsDone: entry.checkouts, stayoversDone: entry.stayovers, avgCleanMins, daysActive, avgPerDay });
  }
  return results.sort((a, b) => b.totalDone - a.totalDone);
}

export function PaceBadge({ pace, lang }: { pace: HKLive['pace']; lang: 'en' | 'es' }) {
  if (pace === 'not_started') return null;
  const config = {
    ahead:    { bg: 'var(--green-dim)',  border: 'var(--green-border, rgba(34,197,94,0.35))',  color: 'var(--green)', icon: <TrendingUp size={11} />,   label: t('ahead', lang) },
    on_pace:  { bg: 'var(--amber-dim)', border: 'var(--amber-border)', color: 'var(--amber)', icon: <Minus size={11} />,        label: t('onPace', lang) },
    behind:   { bg: 'var(--red-dim)',  border: 'var(--red-border, rgba(239,68,68,0.35))',  color: 'var(--red)', icon: <TrendingDown size={11} />, label: t('behindPace', lang) },
  }[pace];
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', borderRadius: '100px', background: config.bg, border: `1px solid ${config.border}`, color: config.color, fontSize: '11px', fontWeight: 700 }}>
      {config.icon}{config.label}
    </div>
  );
}

export function RankBadge({ rank }: { rank: number }) {
  const s = ({ 1: { bg: 'rgba(251,191,36,0.18)', color: 'var(--amber)' }, 2: { bg: 'rgba(156,163,175,0.18)', color: 'var(--text-muted)' }, 3: { bg: 'rgba(180,120,60,0.18)', color: 'var(--bronze, #B4783C)' } } as Record<number, { bg: string; color: string }>)[rank] ?? { bg: 'rgba(0,0,0,0.05)', color: 'var(--text-muted)' };
  return (
    <div style={{ width: '26px', height: '26px', borderRadius: '8px', background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '12px', color: s.color, flexShrink: 0 }}>
      {rank === 1 ? '🏆' : `#${rank}`}
    </div>
  );
}

export function StatPill({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '100px', background: highlight ? 'var(--amber-dim)' : 'rgba(0,0,0,0.04)', border: `1px solid ${highlight ? 'var(--amber-border)' : 'var(--border)'}` }}>
      <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, color: highlight ? 'var(--amber)' : 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

// ─── Staff helpers ────────────────────────────────────────────────────────────

export interface StaffFormData {
  name: string; phone?: string; language: 'en' | 'es'; isSenior: boolean;
  hourlyWage?: number; maxWeeklyHours: number; maxDaysPerWeek: number;
  vacationDates: string; isActive: boolean;
}

export const EMPTY_FORM: StaffFormData = { name: '', language: 'en', isSenior: false, maxWeeklyHours: 40, maxDaysPerWeek: 5, vacationDates: '', isActive: true };

export function staffInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEDULE SECTION
// ══════════════════════════════════════════════════════════════════════════════


export function getFloor(roomNumber: string): string {
  const cleaned = roomNumber.replace(/\D/g, '');
  const num = parseInt(cleaned);
  if (isNaN(num)) return '?';
  if (num < 100) return 'G';
  return String(Math.floor(num / 100));
}

export const ROOM_ACTION_COLOR: Record<RoomStatus, { bg: string; border: string; color: string }> = {
  dirty:       { bg: 'rgba(251,191,36,0.15)',  border: 'rgba(251,191,36,0.5)',  color: 'var(--amber)' },
  in_progress: { bg: 'rgba(34,197,94,0.15)',   border: 'rgba(34,197,94,0.5)',   color: 'var(--green)' },
  clean:       { bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.35)',  color: 'var(--red)' },
  inspected:   { bg: 'rgba(139,92,246,0.10)',  border: 'rgba(139,92,246,0.3)',  color: 'var(--purple, #7C3AED)' },
};



// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC AREAS SECTION
// ══════════════════════════════════════════════════════════════════════════════

export function paFloorLabel(value: string, lang: 'en' | 'es'): string {
  if (value === 'other') return lang === 'es' ? 'Otro' : 'Other';
  return `${t('floor', lang)} ${value}`;
}

export const PA_FLOOR_VALUES = ['1', '2', '3', '4', 'other'] as const;

export const SLIDER_MAX = 7;

export function freqLabel(days: number, lang: 'en' | 'es' = 'en'): string {
  if (days === 1) return t('daily', lang);
  if (days === 7) return t('weekly', lang);
  return `${t('every', lang)} ${days} ${t('days', lang)}`;
}

export function FrequencySlider({ value, onChange, lang }: { value: number; onChange: (v: number) => void; lang?: 'en' | 'es' }) {
  const isCustom = value > SLIDER_MAX;
  const sliderVal = isCustom ? SLIDER_MAX + 1 : value;
  const pct = ((sliderVal - 1) / SLIDER_MAX) * 100;
  const currentLang = lang ?? 'en';

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (v <= SLIDER_MAX) onChange(v);
    else onChange(SLIDER_MAX + 1); // trigger custom mode with value just above max
  };

  const getFreqLabel = (days: number): string => {
    if (days === 1) return t('daily', currentLang);
    if (days === 7) return t('weekly', currentLang);
    const everyWord = currentLang === 'es' ? 'Cada' : 'Every';
    const daysWord = currentLang === 'es' ? 'días' : 'days';
    return `${everyWord} ${days} ${daysWord}`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label className="label" style={{ margin: 0 }}>{t('frequency', currentLang)}</label>
        <span style={{ fontSize: '13px', fontWeight: 700, color: isCustom ? 'var(--amber)' : 'var(--navy)' }}>
          {isCustom ? t('custom', currentLang) : getFreqLabel(value)}
        </span>
      </div>
      <div style={{ position: 'relative', height: '28px', display: 'flex', alignItems: 'center' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, height: '6px', borderRadius: '3px', background: 'rgba(0,0,0,0.06)' }} />
        <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: '6px', borderRadius: '3px', background: isCustom ? 'var(--amber)' : 'var(--navy)', transition: 'width 0.15s, background 0.15s' }} />
        <input
          type="range" min={1} max={SLIDER_MAX + 1} step={1} value={sliderVal}
          onChange={handleSlider}
          style={{ position: 'absolute', left: 0, right: 0, width: '100%', height: '28px', margin: 0, opacity: 0, cursor: 'pointer', zIndex: 2 }}
        />
        <div style={{
          position: 'absolute', left: `${pct}%`, transform: 'translateX(-50%)',
          width: '22px', height: '22px', borderRadius: '11px',
          background: isCustom ? 'var(--amber)' : 'var(--navy)', border: '3px solid white',
          boxShadow: '0 2px 6px rgba(0,0,0,0.2)', transition: 'left 0.15s, background 0.15s',
          pointerEvents: 'none',
        }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 2px' }}>
        {Array.from({ length: SLIDER_MAX + 1 }, (_, i) => i + 1).map(n => (
          <span key={n} style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 500, width: '24px', textAlign: 'center' }}>
            {n <= SLIDER_MAX ? n : '✎'}
          </span>
        ))}
      </div>
      {isCustom && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', animation: 'toastIn 0.2s ease-out' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{t('every', currentLang)}</span>
          <input className="input" type="number" min={1} value={value > SLIDER_MAX ? value : ''} autoFocus
            onChange={e => { const v = Number(e.target.value); if (v >= 1) onChange(v); }}
            style={{ width: '70px', textAlign: 'center' }}
          />
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{t('days', currentLang)}</span>
        </div>
      )}
    </div>
  );
}


// ─── Spanish translations for public area names ──────────────────────────────
export const AREA_NAME_ES: Record<string, string> = {
  'Elevator Area - 1st Floor': 'Área del Elevador - Piso 1',
  '1st Floor Hallway': 'Pasillo del Piso 1',
  'Front Entrance + Breakfast Area + Pantry + Lobby': 'Entrada + Área de Desayuno + Despensa + Vestíbulo',
  'Front Desk + Behind Front Desk': 'Recepción + Detrás de Recepción',
  'Restrooms': 'Baños',
  'Pool area + Pool bathroom': 'Área de Piscina + Baño de Piscina',
  'Meeting Room': 'Sala de Reuniones',
  'Business Center': 'Centro de Negocios',
  'Fitness Center': 'Gimnasio',
  'Laundry + Linen Room': 'Lavandería + Cuarto de Ropa',
  'Laundry Break Room': 'Sala de Descanso de Lavandería',
  '2nd Floor Hallway + Side Hallway': 'Pasillo del Piso 2 + Pasillo Lateral',
  '3rd Floor Hallway + Side Hallway': 'Pasillo del Piso 3 + Pasillo Lateral',
  '4th Floor Hallway + Side Hallway': 'Pasillo del Piso 4 + Pasillo Lateral',
  'Guest Laundry Room': 'Lavandería de Huéspedes',
  'Soda Ice Room': 'Cuarto de Hielo y Refrescos',
  'Housekeeping Room': 'Cuarto de Limpieza',
  'Stairs': 'Escaleras',
  'Parking Lot Garbage': 'Basura del Estacionamiento',
  'Front + Side Glass (Outside)': 'Vidrios Frontales + Laterales (Exterior)',
};

export function areaDisplayName(name: string, lang: 'en' | 'es'): string {
  if (lang === 'es' && AREA_NAME_ES[name]) return AREA_NAME_ES[name];
  return name;
}

export function PublicAreasModal({ show, onClose }: { show: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();

  const [areas, setAreas] = useState<PublicArea[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newArea, setNewArea] = useState({ name: '', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 15 });
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  useEffect(() => {
    if (!uid || !pid) return;
    setLoading(true);
    const OLD_NAMES = ['stairwell', 'staff / service', 'floor 2 hallway', 'floor 3 hallway', 'floor 4 hallway', 'restrooms (3', 'elevator area (1st', '2nd, 3rd, & 4th floor hallways'];
    const needsReseed = (areas: PublicArea[]) => areas.some(a => OLD_NAMES.some(old => a.name.toLowerCase().includes(old)));

    const seedDefaults = async () => {
      const defaults = getDefaultPublicAreas();
      const seeded: PublicArea[] = [];
      for (const area of defaults) {
        const id = crypto.randomUUID();
        const full = { id, ...area } as PublicArea;
        await setPublicArea(uid, pid, full);
        seeded.push(full);
      }
      return seeded;
    };

    getPublicAreas(uid, pid).then(async (fetched) => {
      if (fetched.length === 0) {
        setAreas(await seedDefaults());
      } else if (needsReseed(fetched)) {
        // Parallel — see /housekeeping page header for the same pattern.
        await Promise.all(fetched.map(a => deletePublicArea(uid, pid, a.id)));
        setAreas(await seedDefaults());
      } else {
        setAreas(fetched);
      }
      setLoading(false);
    });
  }, [uid, pid]);

  const handleUpdate = (id: string, patch: Partial<PublicArea>) => {
    setAreas(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a));
    setDirty(true);
  };

  const handleDelete = async (id: string) => {
    const deleted = areas.find(a => a.id === id);
    setAreas(prev => prev.filter(a => a.id !== id));
    try {
      if (uid && pid) await deletePublicArea(uid, pid, id);
    } catch (err) {
      console.error('Error deleting public area:', err);
    }
    setDirty(true);
    setExpandedId(null);
    const label = deleted ? areaDisplayName(deleted.name, lang) : 'Area';
    setToast(`"${label}" ${t('deleted', lang)}`);
    setTimeout(() => setToast(null), 2500);
  };

  const openAddModal = () => {
    setNewArea({ name: '', floor: '1', locations: 1, frequencyDays: 1, minutesPerClean: 15 });
    setShowAddModal(true);
  };

  const confirmAdd = () => {
    if (!newArea.name.trim()) return;
    const id = crypto.randomUUID();
    const today = new Date().toLocaleDateString('en-CA');
    const full: PublicArea = { id, name: newArea.name.trim(), floor: newArea.floor, locations: newArea.locations, frequencyDays: newArea.frequencyDays, minutesPerClean: newArea.minutesPerClean, startDate: today };
    setAreas(prev => [...prev, full]);
    setDirty(true);
    setShowAddModal(false);
    setHighlightId(id);
    setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    setTimeout(() => setHighlightId(null), 2000);
  };

  const handleSave = async () => {
    if (!uid || !pid) return;
    setSaving(true);
    try {
      await Promise.all(areas.map(a => setPublicArea(uid, pid, a)));
      setSaved(true);
      setDirty(false);
      setTimeout(() => setSaved(false), 2500);
    } finally { setSaving(false); }
  };

  // Group areas by floor in display order
  const floorOrder = ['1', '2', '3', '4', 'other'];
  const grouped = floorOrder
    .map(f => ({ floor: f, label: paFloorLabel(f, lang), areas: areas.filter(a => a.floor === f) }))
    .filter(g => g.areas.length > 0);

  if (!show) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-card)', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '85vw', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p style={{ fontWeight: 700, fontSize: '17px', color: 'var(--text-primary)', margin: 0 }}>{lang === 'es' ? 'Áreas Comunes' : 'Public Areas'}</p>
          <button onClick={onClose} aria-label={lang === 'es' ? 'Cerrar' : 'Close'} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '18px', padding: '4px' }}>✕</button>
        </div>

      {/* Add button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={openAddModal} style={{
          display: 'flex', alignItems: 'center', gap: '5px',
          padding: '6px 12px', borderRadius: 'var(--radius-full)',
          background: 'var(--navy)', border: 'none',
          color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
        }}>
          <Plus size={12} /> {t('add', lang)}
        </button>
      </div>

      {/* Area list grouped by floor */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <div className="animate-spin" style={{ width: '28px', height: '28px', border: '3px solid var(--border)', borderTopColor: 'var(--amber)', borderRadius: '50%', margin: '0 auto 12px' }} />
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', margin: 0 }}>{t('loading', lang)}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {grouped.map(group => (
            <div key={group.floor}>
              {/* Floor header — centered */}
              <div style={{ textAlign: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '16px', fontWeight: 800, color: 'var(--navy)', letterSpacing: '-0.01em' }}>{group.label}</span>
              </div>
              {/* Area cards — 3 column grid */}
              <div className="pa-grid" style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px',
              }}>
                {group.areas.map((area) => {
                  const isHighlighted = highlightId === area.id;
                  const fLabel = freqLabel(area.frequencyDays, lang);
                  return (
                    <div
                      key={area.id}
                      ref={isHighlighted ? highlightRef : undefined}
                      onClick={() => setExpandedId(area.id)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        gap: '6px',
                        padding: '20px 14px',
                        background: 'var(--bg-card)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-lg)',
                        cursor: 'pointer',
                        boxShadow: isHighlighted
                          ? '0 0 0 2px var(--amber), 0 4px 16px rgba(251,191,36,0.25)'
                          : '0 1px 4px rgba(0,0,0,0.06)',
                        transition: 'all 0.15s',
                        textAlign: 'center',
                      }}
                    >
                      {/* Name */}
                      <p style={{
                        fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)',
                        margin: 0, lineHeight: 1.3,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                        overflow: 'hidden',
                      }}>{areaDisplayName(area.name, lang) || (lang === 'es' ? 'Sin Título' : 'Untitled')}</p>
                      {/* Time + Frequency on one line */}
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>
                        {area.minutesPerClean}{t('minutes', lang)} · {fLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {areas.length === 0 && (
            <div style={{
              padding: '40px', textAlign: 'center',
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)', fontSize: '13px',
            }}>{t('noAreasFloor', lang)}</div>
          )}
        </div>
      )}

      {/* Save */}
      <button onClick={handleSave} disabled={saving || saved || !dirty} className={`btn btn-xl ${saved ? 'btn-green' : 'btn-primary'}`} style={{ width: '100%', justifyContent: 'center', opacity: (!dirty && !saved) ? 0.5 : 1 }}>
        {saved ? <><Check size={20} /> {t('saved', lang)}</> : saving ? t('saving', lang) : t('saveChanges', lang)}
      </button>

      {/* Add Area Modal */}
      {showAddModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setShowAddModal(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-card)', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '400px', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <p style={{ fontWeight: 700, fontSize: '17px', color: 'var(--text-primary)' }}>{t('addPublicArea', lang)}</p>

            <div>
              <label className="label">{t('name', lang)}</label>
              <input className="input" placeholder={t('areaNamePlaceholder', lang)} autoFocus value={newArea.name} onChange={e => setNewArea(p => ({ ...p, name: e.target.value }))} />
            </div>

            <div>
              <label className="label">{t('floor', lang)}</label>
              <select className="input" value={newArea.floor} onChange={e => setNewArea(p => ({ ...p, floor: e.target.value }))} style={{ width: '100%' }}>
                {PA_FLOOR_VALUES.map(v => <option key={v} value={v}>{paFloorLabel(v, lang)}</option>)}
              </select>
            </div>

            <FrequencySlider value={newArea.frequencyDays} onChange={v => setNewArea(p => ({ ...p, frequencyDays: v }))} lang={lang} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label className="label">{t('minutesPerClean', lang)}</label>
                <DraftNumberInput value={newArea.minutesPerClean} onCommit={n => setNewArea(p => ({ ...p, minutesPerClean: n }))} min={0} width="100%" />
              </div>
              <div>
                <label className="label">{t('locations', lang)}</label>
                <DraftNumberInput value={newArea.locations} onCommit={n => setNewArea(p => ({ ...p, locations: n }))} min={1} width="100%" />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button onClick={() => setShowAddModal(false)} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>
                {t('cancel', lang)}
              </button>
              <button onClick={confirmAdd} disabled={!newArea.name.trim()} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: 'var(--navy)', color: '#fff', fontWeight: 600, fontSize: '14px', cursor: 'pointer', opacity: newArea.name.trim() ? 1 : 0.5 }}>
                {t('addAreaBtn', lang)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Area Modal */}
      {expandedId && (() => {
        const area = areas.find(a => a.id === expandedId);
        if (!area) return null;
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setExpandedId(null)}>
            <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-card)', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '400px', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <p style={{ fontWeight: 700, fontSize: '17px', color: 'var(--text-primary)' }}>{areaDisplayName(area.name, lang) || (lang === 'es' ? 'Sin Título' : 'Untitled')}</p>

              <div>
                <label className="label">{t('name', lang)}</label>
                <input className="input" value={area.name} onChange={e => handleUpdate(area.id, { name: e.target.value })} />
              </div>

              <div>
                <label className="label">{t('floor', lang)}</label>
                <select className="input" value={area.floor} onChange={e => handleUpdate(area.id, { floor: e.target.value })} style={{ width: '100%' }}>
                  {PA_FLOOR_VALUES.map(v => <option key={v} value={v}>{paFloorLabel(v, lang)}</option>)}
                </select>
              </div>

              <FrequencySlider value={area.frequencyDays} onChange={v => handleUpdate(area.id, { frequencyDays: v })} lang={lang} />

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div>
                  <label className="label">{t('minutesPerClean', lang)}</label>
                  <DraftNumberInput value={area.minutesPerClean} onCommit={n => handleUpdate(area.id, { minutesPerClean: n })} min={0} width="100%" />
                </div>
                <div>
                  <label className="label">{t('locations', lang)}</label>
                  <DraftNumberInput value={area.locations} onCommit={n => handleUpdate(area.id, { locations: n })} min={1} width="100%" />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <button onClick={() => { handleDelete(area.id); setExpandedId(null); }} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid rgba(220,38,38,0.2)', background: 'rgba(220,38,38,0.06)', color: 'var(--red)', fontWeight: 600, fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <Trash2 size={14} /> {t('removeArea', lang)}
                </button>
                <button onClick={() => setExpandedId(null)} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: 'var(--navy)', color: '#fff', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>
                  {t('done', lang)}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--navy)', color: '#fff', padding: '10px 20px',
          borderRadius: '10px', fontSize: '13px', fontWeight: 600,
          boxShadow: '0 4px 20px rgba(0,0,0,0.18)', zIndex: 9999,
          animation: 'toastIn 0.25s ease-out',
        }}>
          {toast}
        </div>
      )}
      <style>{`@keyframes toastIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }`}</style>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// DEEP CLEAN SECTION (replaces Inspect)
// ══════════════════════════════════════════════════════════════════════════════

