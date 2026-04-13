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
  subscribeToRooms, updateRoom, addRoom,
  addStaffMember, updateStaffMember, deleteStaffMember,
  getRoomsForDate, getPublicAreas, setPublicArea, deletePublicArea,
  updateProperty,
  getDeepCleanConfig, setDeepCleanConfig, getDeepCleanRecords,
  markRoomDeepCleaned, assignRoomDeepClean, completeRoomDeepClean,
} from '@/lib/firestore';
import { getPublicAreasDueToday, calcPublicAreaMinutes, autoAssignRooms, getOverdueRooms, calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { getDefaultPublicAreas } from '@/lib/defaults';
import type { PublicArea } from '@/types';
import { todayStr } from '@/lib/utils';
import type { Room, RoomStatus, StaffMember, DeepCleanRecord, DeepCleanConfig } from '@/types';
import { format, subDays } from 'date-fns';
import {
  Calendar, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, CheckCircle2, Clock,
  AlertTriangle, Users, Send, Zap, BedDouble, Plus, Pencil, Trash2, Star, Check,
  Trophy, TrendingUp, TrendingDown, Minus, Upload, Settings,
  Search, XCircle,
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

function formatDisplayDate(dateStr: string, lang: 'en' | 'es'): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
  });
}

function isEligible(s: StaffMember, date: string): boolean {
  if (s.isActive === false) return false;
  if (s.schedulePriority === 'excluded') return false;
  if (s.vacationDates?.includes(date)) return false;
  const maxHrs = s.maxWeeklyHours ?? 40;
  if ((s.weeklyHours ?? 0) >= maxHrs) return false;
  return true;
}

const PRIORITY_ORDER = { priority: 0, normal: 1, excluded: 2 } as const;

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

  const tomorrow = addDays(schedTodayStr(), 1);
  const [shiftDate, setShiftDate] = useState(tomorrow);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [showPredictionSettings, setShowPredictionSettings] = useState(false);
  const [showPublicAreas, setShowPublicAreas] = useState(false);
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [expandedCrew, setExpandedCrew] = useState<string | null>(null);
  const [settingsForm, setSettingsForm] = useState({ checkoutMinutes: 30, stayoverMinutes: 20, prepMinutesPerActivity: 5 });
  const [savingSettings, setSavingSettings] = useState(false);

  // Prediction model state
  const [shiftRooms, setShiftRooms] = useState<Room[]>([]);
  const [publicAreas, setPublicAreas] = useState<PublicArea[]>([]);
  const [predictionLoading, setPredictionLoading] = useState(true);

  // Crew assignments
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [crewOverride, setCrewOverride] = useState<string[]>([]); // manually toggled staff IDs
  const [hasAutoSelected, setHasAutoSelected] = useState(false);
  const [showPrioritySettings, setShowPrioritySettings] = useState(false);

  // Swap dropdown
  const [swapOpenFor, setSwapOpenFor] = useState<string | null>(null);
  const [swapAnchor, setSwapAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // Move toast notification
  const [moveToast, setMoveToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Drag-and-drop state (pointer events — works for both mouse + touch)
  const [dragState, setDragState] = useState<{
    roomId: string; roomNumber: string; roomType: string;
    ghost: { x: number; y: number }; dropTarget: string | null;
  } | null>(null);
  const crewCardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragRef = useRef<{
    roomId: string | null; roomNumber: string; roomType: string;
    startX: number; startY: number; active: boolean;
  }>({ roomId: null, roomNumber: '', roomType: '', startX: 0, startY: 0, active: false });

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  useEffect(() => {
    if (uid && pid && staff.length === 0) refreshStaff();
  }, [uid, pid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!uid || !pid) return;
    setPredictionLoading(true);
    getRoomsForDate(uid, pid, shiftDate).then(rooms => {
      setShiftRooms(rooms);
      setPredictionLoading(false);
    }).catch(err => {
      console.error('Error fetching rooms for date:', err);
      setPredictionLoading(false);
    });
  }, [uid, pid, shiftDate]);

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
      setSettingsForm({
        checkoutMinutes: activeProperty.checkoutMinutes ?? 30,
        stayoverMinutes: activeProperty.stayoverMinutes ?? 20,
        prepMinutesPerActivity: activeProperty.prepMinutesPerActivity ?? 5,
      });
    }
  }, [activeProperty]);

  const handleSaveSettings = async () => {
    if (!uid || !pid) return;
    setSavingSettings(true);
    try { await updateProperty(uid, pid, settingsForm); await refreshProperty(); }
    finally { setSavingSettings(false); setShowPredictionSettings(false); }
  };

  // ── Prediction model ──
  const coMins = activeProperty?.checkoutMinutes ?? 30;
  const soMins = activeProperty?.stayoverMinutes ?? 20;
  const prepPerRoom = activeProperty?.prepMinutesPerActivity ?? 5;
  const shiftLen = Math.min(activeProperty?.shiftMinutes ?? 420, 420); // 7h max per housekeeper

  const checkouts = shiftRooms.filter(r => r.type === 'checkout').length;
  const stayovers = shiftRooms.filter(r => r.type === 'stayover').length;
  const totalRooms = checkouts + stayovers;
  const roomMinutes = (checkouts * coMins) + (stayovers * soMins);
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

  // Track whether user has manually touched the crew list
  const userEditedCrew = useRef(false);

  // The selected crew: auto-pick or manual override
  const selectedCrew = useMemo(() => {
    if (userEditedCrew.current) {
      // User has made manual changes — respect crewOverride exactly (even if empty)
      return crewOverride.map(id => staff.find(s => s.id === id)).filter((s): s is StaffMember => !!s);
    }
    if (crewOverride.length > 0) return crewOverride.map(id => staff.find(s => s.id === id)).filter((s): s is StaffMember => !!s);
    if (recommendedStaff > 0 && totalRooms > 0) return eligiblePool.slice(0, recommendedStaff);
    return eligiblePool;
  }, [crewOverride, eligiblePool, recommendedStaff, totalRooms, staff]);

  // Auto-assign: full assign on first load, then only assign unassigned rooms on crew changes
  const manuallyAdded = useRef<Set<string>>(new Set());
  const hasInitialAssign = useRef(false);
  useEffect(() => {
    if (assignableRooms.length === 0 || selectedCrew.length === 0) { setAssignments({}); hasInitialAssign.current = false; return; }

    if (!hasInitialAssign.current) {
      // First time: full auto-assign
      const fakeScheduled = selectedCrew.map(s => ({ ...s, scheduledToday: true }));
      const auto = autoAssignRooms(assignableRooms, fakeScheduled, {
        checkoutMinutes: coMins, stayoverMinutes: soMins, prepMinutesPerRoom: prepPerRoom, shiftMinutes: shiftLen,
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
  }, [selectedCrew, assignableRooms, coMins, soMins, prepPerRoom, shiftLen]);

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


  const handleSend = async () => {
    if (!uid || !pid || selectedCrew.length === 0 || sending) return;
    setSending(true);
    try {
      const baseUrl = window.location.origin;
      const staffPayload = selectedCrew.filter(s => s.phone).map(s => ({ staffId: s.id, name: s.name, phone: s.phone!, language: s.language }));
      await fetch('/api/send-shift-confirmations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, pid, shiftDate, baseUrl, staff: staffPayload }),
      });
      setSent(true);
    } finally { setSending(false); }
  };

  // Room workload per staff member
  const getStaffWorkload = (staffId: string) => {
    const staffRooms = assignableRooms.filter(r => assignments[r.id] === staffId);
    const mins = staffRooms.reduce((sum, r) => sum + (r.type === 'checkout' ? coMins : soMins) + prepPerRoom, 0);
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
      roomId: room.id, roomNumber: room.number, roomType: room.type,
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
      roomId: d.roomId, roomNumber: d.roomNumber, roomType: d.roomType,
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

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* ── Date picker ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
        <button onClick={() => { setShiftDate(d => addDays(d, -1)); setSent(false); setCrewOverride([]); }} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-secondary)' }} aria-label={lang === 'es' ? 'Día anterior' : 'Previous day'}>
          <ChevronLeft size={16} />
        </button>
        <span style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>
          {formatDisplayDate(shiftDate, lang)}
        </span>
        <button onClick={() => { setShiftDate(d => addDays(d, 1)); setSent(false); setCrewOverride([]); }} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '6px 10px', cursor: 'pointer', color: 'var(--text-secondary)' }} aria-label={lang === 'es' ? 'Día siguiente' : 'Next day'}>
          <ChevronRight size={16} />
        </button>
      </div>

      {/* ── STEP 1: Prediction ── */}
      <div className="card animate-in" onClick={() => setShowPredictionSettings(true)} style={{
        padding: '24px 20px 20px', textAlign: 'center',
        background: 'linear-gradient(135deg, var(--navy) 0%, var(--navy-light, #2563EB) 100%)',
        border: 'none', borderRadius: 'var(--radius-xl)',
        boxShadow: '0 4px 24px rgba(27, 58, 92, 0.25)', cursor: 'pointer',
      }}>
        {predictionLoading ? (
          <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{t('roomDataLoading', lang)}</p>
        ) : totalRooms === 0 ? (
          <div>
            <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{t('noRoomDataYet', lang)}</p>
            <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)', margin: '4px 0 0' }}>{t('pmsSync15Min', lang)}</p>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginBottom: '14px' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 800, color: '#fff' }}>{checkouts}</div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', fontWeight: 600 }}>{lang === 'es' ? 'Salidas' : 'Checkouts'}</div>
              </div>
              <div style={{ width: '1px', background: 'rgba(255,255,255,0.15)' }} />
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 800, color: '#fff' }}>{stayovers}</div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', fontWeight: 600 }}>{lang === 'es' ? 'Continuación' : 'Stayovers'}</div>
              </div>
              <div style={{ width: '1px', background: 'rgba(255,255,255,0.15)' }} />
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 800, color: 'var(--amber-light, #FCD34D)' }}>{recommendedStaff}</div>
                <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', fontWeight: 600 }}>{lang === 'es' ? 'Personal' : 'Staff needed'}</div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Unassigned rooms box ── */}
      {!predictionLoading && totalRooms > 0 && (
        <div
          ref={unassignedRef}
          style={{
            background: dragState?.dropTarget === '__unassigned__' ? 'rgba(37,99,235,0.06)' : 'var(--bg-card)',
            border: dragState?.dropTarget === '__unassigned__' ? '2px dashed var(--navy)' : '1.5px dashed var(--border)',
            borderRadius: '14px', padding: '12px 16px',
            transition: 'all 0.15s',
            minHeight: '48px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: unassignedRooms.length > 0 ? '10px' : '0' }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)' }}>
              {lang === 'es' ? 'Sin asignar' : 'Unassigned'}
            </span>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {unassignedRooms.length} {lang === 'es' ? 'habitaciones' : 'rooms'}
            </span>
          </div>
          {unassignedRooms.length > 0 && (
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', fontStyle: 'italic' }}>
              {lang === 'es' ? 'Arrastra las habitaciones al personal para asignar' : 'Drag rooms to crew members to assign'}
            </p>
          )}
          {unassignedRooms.length === 0 && totalRooms > 0 && (
            <p style={{ fontSize: '12px', color: 'var(--green)', fontWeight: 600, marginTop: '4px' }}>
              {lang === 'es' ? '✓ Todas asignadas' : '✓ All rooms assigned'}
            </p>
          )}
          {unassignedRooms.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {unassignedRooms.map(room => (
                <button
                  key={room.id}
                  onPointerDown={e => onPillPointerDown(e, room)}
                  onPointerMove={onPillPointerMove}
                  onPointerUp={e => { onPillPointerUp(e); }}
                  onPointerCancel={onPillPointerCancel}
                  style={{
                    padding: '6px 10px 4px', lineHeight: 1,
                    background: room.type === 'checkout' ? 'var(--red-dim)' : 'var(--blue-dim, #F0F9FF)',
                    border: room.type === 'checkout' ? '1.5px solid var(--red-border, #FECACA)' : '1.5px solid var(--blue-border, #BAE6FD)',
                    borderRadius: '6px', cursor: 'grab',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                    opacity: dragState?.roomId === room.id ? 0.3 : 1,
                    touchAction: 'none',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    WebkitTouchCallout: 'none',
                  }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>{room.number}</span>
                  <span style={{ fontSize: '8px', fontWeight: 600, color: room.type === 'checkout' ? 'var(--red)' : 'var(--navy)', letterSpacing: '0.02em' }}>
                    {room.type === 'checkout' ? 'C' : 'S'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── STEP 2: Crew list ── */}
      {!predictionLoading && totalRooms > 0 && (
        <div style={{
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: '14px', overflow: 'hidden',
        }}>
          {selectedCrew.map((member, idx) => {
            const { rooms: memberRooms, mins } = getStaffWorkload(member.id);
            const hrs = Math.floor(mins / 60);
            const remMins = mins % 60;
            const timeLabel = hrs > 0 ? `${hrs}h${remMins > 0 ? ` ${remMins}m` : ''}` : `${mins}m`;
            const color = STAFF_COLORS[idx % STAFF_COLORS.length];
            const isDropHover = dragState?.dropTarget === member.id && dragState?.roomId && assignments[dragState.roomId] !== member.id;
            const isLast = idx === selectedCrew.length - 1;
            const coCount = memberRooms.filter(r => r.type === 'checkout').length;
            const soCount = memberRooms.length - coCount;

            return (
              <div
                key={member.id}
                ref={el => { crewCardRefs.current[member.id] = el; }}
                data-crew-id={member.id}
                className="sched-crew-row"
                style={{
                  borderBottom: isLast ? 'none' : '1px solid var(--border)',
                  background: isDropHover ? `${color}08` : 'transparent',
                  transition: 'background 0.15s',
                  padding: '12px 16px',
                  display: 'flex', gap: '12px', alignItems: 'center',
                }}
              >
                {/* Top: name + inline stats */}
                <div className="sched-crew-info" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {/* Name — clickable to swap */}
                  <div className="sched-crew-name" style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '120px', flexShrink: 0 }}>
                    <button
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setSwapAnchor({ top: rect.bottom + 4, left: rect.left });
                        setSwapOpenFor(prev => prev === member.id ? null : member.id);
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'var(--font-sans)',
                        fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap',
                        overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left',
                      }}
                    >
                      {member.name}
                    </button>
                  </div>
                  {/* Stats grid */}
                  <div className="sched-crew-stats" style={{ display: 'grid', gridTemplateColumns: '80px 100px', gap: '1px 10px', fontSize: '12px', color: 'var(--text-secondary)', width: '190px', flexShrink: 0 }}>
                    <div>{lang === 'es' ? 'Estimado' : 'Est'}: <strong style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{timeLabel}</strong></div>
                    <div style={{ color: 'var(--red)' }}><strong style={{ fontWeight: 700 }}>{coCount}</strong> {lang === 'es' ? 'Salida' : 'Checkout'}{coCount !== 1 ? 's' : ''}</div>
                    <button onClick={() => {
                      const roomCount = Object.values(assignments).filter(sid => sid === member.id).length;
                      const msg = lang === 'es'
                        ? `¿Quitar a ${member.name} y desasignar sus ${roomCount} habitaciones?`
                        : `Remove ${member.name} and unassign their ${roomCount} room${roomCount !== 1 ? 's' : ''}?`;
                      if (confirm(msg)) toggleCrewMember(member.id);
                    }} style={{
                      background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                      fontSize: '11px', fontWeight: 600, color: 'var(--red)', padding: '0', textAlign: 'left',
                      opacity: 0.6,
                    }}>
                      {lang === 'es' ? 'Quitar' : 'Remove'}
                    </button>
                    <div style={{ color: 'var(--navy)' }}><strong style={{ fontWeight: 700 }}>{soCount}</strong> {lang === 'es' ? 'Continuación' : 'Stayover'}{soCount !== 1 ? 's' : ''}</div>
                  </div>
                </div>

                {/* Room pills */}
                <div className="sched-crew-pills" style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: '6px', alignContent: 'flex-start' }}>
                  {memberRooms.map(room => (
                    <button
                      key={room.id}
                      onPointerDown={e => onPillPointerDown(e, room)}
                      onPointerMove={onPillPointerMove}
                      onPointerUp={e => { onPillPointerUp(e); }}
                      onPointerCancel={onPillPointerCancel}
                      className="sched-room-pill"
                      style={{
                        padding: '6px 10px 4px', lineHeight: 1,
                        background: room.type === 'checkout' ? 'var(--red-dim)' : 'var(--blue-dim, #F0F9FF)',
                        border: room.type === 'checkout' ? '1.5px solid var(--red-border, #FECACA)' : '1.5px solid var(--blue-border, #BAE6FD)',
                        borderRadius: '6px', cursor: 'grab',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                        opacity: dragState?.roomId === room.id ? 0.3 : 1,
                        touchAction: 'none',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        WebkitTouchCallout: 'none',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>{room.number}</span>
                      <span style={{ fontSize: '8px', fontWeight: 600, color: room.type === 'checkout' ? 'var(--red)' : 'var(--navy)', letterSpacing: '0.02em' }}>
                        {room.type === 'checkout' ? 'C' : 'S'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Add staff row */}
          {/* Bottom row: Add staff + Priority side by side */}
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '16px', borderTop: '1px solid var(--border)' }}>
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).length > 0 && (
              <div onClick={() => setShowAddStaff(true)} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                <Plus size={14} color="var(--text-muted)" />
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>
                  {lang === 'es' ? 'Agregar personal' : 'Add staff'}
                </span>
              </div>
            )}
            <div onClick={() => setShowPrioritySettings(true)} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <Settings size={14} color="var(--text-muted)" />
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>
                {lang === 'es' ? 'Prioridad' : 'Priority'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 3: Send confirmations ── */}
      {!predictionLoading && totalRooms > 0 && selectedCrew.length > 0 && (
        sent ? (
          <div className="animate-in" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '14px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', borderRadius: 'var(--radius-md)' }}>
            <CheckCircle2 size={16} color="var(--green)" />
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--green)' }}>{t('confirmationsSent', lang)}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button onClick={handleSend} disabled={sending} style={{
              padding: '12px 28px',
              background: sending ? 'var(--bg-input)' : 'linear-gradient(135deg, var(--navy) 0%, var(--navy-light, #2563EB) 100%)',
              color: sending ? 'var(--text-muted)' : '#fff',
              border: 'none', borderRadius: '12px',
              fontWeight: 700, fontSize: '15px', cursor: sending ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-sans)',
              display: 'flex', alignItems: 'center', gap: '8px',
              boxShadow: '0 2px 12px rgba(27, 58, 92, 0.25)',
            }}>
              <Send size={16} />
              {sending ? (lang === 'es' ? 'Enviando…' : 'Sending…') : (lang === 'es' ? `Enviar Confirmaciones (${selectedCrew.length})` : `Send Confirmations (${selectedCrew.length})`)}
            </button>
          </div>
        )
      )}

      {/* ── Move toast ── */}
      {moveToast && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', zIndex: 10000,
          background: 'linear-gradient(135deg, var(--navy) 0%, var(--navy-light, #2563EB) 100%)', color: '#fff', padding: '10px 20px', borderRadius: '10px',
          fontSize: '13px', fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          animation: 'toastIn 0.2s ease-out',
          whiteSpace: 'nowrap',
        }}>
          {moveToast}
        </div>
      )}
      <style>{`@keyframes toastIn { from { transform: translateX(-50%) translateY(10px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }`}</style>

      {/* ── Swap dropdown (rendered outside card to avoid overflow clip) ── */}
      {swapOpenFor && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9990 }} onClick={() => setSwapOpenFor(null)} />
          <div style={{
            position: 'fixed', top: swapAnchor.top, left: swapAnchor.left, zIndex: 9991,
            background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '10px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.15)', padding: '4px', minWidth: '160px',
          }}>
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).map(s => (
              <button key={s.id} onClick={() => {
                const oldId = swapOpenFor!;
                // Transfer all room assignments from old person to new person
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
                display: 'block', width: '100%', padding: '8px 12px', border: 'none', borderRadius: '8px',
                background: 'transparent', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', textAlign: 'left',
              }}
                onMouseEnter={e => { (e.target as HTMLElement).style.background = 'var(--bg-elevated)'; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.background = 'transparent'; }}
              >
                {s.name}
              </button>
            ))}
            {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>
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
            background: 'var(--bg-card)', borderRadius: '16px', padding: '20px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.2)', width: '340px', maxHeight: '80vh', overflowY: 'auto',
            animation: 'popIn 0.15s ease-out',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <p style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                {lang === 'es' ? 'Prioridad del Personal' : 'Staff Priority'}
              </p>
              <button onClick={() => setShowPrioritySettings(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--text-muted)' }} aria-label={lang === 'es' ? 'Cerrar' : 'Close'}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span style={{ padding: '3px 8px', background: 'var(--blue-dim, #DBEAFE)', color: 'var(--navy)', borderRadius: '6px', fontWeight: 600 }}>{lang === 'es' ? 'Prioridad' : 'Priority'}</span>
              <span>{lang === 'es' ? '= primera selección' : '= picked first'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {staff.filter(s => s.isActive !== false && (s.department === 'housekeeping' || !s.department)).map(s => {
                const pri = s.schedulePriority ?? 'normal';
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: 'var(--bg-elevated)', borderRadius: '10px' }}>
                    <span style={{ flex: 1, fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>{s.name}</span>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      {(['priority', 'normal', 'excluded'] as const).map(level => (
                        <button key={level} onClick={async () => {
                          await updateStaffMember(uid!, pid!, s.id, { schedulePriority: level } as Partial<StaffMember>);
                        }} style={{
                          padding: '4px 10px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                          fontFamily: 'var(--font-sans)', fontSize: '11px', fontWeight: 600,
                          background: pri === level
                            ? level === 'priority' ? 'var(--blue-dim, #DBEAFE)' : level === 'normal' ? 'var(--bg-elevated, #F3F4F6)' : 'var(--red-dim)'
                            : 'transparent',
                          color: pri === level
                            ? level === 'priority' ? 'var(--navy)' : level === 'normal' ? 'var(--text-secondary)' : 'var(--red)'
                            : 'var(--text-muted)',
                        }}>
                          {level === 'priority' ? (lang === 'es' ? 'Prior.' : 'Priority') : level === 'normal' ? 'Normal' : (lang === 'es' ? 'Excluir' : 'Exclude')}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '14px 0 0', lineHeight: 1.5 }}>
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
            background: 'var(--bg-card)', borderRadius: '16px',
            boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '20px', width: '520px', maxWidth: 'calc(100vw - 40px)', maxHeight: '70vh', overflowY: 'auto',
            animation: 'popIn 0.15s ease-out',
          }}>
            <p style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 12px' }}>
              {lang === 'es' ? 'Agregar Personal' : 'Add Staff'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
              {eligiblePool.filter(s => !selectedCrew.find(c => c.id === s.id)).map(member => (
                <button key={member.id} onClick={() => { toggleCrewMember(member.id); setShowAddStaff(false); }} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
                  padding: '12px 6px', background: 'var(--bg-elevated)', border: '1.5px solid var(--border)',
                  borderRadius: '12px', cursor: 'pointer', fontFamily: 'var(--font-sans)',
                }}>
                  <div style={{
                    width: '40px', height: '40px', borderRadius: '10px',
                    background: 'linear-gradient(135deg, var(--navy) 0%, var(--navy-light, #2563EB) 100%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontWeight: 700, fontSize: '14px',
                  }}>
                    {member.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.2 }}>
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
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-card)', borderRadius: '16px', padding: '24px', width: '100%', maxWidth: '380px', boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <p style={{ fontWeight: 700, fontSize: '17px', color: 'var(--text-primary)', margin: 0 }}>
                {lang === 'es' ? 'Ajustes de Predicción' : 'Prediction Settings'}
              </p>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
                {lang === 'es' ? 'Ajusta los tiempos de limpieza.' : 'Adjust cleaning times.'}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {[
                { label: lang === 'es' ? 'Habitación de salida' : 'Checkout room', key: 'checkoutMinutes' as const },
                { label: lang === 'es' ? 'Habitación de continuación' : 'Stayover room', key: 'stayoverMinutes' as const },
                { label: lang === 'es' ? 'Entre habitaciones' : 'Between rooms', key: 'prepMinutesPerActivity' as const },
              ].map(({ label, key }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)' }}>{label}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <input className="input" type="number" min={key === 'prepMinutesPerActivity' ? 0 : 1} value={settingsForm[key]} onChange={e => setSettingsForm(p => ({ ...p, [key]: Number(e.target.value) || 0 }))} style={{ width: '64px', textAlign: 'center', padding: '8px 4px' }} />
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>min</span>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button onClick={() => setShowPredictionSettings(false)} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-muted)', fontWeight: 600, fontSize: '14px', cursor: 'pointer' }}>{t('cancel', lang)}</button>
              <button onClick={handleSaveSettings} disabled={savingSettings} style={{ flex: 1, padding: '12px', borderRadius: '10px', border: 'none', background: 'var(--navy)', color: '#fff', fontWeight: 600, fontSize: '14px', cursor: 'pointer', opacity: savingSettings ? 0.6 : 1 }}>{savingSettings ? t('saving', lang) : t('save', lang)}</button>
            </div>
            <button onClick={() => { setShowPredictionSettings(false); setShowPublicAreas(true); }} style={{
              width: '100%', padding: '14px 16px', marginTop: '4px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              background: 'rgba(27,58,92,0.06)', border: '1px solid var(--border)', borderRadius: '10px',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>{lang === 'es' ? 'Áreas Comunes' : 'Public Areas'}</span>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{areasDueToday.length} {lang === 'es' ? 'para hoy' : 'due today'} · {publicAreaMinutes}m →</span>
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
          padding: '6px 12px',
          background: 'var(--navy)',
          border: '2px solid rgba(255,255,255,0.5)',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          transform: 'scale(1.15)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1,
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: '13px', color: '#fff' }}>{dragState.roomNumber}</span>
          <span style={{ fontSize: '8px', fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>{dragState.roomType === 'checkout' ? 'C' : 'S'}</span>
        </div>
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
  const [loading, setLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [actionRoom, setActionRoom] = useState<Room | null>(null); // room action popup
  const [nowMs, setNowMs] = useState(Date.now());

  // Help request badge tracking — rooms where helpRequested is true
  const [backupRoom, setBackupRoom] = useState<Room | null>(null); // room needing backup staff picker

  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToRooms(user.uid, activePropertyId, todayStr(), (r) => {
      setRooms(r);
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
    // Send SMS to the backup person
    try {
      await fetch('/api/help-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: user.uid, pid: activePropertyId,
          staffName: backupStaffName,
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
    const limit = room.type === 'checkout' ? (activeProperty?.checkoutMinutes ?? 30) : (activeProperty?.stayoverMinutes ?? 20);
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
    if (room.type === 'vacant') return '◇';
    return null;
  };

  return (
    <div style={{ padding: '24px', paddingBottom: '140px', background: '#f4f7fa', minHeight: 'calc(100vh - 180px)' }}>

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
          <p style={{ color: '#64748b', fontSize: '15px', fontWeight: 500 }}>{rooms.length === 0 ? t('noRoomsTodayHkp', lang) : t('noRoomsFloor', lang)}</p>
        </div>
      ) : (
        <>
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
                              background: '#f97316', borderRadius: '4px', padding: '1px 6px',
                              letterSpacing: '0.05em',
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
  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '100px' }}>

      {/* ── Header ── */}
      <div className="animate-in">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Zap size={16} color="var(--navy)" />
            <h2 style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              {lang === 'es' ? 'Limpieza Profunda' : 'Deep Clean'}
            </h2>
          </div>
          {/* Tappable overdue counter */}
          <button
            onClick={() => setShowBreakdown(!showBreakdown)}
            style={{
              fontSize: '14px', fontWeight: 700, color: totalOverdue === 0 ? 'var(--green)' : 'var(--red)',
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px',
              display: 'flex', alignItems: 'center', gap: '4px', minHeight: '44px',
            }}
          >
            {totalOverdue} {lang === 'es' ? 'pendientes' : 'overdue'}
            <ChevronDown size={14} style={{ transform: showBreakdown ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }} />
          </button>
        </div>

        {/* Floor breakdown dropdown */}
        {showBreakdown && floorBreakdown.length > 0 && (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '8px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {floorBreakdown.map(({ floor, count }) => (
              <span key={floor} style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', padding: '4px 10px', background: 'var(--bg-elevated, rgba(0,0,0,0.04))', borderRadius: '8px' }}>
                {lang === 'es' ? `Piso ${floor}` : `Floor ${floor}`}: <span style={{ color: 'var(--red)' }}>{count}</span>
              </span>
            ))}
          </div>
        )}

        {/* Progress bar */}
        <div style={{ height: '6px', background: 'var(--border)', borderRadius: '99px', overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: '99px',
            transition: 'width 600ms cubic-bezier(0.4,0,0.2,1)',
            width: `${pct}%`,
            background: pct === 100 ? 'var(--green)' : 'var(--navy)',
          }} />
        </div>

      </div>

      {/* ── Today's Suggestion ── */}
      <div className="animate-in stagger-1" style={{
        padding: '16px', borderRadius: 'var(--radius-lg)',
        background: isLightDay ? 'linear-gradient(135deg, var(--navy, #1b3a5c), var(--navy-light, #2a5a8c))' : 'var(--bg-card)',
        border: isLightDay ? 'none' : '1px solid var(--border)',
        color: isLightDay ? '#fff' : 'var(--text-primary)',
      }}>
        {isLightDay ? (
          <>
            <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.8, margin: '0 0 6px' }}>
              {lang === 'es' ? 'Sugerencia para hoy' : "Today's Suggestion"}
            </p>
            <p style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 10px' }}>
              {suggestedRooms.length} {lang === 'es' ? 'habitaciones' : 'rooms'}
            </p>
            <div className="scroll-pills" style={{ display: 'flex', gap: '10px', marginBottom: '12px', overflowX: 'auto', paddingBottom: '4px', touchAction: 'pan-x', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }}>
              {suggestedRooms.map(r => {
                const reason = r.daysSince === Infinity
                  ? (lang === 'es' ? 'Nunca limpiado' : 'Never cleaned')
                  : `${r.daysSince - freq}d ${lang === 'es' ? 'atrasado' : 'overdue'}`;
                return (
                  <button
                    key={r.roomNumber}
                    onClick={() => { setAssignRoom(r.roomNumber); setSelectedTeam([]); }}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
                      padding: '14px 18px', background: 'rgba(255,255,255,0.15)', borderRadius: '14px',
                      minWidth: '100px', flexShrink: 0, border: 'none', cursor: 'pointer',
                      color: 'inherit', transition: 'background 0.15s',
                    }}
                  >
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '24px' }}>
                      {r.roomNumber}
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 600, opacity: 0.8, textAlign: 'center', lineHeight: 1.2 }}>
                      {reason}
                    </span>
                  </button>
                );
              })}
            </div>
            <p style={{ fontSize: '12px', opacity: 0.8, margin: 0 }}>
              {dndCount > 0 && (lang === 'es' ? `${dndCount} DND liberan tiempo` : `${dndCount} DND rooms free up time`)}
              {dndCount > 0 && checkoutCount < 25 && ' · '}
              {checkoutCount < 25 && (lang === 'es' ? `Solo ${checkoutCount} checkouts` : `Only ${checkoutCount} checkouts`)}
              {dayOfWeek === 1 && (dndCount > 0 || checkoutCount < 25 ? ' · ' : '') + (lang === 'es' ? 'Lunes — día más ligero' : 'Monday — lightest day')}
            </p>
          </>
        ) : (
          <>
            <p style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 4px' }}>
              {lang === 'es' ? 'Hoy se ve ocupado' : 'Today looks busy'}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
              {lang === 'es'
                ? `${checkoutCount} checkouts. Limpieza profunda no recomendada. Próximo día ligero: Lunes.`
                : `${checkoutCount} checkouts. Deep cleaning not recommended. Next light day: Monday.`}
            </p>
          </>
        )}
      </div>

      {/* ── In Progress ── */}
      {inProgressRooms.length > 0 && (
        <div className="animate-in stagger-2">
          <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--amber)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Clock size={12} /> {lang === 'es' ? 'En progreso' : 'In Progress'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {inProgressRooms.map(r => (
              <div key={r.roomNumber} style={{
                padding: '14px 16px', background: 'var(--bg-card)', border: '2px solid var(--amber)',
                borderRadius: 'var(--radius-lg)', display: 'flex', alignItems: 'center', gap: '12px',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '20px', color: 'var(--text-primary)' }}>
                      {r.roomNumber}
                    </span>
                    <span style={{ padding: '2px 8px', borderRadius: '100px', fontSize: '11px', fontWeight: 700, background: 'rgba(245,158,11,0.1)', color: 'var(--amber)' }}>
                      {lang === 'es' ? 'En progreso' : 'In Progress'}
                    </span>
                  </div>
                  {r.team.length > 0 && (
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                      {r.team.join(', ')}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => setCompleteRoom(r.roomNumber)}
                  style={{
                    padding: '12px 18px', borderRadius: '10px', border: 'none',
                    background: 'var(--green)', color: '#fff', fontWeight: 700, fontSize: '14px',
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

      {/* ── Add Rooms Button ── */}
      <button
        onClick={() => { setShowAddRooms(true); setAddRoomsFloor(null); }}
        className="animate-in stagger-2"
        style={{
          width: '100%', padding: '16px', borderRadius: 'var(--radius-lg)',
          border: '2px dashed var(--border)', background: 'var(--bg-card)',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          minHeight: '56px', fontSize: '15px', fontWeight: 700, color: 'var(--navy)',
        }}
      >
        <Plus size={18} /> {lang === 'es' ? 'Agregar habitaciones' : 'Add Rooms'}
      </button>

      {/* ── Add Rooms Modal ── */}
      {showAddRooms && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => { setShowAddRooms(false); setAddRoomsFloor(null); }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            width: '420px', maxWidth: 'calc(100vw - 40px)', maxHeight: '70vh',
            background: 'var(--bg-card)', borderRadius: '16px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '0', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}>
            {/* Modal header */}
            <div style={{ padding: '18px 20px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              {addRoomsFloor !== null ? (
                <button
                  onClick={() => setAddRoomsFloor(null)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', padding: '0', minHeight: '44px' }}
                >
                  <ChevronLeft size={18} color="var(--navy)" />
                  <span style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {lang === 'es' ? `Piso ${addRoomsFloor}` : `Floor ${addRoomsFloor}`}
                  </span>
                </button>
              ) : (
                <span style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {lang === 'es' ? 'Seleccionar piso' : 'Select Floor'}
                </span>
              )}
              <button
                onClick={() => { setShowAddRooms(false); setAddRoomsFloor(null); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '8px', minHeight: '44px', display: 'flex', alignItems: 'center' }}
              >
                <XCircle size={20} color="var(--text-muted)" />
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
                        padding: '16px 20px', borderBottom: '1px solid var(--border)',
                        background: 'none', border: 'none', borderBottomStyle: 'solid',
                        cursor: 'pointer', minHeight: '60px', textAlign: 'left', width: '100%',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--text-primary)' }}>
                          {lang === 'es' ? `Piso ${fs.floor}` : `Floor ${fs.floor}`}
                        </div>
                        <div style={{ fontSize: '13px', color: fs.descColor, fontWeight: 600, marginTop: '2px' }}>
                          {lang === 'es' ? fs.descEs : fs.desc}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                          {fs.total} {lang === 'es' ? 'hab.' : 'rooms'}
                        </span>
                        <ChevronRight size={16} color="var(--text-muted)" />
                      </div>
                    </button>
                  ))}
                  <button
                    onClick={() => setShowCycleModal(true)}
                    style={{
                      fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px',
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
                        padding: '16px 20px', borderBottom: '1px solid var(--border)',
                        background: room.inProgress ? 'rgba(245,158,11,0.04)' : undefined,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '18px', color: 'var(--text-primary)' }}>
                              {room.roomNumber}
                            </span>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: desc.color }}>
                              {lang === 'es' ? desc.textEs : desc.text}
                            </span>
                          </div>
                          {room.lastCleaned && (
                            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                              {lang === 'es' ? 'Última:' : 'Last:'} {room.daysSince}d {lang === 'es' ? 'atrás' : 'ago'}
                              {room.cleanedBy ? (
                                <>
                                  {' · '}
                                  <span
                                    onClick={(e) => { e.stopPropagation(); setEditRoom(room.roomNumber); setEditDate(room.lastCleaned ?? ''); setEditCleanedBy(room.cleanedBy ?? ''); }}
                                    style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', cursor: 'pointer', color: 'var(--text-secondary)' }}
                                  >
                                    {room.cleanedBy}
                                  </span>
                                </>
                              ) : ''}
                            </p>
                          )}
                          {room.inProgress && room.team.length > 0 && (
                            <p style={{ fontSize: '12px', color: 'var(--amber)', marginTop: '2px' }}>{room.team.join(', ')}</p>
                          )}
                        </div>
                        {/* Action buttons */}
                        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                          {/* Add/Edit Date button */}
                          <button
                            onClick={() => { setEditRoom(room.roomNumber); setEditDate(room.lastCleaned ?? ''); setEditCleanedBy(room.cleanedBy ?? ''); }}
                            style={{
                              padding: '10px 12px', borderRadius: '10px',
                              border: '1.5px solid var(--border)', background: 'var(--bg)',
                              fontWeight: 600, fontSize: '12px', color: 'var(--text-secondary)',
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
                                background: 'var(--green)', color: '#fff', fontWeight: 700, fontSize: '13px',
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
                                background: 'var(--navy)', color: '#fff', fontWeight: 700, fontSize: '13px',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px',
                                minHeight: '44px',
                              }}
                            >
                              <Users size={14} />
                              {lang === 'es' ? 'Asignar' : 'Assign'}
                            </button>
                          ) : (
                            <div style={{ width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <CheckCircle2 size={18} color="var(--green)" />
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

      {/* ── Recently Completed ── */}
      {recentlyDone.length > 0 && (
        <div className="animate-in">
          <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '8px' }}>
            {lang === 'es' ? 'Completadas recientemente' : 'Recently Completed'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {recentlyDone.map(room => (
              <div key={room.roomNumber} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '12px 14px', background: 'var(--bg-card)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', minHeight: '48px',
              }}>
                <CheckCircle2 size={16} color="var(--green)" />
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)' }}>
                  {room.roomNumber}
                </span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', flex: 1 }}>
                  {room.daysSince === 0 ? (lang === 'es' ? 'Hoy' : 'Today') : `${room.daysSince}d ${lang === 'es' ? 'atrás' : 'ago'}`}
                  {room.cleanedBy ? (
                    <>
                      {' · '}
                      <span
                        onClick={() => { setEditRoom(room.roomNumber); setEditDate(room.lastCleaned ?? ''); setEditCleanedBy(room.cleanedBy ?? ''); }}
                        style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', cursor: 'pointer', color: 'var(--text-secondary)' }}
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

      {/* ── Assign Team Modal ── */}
      {assignRoom && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9997 }} onClick={() => { setAssignRoom(null); setSelectedTeam([]); }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 9998,
            background: 'var(--bg-card)', borderRadius: '16px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '20px', width: '340px', maxWidth: 'calc(100vw - 40px)', maxHeight: '80vh', overflowY: 'auto',
          }}>
            <p style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
              {lang === 'es' ? `Asignar equipo — ${assignRoom}` : `Assign Team — ${assignRoom}`}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 14px' }}>
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
                      padding: '12px 14px', borderRadius: '10px',
                      border: isSelected ? '2px solid var(--navy)' : '1.5px solid var(--border)',
                      background: isSelected ? 'rgba(37,99,235,0.06)' : 'var(--bg)',
                      cursor: 'pointer', minHeight: '48px', textAlign: 'left',
                    }}
                  >
                    <div style={{
                      width: '36px', height: '36px', borderRadius: '10px',
                      background: isSelected ? 'var(--navy)' : 'var(--bg-elevated)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: isSelected ? '#fff' : 'var(--text-muted)', fontWeight: 700, fontSize: '13px', flexShrink: 0,
                    }}>
                      {isSelected ? <Check size={16} /> : s.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>{s.name}</div>
                      {s.doneForDay && (
                        <div style={{ fontSize: '11px', color: 'var(--green)', fontWeight: 600 }}>
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
                width: '100%', padding: '14px', borderRadius: 'var(--radius-md)',
                background: selectedTeam.length > 0 ? 'var(--navy)' : 'var(--border)',
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
            background: 'var(--bg-card)', borderRadius: '16px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '24px', width: '320px', maxWidth: 'calc(100vw - 40px)', textAlign: 'center',
          }}>
            <CheckCircle2 size={40} color="var(--green)" style={{ margin: '0 auto 12px' }} />
            <p style={{ fontSize: '17px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
              {lang === 'es' ? `¿Completar ${completeRoom}?` : `Complete ${completeRoom}?`}
            </p>
            {records[completeRoom]?.cleanedByTeam && (
              <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: '0 0 16px' }}>
                {lang === 'es' ? 'Equipo:' : 'Team:'} {records[completeRoom].cleanedByTeam!.join(', ')}
              </p>
            )}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setCompleteRoom(null)}
                style={{
                  flex: 1, padding: '14px', borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', fontWeight: 600, fontSize: '14px',
                  cursor: 'pointer', minHeight: '48px',
                }}
              >
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={() => handleComplete(completeRoom)}
                disabled={saving}
                style={{
                  flex: 1, padding: '14px', borderRadius: 'var(--radius-md)',
                  background: 'var(--green)', color: '#fff', border: 'none',
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
            background: 'var(--bg-card)', borderRadius: '16px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '20px', width: '320px', maxWidth: 'calc(100vw - 40px)',
          }}>
            <p style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 4px' }}>
              {lang === 'es' ? `Editar — ${editRoom}` : `Edit — ${editRoom}`}
            </p>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 14px' }}>
              {lang === 'es' ? 'Cambiar fecha y quién lo limpió.' : 'Change date and who cleaned it.'}
            </p>
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px', display: 'block' }}>
              {lang === 'es' ? 'Fecha' : 'Date'}
            </label>
            <input
              type="date"
              value={editDate}
              onChange={e => setEditDate(e.target.value)}
              style={{
                width: '100%', padding: '12px', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)', background: 'var(--bg)',
                fontSize: '15px', minHeight: '48px', marginBottom: '12px',
                boxSizing: 'border-box',
              }}
            />
            <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px', display: 'block' }}>
              {lang === 'es' ? 'Limpiado por' : 'Cleaned by'}
            </label>
            <select
              value={editCleanedBy}
              onChange={e => setEditCleanedBy(e.target.value)}
              style={{
                width: '100%', padding: '12px', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)', background: 'var(--bg)',
                fontSize: '15px', minHeight: '48px', marginBottom: '12px',
                boxSizing: 'border-box', color: editCleanedBy ? 'var(--text-primary)' : 'var(--text-muted)',
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
                  flex: 1, padding: '12px', borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', fontWeight: 600, fontSize: '14px',
                  cursor: 'pointer', minHeight: '48px',
                }}
              >
                {lang === 'es' ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                onClick={() => handleEditDate(editRoom)}
                disabled={!editDate || saving}
                style={{
                  flex: 1, padding: '12px', borderRadius: 'var(--radius-md)',
                  background: editDate ? 'var(--navy)' : 'var(--border)',
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
            background: 'var(--bg-card)', borderRadius: '16px', boxShadow: '0 8px 40px rgba(0,0,0,0.2)',
            padding: '20px', width: '300px', maxWidth: 'calc(100vw - 40px)',
          }}>
            <p style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 14px' }}>
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
                      padding: '14px', borderRadius: 'var(--radius-md)',
                      border: isSelected ? '2px solid var(--navy)' : '1.5px solid var(--border)',
                      background: isSelected ? 'rgba(37,99,235,0.06)' : 'var(--bg)',
                      fontWeight: isSelected ? 700 : 500, fontSize: '14px',
                      color: isSelected ? 'var(--navy)' : 'var(--text-primary)',
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
                padding: '10px 14px', borderRadius: 'var(--radius-md)',
                border: (freq && ![30, 60, 90, 120].includes(freq)) ? '2px solid var(--navy)' : '1.5px solid var(--border)',
                background: (freq && ![30, 60, 90, 120].includes(freq)) ? 'rgba(37,99,235,0.06)' : 'var(--bg)',
                minHeight: '48px',
              }}>
                <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
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
                    border: '1.5px solid var(--border)', background: 'var(--bg)',
                    fontSize: '14px', color: 'var(--text-primary)',
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
                    background: customCycleDays && parseInt(customCycleDays, 10) > 0 ? 'var(--navy)' : 'var(--border)',
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
          background: 'var(--navy)', color: '#fff', padding: '12px 20px',
          borderRadius: '10px', fontSize: '14px', fontWeight: 600,
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

  return (
    <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* View toggle */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {([
          { key: 'live' as ViewMode, label: lang === 'es' ? 'En Vivo' : 'Live' },
          { key: '7d'  as ViewMode, label: '7d' },
          { key: '14d' as ViewMode, label: '14d' },
          { key: '30d' as ViewMode, label: '30d' },
          { key: '3mo' as ViewMode, label: '3mo' },
          { key: '1yr' as ViewMode, label: '1yr' },
          { key: 'all' as ViewMode, label: lang === 'es' ? 'Todo' : 'All' },
        ]).map(({ key, label }) => (
          <button key={key} onClick={() => setView(key)} className={`chip${view === key ? ' chip-active' : ''}`} style={{ height: '30px', paddingLeft: '10px', paddingRight: '10px', cursor: 'pointer', fontSize: '12px' }}>
            {label}
          </button>
        ))}
      </div>

      {/* LIVE VIEW */}
      {view === 'live' && (
        <>
          {(livePerfs.length > 0 || todayDone > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px' }}>
              {[
                { label: t('roomsDone', lang),    value: `${todayDone}/${rooms.length}`, color: 'var(--green)' },
                { label: t('housekeepers', lang), value: String(livePerfs.filter(p => p.done > 0).length), color: 'var(--amber)' },
                { label: t('avgCleanTime', lang), value: todayTurnaround !== null ? `${todayTurnaround}m` : '-', color: 'var(--text-secondary)' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 10px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.35rem', color, lineHeight: 1, letterSpacing: '-0.03em' }}>{value}</div>
                  <div className="label" style={{ marginTop: '7px', marginBottom: 0, fontSize: '10px' }}>{label}</div>
                </div>
              ))}
            </div>
          )}

          {livePerfs.length === 0 && unassignedToday.length === 0 && (
            <div style={{ textAlign: 'center', padding: '52px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px', background: 'rgba(0,0,0,0.04)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Users size={28} color="var(--text-muted)" />
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 500 }}>{t('noActivityToday', lang)}</p>
            </div>
          )}

          {livePerfs.length > 0 && (
            <>
              <p style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '-6px' }}>{t('leaderboard', lang)}</p>
              {livePerfs.map((p, i) => (
                <div key={p.staffId} className={`card animate-in stagger-${Math.min(i + 2, 4)}`} style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                    <RankBadge rank={i + 1} />
                    <HKInitials name={p.name} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                      {p.shiftStart ? (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                          {p.shiftEnd ? `${format(p.shiftStart, 'h:mm a')} → ${format(p.shiftEnd, 'h:mm a')} · ${fmtMins(Math.round((p.shiftEnd.getTime() - p.shiftStart.getTime()) / 60_000))}` : `${lang === 'es' ? 'Iniciado' : 'Started'} ${format(p.shiftStart, 'h:mm a')} · ${lang === 'es' ? 'en progreso' : 'in progress'}`}
                        </p>
                      ) : null}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '26px', color: 'var(--green)', lineHeight: 1, letterSpacing: '-0.03em' }}>{p.done}</div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>/ {p.totalAssigned}</div>
                    </div>
                  </div>
                  {p.totalAssigned > 0 && (
                    <div style={{ marginBottom: '10px' }}>
                      <div style={{ height: '6px', borderRadius: '3px', background: 'var(--border)', overflow: 'hidden', display: 'flex' }}>
                        <div style={{ width: `${(p.checkoutsDone / p.totalAssigned) * 100}%`, background: 'var(--green)', transition: 'width 400ms ease' }} />
                        <div style={{ width: `${(p.stayoversDone / p.totalAssigned) * 100}%`, background: 'var(--green-light, #34D399)', transition: 'width 400ms ease' }} />
                      </div>
                      <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}><span style={{ color: 'var(--green)', fontWeight: 600 }}>{t('checkoutsShort', lang)}</span> {p.checkoutsDone}/{p.checkoutsAssigned}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}><span style={{ color: 'var(--green-light, #34D399)', fontWeight: 600 }}>{t('stayoversShort', lang)}</span> {p.stayoversDone}/{p.stayoversAssigned}</span>
                      </div>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <StatPill label={t('avgCleanTime', lang)} value={p.avgCleanMins !== null ? `${p.avgCleanMins}m` : '-'} />
                    <StatPill label={t('roomsPerHr', lang)} value={p.roomsPerHr !== null ? String(p.roomsPerHr) : '-'} highlight={p.roomsPerHr !== null} />
                    <PaceBadge pace={p.pace} lang={lang} />
                  </div>
                </div>
              ))}
            </>
          )}

          {unassignedToday.length > 0 && (
            <div className="card" style={{ padding: '16px' }}>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '10px' }}>{t('noActivityToday', lang)}</p>
              {unassignedToday.map((s, i) => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 0', borderBottom: i < unassignedToday.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <HKInitials name={s.name} />
                  <p style={{ fontSize: '14px', color: 'var(--text-secondary)', fontWeight: 500 }}>{s.name}</p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'live' && <LeaderboardCard rooms={rooms} lang={lang} />}

      {/* HISTORY VIEW */}
      {view !== 'live' && (
        <>
          {historyLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
              <div className="spinner" style={{ width: '30px', height: '30px' }} />
            </div>
          ) : historyPerfs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '52px 20px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px', background: 'rgba(0,0,0,0.04)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Clock size={28} color="var(--text-muted)" />
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '15px', fontWeight: 500 }}>{t('noHistoryYet', lang)}</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '6px' }}>
                {lang === 'es' ? `Los datos aparecerán aquí después de que el equipo complete habitaciones en los últimos ${viewDays} días.` : `Data will appear here after the team completes rooms over the past ${viewDays} days.`}
              </p>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px' }}>
                {[
                  { label: t('roomsDone', lang),    value: String(historyPerfs.reduce((s, p) => s + p.totalDone, 0)), color: 'var(--green)' },
                  { label: t('topPerformer', lang),  value: topHistoryPerf ? topHistoryPerf.name.split(' ')[0] : '-', color: 'var(--amber)' },
                  { label: t('avgPerDay', lang),     value: historyPerfs.length > 0 ? String(Math.round(historyPerfs.reduce((s, p) => s + p.avgPerDay, 0) / historyPerfs.length * 10) / 10) : '-', color: 'var(--text-secondary)' },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 10px', textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '1.25rem', color, lineHeight: 1, letterSpacing: '-0.03em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
                    <div className="label" style={{ marginTop: '7px', marginBottom: 0, fontSize: '10px' }}>{label}</div>
                  </div>
                ))}
              </div>

              {(() => {
                const maxDone = Math.max(...historyPerfs.map(p => p.totalDone), 1);
                return historyPerfs.map((p, i) => (
                  <div key={p.staffId} className={`card animate-in stagger-${Math.min(i + 2, 4)}`} style={{ padding: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                      <RankBadge rank={i + 1} />
                      <HKInitials name={p.name} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{p.daysActive} {lang === 'es' ? (p.daysActive === 1 ? 'día activo' : 'días activos') : (p.daysActive === 1 ? 'day active' : 'days active')}</p>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '24px', color: 'var(--green)', lineHeight: 1, letterSpacing: '-0.03em' }}>{p.totalDone}</div>
                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{lang === 'es' ? 'hab.' : 'rooms'}</div>
                      </div>
                    </div>
                    <div style={{ height: '5px', borderRadius: '3px', background: 'var(--border)', marginBottom: '10px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: '3px', background: i === 0 ? 'var(--amber)' : 'var(--green)', width: `${(p.totalDone / maxDone) * 100}%`, transition: 'width 500ms ease' }} />
                    </div>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <StatPill label={t('avgPerDay', lang)} value={`${p.avgPerDay}`} highlight={i === 0} />
                      <StatPill label={t('avgCleanTime', lang)} value={p.avgCleanMins !== null ? `${p.avgCleanMins}m` : '-'} />
                      <StatPill label={t('checkoutsShort', lang)} value={String(p.checkoutsDone)} />
                      <StatPill label={t('stayoversShort', lang)} value={String(p.stayoversDone)} />
                    </div>
                  </div>
                ));
              })()}
            </>
          )}
        </>
      )}
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
          display: 'flex', gap: '4px', padding: '4px',
          background: 'rgba(148,163,184,0.12)', borderRadius: '8px',
          width: 'fit-content',
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
                  padding: '6px 16px',
                  border: isActive ? '1px solid rgba(226,232,240,0.5)' : '1px solid transparent',
                  borderRadius: '6px',
                  background: isActive ? '#ffffff' : 'transparent',
                  color: isActive ? '#0f172a' : '#64748b',
                  fontWeight: isActive ? 700 : 600,
                  fontSize: '12px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-sans)',
                  transition: 'all 120ms',
                  boxShadow: isActive ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
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
