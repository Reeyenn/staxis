// Split from the housekeeping/page.tsx monolith on 2026-04-27.
// Shared helpers / constants / components are imported from ./_shared.
// Only this tab's section logic lives here.

'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
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

function RoomsTab() {
  const { user }                                           = useAuth();
  const { activePropertyId, activeProperty, staff }        = useProperty();
  const { lang }                                           = useLang();
  const { recordOfflineAction }                            = useSyncContext();

  const [rooms,   setRooms]   = useState<Room[]>([]);
  const [activeDate, setActiveDate] = useState<string>(todayStr());
  const [loading, setLoading] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Toast severity drives color: 'success' = green, 'error' = red.
  // Set in handlePopulateFromCsv before each setToastMessage call so the
  // toast can self-explain the outcome at a glance — Mario shouldn't
  // have to read the message text to know if the load worked.
  const [toastKind, setToastKind] = useState<'success' | 'error'>('success');
  const [actionRoom, setActionRoom] = useState<Room | null>(null); // room action popup
  const [nowMs, setNowMs] = useState(Date.now());
  const [populating, setPopulating] = useState(false);

  // Help request badge tracking — rooms where helpRequested is true
  const [backupRoom, setBackupRoom] = useState<Room | null>(null); // room needing backup staff picker

  // "Load Rooms from CSV" button handler.
  //
  // 2026-04-28: switched from /api/populate-rooms-from-plan (which read
  // from the cached plan_snapshots table) to /api/refresh-from-pms (which
  // calls the Railway scraper to pull live state from Choice Advantage's
  // Housekeeping Center page right now). Reeyen wanted the button to
  // reflect what's actually in PMS at the moment of click, not whatever
  // the morning scraper happened to capture an hour ago.
  //
  // Round-trip latency: ~5-15s typically. Worst case ~25s if the Railway
  // scraper has to re-login mid-pull. Button shows a spinner state during
  // the fetch.
  const handlePopulateFromCsv = async () => {
    if (!user || !activePropertyId || populating) return;
    setPopulating(true);
    try {
      const res = await fetchWithAuth('/api/refresh-from-pms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid:  activePropertyId,
          date: activeDate,
        }),
      });
      // /api/refresh-from-pms now returns the standard ApiResponse envelope:
      //   ok=true:  { ok, requestId, data: { pulledAt, createdCount, updatedCount, totalFromHkCenter, elapsedMs } }
      //   ok=false: { ok, requestId, error, code, details? }
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        data?: { createdCount?: number; updatedCount?: number };
        error?: string;
      };
      if (!res.ok || body?.ok !== true) {
        // Make errors specific about the source so it's obvious WHAT failed.
        // The user shouldn't have to know what "PMS" means — say
        // "Choice Advantage Housekeeping Center" plainly.
        const reason = body?.error ?? (lang === 'es' ? 'razón desconocida' : 'unknown reason');
        setToastKind('error');
        setToastMessage(lang === 'es'
          ? `❌ No se pudo cargar desde Choice Advantage: ${reason}`
          : `❌ Couldn't load from Choice Advantage: ${reason}`);
      } else {
        // Success message names the exact source so anyone clicking the
        // button understands what just happened. Includes time of pull
        // so consecutive clicks don't blur together.
        const created = (body.data && typeof body.data.createdCount === 'number') ? body.data.createdCount : 0;
        const updated = (body.data && typeof body.data.updatedCount === 'number') ? body.data.updatedCount : 0;
        const total = created + updated;
        const time = new Date().toLocaleTimeString(lang === 'es' ? 'es-MX' : 'en-US', {
          hour: 'numeric',
          minute: '2-digit',
        });
        setToastKind('success');
        setToastMessage(lang === 'es'
          ? `✓ Cargadas ${total} habitaciones desde Choice Advantage · ${time}`
          : `✓ Loaded ${total} rooms from Choice Advantage Housekeeping Center · ${time}`);
      }
    } catch (err: unknown) {
      // Network-layer error (Vercel unreachable, browser offline, etc.)
      // — distinct from a server error response handled above.
      const msg = errToString(err);
      setToastKind('error');
      setToastMessage(lang === 'es'
        ? `❌ Error de red: ${msg}`
        : `❌ Network error: ${msg}`);
    } finally {
      setPopulating(false);
      // Errors stay up longer so Mario can read the reason.
      setTimeout(() => setToastMessage(null), 6000);
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
      await fetchWithAuth('/api/notify-backup', {
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
    <div style={{ padding: '24px', paddingBottom: '200px', background: 'var(--bg)', minHeight: 'calc(100dvh - 180px)' }}>

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

      {/* Toast notification — green for success, red for errors so the
          outcome is obvious at a glance even before reading the text.
          Portaled to document.body because some ancestor in the
          housekeeping layout has a CSS transform/perspective that turns
          this component's containing block into the ancestor instead of
          the viewport — without the portal, position:fixed anchors to
          that ancestor and the toast renders below the page fold.
          Same fix pattern used on the Staff Priority modal (commit
          c2bb521). */}
      {toastMessage && typeof document !== 'undefined' && createPortal(
        <div style={{
          position: 'fixed', bottom: '24px', right: '24px',
          maxWidth: '440px',
          background: toastKind === 'error' ? '#dc2626' : '#10b981',
          color: '#fff',
          padding: '14px 18px', borderRadius: '12px',
          fontSize: '14px', fontWeight: 500,
          lineHeight: 1.4,
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          zIndex: 9999,
        }}>
          {toastMessage}
        </div>,
        document.body,
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
            title={lang === 'es'
              ? 'Pulsa para cargar el estado en vivo (limpio/sucio, ocupado, asignado) de la página Housekeeping Center de Choice Advantage. Conserva las asignaciones del personal.'
              : 'Click to load live room status (clean/dirty, occupied, assigned) from Choice Advantage\u2019s Housekeeping Center page. Preserves staff assignments.'}
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

            {/* ── Populate from CSV button (right-aligned) ──
                The button name still reads "Load Rooms from CSV" because
                Mario knows that label, but the title (hover tooltip) is
                explicit about what it actually does today: pulls live
                state from Choice Advantage's Housekeeping Center page. */}
            <button
              onClick={handlePopulateFromCsv}
              disabled={populating}
              title={lang === 'es'
                ? 'Pulsa para cargar el estado en vivo (limpio/sucio, ocupado, asignado) de la página Housekeeping Center de Choice Advantage. Conserva las asignaciones del personal.'
                : 'Click to load live room status (clean/dirty, occupied, assigned) from Choice Advantage\u2019s Housekeeping Center page. Preserves staff assignments.'}
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


export { RoomsTab };
