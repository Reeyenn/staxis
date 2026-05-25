'use client';

// Inspections tab — manager-facing inspection workflow.
//
// Reads from /api/housekeeping/inspections/* and uses the same Snow
// design system primitives as the other tabs (RoomsTab, ScheduleTab).
// Three panels:
//   • Queue (left) — rooms pending inspection or re-check
//   • Detail (center) — when a room is selected, the checklist + pass/fail
//   • Stats + History (right) — sidebar with today's pass rate, top
//     failures, recent history
//
// Side effects live server-side; this component only fires the
// /complete request and refreshes the queue from the response.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { useTodayStr } from '@/lib/use-today-str';
import { fetchWithAuth } from '@/lib/api-fetch';
import { format } from 'date-fns';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, Card,
} from './_snow';
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

type SeverityValue = InspectionItemSeverity | 'pass' | null;

interface ItemDraft {
  state: SeverityValue;
  note: string;
  photoUrl: string | null;
  photoPath: string | null;
  uploading: boolean;
}

function tr(lang: 'en' | 'es', en: string, es: string): string {
  return lang === 'es' ? es : en;
}

export function InspectionsTab() {
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const today = useTodayStr();

  const [queue, setQueue] = useState<InspectionQueueRoom[]>([]);
  const [filter, setFilter] = useState<'all' | 'pending_inspection' | 'pending_recheck'>('all');
  const [loading, setLoading] = useState(true);
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

  // ── Data loaders ───────────────────────────────────────────────────────
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
      // ignore — toast surfaces real failures via submit
    } finally {
      setLoading(false);
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
    }, 15_000);  // poll every 15s — realtime channel isn't wired yet
    return () => window.clearInterval(id);
  }, [refreshQueue, refreshStats, refreshHistory]);

  // ── Filtering ──────────────────────────────────────────────────────────
  const visibleQueue = useMemo(() => {
    if (filter === 'all') return queue;
    return queue.filter((q) => q.reason === filter);
  }, [queue, filter]);

  // ── Inspect button: start an inspection and open the checklist ─────────
  const handleStart = useCallback(async (room: InspectionQueueRoom) => {
    if (!activePropertyId) return;
    try {
      const res = await fetchWithAuth('/api/housekeeping/inspections/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: activePropertyId,
          roomId: room.roomId,
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

  // ── Submit pass / fail ─────────────────────────────────────────────────
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

      // Client-side guard for fail-with-photo-required.
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
    try {
      await fetchWithAuth(
        `/api/housekeeping/inspections/${active.inspection.id}/cancel`,
        { method: 'POST' },
      );
    } catch {
      // ignore — cancel is best-effort
    } finally {
      setActive(null);
      void refreshQueue();
    }
  }, [active, refreshQueue]);

  // ── Per-item draft updates ─────────────────────────────────────────────
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

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px 48px 48px', background: T.bg, minHeight: '60dvh' }}>
      {toast && <Toast text={toast} onDismiss={() => setToast(null)} />}

      <div style={{
        display: 'grid',
        gridTemplateColumns: active ? '320px 1fr 300px' : '1fr 300px',
        gap: 18,
        alignItems: 'flex-start',
      }}>
        {/* Queue / Filters */}
        <Card padding="18px 18px 16px">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <Caps>{tr(lang, 'Queue', 'Cola')}</Caps>
            <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: T.ink3 }}>
              {visibleQueue.length}/{queue.length}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            <FilterPill label={tr(lang, 'All', 'Todas')} active={filter === 'all'} onClick={() => setFilter('all')} />
            <FilterPill label={tr(lang, 'Pending', 'Pendientes')} active={filter === 'pending_inspection'} onClick={() => setFilter('pending_inspection')} />
            <FilterPill label={tr(lang, 'Re-check', 'Reinspección')} active={filter === 'pending_recheck'} onClick={() => setFilter('pending_recheck')} />
          </div>
          {loading ? (
            <div style={{ padding: 16, color: T.ink3, fontFamily: FONT_SANS, fontSize: 13 }}>
              {tr(lang, 'Loading…', 'Cargando…')}
            </div>
          ) : visibleQueue.length === 0 ? (
            <div style={{ padding: '20px 12px', color: T.ink2, fontFamily: FONT_SANS, fontSize: 13, textAlign: 'center' }}>
              {tr(lang, 'No rooms waiting for inspection.', 'No hay habitaciones esperando inspección.')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {visibleQueue.map((q) => (
                <QueueRow
                  key={q.roomId}
                  row={q}
                  active={active?.inspection.roomNumber === q.roomNumber}
                  lang={lang}
                  onInspect={() => handleStart(q)}
                />
              ))}
            </div>
          )}
        </Card>

        {/* Active inspection */}
        {active && (
          <Card padding="22px 24px 24px">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontFamily: FONT_SERIF, fontSize: 26, color: T.ink, letterSpacing: '-0.02em' }}>
                {tr(lang, 'Room', 'Habitación')} {active.inspection.roomNumber}
              </span>
              <button
                onClick={handleCancel}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: T.ink3, fontFamily: FONT_SANS, fontSize: 12,
                }}
              >
                {tr(lang, 'Cancel', 'Cancelar')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, color: T.ink2, fontFamily: FONT_SANS, fontSize: 12 }}>
              <span>{active.checklist.name}</span>
              <span style={{ color: T.ink3 }}>•</span>
              <span>{active.checklist.items.length} {tr(lang, 'items', 'puntos')}</span>
            </div>

            <ChecklistBody
              checklist={active.checklist}
              drafts={active.drafts}
              lang={lang}
              onState={(id, st) => updateDraft(id, { state: st })}
              onNote={(id, n) => updateDraft(id, { note: n })}
              onUpload={handleUploadPhoto}
            />

            <div style={{ marginTop: 18 }}>
              <textarea
                placeholder={tr(lang, 'Optional note to housekeeper / manager', 'Nota opcional para la limpieza / gerente')}
                value={active.notes}
                onChange={(e) => setActive((prev) => prev ? { ...prev, notes: e.target.value } : prev)}
                rows={2}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 12px', borderRadius: 12,
                  border: `1px solid ${T.rule}`,
                  fontFamily: FONT_SANS, fontSize: 13, color: T.ink,
                  resize: 'vertical',
                }}
              />
            </div>

            <SubmitBar
              active={active}
              submitting={submitting}
              lang={lang}
              onSubmit={handleSubmit}
            />
          </Card>
        )}

        {/* Sidebar — stats + history */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <StatsCard stats={stats} lang={lang} />
          <HistoryCard rows={history} lang={lang} />
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 12px', borderRadius: 999,
        background: active ? T.ink : 'transparent',
        color: active ? T.bg : T.ink2,
        border: `1px solid ${active ? T.ink : T.rule}`,
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
        cursor: 'pointer',
      }}
    >{label}</button>
  );
}

function QueueRow({
  row, active, lang, onInspect,
}: {
  row: InspectionQueueRoom; active: boolean; lang: 'en' | 'es'; onInspect: () => void;
}) {
  const tone = row.reason === 'pending_recheck' ? 'warm' : 'sage';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px',
      border: `1px solid ${active ? T.ink : T.rule}`,
      borderRadius: 12,
      background: active ? T.sageDim : T.paper,
    }}>
      <span style={{ fontFamily: FONT_SERIF, fontSize: 22, color: T.ink, lineHeight: 1, minWidth: 56 }}>
        {row.roomNumber}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <Pill tone={tone}>
            {row.reason === 'pending_recheck'
              ? tr(lang, 'Re-check', 'Reinspección')
              : tr(lang, 'Pending', 'Pendiente')}
          </Pill>
          {row.priorFailCount > 0 && (
            <Pill tone="red">
              {row.priorFailCount} {tr(lang, 'fails', 'fallos')}
            </Pill>
          )}
        </div>
        <div style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {row.housekeeperName ?? tr(lang, 'Unassigned', 'Sin asignar')} ·{' '}
          {row.completedAt ? format(new Date(row.completedAt), 'h:mm a') : '—'}
        </div>
      </div>
      <Btn variant="primary" size="sm" onClick={onInspect}>
        {tr(lang, 'Inspect', 'Inspeccionar')}
      </Btn>
    </div>
  );
}

function ChecklistBody({
  checklist, drafts, lang, onState, onNote, onUpload,
}: {
  checklist: InspectionChecklist;
  drafts: Map<string, ItemDraft>;
  lang: 'en' | 'es';
  onState: (id: string, st: SeverityValue) => void;
  onNote: (id: string, n: string) => void;
  onUpload: (id: string, file: File) => void;
}) {
  const byCategory = useMemo(() => {
    const m = new Map<string, InspectionChecklistItem[]>();
    for (const it of checklist.items) {
      const cat = it.category;
      const arr = m.get(cat) ?? [];
      arr.push(it);
      m.set(cat, arr);
    }
    return m;
  }, [checklist.items]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {Array.from(byCategory.entries()).map(([category, items]) => (
        <div key={category}>
          <Caps style={{ marginBottom: 8 }}>{categoryLabel(category, lang)}</Caps>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((item) => (
              <ChecklistRow
                key={item.id}
                item={item}
                draft={drafts.get(item.id) ?? { state: null, note: '', photoUrl: null, photoPath: null, uploading: false }}
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
  const showFailBlock = draft.state === 'minor' || draft.state === 'major' || draft.state === 'critical';

  return (
    <div style={{
      border: `1px solid ${T.rule}`, borderRadius: 12, padding: '12px 14px',
      background: showFailBlock ? T.warmDim : T.paper,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, fontFamily: FONT_SANS, fontSize: 13, color: T.ink }}>
          {label}
          {item.requiresPhotoOnFail && (
            <span style={{ marginLeft: 6, color: T.warm, fontSize: 10, fontFamily: FONT_MONO }}>
              {tr(lang, 'PHOTO REQ', 'FOTO REQ')}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <SevButton label={tr(lang, 'Pass', 'Aprobar')} active={draft.state === 'pass'} tone="sage" onClick={() => onState('pass')} />
          <SevButton label={tr(lang, 'Minor', 'Menor')} active={draft.state === 'minor'} tone="warm" onClick={() => onState('minor')} />
          <SevButton label={tr(lang, 'Major', 'Mayor')} active={draft.state === 'major'} tone="warm" onClick={() => onState('major')} />
          <SevButton label={tr(lang, 'Critical', 'Crítico')} active={draft.state === 'critical'} tone="red" onClick={() => onState('critical')} />
        </div>
      </div>

      {showFailBlock && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            placeholder={tr(lang, 'Note (what to fix)', 'Nota (qué corregir)')}
            value={draft.note}
            onChange={(e) => onNote(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '8px 10px', borderRadius: 10,
              border: `1px solid ${T.rule}`, background: T.paper,
              fontFamily: FONT_SANS, fontSize: 12, color: T.ink,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 999,
              border: `1px solid ${T.rule}`, background: T.paper,
              fontFamily: FONT_SANS, fontSize: 12, color: T.ink,
              cursor: 'pointer',
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
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onFile(f);
                }}
              />
            </label>
            {draft.photoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={draft.photoUrl}
                alt=""
                style={{ width: 48, height: 48, borderRadius: 8, objectFit: 'cover', border: `1px solid ${T.rule}` }}
              />
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
    red:  { bg: T.redDim, fg: T.red },
  }[tone];
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 9px', borderRadius: 999,
        background: active ? palette.bg : 'transparent',
        color: active ? palette.fg : T.ink3,
        border: `1px solid ${active ? palette.fg : T.rule}`,
        fontFamily: FONT_SANS, fontSize: 11, fontWeight: 500,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  );
}

function SubmitBar({
  active, submitting, lang, onSubmit,
}: {
  active: { drafts: Map<string, ItemDraft>; checklist: InspectionChecklist };
  submitting: boolean;
  lang: 'en' | 'es';
  onSubmit: (r: 'pass' | 'fail') => void;
}) {
  const allDecided = active.checklist.items.every((it) => active.drafts.get(it.id)?.state != null);
  const anyFail = active.checklist.items.some((it) => {
    const st = active.drafts.get(it.id)?.state;
    return st === 'minor' || st === 'major' || st === 'critical';
  });
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
      {allDecided && !anyFail && (
        <Btn variant="sage" size="lg" onClick={() => onSubmit('pass')} disabled={submitting}>
          {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, '✓ Pass', '✓ Aprobar')}
        </Btn>
      )}
      {anyFail && (
        <Btn
          variant="primary"
          size="lg"
          onClick={() => onSubmit('fail')}
          disabled={submitting}
          style={{ background: T.warm, borderColor: T.warm }}
        >
          {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, 'Send for re-clean', 'Enviar a re-limpieza')}
        </Btn>
      )}
      {!allDecided && (
        <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink3, alignSelf: 'center' }}>
          {tr(lang, 'Decide every item to submit', 'Decida cada punto para enviar')}
        </span>
      )}
    </div>
  );
}

function StatsCard({ stats, lang }: { stats: InspectionStats | null; lang: 'en' | 'es' }) {
  return (
    <Card padding="18px 18px 16px">
      <Caps style={{ marginBottom: 12 }}>{tr(lang, 'Today', 'Hoy')}</Caps>
      {!stats ? (
        <div style={{ color: T.ink3, fontFamily: FONT_SANS, fontSize: 13 }}>
          {tr(lang, 'Loading stats…', 'Cargando…')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <StatLine label={tr(lang, 'Pass rate today', 'Tasa de aprobación hoy')} value={`${Math.round(stats.todayPassRate * 100)}%`} />
          <StatLine label={tr(lang, 'Pass rate (7d)', 'Tasa (7d)')} value={`${Math.round(stats.weekPassRate * 100)}%`} />
          <StatLine label={tr(lang, 'Re-clean rate', 'Tasa re-limpieza')} value={`${stats.reCleanRatePct.toFixed(0)}%`} />
          <StatLine label={tr(lang, 'Avg duration', 'Duración promedio')} value={`${Math.round(stats.avgInspectionDurationSec / 60)}m`} />
          {stats.topFailureItems.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <Caps style={{ marginBottom: 6 }}>{tr(lang, 'Top failures', 'Fallos más comunes')}</Caps>
              {stats.topFailureItems.map((f) => (
                <div key={f.label} style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontFamily: FONT_SANS, fontSize: 12, color: T.ink2,
                  padding: '3px 0',
                }}>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {f.label}
                  </span>
                  <span style={{ fontFamily: FONT_MONO, marginLeft: 6 }}>{f.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StatLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    }}>
      <span style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink2 }}>{label}</span>
      <span style={{ fontFamily: FONT_MONO, fontSize: 14, color: T.ink, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function HistoryCard({ rows, lang }: { rows: InspectionHistoryEntry[]; lang: 'en' | 'es' }) {
  return (
    <Card padding="18px 18px 14px">
      <Caps style={{ marginBottom: 10 }}>{tr(lang, 'Recent history', 'Historial reciente')}</Caps>
      {rows.length === 0 ? (
        <div style={{ color: T.ink3, fontFamily: FONT_SANS, fontSize: 12 }}>
          {tr(lang, 'Nothing yet.', 'Nada por ahora.')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((r) => (
            <div key={r.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 0', borderBottom: `1px solid ${T.ruleSoft}`,
            }}>
              <div style={{ fontFamily: FONT_SANS, fontSize: 12, color: T.ink, minWidth: 0 }}>
                <span style={{ fontWeight: 600 }}>{r.roomNumber}</span>
                {r.inspectorName && (
                  <span style={{ color: T.ink3, marginLeft: 4 }}>· {r.inspectorName}</span>
                )}
              </div>
              <Pill tone={r.result === 'pass' ? 'sage' : r.escalated ? 'red' : 'warm'}>
                {r.result === 'pass' ? tr(lang, 'Pass', 'Aprob.') : tr(lang, 'Fail', 'Falló')}
                {r.failedItemCount > 0 && ` · ${r.failedItemCount}`}
              </Pill>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Toast({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onDismiss, 4500);
    return () => window.clearTimeout(id);
  }, [onDismiss]);
  return (
    <div
      role="status"
      style={{
        position: 'fixed', top: 78, left: '50%', transform: 'translateX(-50%)',
        zIndex: 1000, maxWidth: 'calc(100vw - 24px)', width: 380,
        background: T.ink, color: T.bg,
        padding: '10px 14px', borderRadius: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
        fontFamily: FONT_SANS, fontSize: 13,
      }}
    >{text}</div>
  );
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
