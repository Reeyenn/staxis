'use client';

// Schedule tab — redesigned June 2026 (the "wearebrand" handoff). The
// manager plans the day's cleaning here: pull occupancy, then assign every
// serviceable room to a housekeeper and balance everyone's workload. Two
// alternate representations of the SAME assignment, toggled by one control:
//
//   • Board    — one compact row per housekeeper (avatar, workload bar,
//                "rooms · time · status", and their room chips). Drag chips
//                between crew; tap a chip for detail. (ScheduleBoard.tsx)
//   • Timeline — the same assignment as a Gantt strip across the shift,
//                one lane per housekeeper. (ScheduleTimeline.tsx)
//
// Data backbone = the cleaning_tasks + hk_assignments system (the modern,
// persistent assignment engine), surfaced via:
//   GET  /api/housekeeping/board            (rooms + crew + current assignment)
//   POST /api/housekeeping/reassign         (move one room to a housekeeper)
//   POST /api/housekeeping/reset-assignments(clear all, or one — drag-to-unassigned)
//   POST /api/housekeeping/auto-assign      (balance unassigned rooms across crew)
//   POST /api/housekeeping/staff-priority   (★ Priority modal)
//   POST /api/send-shift-confirmations      (→ Send links)
//
// Kept from the prior tab: the live date stepper, the PMS pull strip (with
// its cleaning-time settings modal), and the sick-callout banner. Dropped
// per the new design: the Forecast sub-view, the notice board, and the
// tomorrow's-confidence tile.

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { fetchWithAuth } from '@/lib/api-fetch';
import { useFeedStatus } from '@/lib/use-feed-status';
import { FeedLearningBanner } from '@/components/FeedLearningBanner';
import { useToast, ToastHost } from '@/app/_components/ui/toast';
import {
  subscribeToPlanSnapshot,
  subscribeToDashboardByDate,
  updateProperty,
} from '@/lib/db';
import type { PlanSnapshot, DashboardNumbers } from '@/lib/db';
import {
  defaultShiftDate, addDays, formatDisplayDate, formatPulledAt,
} from './_shared';
import { PmsConnPendingStrip, PmsConnPausedStrip } from './_hk-shared';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF, Caps, Btn, HousekeeperDot,
} from './_snow';
import { CalloutBanner } from './CalloutBanner';
import {
  ScheduleBoard, type BoardTask, type BoardHk,
  chipKind, fmtMinutes,
} from './ScheduleBoard';
import { ScheduleTimeline } from './ScheduleTimeline';

type ScheduleView = 'board' | 'timeline';
const VIEW_STORAGE_KEY = 'staxis.schedule.view';

interface BoardData {
  tasks: BoardTask[];
  housekeepers: BoardHk[];
  unassigned: number;
}

const PRIORITY_RANK: Record<string, number> = { priority: 0, normal: 1, excluded: 2 };

// Bottom-center sage pill — the tab's prior hand-rolled toast, now rendered
// through the shared F7 ToastHost.
const SCHEDULE_TOAST_STYLE: React.CSSProperties = {
  padding: '12px 18px',
  background: T.sageDim, color: T.sageDeep,
  border: '1px solid rgba(104,131,114,0.3)', borderRadius: 999,
  fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
};

// Shared POST-and-check for the board mutation handlers: the six /api calls
// all fire a JSON POST, parse the envelope, and throw on a non-ok result so
// each handler's catch can roll back + toast. Verbatim extraction of the
// duplicated block — same request shape, same error message.
async function postJson<T = unknown>(
  url: string,
  payload: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const res = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: T; error?: string };
  if (!res.ok || !body.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as { ok: boolean; data?: T; error?: string };
}

export function ScheduleTab() {
  const { user } = useAuth();
  const { activeProperty, activePropertyId, refreshProperty } = useProperty();
  const { lang } = useLang();

  const [shiftDate, setShiftDate] = useState(defaultShiftDate);
  const [planSnapshot, setPlanSnapshot] = useState<PlanSnapshot | null>(null);
  const [planLoaded, setPlanLoaded] = useState(false);
  const [dashboardNums, setDashboardNums] = useState<DashboardNumbers | null>(null);
  const [dashboardLoaded, setDashboardLoaded] = useState(false);

  const { toasts, show } = useToast({ durationMs: 4000, max: 1 });

  const [view, setView] = useState<ScheduleView>('board');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (stored === 'board' || stored === 'timeline') setView(stored);
    } catch { /* private mode */ }
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* ignore */ }
  }, [view]);

  // ── Board data ─────────────────────────────────────────────────────────
  const [boardData, setBoardData] = useState<BoardData | null>(null);
  const [boardLoaded, setBoardLoaded] = useState(false);
  const [boardErr, setBoardErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'auto' | 'reset' | 'send'>(null);

  // Settings (cleaning-time) modal.
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    checkoutMinutes: 30,
    stayoverDay1Minutes: 15,
    stayoverDay2Minutes: 20,
    prepMinutesPerActivity: 5,
    shiftMinutes: 420,
  });

  // Priority modal + detail drawer.
  const [showPriority, setShowPriority] = useState(false);
  const [openTask, setOpenTask] = useState<BoardTask | null>(null);

  const uid = user?.uid ?? '';
  const pid = activePropertyId ?? '';

  // feat/cua-partial-promotion — the board classifies rooms (checkout vs
  // stayover) from PMS reservations; while arrivals/departures are still
  // being learned that classification is incomplete, and the In House /
  // Arrivals / Departures strip numbers may have no source. Say so.
  // Review pass: 'pending' (never synced) masks data; 'paused' is
  // banner-only (real-but-stale).
  const feedStatus = useFeedStatus(activePropertyId);
  const fsLive = feedStatus?.mode === 'live';
  const connPending = fsLive && feedStatus.connection === 'pending';
  const connPaused = fsLive && feedStatus.connection === 'paused';
  const reservationsLearning = fsLive &&
    (connPending || feedStatus.feeds.arrivals === 'learning' || feedStatus.feeds.departures === 'learning');
  const stripCountsLive = fsLive && !connPending && feedStatus.feeds.dashboardCounts === 'live';

  const flashToast = useCallback((msg: string) => {
    show(msg);
  }, [show]);

  // Dashboard pull (In House / Arrivals / Departures).
  useEffect(() => {
    if (!pid) return;
    setDashboardLoaded(false);
    return subscribeToDashboardByDate(pid, shiftDate, (nums) => {
      setDashboardNums(nums);
      setDashboardLoaded(true);
    });
  }, [pid, shiftDate]);

  // Plan snapshot — kept only for the "Latest PMS pull" freshness stamp.
  useEffect(() => {
    if (!uid || !pid) return;
    setPlanLoaded(false);
    return subscribeToPlanSnapshot(uid, pid, shiftDate, (snap) => {
      setPlanSnapshot(snap);
      setPlanLoaded(true);
    });
  }, [uid, pid, shiftDate]);

  // Board fetch (rooms + crew + assignment).
  const refreshBoard = useCallback(async () => {
    if (!pid) return;
    try {
      const res = await fetchWithAuth(
        `/api/housekeeping/board?propertyId=${encodeURIComponent(pid)}&date=${encodeURIComponent(shiftDate)}`,
      );
      const body = (await res.json()) as { ok: boolean; data?: BoardData; error?: string };
      if (!res.ok || !body.ok || !body.data) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setBoardData(body.data);
      setBoardErr(null);
    } catch (e) {
      setBoardErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBoardLoaded(true);
    }
  }, [pid, shiftDate]);

  useEffect(() => {
    setBoardLoaded(false);
    setBoardData(null);
    void refreshBoard();
  }, [refreshBoard]);

  // ── Derived ────────────────────────────────────────────────────────────
  const SHIFT_MINS = Math.max(60, activeProperty?.shiftMinutes ?? 420);

  const tasks = useMemo(() => boardData?.tasks ?? [], [boardData]);
  const crew = useMemo(() => {
    const list = (boardData?.housekeepers ?? []).filter(h => h.is_active);
    return [...list].sort((a, b) => {
      const pr = (PRIORITY_RANK[a.schedule_priority] ?? 1) - (PRIORITY_RANK[b.schedule_priority] ?? 1);
      return pr !== 0 ? pr : a.name.localeCompare(b.name);
    });
  }, [boardData]);

  const checkouts = tasks.filter(t => chipKind(t.cleaning_type) === 'checkout').length;
  const stayovers = tasks.filter(t => chipKind(t.cleaning_type) === 'stayover').length;
  const totalMinutes = tasks.reduce((s, t) => s + t.estimated_minutes_resolved, 0);
  const recommendedHKs = Math.max(1, Math.ceil(totalMinutes / SHIFT_MINS)) + 1;

  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []);
  const isToday = shiftDate === today;
  const isYesterday = shiftDate === addDays(today, -1);
  const isTomorrow = shiftDate === addDays(today, 1);

  const pulledAtIso = planSnapshot?.pulledAt
    ? (planSnapshot.pulledAt instanceof Date ? planSnapshot.pulledAt.toISOString() : String(planSnapshot.pulledAt))
    : null;
  const pulledAtLabel = pulledAtIso
    ? formatPulledAt(pulledAtIso, lang)
    : (lang === 'es' ? 'sin datos' : 'no data');

  // ── Mutations ──────────────────────────────────────────────────────────

  // Optimistic single-task assignee patch (hkId or null), with rollback.
  const patchAssignee = useCallback((taskId: string, assignee: string | null) => {
    setBoardData(d => {
      if (!d) return d;
      return { ...d, tasks: d.tasks.map(t => t.id === taskId ? { ...t, assignee_id: assignee } : t) };
    });
  }, []);

  const onReassign = useCallback(async (taskId: string, toHkId: string) => {
    const prev = boardData?.tasks.find(t => t.id === taskId)?.assignee_id ?? null;
    if (prev === toHkId) return;
    patchAssignee(taskId, toHkId);
    try {
      await postJson('/api/housekeeping/reassign', { propertyId: pid, taskId, toHousekeeperId: toHkId });
      await refreshBoard();
    } catch (e) {
      patchAssignee(taskId, prev);
      flashToast((lang === 'es' ? 'No se pudo mover: ' : 'Move failed: ') + (e instanceof Error ? e.message : String(e)));
    }
  }, [boardData, pid, patchAssignee, refreshBoard, flashToast, lang]);

  const onUnassign = useCallback(async (taskId: string) => {
    const prev = boardData?.tasks.find(t => t.id === taskId)?.assignee_id ?? null;
    if (prev === null) return;
    patchAssignee(taskId, null);
    try {
      await postJson('/api/housekeeping/reset-assignments', { propertyId: pid, date: shiftDate, taskId });
      await refreshBoard();
    } catch (e) {
      patchAssignee(taskId, prev);
      flashToast((lang === 'es' ? 'No se pudo quitar: ' : 'Unassign failed: ') + (e instanceof Error ? e.message : String(e)));
    }
  }, [boardData, pid, shiftDate, patchAssignee, refreshBoard, flashToast, lang]);

  const onAutoAssign = useCallback(async () => {
    if (!pid || busy) return;
    setBusy('auto');
    try {
      const body = await postJson<{ assigned?: number }>('/api/housekeeping/auto-assign', { propertyId: pid, date: shiftDate });
      const n = body.data?.assigned ?? 0;
      await refreshBoard();
      flashToast(
        n > 0
          ? (lang === 'es' ? `Asignados ${n} cuartos` : `Auto-assigned ${n} rooms`)
          : (lang === 'es' ? 'No hay cuartos por asignar' : 'No rooms to assign'),
      );
    } catch (e) {
      flashToast((lang === 'es' ? 'Error al asignar: ' : 'Auto-assign failed: ') + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }, [pid, shiftDate, busy, refreshBoard, flashToast, lang]);

  const onReset = useCallback(async () => {
    if (!pid || busy) return;
    const assignedCount = tasks.filter(t => t.assignee_id).length;
    if (assignedCount === 0) {
      flashToast(lang === 'es' ? 'Nada que reiniciar' : 'Nothing to reset');
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm(
      lang === 'es'
        ? `¿Quitar las asignaciones de ${assignedCount} cuartos?`
        : `Clear assignments for ${assignedCount} rooms?`,
    )) return;
    setBusy('reset');
    try {
      await postJson('/api/housekeeping/reset-assignments', { propertyId: pid, date: shiftDate });
      await refreshBoard();
      flashToast(lang === 'es' ? 'Asignaciones reiniciadas' : 'Assignments reset');
    } catch (e) {
      flashToast((lang === 'es' ? 'Error al reiniciar: ' : 'Reset failed: ') + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }, [pid, shiftDate, busy, tasks, refreshBoard, flashToast, lang]);

  const onSendLinks = useCallback(async () => {
    if (!pid || busy) return;
    // One text per crew member who has BOTH a phone and at least one room.
    const recipients = crew
      .filter(h => h.has_phone && h.phone)
      .map(h => ({
        staffId: h.id,
        name: h.name,
        phone: h.phone as string,
        language: h.language,
        assignedRooms: tasks.filter(t => t.assignee_id === h.id).map(t => t.room_number),
      }))
      .filter(r => r.assignedRooms.length > 0);
    if (recipients.length === 0) {
      flashToast(lang === 'es' ? 'Nadie con cuartos y teléfono' : 'No crew with rooms + a phone');
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm(
      lang === 'es'
        ? `¿Enviar el enlace de turno por SMS a ${recipients.length} personas?`
        : `Text the shift link to ${recipients.length} housekeeper(s)?`,
    )) return;
    setBusy('send');
    try {
      await postJson('/api/send-shift-confirmations', {
        pid, shiftDate,
        baseUrl: window.location.origin,
        staff: recipients,
      });
      flashToast(lang === 'es' ? `Enlaces enviados a ${recipients.length}` : `Sent links to ${recipients.length}`);
    } catch (e) {
      flashToast((lang === 'es' ? 'Error al enviar: ' : 'Send failed: ') + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }, [pid, shiftDate, busy, crew, tasks, flashToast, lang]);

  const onSavePriority = useCallback(async (staffId: string, priority: 'priority' | 'normal' | 'excluded') => {
    // Optimistic.
    setBoardData(d => {
      if (!d) return d;
      return { ...d, housekeepers: d.housekeepers.map(h => h.id === staffId ? { ...h, schedule_priority: priority } : h) };
    });
    try {
      await postJson('/api/housekeeping/staff-priority', { propertyId: pid, staffId, priority });
    } catch {
      flashToast(lang === 'es' ? 'Error al guardar prioridad' : 'Priority save failed');
      await refreshBoard();
    }
  }, [pid, refreshBoard, flashToast, lang]);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{
      padding: '24px 48px 48px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>
      <CalloutBanner shiftDate={shiftDate} />

      {/* feat/cua-partial-promotion — honesty strips. One banner at a
          time: pending > paused > feed-level. */}
      <PmsConnPendingStrip
        show={connPending}
        marginBottom={16}
        lang={lang}
        text={lang === 'es'
          ? 'Los datos del horario aparecerán cuando termine la primera sincronización.'
          : 'Schedule data will appear once the first sync lands.'}
      />
      <PmsConnPausedStrip show={!connPending && connPaused} marginBottom={16} lang={lang} />
      {!connPending && !connPaused && reservationsLearning && (
        <div style={{ marginBottom: 16 }}>
          <FeedLearningBanner
            variant="strip"
            title={lang === 'es' ? 'Aún aprendiendo tu PMS.' : 'Still learning your PMS.'}
            text={lang === 'es'
              ? 'Las llegadas/salidas del PMS todavía se están aprendiendo — la clasificación de salidas y estancias puede estar incompleta, y un conteo vacío no significa que no haya salidas hoy.'
              : 'PMS arrivals/departures are still being learned — checkout vs. stayover labels may be incomplete, and an empty count does not mean nobody checks out today.'}
          />
        </div>
      )}

      {/* DATE HEADER + STEPPER */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 18, gap: 24, flexWrap: 'wrap',
      }}>
        <div>
          <Caps>{(() => {
            if (isToday)     return lang === 'es' ? 'Horario · hoy'    : 'Schedule · today';
            if (isYesterday) return lang === 'es' ? 'Horario · ayer'   : 'Schedule · yesterday';
            if (isTomorrow)  return lang === 'es' ? 'Horario · mañana' : 'Schedule · tomorrow';
            return lang === 'es' ? 'Horario' : 'Schedule';
          })()}</Caps>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: '4px 0 0',
            letterSpacing: '-0.03em', lineHeight: 1.25, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>{formatDisplayDate(shiftDate, lang).split(',')[0]}</span>
            <span> · {formatDisplayDate(shiftDate, lang).split(',').slice(1).join(',').trim()}</span>
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, -1))}>← {lang === 'es' ? 'Ayer' : 'Yesterday'}</Btn>
          <Btn variant={isToday ? 'paper' : 'ghost'} size="sm" onClick={() => setShiftDate(today)}>{lang === 'es' ? 'Hoy' : 'Today'}</Btn>
          <Btn variant="ghost" size="sm" onClick={() => setShiftDate(addDays(shiftDate, 1))}>{lang === 'es' ? 'Mañana' : 'Tomorrow'} →</Btn>
        </div>
      </div>

      {/* PMS PULL STRIP */}
      <div style={{
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16,
        padding: '15px 20px', marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 26, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 140 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Caps size={9}>{lang === 'es' ? 'Última carga PMS' : 'Latest PMS pull'}</Caps>
            <button
              onClick={() => {
                setSettingsForm({
                  checkoutMinutes:        activeProperty?.checkoutMinutes        ?? 30,
                  stayoverDay1Minutes:    activeProperty?.stayoverDay1Minutes    ?? 15,
                  stayoverDay2Minutes:    activeProperty?.stayoverDay2Minutes    ?? 20,
                  prepMinutesPerActivity: activeProperty?.prepMinutesPerActivity ?? 5,
                  shiftMinutes:           activeProperty?.shiftMinutes           ?? 420,
                });
                setShowSettings(true);
              }}
              title={lang === 'es' ? 'Ajustes de tiempos de limpieza' : 'Cleaning-time settings'}
              aria-label={lang === 'es' ? 'Ajustes' : 'Settings'}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer', padding: 2,
                borderRadius: 4, color: T.ink3, display: 'inline-flex', alignItems: 'center',
              }}
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>
          <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 600, marginTop: 3 }}>
            {planLoaded ? pulledAtLabel : (lang === 'es' ? 'Cargando…' : 'Loading…')}
          </span>
        </div>
        <span style={{ width: 1, height: 40, background: T.rule }} />
        <div style={{ display: 'flex', gap: 26, flex: 1, flexWrap: 'wrap' }}>
          {([
            // Review pass: the legacy anon snapshot read is RLS-dead (these
            // were always null → '—'); when the counts feed is live the
            // server-derived values give real numbers, otherwise an honest
            // '—'. Checkout/stayover/recommended cells null out while the
            // reservation feeds are untrusted — a confident 0 there reads
            // as "nobody checks out today".
            { l: lang === 'es' ? 'En Casa'      : 'In House',    v: stripCountsLive ? (feedStatus.derived?.snapshotInHouse ?? null) : (fsLive ? null : dashboardNums?.inHouse ?? null), loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Llegadas'     : 'Arrivals',    v: stripCountsLive ? (feedStatus.derived?.snapshotArrivalsRemaining ?? null) : (fsLive ? null : dashboardNums?.arrivals ?? null), loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Salen'        : 'Departures',  v: stripCountsLive ? (feedStatus.derived?.snapshotDeparturesRemaining ?? null) : (fsLive ? null : dashboardNums?.departures ?? null), loaded: dashboardLoaded },
            { l: lang === 'es' ? 'Salidas'      : 'Checkouts',   v: reservationsLearning ? null : checkouts,                loaded: boardLoaded },
            { l: lang === 'es' ? 'Continúan'    : 'Stayovers',   v: reservationsLearning ? null : stayovers,                loaded: boardLoaded },
            { l: lang === 'es' ? 'Tiempo total' : 'Total time',  v: reservationsLearning ? null : fmtMinutes(totalMinutes), loaded: boardLoaded },
            { l: lang === 'es' ? 'Recomendado'  : 'Recommended', v: reservationsLearning ? null : `${recommendedHKs} HK`,   loaded: boardLoaded, tone: T.sageDeep },
          ] as Array<{ l: string; v: React.ReactNode; loaded: boolean; tone?: string }>).map(n => (
            <div key={n.l} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 58 }}>
              <Caps size={9}>{n.l}</Caps>
              <span style={{
                fontFamily: FONT_SERIF, fontSize: 28, color: n.loaded ? (n.tone || T.ink) : T.ink3,
                lineHeight: 1, letterSpacing: '-0.02em', fontWeight: 400, whiteSpace: 'nowrap',
              }}>{n.loaded && n.v != null ? n.v : '—'}</span>
            </div>
          ))}
        </div>
      </div>

      {/* TOOLBAR — view toggle + actions */}
      {pid && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 14, flexWrap: 'wrap', marginBottom: 16,
        }}>
          {/* Board ⇄ Timeline */}
          <div style={{
            display: 'inline-flex', gap: 4, background: T.ruleSoft,
            border: `1px solid ${T.rule}`, borderRadius: 999, padding: 4,
          }}>
            {([['board', lang === 'es' ? 'Tablero' : 'Board', '▤'], ['timeline', lang === 'es' ? 'Línea' : 'Timeline', '▦']] as const).map(([k, label, icon]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                style={{
                  fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600,
                  border: 'none', borderRadius: 999, padding: '8px 18px', cursor: 'pointer',
                  background: view === k ? T.ink : 'transparent',
                  color: view === k ? T.bg : T.ink2,
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  transition: 'background 120ms ease, color 120ms ease',
                }}
              >
                <span style={{ fontSize: 13 }}>{icon}</span>{label}
              </button>
            ))}
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            <Btn variant="ghost" size="sm" onClick={() => setShowPriority(true)}>★ {lang === 'es' ? 'Prioridad' : 'Priority'}</Btn>
            <Btn variant="ghost" size="sm" onClick={onReset} disabled={busy != null}>{lang === 'es' ? 'Reiniciar' : 'Reset'}</Btn>
            <Btn variant="primary" size="sm" onClick={onAutoAssign} disabled={busy != null}>
              {busy === 'auto' ? (lang === 'es' ? 'Asignando…' : 'Assigning…') : `↻ ${lang === 'es' ? 'Auto-asignar' : 'Auto-assign'}`}
            </Btn>
            <Btn variant="sage" size="sm" onClick={onSendLinks} disabled={busy != null}>
              {busy === 'send' ? (lang === 'es' ? 'Enviando…' : 'Sending…') : `→ ${lang === 'es' ? 'Enviar enlaces' : 'Send links'}`}
            </Btn>
          </div>
        </div>
      )}

      {/* VIEW */}
      {!pid && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: T.ink2, fontFamily: FONT_SANS, fontSize: 14 }}>
          {lang === 'es' ? 'Selecciona una propiedad.' : 'Select a property to plan the schedule.'}
        </div>
      )}
      {pid && !boardLoaded && (
        <div style={{ padding: '40px 0', textAlign: 'center' }}>
          <div className="animate-spin" style={{
            width: 26, height: 26, margin: '0 auto',
            border: `2px solid ${T.rule}`, borderTopColor: T.ink, borderRadius: '50%',
          }} />
        </div>
      )}
      {pid && boardLoaded && boardErr && (
        <div style={{
          padding: '18px 20px', border: `1px solid ${T.rule}`, borderRadius: 12,
          background: T.warmDim, color: T.warm, fontFamily: FONT_SANS, fontSize: 13,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
        }}>
          <span>{(lang === 'es' ? 'No se pudo cargar el tablero: ' : 'Couldn\'t load the board: ') + boardErr}</span>
          <Btn variant="ghost" size="sm" onClick={() => void refreshBoard()}>{lang === 'es' ? 'Reintentar' : 'Retry'}</Btn>
        </div>
      )}
      {pid && boardLoaded && !boardErr && crew.length === 0 && (
        <div style={{
          padding: '40px 20px', textAlign: 'center', color: T.ink2,
          fontFamily: FONT_SANS, fontSize: 14, border: `1px dashed ${T.rule}`, borderRadius: 12,
        }}>
          {lang === 'es'
            ? 'No hay personal de limpieza activo todavía.'
            : 'No active housekeeping staff yet — add crew in Staff to start assigning.'}
        </div>
      )}
      {pid && boardLoaded && !boardErr && crew.length > 0 && (
        <>
          {tasks.length === 0 && (
            <div style={{
              marginBottom: 12, padding: '12px 16px',
              border: `1px dashed ${T.rule}`, borderRadius: 12,
              background: T.paper, color: T.ink2, fontFamily: FONT_SANS, fontSize: 13,
            }}>
              {lang === 'es'
                ? 'No hay cuartos para limpiar en esta fecha todavía. Aparecerán aquí cuando llegue la próxima carga del PMS.'
                : 'No rooms to clean for this date yet. They\'ll appear here on the next PMS pull.'}
            </div>
          )}
          {view === 'board' ? (
            <ScheduleBoard
              crew={crew}
              tasks={tasks}
              shiftMinutes={SHIFT_MINS}
              lang={lang}
              onReassign={onReassign}
              onUnassign={onUnassign}
              onOpenTask={setOpenTask}
            />
          ) : (
            <ScheduleTimeline
              crew={crew}
              tasks={tasks}
              shiftMinutes={SHIFT_MINS}
              lang={lang}
              showNow={isToday}
              onReassign={onReassign}
              onOpenTask={setOpenTask}
            />
          )}
        </>
      )}

      {/* TOAST */}
      <ToastHost toasts={toasts} position="bottom" offset="24px" zIndex={70} toastStyle={SCHEDULE_TOAST_STYLE} />

      {/* DETAIL DRAWER */}
      {openTask && typeof document !== 'undefined' && createPortal(
        <RoomDetailDrawer
          task={openTask}
          crew={crew}
          lang={lang}
          onReassign={(hkId) => { void onReassign(openTask.id, hkId); setOpenTask(null); }}
          onUnassign={() => { void onUnassign(openTask.id); setOpenTask(null); }}
          onClose={() => setOpenTask(null)}
        />,
        document.body,
      )}

      {/* PRIORITY MODAL */}
      {showPriority && typeof document !== 'undefined' && createPortal(
        <PriorityModal
          crew={boardData?.housekeepers ?? []}
          lang={lang}
          onSave={onSavePriority}
          onClose={() => setShowPriority(false)}
        />,
        document.body,
      )}

      {/* SETTINGS MODAL */}
      {showSettings && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => { if (!settingsSaving) setShowSettings(false); }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{
            background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18,
            padding: '20px 24px', maxWidth: 480, width: '100%', maxHeight: '85vh', overflow: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.20)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h2 style={{ fontFamily: FONT_SERIF, fontSize: 24, margin: 0, color: T.ink, fontWeight: 400 }}>
                <span style={{ fontStyle: 'italic' }}>{lang === 'es' ? 'Tiempos de limpieza' : 'Cleaning-time settings'}</span>
              </h2>
              <button onClick={() => setShowSettings(false)} disabled={settingsSaving} aria-label="Close" style={{
                background: 'transparent', border: 'none', cursor: settingsSaving ? 'default' : 'pointer',
                fontSize: 20, color: T.ink3, padding: '0 6px',
              }}>×</button>
            </div>
            <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '0 0 14px' }}>
              {lang === 'es'
                ? 'Cuánto tarda cada limpieza. Auto-asignar y las barras de capacidad usan estos valores.'
                : 'How long each clean takes, by type. Auto-assign and the per-housekeeper capacity bars read these.'}
            </p>
            {([
              { key: 'checkoutMinutes',        label: lang === 'es' ? 'Salida (limpieza completa)' : 'Checkout (full clean)',     unit: 'min', step: 1,    min: 1, max: 240 },
              { key: 'stayoverDay1Minutes',    label: lang === 'es' ? 'Estadía día 1 (ligera)'     : 'Stayover Day 1 (light)',     unit: 'min', step: 1,    min: 1, max: 240 },
              { key: 'stayoverDay2Minutes',    label: lang === 'es' ? 'Estadía día 2+ (completa)'  : 'Stayover Day 2+ (full)',     unit: 'min', step: 1,    min: 1, max: 240 },
              { key: 'prepMinutesPerActivity', label: lang === 'es' ? 'Preparación entre cuartos'  : 'Prep between rooms',         unit: 'min', step: 1,    min: 0, max: 60 },
              { key: 'shiftMinutes',           label: lang === 'es' ? 'Turno máximo por persona'   : 'Max shift hours per person', unit: 'h',   step: 0.25, min: 1, max: 24, asHours: true },
            ] as Array<{ key: keyof typeof settingsForm; label: string; unit: string; step: number; min: number; max: number; asHours?: boolean }>).map(f => {
              const raw = settingsForm[f.key];
              const display = f.asHours ? raw / 60 : raw;
              return (
                <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderTop: `1px solid ${T.rule}`, gap: 12 }}>
                  <label htmlFor={`pred-${f.key}`} style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, flex: 1 }}>{f.label}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input id={`pred-${f.key}`} type="number" step={f.step} min={f.min} max={f.max} value={display}
                      onChange={(e) => {
                        const num = Number(e.target.value);
                        if (Number.isNaN(num)) return;
                        setSettingsForm(prev => ({ ...prev, [f.key]: f.asHours ? Math.round(num * 60) : Math.round(num) }));
                      }}
                      style={{ width: 70, padding: '6px 8px', borderRadius: 8, border: `1px solid ${T.rule}`, background: T.bg, fontFamily: FONT_MONO, fontSize: 13, color: T.ink, textAlign: 'right' }}
                    />
                    <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2, minWidth: 24 }}>{f.unit}</span>
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <Btn variant="ghost" size="sm" onClick={() => setShowSettings(false)} disabled={settingsSaving}>{lang === 'es' ? 'Cancelar' : 'Cancel'}</Btn>
              <Btn variant="primary" size="sm" disabled={settingsSaving || !uid || !pid} onClick={async () => {
                if (!uid || !pid) return;
                setSettingsSaving(true);
                try {
                  await updateProperty(uid, pid, {
                    checkoutMinutes:        settingsForm.checkoutMinutes,
                    stayoverDay1Minutes:    settingsForm.stayoverDay1Minutes,
                    stayoverDay2Minutes:    settingsForm.stayoverDay2Minutes,
                    stayoverMinutes:        settingsForm.stayoverDay2Minutes,
                    prepMinutesPerActivity: settingsForm.prepMinutesPerActivity,
                    shiftMinutes:           settingsForm.shiftMinutes,
                  });
                  await refreshProperty();
                  flashToast(lang === 'es' ? 'Ajustes guardados' : 'Settings saved');
                  setShowSettings(false);
                } catch (err) {
                  console.error('[Schedule] settings save failed:', err);
                  flashToast(lang === 'es' ? 'Error al guardar' : 'Save failed');
                } finally {
                  setSettingsSaving(false);
                }
              }}>
                {settingsSaving ? (lang === 'es' ? 'Guardando…' : 'Saving…') : (lang === 'es' ? 'Guardar' : 'Save')}
              </Btn>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Detail drawer — room detail + reassign-to list (design's detailDrawer).
// ───────────────────────────────────────────────────────────────────────

function RoomDetailDrawer({
  task, crew, lang, onReassign, onUnassign, onClose,
}: {
  task: BoardTask;
  crew: BoardHk[];
  lang: 'en' | 'es';
  onReassign: (hkId: string) => void;
  onUnassign: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const kind = chipKind(task.cleaning_type);
  const kindColor = kind === 'checkout' ? T.warm : kind === 'stayover' ? T.caramelDeep : T.sageDeep;
  const floor = (() => {
    const d = task.room_number.replace(/\D/g, '');
    return d.length >= 4 ? d.slice(0, 2) : d.length >= 2 ? d.slice(0, 1) : '?';
  })();
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" style={{
      position: 'fixed', inset: 0, background: 'rgba(24,22,17,0.32)',
      display: 'flex', justifyContent: 'flex-end', zIndex: 9999,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 'min(380px, 92vw)', background: T.paper, height: '100%', padding: 22,
        borderLeft: `1px solid ${T.rule}`, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Caps>{lang === 'es' ? 'Detalle del cuarto' : 'Room detail'}</Caps>
            <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 40, color: T.ink, lineHeight: 1 }}>{task.room_number}</div>
          </div>
          <Btn variant="ghost" size="sm" onClick={onClose}>{lang === 'es' ? 'Cerrar' : 'Close'}</Btn>
        </div>
        <DRow label={lang === 'es' ? 'Tipo' : 'Type'} value={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: kindColor }} />
            <span style={{ textTransform: 'capitalize' }}>{task.cleaning_type.replace(/_/g, ' ')}</span>
          </span>
        } />
        <DRow label={lang === 'es' ? 'Min. estimados' : 'Est. minutes'} value={fmtMinutes(task.estimated_minutes_resolved)} mono />
        <DRow label={lang === 'es' ? 'Estado' : 'Status'} value={<span style={{ textTransform: 'capitalize' }}>{task.status.replace(/_/g, ' ')}</span>} />
        <DRow label={lang === 'es' ? 'Piso' : 'Floor'} value={floor} />
        {task.requires_inspection && (
          <DRow label={lang === 'es' ? 'Inspección' : 'Inspection'} value={lang === 'es' ? 'Requerida' : 'Required'} />
        )}
        <div>
          <div style={{ margin: '6px 0 8px' }}><Caps>{lang === 'es' ? 'Reasignar a' : 'Reassign to'}</Caps></div>
          {crew.map(c => (
            <button key={c.id} onClick={() => onReassign(c.id)} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 9, justifyContent: 'flex-start',
              padding: '8px 10px', marginBottom: 6, borderRadius: 999,
              border: `1px solid ${task.assignee_id === c.id ? T.sageDeep : T.rule}`,
              background: task.assignee_id === c.id ? T.sageDim : 'transparent',
              cursor: 'pointer', fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
            }}>
              <HousekeeperDot staff={{ id: c.id, name: c.name }} size={22} />
              <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
              {task.assignee_id === c.id && <span style={{ color: T.sageDeep }}>✓</span>}
            </button>
          ))}
          {task.assignee_id && (
            <button onClick={onUnassign} style={{
              width: '100%', padding: '8px 10px', marginTop: 2, borderRadius: 999,
              border: `1px dashed ${T.rule}`, background: 'transparent', cursor: 'pointer',
              fontFamily: FONT_SANS, fontSize: 13, color: T.ink2,
            }}>{lang === 'es' ? 'Quitar asignación' : 'Unassign'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function DRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${T.rule}`, gap: 12 }}>
      <Caps>{label}</Caps>
      <span style={{ fontFamily: mono ? FONT_MONO : FONT_SANS, fontSize: 13, color: T.ink }}>{value}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Priority modal — per-staff Priority / Normal / Excluded.
// ───────────────────────────────────────────────────────────────────────

function PriorityModal({
  crew, lang, onSave, onClose,
}: {
  crew: BoardHk[];
  lang: 'en' | 'es';
  onSave: (staffId: string, priority: 'priority' | 'normal' | 'excluded') => void;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const levels: Array<['priority' | 'normal' | 'excluded', string]> = [
    ['priority', lang === 'es' ? 'Prioridad' : 'Priority'],
    ['normal', lang === 'es' ? 'Normal' : 'Normal'],
    ['excluded', lang === 'es' ? 'Excluido' : 'Excluded'],
  ];
  const ordered = [...crew.filter(c => c.is_active)].sort((a, b) =>
    (PRIORITY_RANK[a.schedule_priority] ?? 1) - (PRIORITY_RANK[b.schedule_priority] ?? 1) || a.name.localeCompare(b.name),
  );
  return (
    <div onClick={onClose} role="dialog" aria-modal="true" style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18, padding: '20px 24px',
        maxWidth: 480, width: '100%', maxHeight: '86vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h2 style={{ fontFamily: FONT_SERIF, fontSize: 24, margin: 0, color: T.ink, fontWeight: 400 }}>
            <span style={{ fontStyle: 'italic' }}>{lang === 'es' ? 'Prioridad del personal' : 'Staff priority'}</span>
          </h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 20, color: T.ink3, padding: '0 6px' }}>×</button>
        </div>
        <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '0 0 10px' }}>
          {lang === 'es'
            ? 'Prioridad = se asigna primero. Excluido = nunca se asigna automáticamente.'
            : 'Priority = assigned first. Excluded = never auto-assigned.'}
        </p>
        {ordered.length === 0 && (
          <div style={{ padding: '16px 0', color: T.ink2, fontFamily: FONT_SANS, fontSize: 13 }}>
            {lang === 'es' ? 'No hay personal de limpieza.' : 'No housekeeping staff.'}
          </div>
        )}
        {ordered.map(s => (
          <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderTop: `1px solid ${T.rule}`, gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <HousekeeperDot staff={{ id: s.id, name: s.name }} size={28} />
              <span style={{ fontWeight: 600, fontSize: 13, color: T.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
            </div>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {levels.map(([val, label]) => {
                const on = s.schedule_priority === val;
                return (
                  <button key={val} onClick={() => onSave(s.id, val)} style={{
                    fontFamily: FONT_SANS, fontSize: 11, borderRadius: 999, padding: '5px 11px', cursor: 'pointer',
                    border: `1px solid ${on ? T.sageDeep : T.rule}`,
                    background: on ? T.sageDeep : 'transparent',
                    color: on ? '#fff' : T.ink2,
                  }}>{label}</button>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <Btn variant="primary" size="sm" onClick={onClose}>{lang === 'es' ? 'Listo' : 'Done'}</Btn>
        </div>
      </div>
    </div>
  );
}
