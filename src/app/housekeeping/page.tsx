'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { t } from '@/lib/translations';
import { AppLayout } from '@/components/layout/AppLayout';
import { Modal } from '@/components/ui/Modal';
import { useSyncContext } from '@/contexts/SyncContext';
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
} from '@/lib/firestore';
import type { PlanSnapshot, ScheduleAssignments, CsvRoomSnapshot, DashboardNumbers } from '@/lib/firestore';
import { dashboardFreshness, DASHBOARD_STALE_MINUTES } from '@/lib/firestore';
import { getPublicAreasDueToday, calcPublicAreaMinutes, autoAssignRooms, getOverdueRooms, calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { getDefaultPublicAreas } from '@/lib/defaults';
import type { PublicArea } from '@/types';
import { todayStr } from '@/lib/utils';
import type { Room, RoomStatus, RoomType, RoomPriority, StaffMember, DeepCleanRecord, DeepCleanConfig, ShiftConfirmation, ConfirmationStatus } from '@/types';
import { format, subDays } from 'date-fns';
import {
  Calendar, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CheckCircle2, Clock,
  AlertTriangle, Users, Send, Zap, BedDouble, Plus, Pencil, Trash2, Star, Check,
  Trophy, TrendingUp, TrendingDown, Minus, Upload, Settings,
  Search, XCircle, Home, ArrowRightLeft, Sparkles, Ban, RefreshCw,
  Link2, Copy,
} from 'lucide-react';

// ─── Tab config ──────────────────────────────────────────────────────────────

type TabKey = 'rooms' | 'schedule' | 'deepclean' | 'performance';

const TABS: { key: TabKey; label: string; labelEs: string }[] = [
  { key: 'rooms',       label: 'Rooms',        labelEs: 'Habitaciones'   },
  { key: 'schedule',    label: 'Schedule',     labelEs: 'Horario'        },
  { key: 'deepclean',   label: 'Deep Clean',   labelEs: 'Limpieza Prof.' },
  { key: 'performance', label: 'Performance',  labelEs: 'Rendimiento'    },
];

// ─── Schedule helpers ─────────────────────────────────────────────────────────

function schedTodayStr(): string {
  return new Date().toLocaleDateString('en-CA');
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dt.toLocaleDateString('en-CA');
}

// Maria plans the next day's housekeeping in the afternoon / evening, so
// default the Schedule tab to tomorrow once we hit 1pm local. Before 1pm,
// "next shift" still means today — stops the tab from silently flipping to
// tomorrow at midnight when she's still actively working on today's crew.
function defaultShiftDate(): string {
  const now = new Date();
  const today = now.toLocaleDateString('en-CA');
  return now.getHours() >= 13 ? addDays(today, 1) : today;
}

/**
 * Short, human-friendly stamp for a CSV pull time.
 * "Today 6:02 AM" if the pull happened today, otherwise "Fri 7:02 PM".
 * Keeps Maria oriented at a glance — she always knows how fresh the room list is.
 */
function formatPulledAt(iso: string | null, lang: 'en' | 'es'): string {
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

function formatDisplayDate(dateStr: string, lang: 'en' | 'es'): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

function isEligible(s: StaffMember, date: string): boolean {
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

const PRIORITY_ORDER = { priority: 0, normal: 1, excluded: 2 } as const;

/**
 * Derive synthetic Room[] from a planSnapshot (CSV data).
 * This is the ONLY source the Schedule tab reads from — no rooms-collection dependency.
 *   - C/O stayType → checkout
 *   - OCC + Stay stayType → stayover
 *   - everything else → skipped (arrivals, vacants, OOO don't need HK assignment)
 */
function snapshotToShiftRooms(snap: PlanSnapshot | null, pid: string): Room[] {
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

function autoSelectEligible(staff: StaffMember[], date: string, alreadyInPool: Set<string>): StaffMember[] {
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

const STAFF_COLORS = [
  '#2563EB', '#DC2626', '#16A34A', '#9333EA', '#EA580C', '#0891B2', '#CA8A04', '#DB2777', '#4F46E5', '#059669'
];

// ─── Performance helpers ──────────────────────────────────────────────────────

function toDate(ts: unknown): Date | null {
  if (!ts) return null;
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate();
  }
  const d = new Date(ts as string | number | Date);
  return isNaN(d.getTime()) ? null : d;
}

function fmtMins(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function HKInitials({ name }: { name: string }) {
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

interface HKLive {
  staffId: string; name: string; totalAssigned: number; done: number;
  checkoutsDone: number; stayoversDone: number;
  checkoutsAssigned: number; stayoversAssigned: number;
  avgCleanMins: number | null; roomsPerHr: number | null;
  shiftStart: Date | null; shiftEnd: Date | null;
  pace: 'ahead' | 'on_pace' | 'behind' | 'not_started';
}

function buildLive(rooms: Room[], coMins: number, soMins: number, nowMs: number): HKLive[] {
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

interface HKHistory {
  staffId: string; name: string; totalDone: number; checkoutsDone: number;
  stayoversDone: number; avgCleanMins: number | null; daysActive: number; avgPerDay: number;
}

function buildHistory(roomsByDate: Room[][]): HKHistory[] {
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

function PaceBadge({ pace, lang }: { pace: HKLive['pace']; lang: 'en' | 'es' }) {
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

function RankBadge({ rank }: { rank: number }) {
  const s = ({ 1: { bg: 'rgba(251,191,36,0.18)', color: 'var(--amber)' }, 2: { bg: 'rgba(156,163,175,0.18)', color: 'var(--text-muted)' }, 3: { bg: 'rgba(180,120,60,0.18)', color: 'var(--bronze, #B4783C)' } } as Record<number, { bg: string; color: string }>)[rank] ?? { bg: 'rgba(0,0,0,0.05)', color: 'var(--text-muted)' };
  return (
    <div style={{ width: '26px', height: '26px', borderRadius: '8px', background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '12px', color: s.color, flexShrink: 0 }}>
      {rank === 1 ? '🏆' : `#${rank}`}
    </div>
  );
}

function StatPill({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '5px 10px', borderRadius: '100px', background: highlight ? 'var(--amber-dim)' : 'rgba(0,0,0,0.04)', border: `1px solid ${highlight ? 'var(--amber-border)' : 'var(--border)'}` }}>
      <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 700, color: highlight ? 'var(--amber)' : 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

// ─── Staff helpers ────────────────────────────────────────────────────────────

interface StaffFormData {
  name: string; phone?: string; language: 'en' | 'es'; isSenior: boolean;
  hourlyWage?: number; maxWeeklyHours: number; maxDaysPerWeek: number;
  vacationDates: string; isActive: boolean;
}

const EMPTY_FORM: StaffFormData = { name: '', language: 'en', isSenior: false, maxWeeklyHours: 40, maxDaysPerWeek: 5, vacationDates: '', isActive: true };

function staffInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 1).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEDULE SECTION
// ══════════════════════════════════════════════════════════════════════════════

function ScheduleSection() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff, staffLoaded, refreshStaff, refreshProperty } = useProperty();
  const { lang } = useLang();
  const { recordOfflineAction } = useSyncContext();

  const [shiftDate, setShiftDate] = useState(defaultShiftDate);
  const [sending, setSending] = useState(false);
  const [confirmations, setConfirmations] = useState<ShiftConfirmation[]>([]);
  // Per-person outcome from the last Send click: 'sent' | 'skipped' | 'failed'
  // + a reason when it wasn't sent (e.g. 'no_phone'). Powers the badge next
  // to each crew member's name on the Schedule tab.
  type SendResult = { status: 'sent' | 'skipped' | 'failed'; reason?: string };
  const [sendResults, setSendResults] = useState<Map<string, SendResult>>(new Map());
  const [showPredictionSettings, setShowPredictionSettings] = useState(false);
  const [showPublicAreas, setShowPublicAreas] = useState(false);
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [expandedCrew, setExpandedCrew] = useState<string | null>(null);
  const [settingsForm, setSettingsForm] = useState({
    checkoutMinutes: 30,
    stayoverMinutes: 20,
    stayoverDay1Minutes: 15,
    stayoverDay2Minutes: 20,
    prepMinutesPerActivity: 5,
    shiftMinutes: 420,  // per-housekeeper daily cap in minutes (7h default)
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Plan snapshot from CSV scraper (7pm / 6am pulls) — THE source of truth for Schedule tab.
  const [planSnapshot, setPlanSnapshot] = useState<PlanSnapshot | null>(null);
  const [planSnapshotLoaded, setPlanSnapshotLoaded] = useState(false);

  // Live PMS dashboard numbers (In House / Arrivals / Departures) — pulled off
  // Choice Advantage's View pages every 15 min by the Railway scraper.
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);

  // Staleness ticker — re-renders the PMS block once a minute so that a
  // Schedule tab left open on screen starts showing "stale" the moment
  // pulledAt crosses the threshold, even without a Firestore update. Without
  // this, the UI could tell Maria "fresh at 4:01" all evening while the
  // scraper has been dead for 3 hours.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Saved assignments (survives CSV overwrites — Maria's Send work persists).
  const [scheduleAssignmentsDoc, setScheduleAssignmentsDoc] = useState<ScheduleAssignments | null>(null);
  const [scheduleAssignmentsLoaded, setScheduleAssignmentsLoaded] = useState(false);

  const [publicAreas, setPublicAreas] = useState<PublicArea[]>([]);

  // Crew assignments
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [crewOverride, setCrewOverride] = useState<string[]>([]); // manually toggled staff IDs
  const [hasAutoSelected, setHasAutoSelected] = useState(false);
  const [showPrioritySettings, setShowPrioritySettings] = useState(false);

  // Refs used by the hydration flow below (declared early so useEffects can flip them)
  const userEditedCrew = useRef(false);
  const manuallyAdded = useRef<Set<string>>(new Set());
  const hasInitialAssign = useRef(false);

  // Swap dropdown
  const [swapOpenFor, setSwapOpenFor] = useState<string | null>(null);
  const [swapAnchor, setSwapAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // "Copied!" flash feedback for the per-housekeeper link copy button
  const [copiedFor, setCopiedFor] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Move toast notification
  const [moveToast, setMoveToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag-and-drop state (pointer events — works for both mouse + touch)
  const [dragState, setDragState] = useState<{
    roomId: string; roomNumber: string; roomType: string; stayoverDay?: number;
    ghost: { x: number; y: number }; dropTarget: string | null;
  } | null>(null);
  const crewCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragRef = useRef<{
    roomId: string | null; roomNumber: string; roomType: string; stayoverDay?: number;
    startX: number; startY: number; active: boolean;
  }>({ roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false });

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  useEffect(() => {
    if (uid && pid && staff.length === 0) refreshStaff();
  }, [uid, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Schedule tab reads ONLY from the CSV pull (planSnapshots). The 15-min rooms scraper
  // is intentionally ignored here — it powers the Rooms tab's live view during the day.
  useEffect(() => {
    if (!uid || !pid) return;
    setPlanSnapshotLoaded(false);
    return subscribeToPlanSnapshot(uid, pid, shiftDate, (snap) => {
      setPlanSnapshot(snap);
      setPlanSnapshotLoaded(true);
    });
  }, [uid, pid, shiftDate]);

  // Synthetic room list derived from CSV — no rooms-collection dependency.
  const shiftRooms = useMemo(() => snapshotToShiftRooms(planSnapshot, pid), [planSnapshot, pid]);

  // Maria's saved assignments for this date. Untouched by CSV refreshes.
  useEffect(() => {
    if (!uid || !pid) return;
    // Clear the previous date's doc AND loaded flag synchronously before
    // re-subscribing. Otherwise the hydration effect below can fire on the
    // date change while `scheduleAssignmentsDoc` still holds the previous
    // date's data — and lock in stale assignments whose room IDs are keyed
    // to the old date (so everything shows as unassigned).
    setScheduleAssignmentsDoc(null);
    setScheduleAssignmentsLoaded(false);
    return subscribeToScheduleAssignments(uid, pid, shiftDate, (sa) => {
      setScheduleAssignmentsDoc(sa);
      setScheduleAssignmentsLoaded(true);
    });
  }, [uid, pid, shiftDate]);

  // Live dashboard numbers from Choice Advantage View pages. One listener for
  // the whole app — not per-date, not per-property — these are current-moment
  // snapshots maintained by the Railway scraper (see scraper/dashboard-pull.js).
  useEffect(() => {
    return subscribeToDashboardNumbers(setDashboardNums);
  }, []);

  // One-time hydration per date: when assignments + crew load from Firestore, seed local state.
  const hydratedForDate = useRef<string | null>(null);
  useEffect(() => {
    if (!scheduleAssignmentsLoaded) return;
    if (hydratedForDate.current === shiftDate) return;
    // Guard against a stale subscription emission: if the doc we have isn't
    // for the shiftDate we're now viewing, wait for the real doc to arrive.
    // (Happens when the user switches dates faster than Firestore re-emits.)
    if (scheduleAssignmentsDoc && scheduleAssignmentsDoc.date !== shiftDate) return;
    hydratedForDate.current = shiftDate;
    if (scheduleAssignmentsDoc) {
      setAssignments(scheduleAssignmentsDoc.roomAssignments ?? {});
      setCrewOverride(scheduleAssignmentsDoc.crew ?? []);
      userEditedCrew.current = true;     // respect what Maria already saved
      hasInitialAssign.current = true;   // skip the auto-assign-on-first-load
    } else {
      setAssignments({});
      setCrewOverride([]);
      userEditedCrew.current = false;
      hasInitialAssign.current = false;
    }
  }, [shiftDate, scheduleAssignmentsLoaded, scheduleAssignmentsDoc]);

  const predictionLoading = !planSnapshotLoaded;

  // Subscribe to shift confirmations for this date (for the status panel)
  useEffect(() => {
    if (!uid || !pid) return;
    return subscribeToShiftConfirmations(uid, pid, shiftDate, setConfirmations);
  }, [uid, pid, shiftDate]);

  // When the shift date changes, forget the previous Send outcomes — the
  // badges are per-shift and shouldn't leak across dates.
  useEffect(() => {
    setSendResults(new Map());
  }, [shiftDate]);

  // Map of staffId → confirmation status for this shift date
  const statusByStaff = useMemo(() => {
    const m = new Map<string, ConfirmationStatus>();
    confirmations.forEach(c => m.set(c.staffId, c.status));
    return m;
  }, [confirmations]);
  const alreadySent = confirmations.length > 0;

  // No more confirmation aggregates — the new flow doesn't track replies
  // (Maria confirms in person at 3pm). The post-send pill just says "Links
  // sent" and doesn't count anything.

  useEffect(() => {
    if (!uid || !pid) return;
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
      if (fetched.length === 0) setPublicAreas(await seedDefaults());
      else if (needsReseed(fetched)) { for (const a of fetched) await deletePublicArea(uid, pid, a.id); setPublicAreas(await seedDefaults()); }
      else setPublicAreas(fetched);
    }).catch(err => {
      console.error('Error fetching public areas:', err);
    });
  }, [uid, pid]);

  useEffect(() => {
    if (activeProperty) {
      const legacySo = activeProperty.stayoverMinutes ?? 20;
      setSettingsForm({
        checkoutMinutes: activeProperty.checkoutMinutes ?? 30,
        stayoverMinutes: legacySo,
        stayoverDay1Minutes: activeProperty.stayoverDay1Minutes ?? 15,
        stayoverDay2Minutes: activeProperty.stayoverDay2Minutes ?? legacySo,
        prepMinutesPerActivity: activeProperty.prepMinutesPerActivity ?? 5,
        shiftMinutes: activeProperty.shiftMinutes ?? 420,
      });
    }
  }, [activeProperty]);

  const handleSaveSettings = async () => {
    if (!uid || !pid) return;
    setSavingSettings(true);
    try {
      // Keep legacy `stayoverMinutes` in sync with Day 2 (the fuller clean) so
      // any old consumers still reading the deprecated field get the safer estimate.
      const payload = { ...settingsForm, stayoverMinutes: settingsForm.stayoverDay2Minutes };
      await updateProperty(uid, pid, payload);
      await refreshProperty();
    } finally {
      setSavingSettings(false);
      setShowPredictionSettings(false);
    }
  };

  // ── Prediction model ──
  const coMins = activeProperty?.checkoutMinutes ?? 30;
  const legacySoMins = activeProperty?.stayoverMinutes ?? 20;
  const day1Mins = activeProperty?.stayoverDay1Minutes ?? 15;
  const day2Mins = activeProperty?.stayoverDay2Minutes ?? legacySoMins;
  // soMins kept for legacy call sites (DND/over-time fallbacks) — represents a sensible "blended" stayover estimate.
  const soMins = legacySoMins;
  const prepPerRoom = activeProperty?.prepMinutesPerActivity ?? 5;
  // Per-housekeeper daily cap. Configurable via Prediction Settings →
  // "Max hours per housekeeper" so different operators can dial it to
  // their staffing reality (6h, 7h, 8h, etc.). Default 420m (7h).
  const shiftLen = activeProperty?.shiftMinutes ?? 420;

  const checkouts = shiftRooms.filter(r => r.type === 'checkout').length;
  const stayovers = shiftRooms.filter(r => r.type === 'stayover').length;
  const totalRooms = checkouts + stayovers;
  // Per-room cleaning minutes using stayoverDay cycle (Day 1 odd = light, Day 2 even = full).
  // Fall back to legacy stayoverMinutes for arrival-day stayovers (stayoverDay=0 or missing).
  const minsForRoom = (r: { type: string; stayoverDay?: number }): number => {
    if (r.type === 'checkout') return coMins;
    const d = r.stayoverDay;
    if (typeof d !== 'number' || d <= 0) return legacySoMins;
    return d % 2 === 1 ? day1Mins : day2Mins;
  };
  const stayoverRooms = shiftRooms.filter(r => r.type === 'stayover');
  const stayoverMinutesTotal = stayoverRooms.reduce((sum, r) => sum + minsForRoom(r), 0);
  const roomMinutes = (checkouts * coMins) + stayoverMinutesTotal;
  const prepMinutes = totalRooms * prepPerRoom;

  const [shiftY, shiftM, shiftD] = shiftDate.split('-').map(Number);
  const shiftDateObj = new Date(shiftY, shiftM - 1, shiftD);
  const areasDueToday = getPublicAreasDueToday(publicAreas, shiftDateObj);
  const publicAreaMinutes = calcPublicAreaMinutes(areasDueToday);

  const LAUNDRY_STAFF = 1;
  const workloadMinutes = roomMinutes + prepMinutes;
  const cleaningStaff = workloadMinutes > 0 ? Math.ceil(workloadMinutes / shiftLen) : 0;
  const recommendedStaff = cleaningStaff + LAUNDRY_STAFF;

  // ── Auto-select crew + auto-assign rooms ──
  const eligiblePool = useMemo(() => autoSelectEligible(staff, shiftDate, new Set()), [staff, shiftDate]);
  const assignableRooms = useMemo(() =>
    [...shiftRooms].filter(r => r.type === 'checkout' || r.type === 'stayover')
      .sort((a, b) => (parseInt(a.number.replace(/\D/g, '')) || 0) - (parseInt(b.number.replace(/\D/g, '')) || 0)),
    [shiftRooms]
  );

  // The selected crew: auto-pick or manual override.
  // Always strip out anyone who isn't a housekeeper anymore — a saved
  // crew doc from an earlier day can still carry the old IDs, and we
  // don't want a manager who got moved to 'other' to keep showing up
  // on the schedule with rooms assigned.
  const isHousekeeper = (s: StaffMember) => (s.department ?? 'housekeeping') === 'housekeeping';
  const selectedCrew = useMemo(() => {
    if (userEditedCrew.current) {
      // User has made manual changes — respect crewOverride exactly (even if empty)
      return crewOverride
        .map(id => staff.find(s => s.id === id))
        .filter((s): s is StaffMember => !!s && isHousekeeper(s));
    }
    if (crewOverride.length > 0) return crewOverride
      .map(id => staff.find(s => s.id === id))
      .filter((s): s is StaffMember => !!s && isHousekeeper(s));
    if (recommendedStaff > 0 && totalRooms > 0) return eligiblePool.slice(0, recommendedStaff);
    return eligiblePool;
  }, [crewOverride, eligiblePool, recommendedStaff, totalRooms, staff]);

  // Auto-assign: full assign on first load, then only assign unassigned rooms on crew changes
  useEffect(() => {
    if (assignableRooms.length === 0 || selectedCrew.length === 0) { setAssignments({}); hasInitialAssign.current = false; return; }

    if (!hasInitialAssign.current) {
      // First time: full auto-assign
      const fakeScheduled = selectedCrew.map(s => ({ ...s, scheduledToday: true }));
      const auto = autoAssignRooms(assignableRooms, fakeScheduled, {
        checkoutMinutes: coMins,
        stayoverMinutes: legacySoMins,
        stayoverDay1Minutes: day1Mins,
        stayoverDay2Minutes: day2Mins,
        prepMinutesPerRoom: prepPerRoom,
        shiftMinutes: shiftLen,
      });
      setAssignments(auto);
      hasInitialAssign.current = true;

      // Auto-remove staff with 0 rooms (unless manually added)
      const assignedStaffIds = new Set(Object.values(auto));
      const emptyStaff = selectedCrew.filter(s => !assignedStaffIds.has(s.id) && !manuallyAdded.current.has(s.id));
      if (emptyStaff.length > 0) {
        setCrewOverride(prev => {
          const current = prev.length > 0 ? prev : selectedCrew.map(s => s.id);
          return current.filter(id => assignedStaffIds.has(id) || manuallyAdded.current.has(id));
        });
      }
    }
    // On subsequent crew changes, don't re-assign — let unassigned rooms stay unassigned
  }, [selectedCrew, assignableRooms, coMins, soMins, day1Mins, day2Mins, prepPerRoom, shiftLen]);

  const toggleCrewMember = (memberId: string) => {
    userEditedCrew.current = true;
    setCrewOverride(prev => {
      const current = prev.length > 0 ? prev : selectedCrew.map(s => s.id);
      if (current.includes(memberId)) {
        manuallyAdded.current.delete(memberId);
        // Unassign this person's rooms (move to unassigned pool)
        setAssignments(a => {
          const updated = { ...a };
          for (const [roomId, staffId] of Object.entries(updated)) {
            if (staffId === memberId) delete updated[roomId];
          }
          return updated;
        });
        return current.filter(id => id !== memberId);
      } else {
        manuallyAdded.current.add(memberId);
        return [...current, memberId];
      }
    });
  };


  // Snapshot of what the CSV looked like at save time — so the next open can diff.
  const currentCsvSnapshot = useMemo<CsvRoomSnapshot[]>(
    () => shiftRooms.map(r => ({ number: r.number, type: r.type as 'checkout' | 'stayover' })),
    [shiftRooms],
  );
  const currentCsvPulledAt = useMemo<string | null>(
    () => (planSnapshot?.pulledAt ? new Date(planSnapshot.pulledAt).toISOString() : null),
    [planSnapshot?.pulledAt],
  );

  // Ref mirror of assignableRooms so the sync-effect below can read the latest
  // list without becoming a dep (which would cause loops when our own write
  // bumps the rooms snapshot).
  const assignableRoomsRef = useRef(assignableRooms);
  useEffect(() => { assignableRoomsRef.current = assignableRooms; }, [assignableRooms]);

  // ── Persist assignments + crew to scheduleAssignments (debounced) ─────────
  // This is what makes Maria's 7pm work survive the 6am CSV refresh.
  //
  // ALSO fires /api/sync-room-assignments which mirrors the per-room
  // `assignedTo`/`assignedName` field on each rooms doc so the crew-row "Link"
  // button (opens /housekeeper/{id}) shows the current Schedule state before
  // Maria even hits Send. The HK page queries rooms by `assignedTo`, so
  // without this sync the Link preview would show stale data.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!uid || !pid) return;
    if (!scheduleAssignmentsLoaded) return;            // don't save before first load
    if (hydratedForDate.current !== shiftDate) return; // still hydrating this date
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const staffNames: Record<string, string> = {};
      selectedCrew.forEach(s => { staffNames[s.id] = s.name; });
      saveScheduleAssignments(uid, pid, shiftDate, {
        roomAssignments: assignments,
        crew: selectedCrew.map(s => s.id),
        staffNames,
        csvRoomSnapshot: currentCsvSnapshot,
        csvPulledAt: currentCsvPulledAt,
      }).catch(err => console.error('[Schedule] save assignments failed:', err));

      // Mirror the assignments onto each room doc (drives the HK Link preview).
      // Best-effort — a transient failure here is not user-visible; the next
      // autosave or Send will catch it up. Uses an `assignableRoomsRef` so the
      // effect doesn't re-fire every time Firestore's own write bumps the
      // rooms snapshot (which would loop through this effect).
      const currentAssignable = assignableRoomsRef.current;
      const staffPayload = selectedCrew.map(s => ({
        staffId: s.id,
        staffName: s.name,
        assignedRooms: currentAssignable
          .filter(r => assignments[r.id] === s.id)
          .map(r => r.number),
      }));
      fetch('/api/sync-room-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, shiftDate, staff: staffPayload }),
      }).catch(err => console.error('[Schedule] sync room assignments failed:', err));
    }, 400);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [uid, pid, shiftDate, assignments, selectedCrew, scheduleAssignmentsLoaded, currentCsvSnapshot, currentCsvPulledAt]);

  // ── Morning diff: what changed between Maria's saved CSV and the fresh 6am CSV ──
  // Only fires when (a) she's saved before and (b) a newer CSV has landed.
  const morningDiff = useMemo(() => {
    if (!scheduleAssignmentsDoc) return null;
    const savedSnap = scheduleAssignmentsDoc.csvRoomSnapshot ?? [];
    const savedPulledAt = scheduleAssignmentsDoc.csvPulledAt ?? null;
    if (savedSnap.length === 0) return null;                  // first save — nothing to diff against
    if (!currentCsvPulledAt || !savedPulledAt) return null;
    if (new Date(currentCsvPulledAt) <= new Date(savedPulledAt)) return null; // same or older CSV

    const savedByNumber = new Map(savedSnap.map(r => [r.number, r.type]));
    const currentByNumber = new Map(currentCsvSnapshot.map(r => [r.number, r.type]));

    const added: CsvRoomSnapshot[] = [];
    const removed: CsvRoomSnapshot[] = [];
    const typeChanged: Array<{ number: string; was: 'checkout' | 'stayover'; now: 'checkout' | 'stayover' }> = [];

    for (const r of currentCsvSnapshot) {
      const prev = savedByNumber.get(r.number);
      if (prev === undefined) added.push(r);
      else if (prev !== r.type) typeChanged.push({ number: r.number, was: prev, now: r.type });
    }
    for (const r of savedSnap) {
      if (!currentByNumber.has(r.number)) removed.push(r);
    }

    const hasChanges = added.length > 0 || removed.length > 0 || typeChanged.length > 0;
    if (!hasChanges) return null;
    return { added, removed, typeChanged, savedPulledAt, currentPulledAt: currentCsvPulledAt };
  }, [scheduleAssignmentsDoc, currentCsvSnapshot, currentCsvPulledAt]);

  // ── Morning confirmation: fresh CSV landed since Maria's save but nothing changed ──
  // This gives her a positive signal instead of silence when the 6am pull matches 7pm.
  const morningConfirmation = useMemo(() => {
    if (morningDiff) return null; // yellow callout takes priority
    if (!scheduleAssignmentsDoc) return null;
    const savedSnap = scheduleAssignmentsDoc.csvRoomSnapshot ?? [];
    const savedPulledAt = scheduleAssignmentsDoc.csvPulledAt ?? null;
    if (savedSnap.length === 0) return null;
    if (!currentCsvPulledAt || !savedPulledAt) return null;
    if (new Date(currentCsvPulledAt) <= new Date(savedPulledAt)) return null;
    return { pulledAt: currentCsvPulledAt };
  }, [morningDiff, scheduleAssignmentsDoc, currentCsvPulledAt]);

  // Plain-English sentence describing what changed overnight.
  const morningSummary = useMemo(() => {
    if (!morningDiff) return '';
    const parts: string[] = [];
    const { added, removed, typeChanged } = morningDiff;
    if (added.length) {
      const co = added.filter(r => r.type === 'checkout').map(r => r.number);
      const so = added.filter(r => r.type === 'stayover').map(r => r.number);
      const bits: string[] = [];
      if (co.length) bits.push(`${co.length} new checkout${co.length === 1 ? '' : 's'} (${co.join(', ')})`);
      if (so.length) bits.push(`${so.length} new stayover${so.length === 1 ? '' : 's'} (${so.join(', ')})`);
      parts.push(bits.join(' and ') + ' showed up');
    }
    if (removed.length) {
      parts.push(`${removed.length} room${removed.length === 1 ? '' : 's'} got pulled (${removed.map(r => r.number).join(', ')})`);
    }
    if (typeChanged.length) {
      parts.push(typeChanged.map(c => `${c.number} flipped from ${c.was} to ${c.now}`).join(', '));
    }
    const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ', and ' + parts.at(-1);
    return joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
  }, [morningDiff]);

  // Auto Recommend — distributes unassigned rooms across current crew, least-loaded first.
  const handleAutoRecommend = () => {
    // ── Step 1: top up crew to cleaningStaff (not recommendedStaff) ──
    //
    // cleaningStaff = ceil(totalCleaningMinutes / shiftLen) — the minimum
    // number of people needed to finish rooms without anyone going over
    // the configurable shift cap. recommendedStaff adds +1 for laundry,
    // but that person handles laundry, not rooms, so they shouldn't be
    // in the Auto Assign distribution. Using cleaningStaff here means
    // each housekeeper ends up closer to a full shift instead of sitting
    // at ~4h 30m while 5 people share work 4 could do.
    const currentIds = new Set(selectedCrew.map(s => s.id));
    const additions: StaffMember[] = [];
    const target = Math.max(cleaningStaff, 1);
    for (const s of eligiblePool) {
      if (currentIds.has(s.id)) continue;
      if (selectedCrew.length + additions.length >= target) break;
      additions.push(s);
    }
    const effectiveCrew = [...selectedCrew, ...additions];
    if (effectiveCrew.length === 0) return;

    // ── Step 2: seed current loads + floor counts from existing assignments ──
    // Existing (non-empty) assignments stay put — we don't yank rooms off
    // anyone mid-clean. floorCount[staff][floor] = how many rooms on that
    // floor they already own, so the stickiness logic below can prefer the
    // person who already owns most of a floor.
    const loadByStaff = new Map<string, number>();
    const floorCountByStaff = new Map<string, Map<string, number>>();
    for (const s of effectiveCrew) {
      loadByStaff.set(s.id, 0);
      floorCountByStaff.set(s.id, new Map());
    }
    for (const r of assignableRooms) {
      const who = assignments[r.id];
      if (!who || !loadByStaff.has(who)) continue;
      const mins = minsForRoom(r) + prepPerRoom;
      loadByStaff.set(who, (loadByStaff.get(who) ?? 0) + mins);
      const f = getFloor(r.number);
      const fmap = floorCountByStaff.get(who)!;
      fmap.set(f, (fmap.get(f) ?? 0) + 1);
    }

    // ── Step 3: sort unassigned rooms by floor, then checkouts first ──
    // Going floor-by-floor is what lets stickiness cluster the whole
    // floor onto one person before moving to the next.
    const toAssign = [...unassignedRooms].sort((a, b) => {
      const fA = getFloor(a.number);
      const fB = getFloor(b.number);
      if (fA !== fB) return fA < fB ? -1 : 1;
      if (a.type !== b.type) return a.type === 'checkout' ? -1 : 1;
      return (parseInt(a.number.replace(/\D/g, '')) || 0) - (parseInt(b.number.replace(/\D/g, '')) || 0);
    });

    // ── Step 4: one-person-per-floor with capacity respect ──
    //
    // For each room we want the staff who already owns the most rooms
    // on that floor (stickiness → one person per floor). Ties break on
    // whoever has less total load today. If the top pick would blow
    // through the shift cap, we filter them out first and fall back to
    // the next candidate — so floors that won't fit on one person spill
    // cleanly onto the next person instead of overloading anyone.
    const next = { ...assignments };
    for (const r of toAssign) {
      const f = getFloor(r.number);
      const mins = minsForRoom(r) + prepPerRoom;
      // Prefer only staff who have room under the cap. If literally
      // nobody fits, fall back to the full crew (better to assign than
      // leave the room in the pool — cap breach shows up as Near Capacity).
      const withCapacity = effectiveCrew.filter(s => (loadByStaff.get(s.id) ?? 0) + mins <= shiftLen);
      const pool = withCapacity.length > 0 ? withCapacity : effectiveCrew;
      let best: string | null = null;
      let bestFloorCount = -1;
      let bestLoad = Infinity;
      for (const s of pool) {
        const fc = floorCountByStaff.get(s.id)?.get(f) ?? 0;
        const load = loadByStaff.get(s.id) ?? 0;
        if (fc > bestFloorCount || (fc === bestFloorCount && load < bestLoad)) {
          bestFloorCount = fc;
          bestLoad = load;
          best = s.id;
        }
      }
      if (!best) break;
      next[r.id] = best;
      loadByStaff.set(best, (loadByStaff.get(best) ?? 0) + mins);
      const fmap = floorCountByStaff.get(best)!;
      fmap.set(f, (fmap.get(f) ?? 0) + 1);
    }

    // ── Step 5: drop anyone with 0 rooms after distribution ──
    //
    // Auto Assign is a clean-slate distribution. If the algorithm didn't
    // need a person (e.g. Astri sat at 0m while the other 4 carried the
    // full load), kick them off the crew instead of leaving a dead tile
    // cluttering the screen. This intentionally overrides the usual
    // manuallyAdded stickiness — the user specifically asked for Auto
    // Assign to prune extras. If somehow nobody got a room (defensive,
    // e.g. unassignedRooms was empty to begin with), leave crew alone.
    const usedStaffIds = new Set(
      Object.values(next).filter((v): v is string => !!v)
    );
    const keep = effectiveCrew.filter(s => usedStaffIds.has(s.id));
    const dropped = effectiveCrew.filter(s => !usedStaffIds.has(s.id));
    const shouldPrune = keep.length > 0 && dropped.length > 0;

    // Commit crew changes (additions + prunes) first so the tile render
    // matches what we're about to write into assignments.
    if (additions.length > 0 || shouldPrune) {
      userEditedCrew.current = true;
      // Only flag additions as manually-added if they actually ended up
      // with rooms — an addition that got pruned shouldn't leave a
      // sticky "manually added" marker behind.
      additions.forEach(s => {
        if (usedStaffIds.has(s.id)) manuallyAdded.current.add(s.id);
      });
      dropped.forEach(s => manuallyAdded.current.delete(s.id));
      const finalCrew = shouldPrune ? keep : effectiveCrew;
      setCrewOverride(finalCrew.map(s => s.id));
    }
    setAssignments(next);
    const parts: string[] = [];
    if (additions.length > 0) {
      parts.push(lang === 'es'
        ? `Agregado${additions.length === 1 ? '' : 's'}: ${additions.length}`
        : `Added ${additions.length}`);
    }
    if (shouldPrune) {
      parts.push(lang === 'es'
        ? `Quitado${dropped.length === 1 ? '' : 's'}: ${dropped.length}`
        : `Removed ${dropped.length}`);
    }
    const toastMsg = parts.length > 0
      ? (lang === 'es'
          ? `Habitaciones redistribuidas (${parts.join(', ')})`
          : `Rooms redistributed (${parts.join(', ')})`)
      : (lang === 'es' ? 'Habitaciones redistribuidas' : 'Rooms redistributed');
    showMoveToast(toastMsg);
  };

  const handleSend = async () => {
    if (!uid || !pid || selectedCrew.length === 0 || sending) return;
    setSending(true);
    try {
      // Make sure the latest assignments are written before we fire SMS.
      // The debounced save above may still be pending.
      const staffNames: Record<string, string> = {};
      selectedCrew.forEach(s => { staffNames[s.id] = s.name; });
      await saveScheduleAssignments(uid, pid, shiftDate, {
        roomAssignments: assignments,
        crew: selectedCrew.map(s => s.id),
        staffNames,
        csvRoomSnapshot: currentCsvSnapshot,
        csvPulledAt: currentCsvPulledAt,
      }).catch(err => console.error('[Schedule] save-before-send failed:', err));

      const baseUrl = window.location.origin;
      // Include EVERYONE on the crew — even people without a phone number.
      // The backend skips the SMS for phoneless staff but keeps their room
      // assignments intact (so the rooms don't fly back to Unassigned). Each
      // person gets a status back (sent / skipped / failed) that we render
      // as a badge next to their name.
      const staffPayload = selectedCrew.map(s => {
        const memberRooms = assignableRooms
          .filter(r => assignments[r.id] === s.id)
          .map(r => r.number);
        return {
          staffId: s.id,
          name: s.name,
          phone: s.phone ?? '',
          language: s.language,
          assignedRooms: memberRooms,
          assignedAreas: [] as string[],
        };
      });
      const res = await fetch('/api/send-shift-confirmations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, shiftDate, baseUrl, staff: staffPayload }),
      });
      // The subscribeToShiftConfirmations effect will pick up the new docs
      // and flip `alreadySent` automatically.

      // Parse the API response so we can tell Maria what actually happened:
      // - `fresh`: HKs who got a brand-new link SMS (no prior doc)
      // - `updated`: HKs whose existing doc was refreshed + re-texted
      // - `skipped`: HKs we couldn't text (no phone / invalid phone)
      // - `failed`: SMS sends that errored (Twilio issue, etc.)
      // - `perStaff`: per-person outcome, drives the badge next to each name
      try {
        const data = (await res.json()) as {
          sent?: number; failed?: number; skipped?: number; updated?: number; fresh?: number;
          perStaff?: Array<{ staffId: string; status: 'sent' | 'skipped' | 'failed'; reason?: string }>;
        };
        const fresh = data.fresh ?? 0;
        const updated = data.updated ?? 0;
        const skipped = data.skipped ?? 0;
        const failed = data.failed ?? 0;

        // Store per-person outcome so each crew card can show its own badge.
        if (data.perStaff) {
          const m = new Map<string, SendResult>();
          data.perStaff.forEach(r => m.set(r.staffId, { status: r.status, reason: r.reason }));
          setSendResults(m);
        }

        const parts: string[] = [];
        if (fresh > 0) parts.push(lang === 'es' ? `${fresh} enlace${fresh === 1 ? '' : 's'}` : `${fresh} link${fresh === 1 ? '' : 's'}`);
        if (updated > 0) parts.push(lang === 'es' ? `${updated} actualización${updated === 1 ? '' : 'es'}` : `${updated} update${updated === 1 ? '' : 's'}`);
        if (skipped > 0) parts.push(lang === 'es' ? `${skipped} omitido${skipped === 1 ? '' : 's'}` : `${skipped} skipped`);
        if (failed > 0) parts.push(lang === 'es' ? `${failed} fallaron` : `${failed} failed`);

        const msg = parts.length
          ? (lang === 'es' ? `Enviado: ${parts.join(' · ')}` : `Sent: ${parts.join(' · ')}`)
          : (lang === 'es' ? 'Enviado' : 'Sent');

        if (toastTimer.current) clearTimeout(toastTimer.current);
        setMoveToast(msg);
        toastTimer.current = setTimeout(() => setMoveToast(null), 5000);
      } catch (err) {
        console.error('[Schedule] send response parse failed:', err);
      }
    } finally { setSending(false); }
  };

  // Room workload per staff member
  const getStaffWorkload = (staffId: string) => {
    const staffRooms = assignableRooms.filter(r => assignments[r.id] === staffId);
    const mins = staffRooms.reduce((sum, r) => sum + minsForRoom(r) + prepPerRoom, 0);
    return { rooms: staffRooms, mins };
  };

  // Unassigned rooms (not assigned to any current crew member)
  const unassignedRooms = useMemo(() => {
    const crewIds = new Set(selectedCrew.map(s => s.id));
    return assignableRooms.filter(r => !assignments[r.id] || !crewIds.has(assignments[r.id]));
  }, [assignableRooms, assignments, selectedCrew]);

  const unassignedRef = useRef<HTMLDivElement | null>(null);

  // ── Drag-and-drop via Pointer Events (mouse + touch) ──
  const DRAG_THRESHOLD = 8;

  const findDropTarget = useCallback((x: number, y: number): string | null => {
    // Check unassigned box first
    if (unassignedRef.current) {
      const r = unassignedRef.current.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return '__unassigned__';
    }
    for (const [staffId, el] of Object.entries(crewCardRefs.current)) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return staffId;
    }
    return null;
  }, []);

  const onPillPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>, room: Room) => {
    // Capture pointer so all subsequent move/up events come to this element
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      roomId: room.id, roomNumber: room.number, roomType: room.type, stayoverDay: room.stayoverDay,
      startX: e.clientX, startY: e.clientY, active: false,
    };
  }, []);

  const onPillPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d.roomId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.active) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
      d.active = true;
    }
    e.preventDefault();
    const dt = findDropTarget(e.clientX, e.clientY);
    setDragState({
      roomId: d.roomId, roomNumber: d.roomNumber, roomType: d.roomType, stayoverDay: d.stayoverDay,
      ghost: { x: e.clientX, y: e.clientY }, dropTarget: dt,
    });
  }, [findDropTarget]);

  const showMoveToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setMoveToast(msg);
    toastTimer.current = setTimeout(() => setMoveToast(null), 4000);
  }, []);

  const onPillPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    const d = dragRef.current;
    if (d.active && d.roomId) {
      setDragState(prev => {
        if (prev?.dropTarget && prev.roomId) {
          const fromStaffId = assignments[prev.roomId];
          if (prev.dropTarget === '__unassigned__') {
            // Move to unassigned
            if (fromStaffId) {
              setAssignments(a => { const updated = { ...a }; delete updated[prev.roomId]; return updated; });
              const fromName = selectedCrew.find(s => s.id === fromStaffId)?.name ?? '?';
              showMoveToast(lang === 'es' ? `${prev.roomNumber} movida de ${fromName} a Sin Asignar` : `Moved ${prev.roomNumber} from ${fromName} to Unassigned`);
            }
          } else if (fromStaffId !== prev.dropTarget) {
            setAssignments(a => ({ ...a, [prev.roomId]: prev.dropTarget! }));
            const fromName = fromStaffId ? (selectedCrew.find(s => s.id === fromStaffId)?.name ?? '?') : (lang === 'es' ? 'Sin Asignar' : 'Unassigned');
            const toName = selectedCrew.find(s => s.id === prev.dropTarget)?.name ?? '?';
            showMoveToast(lang === 'es' ? `${prev.roomNumber} movida de ${fromName} a ${toName}` : `Moved ${prev.roomNumber} from ${fromName} to ${toName}`);
          }
        }
        return null;
      });
    } else {
      setDragState(null);
    }
    dragRef.current = { roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false };
  }, [assignments, selectedCrew, showMoveToast]);

  // If the browser cancels the pointer (e.g. interrupted by scroll, app switch),
  // clear all drag state so the ghost doesn't stay stuck on screen.
  const onPillPointerCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    setDragState(null);
    dragRef.current = { roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false };
  }, []);

  // Compute deficit
  const staffDeficit = recommendedStaff - selectedCrew.length;

  return (
    <div style={{ padding: '16px 24px 200px', background: 'var(--bg)', minHeight: 'calc(100vh - 180px)', display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Date picker ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' }}>
        <button onClick={() => { setShiftDate(d => addDays(d, -1)); setCrewOverride([]); }} style={{ background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)', border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px', padding: '8px 12px', cursor: 'pointer', color: '#454652' }} aria-label={lang === 'es' ? 'Día anterior' : 'Previous day'}>
          <ChevronLeft size={18} />
        </button>
        <span style={{ fontSize: '16px', fontWeight: 600, color: '#364262', letterSpacing: '-0.01em' }}>
          {formatDisplayDate(shiftDate, lang)}
        </span>
        <button onClick={() => { setShiftDate(d => addDays(d, 1)); setCrewOverride([]); }} style={{ background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)', border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px', padding: '8px 12px', cursor: 'pointer', color: '#454652' }} aria-label={lang === 'es' ? 'Día siguiente' : 'Next day'}>
          <ChevronRight size={18} />
        </button>
      </div>

      {/* ── Last CSV update stamp — always visible so Maria knows the system is alive ── */}
      {currentCsvPulledAt && (() => {
        const ageMs = Date.now() - new Date(currentCsvPulledAt).getTime();
        const ageHours = ageMs / (1000 * 60 * 60);
        const isStale = ageHours > 6; // flag if >6h old
        const isVeryStale = ageHours > 12;
        const accent = isVeryStale ? '#b91c1c' : isStale ? '#b45309' : '#364262';
        const mutedText = isVeryStale ? '#ef4444' : isStale ? '#d97706' : '#94a3b8';
        return (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            fontSize: '12px', color: isStale ? accent : '#64748b', marginTop: '-12px',
            fontWeight: isStale ? 600 : 400,
          }}>
            {isStale ? <AlertTriangle size={12} style={{ color: accent }} /> : <Clock size={12} style={{ color: '#94a3b8' }} />}
            <span>
              {lang === 'es' ? 'Lista de habitaciones actualizada:' : 'Room list updated:'}{' '}
              <span style={{ color: accent, fontWeight: 600 }}>{formatPulledAt(currentCsvPulledAt, lang)}</span>
              {planSnapshot?.pullType && (
                <span style={{ color: mutedText }}>
                  {' · '}
                  {planSnapshot.pullType === 'evening'
                    ? (lang === 'es' ? 'Plan nocturno' : 'Evening plan')
                    : (lang === 'es' ? 'Plan matutino' : 'Morning plan')}
                </span>
              )}
              {isStale && (
                <span style={{ color: accent, marginLeft: '8px' }}>
                  {lang === 'es'
                    ? `· Datos de hace ${Math.round(ageHours)}h — considera recargar`
                    : `· ${Math.round(ageHours)}h old — consider refreshing`}
                </span>
              )}
            </span>
          </div>
        );
      })()}

      {/* ── Prediction Hero Card (glass) ── */}
      <section className="glass-hero" style={{
        border: '1px solid rgba(197,197,212,0.2)', borderRadius: '16px',
        padding: '24px 32px', position: 'relative', overflow: 'hidden',
        cursor: 'pointer', margin: '0 auto', width: 'fit-content', minWidth: '320px',
      }} onClick={() => setShowPredictionSettings(true)}>
        {/* Background image — same as dashboard hero */}
        <div className="glass-hero-bg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuAUkJ87OGqb9QZ3nLbfCbHYuNgoCRsfcrSTqcfy8LlaEm8_94XXXZc5LvqA_5T36RJJykyAlxUHbasVhW-V52jbgsdVMHhedC17vZk_Y5-TCMq6NWzbrN60mUF_bgeUYq_2wEOltK3e5GIuN5krTVz7lju3NN9ru-gTTwjtEG0ZIRdl1dGDL4FP5KjnJsNm2lw4HNq9nO7C0xSjh0WnhsNEQ0c9rQP5-Bg5ycpesyUdhDiSQPxFLzP6L1vDs-8LjUHCbvH0R4UFxyU"
            alt=""
            aria-hidden="true"
          />
        </div>

        {predictionLoading ? (
          <div style={{ textAlign: 'center' }}>
            <div className="spinner" style={{ width: '28px', height: '28px', margin: '0 auto 12px' }} />
            <p style={{ fontSize: '14px', color: '#454652', margin: 0 }}>{t('roomDataLoading', lang)}</p>
          </div>
        ) : totalRooms === 0 && planSnapshot ? (
          /* ── Plan Snapshot Card (CSV data from 7pm/6am) ── */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', position: 'relative', zIndex: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {planSnapshot.pullType === 'evening' ? (lang === 'es' ? 'Plan Nocturno' : 'Evening Plan') : (lang === 'es' ? 'Plan Matutino' : 'Morning Plan')}
              </span>
              <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                {planSnapshot.pulledAt ? new Date(planSnapshot.pulledAt).toLocaleTimeString(lang === 'es' ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' }) : ''}
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '40px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Salidas' : 'Checkouts'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{planSnapshot.checkouts}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Continuaciones' : 'Stayovers'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>
                  {planSnapshot.stayovers}
                  <span style={{ fontSize: '14px', color: '#64748b', fontWeight: 400, marginLeft: '6px' }}>
                    ({planSnapshot.stayoverDay1 ?? 0} {lang === 'es' ? 'ligeros' : 'light'} · {planSnapshot.stayoverDay2 ?? 0} {lang === 'es' ? 'completos' : 'full'})
                  </span>
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Personal Necesario' : 'Staff Needed'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{planSnapshot.recommendedHKs}</p>
              </div>
            </div>
            {/* Workload bar */}
            <div style={{ width: '100%', maxWidth: '400px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', color: '#64748b', fontWeight: 500 }}>{lang === 'es' ? 'Carga Total' : 'Total Workload'}</span>
                <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: '#454652' }}>
                  {Math.floor(planSnapshot.totalCleaningMinutes / 60)}h {planSnapshot.totalCleaningMinutes % 60}m
                </span>
              </div>
              <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(197,197,212,0.2)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '3px',
                  background: 'linear-gradient(90deg, #3b82f6, #6366f1)',
                  width: `${Math.min(100, (planSnapshot.totalCleaningMinutes / (planSnapshot.recommendedHKs * 480)) * 100)}%`,
                }} />
              </div>
            </div>
            {/* Extra counts row */}
            <div style={{ display: 'flex', gap: '24px', fontSize: '13px', color: '#64748b' }}>
              <span><Sparkles size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '3px' }} />{planSnapshot.vacantClean} {lang === 'es' ? 'Listas' : 'Ready'}</span>
              {planSnapshot.ooo > 0 && <span><Ban size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '3px' }} />{planSnapshot.ooo} OOO</span>}
            </div>
          </div>
        ) : totalRooms === 0 ? (
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '14px', color: '#454652', margin: 0 }}>{t('noRoomDataYet', lang)}</p>
            <p style={{ fontSize: '12px', color: '#94a3b8', margin: '4px 0 0' }}>{t('pmsSync15Min', lang)}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', position: 'relative', zIndex: 10 }}>
            {/* CSV caption — Active Checkouts / Stayovers / Staff Needed all
                come from the hourly CSV pull (see scraper/scraper.js
                maybeRunCSVPull). Three visual states, mirroring the PMS
                block below so Maria sees consistent warnings across both
                data sources:
                  • fresh (≤75 min):   grey "CSV updated X:XX" caption
                  • stale (75–180):    amber banner, numbers may lag (1–2
                                       missed hourly pulls, usually transient)
                  • error (>180 min):  red banner, scraper is probably down
                                       (3+ missed pulls — watchdog SMS will
                                       have already fired by this point) */}
            {planSnapshot?.pulledAt && (() => {
              const CSV_STALE_MINUTES = 75;
              const CSV_ERROR_MINUTES = 180;
              const csvPulledAt: Date | null =
                planSnapshot.pulledAt instanceof Date
                  ? planSnapshot.pulledAt
                  : (planSnapshot.pulledAt?.toDate?.() ?? null);
              if (!csvPulledAt) return null;
              const csvMinutesAgo = Math.max(0, Math.round((nowMs - csvPulledAt.getTime()) / 60_000));
              const timeStr = csvPulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
              const csvState: 'fresh' | 'stale' | 'error' =
                csvMinutesAgo > CSV_ERROR_MINUTES ? 'error' :
                csvMinutesAgo > CSV_STALE_MINUTES ? 'stale' :
                'fresh';

              if (csvState === 'fresh') {
                return (
                  <p style={{ fontSize: '11px', color: '#94a3b8', margin: 0 }}>
                    {lang === 'es' ? `CSV actualizado ${timeStr}` : `CSV updated ${timeStr}`}
                  </p>
                );
              }

              if (csvState === 'stale') {
                return (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '8px 12px', borderRadius: '8px',
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '1px solid rgba(217, 119, 6, 0.35)',
                    fontSize: '12px', color: '#78350f', fontWeight: 500,
                    maxWidth: '440px', textAlign: 'center',
                  }}>
                    <AlertTriangle size={14} style={{ color: '#b45309', flexShrink: 0 }} />
                    <span>
                      {lang === 'es'
                        ? `CSV antiguo — última actualización ${timeStr} (hace ${csvMinutesAgo} min). Debería actualizarse cada hora.`
                        : `CSV stale — last updated ${timeStr} (${csvMinutesAgo} min ago). Should pull hourly.`}
                    </span>
                  </div>
                );
              }

              // error state — 3+ missed hourly pulls
              return (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '8px 12px', borderRadius: '8px',
                  background: 'rgba(220, 38, 38, 0.10)',
                  border: '1px solid rgba(220, 38, 38, 0.35)',
                  fontSize: '12px', color: '#7f1d1d', fontWeight: 500,
                  maxWidth: '440px',
                }}>
                  <AlertTriangle size={14} style={{ color: '#b91c1c', flexShrink: 0, marginTop: '2px' }} />
                  <div style={{ textAlign: 'left' }}>
                    <div>
                      {lang === 'es'
                        ? 'Falla la actualización del CSV — Reeyen fue notificado.'
                        : 'CSV pull failing — Reeyen has been notified.'}
                    </div>
                    <div style={{ fontSize: '11px', color: '#991b1b', fontWeight: 400, marginTop: '2px' }}>
                      {lang === 'es'
                        ? `Últimos números buenos a las ${timeStr} (hace ${csvMinutesAgo} min).`
                        : `Last good numbers at ${timeStr} (${csvMinutesAgo} min ago).`}
                    </div>
                  </div>
                </div>
              );
            })()}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '40px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Salidas Activas' : 'Active Checkouts'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{checkouts}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Continuaciones' : 'Stayovers'}</p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{stayovers}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Personal Necesario' : 'Staff Needed'}</p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: '#364262', lineHeight: 1, margin: 0 }}>{recommendedStaff}</p>
                  {staffDeficit > 0 && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 600, color: '#ba1a1a' }}>+{staffDeficit} Deficit</span>
                  )}
                </div>
              </div>
            </div>

          </div>
        )}

        {/* ── Live PMS numbers from Choice Advantage View pages ───────── */}
        {/* Always rendered — regardless of plan-snapshot / active-rooms /  */}
        {/* empty branch above — because these are CURRENT-MOMENT PMS      */}
        {/* numbers and Maria needs them visible on every view of the      */}
        {/* Schedule tab. Pulled every 15 min 5am–11pm by the Railway      */}
        {/* scraper (see scraper/dashboard-pull.js).                        */}
        {/*                                                                  */}
        {/* Three visual states, driven by dashboardFreshness():            */}
        {/*   • fresh:   normal numbers, grey "PMS updated 4:01 PM" caption */}
        {/*   • stale:   numbers greyed out with amber warning banner;      */}
        {/*              Maria can still see them but knows not to trust    */}
        {/*   • error:   numbers replaced with dashes, red banner with      */}
        {/*              actionable text ("Sign in failed — password may   */}
        {/*              have been changed")                                */}
        {/*                                                                  */}
        {/* We deliberately NEVER show a plausible-looking number without   */}
        {/* also telling Maria how stale it is. The whole point of this     */}
        {/* block is that a silently wrong number is worse than no number. */}
        {!predictionLoading && (() => {
          const freshness = dashboardFreshness(dashboardNums, nowMs);
          // Wrap the numbers-or-dashes choice once so it stays consistent
          // across all three columns. 'error' shows dashes unless we have
          // a pulledAt still in-window (then it's degraded to "stale"
          // visually but we already flagged it in the banner).
          const showDashes = freshness === 'error' || freshness === 'unknown';
          const fmt = (n: number | null | undefined) =>
            showDashes ? '—' : (typeof n === 'number' ? n : '—');
          const numColor =
            freshness === 'fresh' ? '#364262' :
            freshness === 'stale' ? '#94a3b8' :
            '#cbd5e1';
          // Build the caption / banner. Shape depends on state.
          const errorCopy = (code: DashboardNumbers['errorCode'], lang: 'en' | 'es'): string => {
            // Actionable human copy per code. Keep short — this shows in a
            // red banner on a phone screen. "What does Maria do next?" is
            // the guiding question for the wording.
            const en: Record<string, string> = {
              login_failed:      'Choice Advantage sign-in failed — password may have been changed. Tell Reeyen.',
              session_expired:   'Lost Choice Advantage session — retrying. Check back in a minute.',
              selector_miss:     'Choice Advantage page layout changed — Reeyen needs to update the scraper.',
              timeout:           'Choice Advantage was slow to respond — retrying in 15 min.',
              parse_error:       'Could not read numbers from Choice Advantage. Reeyen has been notified.',
              validation_failed: 'Choice Advantage returned numbers outside the expected range. Reeyen has been notified.',
              ca_unreachable:    'Could not reach Choice Advantage. Check the CA website yourself.',
              unknown:           'Something unexpected happened pulling PMS data. Reeyen has been notified.',
            };
            const es: Record<string, string> = {
              login_failed:      'Falló el inicio de sesión en Choice Advantage — la contraseña puede haber cambiado. Avísale a Reeyen.',
              session_expired:   'Sesión de Choice Advantage perdida — reintentando. Revisa en un minuto.',
              selector_miss:     'El diseño de Choice Advantage cambió — Reeyen debe actualizar el scraper.',
              timeout:           'Choice Advantage respondió lento — reintentando en 15 min.',
              parse_error:       'No se pudieron leer los números de Choice Advantage. Reeyen fue notificado.',
              validation_failed: 'Choice Advantage devolvió números fuera de rango. Reeyen fue notificado.',
              ca_unreachable:    'No se pudo conectar con Choice Advantage. Revisa el sitio directamente.',
              unknown:           'Ocurrió algo inesperado al obtener los datos del PMS. Reeyen fue notificado.',
            };
            const dict = lang === 'es' ? es : en;
            return dict[code ?? 'unknown'] ?? dict.unknown;
          };
          // Stale caption shows BOTH last-fresh time and minutes-old count so
          // Maria can eyeball "how out of date is this" without doing math.
          const minutesStale = dashboardNums?.pulledAt
            ? Math.max(0, Math.round((nowMs - dashboardNums.pulledAt.getTime()) / 60_000))
            : null;
          return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: '40px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
                  <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Llegadas' : 'Arrivals'}</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: numColor, lineHeight: 1, margin: 0 }}>
                    {fmt(dashboardNums?.arrivals)}
                  </p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
                  <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'En Casa' : 'In House'}</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: numColor, lineHeight: 1, margin: 0 }}>
                    {fmt(dashboardNums?.inHouse)}
                  </p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' }}>
                  <p style={{ fontSize: '14px', color: '#454652', fontWeight: 500, margin: 0 }}>{lang === 'es' ? 'Salidas' : 'Departures'}</p>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '36px', fontWeight: 500, color: numColor, lineHeight: 1, margin: 0 }}>
                    {fmt(dashboardNums?.departures)}
                  </p>
                </div>
              </div>
              {/* Status line / banner — one of four variants. */}
              {freshness === 'fresh' && dashboardNums?.pulledAt && (
                <p style={{ fontSize: '11px', color: '#94a3b8', margin: 0 }}>
                  {`${lang === 'es' ? 'PMS actualizado' : 'PMS updated'} ${dashboardNums.pulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
                </p>
              )}
              {freshness === 'stale' && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '8px 12px', borderRadius: '8px',
                  background: 'rgba(245, 158, 11, 0.12)',
                  border: '1px solid rgba(217, 119, 6, 0.35)',
                  fontSize: '12px', color: '#78350f', fontWeight: 500,
                  maxWidth: '440px', textAlign: 'center',
                }}>
                  <AlertTriangle size={14} style={{ color: '#b45309', flexShrink: 0 }} />
                  <span>
                    {lang === 'es'
                      ? `Datos PMS antiguos — última actualización ${dashboardNums?.pulledAt?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) ?? '—'}${minutesStale !== null ? ` (hace ${minutesStale} min)` : ''}. Verifica Choice Advantage directamente si necesitas números en vivo.`
                      : `PMS data is stale — last updated ${dashboardNums?.pulledAt?.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) ?? '—'}${minutesStale !== null ? ` (${minutesStale} min ago)` : ''}. Should be every ${DASHBOARD_STALE_MINUTES} min max. Check Choice Advantage directly if you need live numbers.`}
                  </span>
                </div>
              )}
              {freshness === 'error' && (
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '8px',
                  padding: '8px 12px', borderRadius: '8px',
                  background: 'rgba(220, 38, 38, 0.10)',
                  border: '1px solid rgba(220, 38, 38, 0.35)',
                  fontSize: '12px', color: '#7f1d1d', fontWeight: 500,
                  maxWidth: '440px',
                }}>
                  <AlertTriangle size={14} style={{ color: '#b91c1c', flexShrink: 0, marginTop: '2px' }} />
                  <div style={{ textAlign: 'left' }}>
                    <div>{errorCopy(dashboardNums?.errorCode ?? 'unknown', lang === 'es' ? 'es' : 'en')}</div>
                    {dashboardNums?.pulledAt && (
                      <div style={{ fontSize: '11px', color: '#991b1b', fontWeight: 400, marginTop: '2px' }}>
                        {lang === 'es'
                          ? `Últimos números buenos a las ${dashboardNums.pulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
                          : `Last good numbers at ${dashboardNums.pulledAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {freshness === 'unknown' && (
                <p style={{ fontSize: '11px', color: '#94a3b8', margin: 0 }}>
                  {lang === 'es' ? 'Esperando datos de PMS...' : 'Waiting for PMS data...'}
                </p>
              )}

              {/* ── Room-count reconciliation ("hidden rooms" check) ──
                  Maria's 7pm ritual: compare in-house + arrivals against the
                  property's total room count. If they don't match, the front
                  desk has probably over- or under-counted a group booking
                  (e.g. TDCJ books 25 when they only need 18 → 7 rooms get
                  "hidden" and can't be sold). Brandy is the only one with
                  group-booking access so the action here is "tell Brandy".

                  Rendered only when PMS numbers are actually trustworthy —
                  skipped on 'error' and 'unknown' freshness so we don't flag
                  bogus math on stale/missing data. Property totalRooms (74
                  for Comfort Suites Beaumont) is configured in settings.   */}
              {(freshness === 'fresh' || freshness === 'stale')
                && dashboardNums?.inHouse != null
                && dashboardNums?.arrivals != null
                && (activeProperty?.totalRooms ?? 0) > 0
                && (() => {
                  const totalPropertyRooms = activeProperty!.totalRooms;
                  const inHouseNum = dashboardNums!.inHouse as number;
                  const arrivalsNum = dashboardNums!.arrivals as number;
                  const roomSum = inHouseNum + arrivalsNum;
                  const delta = roomSum - totalPropertyRooms;

                  // Matched — quiet green confirmation.
                  if (delta === 0) {
                    return (
                      <p style={{ fontSize: '11px', color: '#15803d', margin: 0, fontWeight: 500 }}>
                        {lang === 'es'
                          ? `✓ Habitaciones cuadran: ${inHouseNum} en casa + ${arrivalsNum} llegadas = ${totalPropertyRooms}`
                          : `✓ Room count matches: ${inHouseNum} in-house + ${arrivalsNum} arrivals = ${totalPropertyRooms}`}
                      </p>
                    );
                  }

                  // Over-count — red. Group booking has extra rooms that
                  // should be released. This is the scenario Maria catches
                  // most often (e.g. TDCJ booked 25, needs 18).
                  if (delta > 0) {
                    return (
                      <div style={{
                        display: 'flex', alignItems: 'flex-start', gap: '8px',
                        padding: '8px 12px', borderRadius: '8px',
                        background: 'rgba(220, 38, 38, 0.10)',
                        border: '1px solid rgba(220, 38, 38, 0.35)',
                        fontSize: '12px', color: '#7f1d1d', fontWeight: 500,
                        maxWidth: '460px',
                      }}>
                        <AlertTriangle size={14} style={{ color: '#b91c1c', flexShrink: 0, marginTop: '2px' }} />
                        <div style={{ textAlign: 'left' }}>
                          <div>
                            {lang === 'es'
                              ? `Habitaciones no cuadran: ${inHouseNum} en casa + ${arrivalsNum} llegadas = ${roomSum}, pero la propiedad tiene ${totalPropertyRooms}.`
                              : `Room count mismatch: ${inHouseNum} in-house + ${arrivalsNum} arrivals = ${roomSum}, but property has ${totalPropertyRooms}.`}
                          </div>
                          <div style={{ fontSize: '11px', color: '#991b1b', fontWeight: 400, marginTop: '2px' }}>
                            {lang === 'es'
                              ? `${delta} habitación${delta === 1 ? '' : 'es'} de más — pídele a Brandy que revise las reservas de grupos (probablemente reservaron más de lo necesario).`
                              : `${delta} extra room${delta === 1 ? '' : 's'} showing — ask Brandy to check group bookings (likely over-booked).`}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Under-count — amber. Could be legit (rooms genuinely
                  // available for sale) OR rooms hidden in a group booking.
                  // We can't tell which without scraping the "available"
                  // number, so surface it softly and let Maria/Raj judge
                  // by cross-checking CA's available count.
                  return (
                    <div style={{
                      display: 'flex', alignItems: 'flex-start', gap: '8px',
                      padding: '8px 12px', borderRadius: '8px',
                      background: 'rgba(245, 158, 11, 0.12)',
                      border: '1px solid rgba(217, 119, 6, 0.35)',
                      fontSize: '12px', color: '#78350f', fontWeight: 500,
                      maxWidth: '460px',
                    }}>
                      <AlertTriangle size={14} style={{ color: '#b45309', flexShrink: 0, marginTop: '2px' }} />
                      <div style={{ textAlign: 'left' }}>
                        <div>
                          {lang === 'es'
                            ? `Faltan habitaciones: ${inHouseNum} en casa + ${arrivalsNum} llegadas = ${roomSum}, de ${totalPropertyRooms}.`
                            : `Rooms missing: ${inHouseNum} in-house + ${arrivalsNum} arrivals = ${roomSum}, out of ${totalPropertyRooms}.`}
                        </div>
                        <div style={{ fontSize: '11px', color: '#92400e', fontWeight: 400, marginTop: '2px' }}>
                          {lang === 'es'
                            ? `${-delta} habitación${-delta === 1 ? '' : 'es'} sin contar. Si Choice Advantage muestra 0 disponibles, pídele a Brandy que revise si hay habitaciones escondidas en un grupo.`
                            : `${-delta} room${-delta === 1 ? '' : 's'} unaccounted for. If Choice Advantage shows 0 available, ask Brandy to check if rooms are hidden in a group booking.`}
                        </div>
                      </div>
                    </div>
                  );
                })()}
            </div>
          );
        })()}
      </section>

      {/* ── Overnight Changes Callout (6am CSV diff vs Maria's saved plan) ── */}
      {!predictionLoading && morningDiff && (
        <section style={{
          display: 'flex', flexDirection: 'column', gap: '12px',
          padding: '16px 18px',
          borderRadius: '16px',
          background: 'linear-gradient(180deg, rgba(255,236,179,0.45) 0%, rgba(255,236,179,0.2) 100%)',
          border: '1px solid rgba(217,119,6,0.25)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Sparkles size={16} style={{ color: '#b45309' }} />
              <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#78350f', margin: 0, letterSpacing: '0.01em' }}>
                {lang === 'es' ? 'Cambios durante la noche' : 'What changed overnight'}
              </h3>
            </div>
            <button
              onClick={handleAutoRecommend}
              disabled={unassignedRooms.length === 0 || selectedCrew.length === 0}
              style={{
                padding: '8px 14px', borderRadius: '9999px',
                background: unassignedRooms.length === 0 ? '#e5e7eb' : '#364262',
                color: unassignedRooms.length === 0 ? '#9ca3af' : '#ffffff',
                border: 'none',
                fontFamily: 'var(--font-sans)', fontSize: '13px', fontWeight: 600,
                cursor: unassignedRooms.length === 0 ? 'not-allowed' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: '6px',
              }}
            >
              <Sparkles size={13} />
              {lang === 'es' ? 'Recomendación Automática' : 'Auto Recommend'}
            </button>
          </div>

          <p style={{ fontSize: '14px', color: '#57361f', margin: 0, lineHeight: 1.5 }}>
            {morningSummary}
          </p>

          {unassignedRooms.length > 0 && (
            <p style={{ fontSize: '13px', color: '#92400e', margin: 0, lineHeight: 1.4, fontWeight: 500 }}>
              {lang === 'es'
                ? `${unassignedRooms.length} habitación${unassignedRooms.length === 1 ? '' : 'es'} sin asignar — arrastra manualmente o usa Recomendación Automática para repartirlas.`
                : `${unassignedRooms.length} room${unassignedRooms.length === 1 ? '' : 's'} still need a housekeeper — drag them yourself or hit Auto Recommend to split them across the crew.`}
            </p>
          )}
          {unassignedRooms.length === 0 && (
            <p style={{ fontSize: '13px', color: '#065f46', margin: 0, lineHeight: 1.4, fontWeight: 500 }}>
              {lang === 'es'
                ? '✓ Todas las habitaciones están asignadas. Revisa y pulsa Enviar para actualizar a los limpiadores.'
                : '✓ All rooms are covered. Review and hit Send to update the housekeepers.'}
            </p>
          )}
        </section>
      )}

      {/* ── "No overnight changes" confirmation (6am CSV landed, matched Maria's 7pm save) ── */}
      {!predictionLoading && morningConfirmation && (
        <section style={{
          display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '14px 18px',
          borderRadius: '16px',
          background: 'linear-gradient(180deg, rgba(34,197,94,0.12) 0%, rgba(34,197,94,0.04) 100%)',
          border: '1px solid rgba(34,197,94,0.25)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <CheckCircle2 size={16} style={{ color: '#15803d' }} />
            <h3 style={{ fontSize: '15px', fontWeight: 700, color: '#14532d', margin: 0, letterSpacing: '0.01em' }}>
              {lang === 'es' ? 'Sin cambios durante la noche' : 'No overnight changes'}
            </h3>
          </div>
          <p style={{ fontSize: '14px', color: '#166534', margin: 0, lineHeight: 1.5 }}>
            {lang === 'es'
              ? `El PMS se actualizó (${formatPulledAt(morningConfirmation.pulledAt, lang)}) y coincide con lo que guardaste anoche. Tu plan está bien — pulsa Enviar cuando estés lista.`
              : `The PMS refreshed (${formatPulledAt(morningConfirmation.pulledAt, lang)}) and matches what you saved last night. Your plan is good to go — hit Send when you're ready.`}
          </p>
        </section>
      )}

      {/* ── Unassigned Rooms Pool ── */}
      {!predictionLoading && totalRooms > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#364262', margin: 0 }}>
              {lang === 'es' ? 'Habitaciones Sin Asignar' : 'Unassigned Rooms'}
            </h3>
            <span style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', color: '#454652' }}>
              {unassignedRooms.length} {lang === 'es' ? 'Restantes' : 'Rooms Remaining'}
            </span>
          </div>
          <div
            ref={unassignedRef}
            style={{
              display: 'flex', flexWrap: 'wrap', gap: '12px',
              minHeight: '48px',
              padding: unassignedRooms.length === 0 ? '12px' : '0',
              background: dragState?.dropTarget === '__unassigned__' ? 'rgba(54,66,98,0.04)' : 'transparent',
              borderRadius: '16px',
              border: dragState?.dropTarget === '__unassigned__' ? '2px dashed #364262' : '2px dashed transparent',
              transition: 'all 0.15s',
            }}
          >
            {unassignedRooms.length === 0 && totalRooms > 0 && (
              <p style={{ fontSize: '14px', color: '#10b981', fontWeight: 600, margin: 0 }}>
                ✓ {lang === 'es' ? 'Todas asignadas' : 'All rooms assigned'}
              </p>
            )}
            {unassignedRooms.map(room => (
              <button
                key={room.id}
                onPointerDown={e => onPillPointerDown(e, room)}
                onPointerMove={onPillPointerMove}
                onPointerUp={e => { onPillPointerUp(e); }}
                onPointerCancel={onPillPointerCancel}
                className="sched-room-pill"
                style={{
                  width: '42px', height: '48px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: '1px',
                  borderRadius: '8px', background: '#eae8e3',
                  border: 'none', cursor: 'grab',
                  opacity: dragState?.roomId === room.id ? 0.3 : 1,
                  touchAction: 'none', userSelect: 'none',
                  WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '14px', color: '#364262', lineHeight: 1 }}>{room.number}</span>
                <span style={{ fontSize: '9px', fontWeight: 700, color: room.type === 'checkout' ? '#93000a' : '#757684', lineHeight: 1, textTransform: 'uppercase' }}>
                  {room.type === 'checkout'
                    ? 'C'
                    : (typeof room.stayoverDay === 'number' && room.stayoverDay > 0
                        ? (room.stayoverDay % 2 === 1 ? 'S1' : 'S2')
                        : 'S')}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Active Crew ── */}
      {!predictionLoading && totalRooms > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: '#364262', margin: 0 }}>
            {lang === 'es' ? 'Equipo Activo' : 'Active Crew'}
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {selectedCrew.map((member, idx) => {
              const { rooms: memberRooms, mins } = getStaffWorkload(member.id);
              const hrs = Math.floor(mins / 60);
              const remMins = mins % 60;
              const timeLabel = hrs > 0 ? `${hrs}h ${remMins > 0 ? `${remMins}m` : ''}`.trim() : `${mins}m`;
              const isDropHover = dragState?.dropTarget === member.id && dragState?.roomId && assignments[dragState.roomId] !== member.id;
              const coCount = memberRooms.filter(r => r.type === 'checkout').length;
              const soCount = memberRooms.length - coCount;
              const isNearCapacity = mins > shiftLen * 0.85;
              const statusLabel = memberRooms.length === 0
                ? (lang === 'es' ? 'Disponible' : 'Available')
                : isNearCapacity
                  ? (lang === 'es' ? 'Casi lleno' : 'Near Capacity')
                  : (lang === 'es' ? 'Asignado' : 'Assigned');
              const statusBg = memberRooms.length === 0 ? '#d3e4f8' : isNearCapacity ? '#ffdad6' : '#eae8e3';
              const statusColor = memberRooms.length === 0 ? '#0c1d2b' : isNearCapacity ? '#93000a' : '#454652';

              // The badge next to each crew member's name is simple now:
              //   - sent         → "Link Sent" (green)
              //   - skipped      → "Didn't Send — No Phone Number" (red)
              //   - failed       → "Didn't Send — <reason>"         (red)
              // On page reload, a confirmation doc being present is enough
              // to show "Link Sent" even if we don't have a fresh sendResult.
              const confStatus = statusByStaff.get(member.id);
              const sendResult = sendResults.get(member.id);

              const reasonLabel = (reason?: string): string => {
                switch (reason) {
                  case 'no_phone':      return lang === 'es' ? 'Sin teléfono'        : 'No Phone Number';
                  case 'invalid_phone': return lang === 'es' ? 'Teléfono inválido'   : 'Invalid Phone';
                  case 'sms_error':     return lang === 'es' ? 'Error de SMS'        : 'SMS Error';
                  default:              return reason || (lang === 'es' ? 'Error' : 'Error');
                }
              };

              const confBadge =
                (sendResult?.status === 'skipped' || sendResult?.status === 'failed')
                  ? { label: (lang === 'es' ? 'No se envió — ' : "Didn't Send — ") + reasonLabel(sendResult.reason),
                      bg: 'rgba(239,68,68,0.12)', color: '#b91c1c' }
                : (sendResult?.status === 'sent' || confStatus === 'sent' || confStatus === 'pending')
                  ? { label: lang === 'es' ? 'Enlace enviado' : 'Link Sent',
                      bg: 'rgba(16,185,129,0.15)', color: '#059669' }
                : null;

              return (
                <div
                  key={member.id}
                  ref={el => { crewCardRefs.current[member.id] = el; }}
                  data-crew-id={member.id}
                  className="sched-crew-row"
                  style={{
                    background: isDropHover ? 'rgba(54,66,98,0.04)' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(24px)',
                    border: isDropHover ? '2px solid #364262' : '1px solid rgba(197,197,212,0.2)',
                    borderRadius: '16px',
                    padding: '24px',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: '24px', transition: 'all 0.15s',
                    flexWrap: 'wrap',
                  }}
                >
                  {/* Left: avatar + info */}
                  <div className="sched-crew-info" style={{ display: 'flex', alignItems: 'center', gap: '24px', flexShrink: 0 }}>
                    <div style={{ position: 'relative' }}>
                      <div style={{
                        width: '64px', height: '64px', borderRadius: '50%',
                        background: 'linear-gradient(135deg, #364262 0%, #4e5a7a 100%)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#dae2ff', fontWeight: 700, fontSize: '20px',
                        fontFamily: 'var(--font-sans)',
                      }}>
                        {member.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <div style={{
                        position: 'absolute', bottom: 0, right: 0,
                        width: '16px', height: '16px', borderRadius: '50%',
                        background: memberRooms.length === 0 ? '#22c55e' : isNearCapacity ? '#ef4444' : '#f59e0b',
                        border: '4px solid #fff',
                      }} />
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                        <button
                          className="sched-crew-name"
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setSwapAnchor({ top: rect.bottom + 4, left: rect.left });
                            setSwapOpenFor(prev => prev === member.id ? null : member.id);
                          }}
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                            fontFamily: 'var(--font-sans)', fontSize: '20px', fontWeight: 700,
                            color: '#1b1c19', textAlign: 'left',
                          }}
                        >
                          {member.name}
                        </button>
                        {/* HK link + copy — fallback channel if SMS ever breaks.
                            `hkUrl` points to /housekeeper/{staffId}?uid=…&pid=…,
                            identical to what the SMS sends. uid/pid are required
                            for the Need Help / Report Issue buttons on the HK page. */}
                        {(() => {
                          const qs = `?uid=${encodeURIComponent(uid)}&pid=${encodeURIComponent(pid)}`;
                          const hkUrl = typeof window !== 'undefined'
                            ? `${window.location.origin}/housekeeper/${member.id}${qs}`
                            : `/housekeeper/${member.id}${qs}`;
                          const isCopied = copiedFor === member.id;
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <a
                                href={hkUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={lang === 'es' ? 'Abrir página del limpiador' : "Open housekeeper's page"}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                                  padding: '4px 10px', borderRadius: '9999px',
                                  background: 'rgba(54,66,98,0.08)', color: '#364262',
                                  fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 600,
                                  textDecoration: 'none', cursor: 'pointer',
                                  border: '1px solid rgba(54,66,98,0.15)',
                                }}
                              >
                                <Link2 size={12} />
                                {lang === 'es' ? 'Enlace' : 'Link'}
                              </a>
                              <button
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(hkUrl);
                                  } catch {
                                    // Fallback for older browsers / non-HTTPS
                                    const ta = document.createElement('textarea');
                                    ta.value = hkUrl;
                                    document.body.appendChild(ta);
                                    ta.select();
                                    try { document.execCommand('copy'); } catch {}
                                    document.body.removeChild(ta);
                                  }
                                  if (copiedTimer.current) clearTimeout(copiedTimer.current);
                                  setCopiedFor(member.id);
                                  copiedTimer.current = setTimeout(() => setCopiedFor(null), 1500);
                                }}
                                title={lang === 'es' ? 'Copiar enlace' : 'Copy link'}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: '4px',
                                  padding: '4px 10px', borderRadius: '9999px',
                                  background: isCopied ? 'rgba(16,185,129,0.15)' : 'rgba(54,66,98,0.08)',
                                  color: isCopied ? '#059669' : '#364262',
                                  fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 600,
                                  cursor: 'pointer',
                                  border: `1px solid ${isCopied ? 'rgba(16,185,129,0.3)' : 'rgba(54,66,98,0.15)'}`,
                                }}
                              >
                                {isCopied ? <Check size={12} /> : <Copy size={12} />}
                                {isCopied
                                  ? (lang === 'es' ? '¡Copiado!' : 'Copied!')
                                  : (lang === 'es' ? 'Copiar' : 'Copy')}
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                        <span style={{
                          padding: '2px 8px', borderRadius: '9999px',
                          background: statusBg, color: statusColor,
                          fontSize: '12px', fontWeight: 600,
                        }}>
                          {statusLabel}
                        </span>
                        {confBadge && (
                          <span style={{
                            padding: '2px 8px', borderRadius: '9999px',
                            background: confBadge.bg, color: confBadge.color,
                            fontSize: '12px', fontWeight: 600,
                          }}>
                            {confBadge.label}
                          </span>
                        )}
                        <button onClick={() => {
                          const roomCount = Object.values(assignments).filter(sid => sid === member.id).length;
                          const msg = lang === 'es'
                            ? `¿Quitar a ${member.name} y desasignar sus ${roomCount} habitaciones?`
                            : `Remove ${member.name} and unassign their ${roomCount} room${roomCount !== 1 ? 's' : ''}?`;
                          if (confirm(msg)) toggleCrewMember(member.id);
                        }} style={{
                          background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                          fontSize: '11px', fontWeight: 600, color: '#ba1a1a', padding: '0',
                          opacity: 0.5,
                        }}>
                          {lang === 'es' ? 'Quitar' : 'Remove'}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Right: checkouts/stayovers + workload + room tiles */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '48px', flexWrap: 'wrap' }}>
                    {memberRooms.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0, textAlign: 'right' }}>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: '#364262', fontFamily: 'var(--font-sans)' }}>
                          {coCount} {lang === 'es' ? 'Salidas' : 'Checkout'}{coCount !== 1 && lang !== 'es' ? 's' : ''}
                        </span>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: '#757684', fontFamily: 'var(--font-sans)' }}>
                          {soCount} {lang === 'es' ? 'Continuaciones' : 'Stayover'}{soCount !== 1 && lang !== 'es' ? 's' : ''}
                        </span>
                      </div>
                    )}
                    <div className="sched-crew-stats" style={{ textAlign: 'right' }}>
                      <p style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700, color: '#454652', margin: '0 0 2px' }}>
                        {lang === 'es' ? 'Carga' : 'Workload'}
                      </p>
                      <p style={{
                        fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 500,
                        color: isNearCapacity ? '#ba1a1a' : '#364262', margin: 0,
                      }}>
                        {timeLabel}
                      </p>
                    </div>
                    <div className="sched-crew-pills" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignContent: 'flex-start' }}>
                      {memberRooms.map(room => (
                        <button
                          key={room.id}
                          onPointerDown={e => onPillPointerDown(e, room)}
                          onPointerMove={onPillPointerMove}
                          onPointerUp={e => { onPillPointerUp(e); }}
                          onPointerCancel={onPillPointerCancel}
                          className="sched-room-pill"
                          style={{
                            width: '42px', height: '48px',
                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                            gap: '1px',
                            borderRadius: '8px', background: '#eae8e3',
                            border: 'none', cursor: 'grab',
                            opacity: dragState?.roomId === room.id ? 0.3 : 1,
                            touchAction: 'none', userSelect: 'none',
                            WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                          }}
                        >
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '14px', color: '#364262', lineHeight: 1 }}>{room.number}</span>
                          <span style={{ fontSize: '9px', fontWeight: 700, color: room.type === 'checkout' ? '#93000a' : '#757684', lineHeight: 1, textTransform: 'uppercase' }}>
                            {room.type === 'checkout'
                              ? 'C'
                              : (typeof room.stayoverDay === 'number' && room.stayoverDay > 0
                                  ? (room.stayoverDay % 2 === 1 ? 'S1' : 'S2')
                                  : 'S')}
                          </span>
                        </button>
                      ))}
                      {/* Add room button */}
                      <button
                        onClick={(e) => { e.stopPropagation(); }}
                        style={{
                          width: '40px', height: '40px',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          borderRadius: '8px', border: '2px dashed rgba(197,197,212,0.5)',
                          background: 'transparent', color: '#757684', cursor: 'default',
                        }}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Add staff + Priority row + Send Confirmations centered on same line.
              Tighter gap (10px, uniform) on the left cluster so there's room
              for the Send Confirmations cluster to sit absolutely centered
              without colliding with Unassign All. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', position: 'relative', minHeight: '48px' }}>
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).length > 0 && (
              <button onClick={() => setShowAddStaff(true)} style={{
                padding: '10px 20px', background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
                display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '14px', fontWeight: 600, color: '#454652',
              }}>
                <Plus size={16} />
                {lang === 'es' ? 'Agregar personal' : 'Add Staff'}
              </button>
            )}
            <button onClick={() => setShowPrioritySettings(true)} style={{
              padding: '10px 20px', background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
              border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
              display: 'flex', alignItems: 'center', gap: '8px',
              fontSize: '14px', fontWeight: 600, color: '#454652',
            }}>
              <Settings size={16} />
              {lang === 'es' ? 'Prioridad' : 'Priority'}
            </button>

            {/* Auto Assign — tops up the crew from the eligible pool (priority
                order) if the current crew is under the recommended headcount,
                then distributes unassigned rooms least-loaded-first. Same
                logic that fires automatically when the CSV pulls. Only
                disabled if there's nothing to assign, or there's nobody in
                the eligible pool to pull from at all. */}
            {(() => {
              const canStaff = selectedCrew.length > 0 || eligiblePool.length > 0;
              const disabled = unassignedRooms.length === 0 || !canStaff;
              return (
                <button
                  onClick={handleAutoRecommend}
                  disabled={disabled}
                  title={
                    disabled
                      ? (unassignedRooms.length === 0
                          ? (lang === 'es' ? 'No hay habitaciones sin asignar' : 'No unassigned rooms')
                          : (lang === 'es' ? 'No hay personal elegible' : 'No eligible staff'))
                      : (lang === 'es'
                          ? 'Agrega personal si hace falta y reparte las habitaciones'
                          : 'Add staff if needed and distribute rooms across the crew')
                  }
                  style={{
                    padding: '10px 20px',
                    background: disabled ? 'rgba(229,231,235,0.6)' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(24px)',
                    border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-sans)',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '14px', fontWeight: 600,
                    color: disabled ? '#9ca3af' : '#454652',
                    opacity: disabled ? 0.7 : 1,
                  }}
                >
                  <Sparkles size={16} />
                  {lang === 'es' ? 'Asignación Automática' : 'Auto Assign'}
                  {unassignedRooms.length > 0 && (
                    <span style={{
                      padding: '1px 7px', borderRadius: '9999px',
                      background: '#364262', color: '#ffffff',
                      fontSize: '11px', fontWeight: 700,
                    }}>
                      {unassignedRooms.length}
                    </span>
                  )}
                </button>
              );
            })()}

            {/* Unassign All — clears every room assignment so the whole pool
                goes back to Unassigned. Useful when the distribution is off
                (one person overloaded, another idle) and Maria wants to reset
                and let Auto Assign rebuild from scratch. Confirms first since
                it wipes local state. */}
            {(() => {
              const assignedCount = Object.keys(assignments).length;
              const disabled = assignedCount === 0;
              return (
                <button
                  onClick={() => {
                    const msg = lang === 'es'
                      ? `¿Quitar la asignación de las ${assignedCount} habitaciones? Todas regresarán al grupo "Sin asignar".`
                      : `Unassign all ${assignedCount} room${assignedCount === 1 ? '' : 's'}? Every room will go back to the Unassigned pool.`;
                    if (!confirm(msg)) return;
                    setAssignments({});
                    // IMPORTANT: do NOT reset hasInitialAssign here. The
                    // initial-auto-assign effect keys off that flag, and if we
                    // flip it back to false, the next crew change (e.g. Maria
                    // clicking Add Staff) will silently re-run the full
                    // auto-assignment. Unassign All should leave the pool
                    // empty and stay empty until the user explicitly hits
                    // Auto Assign — nothing should redistribute on its own.
                    showMoveToast(lang === 'es' ? 'Todas las habitaciones sin asignar' : 'All rooms unassigned');
                  }}
                  disabled={disabled}
                  title={
                    disabled
                      ? (lang === 'es' ? 'No hay habitaciones asignadas' : 'No rooms to unassign')
                      : (lang === 'es' ? 'Desasigna todas las habitaciones' : 'Clear every room assignment')
                  }
                  style={{
                    padding: '10px 20px',
                    background: disabled ? 'rgba(229,231,235,0.6)' : 'rgba(255,255,255,0.7)',
                    backdropFilter: 'blur(24px)',
                    border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-sans)',
                    display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '14px', fontWeight: 600,
                    color: disabled ? '#9ca3af' : '#ba1a1a',
                    opacity: disabled ? 0.7 : 1,
                  }}
                >
                  <Ban size={16} />
                  {lang === 'es' ? 'Desasignar Todo' : 'Unassign All'}
                  {assignedCount > 0 && (
                    <span style={{
                      padding: '1px 7px', borderRadius: '9999px',
                      background: '#ba1a1a', color: '#ffffff',
                      fontSize: '11px', fontWeight: 700,
                    }}>
                      {assignedCount}
                    </span>
                  )}
                </button>
              );
            })()}

            {/* Send Links — absolutely centered on the same line.
                The left cluster uses a tight 10px gap so there's breathing
                room around this centered block. Before the first send:
                primary "Send Links" button. After: status pill +
                the SAME "Send Links" button so Maria can re-send
                assignments at any time without us calling it something
                different. "Send Updates" / "Send Confirmations" as concepts
                are gone — it's one action, and you can do it as many times
                as you want. Maria confirms availability in person at 3pm,
                so the SMS is just the link to their list. */}
            {!alreadySent && selectedCrew.length > 0 && (
              <button onClick={(e) => { e.stopPropagation(); handleSend(); }} disabled={sending} style={{
                position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                padding: '14px 24px', background: '#006565', color: '#82e2e1',
                borderRadius: '9999px', fontWeight: 600, fontSize: '14px',
                border: 'none', cursor: sending ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: '10px',
                boxShadow: '0 10px 30px -10px rgba(0,101,101,0.3)',
                opacity: sending ? 0.7 : 1,
                fontFamily: 'var(--font-sans)',
                overflow: 'hidden',
              }}>
                <Zap size={18} />
                {sending ? (lang === 'es' ? 'Enviando…' : 'Sending…') : (lang === 'es' ? 'Enviar Enlaces' : 'Send Links')}
              </button>
            )}
            {alreadySent && (
              <div style={{
                position: 'absolute', left: '50%', transform: 'translateX(-50%)',
                display: 'flex', alignItems: 'center', gap: '10px',
                whiteSpace: 'nowrap',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '10px 20px',
                  background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px)',
                  border: '1px solid rgba(197,197,212,0.3)', borderRadius: '9999px',
                  fontSize: '13px', fontWeight: 600, color: '#454652',
                }}>
                  <CheckCircle2 size={16} color="#10b981" />
                  <span style={{ color: '#10b981' }}>
                    {lang === 'es' ? 'Enlaces enviados' : 'Links sent'}
                  </span>
                </div>
                {selectedCrew.length > 0 && (
                  <button onClick={(e) => { e.stopPropagation(); handleSend(); }} disabled={sending} style={{
                    padding: '10px 16px', background: '#006565', color: '#82e2e1',
                    borderRadius: '9999px', fontWeight: 600, fontSize: '13px',
                    border: 'none', cursor: sending ? 'not-allowed' : 'pointer',
                    display: 'flex', alignItems: 'center', gap: '6px',
                    boxShadow: '0 8px 20px -10px rgba(0,101,101,0.3)',
                    opacity: sending ? 0.7 : 1,
                    fontFamily: 'var(--font-sans)',
                    whiteSpace: 'nowrap',
                  }}>
                    <Zap size={14} />
                    {sending
                      ? (lang === 'es' ? 'Enviando…' : 'Sending…')
                      : (lang === 'es' ? 'Enviar Enlaces' : 'Send Links')}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Move toast ── */}
      {moveToast && (
        <div style={{
          position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)', zIndex: 10000,
          background: '#364262', color: '#fff', padding: '12px 24px', borderRadius: '12px',
          fontSize: '14px', fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          animation: 'toastIn 0.2s ease-out', whiteSpace: 'nowrap',
        }}>
          {moveToast}
        </div>
      )}
      <style>{`@keyframes toastIn { from { transform: translateX(-50%) translateY(10px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }`}</style>

      {/* ── Swap dropdown ── */}
      {swapOpenFor && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9990 }} onClick={() => setSwapOpenFor(null)} />
          <div style={{
            position: 'fixed', top: swapAnchor.top, left: swapAnchor.left, zIndex: 9991,
            background: '#fff', border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)', padding: '4px', minWidth: '180px',
            backdropFilter: 'blur(24px)',
          }}>
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).map(s => (
              <button key={s.id} onClick={() => {
                const oldId = swapOpenFor!;
                setAssignments(a => {
                  const updated = { ...a };
                  for (const [roomId, staffId] of Object.entries(updated)) {
                    if (staffId === oldId) updated[roomId] = s.id;
                  }
                  return updated;
                });
                setCrewOverride(prev => {
                  const current = prev.length > 0 ? prev : selectedCrew.map(c => c.id);
                  return current.map(id => id === oldId ? s.id : id);
                });
                const oldName = selectedCrew.find(c => c.id === oldId)?.name ?? '?';
                showMoveToast(lang === 'es' ? `${oldName} reemplazado por ${s.name}` : `Replaced ${oldName} with ${s.name}`);
                setSwapOpenFor(null);
              }} style={{
                display: 'block', width: '100%', padding: '10px 14px', border: 'none', borderRadius: '8px',
                background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                fontSize: '14px', fontWeight: 600, color: '#1b1c19', textAlign: 'left',
              }}
                onMouseEnter={e => { (e.target as HTMLElement).style.background = '#f5f3ee'; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent'; }}
              >
                {s.name}
              </button>
            ))}
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).length === 0 && (
              <div style={{ padding: '10px 14px', fontSize: '13px', color: '#454652' }}>
                {lang === 'es' ? 'Sin personal disponible' : 'No available staff'}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Staff Priority Settings popup ── */}
      {showPrioritySettings && uid && pid && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => setShowPrioritySettings(false)} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: '#fff', borderRadius: '16px', padding: '24px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.2)', width: '380px', maxHeight: '80vh', overflowY: 'auto',
            animation: 'popIn 0.15s ease-out',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <p style={{ fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: 0 }}>
                {lang === 'es' ? 'Prioridad del Personal' : 'Staff Priority'}
              </p>
              <button onClick={() => setShowPrioritySettings(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: '#454652' }} aria-label="Close">✕</button>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', fontSize: '12px', color: '#454652' }}>
              <span style={{ padding: '4px 10px', background: '#d3e4f8', color: '#0c1d2b', borderRadius: '8px', fontWeight: 600 }}>{lang === 'es' ? 'Prioridad' : 'Priority'}</span>
              <span style={{ display: 'flex', alignItems: 'center' }}>{lang === 'es' ? '= primera selección' : '= picked first'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {staff.filter(s => s.isActive !== false && (s.department === 'housekeeping' || !s.department)).map(s => {
                const pri = s.schedulePriority ?? 'normal';
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', background: '#f5f3ee', borderRadius: '12px' }}>
                    <span style={{ flex: 1, fontSize: '14px', fontWeight: 600, color: '#1b1c19' }}>{s.name}</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {(['priority', 'normal', 'excluded'] as const).map(level => (
                        <button key={level} onClick={async () => {
                          await updateStaffMember(uid!, pid!, s.id, { schedulePriority: level } as Partial<StaffMember>);
                        }} style={{
                          padding: '4px 10px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                          fontFamily: 'var(--font-sans)', fontSize: '12px', fontWeight: 600,
                          background: pri === level
                            ? level === 'priority' ? '#d3e4f8' : level === 'normal' ? '#eae8e3' : '#ffdad6'
                            : 'transparent',
                          color: pri === level
                            ? level === 'priority' ? '#0c1d2b' : level === 'normal' ? '#454652' : '#93000a'
                            : '#757684',
                        }}>
                          {level === 'priority' ? (lang === 'es' ? 'Prior.' : 'Priority') : level === 'normal' ? 'Normal' : (lang === 'es' ? 'Excluir' : 'Exclude')}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: '12px', color: '#757684', margin: '16px 0 0', lineHeight: 1.5 }}>
              {lang === 'es'
                ? 'Prioridad = seleccionado automáticamente primero. Normal = respaldo. Excluir = nunca seleccionado automáticamente.'
                : 'Priority = auto-selected first. Normal = backup when needed. Exclude = never auto-selected.'}
            </p>
          </div>
          <style>{`@keyframes popIn { from { transform: translate(-50%, -50%) scale(0.9); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }`}</style>
        </>
      )}

      {/* ── Add Staff popup ── */}
      {showAddStaff && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => setShowAddStaff(false)} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: '#fff', borderRadius: '16px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '24px', width: '520px', maxWidth: 'calc(100vw - 40px)', maxHeight: '70vh', overflowY: 'auto',
            animation: 'popIn 0.15s ease-out',
          }}>
            <p style={{ fontSize: '18px', fontWeight: 700, color: '#1b1c19', margin: '0 0 16px' }}>
              {lang === 'es' ? 'Agregar Personal' : 'Add Staff'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
              {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).map(member => (
                <button key={member.id} onClick={() => { toggleCrewMember(member.id); setShowAddStaff(false); }} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
                  padding: '16px 8px', background: '#f5f3ee', border: '1px solid rgba(197,197,212,0.2)',
                  borderRadius: '16px', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                }}>
                  <div style={{
                    width: '48px', height: '48px', borderRadius: '50%',
                    background: 'linear-gradient(135deg, #364262 0%, #4e5a7a 100%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#dae2ff', fontWeight: 700, fontSize: '16px',
                  }}>
                    {member.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: '#1b1c19', textAlign: 'center', lineHeight: 1.2 }}>
                    {member.name}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <style>{`@keyframes popIn { from { transform: translate(-50%, -50%) scale(0.9); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }`}</style>
        </>
      )}

      {/* Prediction Settings Modal */}
      {showPredictionSettings && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }} onClick={() => setShowPredictionSettings(false)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: '16px', padding: '28px', width: '100%', maxWidth: '400px', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div>
              <p style={{ fontWeight: 700, fontSize: '18px', color: '#1b1c19', margin: 0 }}>
                {lang === 'es' ? 'Ajustes de Predicción' : 'Prediction Settings'}
              </p>
              <p style={{ fontSize: '13px', color: '#757684', margin: '6px 0 0' }}>
                {lang === 'es' ? 'Ajusta los tiempos de limpieza.' : 'Adjust cleaning times.'}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* Max hours per housekeeper — shown in hours for readability,
                  stored as minutes on the property doc (shiftMinutes). This
                  is the cap Auto Assign respects when deciding whether it
                  needs to pull in more crew. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: '14px', fontWeight: 500, color: '#1b1c19' }}>
                    {lang === 'es' ? 'Horas máx. por limpiador' : 'Max hours per housekeeper'}
                  </span>
                  <span style={{ fontSize: '11px', color: '#9a9baa', marginTop: '2px' }}>
                    {lang === 'es' ? 'Tope diario por persona' : 'Daily cap per person'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={24}
                    step={0.25}
                    value={(settingsForm.shiftMinutes / 60).toString()}
                    onChange={e => {
                      const hrs = Number(e.target.value);
                      if (isNaN(hrs) || hrs <= 0) return;
                      setSettingsForm(p => ({ ...p, shiftMinutes: Math.round(hrs * 60) }));
                    }}
                    style={{ width: '64px', textAlign: 'center', padding: '8px 4px' }}
                  />
                  <span style={{ fontSize: '13px', color: '#757684' }}>hr</span>
                </div>
              </div>
              {[
                {
                  label: lang === 'es' ? 'Habitación de salida' : 'Checkout room',
                  sub: lang === 'es' ? 'Limpieza completa al salir' : 'Full clean at check-out',
                  key: 'checkoutMinutes' as const,
                },
                {
                  label: lang === 'es' ? 'Continuación — Día 1' : 'Stayover — Day 1',
                  sub: lang === 'es' ? 'Limpieza ligera (sin cambio de sábanas)' : 'Light clean (no bed change)',
                  key: 'stayoverDay1Minutes' as const,
                },
                {
                  label: lang === 'es' ? 'Continuación — Día 2' : 'Stayover — Day 2',
                  sub: lang === 'es' ? 'Limpieza completa (cambio de sábanas)' : 'Full clean (bed change)',
                  key: 'stayoverDay2Minutes' as const,
                },
                {
                  label: lang === 'es' ? 'Entre habitaciones' : 'Between rooms',
                  sub: lang === 'es' ? 'Tiempo de preparación por hab.' : 'Prep/transition time',
                  key: 'prepMinutesPerActivity' as const,
                },
              ].map(({ label, sub, key }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: '#1b1c19' }}>{label}</span>
                    <span style={{ fontSize: '11px', color: '#9a9baa', marginTop: '2px' }}>{sub}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <input className="input" type="number" min={key === 'prepMinutesPerActivity' ? 0 : 1} value={settingsForm[key]} onChange={e => setSettingsForm(p => ({ ...p, [key]: Number(e.target.value) || 0 }))} style={{ width: '64px', textAlign: 'center', padding: '8px 4px' }} />
                    <span style={{ fontSize: '13px', color: '#757684' }}>min</span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button onClick={() => setShowPredictionSettings(false)} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: '1px solid rgba(197,197,212,0.2)', background: '#fff', color: '#454652', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>{t('cancel', lang)}</button>
              <button onClick={handleSaveSettings} disabled={savingSettings} style={{ flex: 1, padding: '12px', borderRadius: '12px', border: 'none', background: '#364262', color: '#fff', fontWeight: 600, fontSize: '14px', cursor: 'pointer', opacity: savingSettings ? 0.6 : 1 }}>{savingSettings ? t('saving', lang) : t('save', lang)}</button>
            </div>
            <button onClick={() => { setShowPredictionSettings(false); setShowPublicAreas(true); }} style={{
              width: '100%', padding: '16px', marginTop: '4px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: '#f5f3ee', border: '1px solid rgba(197,197,212,0.2)', borderRadius: '12px',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: '#1b1c19' }}>{lang === 'es' ? 'Áreas Comunes' : 'Public Areas'}</span>
              <span style={{ fontSize: '12px', color: '#757684' }}>{areasDueToday.length} {lang === 'es' ? 'para hoy' : 'due today'} · {publicAreaMinutes}m →</span>
            </button>
          </div>
        </div>
      )}

      <PublicAreasModal show={showPublicAreas} onClose={() => setShowPublicAreas(false)} />

      {/* Drag ghost — floating room pill that follows your finger */}
      {dragState && (
        <div style={{
          position: 'fixed',
          left: dragState.ghost.x - 28,
          top: dragState.ghost.y - 40,
          zIndex: 10000,
          pointerEvents: 'none',
          padding: '8px 14px',
          background: '#364262',
          border: '2px solid rgba(255,255,255,0.5)',
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          transform: 'scale(1.15)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1,
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '14px', color: '#fff' }}>{dragState.roomNumber}</span>
          <span style={{ fontSize: '9px', fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>
            {dragState.roomType === 'checkout'
              ? 'C'
              : (typeof dragState.stayoverDay === 'number' && dragState.stayoverDay > 0
                  ? (dragState.stayoverDay % 2 === 1 ? 'S1' : 'S2')
                  : 'S')}
          </span>
        </div>
      )}

      {/* ── Glass Metrics Footer ── */}
      {!predictionLoading && totalRooms > 0 && (
        <footer style={{
          position: 'fixed', bottom: 0, left: 0, width: '100%', zIndex: 50,
          padding: '16px 24px',
        }}>
          <div style={{
            maxWidth: '768px', margin: '0 auto',
            background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(24px) saturate(200%)',
            border: '1px solid rgba(197,197,212,0.2)',
            borderRadius: '9999px', padding: '16px 40px',
            boxShadow: '0 20px 60px rgba(0,0,0,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-around',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <BedDouble size={18} color="#364262" />
              <span style={{ fontSize: '14px', fontWeight: 600, letterSpacing: '0.02em', color: '#454652' }}>{lang === 'es' ? 'Ocupación' : 'Occupancy'}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, color: '#364262' }}>
                {totalRooms > 0 ? Math.round((totalRooms / (activeProperty?.totalRooms ?? totalRooms)) * 100) : 0}%
              </span>
            </div>
            <div style={{ height: '24px', width: '1px', background: 'rgba(197,197,212,0.3)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <AlertTriangle size={18} color="#ba1a1a" />
              <span style={{ fontSize: '14px', fontWeight: 600, letterSpacing: '0.02em', color: '#454652' }}>{lang === 'es' ? 'Sin Asignar' : 'Unassigned'}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, color: unassignedRooms.length > 0 ? '#ba1a1a' : '#10b981' }}>
                {unassignedRooms.length}
              </span>
            </div>
            <div style={{ height: '24px', width: '1px', background: 'rgba(197,197,212,0.3)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Clock size={18} color="#006565" />
              <span style={{ fontSize: '14px', fontWeight: 600, letterSpacing: '0.02em', color: '#454652' }}>{lang === 'es' ? 'Est. Total' : 'Est. Labor'}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, color: '#364262' }}>
                {fmtMins(workloadMinutes)}
              </span>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ROOMS SECTION (live room status)
// ══════════════════════════════════════════════════════════════════════════════

function getFloor(roomNumber: string): string {
  const cleaned = roomNumber.replace(/\D/g, '');
  const num = parseInt(cleaned);
  if (isNaN(num)) return '?';
  if (num < 100) return 'G';
  return String(Math.floor(num / 100));
}

const ROOM_ACTION_COLOR: Record<RoomStatus, { bg: string; border: string; color: string }> = {
  dirty:       { bg: 'rgba(251,191,36,0.15)',  border: 'rgba(251,191,36,0.5)',  color: 'var(--amber)' },
  in_progress: { bg: 'rgba(34,197,94,0.15)',   border: 'rgba(34,197,94,0.5)',   color: 'var(--green)' },
  clean:       { bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.35)',  color: 'var(--red)' },
  inspected:   { bg: 'rgba(139,92,246,0.10)',  border: 'rgba(139,92,246,0.3)',  color: 'var(--purple, #7C3AED)' },
};

function RoomsSection() {
  const { user }                                           = useAuth();
  const { activePropertyId, activeProperty, staff }        = useProperty();
  const { lang }                                           = useLang();
  const { recordOfflineAction }                            = useSyncContext();

  const [rooms,   setRooms]   = useState<Room[]>([]);
  const [activeDate, setActiveDate] = useState<string>(todayStr());
  const [loading, setLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [actionRoom, setActionRoom] = useState<Room | null>(null); // room action popup
  const [nowMs, setNowMs] = useState(Date.now());
  const [populating, setPopulating] = useState(false);

  // Help request badge tracking — rooms where helpRequested is true
  const [backupRoom, setBackupRoom] = useState<Room | null>(null); // room needing backup staff picker

  // Manual "pull all rooms from last CSV" button handler — seeds rooms/{date}_{num}
  // with the CSV baseline so the grid shows all 74 rooms (not just assigned ones).
  const handlePopulateFromCsv = async () => {
    if (!user || !activePropertyId || populating) return;
    setPopulating(true);
    try {
      const res = await fetch('/api/populate-rooms-from-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid:  user.uid,
          pid:  activePropertyId,
          date: activeDate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setToastMessage(lang === 'es'
          ? `Error: ${data?.error ?? 'no se pudo cargar'}`
          : `Error: ${data?.error ?? 'could not load'}`);
      } else {
        const { created = 0, updated = 0 } = data;
        setToastMessage(lang === 'es'
          ? `Cargadas ${created + updated} habitaciones (${created} nuevas, ${updated} actualizadas)`
          : `Loaded ${created + updated} rooms (${created} new, ${updated} updated)`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setToastMessage(lang === 'es' ? `Error: ${msg}` : `Error: ${msg}`);
    } finally {
      setPopulating(false);
      setTimeout(() => setToastMessage(null), 3500);
    }
  };

  // Subscribe to ALL rooms in the property, then pick the active date to show.
  //
  // Two data sources write to this collection:
  //   1. The 15-min PMS scraper writes today's LIVE occupancy with today's date
  //      but WITHOUT assignedTo (it doesn't know who's cleaning what).
  //   2. `send-shift-confirmations` seeds the SHIFT date's rooms with
  //      assignedTo populated — that's Maria's active plan.
  //
  // We want the Rooms tab to track Maria's active PLAN, not scraper noise.
  // So prefer dates that have at least one assigned room (the "assigned
  // shift"), and use scraper-only dates as a last-resort fallback.
  //
  // Within assigned dates: today → nearest future → most recent past.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToAllRooms(user.uid, activePropertyId, (all) => {
      const today = todayStr();
      const byDate = new Map<string, Room[]>();
      for (const r of all) {
        if (!r.date) continue;
        const list = byDate.get(r.date) ?? [];
        list.push(r);
        byDate.set(r.date, list);
      }

      const pickFrom = (dates: string[]) => {
        if (dates.includes(today)) return today;
        const future = dates.filter(d => d > today).sort();
        if (future.length > 0) return future[0];
        const past = dates.filter(d => d < today).sort().reverse();
        if (past.length > 0) return past[0];
        return null;
      };

      // Prefer dates where Maria has actually assigned rooms — that's her
      // active plan. Scraper-only dates (no assignedTo) are fallback only.
      const assignedDates = [...byDate.entries()]
        .filter(([, list]) => list.some(r => r.assignedTo))
        .map(([date]) => date);

      let chosenDate = pickFrom(assignedDates);
      if (!chosenDate) {
        chosenDate = pickFrom([...byDate.keys()]) ?? today;
      }

      setActiveDate(chosenDate);
      setRooms(byDate.get(chosenDate) ?? []);
      setLoading(false);
    });
    return unsub;
  }, [user, activePropertyId]);

  // Live timer refresh every 15 seconds
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const floors = [...new Set(rooms.map(r => getFloor(r.number)))].sort((a, b) => {
    if (a === 'G') return -1; if (b === 'G') return 1;
    return parseInt(a) - parseInt(b);
  });

  const sorted = [...rooms].sort((a, b) => (parseInt(a.number.replace(/\D/g, '')) || 0) - (parseInt(b.number.replace(/\D/g, '')) || 0));

  const doneCount  = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const totalCount = rooms.length;
  const pct        = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const STATUS_INFO: Record<RoomStatus, { label: string; color: string; bgColor: string; borderColor: string }> = {
    dirty:       { label: t('dirty', lang),          color: 'var(--red)', bgColor: 'var(--red-dim)',   borderColor: 'var(--red-border, rgba(239,68,68,0.25))'   },
    in_progress: { label: t('cleaning', lang),       color: 'var(--amber)', bgColor: 'var(--amber-dim)',  borderColor: 'var(--amber-border)'  },
    clean:       { label: t('clean', lang) + ' ✓',  color: 'var(--green)', bgColor: 'var(--green-dim)',   borderColor: 'var(--green-border, rgba(34,197,94,0.25))'   },
    inspected:   { label: t('approved', lang),       color: 'var(--purple, #8B5CF6)', bgColor: 'rgba(139,92,246,0.08)',  borderColor: 'rgba(139,92,246,0.25)'  },
  };

  const ACTION_LABEL: Record<RoomStatus, string> = {
    dirty: t('start', lang), in_progress: t('done', lang) + ' ✓', clean: t('reset', lang), inspected: t('locked', lang),
  };

  const handleToggle = async (room: Room) => {
    if (!user || !activePropertyId || room.status === 'inspected') return;
    let newStatus: RoomStatus;
    if (room.status === 'dirty') newStatus = 'in_progress';
    else if (room.status === 'in_progress') newStatus = 'clean';
    else newStatus = 'dirty';
    const updates: Partial<Room> = { status: newStatus };
    if (newStatus === 'in_progress') updates.startedAt  = new Date();
    if (newStatus === 'clean')       updates.completedAt = new Date();
    if (!navigator.onLine) recordOfflineAction();
    await updateRoom(user.uid, activePropertyId, room.id, updates);
  };

  // Send backup handler — assign a backup person to a room
  const handleSendBackup = async (room: Room, backupStaffId: string, backupStaffName: string) => {
    if (!user || !activePropertyId) return;
    if (!navigator.onLine) recordOfflineAction();
    // Clear help request and assign backup
    await updateRoom(user.uid, activePropertyId, room.id, {
      helpRequested: false,
      issueNote: `Backup sent: ${backupStaffName} at ${new Date().toLocaleTimeString()}`,
    });
    // Send SMS directly to the backup person Mario picked — not the
    // scheduling manager, not a broadcast. Uses /api/notify-backup which is
    // the only path that texts a specific staff member by id.
    try {
      await fetch('/api/notify-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: user.uid, pid: activePropertyId,
          backupStaffId,
          roomNumber: room.number,
          language: 'en',
        }),
      });
    } catch (e) { /* SMS failure is non-blocking */ }
    setBackupRoom(null);
    setToastMessage(lang === 'es' ? `${backupStaffName} enviado a ${room.number}` : `${backupStaffName} sent to Room ${room.number}`);
    setTimeout(() => setToastMessage(null), 2500);
  };

  // Helper: get elapsed minutes for an in-progress room
  const getElapsedMins = (room: Room): number | null => {
    if (room.status !== 'in_progress') return null;
    const s = toDate(room.startedAt);
    if (!s) return null;
    return Math.round((nowMs - s.getTime()) / 60_000);
  };

  // Helper: check if room is over time
  const isOverTime = (room: Room): boolean => {
    const elapsed = getElapsedMins(room);
    if (elapsed === null) return false;
    let limit: number;
    if (room.type === 'checkout') {
      limit = activeProperty?.checkoutMinutes ?? 30;
    } else {
      const d = room.stayoverDay;
      const d1 = activeProperty?.stayoverDay1Minutes ?? 15;
      const d2 = activeProperty?.stayoverDay2Minutes ?? activeProperty?.stayoverMinutes ?? 20;
      if (typeof d === 'number' && d > 0) {
        limit = d % 2 === 1 ? d1 : d2;
      } else {
        limit = activeProperty?.stayoverMinutes ?? d2;
      }
    }
    return elapsed > limit;
  };

  // Compute metrics for the footer
  const dirtyCount = rooms.filter(r => r.status === 'dirty').length;
  const inProgressCount = rooms.filter(r => r.status === 'in_progress').length;
  const queueCount = dirtyCount + inProgressCount;

  // Status → glow class mapping
  const GLOW_CLASS: Record<RoomStatus, string> = {
    dirty: 'glow-dirty',
    in_progress: 'glow-cleaning',
    clean: 'glow-clean',
    inspected: 'glow-inspected',
  };

  // Status → text color class
  const STATUS_TEXT_CLASS: Record<RoomStatus, string> = {
    dirty: 'text-status-dirty',
    in_progress: 'text-status-cleaning',
    clean: 'text-status-clean',
    inspected: 'text-status-inspected',
  };

  // Room type icon (using unicode instead of Material Symbols for simplicity)
  const getRoomIcon = (room: Room): string | null => {
    if (room.isDnd) return '⊘';
    if (room.type === 'checkout') return '↗';
    if (room.type === 'stayover') return '🔒';
    return null;
  };

  return (
    <div style={{ padding: '24px', paddingBottom: '200px', background: 'var(--bg)', minHeight: 'calc(100vh - 180px)' }}>

      {/* Backup staff picker popup */}
      {backupRoom && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9997, background: 'rgba(0,0,0,0.4)' }} onClick={() => setBackupRoom(null)} />
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9998,
            background: '#fff', borderRadius: '16px 16px 0 0',
            boxShadow: '0 -4px 30px rgba(0,0,0,0.15)',
            padding: '20px 16px 32px', display: 'flex', flexDirection: 'column', gap: '12px',
            maxHeight: '60vh', overflowY: 'auto',
          }}>
            <div style={{ width: '40px', height: '4px', borderRadius: '2px', background: '#e2e8f0', margin: '0 auto 4px' }} />
            <p style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a', margin: 0 }}>
              {lang === 'es' ? `Enviar ayuda a ${backupRoom.number}` : `Send backup to Room ${backupRoom.number}`}
            </p>
            <p style={{ fontSize: '13px', color: '#64748b', margin: 0 }}>
              {lang === 'es' ? 'Selecciona quién enviar:' : 'Select who to send:'}
            </p>
            {staff.filter(s => s.isActive !== false && s.id !== backupRoom.assignedTo).map(s => (
              <button key={s.id} onClick={() => handleSendBackup(backupRoom, s.id, s.name)} style={{
                display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px',
                background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px',
                cursor: 'pointer', fontFamily: 'var(--font-sans)', width: '100%',
              }}>
                <div style={{
                  width: '36px', height: '36px', borderRadius: '10px',
                  background: '#0f172a', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: '13px', flexShrink: 0,
                }}>
                  {s.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#0f172a' }}>{s.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* Toast notification */}
      {toastMessage && (
        <div style={{
          position: 'fixed', bottom: '100px', right: '20px',
          background: '#10b981', color: '#fff',
          padding: '12px 16px', borderRadius: '12px',
          fontSize: '14px', fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 1000,
        }}>
          {toastMessage}
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <div className="spinner" style={{ width: '28px', height: '28px', margin: '0 auto 12px' }} />
          <p style={{ color: '#64748b', fontSize: '14px', margin: 0 }}>{t('loading', lang)}</p>
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '52px 20px', background: 'rgba(255,255,255,0.7)', borderRadius: '12px', backdropFilter: 'blur(8px)' }}>
          <p style={{ fontSize: '32px', marginBottom: '12px' }}>🛏️</p>
          <p style={{ color: '#64748b', fontSize: '15px', fontWeight: 500, marginBottom: '20px' }}>{rooms.length === 0 ? t('noRoomsTodayHkp', lang) : t('noRoomsFloor', lang)}</p>
          <button
            onClick={handlePopulateFromCsv}
            disabled={populating}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '8px',
              padding: '10px 18px',
              background: populating ? 'rgba(16,185,129,0.4)' : '#10b981',
              color: '#fff', border: 'none', borderRadius: '10px',
              fontSize: '13px', fontWeight: 700, letterSpacing: '0.03em',
              cursor: populating ? 'wait' : 'pointer',
              boxShadow: '0 2px 8px rgba(16,185,129,0.3)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <RefreshCw size={14} style={{ animation: populating ? 'spin 1s linear infinite' : undefined }} />
            {populating
              ? (lang === 'es' ? 'Cargando…' : 'Loading…')
              : (lang === 'es' ? 'Cargar desde CSV' : 'Load Rooms from CSV')}
          </button>
        </div>
      ) : (
        <>
          {/* ── Active Shift Date Banner ── */}
          {(() => {
            const today = todayStr();
            const isToday = activeDate === today;
            const isFuture = activeDate > today;
            const parsed = new Date(activeDate + 'T00:00:00');
            const dateLabel = format(parsed, 'EEEE, MMMM d');
            const prefix = isToday
              ? (lang === 'es' ? 'Turno de hoy' : "Today's shift")
              : isFuture
                ? (lang === 'es' ? 'Próximo turno' : 'Next shift')
                : (lang === 'es' ? 'Último turno' : 'Last shift');
            const bg = isToday ? 'rgba(16,185,129,0.08)' : isFuture ? 'rgba(59,130,246,0.08)' : 'rgba(148,163,184,0.12)';
            const border = isToday ? 'rgba(16,185,129,0.25)' : isFuture ? 'rgba(59,130,246,0.25)' : 'rgba(148,163,184,0.35)';
            const fg = isToday ? '#047857' : isFuture ? '#1d4ed8' : '#475569';
            return (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: '10px',
                padding: '8px 14px', marginBottom: '20px',
                background: bg, border: `1px solid ${border}`,
                borderRadius: '999px', color: fg,
                fontSize: '13px', fontWeight: 600,
              }}>
                <Calendar size={14} />
                <span style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: '11px', fontWeight: 700, opacity: 0.8 }}>{prefix}</span>
                <span style={{ opacity: 0.45 }}>·</span>
                <span>{dateLabel}</span>
              </div>
            );
          })()}

          {/* ── Status Legend ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '32px', marginBottom: '40px', padding: '0 4px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
              {[
                { label: lang === 'es' ? 'Sucia' : 'Dirty', color: '#ef4444' },
                { label: lang === 'es' ? 'Limpiando' : 'Cleaning', color: '#f59e0b' },
                { label: lang === 'es' ? 'Limpia' : 'Clean', color: '#10b981' },
                { label: lang === 'es' ? 'Inspeccionada' : 'Inspected', color: '#8b5cf6' },
              ].map(s => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{
                    width: '10px', height: '10px', borderRadius: '50%',
                    background: s.color, boxShadow: `0 0 8px ${s.color}80`,
                  }} />
                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    {s.label}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ height: '16px', width: '1px', background: 'rgba(148,163,184,0.3)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '20px', color: '#94a3b8' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '14px' }}>⊘</span>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>DND</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '14px' }}>🔒</span>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{lang === 'es' ? 'Ocupada' : 'Occupied'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '14px' }}>↗</span>
                <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{lang === 'es' ? 'Salida' : 'Checkout'}</span>
              </div>
            </div>

            {/* ── Populate from CSV button (right-aligned) ── */}
            <button
              onClick={handlePopulateFromCsv}
              disabled={populating}
              title={lang === 'es'
                ? 'Carga todas las habitaciones desde el último CSV. Preserva asignaciones.'
                : 'Loads every room from the last CSV pull. Preserves assignments.'}
              style={{
                marginLeft: 'auto',
                display: 'inline-flex', alignItems: 'center', gap: '8px',
                padding: '8px 14px',
                background: populating ? 'rgba(16,185,129,0.4)' : 'rgba(16,185,129,0.1)',
                color: '#047857',
                border: '1px solid rgba(16,185,129,0.35)',
                borderRadius: '999px',
                fontSize: '12px', fontWeight: 700,
                letterSpacing: '0.03em',
                cursor: populating ? 'wait' : 'pointer',
                fontFamily: 'var(--font-sans)',
                transition: 'all 0.15s ease',
              }}
            >
              <RefreshCw size={13} style={{ animation: populating ? 'spin 1s linear infinite' : undefined }} />
              {populating
                ? (lang === 'es' ? 'Cargando…' : 'Loading…')
                : (lang === 'es' ? 'Cargar desde CSV' : 'Load Rooms from CSV')}
            </button>
          </div>

          {/* ── Floor Grids ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '48px' }}>
            {floors.map((floor) => {
              const floorRooms = sorted.filter(r => getFloor(r.number) === floor);
              if (floorRooms.length === 0) return null;
              const floorLabel = floor === 'G' ? 'LOBBY' : `LEVEL ${floor.padStart(2, '0')}`;
              return (
                <section key={floor}>
                  {/* Floor header with gradient divider */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '16px', padding: '0 4px' }}>
                    <h2 style={{
                      fontSize: '10px', fontWeight: 900, textTransform: 'uppercase',
                      letterSpacing: '0.3em', color: '#94a3b8', margin: 0,
                      fontFamily: 'var(--font-sans)',
                    }}>
                      {floorLabel}
                    </h2>
                    <div style={{ flex: 1, height: '1px', background: 'linear-gradient(to right, #e2e8f0, #e2e8f0 50%, transparent)' }} />
                  </div>

                  {/* Room tiles grid */}
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                    gap: '12px',
                  }}>
                    {floorRooms.map(room => {
                      const hasHelp = room.helpRequested === true;
                      const elapsed = getElapsedMins(room);
                      const overTime = isOverTime(room);
                      const icon = getRoomIcon(room);
                      const glowClass = hasHelp ? 'glow-help' : GLOW_CLASS[room.status];
                      const textClass = STATUS_TEXT_CLASS[room.status];

                      return (
                        <button
                          key={room.id}
                          className={`glass-tile ${glowClass}`}
                          onClick={() => hasHelp ? setBackupRoom(room) : handleToggle(room)}
                          disabled={room.status === 'inspected' && !hasHelp}
                          title={`Room ${room.number} · ${room.type ?? ''} · ${STATUS_INFO[room.status].label}`}
                          style={{
                            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                            padding: '14px', borderRadius: '8px',
                            border: '1px solid rgba(255,255,255,0.4)',
                            cursor: room.status === 'inspected' && !hasHelp ? 'default' : 'pointer',
                            fontFamily: 'var(--font-sans)',
                            position: 'relative',
                            minHeight: '56px',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <span className={textClass} style={{
                              fontFamily: 'var(--font-mono)', fontSize: '18px', fontWeight: 700, lineHeight: 1,
                            }}>
                              {room.number}
                            </span>
                            {icon && (
                              <span style={{
                                fontSize: '13px', lineHeight: 1,
                                color: room.isDnd ? 'rgba(239,68,68,0.7)' : 'rgba(148,163,184,0.6)',
                              }}>
                                {icon}
                              </span>
                            )}
                          </div>

                          {/* Timer for in-progress rooms */}
                          {elapsed !== null && (
                            <span style={{
                              fontSize: '10px', fontWeight: 700, fontFamily: 'var(--font-mono)',
                              color: overTime ? '#ef4444' : '#94a3b8',
                              marginTop: '4px', lineHeight: 1,
                            }}>
                              {elapsed}m{overTime ? ' ⚠' : ''}
                            </span>
                          )}

                          {/* SOS badge */}
                          {hasHelp && (
                            <div style={{
                              position: 'absolute', bottom: '4px', left: '50%', transform: 'translateX(-50%)',
                              fontSize: '9px', fontWeight: 900, color: '#fff',
                              background: '#dc2626', borderRadius: '4px', padding: '1px 6px',
                              letterSpacing: '0.05em',
                              boxShadow: '0 0 8px rgba(220, 38, 38, 0.6)',
                            }}>
                              SOS
                            </div>
                          )}

                          {/* Assigned staff name */}
                          {room.assignedName && !hasHelp && (
                            <div style={{
                              fontSize: '9px', fontWeight: 600, color: '#94a3b8',
                              marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {room.assignedName.split(' ')[0]}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          {/* ── AI Intelligence Recommendation Card ── */}
          {dirtyCount > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginTop: '48px', padding: '24px 28px',
              background: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(8px)',
              border: '1px solid rgba(16,185,129,0.2)', borderRadius: '16px',
              flexWrap: 'wrap', gap: '16px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{
                  width: '48px', height: '48px', borderRadius: '16px',
                  background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, boxShadow: '0 0 20px rgba(16,185,129,0.4)',
                }}>
                  <Zap size={24} color="#10b981" />
                </div>
                <div>
                  <h3 style={{ fontSize: '10px', fontWeight: 900, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: '4px' }}>
                    {lang === 'es' ? 'Recomendación Inteligente' : 'Intelligence Recommendation'}
                  </h3>
                  <p style={{ fontSize: '14px', color: '#334155', margin: 0 }}>
                    {dirtyCount} {lang === 'es' ? 'habitaciones pendientes' : 'rooms in queue'}.{' '}
                    <span style={{ color: '#059669', fontWeight: 700 }}>{pct}%</span>{' '}
                    {lang === 'es' ? 'completado hoy' : 'completed today'}.
                    {inProgressCount > 0 && (
                      <> {inProgressCount} {lang === 'es' ? 'en progreso ahora' : 'in progress now'}.</>
                    )}
                  </p>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Glass Metrics Footer ── */}
      {!loading && sorted.length > 0 && (
        <footer className="glass-footer" style={{
          position: 'fixed', bottom: 0, left: 0, width: '100%', zIndex: 50,
          borderTop: '1px solid rgba(226,232,240,0.5)',
          padding: '20px 40px',
        }}>
          <div style={{ maxWidth: '1800px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '64px' }}>
              {/* Occupancy */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '9px', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: '#94a3b8', marginBottom: '4px' }}>
                  {lang === 'es' ? 'Progreso' : 'Progress'}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '30px', fontWeight: 900, color: '#0f172a', lineHeight: 1 }}>
                  {pct}<span style={{ fontSize: '14px', fontWeight: 500, color: '#94a3b8' }}>%</span>
                </span>
              </div>
              {/* Queue */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '9px', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: '#94a3b8', marginBottom: '4px' }}>
                  {lang === 'es' ? 'En Cola' : 'Queue Status'}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '30px', fontWeight: 900, color: queueCount > 0 ? '#ef4444' : '#10b981', lineHeight: 1 }}>
                  {queueCount}<span style={{ fontSize: '14px', fontWeight: 500, color: '#94a3b8' }}> {lang === 'es' ? 'hab.' : 'rooms'}</span>
                </span>
              </div>
              {/* Total */}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '9px', fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.2em', color: '#94a3b8', marginBottom: '4px' }}>
                  {lang === 'es' ? 'Total' : 'Total Rooms'}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '30px', fontWeight: 900, color: '#0f172a', lineHeight: 1 }}>
                  {totalCount}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <span style={{
                padding: '12px 28px', borderRadius: '12px', fontSize: '12px', fontWeight: 700,
                border: '1px solid #e2e8f0', background: 'rgba(255,255,255,0.5)', color: '#475569',
                fontFamily: 'var(--font-sans)',
              }}>
                {doneCount}/{totalCount} {lang === 'es' ? 'Completadas' : 'Complete'}
              </span>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// STAFF SECTION
// ══════════════════════════════════════════════════════════════════════════════

function StaffSection() {
  const { user } = useAuth();
  const { activePropertyId, staff } = useProperty();
  const { lang } = useLang();

  const [showModal, setShowModal] = useState(false);
  const [editMember, setEditMember] = useState<StaffMember | null>(null);
  const [form, setForm] = useState<StaffFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const openAdd = () => { setEditMember(null); setForm(EMPTY_FORM); setShowModal(true); };
  const openEdit = (member: StaffMember) => {
    setEditMember(member);
    setForm({ name: member.name, phone: member.phone, language: member.language, isSenior: member.isSenior, hourlyWage: member.hourlyWage, maxWeeklyHours: member.maxWeeklyHours, maxDaysPerWeek: member.maxDaysPerWeek ?? 5, vacationDates: (member.vacationDates ?? []).join('\n'), isActive: member.isActive ?? true });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!user || !activePropertyId || !form.name.trim()) return;
    setSaving(true);
    try {
      const vacationDates = form.vacationDates.split('\n').map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
      const data = { name: form.name.trim(), ...(form.phone && { phone: form.phone }), language: form.language, isSenior: form.isSenior, ...(form.hourlyWage !== undefined && { hourlyWage: form.hourlyWage }), maxWeeklyHours: form.maxWeeklyHours, maxDaysPerWeek: form.maxDaysPerWeek, vacationDates, isActive: form.isActive };
      if (editMember) {
        await updateStaffMember(user.uid, activePropertyId, editMember.id, data);
      } else {
        await addStaffMember(user.uid, activePropertyId, { ...data, scheduledToday: false, weeklyHours: 0 });
      }
      setShowModal(false);
    } finally { setSaving(false); }
  };

  const handleDelete = async (member: StaffMember) => {
    if (window.confirm(lang === 'es' ? `¿Eliminar a ${member.name}?` : `Delete ${member.name}?`)) {
      if (!user || !activePropertyId) return;
      try {
        await deleteStaffMember(user.uid, activePropertyId, member.id);
      } catch (err) {
        console.error('Error deleting staff member:', err);
        alert(lang === 'es' ? 'Error al eliminar personal' : 'Error deleting staff member');
      }
    }
  };

  const toggleScheduledToday = async (member: StaffMember) => {
    if (!user || !activePropertyId) return;
    await updateStaffMember(user.uid, activePropertyId, member.id, { scheduledToday: !member.scheduledToday });
  };

  const totalStaff      = staff.length;
  const scheduledToday  = staff.filter(s => s.scheduledToday).length;
  const nearOvertime    = staff.filter(s => s.weeklyHours >= s.maxWeeklyHours - 8).length;
  const hasOvertimeWarning = staff.some(s => s.weeklyHours >= s.maxWeeklyHours - 4);

  const sortedStaff = useMemo(() => [...staff].sort((a, b) => {
    if (a.scheduledToday !== b.scheduledToday) return a.scheduledToday ? -1 : 1;
    return a.name.localeCompare(b.name);
  }), [staff]);

  return (
    <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '10px', margin: 0 }}>
          <Users size={18} color="var(--navy)" />{t('staffRosterTitle', lang)}
        </h2>
        <button onClick={openAdd} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px', background: 'var(--navy-light)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>
          <Plus size={14} />{t('addStaff', lang)}
        </button>
      </div>

      {totalStaff > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '20px' }}>
          {[
            { label: t('totalStaffLabel', lang),      value: totalStaff,     color: 'var(--navy)' },
            { label: t('scheduledTodayCount', lang),  value: scheduledToday, color: 'var(--green)' },
            { label: t('nearOvertime', lang),          value: nearOvertime,   color: nearOvertime > 0 ? 'var(--amber)' : 'var(--text-muted)' },
          ].map(({ label, value, color }) => (
            <div key={label} className="card" style={{ padding: '14px 12px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '6px' }}>{label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 700, color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {hasOvertimeWarning && (
        <div className="animate-in" style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '14px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>
          <AlertTriangle size={16} color="var(--amber)" style={{ flexShrink: 0, marginTop: '2px' }} />
          <div>
            <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--amber)', margin: 0 }}>{t('overtimeAlert', lang)}</p>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>{t('overtimeAlertDesc', lang)}</p>
          </div>
        </div>
      )}

      {staff.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 16px' }}>
          <Users size={40} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', margin: 0 }}>{t('noStaffYet', lang)}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
          {sortedStaff.map((member, idx) => {
            const utilizationPct = Math.round((member.weeklyHours / member.maxWeeklyHours) * 100);
            const atOrOverMax = member.weeklyHours >= member.maxWeeklyHours;
            const nearMax = member.weeklyHours >= member.maxWeeklyHours - 4;
            return (
              <div key={member.id} className="animate-in" style={{ animationDelay: `${idx * 50}ms` }}>
                <div className="card" style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', height: '100%', borderColor: nearMax ? 'rgba(251,191,36,0.3)' : 'var(--border)', background: nearMax ? 'rgba(251,191,36,0.04)' : 'var(--bg-card)' }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ width: '38px', height: '38px', borderRadius: 'var(--radius-md)', background: 'var(--navy)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '14px', flexShrink: 0 }}>{staffInitials(member.name)}</div>
                    <div style={{ flex: 1 }}>
                      <p style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', margin: '0 0 4px' }}>{member.name}</p>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <span className="chip" style={{ fontSize: '10px', padding: '2px 7px', background: member.language === 'es' ? 'rgba(34,197,94,0.15)' : 'rgba(59,130,246,0.15)', color: member.language === 'es' ? 'var(--green)' : 'var(--blue)' }}>{member.language === 'es' ? 'ES' : 'EN'}</span>
                        {member.isSenior && <span className="chip" style={{ fontSize: '10px', padding: '2px 7px', background: 'rgba(251,191,36,0.15)', color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: '3px' }}><Star size={9} />Senior</span>}
                      </div>
                    </div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                      <span>{member.weeklyHours}h / {member.maxWeeklyHours}h</span>
                      <span style={{ color: atOrOverMax ? 'var(--red)' : nearMax ? 'var(--amber)' : 'var(--text-muted)' }}>{Math.max(0, member.maxWeeklyHours - member.weeklyHours)}{t('hoursLeftLabel', lang)}</span>
                    </div>
                    <div className="progress-track" style={{ height: '4px', background: 'rgba(0,0,0,0.05)', borderRadius: '2px', overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(utilizationPct, 100)}%`, height: '100%', background: utilizationPct > 100 ? 'var(--red)' : utilizationPct > 90 ? 'var(--amber)' : 'var(--green)', borderRadius: '2px' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', background: member.scheduledToday ? 'rgba(34,197,94,0.08)' : 'rgba(0,0,0,0.03)', border: '1px solid ' + (member.scheduledToday ? 'rgba(34,197,94,0.2)' : 'var(--border)'), borderRadius: 'var(--radius-md)', cursor: 'pointer' }} onClick={() => toggleScheduledToday(member)}>
                    <Clock size={14} color={member.scheduledToday ? 'var(--green)' : 'var(--text-muted)'} />
                    <span style={{ flex: 1, fontSize: '13px', fontWeight: 500, color: member.scheduledToday ? 'var(--green)' : 'var(--text-secondary)' }}>{member.scheduledToday ? t('scheduledTodayStatus', lang) : t('notScheduled', lang)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => openEdit(member)} style={{ flex: 1, padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontWeight: 500, fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontFamily: 'var(--font-sans)' }}>
                      <Pencil size={12} />{t('edit', lang)}
                    </button>
                    <button onClick={() => handleDelete(member)} aria-label={lang === 'es' ? `Eliminar a ${member.name}` : `Delete ${member.name}`} style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius-md)', color: 'var(--red)', fontWeight: 500, fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-sans)' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit Modal */}
      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editMember ? `${t('edit', lang)} ${editMember.name}` : t('addStaffMember', lang)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label className="label">{t('nameRequired', lang)}</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" placeholder="Maria Garcia" autoFocus />
          </div>
          <div>
            <label className="label">{t('phoneOptional', lang)}</label>
            <input type="tel" value={form.phone ?? ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="input" placeholder="(409) 555-1234" />
          </div>
          <div>
            <label className="label">{t('language', lang)}</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {(['en', 'es'] as const).map(l => (
                <button key={l} onClick={() => setForm(f => ({ ...f, language: l }))} style={{ flex: 1, padding: '10px', border: `1px solid ${form.language === l ? 'var(--amber)' : 'var(--border)'}`, background: form.language === l ? 'rgba(251,191,36,0.1)' : 'transparent', color: form.language === l ? 'var(--amber)' : 'var(--text-secondary)', borderRadius: 'var(--radius-md)', fontWeight: 500, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '13px' }}>
                  {l === 'en' ? 'English' : 'Español'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">{t('hourlyWageOptional', lang)}</label>
            <input type="number" value={form.hourlyWage ?? ''} onChange={e => setForm(f => ({ ...f, hourlyWage: e.target.value ? parseFloat(e.target.value) : undefined }))} className="input" placeholder="15.00" step="0.50" min="0" />
          </div>
          <div>
            <label className="label">{t('maxWeeklyHoursLabel', lang)}</label>
            <input type="number" value={form.maxWeeklyHours} onChange={e => setForm(f => ({ ...f, maxWeeklyHours: parseInt(e.target.value) || 40 }))} className="input" placeholder="40" min="1" />
          </div>
          <div>
            <label className="label">{t('maxDaysPerWeekLabel', lang)}</label>
            <input type="number" value={form.maxDaysPerWeek} onChange={e => setForm(f => ({ ...f, maxDaysPerWeek: parseInt(e.target.value) || 5 }))} className="input" placeholder="5" min="1" max="7" />
          </div>
          <div>
            <label className="label">{t('vacationDatesLabel', lang)}</label>
            <textarea value={form.vacationDates} onChange={e => setForm(f => ({ ...f, vacationDates: e.target.value }))} className="input" placeholder={'2026-03-28\n2026-03-29'} rows={3} style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '12px' }} />
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>{t('vacationDatesHelp', lang)}</p>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('isActiveLabel', lang)}</span>
            <label className="toggle" style={{ margin: 0 }}><input type="checkbox" checked={form.isActive} onChange={e => setForm(f => ({ ...f, isActive: e.target.checked }))} /><span className="toggle-track" /><span className="toggle-thumb" /></label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(0,0,0,0.03)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{t('seniorStaff', lang)}</span>
            <label className="toggle" style={{ margin: 0 }}><input type="checkbox" checked={form.isSenior} onChange={e => setForm(f => ({ ...f, isSenior: e.target.checked }))} /><span className="toggle-track" /><span className="toggle-thumb" /></label>
          </div>
          <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
            <button onClick={() => setShowModal(false)} style={{ flex: 1, padding: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 'var(--radius-md)', fontWeight: 500, fontSize: '13px', cursor: 'pointer', fontFamily: 'var(--font-sans)' }}>{t('cancel', lang)}</button>
            <button onClick={handleSave} disabled={saving || !form.name.trim()} style={{ flex: 1, padding: '10px', background: saving || !form.name.trim() ? 'rgba(37,99,235,0.4)' : 'var(--navy-light)', color: saving || !form.name.trim() ? 'rgba(255,255,255,0.5)' : '#fff', border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '13px', cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer', fontFamily: 'var(--font-sans)' }}>
              {saving ? t('savingDots', lang) : editMember ? t('update', lang) : t('addStaff', lang)}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC AREAS SECTION
// ══════════════════════════════════════════════════════════════════════════════

function paFloorLabel(value: string, lang: 'en' | 'es'): string {
  if (value === 'other') return lang === 'es' ? 'Otro' : 'Other';
  return `${t('floor', lang)} ${value}`;
}

const PA_FLOOR_VALUES = ['1', '2', '3', '4', 'other'] as const;

const SLIDER_MAX = 7;

function freqLabel(days: number, lang: 'en' | 'es' = 'en'): string {
  if (days === 1) return t('daily', lang);
  if (days === 7) return t('weekly', lang);
  return `${t('every', lang)} ${days} ${t('days', lang)}`;
}

function FrequencySlider({ value, onChange, lang }: { value: number; onChange: (v: number) => void; lang?: 'en' | 'es' }) {
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
const AREA_NAME_ES: Record<string, string> = {
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

function areaDisplayName(name: string, lang: 'en' | 'es'): string {
  if (lang === 'es' && AREA_NAME_ES[name]) return AREA_NAME_ES[name];
  return name;
}

function PublicAreasModal({ show, onClose }: { show: boolean; onClose: () => void }) {
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
        for (const a of fetched) await deletePublicArea(uid, pid, a.id);
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
                <input className="input" type="number" value={newArea.minutesPerClean} onChange={e => setNewArea(p => ({ ...p, minutesPerClean: Number(e.target.value) || 0 }))} />
              </div>
              <div>
                <label className="label">{t('locations', lang)}</label>
                <input className="input" type="number" value={newArea.locations} onChange={e => setNewArea(p => ({ ...p, locations: Number(e.target.value) || 1 }))} />
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
                  <input className="input" type="number" value={area.minutesPerClean} onChange={e => handleUpdate(area.id, { minutesPerClean: Number(e.target.value) || 0 })} />
                </div>
                <div>
                  <label className="label">{t('locations', lang)}</label>
                  <input className="input" type="number" value={area.locations} onChange={e => handleUpdate(area.id, { locations: Number(e.target.value) || 1 })} />
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

function DeepCleanSection() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty, staff } = useProperty();
  const { lang } = useLang();

  const [config, setConfigState] = useState<DeepCleanConfig | null>(null);
  const [records, setRecords] = useState<Record<string, DeepCleanRecord>>({});
  const [todayRooms, setTodayRooms] = useState<Room[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCycleModal, setShowCycleModal] = useState(false);
  const [customCycleDays, setCustomCycleDays] = useState('');
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [assignRoom, setAssignRoom] = useState<string | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<string[]>([]);
  const [completeRoom, setCompleteRoom] = useState<string | null>(null);
  const [collapsedFloors, setCollapsedFloors] = useState<Set<number>>(new Set());
  const [editRoom, setEditRoom] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editCleanedBy, setEditCleanedBy] = useState('');
  const [showAddRooms, setShowAddRooms] = useState(false);
  const [addRoomsFloor, setAddRoomsFloor] = useState<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';
  const totalRooms = activeProperty?.totalRooms ?? 74;
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon

  // All room numbers — Comfort Suites Beaumont layout
  const allRoomNumbers = useMemo(() => {
    const rooms: string[] = [];
    // Floor 1: 101-112, skips 107, 109, 111 (9 rooms)
    [101,102,103,104,105,106,108,110,112].forEach(n => rooms.push(String(n)));
    // Floor 2: 201-222, skip 213 (~21 rooms)
    for (let r = 201; r <= 222; r++) { if (r !== 213) rooms.push(String(r)); }
    // Floor 3: 300-322, skip 313 (~22 rooms)
    for (let r = 300; r <= 322; r++) { if (r !== 313) rooms.push(String(r)); }
    // Floor 4: 400-422, skip 413 (~22 rooms)
    for (let r = 400; r <= 422; r++) { if (r !== 413) rooms.push(String(r)); }
    return rooms;
  }, []);

  const getFloor = (num: string) => parseInt(num.charAt(0));

  // Load data
  useEffect(() => {
    if (!uid || !pid) return;
    getDeepCleanConfig(uid, pid).then(c => setConfigState(c)).catch(() => {});
    getDeepCleanRecords(uid, pid).then(r => {
      const map: Record<string, DeepCleanRecord> = {};
      for (const rec of r) map[rec.roomNumber] = rec;
      setRecords(map);
    }).catch(() => {});
    // Subscribe to today's rooms for occupancy data
    const unsub = subscribeToRooms(uid, pid, todayStr(), setTodayRooms);
    return unsub;
  }, [uid, pid]);

  useEffect(() => { return () => { if (toastTimer.current) clearTimeout(toastTimer.current); }; }, []);

  const showToast = (msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const freq = config?.frequencyDays ?? 90;

  // ─── Room status helpers ──────────────────────────────────────────────────
  type RoomInfo = { roomNumber: string; daysSince: number; lastCleaned: string | null; cleanedBy: string | null; team: string[]; status: 'overdue' | 'approaching' | 'ok' | 'never'; inProgress: boolean; };

  const allRoomInfo = useMemo((): RoomInfo[] => {
    return allRoomNumbers.map(num => {
      const rec = records[num];
      if (!rec || !rec.lastDeepClean) {
        return { roomNumber: num, daysSince: Infinity, lastCleaned: null, cleanedBy: null, team: rec?.cleanedByTeam ?? [], status: 'never' as const, inProgress: rec?.status === 'in_progress' };
      }
      const last = new Date(rec.lastDeepClean);
      const days = Math.floor((today.getTime() - last.getTime()) / 86_400_000);
      const daysLeft = freq - days;
      let status: 'overdue' | 'approaching' | 'ok' | 'never' = 'ok';
      if (days >= freq) status = 'overdue';
      else if (daysLeft <= 14) status = 'approaching';
      return {
        roomNumber: num, daysSince: days,
        lastCleaned: rec.lastDeepClean,
        cleanedBy: rec.cleanedByTeam?.join(', ') ?? rec.cleanedBy ?? null,
        team: rec.cleanedByTeam ?? [],
        status, inProgress: rec.status === 'in_progress',
      };
    });
  }, [allRoomNumbers, records, freq, today]);

  const overdueRooms = useMemo(() =>
    allRoomInfo.filter(r => r.status === 'overdue' || r.status === 'never')
      .sort((a, b) => (b.daysSince === Infinity ? 99999 : b.daysSince) - (a.daysSince === Infinity ? 99999 : a.daysSince)),
    [allRoomInfo]);

  const inProgressRooms = useMemo(() => allRoomInfo.filter(r => r.inProgress), [allRoomInfo]);

  const recentlyDone = useMemo(() =>
    allRoomInfo.filter(r => r.lastCleaned && r.daysSince <= 14 && !r.inProgress)
      .sort((a, b) => a.daysSince - b.daysSince).slice(0, 10),
    [allRoomInfo]);

  const totalOverdue = overdueRooms.length;
  const pct = allRoomNumbers.length > 0 ? Math.round(((allRoomNumbers.length - totalOverdue) / allRoomNumbers.length) * 100) : 0;

  // ─── Floor breakdown ──────────────────────────────────────────────────────
  const floorBreakdown = useMemo(() => {
    const floors: Record<number, number> = {};
    overdueRooms.forEach(r => {
      const f = getFloor(r.roomNumber);
      floors[f] = (floors[f] ?? 0) + 1;
    });
    return Object.entries(floors).sort(([a], [b]) => Number(a) - Number(b)).map(([f, c]) => ({ floor: Number(f), count: c }));
  }, [overdueRooms]);

  // ─── Today's Suggestion ───────────────────────────────────────────────────
  const dndCount = todayRooms.filter(r => r.isDnd).length;
  const checkoutCount = todayRooms.filter(r => r.type === 'checkout').length;
  const totalOccupied = todayRooms.length;
  const isLightDay = dayOfWeek === 1 || checkoutCount < 25 || dndCount >= 5; // Monday or light checkout or many DNDs

  // Find floors with lightest workload
  const floorLoad = useMemo(() => {
    const loads: Record<number, number> = {};
    todayRooms.forEach(r => {
      const f = getFloor(r.number);
      if (r.type === 'checkout') loads[f] = (loads[f] ?? 0) + 2;
      else if (r.type === 'stayover' && !r.isDnd) loads[f] = (loads[f] ?? 0) + 1;
    });
    return loads;
  }, [todayRooms]);

  const suggestedRooms = useMemo(() => {
    if (!isLightDay) return [];
    // Always pick the 5 most overdue rooms (longest overdue first), skip in-progress
    const sorted = [...overdueRooms]
      .filter(r => !r.inProgress)
      .sort((a, b) => (b.daysSince === Infinity ? 99999 : b.daysSince) - (a.daysSince === Infinity ? 99999 : a.daysSince));
    return sorted.slice(0, 5);
  }, [isLightDay, overdueRooms]);

  // Staff who finished their rooms today
  const availableStaff = useMemo(() => {
    const hkStaff = staff.filter(s => (!s.department || s.department === 'housekeeping') && s.isActive !== false);
    const assignedRooms = todayRooms.filter(r => r.assignedTo && (r.status === 'clean' || r.status === 'inspected'));
    const staffDoneIds = new Set<string>();
    hkStaff.forEach(s => {
      const myRooms = todayRooms.filter(r => r.assignedTo === s.id);
      if (myRooms.length > 0 && myRooms.every(r => r.status === 'clean' || r.status === 'inspected')) {
        staffDoneIds.add(s.id);
      }
    });
    return hkStaff.map(s => ({ ...s, doneForDay: staffDoneIds.has(s.id) }))
      .sort((a, b) => (a.doneForDay === b.doneForDay ? 0 : a.doneForDay ? -1 : 1));
  }, [staff, todayRooms]);

  // ─── Handlers ─────────────────────────────────────────────────────────────
  const handleAssignTeam = async (roomNumber: string) => {
    if (!uid || !pid || selectedTeam.length === 0) return;
    setSaving(true);
    try {
      const teamNames = selectedTeam.map(id => staff.find(s => s.id === id)?.name ?? id);
      await assignRoomDeepClean(uid, pid, roomNumber, teamNames);
      setRecords(prev => ({
        ...prev,
        [roomNumber]: { ...prev[roomNumber], id: roomNumber, roomNumber, lastDeepClean: prev[roomNumber]?.lastDeepClean ?? '', cleanedByTeam: teamNames, status: 'in_progress', assignedAt: todayStr() },
      }));
      setAssignRoom(null);
      setSelectedTeam([]);
      showToast(lang === 'es' ? `${roomNumber}: Equipo asignado` : `${roomNumber}: Team assigned`);
    } finally { setSaving(false); }
  };

  const handleComplete = async (roomNumber: string) => {
    if (!uid || !pid) return;
    setSaving(true);
    try {
      const rec = records[roomNumber];
      const team = rec?.cleanedByTeam ?? [user?.displayName ?? 'Manager'];
      await completeRoomDeepClean(uid, pid, roomNumber, team);
      setRecords(prev => ({
        ...prev,
        [roomNumber]: { ...prev[roomNumber], id: roomNumber, roomNumber, lastDeepClean: todayStr(), cleanedByTeam: team, cleanedBy: team.join(', '), status: 'completed', completedAt: todayStr() },
      }));
      setCompleteRoom(null);
      showToast(lang === 'es' ? `${roomNumber}: ¡Limpieza profunda completada!` : `${roomNumber}: Deep clean complete!`);
    } finally { setSaving(false); }
  };

  const handleAcceptSuggestion = () => {
    if (suggestedRooms.length > 0) {
      setAssignRoom(suggestedRooms[0].roomNumber);
    }
  };

  const handleSaveCycle = async (days: number) => {
    if (!uid || !pid) return;
    const newConfig = { ...(config ?? { frequencyDays: 90, minutesPerRoom: 60, targetPerWeek: 5 }), frequencyDays: days };
    await setDeepCleanConfig(uid, pid, newConfig);
    setConfigState(newConfig);
    setShowCycleModal(false);
    showToast(lang === 'es' ? `Ciclo actualizado: ${days} días` : `Cycle updated: ${days} days`);
  };

  const handleEditDate = async (roomNumber: string) => {
    if (!uid || !pid || !editDate) return;
    setSaving(true);
    try {
      const { setDeepCleanRecord } = await import('@/lib/firestore');
      const existing = records[roomNumber];
      await setDeepCleanRecord(uid, pid, {
        id: roomNumber, roomNumber,
        lastDeepClean: editDate,
        cleanedBy: editCleanedBy || existing?.cleanedBy,
        cleanedByTeam: editCleanedBy ? [editCleanedBy] : (existing?.cleanedByTeam ?? []),
        status: 'completed', completedAt: editDate,
      });
      setRecords(prev => ({
        ...prev,
        [roomNumber]: { ...prev[roomNumber], id: roomNumber, roomNumber, lastDeepClean: editDate, cleanedBy: editCleanedBy || existing?.cleanedBy, cleanedByTeam: editCleanedBy ? [editCleanedBy] : (existing?.cleanedByTeam ?? []), status: 'completed', completedAt: editDate },
      }));
      showToast(lang === 'es' ? `${roomNumber}: Actualizado` : `${roomNumber}: Updated`);
      setEditRoom(null);
      setEditDate('');
      setEditCleanedBy('');
    } finally { setSaving(false); }
  };

  const toggleFloor = (floor: number) => {
    setCollapsedFloors(prev => {
      const next = new Set(prev);
      if (next.has(floor)) next.delete(floor); else next.add(floor);
      return next;
    });
  };

  // Group overdue by floor
  const overdueByFloor = useMemo(() => {
    const floors = new Map<number, RoomInfo[]>();
    overdueRooms.forEach(r => {
      const f = getFloor(r.roomNumber);
      if (!floors.has(f)) floors.set(f, []);
      floors.get(f)!.push(r);
    });
    return [...floors.entries()].sort(([a], [b]) => a - b);
  }, [overdueRooms]);

  // Group ALL rooms by floor (for Add Rooms modal)
  const allRoomsByFloor = useMemo(() => {
    const floors = new Map<number, RoomInfo[]>();
    allRoomInfo.forEach(r => {
      const f = getFloor(r.roomNumber);
      if (!floors.has(f)) floors.set(f, []);
      floors.get(f)!.push(r);
    });
    return [...floors.entries()].sort(([a], [b]) => a - b);
  }, [allRoomInfo]);

  // Floor summary for the Add Rooms picker
  const floorSummary = useMemo(() => {
    return allRoomsByFloor.map(([floor, rooms]) => {
      const overdue = rooms.filter(r => r.status === 'overdue' || r.status === 'never').length;
      const approaching = rooms.filter(r => r.status === 'approaching').length;
      const ok = rooms.filter(r => r.status === 'ok' && !r.inProgress).length;
      const inProg = rooms.filter(r => r.inProgress).length;
      // Worst status description
      let desc = '';
      let descEs = '';
      let descColor = 'var(--text-muted)';
      if (overdue > 0) {
        desc = `${overdue} overdue`;
        descEs = `${overdue} pendientes`;
        descColor = 'var(--red)';
      } else if (approaching > 0) {
        desc = `${approaching} due soon`;
        descEs = `${approaching} por vencer`;
        descColor = 'var(--amber)';
      } else if (inProg > 0) {
        desc = `${inProg} in progress`;
        descEs = `${inProg} en progreso`;
        descColor = 'var(--amber)';
      } else {
        desc = 'All on track';
        descEs = 'Todo al día';
        descColor = 'var(--green)';
      }
      return { floor, total: rooms.length, overdue, approaching, ok, inProg, desc, descEs, descColor };
    });
  }, [allRoomsByFloor]);

  // Status description for individual room in the modal
  const roomStatusDesc = (r: RoomInfo): { text: string; textEs: string; color: string } => {
    if (r.inProgress) return { text: 'In progress', textEs: 'En progreso', color: 'var(--amber)' };
    if (r.status === 'never') return { text: 'Never cleaned', textEs: 'Nunca limpiado', color: 'var(--red)' };
    if (r.status === 'overdue') {
      const dOver = r.daysSince - freq;
      return { text: `${dOver}d overdue`, textEs: `${dOver}d atrasado`, color: 'var(--red)' };
    }
    if (r.status === 'approaching') {
      const dLeft = freq - r.daysSince;
      return { text: `Due in ${dLeft}d`, textEs: `Vence en ${dLeft}d`, color: 'var(--amber)' };
    }
    const dLeft = freq - r.daysSince;
    return { text: `Clean in ${dLeft}d`, textEs: `Limpio en ${dLeft}d`, color: 'var(--green)' };
  };

  // ─── Status badge color helper ────────────────────────────────────────────
  const statusColor = (r: RoomInfo) => {
    if (r.inProgress) return { bg: 'rgba(245,158,11,0.1)', color: 'var(--amber)' };
    if (r.status === 'never') return { bg: 'var(--red-dim, rgba(220,38,38,0.08))', color: 'var(--red)' };
    if (r.status === 'overdue') return { bg: 'var(--red-dim, rgba(220,38,38,0.08))', color: 'var(--red)' };
    if (r.status === 'approaching') return { bg: 'rgba(245,158,11,0.1)', color: 'var(--amber)' };
    return { bg: 'rgba(0,0,0,0.04)', color: 'var(--text-muted)' };
  };

  const statusLabel = (r: RoomInfo) => {
    if (r.inProgress) return lang === 'es' ? 'En progreso' : 'In Progress';
    if (r.status === 'never') return lang === 'es' ? 'Nunca limpiado' : 'Never cleaned';
    if (r.daysSince === Infinity) return lang === 'es' ? 'Nunca limpiado' : 'Never cleaned';
    if (r.status === 'overdue') return `${r.daysSince - freq}d ${lang === 'es' ? 'atrasado' : 'overdue'}`;
    return `${r.daysSince}d ${lang === 'es' ? 'atrás' : 'ago'}`;
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────
  // Computed stats for the Soft Minimal card
  const queuedCount = overdueRooms.filter(r => !r.inProgress).length;
  const activeCount = inProgressRooms.length;
  const completedCount = allRoomInfo.filter(r => r.status === 'ok' || (r.lastCleaned && r.daysSince <= 14 && !r.inProgress)).length;
  const estMinutesRemaining = (activeCount + queuedCount) * (config?.minutesPerRoom ?? 60);
  const estHours = Math.floor(estMinutesRemaining / 60);
  const estMins = estMinutesRemaining % 60;
  const hkStaffTotal = staff.filter(s => (!s.department || s.department === 'housekeeping') && s.isActive !== false).length;
  const hkStaffActive = availableStaff.filter(s => s.doneForDay).length;
  // AI suggestion text
  const aiSuggestionText = (() => {
    if (!isLightDay) return lang === 'es' ? `${checkoutCount} checkouts hoy. Limpieza profunda no recomendada.` : `${checkoutCount} checkouts today. Deep cleaning not recommended.`;
    if (floorBreakdown.length > 0) {
      const worstFloor = floorBreakdown.reduce((a, b) => b.count > a.count ? b : a);
      return lang === 'es'
        ? `Piso ${worstFloor.floor} necesita limpieza profunda prioritaria — ${worstFloor.count} habitaciones pendientes.`
        : `Floor ${worstFloor.floor} requires priority deep cleaning — ${worstFloor.count} rooms overdue.`;
    }
    return lang === 'es' ? 'Todas las habitaciones están al día.' : 'All rooms are on schedule.';
  })();

  return (
    <div style={{ padding: '24px 24px 120px', display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: '900px', margin: '0 auto', width: '100%' }}>

      {/* ── AI Suggestion Ribbon ── */}
      <div style={{ width: '100%', marginBottom: '40px' }}>
        <div style={{
          background: '#ffffff', borderRadius: '9999px', padding: '12px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          border: '1px solid rgba(78,90,122,0.08)', position: 'relative', overflow: 'hidden',
        }}>
          {/* Shimmer overlay */}
          <div style={{ position: 'absolute', top: '-50%', left: '-50%', width: '200%', height: '200%', background: 'linear-gradient(45deg, transparent 25%, rgba(0,101,101,0.03) 50%, transparent 75%)', pointerEvents: 'none' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', position: 'relative' }}>
            <Zap size={18} style={{ color: '#006565' }} fill="#006565" />
            <span style={{ fontSize: '14px', fontWeight: 500, color: '#454652' }}>
              {lang === 'es' ? 'Sugerencia IA: ' : 'AI Suggestion: '}{aiSuggestionText}
            </span>
          </div>
          {isLightDay && suggestedRooms.length > 0 && (
            <button
              onClick={handleAcceptSuggestion}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#006565', fontWeight: 600, fontSize: '14px', whiteSpace: 'nowrap', position: 'relative' }}
            >
              {lang === 'es' ? 'Aplicar' : 'Apply Now'}
            </button>
          )}
        </div>
      </div>

      {/* ── Central Action Card ── */}
      <div style={{ position: 'relative', width: '100%', paddingBottom: '75%', maxHeight: '600px', marginBottom: '40px' }}>
        <div style={{
          position: 'absolute', inset: 0, background: '#ffffff', borderRadius: '3rem',
          overflow: 'hidden', boxShadow: '0 25px 60px -12px rgba(54,66,98,0.08)',
          border: '1px solid rgba(197,197,212,0.15)',
        }}>
          {/* Progress fill background */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, width: '100%',
            background: 'rgba(211,228,248,0.25)',
            transition: 'height 1000ms cubic-bezier(0.4,0,0.2,1)',
            height: `${pct}%`,
          }} />
          {/* Atmospheric blur — top left */}
          <div style={{ position: 'absolute', top: '-80px', left: '-80px', width: '256px', height: '256px', background: 'rgba(147,242,242,0.08)', filter: 'blur(80px)', borderRadius: '50%' }} />
          {/* Atmospheric blur — bottom right */}
          <div style={{ position: 'absolute', bottom: '-80px', right: '-80px', width: '256px', height: '256px', background: 'rgba(218,226,255,0.08)', filter: 'blur(80px)', borderRadius: '50%' }} />

          {/* Content */}
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '48px', textAlign: 'center' }}>
            {/* Big percentage */}
            <div style={{ marginBottom: '32px' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 'clamp(48px, 8vw, 96px)', fontWeight: 500, color: '#364262', letterSpacing: '-0.05em', lineHeight: 1, marginBottom: '8px' }}>
                {pct}<span style={{ fontSize: 'clamp(24px, 3vw, 40px)', opacity: 0.35 }}>%</span>
              </div>
              <div style={{ color: '#454652', textTransform: 'uppercase', letterSpacing: '0.2em', fontSize: '11px', fontWeight: 700 }}>
                {lang === 'es' ? 'Progreso del Ciclo' : 'Current Cycle Progress'}
              </div>
            </div>

            {/* Add Rooms button */}
            <button
              onClick={() => { setShowAddRooms(true); setAddRoomsFloor(null); }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px',
                background: '#364262', color: '#fff', padding: 'clamp(32px, 4vw, 48px) clamp(48px, 6vw, 80px)',
                borderRadius: '2.5rem', border: 'none', cursor: 'pointer',
                transition: 'all 300ms cubic-bezier(0.4,0,0.2,1)',
                boxShadow: '0 12px 32px -4px rgba(54,66,98,0.2)',
                position: 'relative',
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.05)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; }}
            >
              <Plus size={40} strokeWidth={1.5} />
              <span style={{ fontSize: '20px', fontWeight: 600, letterSpacing: '-0.01em' }}>
                {lang === 'es' ? 'Agregar Habitaciones' : 'Add Rooms'}
              </span>
            </button>

            {/* Stats row */}
            <div style={{ marginTop: '40px', display: 'flex', gap: '48px' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '22px', color: '#1b1c19', fontWeight: 500 }}>{String(queuedCount).padStart(2, '0')}</div>
                <div style={{ color: '#454652', fontSize: '11px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: '2px' }}>
                  {lang === 'es' ? 'Pendientes' : 'Queued'}
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '22px', color: '#1b1c19', fontWeight: 500 }}>{String(activeCount).padStart(2, '0')}</div>
                <div style={{ color: '#454652', fontSize: '11px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: '2px' }}>
                  {lang === 'es' ? 'Activos' : 'Active'}
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '22px', color: '#1b1c19', fontWeight: 500 }}>{String(completedCount).padStart(2, '0')}</div>
                <div style={{ color: '#454652', fontSize: '11px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: '2px' }}>
                  {lang === 'es' ? 'Completos' : 'Complete'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── In Progress Cards (between main card and insights) ── */}
      {inProgressRooms.length > 0 && (
        <div style={{ width: '100%', marginBottom: '24px' }}>
          <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#f59e0b', marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Clock size={12} /> {lang === 'es' ? 'En progreso' : 'In Progress'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {inProgressRooms.map(r => (
              <div key={r.roomNumber} style={{
                padding: '16px 20px', background: '#ffffff', border: '2px solid #f59e0b',
                borderRadius: '16px', display: 'flex', alignItems: 'center', gap: '14px',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: '20px', color: '#1b1c19' }}>
                      {r.roomNumber}
                    </span>
                    <span style={{ padding: '2px 10px', borderRadius: '9999px', fontSize: '11px', fontWeight: 700, background: 'rgba(245,158,11,0.1)', color: '#f59e0b' }}>
                      {lang === 'es' ? 'En progreso' : 'In Progress'}
                    </span>
                  </div>
                  {r.team.length > 0 && (
                    <p style={{ fontSize: '13px', color: '#757684', marginTop: '4px' }}>{r.team.join(', ')}</p>
                  )}
                </div>
                <button
                  onClick={() => setCompleteRoom(r.roomNumber)}
                  style={{
                    padding: '12px 20px', borderRadius: '12px', border: 'none',
                    background: '#10b981', color: '#fff', fontWeight: 700, fontSize: '14px',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
                    flexShrink: 0, minHeight: '48px',
                  }}
                >
                  <Check size={16} /> {lang === 'es' ? 'Hecho' : 'Done'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Secondary Insight Cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', width: '100%', marginBottom: '24px' }}>
        <div style={{ background: '#f5f3ee', padding: '28px', borderRadius: '16px', display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Clock size={22} style={{ color: '#006565' }} />
          </div>
          <div>
            <div style={{ color: '#454652', fontSize: '14px', fontWeight: 500 }}>
              {lang === 'es' ? 'Est. Completar' : 'Est. Completion'}
            </div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '20px', color: '#1b1c19', fontWeight: 500 }}>
              {estHours}h {estMins}m <span style={{ fontSize: '12px', opacity: 0.4 }}>{lang === 'es' ? 'Restante' : 'Remaining'}</span>
            </div>
          </div>
        </div>
        <div style={{ background: '#f5f3ee', padding: '28px', borderRadius: '16px', display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ width: '52px', height: '52px', borderRadius: '50%', background: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Users size={22} style={{ color: '#364262' }} />
          </div>
          <div>
            <div style={{ color: '#454652', fontSize: '14px', fontWeight: 500 }}>
              {lang === 'es' ? 'Personal Activo' : 'Active Staff'}
            </div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '20px', color: '#1b1c19', fontWeight: 500 }}>
              {hkStaffActive} / {hkStaffTotal}
            </div>
          </div>
        </div>
      </div>

      {/* ── Recently Completed ── */}
      {recentlyDone.length > 0 && (
        <div style={{ width: '100%', marginBottom: '24px' }}>
          <p style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#757684', marginBottom: '10px' }}>
            {lang === 'es' ? 'Completadas recientemente' : 'Recently Completed'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {recentlyDone.map(room => (
              <div key={room.roomNumber} style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '14px 18px', background: '#ffffff',
                border: '1px solid rgba(197,197,212,0.15)', borderRadius: '14px', minHeight: '48px',
              }}>
                <CheckCircle2 size={16} color="#10b981" />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: '15px', color: '#1b1c19' }}>
                  {room.roomNumber}
                </span>
                <span style={{ fontSize: '13px', color: '#757684', flex: 1 }}>
                  {room.daysSince === 0 ? (lang === 'es' ? 'Hoy' : 'Today') : `${room.daysSince}d ${lang === 'es' ? 'atrás' : 'ago'}`}
                  {room.cleanedBy ? (
                    <>
                      {' · '}
                      <span
                        onClick={() => { setEditRoom(room.roomNumber); setEditDate(room.lastCleaned ?? ''); setEditCleanedBy(room.cleanedBy ?? ''); }}
                        style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', cursor: 'pointer', color: '#506071' }}
                      >
                        {room.cleanedBy}
                      </span>
                    </>
                  ) : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Glass Pill Footer ── */}
      <div style={{
        position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
        borderRadius: '9999px', padding: '14px 32px', minWidth: '320px',
        background: '#364262', boxShadow: '0 25px 50px -12px rgba(27,28,25,0.2)',
        display: 'flex', justifyContent: 'space-around', alignItems: 'center', gap: '32px', zIndex: 40,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ffffff' }}>
          <Zap size={18} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', lineHeight: 1.1 }}>{pct}%</span>
            <span style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.15em', opacity: 0.7 }}>
              {lang === 'es' ? 'Ciclo' : 'Cycle'}
            </span>
          </div>
        </div>
        <div style={{ width: '1px', height: '32px', background: 'rgba(255,255,255,0.1)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: totalOverdue > 0 ? '#ffdad6' : 'rgba(218,226,255,0.7)' }}>
          <Clock size={18} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', lineHeight: 1.1 }}>{totalOverdue}</span>
            <span style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.15em', opacity: 0.7 }}>
              {lang === 'es' ? 'Pendientes' : 'Overdue'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Add Rooms Modal ── */}
      {showAddRooms && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => { setShowAddRooms(false); setAddRoomsFloor(null); }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            width: '420px', maxWidth: 'calc(100vw - 40px)', maxHeight: '70vh',
            background: '#fbf9f4', borderRadius: '20px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Modal header */}
            <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid rgba(197,197,212,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              {addRoomsFloor !== null ? (
                <button
                  onClick={() => setAddRoomsFloor(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', padding: '0', minHeight: '44px' }}
                >
                  <ChevronLeft size={18} color="#364262" />
                  <span style={{ fontSize: '17px', fontWeight: 700, color: '#1b1c19' }}>
                    {lang === 'es' ? `Piso ${addRoomsFloor}` : `Floor ${addRoomsFloor}`}
                  </span>
                </button>
              ) : (
                <span style={{ fontSize: '17px', fontWeight: 700, color: '#1b1c19' }}>
                  {lang === 'es' ? 'Seleccionar piso' : 'Select Floor'}
                </span>
              )}
              <button
                onClick={() => { setShowAddRooms(false); setAddRoomsFloor(null); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px', minHeight: '44px', display: 'flex', alignItems: 'center' }}
              >
                <XCircle size={20} color="#757684" />
              </button>
            </div>

            {/* Content */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {addRoomsFloor === null ? (
                /* Floor list */
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {floorSummary.map(fs => (
                    <button
                      key={fs.floor}
                      onClick={() => setAddRoomsFloor(fs.floor)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '16px 20px', borderBottom: '1px solid rgba(197,197,212,0.15)',
                        background: 'none', border: 'none', borderBottomStyle: 'solid',
                        cursor: 'pointer', minHeight: '60px', textAlign: 'left', width: '100%',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '16px', color: '#1b1c19' }}>
                          {lang === 'es' ? `Piso ${fs.floor}` : `Floor ${fs.floor}`}
                        </div>
                        <div style={{ fontSize: '13px', color: fs.descColor, fontWeight: 600, marginTop: '2px' }}>
                          {lang === 'es' ? fs.descEs : fs.desc}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '13px', color: '#757684' }}>
                          {fs.total} {lang === 'es' ? 'hab.' : 'rooms'}
                        </span>
                        <ChevronRight size={16} color="#757684" />
                      </div>
                    </button>
                  ))}
                  <button
                    onClick={() => setShowCycleModal(true)}
                    style={{
                      fontSize: '13px', color: '#757684', marginTop: '4px',
                      background: 'none', border: 'none', cursor: 'pointer', padding: '14px 0',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                      minHeight: '44px', width: '100%',
                    }}
                  >
                    <Settings size={14} />
                    {lang === 'es' ? `Ciclo: cada ${freq} días` : `Cycle: every ${freq} days`}
                  </button>
                </div>
              ) : (
                /* Room list for selected floor */
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {(allRoomsByFloor.find(([f]) => f === addRoomsFloor)?.[1] ?? []).map(room => {
                    const desc = roomStatusDesc(room);
                    return (
                      <div key={room.roomNumber} style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        padding: '16px 20px', borderBottom: '1px solid rgba(197,197,212,0.15)',
                        background: room.inProgress ? 'rgba(245,158,11,0.04)' : undefined,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, fontSize: '18px', color: '#1b1c19' }}>
                              {room.roomNumber}
                            </span>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: desc.color }}>
                              {lang === 'es' ? desc.textEs : desc.text}
                            </span>
                          </div>
                          {room.lastCleaned && (
                            <p style={{ fontSize: '12px', color: '#757684', marginTop: '3px' }}>
                              {lang === 'es' ? 'Última:' : 'Last:'} {room.daysSince}d {lang === 'es' ? 'atrás' : 'ago'}
                              {room.cleanedBy ? (
                                <>
                                  {' · '}
                                  <span
                                    onClick={(e) => { e.stopPropagation(); setEditRoom(room.roomNumber); setEditDate(room.lastCleaned ?? ''); setEditCleanedBy(room.cleanedBy ?? ''); }}
                                    style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', cursor: 'pointer', color: '#506071' }}
                                  >
                                    {room.cleanedBy}
                                  </span>
                                </>
                              ) : ''}
                            </p>
                          )}
                          {room.inProgress && room.team.length > 0 && (
                            <p style={{ fontSize: '12px', color: '#f59e0b', marginTop: '2px' }}>{room.team.join(', ')}</p>
                          )}
                        </div>
                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                          {/* Add/Edit Date button */}
                          <button
                            onClick={() => { setEditRoom(room.roomNumber); setEditDate(room.lastCleaned ?? ''); setEditCleanedBy(room.cleanedBy ?? ''); }}
                            style={{
                              padding: '10px 12px', borderRadius: '10px',
                              border: '1.5px solid rgba(197,197,212,0.3)', background: '#fbf9f4',
                              fontWeight: 600, fontSize: '12px', color: '#506071',
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
                              minHeight: '44px', whiteSpace: 'nowrap',
                            }}
                          >
                            <Calendar size={13} />
                            {room.lastCleaned
                              ? (lang === 'es' ? 'Editar' : 'Edit')
                              : (lang === 'es' ? 'Fecha' : 'Add Date')
                            }
                          </button>
                          {/* Assign / Done / Check */}
                          {room.inProgress ? (
                            <button
                              onClick={() => { setCompleteRoom(room.roomNumber); setShowAddRooms(false); }}
                              style={{
                                padding: '10px 14px', borderRadius: '10px', border: 'none',
                                background: '#10b981', color: '#fff', fontWeight: 700, fontSize: '13px',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px',
                                minHeight: '44px',
                              }}
                            >
                              <Check size={14} />
                              {lang === 'es' ? 'Listo' : 'Done'}
                            </button>
                          ) : (room.status === 'overdue' || room.status === 'never') ? (
                            <button
                              onClick={() => { setAssignRoom(room.roomNumber); setSelectedTeam([]); setShowAddRooms(false); }}
                              style={{
                                padding: '10px 14px', borderRadius: '10px', border: 'none',
                                background: '#364262', color: '#fff', fontWeight: 700, fontSize: '13px',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px',
                                minHeight: '44px',
                              }}
                            >
                              <Users size={14} />
                              {lang === 'es' ? 'Asignar' : 'Assign'}
                            </button>
                          ) : (
                            <div style={{ width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <CheckCircle2 size={18} color="#10b981" />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Assign Team Modal ── */}
      {assignRoom && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => { setAssignRoom(null); setSelectedTeam([]); }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: '#fbf9f4', borderRadius: '20px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '20px', width: '340px', maxWidth: 'calc(100vw - 40px)', maxHeight: '80vh', overflowY: 'auto',
          }}>
            <p style={{ fontSize: '16px', fontWeight: 700, color: '#1b1c19', margin: '0 0 4px' }}>
              {lang === 'es' ? `Asignar equipo — ${assignRoom}` : `Assign Team — ${assignRoom}`}
            </p>
            <p style={{ fontSize: '12px', color: '#757684', margin: '0 0 14px' }}>
              {lang === 'es' ? 'Selecciona 2-3 personas' : 'Select 2-3 people'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' }}>
              {availableStaff.map(s => {
                const isSelected = selectedTeam.includes(s.id);
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      setSelectedTeam(prev =>
                        prev.includes(s.id) ? prev.filter(id => id !== s.id) : [...prev, s.id]
                      );
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '10px',
                      padding: '12px 14px', borderRadius: '12px',
                      border: isSelected ? '2px solid #364262' : '1.5px solid rgba(197,197,212,0.3)',
                      background: isSelected ? 'rgba(54,66,98,0.06)' : '#ffffff',
                      cursor: 'pointer', minHeight: '48px', textAlign: 'left',
                    }}
                  >
                    <div style={{
                      width: '36px', height: '36px', borderRadius: '10px',
                      background: isSelected ? '#364262' : '#eae8e3',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: isSelected ? '#fff' : '#757684', fontWeight: 700, fontSize: '13px', flexShrink: 0,
                    }}>
                      {isSelected ? <Check size={16} /> : s.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '14px', color: '#1b1c19' }}>{s.name}</div>
                      {s.doneForDay && (
                        <div style={{ fontSize: '11px', color: '#10b981', fontWeight: 600 }}>
                          {lang === 'es' ? 'Terminó sus habitaciones' : 'Finished rooms'}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => handleAssignTeam(assignRoom)}
              disabled={selectedTeam.length === 0 || saving}
              style={{
                width: '100%', padding: '14px', borderRadius: '14px',
                background: selectedTeam.length > 0 ? '#364262' : '#c5c5d4',
                color: '#fff', border: 'none', fontWeight: 700, fontSize: '15px',
                cursor: selectedTeam.length > 0 ? 'pointer' : 'not-allowed',
                minHeight: '52px', opacity: saving ? 0.6 : 1,
              }}
            >
              {saving
                ? '...'
                : `${lang === 'es' ? 'Confirmar' : 'Confirm'} (${selectedTeam.length} ${lang === 'es' ? 'seleccionados' : 'selected'})`
              }
            </button>
          </div>
        </>
      )}

      {/* ── Complete Confirmation Modal ── */}
      {completeRoom && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => setCompleteRoom(null)} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: '#fbf9f4', borderRadius: '20px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '24px', width: '320px', maxWidth: 'calc(100vw - 40px)', textAlign: 'center',
          }}>
            <CheckCircle2 size={40} color="#10b981" style={{ margin: '0 auto 12px' }} />
            <p style={{ fontSize: '17px', fontWeight: 700, color: '#1b1c19', margin: '0 0 4px' }}>
              {lang === 'es' ? `¿Completar ${completeRoom}?` : `Complete ${completeRoom}?`}
            </p>
            {records[completeRoom]?.cleanedByTeam && (
              <p style={{ fontSize: '13px', color: '#757684', margin: '0 0 16px' }}>
                {lang === 'es' ? 'Equipo:' : 'Team:'} {records[completeRoom].cleanedByTeam!.join(', ')}
              </p>
            )}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setCompleteRoom(null)}
                style={{
                  flex: 1, padding: '14px', borderRadius: '14px',
                  border: '1px solid rgba(197,197,212,0.3)', background: 'transparent',
                  color: '#506071', fontWeight: 600, fontSize: '14px',
                  cursor: 'pointer', minHeight: '48px',
                }}
              >
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={() => handleComplete(completeRoom)}
                disabled={saving}
                style={{
                  flex: 1, padding: '14px', borderRadius: '14px',
                  background: '#10b981', color: '#fff', border: 'none',
                  fontWeight: 700, fontSize: '14px', cursor: 'pointer',
                  minHeight: '48px', opacity: saving ? 0.6 : 1,
                }}
              >
                <Check size={16} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
                {saving ? '...' : (lang === 'es' ? '¡Hecho!' : 'Done!')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Edit Date Modal ── */}
      {editRoom && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => { setEditRoom(null); setEditDate(''); setEditCleanedBy(''); }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: '#fbf9f4', borderRadius: '20px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '20px', width: '320px', maxWidth: 'calc(100vw - 40px)',
          }}>
            <p style={{ fontSize: '16px', fontWeight: 700, color: '#1b1c19', margin: '0 0 4px' }}>
              {lang === 'es' ? `Editar — ${editRoom}` : `Edit — ${editRoom}`}
            </p>
            <p style={{ fontSize: '12px', color: '#757684', margin: '0 0 14px' }}>
              {lang === 'es' ? 'Cambiar fecha y quién lo limpió.' : 'Change date and who cleaned it.'}
            </p>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#757684', marginBottom: '4px', display: 'block' }}>
              {lang === 'es' ? 'Fecha' : 'Date'}
            </label>
            <input
              type="date"
              value={editDate}
              onChange={e => setEditDate(e.target.value)}
              style={{
                width: '100%', padding: '12px', borderRadius: '14px',
                border: '1px solid rgba(197,197,212,0.3)', background: '#ffffff',
                fontSize: '15px', minHeight: '48px', marginBottom: '12px',
                boxSizing: 'border-box',
              }}
            />
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#757684', marginBottom: '4px', display: 'block' }}>
              {lang === 'es' ? 'Limpiado por' : 'Cleaned by'}
            </label>
            <select
              value={editCleanedBy}
              onChange={e => setEditCleanedBy(e.target.value)}
              style={{
                width: '100%', padding: '12px', borderRadius: '14px',
                border: '1px solid rgba(197,197,212,0.3)', background: '#ffffff',
                fontSize: '15px', minHeight: '48px', marginBottom: '12px',
                boxSizing: 'border-box', color: editCleanedBy ? '#1b1c19' : '#757684',
              }}
            >
              <option value="">{lang === 'es' ? 'Seleccionar...' : 'Select...'}</option>
              {availableStaff.map(s => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => { setEditRoom(null); setEditDate(''); setEditCleanedBy(''); }}
                style={{
                  flex: 1, padding: '12px', borderRadius: '14px',
                  border: '1px solid rgba(197,197,212,0.3)', background: 'transparent',
                  color: '#506071', fontWeight: 600, fontSize: '14px',
                  cursor: 'pointer', minHeight: '48px',
                }}
              >
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={() => handleEditDate(editRoom)}
                disabled={!editDate || saving}
                style={{
                  flex: 1, padding: '12px', borderRadius: '14px',
                  background: editDate ? '#364262' : '#c5c5d4',
                  color: '#fff', border: 'none', fontWeight: 700, fontSize: '14px',
                  cursor: editDate ? 'pointer' : 'not-allowed',
                  minHeight: '48px', opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? '...' : (lang === 'es' ? 'Guardar' : 'Save')}
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Cycle Config Modal ── */}
      {showCycleModal && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => setShowCycleModal(false)} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: '#fbf9f4', borderRadius: '20px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '20px', width: '300px', maxWidth: 'calc(100vw - 40px)',
          }}>
            <p style={{ fontSize: '16px', fontWeight: 700, color: '#1b1c19', margin: '0 0 14px' }}>
              {lang === 'es' ? 'Ciclo de limpieza' : 'Deep Clean Cycle'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {[30, 60, 90, 120].map(days => {
                const isSelected = freq === days;
                return (
                  <button
                    key={days}
                    onClick={() => { setCustomCycleDays(''); handleSaveCycle(days); }}
                    style={{
                      padding: '14px', borderRadius: '14px',
                      border: isSelected ? '2px solid #364262' : '1.5px solid rgba(197,197,212,0.3)',
                      background: isSelected ? 'rgba(54,66,98,0.06)' : '#ffffff',
                      fontWeight: isSelected ? 700 : 500, fontSize: '14px',
                      color: isSelected ? '#364262' : '#1b1c19',
                      cursor: 'pointer', minHeight: '48px', textAlign: 'left',
                    }}
                  >
                    {lang === 'es' ? `Cada ${days} días` : `Every ${days} days`}
                    {isSelected && ' ✓'}
                  </button>
                );
              })}
              {/* Custom option */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '10px 14px', borderRadius: '14px',
                border: (freq && ![30, 60, 90, 120].includes(freq)) ? '2px solid #364262' : '1.5px solid rgba(197,197,212,0.3)',
                background: (freq && ![30, 60, 90, 120].includes(freq)) ? 'rgba(54,66,98,0.06)' : '#ffffff',
                minHeight: '48px',
              }}>
                <span style={{ fontSize: '14px', fontWeight: 500, color: '#1b1c19', whiteSpace: 'nowrap' }}>
                  {lang === 'es' ? 'Personalizado:' : 'Custom:'}
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="365"
                  placeholder={lang === 'es' ? 'días' : 'days'}
                  value={customCycleDays}
                  onChange={e => setCustomCycleDays(e.target.value)}
                  style={{
                    flex: 1, padding: '8px 10px', borderRadius: '8px',
                    border: '1.5px solid rgba(197,197,212,0.3)', background: '#ffffff',
                    fontSize: '14px', color: '#1b1c19',
                    outline: 'none', minWidth: 0,
                  }}
                />
                <button
                  onClick={() => {
                    const n = parseInt(customCycleDays, 10);
                    if (n && n > 0 && n <= 365) handleSaveCycle(n);
                  }}
                  disabled={!customCycleDays || parseInt(customCycleDays, 10) <= 0}
                  style={{
                    padding: '8px 14px', borderRadius: '8px',
                    background: customCycleDays && parseInt(customCycleDays, 10) > 0 ? '#364262' : '#c5c5d4',
                    color: '#fff', fontWeight: 600, fontSize: '13px',
                    border: 'none', cursor: customCycleDays && parseInt(customCycleDays, 10) > 0 ? 'pointer' : 'default',
                    opacity: customCycleDays && parseInt(customCycleDays, 10) > 0 ? 1 : 0.5,
                  }}
                >
                  {lang === 'es' ? 'Fijar' : 'Set'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: '90px', left: '50%', transform: 'translateX(-50%)',
          background: '#364262', color: '#fff', padding: '12px 20px',
          borderRadius: '12px', fontSize: '14px', fontWeight: 600,
          boxShadow: '0 4px 20px rgba(0,0,0,0.18)', zIndex: 9999,
          animation: 'toastIn 0.25s ease-out', whiteSpace: 'nowrap',
        }}>
          {toast}
        </div>
      )}
      <style>{`@keyframes toastIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }`}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE SECTION
// ══════════════════════════════════════════════════════════════════════════════

type ViewMode = 'live' | '7d' | '14d' | '30d' | '3mo' | '1yr' | 'all';

const VIEW_DAYS: Record<ViewMode, number> = { live: 0, '7d': 7, '14d': 14, '30d': 30, '3mo': 90, '1yr': 365, all: 730 };

function PerformanceSection() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff } = useProperty();
  const { lang } = useLang();

  const [view, setView] = useState<ViewMode>('live');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [historyRooms, setHistoryRooms] = useState<Room[][]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  const coMins = activeProperty?.checkoutMinutes ?? 30;
  const soMins = activeProperty?.stayoverMinutes ?? 20;

  useEffect(() => {
    if (!user || !activePropertyId) return;
    return subscribeToRooms(user.uid, activePropertyId, todayStr(), setRooms);
  }, [user, activePropertyId]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const loadHistory = useCallback(async (days: number) => {
    if (!user || !activePropertyId) return;
    setHistoryLoading(true);
    try {
      const dates = Array.from({ length: days }, (_, i) => format(subDays(new Date(), i + 1), 'yyyy-MM-dd'));
      const results = await Promise.all(dates.map(d => getRoomsForDate(user.uid, activePropertyId, d)));
      setHistoryRooms(results);
    } catch (err) {
      console.error('Error loading performance history:', err);
    } finally {
      setHistoryLoading(false);
    }
  }, [user, activePropertyId]);

  useEffect(() => {
    const days = VIEW_DAYS[view];
    if (days > 0) loadHistory(days);
  }, [view, loadHistory]);

  const livePerfs    = buildLive(rooms, coMins, soMins, nowMs);
  const historyPerfs = buildHistory(historyRooms);

  const todayDone = rooms.filter(r => r.status === 'clean' || r.status === 'inspected').length;
  const todayTurnaround = (() => {
    const timed = rooms.filter(r => r.startedAt && r.completedAt).map(r => {
      const s = toDate(r.startedAt); const e = toDate(r.completedAt);
      if (!s || !e) return null;
      return (e.getTime() - s.getTime()) / 60_000;
    }).filter((m): m is number => m !== null && m > 0);
    return timed.length > 0 ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  })();

  const scheduledToday  = staff.filter(s => s.scheduledToday);
  const unassignedToday = scheduledToday.filter(s => !livePerfs.find(p => p.staffId === s.id));
  const viewDays        = VIEW_DAYS[view] || 14;
  const topHistoryPerf  = historyPerfs[0];

  // ── Computed metrics for sidebar ──
  const coTimedRooms = rooms.filter(r => r.type === 'checkout' && r.startedAt && r.completedAt).map(r => {
    const s = toDate(r.startedAt); const e = toDate(r.completedAt);
    if (!s || !e) return null;
    return (e.getTime() - s.getTime()) / 60_000;
  }).filter((m): m is number => m !== null && m > 0);
  const soTimedRooms = rooms.filter(r => r.type === 'stayover' && r.startedAt && r.completedAt).map(r => {
    const s = toDate(r.startedAt); const e = toDate(r.completedAt);
    if (!s || !e) return null;
    return (e.getTime() - s.getTime()) / 60_000;
  }).filter((m): m is number => m !== null && m > 0);
  const avgCoMins = coTimedRooms.length > 0 ? Math.round(coTimedRooms.reduce((a, b) => a + b, 0) / coTimedRooms.length) : null;
  const avgSoMins = soTimedRooms.length > 0 ? Math.round(soTimedRooms.reduce((a, b) => a + b, 0) / soTimedRooms.length) : null;
  const coVar = avgCoMins !== null ? avgCoMins - coMins : null;
  const soVar = avgSoMins !== null ? avgSoMins - soMins : null;
  const coFmtMin = avgCoMins !== null ? `${Math.floor(avgCoMins)}:${String(Math.round(avgCoMins % 1 * 60)).padStart(2, '0')}` : '--:--';
  const soFmtMin = avgSoMins !== null ? `${Math.floor(avgSoMins)}:${String(Math.round(avgSoMins % 1 * 60)).padStart(2, '0')}` : '--:--';

  // ── Leaderboard data (merged from livePerfs + LeaderboardCard logic) ──
  const leaderboardData = (() => {
    if (view === 'live') {
      const map = new Map<string, { name: string; cleaned: number; totalMinutes: number; inspected: number }>();
      rooms.filter(r => r.assignedTo && (r.status === 'clean' || r.status === 'inspected' || r.status === 'in_progress'))
        .forEach(room => {
          const entry = map.get(room.assignedTo!) ?? { name: room.assignedName ?? 'Unknown', cleaned: 0, totalMinutes: 0, inspected: 0 };
          if (room.status === 'clean' || room.status === 'inspected') {
            entry.cleaned++;
            const s = toDate(room.startedAt); const e = toDate(room.completedAt);
            if (s && e) { const mins = (e.getTime() - s.getTime()) / 60000; if (mins > 0 && mins < 480) entry.totalMinutes += mins; }
          }
          if (room.status === 'inspected') entry.inspected++;
          map.set(room.assignedTo!, entry);
        });
      const maxCleaned = Math.max(...Array.from(map.values()).map(s => s.cleaned), 1);
      return Array.from(map.values())
        .map(s => ({ ...s, avgMinutes: s.cleaned > 0 ? Math.round(s.totalMinutes / s.cleaned) : 0, efficiency: s.cleaned > 0 ? Math.round((s.inspected / s.cleaned) * 100) : 0, score: s.cleaned > 0 ? Math.round((s.cleaned / maxCleaned) * 10 * 10) / 10 : 0 }))
        .sort((a, b) => b.cleaned - a.cleaned);
    } else {
      const maxDone = Math.max(...historyPerfs.map(p => p.totalDone), 1);
      return historyPerfs.map(p => ({ name: p.name, cleaned: p.totalDone, totalMinutes: 0, inspected: 0, avgMinutes: p.avgCleanMins ?? 0, efficiency: 0, score: Math.round((p.totalDone / maxDone) * 10 * 10) / 10 }));
    }
  })();

  // AI insight text
  const aiInsightText = (() => {
    if (leaderboardData.length === 0) return lang === 'es' ? 'No hay suficientes datos para generar información.' : 'Not enough data to generate insights yet.';
    const top = leaderboardData[0];
    const totalCleaned = leaderboardData.reduce((s, p) => s + p.cleaned, 0);
    const avgEff = leaderboardData.length > 0 ? Math.round(leaderboardData.reduce((s, p) => s + (p.efficiency || 0), 0) / leaderboardData.length) : 0;
    if (todayTurnaround !== null && todayTurnaround < coMins) {
      return lang === 'es'
        ? `El tiempo promedio de limpieza es ${todayTurnaround}m — ${coMins - todayTurnaround}m por debajo del objetivo. ${top.name} lidera con ${top.cleaned} habitaciones.`
        : `Average clean time is ${todayTurnaround}m — ${coMins - todayTurnaround}m below target. ${top.name} leads with ${top.cleaned} rooms.`;
    }
    return lang === 'es'
      ? `${totalCleaned} habitaciones completadas este período. ${top.name} lidera el equipo con ${top.cleaned} habitaciones y un promedio de ${top.avgMinutes}m por habitación.`
      : `${totalCleaned} rooms completed this period. ${top.name} leads the team with ${top.cleaned} rooms and an average of ${top.avgMinutes}m per room.`;
  })();

  return (
    <div style={{ padding: '24px', maxWidth: '1600px', margin: '0 auto', minHeight: 'calc(100vh - 120px)' }}>

      {/* ── Header + Time-range Filter ── */}
      <header style={{ marginBottom: '40px', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(24px, 3vw, 36px)', fontWeight: 600, letterSpacing: '-0.02em', color: '#1b1c19', marginBottom: '6px' }}>
            {lang === 'es' ? 'Rendimiento del Equipo' : 'Housekeeping Performance'}
          </h1>
          <p style={{ color: '#454652', fontSize: '16px' }}>
            {lang === 'es' ? 'Eficiencia operacional y clasificaciones del equipo' : 'Operational efficiency and team leaderboards'}
          </p>
        </div>
        <div style={{ background: '#f5f3ee', padding: '6px', borderRadius: '16px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          {([
            { key: 'live' as ViewMode, label: lang === 'es' ? 'En Vivo' : 'Live' },
            { key: '7d'  as ViewMode, label: lang === 'es' ? '7 Días' : '7 Days' },
            { key: '30d' as ViewMode, label: lang === 'es' ? '30 Días' : '30 Days' },
            { key: '3mo' as ViewMode, label: lang === 'es' ? '6 Meses' : '6 Months' },
            { key: '1yr' as ViewMode, label: lang === 'es' ? '1 Año' : '1 Year' },
          ]).map(({ key, label }) => (
            <button key={key} onClick={() => setView(key)} style={{
              padding: '10px 20px', borderRadius: '12px', fontSize: '14px', fontWeight: 500,
              transition: 'all 200ms', cursor: 'pointer', border: 'none',
              background: view === key ? '#ffffff' : 'transparent',
              color: view === key ? '#1b1c19' : '#454652',
              boxShadow: view === key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}>
              {label}
            </button>
          ))}
        </div>
      </header>

      {/* ── Main Grid: Leaderboard (70%) + Sidebar (30%) ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '32px' }}>
        <div className="perf-grid" style={{ display: 'grid', gap: '32px', alignItems: 'start' }}>
          <style>{`.perf-grid { grid-template-columns: 1fr; } @media (min-width: 768px) { .perf-grid { grid-template-columns: 7fr 3fr; } }`}</style>

          {/* ── LEFT: Team Leaderboard ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ background: '#ffffff', padding: '32px', borderRadius: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
                <h2 style={{ fontSize: '22px', fontWeight: 600, color: '#1b1c19' }}>
                  {lang === 'es' ? 'Clasificación del Equipo' : 'Team Leaderboard'}
                </h2>
                <button style={{ color: '#364262', fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: 'pointer' }}>
                  {lang === 'es' ? 'Exportar Reporte' : 'Export Report'} <span style={{ fontSize: '16px' }}>↓</span>
                </button>
              </div>

              {/* Loading state */}
              {view !== 'live' && historyLoading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                  <div className="spinner" style={{ width: '30px', height: '30px' }} />
                </div>
              )}

              {/* Empty state */}
              {leaderboardData.length === 0 && !(view !== 'live' && historyLoading) && (
                <div style={{ textAlign: 'center', padding: '52px 20px' }}>
                  <div style={{ width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px', background: 'rgba(0,0,0,0.03)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Users size={28} color="#757684" />
                  </div>
                  <p style={{ color: '#454652', fontSize: '15px', fontWeight: 500 }}>{t('noActivityToday', lang)}</p>
                  {view !== 'live' && (
                    <p style={{ color: '#757684', fontSize: '13px', marginTop: '6px' }}>
                      {lang === 'es' ? `Los datos aparecerán aquí después de que el equipo complete habitaciones en los últimos ${viewDays} días.` : `Data will appear here after the team completes rooms over the past ${viewDays} days.`}
                    </p>
                  )}
                </div>
              )}

              {/* Leaderboard table */}
              {leaderboardData.length > 0 && (
                <div>
                  {/* Header row */}
                  <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr 100px 100px 80px', padding: '0 20px 12px', borderBottom: 'none' }}>
                    {[
                      lang === 'es' ? 'Rango' : 'Rank',
                      lang === 'es' ? 'Especialista' : 'Specialist',
                      lang === 'es' ? 'Hab.' : 'Rooms',
                      lang === 'es' ? 'Eficiencia' : 'Efficiency',
                      lang === 'es' ? 'Puntos' : 'Score',
                    ].map(h => (
                      <div key={h} style={{ fontSize: '12px', fontWeight: 500, color: '#454652', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: h === (lang === 'es' ? 'Rango' : 'Rank') || h === (lang === 'es' ? 'Especialista' : 'Specialist') ? 'left' : 'right' }}>
                        {h}
                      </div>
                    ))}
                  </div>

                  {/* Rows */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                    {leaderboardData.map((s, i) => {
                      const initials = s.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
                      const effPct = s.avgMinutes > 0 && s.avgMinutes <= coMins ? Math.round((1 - (s.avgMinutes - soMins) / (coMins - soMins + 1)) * 100) : s.cleaned > 0 ? Math.round(Math.min(100, (1 - Math.max(0, s.avgMinutes - coMins) / coMins) * 100)) : 0;
                      const effDisplay = s.cleaned > 0 ? `${Math.min(99, Math.max(50, effPct))}%` : '-';
                      return (
                        <div key={s.name} style={{
                          display: 'grid', gridTemplateColumns: '60px 1fr 100px 100px 80px', alignItems: 'center',
                          padding: '16px 20px', background: 'rgba(245,243,238,0.4)', borderRadius: '16px',
                          transition: 'background 200ms',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ee'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(245,243,238,0.4)'; }}
                        >
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '18px', color: '#454652' }}>
                            {String(i + 1).padStart(2, '0')}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <div style={{
                              width: '44px', height: '44px', borderRadius: '50%', background: '#eae8e3',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontWeight: 700, fontSize: '14px', color: '#364262', flexShrink: 0,
                              border: '2px solid #ffffff',
                            }}>
                              {initials}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, fontSize: '15px', color: '#1b1c19' }}>{s.name}</div>
                              <div style={{ fontSize: '13px', color: '#454652' }}>
                                {s.avgMinutes > 0 ? `${s.avgMinutes}m avg` : (lang === 'es' ? 'Especialista' : 'Specialist')}
                              </div>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '16px', color: '#1b1c19' }}>
                            {s.cleaned}
                          </div>
                          <div style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '16px', color: '#006565' }}>
                            {effDisplay}
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <span style={{
                              background: '#364262', color: '#ffffff', padding: '4px 12px', borderRadius: '9999px',
                              fontFamily: "'JetBrains Mono', monospace", fontSize: '13px', letterSpacing: '-0.02em',
                            }}>
                              {s.score.toFixed(1)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* ── AI Operational Insight ── */}
            <div style={{ background: '#ffffff', padding: '28px', borderRadius: '24px', position: 'relative', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              {/* Shimmer border effect */}
              <div style={{ position: 'absolute', inset: '-1px', padding: '1px', borderRadius: '24px', background: 'linear-gradient(135deg, rgba(78,90,122,0.2), rgba(0,101,101,0.2))', mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMaskComposite: 'xor', maskComposite: 'exclude', pointerEvents: 'none' }} />
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
                <div style={{ width: '44px', height: '44px', borderRadius: '14px', background: 'rgba(0,101,101,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Zap size={20} style={{ color: '#006565' }} fill="#006565" />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 600, color: '#006565', textTransform: 'uppercase', letterSpacing: '0.15em', fontSize: '11px' }}>
                      {lang === 'es' ? 'Información Operacional IA' : 'AI Operational Insight'}
                    </span>
                    <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#006565', animation: 'pulse 2s ease-in-out infinite' }} />
                  </div>
                  <p style={{ fontSize: '16px', color: '#1b1c19', lineHeight: 1.6 }}>{aiInsightText}</p>
                </div>
              </div>
              <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
            </div>
          </div>

          {/* ── RIGHT: Cleaning Efficiency Sidebar ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ background: '#f0eee9', padding: '28px', borderRadius: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '28px', display: 'flex', alignItems: 'center', gap: '8px', color: '#1b1c19' }}>
                <Clock size={18} style={{ color: '#364262' }} />
                {lang === 'es' ? 'Eficiencia de Limpieza' : 'Cleaning Efficiency'}
              </h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                {/* Checkout Rooms */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '10px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: '#454652' }}>
                      {lang === 'es' ? 'Habitaciones Checkout' : 'Checkout Rooms'}
                    </span>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '28px', fontWeight: 500, color: '#1b1c19' }}>{coFmtMin}</span>
                      <span style={{ display: 'block', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#454652' }}>avg minutes</span>
                    </div>
                  </div>
                  <div style={{ height: '10px', width: '100%', background: '#eae8e3', borderRadius: '9999px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#364262', borderRadius: '9999px', transition: 'width 400ms', width: avgCoMins !== null ? `${Math.min(100, (avgCoMins / (coMins * 1.5)) * 100)}%` : '0%' }} />
                  </div>
                  <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', color: '#454652' }}>
                    <span>{lang === 'es' ? 'Objetivo' : 'Target'} {coMins}:00</span>
                    <span style={{ color: coVar !== null && coVar > 0 ? '#ba1a1a' : '#006565', fontWeight: 700 }}>
                      {coVar !== null ? `${coVar > 0 ? '+' : ''}${coVar}:00 VAR` : '-'}
                    </span>
                  </div>
                </div>

                {/* Stayover Rooms */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '10px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 500, color: '#454652' }}>
                      {lang === 'es' ? 'Habitaciones Stayover' : 'Stayover Rooms'}
                    </span>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '28px', fontWeight: 500, color: '#1b1c19' }}>{soFmtMin}</span>
                      <span style={{ display: 'block', fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#454652' }}>avg minutes</span>
                    </div>
                  </div>
                  <div style={{ height: '10px', width: '100%', background: '#eae8e3', borderRadius: '9999px', overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: '#006565', borderRadius: '9999px', transition: 'width 400ms', width: avgSoMins !== null ? `${Math.min(100, (avgSoMins / (soMins * 1.5)) * 100)}%` : '0%' }} />
                  </div>
                  <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', color: '#454652' }}>
                    <span>{lang === 'es' ? 'Objetivo' : 'Target'} {soMins}:00</span>
                    <span style={{ color: soVar !== null && soVar > 0 ? '#ba1a1a' : '#006565', fontWeight: 700 }}>
                      {soVar !== null ? `${soVar > 0 ? '+' : ''}${soVar}:00 VAR` : '-'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Performance Shift */}
              <div style={{ marginTop: '36px', padding: '20px', background: '#ffffff', borderRadius: '16px', border: '1px solid rgba(197,197,212,0.1)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <Trophy size={16} style={{ color: '#506071' }} />
                  <span style={{ fontSize: '14px', fontWeight: 600, color: '#1b1c19' }}>
                    {lang === 'es' ? 'Cambio de Rendimiento' : 'Performance Shift'}
                  </span>
                </div>
                <p style={{ fontSize: '14px', color: '#454652', lineHeight: 1.6 }}>
                  {todayTurnaround !== null ? (
                    lang === 'es'
                      ? <>Tiempo promedio de respuesta del equipo: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#364262', fontWeight: 700 }}>{todayTurnaround}m</span> por habitación hoy.</>
                      : <>Team average response time: <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#364262', fontWeight: 700 }}>{todayTurnaround}m</span> per room today.</>
                  ) : (
                    lang === 'es' ? 'Los datos de rendimiento aparecerán cuando se completen habitaciones.' : 'Performance data will appear as rooms are completed.'
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LeaderboardCard({ rooms, lang }: { rooms: Room[]; lang: 'en' | 'es' }) {
  const { activeProperty } = useProperty();
  const checkoutMins = activeProperty?.checkoutMinutes || 30;

  const staffStats = useMemo(() => {
    const map = new Map<string, { name: string; cleaned: number; totalMinutes: number; inspected: number }>();
    rooms
      .filter(r => r.assignedTo && (r.status === 'clean' || r.status === 'inspected' || r.status === 'in_progress'))
      .forEach(room => {
        const entry = map.get(room.assignedTo!) ?? { name: room.assignedName ?? 'Unknown', cleaned: 0, totalMinutes: 0, inspected: 0 };
        if (room.status === 'clean' || room.status === 'inspected') {
          entry.cleaned++;
          const s = toDate(room.startedAt);
          const e = toDate(room.completedAt);
          if (s && e) {
            const mins = (e.getTime() - s.getTime()) / 60000;
            if (mins > 0 && mins < 480) entry.totalMinutes += mins;
          }
        }
        if (room.status === 'inspected') entry.inspected++;
        map.set(room.assignedTo!, entry);
      });
    return Array.from(map.values())
      .map(s => ({ ...s, avgMinutes: s.cleaned > 0 ? Math.round(s.totalMinutes / s.cleaned) : 0 }))
      .sort((a, b) => b.cleaned - a.cleaned);
  }, [rooms]);

  if (staffStats.length === 0) {
    return (
      <div className="card animate-in stagger-3" style={{ padding: '20px', textAlign: 'center' }}>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 500 }}>
          {t('noRoomsCompleted', lang)}
        </p>
      </div>
    );
  }

  const getAvgColor = (avg: number) => {
    if (avg <= checkoutMins) return 'var(--green)';
    if (avg <= checkoutMins * 1.5) return 'var(--amber)';
    return 'var(--red)';
  };

  return (
    <div className="card animate-in stagger-3" style={{ padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
        <Trophy size={16} color="var(--amber)" />
        <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
          {t('leaderboard', lang)}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {staffStats.map((s, i) => (
          <div key={s.name} style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '10px 12px', background: i === 0 ? 'rgba(251,191,36,0.06)' : 'rgba(0,0,0,0.02)',
            borderRadius: 'var(--radius-md)', border: i === 0 ? '1px solid rgba(251,191,36,0.2)' : '1px solid var(--border)',
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '13px',
              color: i === 0 ? 'var(--amber)' : 'var(--text-muted)', width: '24px', textAlign: 'center', flexShrink: 0,
            }}>
              {i === 0 ? '🏆' : `#${i + 1}`}
            </span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {s.name}
            </span>
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>
              {s.cleaned} {t('roomsCleaned', lang)}
            </span>
            {s.avgMinutes > 0 && (
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: 700,
                color: getAvgColor(s.avgMinutes), flexShrink: 0,
              }}>
                {s.avgMinutes}m {t('avgTime', lang)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// IMPORT SECTION
// ══════════════════════════════════════════════════════════════════════════════

function ImportSection() {
  const { lang } = useLang();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[]>([]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split('\n').filter(l => l.trim()).slice(0, 6);
      setPreview(lines);
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <h2 style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: '20px', letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 6px', color: 'var(--text-primary)' }}>
          <Upload size={18} color="var(--navy)" />{t('csvImportTitle', lang)}
        </h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>{t('csvHelpText', lang)}</p>
      </div>

      <div
        onClick={() => fileRef.current?.click()}
        style={{ border: '2px dashed var(--border)', borderRadius: 'var(--radius-lg)', padding: '40px 20px', textAlign: 'center', cursor: 'pointer', background: 'rgba(0,0,0,0.02)', transition: 'all 150ms' }}
      >
        <Upload size={32} color="var(--text-muted)" style={{ margin: '0 auto 12px' }} />
        <p style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>{fileName ?? t('csvDropHint', lang)}</p>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{t('uploadCsv', lang)}</p>
        <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFile} style={{ display: 'none' }} />
      </div>

      {preview.length > 0 && (
        <div className="card" style={{ padding: '16px' }}>
          <p style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '10px' }}>{t('csvPreviewLabel', lang)}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {preview.map((line, i) => (
              <p key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)', margin: 0, padding: '4px 8px', background: 'rgba(0,0,0,0.03)', borderRadius: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{line}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

export default function HousekeepingPage() {
  const [activeTab, setActiveTabState] = useState<TabKey>('rooms');
  const { lang } = useLang();
  const { user, loading: authLoading } = useAuth();
  const { activeProperty, activePropertyId, loading: propLoading } = useProperty();
  const router = useRouter();

  // Auth guard — redirect if not logged in or no property
  useEffect(() => {
    if (!authLoading && !propLoading && !user) router.replace('/signin');
    if (!authLoading && !propLoading && user && !activePropertyId) router.replace('/onboarding');
  }, [user, authLoading, propLoading, activePropertyId, router]);

  // Restore tab from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('hk-tab') as TabKey | null;
    const valid: TabKey[] = ['rooms', 'schedule', 'deepclean', 'performance'];
    if (saved && valid.includes(saved)) setActiveTabState(saved);
  }, []);

  const setActiveTab = (tab: TabKey) => {
    setActiveTabState(tab);
    localStorage.setItem('hk-tab', tab);
  };

  if (authLoading || propLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div className="spinner" style={{ width: '32px', height: '32px' }} />
      </div>
    );
  }

  return (
    <AppLayout>
      {/* ── Sub-tab bar (Stitch pill style) ── */}
      <div style={{ padding: '16px 24px 0', position: 'sticky', top: 64, zIndex: 10, background: 'var(--bg)' }}>
        <nav style={{
          display: 'flex', alignItems: 'center', gap: '32px',
          borderBottom: '1px solid rgba(197,197,212,0.25)',
          paddingBottom: '0',
        }}>
          {TABS.map(tab => {
            const isActive = activeTab === tab.key;
            const tabLabel = tab.key === 'deepclean' ? (lang === 'es' ? tab.labelEs : tab.label) : undefined;
            const tabLabelKey = tab.key === 'rooms' ? 'rooms' : tab.key === 'schedule' ? 'scheduling' : tab.key === 'deepclean' ? undefined : 'performance';
            return (
              <button
                key={tab.key}
                className="hk-tab-btn"
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: '8px 0 12px',
                  border: 'none',
                  borderRadius: 0,
                  background: 'none',
                  color: isActive ? '#1b1c19' : '#757684',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: '15px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontFamily: "'Inter', sans-serif",
                  transition: 'all 150ms',
                  boxShadow: 'none',
                  borderBottom: isActive ? '2px solid #1b1c19' : '2px solid transparent',
                  letterSpacing: '-0.01em',
                  marginBottom: '-1px',
                }}
              >
                {tabLabel ?? (tabLabelKey ? t(tabLabelKey, lang) : '')}
              </button>
            );
          })}
        </nav>
      </div>

      {/* ── Section content ── */}
      {activeTab === 'schedule'    && <ScheduleSection />}
      {activeTab === 'rooms'       && <RoomsSection />}
      {activeTab === 'deepclean'   && <DeepCleanSection />}
      {activeTab === 'performance' && <PerformanceSection />}
    </AppLayout>
  );
}
