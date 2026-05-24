'use client';

// InspectorView — the mobile inspection surface for /housekeeper/[id].
//
// Rendered above the housekeeper's regular cleaning queue. Self-decides
// whether to render based on the staff member's can_inspect flag — if
// false, the component returns null so non-inspector housekeepers see
// nothing extra.
//
// For staff who BOTH inspect and clean (head_housekeeper), the regular
// cleaning queue still renders below this component (housekeeper/[id]
// page.tsx renders both unconditionally — InspectorView is additive).
//
// Optimized for phone screens: single-column layout, big tap targets,
// progressive disclosure (queue → checklist → fail/note/photo per
// failed item).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTodayStr } from '@/lib/use-today-str';
import { format } from 'date-fns';
import { CheckCircle, AlertTriangle, Camera, ChevronLeft } from 'lucide-react';
import type {
  Inspection,
  InspectionChecklist,
  InspectionChecklistItem,
  InspectionFailedItem,
  InspectionItemSeverity,
  InspectionQueueRoom,
} from '@/types/inspections';

type SeverityValue = InspectionItemSeverity | 'pass' | null;

interface ItemDraft {
  state: SeverityValue;
  note: string;
  photoUrl: string | null;
  uploading: boolean;
}

function tr(lang: 'en' | 'es', en: string, es: string): string {
  return lang === 'es' ? es : en;
}

export default function InspectorView({
  pid,
  staffId,
  lang,
}: {
  pid: string;
  staffId: string;
  lang: 'en' | 'es';
}) {
  const today = useTodayStr();
  const [canInspect, setCanInspect] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<InspectionQueueRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<{
    inspection: Inspection;
    checklist: InspectionChecklist;
    drafts: Map<string, ItemDraft>;
    notes: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // ── Bootstrap: fetch can_inspect + queue together ──────────────────────
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/housekeeper/inspections/me?pid=${encodeURIComponent(pid)}&staffId=${encodeURIComponent(staffId)}&date=${today}`,
      );
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        setCanInspect(Boolean(json.data?.canInspect));
        if (Array.isArray(json.data?.queue)) setQueue(json.data.queue as InspectionQueueRoom[]);
      } else {
        setCanInspect(false);
      }
    } catch {
      setCanInspect(false);
    } finally {
      setLoading(false);
    }
  }, [pid, staffId, today]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (canInspect !== true) return;
    pollRef.current = window.setInterval(() => {
      void refresh();
    }, 20_000);  // every 20s — light poll, easy on cell data
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [canInspect, refresh]);

  // ── Start an inspection ────────────────────────────────────────────────
  const handleStart = useCallback(async (row: InspectionQueueRoom) => {
    try {
      const res = await fetch('/api/housekeeper/inspections/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid,
          staffId,
          roomId: row.roomId,
          roomNumber: row.roomNumber,
          roomType: row.roomType || null,
          parentInspectionId: row.parentInspectionId,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setToast(tr(lang, 'Could not start inspection', 'No se pudo iniciar'));
        return;
      }
      const inspection = json.data.inspection as Inspection;
      const checklist = json.data.checklist as InspectionChecklist;
      const drafts = new Map<string, ItemDraft>();
      for (const item of checklist.items) {
        drafts.set(item.id, { state: null, note: '', photoUrl: null, uploading: false });
      }
      setActive({ inspection, checklist, drafts, notes: '' });
    } catch {
      setToast(tr(lang, 'Network error', 'Error de red'));
    }
  }, [pid, staffId, lang]);

  // ── Per-item draft updates ─────────────────────────────────────────────
  const updateDraft = useCallback((itemId: string, patch: Partial<ItemDraft>) => {
    setActive((prev) => {
      if (!prev) return prev;
      const drafts = new Map(prev.drafts);
      const cur = drafts.get(itemId) ?? { state: null, note: '', photoUrl: null, uploading: false };
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
      fd.append('pid', pid);
      fd.append('staffId', staffId);
      const res = await fetch('/api/housekeeper/inspections/upload-photo', {
        method: 'POST',
        body: fd,
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok && json.data?.url) {
        updateDraft(itemId, { photoUrl: json.data.url, uploading: false });
      } else {
        setToast(tr(lang, 'Photo upload failed', 'Carga de foto falló'));
        updateDraft(itemId, { uploading: false });
      }
    } catch {
      setToast(tr(lang, 'Photo upload failed', 'Carga de foto falló'));
      updateDraft(itemId, { uploading: false });
    }
  }, [active, pid, staffId, lang, updateDraft]);

  // ── Submit ─────────────────────────────────────────────────────────────
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
            note: d.note || null,
          });
        }
      }

      if (result === 'fail') {
        for (const f of failedItems) {
          const item = active.checklist.items.find((i) => i.id === f.itemId);
          if (item?.requiresPhotoOnFail && !f.photoUrl) {
            setToast(tr(lang,
              `${item.label} needs a photo`,
              `${item.label} necesita foto`));
            setSubmitting(false);
            return;
          }
        }
      }

      const res = await fetch(`/api/housekeeper/inspections/${active.inspection.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid, staffId,
          result,
          failedItems,
          passedItems,
          notes: active.notes || null,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setToast(json?.error ?? tr(lang, 'Could not save', 'No se pudo guardar'));
        return;
      }
      setToast(result === 'pass'
        ? tr(lang, 'Inspection passed', 'Inspección aprobada')
        : tr(lang, 'Sent back for re-clean', 'Enviada a re-limpieza'));
      setActive(null);
      void refresh();
    } finally {
      setSubmitting(false);
    }
  }, [active, submitting, pid, staffId, lang, refresh]);

  // ── Render gates ───────────────────────────────────────────────────────
  if (loading) return null;
  if (canInspect !== true) return null;

  // Active checklist mode — full screen overlay-ish.
  if (active) {
    return (
      <div style={{
        background: 'white',
        borderRadius: 18,
        margin: '12px 16px 4px',
        padding: '18px 16px 18px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        border: '1px solid #E5E7EB',
      }}>
        {toast && <Toast text={toast} onDismiss={() => setToast(null)} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <button
            onClick={() => setActive(null)}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer',
              padding: 6, color: '#374151', display: 'inline-flex',
            }}
            aria-label="Back"
          >
            <ChevronLeft size={20} />
          </button>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#111827', lineHeight: 1.1 }}>
              {tr(lang, 'Inspect', 'Inspeccionar')} {active.inspection.roomNumber}
            </div>
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>
              {active.checklist.name} · {active.checklist.items.length} {tr(lang, 'items', 'puntos')}
            </div>
          </div>
        </div>

        <MobileChecklistBody
          checklist={active.checklist}
          drafts={active.drafts}
          lang={lang}
          onState={(id, st) => updateDraft(id, { state: st })}
          onNote={(id, n) => updateDraft(id, { note: n })}
          onUpload={handleUploadPhoto}
        />

        <textarea
          value={active.notes}
          onChange={(e) => setActive((prev) => prev ? { ...prev, notes: e.target.value } : prev)}
          placeholder={tr(lang, 'Optional note', 'Nota opcional')}
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box', marginTop: 16,
            padding: '10px 12px', borderRadius: 12, border: '1px solid #E5E7EB',
            fontSize: 14, color: '#111827', resize: 'vertical',
          }}
        />

        <MobileSubmitBar
          active={active}
          submitting={submitting}
          lang={lang}
          onSubmit={handleSubmit}
        />
      </div>
    );
  }

  // Queue mode.
  return (
    <div style={{ margin: '12px 16px 0' }}>
      {toast && <Toast text={toast} onDismiss={() => setToast(null)} />}
      <div style={{
        background: 'white', borderRadius: 18, padding: '14px 14px 12px',
        border: '1px solid #E5E7EB',
        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        }}>
          <CheckCircle size={18} color="#6B7280" />
          <span style={{ fontSize: 14, fontWeight: 700, color: '#111827', flex: 1 }}>
            {tr(lang, 'Inspections', 'Inspecciones')}
          </span>
          <span style={{ fontSize: 12, color: '#6B7280' }}>
            {queue.length} {tr(lang, 'waiting', 'esperando')}
          </span>
        </div>
        {queue.length === 0 ? (
          <div style={{
            padding: '14px 4px', textAlign: 'center',
            color: '#6B7280', fontSize: 13,
          }}>
            {tr(lang, 'Nothing waiting right now.', 'Nada esperando ahora.')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {queue.map((r) => (
              <MobileQueueRow key={r.roomId} row={r} lang={lang} onInspect={() => handleStart(r)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components (mobile) ─────────────────────────────────────────────

function MobileQueueRow({
  row, lang, onInspect,
}: {
  row: InspectionQueueRoom; lang: 'en' | 'es'; onInspect: () => void;
}) {
  const recheck = row.reason === 'pending_recheck';
  return (
    <button
      onClick={onInspect}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px', borderRadius: 14,
        background: recheck ? '#FEF2F2' : '#F9FAFB',
        border: `1px solid ${recheck ? '#FECACA' : '#E5E7EB'}`,
        cursor: 'pointer', textAlign: 'left', width: '100%',
        WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
      }}
    >
      <span style={{
        fontFamily: 'ui-monospace, monospace', fontWeight: 800, fontSize: 26,
        color: recheck ? '#991B1B' : '#111827', letterSpacing: '-0.02em',
        minWidth: 64,
      }}>
        {row.roomNumber}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.07em', marginBottom: 3,
          color: recheck ? '#991B1B' : '#374151',
        }}>
          {recheck
            ? tr(lang, 'Re-check needed', 'Reinspección')
            : tr(lang, 'Ready for inspection', 'Lista para inspección')}
        </div>
        <div style={{ fontSize: 12, color: '#6B7280' }}>
          {row.housekeeperName ?? tr(lang, 'Unassigned', 'Sin asignar')}
          {row.completedAt && ` · ${format(new Date(row.completedAt), 'h:mm a')}`}
        </div>
      </div>
      <span style={{
        background: '#111827', color: 'white',
        padding: '6px 12px', borderRadius: 999,
        fontSize: 12, fontWeight: 700,
      }}>
        {tr(lang, 'Inspect', 'Inspeccionar')}
      </span>
    </button>
  );
}

function MobileChecklistBody({
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
      const arr = m.get(it.category) ?? [];
      arr.push(it);
      m.set(it.category, arr);
    }
    return m;
  }, [checklist.items]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 6 }}>
      {Array.from(byCategory.entries()).map(([category, items]) => (
        <div key={category}>
          <div style={{
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.07em', color: '#6B7280', marginBottom: 8,
          }}>
            {categoryLabel(category, lang)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map((item) => (
              <MobileChecklistRow
                key={item.id}
                item={item}
                draft={drafts.get(item.id) ?? { state: null, note: '', photoUrl: null, uploading: false }}
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

function MobileChecklistRow({
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
  const failed = draft.state === 'minor' || draft.state === 'major' || draft.state === 'critical';

  return (
    <div style={{
      borderRadius: 14,
      border: `1.5px solid ${failed ? '#FECACA' : '#E5E7EB'}`,
      background: failed ? '#FEF2F2' : 'white',
      padding: '12px 14px',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
        gap: 8, marginBottom: 10,
      }}>
        <span style={{ fontSize: 14, color: '#111827', lineHeight: 1.35, flex: 1 }}>
          {label}
          {item.requiresPhotoOnFail && (
            <span style={{
              marginLeft: 6, color: '#B45309', fontSize: 10,
              fontFamily: 'ui-monospace, monospace',
            }}>
              {tr(lang, 'PHOTO REQ', 'FOTO REQ')}
            </span>
          )}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <MobileSevButton label={tr(lang, 'Pass', 'Aprobar')} active={draft.state === 'pass'} variant="pass" onClick={() => onState('pass')} />
        <MobileSevButton label={tr(lang, 'Minor', 'Menor')} active={draft.state === 'minor'} variant="minor" onClick={() => onState('minor')} />
        <MobileSevButton label={tr(lang, 'Major', 'Mayor')} active={draft.state === 'major'} variant="major" onClick={() => onState('major')} />
        <MobileSevButton label={tr(lang, 'Critical', 'Crítico')} active={draft.state === 'critical'} variant="critical" onClick={() => onState('critical')} />
      </div>

      {failed && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            placeholder={tr(lang, 'What to fix', 'Qué corregir')}
            value={draft.note}
            onChange={(e) => onNote(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '10px 12px', borderRadius: 10,
              border: '1px solid #E5E7EB', background: 'white',
              fontSize: 14, color: '#111827',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 999,
              border: '1px solid #E5E7EB', background: 'white',
              fontSize: 13, color: '#111827',
              cursor: 'pointer', minHeight: 36,
            }}>
              <Camera size={14} />
              {draft.uploading
                ? tr(lang, 'Uploading…', 'Subiendo…')
                : draft.photoUrl
                  ? tr(lang, 'Replace', 'Cambiar')
                  : tr(lang, 'Add photo', 'Agregar foto')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                capture="environment"
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
                style={{ width: 44, height: 44, borderRadius: 8, objectFit: 'cover', border: '1px solid #E5E7EB' }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MobileSevButton({
  label, active, variant, onClick,
}: {
  label: string;
  active: boolean;
  variant: 'pass' | 'minor' | 'major' | 'critical';
  onClick: () => void;
}) {
  const palette = {
    pass:     { bg: '#DCFCE7', fg: '#166534', br: '#86EFAC' },
    minor:    { bg: '#FEF3C7', fg: '#92400E', br: '#FDE68A' },
    major:    { bg: '#FED7AA', fg: '#9A3412', br: '#FB923C' },
    critical: { bg: '#FECACA', fg: '#991B1B', br: '#F87171' },
  }[variant];
  return (
    <button
      onClick={onClick}
      style={{
        minHeight: 36, padding: '0 14px', borderRadius: 999,
        background: active ? palette.bg : 'white',
        color: active ? palette.fg : '#6B7280',
        border: `1.5px solid ${active ? palette.fg : '#E5E7EB'}`,
        fontSize: 13, fontWeight: 600,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  );
}

function MobileSubmitBar({
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
    <div style={{ marginTop: 16 }}>
      {!allDecided && (
        <div style={{
          padding: '10px 14px', borderRadius: 12, background: '#F3F4F6',
          color: '#374151', fontSize: 13, textAlign: 'center', marginBottom: 8,
        }}>
          {tr(lang, 'Decide every item to submit', 'Decida cada punto para enviar')}
        </div>
      )}
      {allDecided && !anyFail && (
        <button
          onClick={() => onSubmit('pass')}
          disabled={submitting}
          style={{
            width: '100%', height: 56, borderRadius: 14, border: 'none',
            background: submitting ? '#9CA3AF' : '#166534',
            color: 'white', fontSize: 17, fontWeight: 800,
            cursor: submitting ? 'not-allowed' : 'pointer',
            WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
          }}
        >
          {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, '✓ Pass — room ready', '✓ Aprobar — habitación lista')}
        </button>
      )}
      {anyFail && (
        <button
          onClick={() => onSubmit('fail')}
          disabled={submitting}
          style={{
            width: '100%', height: 56, borderRadius: 14, border: 'none',
            background: submitting ? '#9CA3AF' : '#B45309',
            color: 'white', fontSize: 17, fontWeight: 800,
            cursor: submitting ? 'not-allowed' : 'pointer',
            WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation',
          }}
        >
          {submitting ? tr(lang, 'Saving…', 'Guardando…') : tr(lang, 'Send back for re-clean', 'Enviar a re-limpieza')}
        </button>
      )}
    </div>
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
        position: 'fixed', top: 'env(safe-area-inset-top, 12px)', left: '50%',
        transform: 'translateX(-50%)', zIndex: 1000,
        maxWidth: 'calc(100vw - 24px)', width: 360,
        background: '#111827', color: 'white',
        padding: '12px 14px', borderRadius: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        fontSize: 13, fontWeight: 600,
        display: 'flex', alignItems: 'center', gap: 10,
      }}
    >
      <AlertTriangle size={16} />
      {text}
    </div>
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
