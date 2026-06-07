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
// No functionality from either source tab was dropped:
//   Inspections → queue poll (15s), filters, start/complete/cancel,
//     4-state severity (pass/minor/major/critical), per-item note + photo
//     upload + requiresPhotoOnFail guard, overall note, stats, history.
//   Performance → live realtime (Today) + ranged history, active-staff
//     leaderboard (min 3 rooms) with pace badges, provisional crew pills,
//     weighted cleaning-efficiency card, flagged keep/discard (30s poll),
//     and the real CSV export (NOT a toast).
//
// Data layers are untouched — same /api/housekeeping/inspections/* routes
// and the same cleaning-events db helpers (Migration 0012).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useTodayStr } from '@/lib/use-today-str';
import { fetchWithAuth } from '@/lib/api-fetch';
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
import type { StaffMember } from '@/types';
import type {
  Inspection,
  InspectionChecklist,
  InspectionChecklistItem,
  InspectionFailedItem,
  InspectionHistoryEntry,
  InspectionItemSeverity,
  InspectionQueueRoom,
  InspectionStats,
} from '@/types/inspections';

// ─── Shared types ──────────────────────────────────────────────────────────

type SeverityValue = InspectionItemSeverity | 'pass' | null;

interface ItemDraft {
  state: SeverityValue;
  note: string;
  photoUrl: string | null;
  photoPath: string | null;
  uploading: boolean;
}

type ViewMode = 'live' | '7d' | '30d' | '3mo' | '1yr';
const VIEW_DAYS: Record<ViewMode, number> = { live: 1, '7d': 7, '30d': 30, '3mo': 90, '1yr': 365 };
const LEADERBOARD_MIN_ROOMS = 3;

// Plan-v4 PMS rooms carry a synthetic composite id ("YYYY-MM-DD:roomNumber",
// see pms-rooms-server.composeRoomId), not a UUID. The inspections /start
// route validates roomId as a UUID and 400s on anything else, so only forward
// it when it's a real UUID — the flow otherwise keys on roomNumber, and the
// inspection row stores roomId=null harmlessly.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StaffStats {
  staffId: string;
  name: string;
  total: number;
  avgMins: number;
  avgCheckout: number | null;
  avgS1: number | null;
  avgS2: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tr(lang: 'en' | 'es', en: string, es: string): string {
  return lang === 'es' ? es : en;
}

// Decimal-minute format ("21.4m") — matches the design typography.
function fmtDec(mins: number | null | undefined): string {
  if (mins == null || !isFinite(mins)) return '—';
  return `${mins.toFixed(1)}m`;
}

// Parse YYYY-MM-DD as a *local* midnight (avoids the UTC "off by one day"
// bug that would render today's flagged cleans as yesterday west of UTC).
function parseLocalDate(ymd: string | null | undefined): Date | null {
  if (!ymd) return null;
  const parts = ymd.split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

// Coerces startedAt/completedAt for the CSV export. The CleaningEvent type
// narrows to Date in TS, but Supabase row mappers occasionally forward an
// ISO string (legacy rows that bypass the mapper); .toISOString() on a
// string throws mid-export, so accept both (+ Firestore .toDate()).
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  if (typeof v === 'object' && v !== null && 'toDate' in v && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return '';
}

// "12m" / "3h" / "2d" relative label from an ISO timestamp.
function relAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return null;
  const min = Math.round(ms / 60000);
  if (min < 1) return null; // → caller renders "just now"
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function categoryLabel(cat: string, lang: 'en' | 'es'): string {
  const map: Record<string, [string, string]> = {
    bathroom: ['Bathroom', 'Baño'],
    bedroom:  ['Bedroom', 'Dormitorio'],
    living:   ['Living', 'Sala'],
    kitchen:  ['Kitchen', 'Cocina'],
    welcome:  ['Welcome', 'Recepción'],
    other:    ['Other', 'Otro'],
  };
  const pair = map[cat] ?? [cat, cat];
  return lang === 'es' ? pair[1] : pair[0];
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

export function QualityTab() {
  const { user } = useAuth();
  const { activePropertyId, staff, staffLoaded } = useProperty();
  const { lang } = useLang();
  const today = useTodayStr();

  // ── Inspections state ──────────────────────────────────────────────────
  const [queue, setQueue] = useState<InspectionQueueRoom[]>([]);
  const [filter, setFilter] = useState<'all' | 'pending_inspection' | 'pending_recheck'>('all');
  const [queueLoading, setQueueLoading] = useState(true);
  const [active, setActive] = useState<{
    inspection: Inspection;
    checklist: InspectionChecklist;
    drafts: Map<string, ItemDraft>;
    notes: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stats, setStats] = useState<InspectionStats | null>(null);
  const [history, setHistory] = useState<InspectionHistoryEntry[]>([]);
  const [toast, setToast] = useState<string | null>(null);

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
      }
    } catch {
      // ignore — submit path surfaces real failures
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
        setToast(tr(lang, 'Could not start inspection', 'No se pudo iniciar la inspección'));
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
      setToast(tr(lang, 'Network error', 'Error de red'));
    }
  }, [activePropertyId, lang]);

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
            setToast(tr(lang,
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
        setToast(tr(lang,
          json?.error ?? 'Could not complete inspection',
          json?.error ?? 'No se pudo completar la inspección'));
        return;
      }
      setToast(result === 'pass'
        ? tr(lang, 'Inspection passed — room ready', 'Inspección aprobada — habitación lista')
        : tr(lang, 'Inspection failed — re-clean requested', 'Inspección reprobada — solicitada re-limpieza'));
      setActive(null);
      void refreshQueue();
      void refreshStats();
      void refreshHistory();
    } finally {
      setSubmitting(false);
    }
  }, [active, submitting, lang, refreshQueue, refreshStats, refreshHistory]);

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
        setToast(tr(lang, 'Photo upload failed', 'Carga de foto falló'));
        updateDraft(itemId, { uploading: false });
      }
    } catch {
      setToast(tr(lang, 'Photo upload failed', 'Carga de foto falló'));
      updateDraft(itemId, { uploading: false });
    }
  }, [active, lang, updateDraft]);

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
      setToast(decision === 'approved'
        ? tr(lang, 'Kept — counts toward averages', 'Mantenida — cuenta en los promedios')
        : tr(lang, 'Discarded from averages', 'Descartada de los promedios'));
    } catch (err) {
      console.error('[QualityTab] decide failed:', err);
      setToast(tr(lang, 'Could not save decision', 'No se pudo guardar la decisión'));
    } finally {
      setReviewingId(null);
    }
  }, [user, activePropertyId, lang]);

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
    setToast(tr(lang, 'Report exported', 'Reporte exportado'));
  }, [events, view, today, lang]);

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
      {toast && <Toast text={toast} onDismiss={() => setToast(null)} />}

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

// ══════════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ══════════════════════════════════════════════════════════════════════════════

function StatBand({ stats, lang }: { stats: InspectionStats | null; lang: 'en' | 'es' }) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const cardBase: React.CSSProperties = {
    border: `1px solid ${T.rule}`, borderRadius: 16, padding: '15px 18px',
    display: 'flex', flexDirection: 'column', gap: 7, background: T.paper,
  };
  const valStyle: React.CSSProperties = {
    fontFamily: FONT_SERIF, fontSize: 40, lineHeight: 0.9, color: T.ink,
    letterSpacing: '-0.02em', fontWeight: 400,
  };
  const reClean = stats?.reCleanRatePct ?? 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
      {/* Pass rate today — hero */}
      <div style={{
        ...cardBase,
        background: 'linear-gradient(135deg, rgba(92,122,96,0.10), rgba(92,122,96,0.02))',
        borderColor: 'rgba(92,122,96,0.22)',
      }}>
        <Caps>{tr(lang, 'Pass rate · today', 'Aprobación · hoy')}</Caps>
        <span style={{ ...valStyle, color: T.sageDeep }}>{stats ? pct(stats.todayPassRate) : '—'}</span>
        <div style={{ height: 6, background: T.ruleSoft, borderRadius: 999, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: stats ? pct(stats.todayPassRate) : '0%', background: T.sage, borderRadius: 999 }} />
        </div>
      </div>
      {/* Pass rate 7d */}
      <div style={cardBase}>
        <Caps>{tr(lang, 'Pass rate · 7d', 'Aprobación · 7d')}</Caps>
        <span style={valStyle}>{stats ? pct(stats.weekPassRate) : '—'}</span>
        <Caps c={T.ink3} size={11} tracking="0">{tr(lang, 'trailing week', 'semana previa')}</Caps>
      </div>
      {/* Re-clean rate */}
      <div style={cardBase}>
        <Caps>{tr(lang, 'Re-clean rate', 'Tasa re-limpieza')}</Caps>
        <span style={{ ...valStyle, color: reClean > 12 ? T.warm : T.ink }}>
          {stats ? reClean.toFixed(0) : '—'}<small style={{ fontSize: 18, color: T.ink2 }}>%</small>
        </span>
        <Caps c={T.ink3} size={11} tracking="0">{tr(lang, 'sent back', 'devueltas')}</Caps>
      </div>
      {/* Avg inspection */}
      <div style={cardBase}>
        <Caps>{tr(lang, 'Avg inspection', 'Inspección prom.')}</Caps>
        <span style={valStyle}>{stats ? fmtDec(stats.avgInspectionDurationSec / 60) : '—'}</span>
        <Caps c={T.ink3} size={11} tracking="0">{tr(lang, 'per room', 'por habitación')}</Caps>
      </div>
    </div>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 12px', borderRadius: 999,
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink2,
        border: `1px solid ${active ? T.ink : T.rule}`,
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500, cursor: 'pointer',
      }}
    >{label}</button>
  );
}

function QueueRow({ row, lang, onInspect }: { row: InspectionQueueRoom; lang: 'en' | 'es'; onInspect: () => void }) {
  const recheck = row.reason === 'pending_recheck';
  const ago = relAgo(row.completedAt);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '11px 13px', border: `1px solid ${T.rule}`, borderRadius: 12, background: T.paper,
    }}>
      <span style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 24, color: T.ink, lineHeight: 1, minWidth: 46, letterSpacing: '-0.02em' }}>
        {row.roomNumber}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <Pill tone={recheck ? 'warm' : 'sage'}>
            {recheck ? tr(lang, 'Re-check', 'Reinspección') : tr(lang, 'Pending', 'Pendiente')}
          </Pill>
          {row.priorFailCount > 0 && (
            <Pill tone="red">{row.priorFailCount} {tr(lang, 'fail', 'fallo')}</Pill>
          )}
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.housekeeperName ?? tr(lang, 'Unassigned', 'Sin asignar')}
          {' · '}
          {ago ? tr(lang, `cleaned ${ago} ago`, `limpiada hace ${ago}`) : tr(lang, 'just cleaned', 'recién limpiada')}
        </div>
      </div>
      <Btn variant="primary" size="sm" onClick={onInspect}>
        {tr(lang, 'Inspect', 'Inspeccionar')} →
      </Btn>
    </div>
  );
}

function HistoryCard({ rows, lang }: { rows: InspectionHistoryEntry[]; lang: 'en' | 'es' }) {
  return (
    <Card padding="18px 22px 14px">
      <Caps style={{ marginBottom: 10, display: 'block' }}>{tr(lang, 'Recent inspections', 'Inspecciones recientes')}</Caps>
      {rows.length === 0 ? (
        <div style={{ color: T.ink3, fontFamily: FONT_SANS, fontSize: 12 }}>
          {tr(lang, 'Nothing yet.', 'Nada por ahora.')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.slice(0, 6).map((r) => {
            const ago = relAgo(r.completedAt);
            return (
              <div key={r.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 0', borderTop: `1px solid ${T.ruleSoft}`,
              }}>
                <div style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{r.roomNumber}</span>
                  {r.inspectorName && <span style={{ color: T.ink3 }}> · {r.inspectorName.split(' ')[0]}</span>}
                  <span style={{ color: T.ink3 }}> · {ago ? tr(lang, `${ago} ago`, `hace ${ago}`) : tr(lang, 'just now', 'recién')}</span>
                </div>
                <Pill tone={r.result === 'pass' ? 'sage' : r.escalated ? 'red' : 'caramel'}>
                  {r.result === 'pass' ? tr(lang, 'Pass', 'Aprob.') : tr(lang, 'Fail', 'Falló')}
                  {r.failedItemCount > 0 && ` · ${r.failedItemCount}`}
                </Pill>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Leaderboard({
  rows, loading, lang, paceFor, staffShape,
}: {
  rows: StaffStats[];
  loading: boolean;
  lang: 'en' | 'es';
  paceFor: (s: StaffStats) => 'fast' | 'on' | 'slow';
  staffShape: (s: { staffId: string; name: string }) => Pick<StaffMember, 'id' | 'name'>;
}) {
  const cols = '24px 1fr 44px 58px 84px';
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center',
        padding: '10px 0', borderBottom: `1px solid ${T.ruleSoft}`,
      }}>
        <Caps size={9}>#</Caps>
        <Caps size={9}>{tr(lang, 'Crew', 'Limpiadora')}</Caps>
        <Caps size={9}>{tr(lang, 'Rooms', 'Cuartos')}</Caps>
        <Caps size={9}>{tr(lang, 'Avg', 'Tiempo')}</Caps>
        <Caps size={9}>{tr(lang, 'Pace', 'Ritmo')}</Caps>
      </div>
      {loading && (
        <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, padding: '18px 0' }}>
          {tr(lang, 'Loading…', 'Cargando…')}
        </p>
      )}
      {!loading && rows.length === 0 && (
        <p style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink2, padding: '18px 0', fontStyle: 'italic' }}>
          {tr(lang, 'Not enough data in this period yet.', 'Sin datos suficientes en este período.')}
        </p>
      )}
      {rows.map((r, i) => {
        const pace = paceFor(r);
        return (
          <div key={r.staffId} style={{
            display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center',
            padding: '11px 0', borderTop: `1px solid ${T.ruleSoft}`,
          }}>
            <span style={{
              fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 22,
              color: i < 3 ? T.ink : T.ink3, lineHeight: 1, letterSpacing: '-0.02em',
            }}>{i + 1}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
              <HousekeeperDot staff={staffShape(r)} size={30} />
              <span style={{ fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
            </div>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.ink }}>{r.total}</span>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: T.ink, fontWeight: 600 }}>{fmtDec(r.avgMins)}</span>
            <span>
              {pace === 'fast' && <Pill tone="sage">↑ {tr(lang, 'Fast', 'Rápido')}</Pill>}
              {pace === 'slow' && <Pill tone="warm">↓ {tr(lang, 'Slow', 'Lento')}</Pill>}
              {pace === 'on' && <Pill tone="neutral">· {tr(lang, 'On pace', 'En ritmo')}</Pill>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function EfficiencyCard({
  typeAvgs, eligibleCount, lang,
}: {
  typeAvgs: {
    overall: number | null; checkout: number | null; s1: number | null; s2: number | null;
    shareCheckout: number; shareS1: number; shareS2: number;
  };
  eligibleCount: number;
  lang: 'en' | 'es';
}) {
  const rows = [
    { l: tr(lang, 'Checkout', 'Salida'),       sub: tr(lang, 'full turnover', 'cambio total'), v: typeAvgs.checkout, tone: T.warm,        share: typeAvgs.shareCheckout },
    { l: tr(lang, 'Stay · light', 'Estadía · 1'), sub: tr(lang, 'day 1', 'día 1'),             v: typeAvgs.s1,       tone: T.sageDeep,    share: typeAvgs.shareS1 },
    { l: tr(lang, 'Stay · full', 'Estadía · 2'),  sub: tr(lang, 'day 2+', 'día 2+'),           v: typeAvgs.s2,       tone: T.caramelDeep, share: typeAvgs.shareS2 },
  ];
  return (
    <Card padding="20px 22px">
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${T.rule}`,
      }}>
        <Caps>{tr(lang, 'Cleaning efficiency', 'Eficiencia de limpieza')}</Caps>
        <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink2 }}>
          {eligibleCount} {tr(lang, 'cleans', 'limpiezas')}
        </span>
      </div>
      {/* Overall hero */}
      <div style={{ paddingBottom: 12, borderBottom: `1px solid ${T.ruleSoft}` }}>
        <Caps size={9}>{tr(lang, 'Overall avg', 'Promedio general')}</Caps>
        <div style={{ marginTop: 6 }}>
          <span style={{ fontFamily: FONT_SERIF, fontSize: 40, color: T.ink, letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400 }}>
            {typeAvgs.overall != null ? (
              <>
                <span style={{ fontStyle: 'italic' }}>{typeAvgs.overall.toFixed(1)}</span>
                <span style={{ fontSize: 20, color: T.ink2, fontStyle: 'italic' }}>m</span>
              </>
            ) : '—'}
          </span>
        </div>
      </div>
      {/* Per-type */}
      {rows.map((e, i) => (
        <div key={e.l} style={{ padding: '12px 0', borderBottom: i < rows.length - 1 ? `1px solid ${T.ruleSoft}` : 'none' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontFamily: FONT_SANS, fontSize: 13, color: T.ink, fontWeight: 500 }}>{e.l}</span>
              <Caps size={9} tracking="0.06em">{e.sub}</Caps>
            </div>
            <span style={{ fontFamily: FONT_SERIF, fontSize: 24, color: e.tone, letterSpacing: '-0.02em', lineHeight: 1, fontWeight: 400 }}>
              {e.v != null ? (
                <>
                  <span style={{ fontStyle: 'italic' }}>{e.v.toFixed(1)}</span>
                  <span style={{ fontSize: 13, color: T.ink2, fontStyle: 'italic' }}>m</span>
                </>
              ) : '—'}
            </span>
          </div>
          <div style={{ height: 5, background: T.ruleSoft, borderRadius: 999, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.round(e.share * 100)}%`, background: e.tone, borderRadius: 999 }} />
          </div>
          <Caps size={9} tracking="0.06em" style={{ marginTop: 4, display: 'inline-block' }}>
            {Math.round(e.share * 100)}% {tr(lang, 'of cleans', 'de limpiezas')}
          </Caps>
        </div>
      ))}
    </Card>
  );
}

// ─── Inspection drawer ───────────────────────────────────────────────────────

function InspectDrawer({
  active, submitting, lang, onClose, onState, onNote, onUpload, onNotes, onSubmit,
}: {
  active: { inspection: Inspection; checklist: InspectionChecklist; drafts: Map<string, ItemDraft>; notes: string };
  submitting: boolean;
  lang: 'en' | 'es';
  onClose: () => void;
  onState: (id: string, st: SeverityValue) => void;
  onNote: (id: string, n: string) => void;
  onUpload: (id: string, file: File) => void;
  onNotes: (n: string) => void;
  onSubmit: (r: 'pass' | 'fail') => void;
}) {
  // Escape closes (and cancels) the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const byCategory = useMemo(() => {
    const m = new Map<string, InspectionChecklistItem[]>();
    for (const it of active.checklist.items) {
      const arr = m.get(it.category) ?? [];
      arr.push(it);
      m.set(it.category, arr);
    }
    return m;
  }, [active.checklist.items]);

  const allDecided = active.checklist.items.every((it) => active.drafts.get(it.id)?.state != null);
  const anyFail = active.checklist.items.some((it) => {
    const st = active.drafts.get(it.id)?.state;
    return st === 'minor' || st === 'major' || st === 'critical';
  });

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(24,22,17,0.34)', zIndex: 1000, display: 'flex' }}
    >
      <div style={{
        marginLeft: 'auto', width: 'min(460px, 96vw)', height: '100%', background: T.paper,
        padding: '22px 24px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Caps>{tr(lang, 'Inspect room', 'Inspeccionar habitación')}</Caps>
            <div style={{ fontFamily: FONT_SERIF, fontStyle: 'italic', fontSize: 40, color: T.ink, letterSpacing: '-0.02em', lineHeight: 1, margin: '2px 0 4px' }}>
              {active.inspection.roomNumber}
            </div>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
              {active.checklist.name} · {active.checklist.items.length} {tr(lang, 'checks', 'puntos')}
            </span>
          </div>
          <Btn variant="ghost" size="sm" onClick={onClose}>{tr(lang, 'Close', 'Cerrar')}</Btn>
        </div>

        {/* Checklist */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {Array.from(byCategory.entries()).map(([category, items]) => (
            <div key={category}>
              <Caps style={{ display: 'block', margin: '12px 0 8px' }}>{categoryLabel(category, lang)}</Caps>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((item) => (
                  <ChecklistRow
                    key={item.id}
                    item={item}
                    draft={active.drafts.get(item.id) ?? { state: null, note: '', photoUrl: null, photoPath: null, uploading: false }}
                    lang={lang}
                    onState={(st) => onState(item.id, st)}
                    onNote={(n) => onNote(item.id, n)}
                    onFile={(f) => onUpload(item.id, f)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Overall note */}
        <textarea
          placeholder={tr(lang, 'Optional note to housekeeper / manager', 'Nota opcional para la limpieza / gerente')}
          value={active.notes}
          onChange={(e) => onNotes(e.target.value)}
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 12,
            border: `1px solid ${T.rule}`, fontFamily: FONT_SANS, fontSize: 13, color: T.ink, resize: 'vertical',
          }}
        />

        {/* Sticky submit bar */}
        <div style={{
          position: 'sticky', bottom: 0, background: T.paper, paddingTop: 10,
          borderTop: `1px solid ${T.rule}`, display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center',
        }}>
          {!allDecided && (
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
              {tr(lang, 'Mark every check to submit', 'Marca cada punto para enviar')}
            </span>
          )}
          {allDecided && !anyFail && (
            <Btn variant="sage" size="lg" onClick={() => onSubmit('pass')} disabled={submitting}>
              {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, '✓ Pass — room ready', '✓ Aprobar — lista')}
            </Btn>
          )}
          {allDecided && anyFail && (
            <Btn variant="primary" size="lg" onClick={() => onSubmit('fail')} disabled={submitting} style={{ background: T.warm, borderColor: T.warm }}>
              {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, 'Send for re-clean →', 'Enviar a re-limpieza →')}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function ChecklistRow({
  item, draft, lang, onState, onNote, onFile,
}: {
  item: InspectionChecklistItem;
  draft: ItemDraft;
  lang: 'en' | 'es';
  onState: (st: SeverityValue) => void;
  onNote: (n: string) => void;
  onFile: (f: File) => void;
}) {
  const label = lang === 'es' && item.labelEs ? item.labelEs : item.label;
  const isFail = draft.state === 'minor' || draft.state === 'major' || draft.state === 'critical';
  const isCritical = draft.state === 'critical';
  return (
    <div style={{
      border: `1px solid ${isFail ? (isCritical ? 'rgba(160,74,44,0.35)' : 'rgba(184,92,61,0.35)') : T.rule}`,
      borderRadius: 12, padding: '11px 13px',
      background: isFail ? (isCritical ? T.redDim : T.warmDim) : T.paper,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontFamily: FONT_SANS, fontSize: 13.5, color: T.ink }}>
          {label}
          {item.requiresPhotoOnFail && (
            <span style={{ marginLeft: 6, color: T.warm, fontSize: 9, fontFamily: FONT_MONO }}>
              {tr(lang, 'PHOTO', 'FOTO')}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <SevButton label={tr(lang, 'Pass', 'Aprob.')} active={draft.state === 'pass'} tone="sage" onClick={() => onState('pass')} />
          <SevButton label={tr(lang, 'Minor', 'Menor')} active={draft.state === 'minor'} tone="warm" onClick={() => onState('minor')} />
          <SevButton label={tr(lang, 'Major', 'Mayor')} active={draft.state === 'major'} tone="warm" onClick={() => onState('major')} />
          <SevButton label={tr(lang, 'Critical', 'Crítico')} active={draft.state === 'critical'} tone="red" onClick={() => onState('critical')} />
        </div>
      </div>
      {isFail && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            placeholder={tr(lang, 'Note (what to fix)', 'Nota (qué corregir)')}
            value={draft.note}
            onChange={(e) => onNote(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 10,
              border: `1px solid ${T.rule}`, background: T.paper, fontFamily: FONT_SANS, fontSize: 12, color: T.ink,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999,
              border: `1px solid ${T.rule}`, background: T.paper, fontFamily: FONT_SANS, fontSize: 12, color: T.ink, cursor: 'pointer',
            }}>
              {draft.uploading
                ? tr(lang, 'Uploading…', 'Subiendo…')
                : draft.photoUrl
                  ? tr(lang, 'Replace photo', 'Cambiar foto')
                  : tr(lang, 'Add photo', 'Agregar foto')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
              />
            </label>
            {draft.photoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.photoUrl} alt="" style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', border: `1px solid ${T.rule}` }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SevButton({
  label, active, tone, onClick,
}: {
  label: string; active: boolean; tone: 'sage' | 'warm' | 'red'; onClick: () => void;
}) {
  const palette = {
    sage: { bg: T.sageDim, fg: T.sageDeep },
    warm: { bg: T.warmDim, fg: T.warm },
    red:  { bg: T.redDim,  fg: T.red },
  }[tone];
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 9px', borderRadius: 999,
        background: active ? palette.bg : 'transparent',
        color: active ? palette.fg : T.ink3,
        border: `1px solid ${active ? palette.fg : T.rule}`,
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >{label}</button>
  );
}

function Toast({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onDismiss, 3200);
    return () => window.clearTimeout(id);
  }, [onDismiss]);
  return (
    <div
      role="status"
      style={{
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        zIndex: 1200, maxWidth: 'calc(100vw - 24px)',
        background: T.sageDim, color: T.sageDeep, border: `1px solid rgba(92,122,96,0.3)`,
        padding: '11px 18px', borderRadius: 999,
        fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500,
        boxShadow: '0 8px 24px rgba(0,0,0,0.10)',
      }}
    >{text}</div>
  );
}
