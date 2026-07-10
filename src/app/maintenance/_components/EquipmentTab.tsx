// Maintenance → Equipment tab. Storeroom-inventory board (Claude Design
// handoff, Jun 2026): Out · Low · In stock. The redesign's "Equipment" is the
// storeroom — parts, tools, supplies on hand — i.e. the old "Parts" tab. It
// reads/writes the SAME `inventory` table (category = 'maintenance') the Parts
// tab used, so existing maintenance stock carries straight over and stays in
// sync with the Inventory page.
//
// (Not to be confused with the equipment-ASSET registry — HVAC units, pumps —
// which lives behind the Preventive tab's "Equipment assets" button.)

'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { subscribeToInventory, addInventoryItem, updateInventoryItem } from '@/lib/db';
import type { InventoryItem } from '@/types';
import {
  T, FONT_SANS, FONT_MONO,
  Caps, Pill, Btn, Modal, Field, TextInput,
  PageHead, BoardColumn, BoardCard, CenteredBoard,
  CX_CARD_SHADOW,
} from './_mt-snow';

type Status = 'out' | 'low' | 'ok';
const STAT: Record<Status, { color: string; tone: 'warm' | 'caramel' | 'sage'; en: string; es: string }> = {
  out: { color: T.warm,     tone: 'warm',    en: 'Out',      es: 'Agotado' },
  low: { color: T.caramel,  tone: 'caramel', en: 'Low',      es: 'Bajo' },
  ok:  { color: T.sageDeep, tone: 'sage',    en: 'In stock', es: 'En stock' },
};
const STAT_ORDER: Status[] = ['out', 'low', 'ok'];

// One board item, projected from an InventoryItem. "bin" (where it's kept) maps
// to the inventory row's free-text notes; the reorder threshold falls back to
// ~30% of par when an item has no explicit reorderAt (repo's 70/30 convention).
type Part = {
  id: string; name: string; bin: string; qty: number; reorderAt: number;
  unit: string; parLevel: number; status: Status;
};
function toPart(i: InventoryItem): Part {
  const reorderAt = i.reorderAt != null ? i.reorderAt : Math.max(1, Math.round((i.parLevel || 0) * 0.3));
  const qty = i.currentStock;
  const status: Status = qty <= 0 ? 'out' : qty <= reorderAt ? 'low' : 'ok';
  return { id: i.id, name: i.name, bin: i.notes || '', qty, reorderAt, unit: i.unit || 'units', parLevel: i.parLevel || 0, status };
}

// ── add item modal ───────────────────────────────────────────────────────────
function AddItemModal({
  open, onClose, onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (args: { name: string; bin: string; qty: number; reorderAt: number }) => Promise<void>;
}) {
  const { lang } = useLang();
  const es = lang === 'es';
  const [name, setName] = useState('');
  const [bin, setBin] = useState('');
  const [qty, setQty] = useState('');
  const [reorderAt, setReorderAt] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setName(''); setBin(''); setQty(''); setReorderAt(''); setBusy(false); };
  const close = () => { reset(); onClose(); };
  const can = name.trim() && bin.trim() && !busy;

  const submit = async () => {
    if (!can) return;
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), bin: bin.trim(), qty: parseInt(qty, 10) || 0, reorderAt: parseInt(reorderAt, 10) || 1 });
      reset();
      onClose();
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open={open} onClose={close}
      title={es ? 'Agregar artículo' : 'Add item'}
      subtitle={es ? 'Lleva la cuenta de una pieza, herramienta o insumo del almacén.' : 'Track a part, tool, or supply in the storeroom.'}
      width={560}
      footer={<>
        <Btn variant="ghost" onClick={close}>{es ? 'Cancelar' : 'Cancel'}</Btn>
        <Btn variant="primary" disabled={!can} onClick={submit}>{busy ? (es ? 'Agregando…' : 'Adding…') : (es ? 'Agregar al almacén' : 'Add to storeroom')}</Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label={es ? 'Artículo' : 'Item'} required><TextInput value={name} onChange={setName} placeholder={es ? 'ej. "Filtro HVAC — 20×25×1 MERV 8"' : 'e.g. "HVAC filter — 20×25×1 MERV 8"'} /></Field>
        <Field label={es ? 'Dónde se guarda' : "Where it's kept"} required><TextInput value={bin} onChange={setBin} placeholder={es ? 'ej. "Cuarto de máquinas · A2"' : 'e.g. "Mechanical · A2"'} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Field label={es ? 'Disponibles' : 'On hand'}><TextInput value={qty} onChange={setQty} type="number" min={0} placeholder="0" /></Field>
          <Field label={es ? 'Reordenar en' : 'Reorder at'}><TextInput value={reorderAt} onChange={setReorderAt} type="number" min={0} placeholder="1" /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ── item detail modal (−/＋ stepper) ─────────────────────────────────────────
function ItemModal({
  part, open, onClose, onSetQty, onRestock,
}: {
  part: Part | null;
  open: boolean;
  onClose: () => void;
  onSetQty: (id: string, qty: number) => void;
  onRestock: (part: Part) => void;
}) {
  const { lang } = useLang();
  const es = lang === 'es';
  // Local draft for snappy stepping; seeded from the live row on open. Re-seed
  // only when the modal opens or switches items — NOT on every realtime qty
  // update, which would clobber optimistic stepping mid-tap.
  const [draft, setDraft] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (part && open) setDraft(part.qty); }, [part?.id, open]);

  if (!part) return null;
  const status: Status = draft <= 0 ? 'out' : draft <= part.reorderAt ? 'low' : 'ok';
  const meta = STAT[status];

  const step = (d: number) => {
    const next = Math.max(0, draft + d);
    setDraft(next);
    onSetQty(part.id, next);
  };

  return (
    <Modal
      open={open} onClose={onClose}
      title={part.name} subtitle={part.bin} width={520}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>{es ? 'Cerrar' : 'Close'}</Btn>
        {status !== 'ok' && <Btn variant="primary" onClick={() => { onRestock(part); onClose(); }}>{es ? 'Reabastecer' : 'Restock to full'}</Btn>}
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Pill tone={meta.tone}>{es ? meta.es : meta.en}</Pill>
          <Caps size={11} tracking="0.06em">{es ? 'Reordenar en' : 'Reorder at'} {part.reorderAt} {part.unit}</Caps>
        </div>
        <div style={{ background: 'rgba(31,35,28,0.03)', border: `1px solid ${T.rule}`, borderRadius: 12, padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <Caps size={10}>{es ? 'Disponibles' : 'On hand'}</Caps>
            <div style={{ fontFamily: FONT_SANS, fontSize: 34, fontWeight: 600, color: T.ink, letterSpacing: '-0.02em', lineHeight: 1, marginTop: 4 }}>
              {draft} <span style={{ fontWeight: 400, fontSize: 15, color: T.ink3, letterSpacing: 0 }}>{part.unit}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', border: '1px solid rgba(31,35,28,0.14)', borderRadius: 999, height: 44, overflow: 'hidden', background: '#FFFFFF' }}>
            <button onClick={() => step(-1)} aria-label="−" style={{ width: 44, height: '100%', border: 'none', background: 'transparent', cursor: 'pointer', color: T.ink2, fontSize: 20, fontFamily: FONT_SANS }}>−</button>
            <span style={{ width: 1, height: '100%', background: T.rule }} />
            <button onClick={() => step(1)} aria-label="＋" style={{ width: 44, height: '100%', border: 'none', background: 'transparent', cursor: 'pointer', color: T.ink2, fontSize: 20, fontFamily: FONT_SANS }}>＋</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── root ─────────────────────────────────────────────────────────────────────
export function EquipmentTab() {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = lang === 'es';

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    const unsub = subscribeToInventory(user.uid, activePropertyId, setItems);
    return () => unsub();
  }, [user, activePropertyId]);

  const parts = useMemo(
    () => items.filter((i) => i.category === 'maintenance').map(toPart),
    [items],
  );
  const sel = selId ? parts.find((p) => p.id === selId) ?? null : null;

  const out = parts.filter((p) => p.status === 'out').length;
  const low = parts.filter((p) => p.status === 'low').length;
  const liveBands = STAT_ORDER.filter((s) => parts.some((p) => p.status === s));

  const setQty = (id: string, qty: number) => {
    if (!user || !activePropertyId) return;
    void updateInventoryItem(user.uid, activePropertyId, id, { currentStock: Math.max(0, qty) });
  };
  const restock = (part: Part) => {
    const target = part.parLevel > 0 ? part.parLevel : part.reorderAt > 0 ? part.reorderAt * 4 : 1;
    setQty(part.id, target);
  };
  const create = async (args: { name: string; bin: string; qty: number; reorderAt: number }) => {
    if (!user || !activePropertyId) return;
    const par = args.reorderAt > 0 ? args.reorderAt * 4 : Math.max(args.qty, 1);
    await addInventoryItem(user.uid, activePropertyId, {
      propertyId: activePropertyId,
      name: args.name,
      category: 'maintenance',
      currentStock: args.qty,
      parLevel: par,
      reorderAt: args.reorderAt,
      unit: 'units',
      notes: args.bin,
    });
  };

  const lead = out > 0
    ? `${out} ${es ? 'agotado' + (out > 1 ? 's' : '') : 'out of stock'}`
    : low > 0
      ? `${low} ${es ? 'bajo' + (low > 1 ? 's' : '') : 'running low'}`
      : (es ? 'Bien surtido' : 'Fully stocked');

  return (
    <div style={{ padding: '28px 48px 130px', background: 'transparent', color: T.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      <PageHead
        eyebrow={es ? 'Equipo · almacén' : 'Equipment · storeroom'}
        lead={lead}
        rest={`${parts.length} ${es ? 'artículos' : 'tracked items'}`}
        actions={<Btn variant="primary" onClick={() => setAddOpen(true)}>＋ {es ? 'Agregar artículo' : 'Add item'}</Btn>}
      />

      {parts.length === 0 ? (
        <div style={{ background: T.paper, border: `1px solid ${T.rule}`, borderRadius: 18, padding: '48px 24px', textAlign: 'center' }}>
          <span style={{ fontFamily: FONT_SANS, fontSize: 20, color: T.ink, fontWeight: 600, letterSpacing: '-0.02em' }}>{es ? 'Almacén vacío aún.' : 'Storeroom is empty.'}</span>
          <p style={{ fontFamily: FONT_SANS, fontSize: 14, color: T.ink2, margin: '8px 0 18px' }}>
            {es ? 'Agrega filtros, focos, piezas — lo que guardes para reparaciones.' : 'Add filters, bulbs, parts — anything you keep on hand for repairs.'}
          </p>
          <Btn variant="primary" onClick={() => setAddOpen(true)}>＋ {es ? 'Agregar tu primer artículo' : 'Add your first item'}</Btn>
        </div>
      ) : (
        <CenteredBoard>
          {liveBands.map((s) => {
            const meta = STAT[s];
            const list = parts.filter((p) => p.status === s);
            return (
              <BoardColumn key={s} color={meta.color} label={es ? meta.es : meta.en} count={list.length}>
                {list.map((p) => (
                  <BoardCard key={p.id} accent={meta.color} onClick={() => setSelId(p.id)}>
                    <span style={{ fontFamily: FONT_SANS, fontSize: 14.5, color: T.ink, fontWeight: 600, lineHeight: 1.3 }}>{p.name}</span>
                    <span style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2, lineHeight: 1.4 }}>{p.bin ? `${p.bin} · ` : ''}{es ? 'reordenar en' : 'reorder at'} {p.reorderAt}</span>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 1 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 600, color: T.ink }}>{p.qty} <span style={{ color: T.ink3, fontWeight: 400, fontSize: 12 }}>{p.unit}</span></span>
                      <Pill tone={meta.tone}>{es ? meta.es : meta.en}</Pill>
                    </div>
                  </BoardCard>
                ))}
              </BoardColumn>
            );
          })}
        </CenteredBoard>
      )}

      <AddItemModal open={addOpen} onClose={() => setAddOpen(false)} onCreate={create} />
      <ItemModal part={sel} open={!!sel} onClose={() => setSelId(null)} onSetQty={setQty} onRestock={restock} />
    </div>
  );
}
