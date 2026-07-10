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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import { useLang } from '@/contexts/LanguageContext';
import { subscribeToInventory, addInventoryItem, updateInventoryItem } from '@/lib/db';
import type { InventoryItem } from '@/types';
import {
  T, FONT_SANS, FONT_MONO, FONT_SERIF,
  Caps, Pill, Btn, Modal, Field, TextInput,
  PageHead, BoardColumn, BoardCard, CenteredBoard, MtEmptyCard,
  useBoardGate, BoardLoading, BoardLoadError,
} from './_mt-snow';
import { useToast, ToastHost } from '@/app/_components/ui/toast';

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
  const dirty = name.trim() !== '' || bin.trim() !== '' || qty !== '' || reorderAt !== '';
  // Guard the eaten-form path: Escape / a stray scrim click used to wipe the
  // half-typed item instantly. Confirm before discarding anything typed.
  const close = () => {
    if (dirty && !window.confirm(es
      ? '¿Descartar este artículo sin agregar? Se perderá lo que escribiste.'
      : 'Discard this item? What you typed will be lost.')) return;
    reset();
    onClose();
  };
  const can = name.trim() && bin.trim() && !busy;

  const submit = async () => {
    if (!can) return;
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), bin: bin.trim(), qty: parseInt(qty, 10) || 0, reorderAt: parseInt(reorderAt, 10) || 1 });
      reset();
      onClose();
    } catch {
      // Create failed — the board surfaced a toast; keep the form intact.
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
  /** Resolves once the (serialized) write settles; false = it failed. */
  onSetQty: (id: string, qty: number) => Promise<boolean>;
  onRestock: (part: Part) => void;
}) {
  const { lang } = useLang();
  const es = lang === 'es';
  // Local draft for snappy stepping; seeded from the live row on open.
  const [draft, setDraft] = useState(0);
  // Count of taps whose write hasn't settled yet. While >0 we don't adopt
  // realtime values (would clobber optimistic stepping mid-tap); once all
  // settle we DO adopt them, so another device's count change isn't silently
  // overwritten by this modal's stale snapshot. A counter (not a boolean) so
  // an early tap settling can't unlock adoption while a later tap is in flight.
  const pendingWrites = useRef(0);
  // Latest stored qty / item id — used to roll the draft back when a write
  // fails (the modal must never keep showing a number the DB rejected) and to
  // ignore settlements for an item the modal is no longer showing.
  const liveQty = useRef(0);
  liveQty.current = part?.qty ?? 0;
  const curId = useRef<string | null>(null);
  curId.current = part?.id ?? null;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (part && open) { setDraft(part.qty); pendingWrites.current = 0; } }, [part?.id, open]);

  // Adopt external realtime changes when nothing of ours is in flight.
  useEffect(() => {
    if (part && open && pendingWrites.current === 0) setDraft(part.qty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part?.qty]);

  if (!part) return null;
  const status: Status = draft <= 0 ? 'out' : draft <= part.reorderAt ? 'low' : 'ok';
  const meta = STAT[status];

  const step = (d: number) => {
    const id = part.id;
    const next = Math.max(0, draft + d);
    setDraft(next);
    pendingWrites.current += 1;
    void onSetQty(id, next).then((ok) => {
      if (curId.current !== id) return; // modal moved on to another item
      pendingWrites.current = Math.max(0, pendingWrites.current - 1);
      if (!ok && pendingWrites.current === 0) setDraft(liveQty.current);
    });
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
        <div style={{ background: T.bg, border: `1px solid ${T.rule}`, borderRadius: 12, padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <Caps size={10}>{es ? 'Disponibles' : 'On hand'}</Caps>
            <div style={{ fontFamily: FONT_SERIF, fontSize: 40, color: T.ink, fontStyle: 'italic', lineHeight: 1, marginTop: 4 }}>
              {draft} <span style={{ fontStyle: 'normal', fontSize: 16, color: T.ink3 }}>{part.unit}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', border: `1px solid ${T.rule}`, borderRadius: 999, height: 44, overflow: 'hidden' }}>
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
  const [loaded, setLoaded] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Failure feedback for board writes (same ink pill as the equipment registry).
  const { toasts, show: flash } = useToast({ durationMs: 3600, max: 1 });

  // Load gate: don't render the happy "Storeroom is empty" state until the
  // first snapshot arrived; error card + retry when the load failed.
  const gate = useBoardGate(activePropertyId, 'inventory', loaded);

  useEffect(() => {
    if (!user || !activePropertyId) return;
    setLoaded(false);
    const unsub = subscribeToInventory(user.uid, activePropertyId, (rows) => {
      setLoaded(true);
      setItems(rows);
    });
    return () => unsub();
  }, [user, activePropertyId, gate.retryKey]);

  const parts = useMemo(
    () => items.filter((i) => i.category === 'maintenance').map(toPart),
    [items],
  );
  const sel = selId ? parts.find((p) => p.id === selId) ?? null : null;

  const out = parts.filter((p) => p.status === 'out').length;
  const low = parts.filter((p) => p.status === 'low').length;
  const liveBands = STAT_ORDER.filter((s) => parts.some((p) => p.status === s));

  // Last-value-wins write pump, one per item. Rapid stepper taps used to fire
  // parallel absolute UPDATEs whose out-of-order completion could persist a
  // stale intermediate count; the pump keeps at most ONE request in flight
  // per item and always writes the latest tapped value next. The returned
  // promise resolves with the FINAL outcome of the tap burst (false = the
  // last write failed → caller rolls the draft back).
  const qtyPumps = useRef<Map<string, { desired: number; promise: Promise<boolean> | null }>>(new Map());
  const setQty = (id: string, qty: number): Promise<boolean> => {
    if (!user || !activePropertyId) return Promise.resolve(false);
    const uid = user.uid;
    const pid = activePropertyId;
    let pump = qtyPumps.current.get(id);
    if (!pump) { pump = { desired: qty, promise: null }; qtyPumps.current.set(id, pump); }
    pump.desired = Math.max(0, qty);
    if (pump.promise) return pump.promise; // running pump picks up `desired`
    const state = pump;
    state.promise = (async () => {
      let ok = true;
      for (;;) {
        const want = state.desired;
        try { await updateInventoryItem(uid, pid, id, { currentStock: want }); ok = true; }
        catch { ok = false; }
        if (state.desired === want) break; // no newer taps → settled
      }
      state.promise = null;
      if (!ok) {
        flash(es ? 'No se pudo guardar el conteo — revisa la conexión e inténtalo de nuevo.' : "Couldn't save the count — check your connection and try again.");
      }
      return ok;
    })();
    return state.promise;
  };
  const restock = (part: Part) => {
    const target = part.parLevel > 0 ? part.parLevel : part.reorderAt > 0 ? part.reorderAt * 4 : 1;
    void setQty(part.id, target);
  };
  const create = async (args: { name: string; bin: string; qty: number; reorderAt: number }) => {
    if (!user || !activePropertyId) return;
    const par = args.reorderAt > 0 ? args.reorderAt * 4 : Math.max(args.qty, 1);
    try {
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
    } catch (err) {
      flash(es ? 'No se pudo agregar el artículo — revisa la conexión e inténtalo de nuevo.' : "Couldn't add the item — check your connection and try again.");
      throw err;
    }
  };

  const lead = out > 0
    ? `${out} ${es ? 'agotado' + (out > 1 ? 's' : '') : 'out of stock'}`
    : low > 0
      ? `${low} ${es ? 'bajo' + (low > 1 ? 's' : '') : 'running low'}`
      : (es ? 'Bien surtido' : 'Fully stocked');

  return (
    <div style={{ padding: '28px 48px 64px', background: T.bg, color: T.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      <PageHead
        eyebrow={es ? 'Equipo · almacén' : 'Equipment · storeroom'}
        lead={lead}
        rest={`${parts.length} ${es ? 'artículos' : 'tracked items'}`}
        actions={<Btn variant="primary" onClick={() => setAddOpen(true)}>＋ {es ? 'Agregar artículo' : 'Add item'}</Btn>}
      />

      {gate.status === 'error' ? (
        <BoardLoadError es={es} onRetry={gate.retry} />
      ) : gate.status === 'loading' ? (
        <BoardLoading es={es} />
      ) : parts.length === 0 ? (
        <MtEmptyCard
          title={es ? 'Almacén vacío aún.' : 'Storeroom is empty.'}
          body={es ? 'Agrega filtros, focos, piezas — lo que guardes para reparaciones.' : 'Add filters, bulbs, parts — anything you keep on hand for repairs.'}
          action={<Btn variant="primary" onClick={() => setAddOpen(true)}>＋ {es ? 'Agregar tu primer artículo' : 'Add your first item'}</Btn>}
        />
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

      <ToastHost
        toasts={toasts}
        position="bottom"
        offset="28px"
        zIndex={1100}
        toastStyle={{ background: T.ink, color: T.bg, padding: '12px 22px', borderRadius: 12, fontFamily: FONT_SANS, fontSize: 13, fontWeight: 500, boxShadow: '0 12px 32px rgba(31,35,28,0.24)' }}
      />
    </div>
  );
}
