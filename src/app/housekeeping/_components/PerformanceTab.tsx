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
  // Cleaning events (Migration 0012) — powers the Performance tab.
  getCleaningEventsForRange,
  getFlaggedCleaningEvents,
  decideOnFlaggedEvent,
  subscribeToTodayCleaningEvents,
} from '@/lib/db';
import type { PlanSnapshot, ScheduleAssignments, CsvRoomSnapshot, DashboardNumbers, CleaningEvent } from '@/lib/db';
import { dashboardFreshness, DASHBOARD_STALE_MINUTES } from '@/lib/db';
import { getPublicAreasDueToday, calcPublicAreaMinutes, autoAssignRooms, getOverdueRooms, calcDndFreedMinutes, suggestDeepCleans } from '@/lib/calculations';
import { getDefaultPublicAreas } from '@/lib/defaults';
import type { PublicArea } from '@/types';
import { todayStr, errToString } from '@/lib/utils';
import { useTodayStr } from '@/lib/use-today-str';
import type { Room, RoomStatus, RoomType, RoomPriority, StaffMember, DeepCleanRecord, DeepCleanConfig, ShiftConfirmation, ConfirmationStatus, WorkOrder } from '@/types';
import { format, subDays } from 'date-fns';
import { es as esLocale } from 'date-fns/locale';
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


// ══════════════════════════════════════════════════════════════════════════════
// PERFORMANCE SECTION
//
// Powered by `cleaning_events` (Migration 0012). Each row is one immutable
// "Done" tap from the housekeeper page. The legacy logic below USED to read
// from `rooms` directly — but that table gets its started_at/completed_at
// wiped on every populate-rooms-from-plan re-pull, so durations were
// silently zeroed out within minutes of being captured. The audit log
// fixes that.
//
// Leaderboard rules locked in 2026-04-27 with Reeyen:
//   • Rank by overall avg clean time, ascending (fastest = #1).
//   • 3-room minimum to appear ranked (prevents gaming with 1 fast clean).
//   • Show: rooms count, checkout avg, S1 avg, S2 avg, overall avg, rate.
//   • Inactive staff hidden from leaderboard (history persists in DB).
// Flag review:
//   • Cleans > 60 min are flagged. Mario clicks Keep / Discard. Permanent.
//   • Discarded (<3 min, accidental) entries auto-excluded from averages.
// ══════════════════════════════════════════════════════════════════════════════

type ViewMode = 'live' | '7d' | '14d' | '30d' | '3mo' | '1yr' | 'all';

const VIEW_DAYS: Record<ViewMode, number> = { live: 1, '7d': 7, '14d': 14, '30d': 30, '3mo': 90, '1yr': 365, all: 730 };

// 3-room minimum for the ranked leaderboard. Anyone below this shows in the
// "Provisional" sidebar so Mario can see they're contributing, but they
// can't be #1 with a single 12-minute clean.
const LEADERBOARD_MIN_ROOMS = 3;

// Format minutes as "MM:SS" — matches the existing dashboard typography.
function formatMin(mins: number | null | undefined): string {
  if (mins === null || mins === undefined || !isFinite(mins)) return '--:--';
  const total = Math.max(0, mins);
  const m = Math.floor(total);
  const s = Math.round((total - m) * 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface StaffStats {
  staffId: string;
  name: string;
  total: number;
  totalMins: number;
  avgMins: number;
  avgCheckout: number | null;
  avgS1: number | null;
  avgS2: number | null;
  roomsPerHour: number;
  checkoutN: number;
  s1N: number;
  s2N: number;
}

function PerformanceTab() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, staff, staffLoaded } = useProperty();
  const { lang } = useLang();
  const today = useTodayStr();

  const [view, setView] = useState<ViewMode>('live');
  const [events, setEvents] = useState<CleaningEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [flagged, setFlagged] = useState<CleaningEvent[]>([]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // Targets for the 3 efficiency cards. Falls back to legacy stayoverMinutes
  // if a property pre-dates the day1/day2 split (older seed data).
  const checkoutTarget = activeProperty?.checkoutMinutes ?? 30;
  const s1Target = activeProperty?.stayoverDay1Minutes ?? 15;
  const s2Target = activeProperty?.stayoverDay2Minutes ?? activeProperty?.stayoverMinutes ?? 20;

  // Active staff — used to filter the leaderboard. Inactive housekeepers'
  // historical entries persist in cleaning_events but they're hidden from
  // the live ranking. `isActive !== false` treats undefined as active too.
  //
  // Until the staff context finishes loading we can't reliably filter — an
  // empty Set would hide every housekeeper's entries. Returning null here
  // signals "filter is not ready, include everyone" downstream.
  const activeStaffIds = useMemo<Set<string> | null>(
    () => staffLoaded ? new Set(staff.filter(s => s.isActive !== false).map(s => s.id)) : null,
    [staff, staffLoaded]
  );

  // ── Load events for the current view ──────────────────────────────────────
  // Live: realtime subscription to today's events (new cleans appear instantly).
  // History: one-shot fetch over the rolling window.
  useEffect(() => {
    if (!user || !activePropertyId) return;
    if (view === 'live') {
      return subscribeToTodayCleaningEvents(activePropertyId, today, setEvents);
    }
    const days = VIEW_DAYS[view];
    const fromDate = format(subDays(new Date(), days - 1), 'yyyy-MM-dd');
    let cancelled = false;
    setHistoryLoading(true);
    getCleaningEventsForRange(activePropertyId, fromDate, today)
      .then(rows => { if (!cancelled) setEvents(rows); })
      .catch(err => console.error('[PerformanceTab] load events failed:', err))
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [user, activePropertyId, view, today]);

  // ── Flag-review queue (separate from the view filter) ─────────────────────
  // Always shows ALL pending flags regardless of date range. A 4-hour clean
  // from 30 days ago should still be reviewable. Polled every 30s as a
  // belt-and-suspenders against missed realtime events.
  useEffect(() => {
    if (!activePropertyId) return;
    let cancelled = false;
    const refresh = () => {
      getFlaggedCleaningEvents(activePropertyId)
        .then(rows => { if (!cancelled) setFlagged(rows); })
        .catch(err => console.error('[PerformanceTab] load flagged failed:', err));
    };
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activePropertyId]);

  // ── Leaderboard math ─────────────────────────────────────────────────────
  // Eligible = 'recorded' (clean entry) + 'approved' (Mario kept after flag).
  // Excluded: 'discarded' (auto-purged), 'flagged' (still pending), 'rejected' (Mario threw out).
  const eligibleEvents = useMemo(
    () => events.filter(e => e.status === 'recorded' || e.status === 'approved'),
    [events]
  );

  const leaderboard: StaffStats[] = useMemo(() => {
    const byStaff = new Map<string, StaffStats & { _check: number; _s1: number; _s2: number }>();
    for (const ev of eligibleEvents) {
      // Skip events where the staff has been deactivated. Their old entries
      // remain in the audit log for historical accuracy.
      // Skip events for deactivated staff. When activeStaffIds is null
      // (staff context still loading) we include everyone — the alternative
      // is a transient empty leaderboard during page load.
      if (activeStaffIds && ev.staffId && !activeStaffIds.has(ev.staffId)) continue;
      const key = ev.staffId ?? `name:${ev.staffName}`;
      const e = byStaff.get(key) ?? {
        staffId: ev.staffId ?? key,
        name: ev.staffName,
        total: 0, totalMins: 0,
        avgMins: 0, avgCheckout: null, avgS1: null, avgS2: null,
        roomsPerHour: 0,
        checkoutN: 0, s1N: 0, s2N: 0,
        _check: 0, _s1: 0, _s2: 0,
      };
      e.total++;
      e.totalMins += ev.durationMinutes;
      if (ev.roomType === 'checkout') {
        e._check += ev.durationMinutes; e.checkoutN++;
      } else if (ev.stayoverDay === 1) {
        e._s1 += ev.durationMinutes; e.s1N++;
      } else if (ev.stayoverDay === 2) {
        e._s2 += ev.durationMinutes; e.s2N++;
      }
      byStaff.set(key, e);
    }
    return Array.from(byStaff.values())
      .filter(e => e.total >= LEADERBOARD_MIN_ROOMS)
      .map(e => ({
        staffId: e.staffId,
        name: e.name,
        total: e.total,
        totalMins: e.totalMins,
        avgMins: e.totalMins / e.total,
        avgCheckout: e.checkoutN > 0 ? e._check / e.checkoutN : null,
        avgS1: e.s1N > 0 ? e._s1 / e.s1N : null,
        avgS2: e.s2N > 0 ? e._s2 / e.s2N : null,
        roomsPerHour: e.totalMins > 0 ? e.total / (e.totalMins / 60) : 0,
        checkoutN: e.checkoutN,
        s1N: e.s1N,
        s2N: e.s2N,
      }))
      .sort((a, b) => a.avgMins - b.avgMins); // Fastest avg → #1
  }, [eligibleEvents, activeStaffIds]);

  // Provisional list — housekeepers logging work but not yet at 3 rooms.
  const provisional = useMemo(() => {
    const byStaff = new Map<string, { name: string; total: number }>();
    for (const ev of eligibleEvents) {
      // Skip events for deactivated staff. When activeStaffIds is null
      // (staff context still loading) we include everyone — the alternative
      // is a transient empty leaderboard during page load.
      if (activeStaffIds && ev.staffId && !activeStaffIds.has(ev.staffId)) continue;
      const key = ev.staffId ?? `name:${ev.staffName}`;
      const entry = byStaff.get(key) ?? { name: ev.staffName, total: 0 };
      entry.total++;
      byStaff.set(key, entry);
    }
    return Array.from(byStaff.values())
      .filter(e => e.total < LEADERBOARD_MIN_ROOMS && e.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [eligibleEvents, activeStaffIds]);

  // ── Efficiency cards (Checkout / S1 / S2) ─────────────────────────────────
  const checkoutAvg = useMemo(() => {
    const rows = eligibleEvents.filter(e => e.roomType === 'checkout');
    if (rows.length === 0) return null;
    return rows.reduce((s, e) => s + e.durationMinutes, 0) / rows.length;
  }, [eligibleEvents]);
  const s1Avg = useMemo(() => {
    const rows = eligibleEvents.filter(e => e.roomType === 'stayover' && e.stayoverDay === 1);
    if (rows.length === 0) return null;
    return rows.reduce((s, e) => s + e.durationMinutes, 0) / rows.length;
  }, [eligibleEvents]);
  const s2Avg = useMemo(() => {
    const rows = eligibleEvents.filter(e => e.roomType === 'stayover' && e.stayoverDay === 2);
    if (rows.length === 0) return null;
    return rows.reduce((s, e) => s + e.durationMinutes, 0) / rows.length;
  }, [eligibleEvents]);

  // ── AI Operational Insight (templated stat readout, not a real LLM) ──────
  const aiInsightText = useMemo(() => {
    if (eligibleEvents.length === 0) {
      return lang === 'es'
        ? 'No hay suficientes datos para generar información.'
        : 'Not enough data to generate insights yet.';
    }
    const total = eligibleEvents.length;
    const top = leaderboard[0];
    if (!top) {
      return lang === 'es'
        ? `${total} habitaciones limpiadas en este período. Aún no hay un líder claro (mínimo 3 habitaciones).`
        : `${total} rooms cleaned this period. No clear leader yet (3-room minimum).`;
    }
    return lang === 'es'
      ? `${total} habitaciones limpiadas este período. ${top.name} lidera con ${formatMin(top.avgMins)} promedio en ${top.total} habitaciones.`
      : `${total} rooms cleaned this period. ${top.name} leads at ${formatMin(top.avgMins)} avg across ${top.total} rooms.`;
  }, [eligibleEvents, leaderboard, lang]);

  // ── CSV export ──────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    if (events.length === 0) return;
    const fromDate = view === 'live' ? today : format(subDays(new Date(), VIEW_DAYS[view] - 1), 'yyyy-MM-dd');
    const filename = `cleaning-events_${fromDate}_to_${today}.csv`;
    const headers = ['date', 'room', 'type', 'cycle', 'housekeeper', 'started_at', 'completed_at', 'duration_minutes', 'status'];
    const rows = events.map(e => [
      e.date,
      e.roomNumber,
      e.roomType,
      e.stayoverDay === 1 ? 'S1' : e.stayoverDay === 2 ? 'S2' : (e.roomType === 'checkout' ? 'CO' : ''),
      e.staffName,
      e.startedAt.toISOString(),
      e.completedAt.toISOString(),
      e.durationMinutes.toFixed(2),
      e.status,
    ]);
    const csv = [headers, ...rows]
      .map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [events, view, today]);

  // ── Flag-review actions ─────────────────────────────────────────────────
  const handleDecide = async (eventId: string, decision: 'approved' | 'rejected') => {
    if (!user || reviewingId) return;
    setReviewingId(eventId);
    try {
      await decideOnFlaggedEvent(eventId, decision, user.uid);
      // Optimistically remove from the queue. The 30s poll will reconcile
      // if anything's wrong, but Mario sees instant feedback.
      setFlagged(prev => prev.filter(e => e.id !== eventId));
      // If this event is in the current view's data, update its status so
      // the leaderboard recalculates without a full refetch.
      setEvents(prev => prev.map(e => e.id === eventId ? { ...e, status: decision } : e));
    } catch (err) {
      console.error('[PerformanceTab] decide failed:', err);
    } finally {
      setReviewingId(null);
    }
  };

  const viewDays = VIEW_DAYS[view];

  // Column grid for the leaderboard — kept in one place so header + rows
  // stay aligned. 8 columns: rank, specialist, rooms, C/O, S1, S2, avg, rate.
  const LB_GRID = '40px 1.2fr 60px 70px 60px 60px 80px 80px';

  return (
    <div style={{ padding: '24px', maxWidth: '1600px', margin: '0 auto', minHeight: 'calc(100dvh - 120px)' }}>

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
                <button
                  onClick={handleExport}
                  disabled={events.length === 0}
                  style={{
                    color: events.length > 0 ? '#364262' : '#a3a3a3', fontWeight: 600, fontSize: '14px',
                    display: 'flex', alignItems: 'center', gap: '4px',
                    background: 'none', border: 'none',
                    cursor: events.length > 0 ? 'pointer' : 'not-allowed',
                  }}
                >
                  {lang === 'es' ? 'Exportar Reporte' : 'Export Report'} <span style={{ fontSize: '16px' }}>↓</span>
                </button>
              </div>

              {/* Loading state */}
              {view !== 'live' && historyLoading && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                  <div className="spinner" style={{ width: '30px', height: '30px' }} />
                </div>
              )}

              {/* Empty state — no events at all in this window */}
              {events.length === 0 && !(view !== 'live' && historyLoading) && (
                <div style={{ textAlign: 'center', padding: '52px 20px' }}>
                  <div style={{ width: '60px', height: '60px', borderRadius: '16px', margin: '0 auto 14px', background: 'rgba(0,0,0,0.03)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Users size={28} color="#757684" />
                  </div>
                  <p style={{ color: '#454652', fontSize: '15px', fontWeight: 500 }}>{t('noActivityToday', lang)}</p>
                  <p style={{ color: '#757684', fontSize: '13px', marginTop: '6px' }}>
                    {lang === 'es' ? 'Los datos aparecerán cuando los housekeepers marquen habitaciones como Limpias.' : 'Data will appear here as housekeepers mark rooms Done.'}
                  </p>
                </div>
              )}

              {/* Provisional-only state — events exist but no one's hit 3-room minimum */}
              {events.length > 0 && leaderboard.length === 0 && !(view !== 'live' && historyLoading) && (
                <div style={{ textAlign: 'center', padding: '40px 20px' }}>
                  <p style={{ color: '#454652', fontSize: '15px', fontWeight: 500, marginBottom: '8px' }}>
                    {lang === 'es' ? 'Aún no hay clasificación' : 'No ranked specialists yet'}
                  </p>
                  <p style={{ color: '#757684', fontSize: '13px' }}>
                    {lang === 'es'
                      ? `Se necesitan al menos ${LEADERBOARD_MIN_ROOMS} habitaciones limpias para aparecer.`
                      : `At least ${LEADERBOARD_MIN_ROOMS} cleans needed to appear on the leaderboard.`}
                  </p>
                </div>
              )}

              {/* Leaderboard table */}
              {leaderboard.length > 0 && (
                <div>
                  {/* Header row */}
                  <div style={{ display: 'grid', gridTemplateColumns: LB_GRID, gap: '8px', padding: '0 20px 12px', borderBottom: 'none' }}>
                    {[
                      { label: lang === 'es' ? 'Rango' : 'Rank', align: 'left' as const },
                      { label: lang === 'es' ? 'Especialista' : 'Specialist', align: 'left' as const },
                      { label: lang === 'es' ? 'Hab.' : 'Rooms', align: 'right' as const },
                      { label: 'C/O', align: 'right' as const },
                      { label: 'S1', align: 'right' as const },
                      { label: 'S2', align: 'right' as const },
                      { label: lang === 'es' ? 'Prom.' : 'Avg', align: 'right' as const },
                      { label: lang === 'es' ? 'Hab/h' : 'Rate', align: 'right' as const },
                    ].map(({ label, align }) => (
                      <div key={label} style={{ fontSize: '11px', fontWeight: 600, color: '#454652', textTransform: 'uppercase', letterSpacing: '0.08em', textAlign: align }}>
                        {label}
                      </div>
                    ))}
                  </div>

                  {/* Rows — sorted by overall avg ascending (fastest = #1) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                    {leaderboard.map((s, i) => {
                      const initials = s.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
                      const monoCell: React.CSSProperties = { textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontSize: '14px', color: '#1b1c19' };
                      const isLeader = i === 0;
                      return (
                        <div key={s.staffId} style={{
                          display: 'grid', gridTemplateColumns: LB_GRID, gap: '8px', alignItems: 'center',
                          padding: '14px 20px',
                          background: isLeader ? 'rgba(54,66,98,0.04)' : 'rgba(245,243,238,0.4)',
                          border: isLeader ? '1px solid rgba(54,66,98,0.15)' : '1px solid transparent',
                          borderRadius: '16px', transition: 'background 200ms',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ee'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = isLeader ? 'rgba(54,66,98,0.04)' : 'rgba(245,243,238,0.4)'; }}
                        >
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '16px', color: isLeader ? '#364262' : '#454652', fontWeight: isLeader ? 700 : 400 }}>
                            {String(i + 1).padStart(2, '0')}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
                            <div style={{
                              width: '40px', height: '40px', borderRadius: '50%', background: '#eae8e3',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontWeight: 700, fontSize: '13px', color: '#364262', flexShrink: 0,
                              border: '2px solid #ffffff',
                            }}>
                              {initials}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: '14px', color: '#1b1c19', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                              <div style={{ fontSize: '11px', color: '#757684', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                {lang === 'es' ? 'Especialista' : 'Specialist'}
                              </div>
                            </div>
                          </div>
                          <div style={{ ...monoCell, fontWeight: 600 }}>{s.total}</div>
                          <div style={monoCell}>{formatMin(s.avgCheckout)}</div>
                          <div style={monoCell}>{formatMin(s.avgS1)}</div>
                          <div style={monoCell}>{formatMin(s.avgS2)}</div>
                          <div style={{ ...monoCell, color: '#364262', fontWeight: 700 }}>{formatMin(s.avgMins)}</div>
                          <div style={{ ...monoCell, color: '#006565' }}>{s.roomsPerHour.toFixed(1)}</div>
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

            {/* ── Flag Review Queue ────────────────────────────────────────
                Pending flagged cleans (>60 min). Mario clicks Keep / Discard.
                Permanent. Hidden when queue is empty. */}
            {flagged.length > 0 && (
              <div style={{ background: '#ffffff', padding: '28px', borderRadius: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                  <div style={{ width: '32px', height: '32px', borderRadius: '10px', background: 'rgba(186,26,26,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <AlertTriangle size={16} style={{ color: '#ba1a1a' }} />
                  </div>
                  <h3 style={{ fontSize: '17px', fontWeight: 600, color: '#1b1c19', flex: 1 }}>
                    {lang === 'es' ? 'Revisión de Limpiezas Largas' : 'Long-Clean Review'}
                  </h3>
                  <span style={{
                    background: '#ba1a1a', color: '#ffffff', padding: '3px 10px', borderRadius: '9999px',
                    fontSize: '12px', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {flagged.length}
                  </span>
                </div>
                <p style={{ fontSize: '13px', color: '#757684', marginBottom: '16px', lineHeight: 1.5 }}>
                  {lang === 'es'
                    ? 'Limpiezas que tomaron más de 60 minutos. Decide si cuentan en los promedios. La decisión es permanente.'
                    : 'Cleans that took over 60 minutes. Decide whether each counts toward averages. Once decided, locked.'}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {flagged.map(ev => {
                    const cycle = ev.stayoverDay === 1 ? 'S1' : ev.stayoverDay === 2 ? 'S2' : 'C/O';
                    const dateStr = format(new Date(ev.date + 'T00:00:00'), 'MMM d', { locale: lang === 'es' ? esLocale : undefined });
                    const isReviewing = reviewingId === ev.id;
                    return (
                      <div key={ev.id} style={{
                        display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
                        padding: '12px 16px', background: 'rgba(186,26,26,0.04)',
                        border: '1px solid rgba(186,26,26,0.15)', borderRadius: '12px',
                      }}>
                        <div style={{ flex: 1, minWidth: '160px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '2px', flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 700, fontSize: '14px', color: '#1b1c19' }}>{ev.staffName}</span>
                            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '11px', color: '#757684', background: '#eae8e3', padding: '2px 6px', borderRadius: '4px' }}>
                              {cycle}
                            </span>
                          </div>
                          <div style={{ fontSize: '12px', color: '#454652' }}>
                            {lang === 'es' ? 'Hab.' : 'Room'} {ev.roomNumber} · {dateStr} · <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#ba1a1a', fontWeight: 700 }}>{Math.round(ev.durationMinutes)}m</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleDecide(ev.id, 'approved')}
                          disabled={isReviewing}
                          style={{
                            padding: '8px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
                            background: '#006565', color: '#ffffff', border: 'none',
                            cursor: isReviewing ? 'wait' : 'pointer', opacity: isReviewing ? 0.5 : 1,
                            minHeight: '36px', minWidth: '72px',
                          }}
                        >
                          {lang === 'es' ? 'Mantener' : 'Keep'}
                        </button>
                        <button
                          onClick={() => handleDecide(ev.id, 'rejected')}
                          disabled={isReviewing}
                          style={{
                            padding: '8px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
                            background: '#ffffff', color: '#ba1a1a', border: '1px solid #ba1a1a',
                            cursor: isReviewing ? 'wait' : 'pointer', opacity: isReviewing ? 0.5 : 1,
                            minHeight: '36px', minWidth: '72px',
                          }}
                        >
                          {lang === 'es' ? 'Descartar' : 'Discard'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ── RIGHT: Cleaning Efficiency Sidebar ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div style={{ background: '#f0eee9', padding: '28px', borderRadius: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '28px', display: 'flex', alignItems: 'center', gap: '8px', color: '#1b1c19' }}>
                <Clock size={18} style={{ color: '#364262' }} />
                {lang === 'es' ? 'Eficiencia de Limpieza' : 'Cleaning Efficiency'}
              </h2>

              {/* Three efficiency cards — Checkout, S1, S2 — replacing the old
                  two-card "Stayover Rooms" lump that hid S1 vs S2 differences. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
                <EfficiencyRow
                  label={lang === 'es' ? 'Habitaciones Checkout' : 'Checkout Rooms'}
                  actual={checkoutAvg}
                  target={checkoutTarget}
                  barColor="#364262"
                  lang={lang}
                />
                <EfficiencyRow
                  label={lang === 'es' ? 'Stayover Día 1 (Ligero)' : 'Stayover Day 1 (Light)'}
                  actual={s1Avg}
                  target={s1Target}
                  barColor="#006565"
                  lang={lang}
                />
                <EfficiencyRow
                  label={lang === 'es' ? 'Stayover Día 2 (Completo)' : 'Stayover Day 2 (Full)'}
                  actual={s2Avg}
                  target={s2Target}
                  barColor="#506071"
                  lang={lang}
                />
              </div>

              {/* Provisional list — anyone logging cleans but not yet at the
                  3-room minimum to qualify for the ranked leaderboard. */}
              {provisional.length > 0 && (
                <div style={{ marginTop: '32px', padding: '18px', background: '#ffffff', borderRadius: '14px', border: '1px solid rgba(197,197,212,0.15)' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#757684', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '10px' }}>
                    {lang === 'es' ? `En camino (mín. ${LEADERBOARD_MIN_ROOMS})` : `Warming up (min ${LEADERBOARD_MIN_ROOMS})`}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {provisional.map(p => (
                      <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', color: '#454652' }}>
                        <span>{p.name}</span>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#1b1c19', fontWeight: 600 }}>{p.total}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Period summary — replaces the old "Performance Shift" card.
                  Shows total cleans counted in the current view's window. */}
              <div style={{ marginTop: '24px', padding: '18px', background: '#ffffff', borderRadius: '14px', border: '1px solid rgba(197,197,212,0.15)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <Trophy size={14} style={{ color: '#506071' }} />
                  <span style={{ fontSize: '12px', fontWeight: 700, color: '#1b1c19', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {lang === 'es' ? 'Resumen del Período' : 'Period Summary'}
                  </span>
                </div>
                <div style={{ fontSize: '13px', color: '#454652', lineHeight: 1.6 }}>
                  {eligibleEvents.length > 0 ? (
                    <>
                      <div><span style={{ fontFamily: "'JetBrains Mono', monospace", color: '#1b1c19', fontWeight: 700 }}>{eligibleEvents.length}</span> {lang === 'es' ? 'limpiezas contadas' : 'cleans counted'}</div>
                      <div style={{ fontSize: '11px', color: '#757684', marginTop: '4px' }}>
                        {view === 'live'
                          ? (lang === 'es' ? 'Hoy' : 'Today')
                          : (lang === 'es' ? `Últimos ${viewDays} días` : `Last ${viewDays} days`)}
                      </div>
                    </>
                  ) : (
                    <span style={{ fontSize: '12px', color: '#757684' }}>
                      {lang === 'es' ? 'Sin datos en este período' : 'No data in this period'}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One row in the Cleaning Efficiency sidebar — used for Checkout, S1, S2.
 * Renders the actual avg, target, progress bar, and variance from target.
 * Bar fills toward 100% at target; over-target shades red.
 */
function EfficiencyRow({
  label, actual, target, barColor, lang,
}: {
  label: string;
  actual: number | null;
  target: number;
  barColor: string;
  lang: 'en' | 'es';
}) {
  const variance = actual !== null ? actual - target : null;
  const barPct = actual !== null ? Math.min(100, (actual / (target * 1.5)) * 100) : 0;
  const overTarget = variance !== null && variance > 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', fontWeight: 500, color: '#454652' }}>{label}</span>
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '24px', fontWeight: 500, color: '#1b1c19' }}>
            {formatMin(actual)}
          </span>
          <span style={{ display: 'block', fontFamily: "'JetBrains Mono', monospace", fontSize: '10px', color: '#454652' }}>
            {lang === 'es' ? 'min promedio' : 'avg minutes'}
          </span>
        </div>
      </div>
      <div style={{ height: '8px', width: '100%', background: '#eae8e3', borderRadius: '9999px', overflow: 'hidden' }}>
        <div style={{
          height: '100%',
          background: overTarget ? '#ba1a1a' : barColor,
          borderRadius: '9999px', transition: 'width 400ms',
          width: `${barPct}%`,
        }} />
      </div>
      <div style={{ marginTop: '6px', display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', color: '#454652' }}>
        <span>{lang === 'es' ? 'Objetivo' : 'Target'} {String(target).padStart(2, '0')}:00</span>
        <span style={{ color: overTarget ? '#ba1a1a' : '#006565', fontWeight: 700 }}>
          {variance !== null ? `${variance > 0 ? '+' : ''}${Math.round(variance)}m VAR` : '-'}
        </span>
      </div>
    </div>
  );
}

export { PerformanceTab };
