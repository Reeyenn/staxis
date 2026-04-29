// Split from the housekeeping/page.tsx monolith on 2026-04-27.
// Shared helpers / constants / components are imported from ./_shared.
// Only this tab's section logic lives here.

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

import {
  TABS,
  schedTodayStr, addDays, defaultShiftDate, formatPulledAt, formatDisplayDate,
  isEligible, PRIORITY_ORDER, snapshotToShiftRooms, autoSelectEligible,
  STAFF_COLORS,
  toDate, fmtMins, HKInitials, buildLive, buildHistory,
  PaceBadge, RankBadge, StatPill,
  EMPTY_FORM, staffInitials,
  getFloor, ROOM_ACTION_COLOR,
  paFloorLabel, freqLabel, FrequencySlider, AREA_NAME_ES, areaDisplayName,
  PublicAreasModal, PA_FLOOR_VALUES, SLIDER_MAX,
} from './_shared';
import type { TabKey, HKLive, HKHistory, StaffFormData } from './_shared';

function DeepCleanTab() {
  const { user } = useAuth();
  const { activePropertyId, activeProperty, staff } = useProperty();
  const { lang } = useLang();
  // Reactive YYYY-MM-DD string used for the rooms subscription. Different
  // variable name from the local `today` Date below (used for cycle math)
  // to avoid shadowing.
  const todayStrReactive = useTodayStr();

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
  // `today` is pinned per-mount via useMemo. Without this, `new Date()` runs
  // on every render and downstream useMemo hooks treat it as a changed dep,
  // re-running their (expensive) calculations every render. The component
  // re-mounts on day rollover via the route's date-aware key, so we don't
  // need to track midnight transitions inside this state.
  const today = useMemo(() => new Date(), []);
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
    // Subscribe to today's rooms for occupancy data. `todayStrReactive` is
    // reactive so the channel is rebuilt at midnight rather than silently
    // keeping yesterday's bucket open on a long-running session.
    const unsub = subscribeToRooms(uid, pid, todayStrReactive, setTodayRooms);
    return unsub;
  }, [uid, pid, todayStrReactive]);

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
      const { setDeepCleanRecord } = await import('@/lib/db');
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

export { DeepCleanTab };
