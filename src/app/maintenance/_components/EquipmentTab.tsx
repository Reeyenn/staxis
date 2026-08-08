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
import { subscribeToInventory, addInventoryItem, saveInventoryCountAtomic } from '@/lib/db';
import { generateId } from '@/lib/utils';
import type { InventoryItem } from '@/types';
import {
  T, FONT_SANS, FONT_MONO,
  Caps, Pill, Btn, Modal, Field, TextInput,
  PageHead, BoardColumn, BoardCard, CenteredBoard, MtEmptyCard,
  useBoardGate, BoardLoading, BoardLoadError,
} from './_mt-snow';
import { useToast, ToastHost } from '@/app/_components/ui/toast';
import { useReliableNavigation } from '@/lib/hooks/use-reliable-navigation';

type Status = 'out' | 'low' | 'ok';
const STAT: Record<Status, { color: string; tone: 'warm' | 'caramel' | 'sage'; en: string }> = {
  out: { color: T.warm,     tone: 'warm',    en: 'Out',      },
  low: { color: T.caramel,  tone: 'caramel', en: 'Low',      },
  ok:  { color: T.sageDeep, tone: 'sage',    en: 'In stock', },
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
  onCreate: (args: { name: string; bin: string; reorderAt: number }) => Promise<void>;
}) {
  const { lang } = useLang();
  const es = false;
  const [name, setName] = useState('');
  const [bin, setBin] = useState('');
  const [reorderAt, setReorderAt] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setName(''); setBin(''); setReorderAt(''); setBusy(false); };
  const dirty = name.trim() !== '' || bin.trim() !== '' || reorderAt !== '';
  // Guard the eaten-form path: Escape / a stray scrim click used to wipe the
  // half-typed item instantly. Confirm before discarding anything typed.
  const close = () => {
    if (dirty && !window.confirm('Discard this item? What you typed will be lost.')) return;
    reset();
    onClose();
  };
  const can = name.trim() && bin.trim() && !busy;

  const submit = async () => {
    if (!can) return;
    setBusy(true);
    try {
      await onCreate({ name: name.trim(), bin: bin.trim(), reorderAt: parseInt(reorderAt, 10) || 1 });
      reset();
      onClose();
    } catch {
      // Create failed — the board surfaced a toast; keep the form intact.
    } finally { setBusy(false); }
  };

  return (
    <Modal
      open={open} onClose={close}
      title={'Add item'}
      subtitle={'Track a part, tool, or supply in the storeroom.'}
      width={560}
      footer={<>
        <Btn variant="ghost" onClick={close}>{'Cancel'}</Btn>
        <Btn variant="primary" disabled={!can} onClick={submit}>{busy ? ('Adding…') : ('Add to storeroom')}</Btn>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Field label={'Item'} required><TextInput value={name} onChange={setName} placeholder={'e.g. "HVAC filter, 20×25×1 MERV 8"'} /></Field>
        <Field label={"Where it's kept"} required><TextInput value={bin} onChange={setBin} placeholder={'e.g. "Mechanical · A2"'} /></Field>
        <Field label={'Reorder at'}>
          <TextInput value={reorderAt} onChange={setReorderAt} type="number" min={0} placeholder="1" />
        </Field>
        <div style={{ padding: '10px 12px', borderRadius: 10, background: 'rgba(31,35,28,0.03)', border: `1px solid ${T.rule}`, fontFamily: FONT_SANS, fontSize: 12.5, lineHeight: 1.5, color: T.ink2 }}>
          {'New items start at 0. Log received stock through Inventory → Add delivery so its purchase cost is recorded.'}
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
  const es = false;
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
        <Btn variant="ghost" onClick={onClose}>{'Close'}</Btn>
        {status !== 'ok' && <Btn variant="primary" onClick={() => { onRestock(part); onClose(); }}>{'Log delivery'}</Btn>}
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Pill tone={meta.tone}>{meta.en}</Pill>
          <Caps size={11} tracking="0.06em">{'Reorder at'} {part.reorderAt} {part.unit}</Caps>
        </div>
        <div style={{ background: 'rgba(31,35,28,0.03)', border: `1px solid ${T.rule}`, borderRadius: 12, padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <Caps size={10}>{'On hand'}</Caps>
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
  const { push } = useReliableNavigation();
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const { lang } = useLang();
  const es = false;

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selId, setSelId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Failure feedback for board writes (same ink pill as the equipment registry).
  const { toasts, show: flash } = useToast({ durationMs: 3600, max: 1 });

  // Load gate: don't render the happy "Storeroom is empty" state until the
  // first snapshot arrived; error card + retry when the load failed.
  const gate = useBoardGate(activePropertyId, 'inventory', loaded);

  useEffect(() => {
    if (!user || !activePropertyId) {
      setLoaded(false);
      setLoadError(false);
      setItems([]);
      setSelId(null);
      return;
    }
    setLoaded(false);
    setLoadError(false);
    setItems([]);
    let initialSettled = false;
    const unsub = subscribeToInventory(
      user.uid,
      activePropertyId,
      (rows) => {
        initialSettled = true;
        setLoaded(true);
        setLoadError(false);
        setItems(rows);
      },
      () => { if (!initialSettled) setLoadError(true); },
    );
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
  const qtyPumps = useRef<Map<string, {
    desired: number;
    persisted: number;
    promise: Promise<boolean> | null;
    attempt: { value: number; requestId: string; countedAt: Date } | null;
    // True between "our write was accepted" and "the realtime snapshot caught
    // up". See the baseline note in setQty for why the snapshot cannot be
    // trusted during that window.
    awaitingEcho: boolean;
  }>>(new Map());
  const setQty = (id: string, qty: number): Promise<boolean> => {
    if (!user || !activePropertyId) return Promise.resolve(false);
    const uid = user.uid;
    const pid = activePropertyId;
    const liveStock = items.find((item) => item.id === id)?.currentStock ?? 0;
    const desired = Math.max(0, qty);
    const pump = qtyPumps.current.get(id);
    // WHAT THE ROW HOLDS RIGHT NOW, which is not always what `items` says. A
    // write resolves on the RPC response; the realtime refetch that updates
    // `items` lands a round trip later. Re-seeding from the snapshot inside that
    // window overwrote a value we had just persisted, so the next tap went out
    // with an expected count the row no longer had — and the atomic-count RPC
    // rejects any mismatch. The tap was lost and the toast blamed the network.
    // A value this pump persisted therefore stays authoritative until the
    // snapshot agrees with it (or a write fails, below, which resyncs).
    const baseline = pump && pump.awaitingEcho && liveStock !== pump.persisted
      ? pump.persisted
      : liveStock;
    if (baseline === desired && !pump?.promise) return Promise.resolve(true);
    let state = pump;
    if (!state) {
      state = { desired, persisted: baseline, promise: null, attempt: null, awaitingEcho: false };
      qtyPumps.current.set(id, state);
    } else if (!state.promise) {
      // Adopt the latest authoritative snapshot between tap bursts. If another
      // employee counted or received stock, the expected-stock guard below
      // will reject any stale modal value instead of overwriting their write.
      state.persisted = baseline;
      state.awaitingEcho = baseline !== liveStock;
    }
    state.desired = desired;
    if (state.promise) return state.promise; // running pump picks up `desired`
    const pumped = state;
    pumped.promise = (async () => {
      let ok = true;
      let conflict = false;
      for (;;) {
        const want = pumped.desired;
        if (want === pumped.persisted) {
          ok = true;
        } else {
          if (!pumped.attempt || pumped.attempt.value !== want) {
            pumped.attempt = { value: want, requestId: generateId(), countedAt: new Date() };
          }
          const attempt = pumped.attempt;
          try {
            await saveInventoryCountAtomic(
              uid,
              pid,
              attempt.requestId,
              attempt.countedAt,
              user.displayName || user.username || 'team',
              [{ itemId: id, expectedStock: pumped.persisted, countedStock: want }],
            );
            pumped.persisted = want;
            pumped.awaitingEcho = true;
            if (pumped.attempt === attempt) pumped.attempt = null;
            ok = true;
          } catch (e) {
            ok = false;
            conflict = (e as { code?: string } | null)?.code === '40001';
            // Whatever we believed about the row is now unreliable. Fall back to
            // the snapshot on the next tap so one rejection cannot wedge the
            // stepper into rejecting every tap after it.
            pumped.awaitingEcho = false;
          }
        }
        if (pumped.desired === want) break; // no newer taps → settled
      }
      pumped.promise = null;
      if (!ok) {
        flash(conflict
          ? 'Someone else just counted this item. Check the new number and try again.'
          : "Couldn't save the count. Check your connection and try again.");
      }
      return ok;
    })();
    return pumped.promise;
  };
  const restock = (part: Part) => {
    void part;
    push('/inventory?action=scan');
  };
  const create = async (args: { name: string; bin: string; reorderAt: number }) => {
    if (!user || !activePropertyId) return;
    const par = args.reorderAt > 0 ? args.reorderAt * 4 : 1;
    try {
      await addInventoryItem(user.uid, activePropertyId, {
        propertyId: activePropertyId,
        name: args.name,
        category: 'maintenance',
        // Received stock belongs in the purchase ledger. Creating catalog
        // metadata here must never masquerade as a count or delivery.
        currentStock: 0,
        parLevel: par,
        reorderAt: args.reorderAt,
        unit: 'units',
        notes: args.bin,
      });
    } catch (err) {
      flash("Couldn't add the item. Check your connection and try again.");
      throw err;
    }
  };

  const lead = out > 0
    ? `${out} ${'out of stock'}`
    : low > 0
      ? `${low} ${'running low'}`
      : ('Fully stocked');

  return (
    <div style={{ padding: '28px 48px 130px', background: 'transparent', color: T.ink, fontFamily: FONT_SANS, minHeight: 'calc(100dvh - 130px)' }}>
      <PageHead
        eyebrow={'Equipment · storeroom'}
        lead={lead}
        rest={`${parts.length} ${'tracked items'}`}
        actions={<Btn variant="primary" onClick={() => setAddOpen(true)}>＋ {'Add item'}</Btn>}
      />

      {loadError || gate.status === 'error' ? (
        <BoardLoadError es={es} onRetry={() => { setLoadError(false); gate.retry(); }} />
      ) : gate.status === 'loading' ? (
        <BoardLoading es={es} />
      ) : parts.length === 0 ? (
        <MtEmptyCard
          titleSize={20}
          title={'Storeroom is empty.'}
          body={'Add filters, bulbs, parts, anything you keep on hand for repairs.'}
          action={<Btn variant="primary" onClick={() => setAddOpen(true)}>＋ {'Add your first item'}</Btn>}
        />
      ) : (
        <CenteredBoard>
          {liveBands.map((s) => {
            const meta = STAT[s];
            const list = parts.filter((p) => p.status === s);
            return (
              <BoardColumn key={s} color={meta.color} label={meta.en} count={list.length}>
                {list.map((p) => (
                  <BoardCard key={p.id} accent={meta.color} onClick={() => setSelId(p.id)}>
                    <span style={{ fontFamily: FONT_SANS, fontSize: 14.5, color: T.ink, fontWeight: 600, lineHeight: 1.3 }}>{p.name}</span>
                    <span style={{ fontFamily: FONT_SANS, fontSize: 12.5, color: T.ink2, lineHeight: 1.4 }}>{p.bin ? `${p.bin} · ` : ''}{'reorder at'} {p.reorderAt}</span>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 1 }}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 15, fontWeight: 600, color: T.ink }}>{p.qty} <span style={{ color: T.ink3, fontWeight: 400, fontSize: 12 }}>{p.unit}</span></span>
                      <Pill tone={meta.tone}>{meta.en}</Pill>
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
