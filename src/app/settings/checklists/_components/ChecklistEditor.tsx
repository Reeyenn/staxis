'use client';

// Shared building blocks for Settings → Checklists, extracted from
// checklists/page.tsx. The Cleaning and Inspection editors were two
// near-identical row-editor implementations; <ChecklistEditor> is the one
// generic version (header row + rows + reorder/delete controls + add
// button). Every style and string here is verbatim from the originals —
// the two editors keep their exact current look.

import React, { useCallback, useState } from 'react';
import {
  ChevronUp, ChevronDown, Plus, Trash2, Copy, RotateCcw, Save, X, Check,
} from 'lucide-react';

import { fetchWithAuth } from '@/lib/api-fetch';
import { T, fonts, Btn, Caps, Pill } from '@/app/staff/_components/_tokens';

export type Lang = 'en' | 'es';

// Editable rows carry a client-only key so React reconciles correctly while
// rows are added / reordered before they have a server id.
let keySeq = 0;
export const nextKey = () => `row-${keySeq++}`;

export const inputStyle: React.CSSProperties = {
  fontFamily: fonts.sans, fontSize: 13, padding: '7px 9px', height: 34,
  border: `1px solid ${T.rule}`, borderRadius: 8, background: T.paper, color: T.ink, width: '100%',
  boxSizing: 'border-box',
};

// ─── Generic row editor ─────────────────────────────────────────────────────
// One grid of editable rows with move-up/move-down/delete controls and an
// "add" button. The caller supplies the columns (headers + renderCells) and
// owns the item state; this component owns only the shared chrome.

export function ChecklistEditor<TItem extends { _key: string }>({
  grid, headers, headerStyle, gap, emptyText, addLabel, items, setItems, newItem, renderCells,
}: {
  /** gridTemplateColumns shared by the header row and every item row. */
  grid: string;
  /** One <Caps> label per column (the last column is the Order controls). */
  headers: string[];
  /** Extra style on the header row (inspection adds marginTop: 4). */
  headerStyle?: React.CSSProperties;
  /** Vertical gap between header/rows/add (cleaning 8, inspection 14). */
  gap: number;
  emptyText: string;
  addLabel: string;
  items: TItem[];
  setItems: React.Dispatch<React.SetStateAction<TItem[]>>;
  newItem: () => TItem;
  /** The editable cells for one row (everything except the Order controls). */
  renderCells: (item: TItem, update: (patch: Partial<TItem>) => void) => React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {/* Header row */}
      <div style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, padding: '0 4px', ...headerStyle }}>
        {headers.map((h) => <Caps key={h}>{h}</Caps>)}
      </div>

      {items.length === 0 && (
        <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink3, padding: '12px 4px' }}>
          {emptyText}
        </div>
      )}

      {items.map((it, idx) => (
        <div key={it._key} style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, alignItems: 'center' }}>
          {renderCells(it, (patch) => setItems((p) => p.map((x, i) => i === idx ? { ...x, ...patch } : x)))}
          <RowControls
            idx={idx} count={items.length}
            onUp={() => move(setItems, idx, -1)}
            onDown={() => move(setItems, idx, 1)}
            onDelete={() => setItems((p) => p.filter((_, i) => i !== idx))}
          />
        </div>
      ))}

      <div>
        <Btn variant="ghost" size="sm" onClick={() => setItems((p) => [...p, newItem()])}>
          <Plus size={14} /> {addLabel}
        </Btn>
      </div>
    </div>
  );
}

function RowControls({ idx, count, onUp, onDown, onDelete }: {
  idx: number; count: number; onUp: () => void; onDown: () => void; onDelete: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
      <IconBtn onClick={onUp} disabled={idx === 0} label="Move up"><ChevronUp size={15} /></IconBtn>
      <IconBtn onClick={onDown} disabled={idx === count - 1} label="Move down"><ChevronDown size={15} /></IconBtn>
      <IconBtn onClick={onDelete} label="Delete" danger><Trash2 size={14} /></IconBtn>
    </div>
  );
}

function IconBtn({ children, onClick, disabled, label, danger }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        width: 28, height: 28, borderRadius: 7, border: `1px solid ${T.rule}`,
        background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? T.ink3 : danger ? T.red : T.ink2,
        opacity: disabled ? 0.4 : 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function move<T>(setter: React.Dispatch<React.SetStateAction<T[]>>, idx: number, delta: number): void {
  setter((prev) => {
    const next = [...prev];
    const target = idx + delta;
    if (target < 0 || target >= next.length) return prev;
    [next[idx], next[target]] = [next[target], next[idx]];
    return next;
  });
}

// ─── Shared pieces ──────────────────────────────────────────────────────────

export function StatusRow({ lang, isOverride }: { lang: Lang; isOverride: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {isOverride ? (
        <Pill tone="sage"><Check size={12} /> {lang === 'es' ? 'Personalizada para esta propiedad' : 'Customized for this property'}</Pill>
      ) : (
        <>
          <Pill tone="neutral">{lang === 'es' ? 'Sin configurar' : 'Not set up yet'}</Pill>
          <span style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>
            {lang === 'es' ? 'Empieza desde cero — sin pasos predeterminados.' : 'Start from scratch — no built-in steps.'}
          </span>
        </>
      )}
    </div>
  );
}

export function Banner({ tone, children }: { tone: 'warm' | 'sage'; children: React.ReactNode }) {
  const c = tone === 'warm'
    ? { fg: T.warm, bg: T.warmDim, br: 'rgba(184,92,61,0.25)' }
    : { fg: T.sageDeep, bg: T.sageDim, br: 'rgba(104,131,114,0.25)' };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: fonts.sans, fontSize: 13, color: c.fg,
      padding: '8px 12px', border: `1px solid ${c.br}`, background: c.bg, borderRadius: 8,
    }}>
      {children}
    </div>
  );
}

export function Loading({ lang }: { lang: Lang }) {
  return (
    <div style={{ fontFamily: fonts.mono, fontSize: 11, color: T.ink3, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '12px 4px' }}>
      {lang === 'es' ? 'Cargando…' : 'Loading…'}
    </div>
  );
}

/** Save / Copy / Delete row under each editor — identical between the two
 *  editors except the tooltip shown while Copy is locked. */
export function ActionBar({ lang, saving, loading, isOverride, copyLockedTitle, onSave, onCopy, onDelete }: {
  lang: Lang; saving: boolean; loading: boolean; isOverride: boolean;
  copyLockedTitle: string;
  onSave: () => void; onCopy: () => void; onDelete: () => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
      <Btn variant="primary" size="md" onClick={onSave} disabled={saving || loading}>
        <Save size={14} /> {saving ? (lang === 'es' ? 'Guardando…' : 'Saving…') : (lang === 'es' ? 'Guardar' : 'Save')}
      </Btn>
      <Btn
        variant="ghost" size="md"
        onClick={onCopy}
        disabled={saving || loading || !isOverride}
        title={!isOverride ? copyLockedTitle : undefined}
      >
        <Copy size={14} /> {lang === 'es' ? 'Copiar a otras propiedades' : 'Copy to other properties'}
      </Btn>
      {isOverride && (
        <Btn variant="ghost" size="md" onClick={onDelete} disabled={saving || loading}>
          <RotateCcw size={14} /> {lang === 'es' ? 'Eliminar esta lista' : 'Delete this checklist'}
        </Btn>
      )}
    </div>
  );
}

// ─── Copy-to-properties modal ───────────────────────────────────────────────

export type CopyBody =
  | { sourceType: 'cleaning'; key: string; sourcePropertyId: string; targetPropertyIds: string[] }
  | { sourceType: 'inspection'; key: string | null; targetPropertyIds: string[] };

export function CopyModal({ lang, pid, properties, label, onClose, buildBody }: {
  lang: Lang;
  pid: string;
  properties: Array<{ id: string; name: string }>;
  label: string;
  onClose: () => void;
  buildBody: (targetIds: string[]) => CopyBody;
}) {
  const others = properties.filter((p) => p.id !== pid);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const run = useCallback(async () => {
    const targetIds = Array.from(selected);
    if (targetIds.length === 0) return;
    setBusy(true); setError(null);
    try {
      const r = await fetchWithAuth('/api/settings/checklists/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(targetIds)),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) { setError(body?.error ?? `Failed (${r.status})`); return; }
      setDone((body?.data?.copied ?? targetIds.length) as number);
    } catch (e) {
      setError((e as Error)?.message ?? 'Network error');
    } finally {
      setBusy(false);
    }
  }, [selected, buildBody]);

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.18)', zIndex: 50, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '8vh 16px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(460px, 96vw)', maxHeight: '80vh', overflowY: 'auto', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Caps>{lang === 'es' ? 'Copiar a otras propiedades' : 'Copy to other properties'}</Caps>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}><X size={16} color={T.ink2} /></button>
        </div>
        <div style={{ fontFamily: fonts.serif, fontSize: 18, color: T.ink }}>{label}</div>

        {done !== null ? (
          <>
            <Banner tone="sage"><Check size={13} /> {lang === 'es' ? `Copiada a ${done} propiedad(es).` : `Copied to ${done} propert${done === 1 ? 'y' : 'ies'}.`}</Banner>
            <div><Btn variant="ghost" size="sm" onClick={onClose}>{lang === 'es' ? 'Cerrar' : 'Close'}</Btn></div>
          </>
        ) : others.length === 0 ? (
          <>
            <div style={{ fontFamily: fonts.sans, fontSize: 13, color: T.ink2 }}>
              {lang === 'es' ? 'No tienes otras propiedades a las que copiar.' : 'You have no other properties to copy to.'}
            </div>
            <div><Btn variant="ghost" size="sm" onClick={onClose}>{lang === 'es' ? 'Cerrar' : 'Close'}</Btn></div>
          </>
        ) : (
          <>
            <div style={{ fontFamily: fonts.sans, fontSize: 12.5, color: T.ink2 }}>
              {lang === 'es'
                ? `Esto creará o reemplazará la lista “${label}” en las propiedades seleccionadas.`
                : `This will create or replace the “${label}” checklist on the selected properties.`}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {others.map((p) => {
                const on = selected.has(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggle(p.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                      padding: '9px 11px', borderRadius: 9, cursor: 'pointer',
                      border: `1px solid ${on ? T.sageDeep : T.rule}`,
                      background: on ? T.sageDim : 'transparent',
                      fontFamily: fonts.sans, fontSize: 13.5, color: T.ink,
                    }}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                      border: `1px solid ${on ? T.sageDeep : T.ink3}`,
                      background: on ? T.sageDeep : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {on && <Check size={12} color="#fff" />}
                    </span>
                    {p.name}
                  </button>
                );
              })}
            </div>

            {error && <Banner tone="warm">{error}</Banner>}

            <div style={{ fontFamily: fonts.sans, fontSize: 12, color: T.ink3 }}>
              {lang === 'es'
                ? `${selected.size} propiedad(es) seleccionada(s).`
                : `${selected.size} propert${selected.size === 1 ? 'y' : 'ies'} selected.`}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <Btn variant="primary" size="md" onClick={() => void run()} disabled={busy || selected.size === 0}>
                <Copy size={14} /> {busy ? (lang === 'es' ? 'Copiando…' : 'Copying…') : (lang === 'es' ? 'Copiar' : 'Copy')}
              </Btn>
              <Btn variant="ghost" size="md" onClick={onClose} disabled={busy}>{lang === 'es' ? 'Cancelar' : 'Cancel'}</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Confirm modal ──────────────────────────────────────────────────────────

export function ConfirmModal({ lang, title, message, confirmLabel, onConfirm, onCancel }: {
  lang: Lang; title: string; message: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(31,35,28,0.18)', zIndex: 50, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(420px, 96vw)', background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontFamily: fonts.serif, fontSize: 19, color: T.ink }}>{title}</div>
        <div style={{ fontFamily: fonts.sans, fontSize: 13.5, color: T.ink2, lineHeight: 1.45 }}>{message}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" size="md" onClick={onCancel}>{lang === 'es' ? 'Cancelar' : 'Cancel'}</Btn>
          <Btn variant="primary" size="md" onClick={onConfirm}>{confirmLabel}</Btn>
        </div>
      </div>
    </div>
  );
}
