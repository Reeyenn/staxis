'use client';

// Quality & Performance — the merged tab. Combines the former Inspections
// and Performance tabs into one "Command" layout (Claude Design handoff,
// "design_handoff_quality", June 2026):
//
//   • Header     — "Quality & performance" + range toggle (drives the
//                  performance numbers only; the stat band is fixed today/7d).
//   • Stat band  — 4 inspection KPIs (pass rate today / 7d, re-clean, avg).
//   • LEFT col   — Inspection queue (filters + Inspect → drawer) + recent history.
//   • RIGHT col  — Team leaderboard (+ CSV export), cleaning efficiency,
//                  top failures, flagged-clean review.
//   • Drawer     — full inspection checklist (per-item severity, notes,
//                  photo-on-fail, overall note) → pass / send-for-re-clean.
//
// This file is the ORCHESTRATOR: state, polling, the /api routes, and the two
// derived columns. The presentational halves live in QualityInspections.tsx
// (left) and QualityPerformance.tsx (right); shared pure helpers/types are in
// quality-shared.ts. The split is mechanical — no behavior changed.
//
// Data layers are untouched — same /api/housekeeping/inspections/* routes
// and the same cleaning-events db helpers (Migration 0012).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useTodayStr } from '@/lib/use-today-str';
import { useFeedStatus } from '@/lib/use-feed-status';
import { FeedLearningBanner } from '@/components/FeedLearningBanner';
import { fetchWithAuth } from '@/lib/api-fetch';
import { parseLocalDate } from '@/lib/format-date';
import { useToast, ToastHost } from '@/app/_components/ui/toast';
import { format, subDays } from 'date-fns';
import {
  getCleaningEventsForRange,
  getFlaggedCleaningEvents,
  decideOnFlaggedEvent,
  subscribeToTodayCleaningEvents,
} from '@/lib/db';
import type { CleaningEvent } from '@/lib/db';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, Card, HousekeeperDot,
} from './_snow';
import {
  tr, toIso,
  UUID_RE, VIEW_DAYS, LEADERBOARD_MIN_ROOMS,
  type ViewMode, type ItemDraft, type StaffStats,
} from './quality-shared';
import {
  StatBand, FilterPill, QueueRow, HistoryCard, InspectDrawer,
} from './QualityInspections';
import { Leaderboard, EfficiencyCard } from './QualityPerformance';
import type { StaffMember } from '@/types';
import type {
  Inspection,
  InspectionChecklist,
  InspectionFailedItem,
  InspectionHistoryEntry,
  InspectionQueueRoom,
  InspectionStats,
} from '@/types/inspections';

// Bottom-center pill matching the tab's prior hand-rolled Toast (sage tone,
// 3.2s auto-dismiss). Rendered through the shared F7 ToastHost.
const TOAST_STYLE: React.CSSProperties = {
  background: T.sageDim, color: T.sageDeep, border: `1px solid rgba(92,122,96,0.3)`,
  padding: '11px 18px', borderRadius: 999,
  fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
  boxShadow: '0 8px 24px rgba(0,0,0,0.10)',
};

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

export function QualityTab() {
  const { user } = useAuth();
  const { activePropertyId, staff, staffLoaded } = useProperty();
  // feat/cua-partial-promotion (review pass) — PMS-cleaned rooms feed the
  // inspection queue; flag when that signal is still learning or pending.
  const feedStatusQt = useFeedStatus(activePropertyId);
  const roomStatusLearningQt = feedStatusQt?.mode === 'live' &&
    (feedStatusQt.feeds.roomStatus === 'learning' || feedStatusQt.connection === 'pending');
  const { lang } = useLang();
  const today = useTodayStr();

  // ── Inspections state ──────────────────────────────────────────────────
  const [queue, setQueue] = useState<InspectionQueueRoom[]>([]);
  const [filter, setFilter] = useState<'all' | 'pending_inspection' | 'pending_recheck'>('all');
  const [queueLoading, setQueueLoading] = useState(true);
  // True when the last queue fetch failed. Distinguishes a genuinely-empty
  // queue ("every room inspected") from a queue that never loaded — without
  // it a failed fetch renders the reassuring empty state and managers skip
  // inspections that are actually pending.
  const [queueError, setQueueError] = useState(false);
  const [active, setActive] = useState<{
    inspection: Inspection;
    checklist: InspectionChecklist;
    drafts: Map<string, ItemDraft>;
    notes: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stats, setStats] = useState<InspectionStats | null>(null);
  const [history, setHistory] = useState<InspectionHistoryEntry[]>([]);
  const { toasts, show } = useToast({ durationMs: 3200, max: 1 });

  // ── Performance state ──────────────────────────────────────────────────
  const [view, setView] = useState<ViewMode>('7d');
  const [events, setEvents] = useState<CleaningEvent[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [flagged, setFlagged] = useState<CleaningEvent[]>([]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // ── Inspection data loaders ────────────────────────────────────────────
  const refreshQueue = useCallback(async () => {
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth(
        `/api/housekeeping/inspections/queue?pid=${encodeURIComponent(activePropertyId)}&date=${today}`,
      );
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok && Array.isArray(json.data)) {
        setQueue(json.data as InspectionQueueRoom[]);
        setQueueError(false);
      } else {
        setQueueError(true);
      }
    } catch {
      setQueueError(true);
    } finally {
      setQueueLoading(false);
    }
  }, [activePropertyId, today]);

  const refreshStats = useCallback(async () => {
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth(
        `/api/housekeeping/inspections/stats?pid=${encodeURIComponent(activePropertyId)}`,
      );
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) setStats(json.data as InspectionStats);
    } catch {
      // non-fatal
    }
  }, [activePropertyId]);

  const refreshHistory = useCallback(async () => {
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth(
        `/api/housekeeping/inspections/history?pid=${encodeURIComponent(activePropertyId)}&limit=25`,
      );
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok && Array.isArray(json.data)) {
        setHistory(json.data as InspectionHistoryEntry[]);
      }
    } catch {
      // non-fatal
    }
  }, [activePropertyId]);

  useEffect(() => {
    void refreshQueue();
    void refreshStats();
    void refreshHistory();
    const id = window.setInterval(() => {
      void refreshQueue();
      void refreshStats();
    }, 15_000); // poll every 15s — realtime channel isn't wired for inspections yet
    return () => window.clearInterval(id);
  }, [refreshQueue, refreshStats, refreshHistory]);

  // ── Performance: events (live realtime vs ranged history) ───────────────
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
      .then((rows) => { if (!cancelled) setEvents(rows); })
      .catch((err) => console.error('[QualityTab] load events failed:', err))
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [user, activePropertyId, view, today]);

  // ── Performance: flagged review queue (polled 30s, range-independent) ────
  useEffect(() => {
    if (!activePropertyId) return;
    let cancelled = false;
    const refresh = () => {
      getFlaggedCleaningEvents(activePropertyId)
        .then((rows) => { if (!cancelled) setFlagged(rows); })
        .catch((err) => console.error('[QualityTab] load flagged failed:', err));
    };
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activePropertyId]);

  // ── Derived: filtered queue ────────────────────────────────────────────
  const visibleQueue = useMemo(() => {
    if (filter === 'all') return queue;
    return queue.filter((q) => q.reason === filter);
  }, [queue, filter]);

  // ── Derived: performance leaderboard / provisional / efficiency ─────────
  const activeStaffIds = useMemo<Set<string> | null>(
    () => staffLoaded ? new Set(staff.filter((s) => s.isActive !== false).map((s) => s.id)) : null,
    [staff, staffLoaded],
  );

  const eligible = useMemo(
    () => events.filter((e) => e.status === 'recorded' || e.status === 'approved'),
    [events],
  );

  const leaderboard: StaffStats[] = useMemo(() => {
    type Acc = StaffStats & { _check: number; _s1: number; _s2: number; checkoutN: number; s1N: number; s2N: number; totalMins: number };
    const byStaff = new Map<string, Acc>();
    for (const ev of eligible) {
      if (activeStaffIds && ev.staffId && !activeStaffIds.has(ev.staffId)) continue;
      const key = ev.staffId ?? `name:${ev.staffName}`;
      const e = byStaff.get(key) ?? {
        staffId: ev.staffId ?? key, name: ev.staffName,
        total: 0, totalMins: 0, avgMins: 0,
        avgCheckout: null, avgS1: null, avgS2: null,
        _check: 0, _s1: 0, _s2: 0, checkoutN: 0, s1N: 0, s2N: 0,
      };
      e.total++;
      e.totalMins += ev.durationMinutes;
      if (ev.roomType === 'checkout')   { e._check += ev.durationMinutes; e.checkoutN++; }
      else if (ev.stayoverDay === 1)    { e._s1    += ev.durationMinutes; e.s1N++; }
      else if (ev.stayoverDay === 2)    { e._s2    += ev.durationMinutes; e.s2N++; }
      byStaff.set(key, e);
    }
    return Array.from(byStaff.values())
      .filter((e) => e.total >= LEADERBOARD_MIN_ROOMS)
      .map((e) => ({
        staffId: e.staffId, name: e.name, total: e.total,
        avgMins: e.totalMins / e.total,
        avgCheckout: e.checkoutN > 0 ? e._check / e.checkoutN : null,
        avgS1:       e.s1N       > 0 ? e._s1    / e.s1N       : null,
        avgS2:       e.s2N       > 0 ? e._s2    / e.s2N       : null,
      }))
      // Tie-break by name so identical avgMins don't flip rank across renders.
      .sort((a, b) => (a.avgMins - b.avgMins) || a.name.localeCompare(b.name));
  }, [eligible, activeStaffIds]);

  const provisional = useMemo(() => {
    const byStaff = new Map<string, { staffId: string; name: string; total: number }>();
    for (const ev of eligible) {
      if (activeStaffIds && ev.staffId && !activeStaffIds.has(ev.staffId)) continue;
      const key = ev.staffId ?? `name:${ev.staffName}`;
      const e = byStaff.get(key) ?? { staffId: ev.staffId ?? key, name: ev.staffName, total: 0 };
      e.total++;
      byStaff.set(key, e);
    }
    return Array.from(byStaff.values())
      .filter((e) => e.total < LEADERBOARD_MIN_ROOMS && e.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [eligible, activeStaffIds]);

  const typeAvgs = useMemo(() => {
    const checkout = eligible.filter((e) => e.roomType === 'checkout');
    const s1       = eligible.filter((e) => e.roomType === 'stayover' && e.stayoverDay === 1);
    const s2       = eligible.filter((e) => e.roomType === 'stayover' && e.stayoverDay === 2);
    const sum = (arr: CleaningEvent[]) => arr.reduce((s, e) => s + e.durationMinutes, 0);
    const total = eligible.length;
    return {
      overall:  total ? sum(eligible) / total : null,
      checkout: checkout.length ? sum(checkout) / checkout.length : null,
      s1:       s1.length       ? sum(s1)       / s1.length       : null,
      s2:       s2.length       ? sum(s2)       / s2.length       : null,
      shareCheckout: total ? checkout.length / total : 0,
      shareS1:       total ? s1.length       / total : 0,
      shareS2:       total ? s2.length       / total : 0,
    };
  }, [eligible]);

  const paceFor = useCallback((s: StaffStats): 'fast' | 'on' | 'slow' => {
    if (typeAvgs.overall == null) return 'on';
    if (s.avgMins < typeAvgs.overall * 0.95) return 'fast';
    if (s.avgMins > typeAvgs.overall * 1.05) return 'slow';
    return 'on';
  }, [typeAvgs.overall]);

  // ── Inspection handlers ────────────────────────────────────────────────
  const handleStart = useCallback(async (room: InspectionQueueRoom) => {
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth('/api/housekeeping/inspections/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: activePropertyId,
          roomId: UUID_RE.test(room.roomId) ? room.roomId : null,
          roomNumber: room.roomNumber,
          roomType: room.roomType || null,
          parentInspectionId: room.parentInspectionId,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        show(tr(lang, 'Could not start inspection', 'No se pudo iniciar la inspección'));
        return;
      }
      const inspection = json.data.inspection as Inspection;
      const checklist = json.data.checklist as InspectionChecklist;
      const drafts = new Map<string, ItemDraft>();
      for (const item of checklist.items) {
        drafts.set(item.id, { state: null, note: '', photoUrl: null, photoPath: null, uploading: false });
      }
      setActive({ inspection, checklist, drafts, notes: '' });
    } catch {
      show(tr(lang, 'Network error', 'Error de red'));
    }
  }, [activePropertyId, lang, show]);

  const handleSubmit = useCallback(async (result: 'pass' | 'fail') => {
    if (!active || submitting) return;
    setSubmitting(true);
    try {
      const failedItems: InspectionFailedItem[] = [];
      const passedItems: string[] = [];
      for (const item of active.checklist.items) {
        const d = active.drafts.get(item.id);
        if (!d) {
          if (result === 'pass') passedItems.push(item.id);
          continue;
        }
        if (d.state === 'pass') {
          passedItems.push(item.id);
        } else if (d.state === 'minor' || d.state === 'major' || d.state === 'critical') {
          failedItems.push({
            itemId: item.id,
            label: item.label,
            severity: d.state,
            photoUrl: d.photoUrl,
            photoPath: d.photoPath,
            note: d.note || null,
          });
        }
      }

      // Client-side guard: fail-with-photo-required.
      if (result === 'fail') {
        for (const f of failedItems) {
          const item = active.checklist.items.find((i) => i.id === f.itemId);
          if (item?.requiresPhotoOnFail && !f.photoUrl) {
            show(tr(lang,
              `${item.label} requires a photo before submitting`,
              `${item.label} requiere foto antes de enviar`));
            setSubmitting(false);
            return;
          }
        }
      }

      const res = await fetchWithAuth(
        `/api/housekeeping/inspections/${active.inspection.id}/complete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            result,
            failedItems,
            passedItems,
            notes: active.notes || null,
          }),
        },
      );
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        show(tr(lang,
          json?.error ?? 'Could not complete inspection',
          json?.error ?? 'No se pudo completar la inspección'));
        return;
      }
      show(result === 'pass'
        ? tr(lang, 'Inspection passed — room ready', 'Inspección aprobada — habitación lista')
        : tr(lang, 'Inspection failed — re-clean requested', 'Inspección reprobada — solicitada re-limpieza'));
      setActive(null);
      void refreshQueue();
      void refreshStats();
      void refreshHistory();
    } catch {
      // Network failure — surface it so the manager knows the inspection
      // was NOT recorded (drawer stays open to retry). Mirrors handleStart.
      show(tr(lang, 'Network error — inspection not saved', 'Error de red — inspección no guardada'));
    } finally {
      setSubmitting(false);
    }
  }, [active, submitting, lang, show, refreshQueue, refreshStats, refreshHistory]);

  const handleCancel = useCallback(async () => {
    if (!active) return;
    const id = active.inspection.id;
    setActive(null);
    try {
      await fetchWithAuth(`/api/housekeeping/inspections/${id}/cancel`, { method: 'POST' });
    } catch {
      // ignore — cancel is best-effort
    } finally {
      void refreshQueue();
    }
  }, [active, refreshQueue]);

  const updateDraft = useCallback((itemId: string, patch: Partial<ItemDraft>) => {
    setActive((prev) => {
      if (!prev) return prev;
      const drafts = new Map(prev.drafts);
      const cur = drafts.get(itemId) ?? { state: null, note: '', photoUrl: null, photoPath: null, uploading: false };
      drafts.set(itemId, { ...cur, ...patch });
      return { ...prev, drafts };
    });
  }, []);

  const handleUploadPhoto = useCallback(async (itemId: string, file: File) => {
    if (!active) return;
    updateDraft(itemId, { uploading: true });
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('inspection', active.inspection.id);
      fd.append('item', itemId);
      const res = await fetchWithAuth('/api/housekeeping/inspections/upload-photo', {
        method: 'POST',
        body: fd,
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok && json.data?.url) {
        updateDraft(itemId, {
          photoUrl: json.data.url,
          photoPath: json.data.path ?? null,
          uploading: false,
        });
      } else {
        show(tr(lang, 'Photo upload failed', 'Carga de foto falló'));
        updateDraft(itemId, { uploading: false });
      }
    } catch {
      show(tr(lang, 'Photo upload failed', 'Carga de foto falló'));
      updateDraft(itemId, { uploading: false });
    }
  }, [active, lang, show, updateDraft]);

  // ── Performance handlers ───────────────────────────────────────────────
  const handleDecide = useCallback(async (eventId: string, decision: 'approved' | 'rejected') => {
    if (!user || !activePropertyId) return;
    setReviewingId(eventId);
    try {
      await decideOnFlaggedEvent(eventId, decision, user.uid);
      setFlagged((prev) => prev.filter((e) => e.id !== eventId));
      // Also patch events so the leaderboard / efficiency (which filter for
      // recorded|approved) reflect the decision without a full re-fetch.
      setEvents((prev) => prev.map((e) => (e.id === eventId ? { ...e, status: decision } : e)));
      show(decision === 'approved'
        ? tr(lang, 'Kept — counts toward averages', 'Mantenida — cuenta en los promedios')
        : tr(lang, 'Discarded from averages', 'Descartada de los promedios'));
    } catch (err) {
      console.error('[QualityTab] decide failed:', err);
      show(tr(lang, 'Could not save decision', 'No se pudo guardar la decisión'));
    } finally {
      setReviewingId(null);
    }
  }, [user, activePropertyId, lang, show]);

  const handleExport = useCallback(() => {
    if (events.length === 0) return;
    const fromDate = view === 'live' ? today : format(subDays(new Date(), VIEW_DAYS[view] - 1), 'yyyy-MM-dd');
    const filename = `cleaning-events_${fromDate}_to_${today}.csv`;
    const headers = ['date', 'room', 'type', 'cycle', 'housekeeper', 'started_at', 'completed_at', 'duration_minutes', 'status'];
    const rows = events.map((e) => [
      e.date, e.roomNumber, e.roomType,
      e.stayoverDay === 1 ? 'S1' : e.stayoverDay === 2 ? 'S2' : (e.roomType === 'checkout' ? 'CO' : ''),
      e.staffName,
      toIso(e.startedAt), toIso(e.completedAt),
      e.durationMinutes.toFixed(2),
      e.status,
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    show(tr(lang, 'Report exported', 'Reporte exportado'));
  }, [events, view, today, lang, show]);

  const staffShape = (s: { staffId: string; name: string }): Pick<StaffMember, 'id' | 'name'> => ({
    id: s.staffId, name: s.name,
  });

  // ── Ranges ─────────────────────────────────────────────────────────────
  const ranges: { k: ViewMode; l: string }[] = [
    { k: 'live', l: tr(lang, 'Today',   'Hoy') },
    { k: '7d',   l: tr(lang, '7 days',  '7 días') },
    { k: '30d',  l: tr(lang, '30 days', '30 días') },
    { k: '3mo',  l: tr(lang, '90 days', '90 días') },
    { k: '1yr',  l: tr(lang, '1 year',  '1 año') },
  ];

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{
      padding: '24px 48px 64px', background: T.bg, color: T.ink,
      fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)',
    }}>
      <ToastHost toasts={toasts} position="bottom" offset="24px" zIndex={1200} ariaLive="polite" toastStyle={TOAST_STYLE} />

      {/* HEADER */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        marginBottom: 18, gap: 20, flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{
            fontFamily: FONT_SERIF, fontSize: 36, color: T.ink, margin: 0,
            letterSpacing: '-0.02em', lineHeight: 1.1, fontWeight: 400,
          }}>
            <span style={{ fontStyle: 'italic' }}>{tr(lang, 'Quality', 'Calidad')}</span>
            {tr(lang, ' & performance', ' y rendimiento')}
          </h1>
          <Caps style={{ display: 'block', marginTop: 8 }} c={T.ink3}>
            {tr(lang, 'Inspections + crew performance · combined', 'Inspecciones + rendimiento del equipo · combinado')}
          </Caps>
        </div>
        <div style={{
          background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 999,
          padding: 4, display: 'flex', gap: 2,
        }}>
          {ranges.map((r) => (
            <button
              key={r.k}
              onClick={() => setView(r.k)}
              style={{
                padding: '7px 14px', borderRadius: 999, border: 'none', cursor: 'pointer',
                background: view === r.k ? T.ink : 'transparent',
                color: view === r.k ? T.bg : T.ink2,
                fontFamily: FONT_SANS, fontSize: 12, fontWeight: view === r.k ? 600 : 500,
                whiteSpace: 'nowrap',
              }}
            >{r.l}</button>
          ))}
        </div>
      </div>

      {/* STAT BAND */}
      <StatBand stats={stats} lang={lang} />

      {/* TWO-COLUMN BOARD */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 18, alignItems: 'flex-start' }}>

        {/* LEFT — INSPECTIONS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card padding="18px 22px 20px">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <h2 style={{
                fontFamily: FONT_SERIF, fontStyle: 'italic', fontWeight: 400,
                fontSize: 24, margin: 0, color: T.ink, letterSpacing: '-0.02em',
              }}>{tr(lang, 'Inspection queue', 'Cola de inspección')}</h2>
              <Pill tone="caramel">
                {queue.length} {tr(lang, 'waiting', 'en espera')}
              </Pill>
            </div>

            {/* feat/cua-partial-promotion (review pass) — the queue derives
                from PMS-cleaned rooms; while room statuses are learning,
                "0 waiting" must not read as "nothing to inspect". */}
            {roomStatusLearningQt && (
              <div style={{ marginBottom: 12 }}>
                <FeedLearningBanner
                  variant="strip"
                  title={tr(lang, 'Still learning your PMS.', 'Aún aprendiendo tu PMS.')}
                  text={tr(lang,
                    'Rooms cleaned in the PMS may not appear here yet — the queue reflects in-app activity only.',
                    'Las habitaciones limpiadas en el PMS pueden no aparecer aquí todavía — la cola refleja solo actividad en la app.')}
                />
              </div>
            )}

            {/* Filters */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
              <FilterPill label={tr(lang, 'All', 'Todas')} active={filter === 'all'} onClick={() => setFilter('all')} />
              <FilterPill label={tr(lang, 'Pending', 'Pendientes')} active={filter === 'pending_inspection'} onClick={() => setFilter('pending_inspection')} />
              <FilterPill label={tr(lang, 'Re-check', 'Reinspección')} active={filter === 'pending_recheck'} onClick={() => setFilter('pending_recheck')} />
              {filter !== 'all' && (
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3, marginLeft: 2 }}>
                  {visibleQueue.length}/{queue.length}
                </span>
              )}
            </div>

            {queueLoading ? (
              <div style={{ padding: 16, color: T.ink3, fontFamily: FONT_SANS, fontSize: 13 }}>
                {tr(lang, 'Loading…', 'Cargando…')}
              </div>
            ) : queueError && queue.length === 0 ? (
              <div style={{
                textAlign: 'center', color: T.warm, fontStyle: 'italic',
                fontFamily: FONT_SERIF, fontSize: 16, padding: '24px 12px 20px',
                border: `1px solid ${T.ruleSoft}`, borderRadius: 12,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
              }}>
                <span>{tr(lang, 'Couldn’t load the inspection queue.', 'No se pudo cargar la cola de inspección.')}</span>
                <Btn variant="paper" size="sm" onClick={() => void refreshQueue()}>
                  {tr(lang, 'Retry', 'Reintentar')}
                </Btn>
              </div>
            ) : visibleQueue.length === 0 ? (
              <div style={{
                textAlign: 'center', color: T.ink2, fontStyle: 'italic',
                fontFamily: FONT_SERIF, fontSize: 16, padding: '28px 12px',
                border: `1px solid ${T.ruleSoft}`, borderRadius: 12,
              }}>
                {queue.length === 0
                  ? tr(lang, 'Queue clear — every room inspected.', 'Cola despejada — todas inspeccionadas.')
                  : tr(lang, 'No rooms in this filter.', 'No hay habitaciones en este filtro.')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {visibleQueue.map((q) => (
                  <QueueRow key={q.roomId} row={q} lang={lang} onInspect={() => handleStart(q)} />
                ))}
              </div>
            )}
          </Card>

          <HistoryCard rows={history} lang={lang} />
        </div>

        {/* RIGHT — PERFORMANCE */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Leaderboard */}
          <Card padding="8px 22px 16px">
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '16px 0 12px', borderBottom: `1px solid ${T.rule}`, marginBottom: 4,
            }}>
              <Caps>{tr(lang, 'Team leaderboard', 'Tabla del equipo')}</Caps>
              <Btn variant="ghost" size="sm" onClick={handleExport} disabled={events.length === 0}>
                {tr(lang, 'Export', 'Exportar')} ↓
              </Btn>
            </div>
            <Leaderboard
              rows={leaderboard}
              loading={historyLoading && leaderboard.length === 0}
              lang={lang}
              paceFor={paceFor}
              staffShape={staffShape}
            />
            {provisional.length > 0 && (
              <div style={{ paddingTop: 14, marginTop: 4 }}>
                <Caps>{tr(lang, 'Provisional · < 3 cleans this period', 'Provisional · < 3 limpiezas este período')}</Caps>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {provisional.map((p) => (
                    <div key={p.staffId} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px 4px 4px',
                      background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 999,
                    }}>
                      <HousekeeperDot staff={staffShape(p)} size={22} />
                      <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink, whiteSpace: 'nowrap' }}>{p.name}</span>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
                        {p.total} {tr(lang, 'cleans', 'limpiezas')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Cleaning efficiency */}
          <EfficiencyCard typeAvgs={typeAvgs} eligibleCount={eligible.length} lang={lang} />

          {/* Top failures */}
          {stats && stats.topFailureItems.length > 0 && (
            <Card padding="18px 22px">
              <Caps style={{ marginBottom: 10, display: 'block' }}>{tr(lang, 'Top failures', 'Fallos más comunes')}</Caps>
              {stats.topFailureItems.map((f) => (
                <div key={f.label} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '6px 0', fontFamily: FONT_SANS, fontSize: 12.5,
                }}>
                  <span style={{ color: T.ink, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.label}</span>
                  <span style={{ fontFamily: FONT_MONO, color: T.warm, fontWeight: 600, marginLeft: 8 }}>{f.count}</span>
                </div>
              ))}
            </Card>
          )}

          {/* Flagged review — only when there's something to review */}
          {flagged.length > 0 && (
            <Card padding="18px 22px">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <Caps>{tr(lang, 'Flagged · review', 'A revisar')}</Caps>
                <Pill tone="warm">{flagged.length} {tr(lang, 'over 60m', 'sobre 60m')}</Pill>
              </div>
              <p style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, margin: '0 0 10px', fontStyle: 'italic' }}>
                {tr(lang, 'Do these long cleans count toward averages?', '¿Estas limpiezas largas cuentan en los promedios?')}
              </p>
              {flagged.map((f) => (
                <div key={f.id} style={{
                  display: 'grid', gridTemplateColumns: '52px 1fr 50px auto',
                  gap: 10, alignItems: 'center', padding: '10px 0', borderTop: `1px solid ${T.ruleSoft}`,
                }}>
                  <span style={{
                    fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 18,
                    color: T.ink, letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400,
                  }}>{f.roomNumber}</span>
                  <span style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink, minWidth: 0 }}>
                    {f.staffName}
                    <span style={{ color: T.ink3 }}>
                      {' · '}
                      {(() => {
                        const d = parseLocalDate(f.date);
                        return d ? format(d, 'MMM d') : f.date;
                      })()}
                    </span>
                  </span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.warm, fontWeight: 600 }}>
                    {f.durationMinutes.toFixed(0)}m
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn variant="ghost" size="sm" disabled={reviewingId === f.id} onClick={() => handleDecide(f.id, 'approved')}>
                      {tr(lang, 'Keep', 'Mantener')}
                    </Btn>
                    <Btn variant="paper" size="sm" disabled={reviewingId === f.id} onClick={() => handleDecide(f.id, 'rejected')}>
                      {tr(lang, 'Discard', 'Descartar')}
                    </Btn>
                  </div>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>

      {/* INSPECTION DRAWER */}
      {active && (
        <InspectDrawer
          active={active}
          submitting={submitting}
          lang={lang}
          onClose={handleCancel}
          onState={(id, st) => updateDraft(id, { state: st })}
          onNote={(id, n) => updateDraft(id, { note: n })}
          onUpload={handleUploadPhoto}
          onNotes={(n) => setActive((prev) => (prev ? { ...prev, notes: n } : prev))}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  );
}
