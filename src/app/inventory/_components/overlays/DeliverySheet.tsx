'use client';

/* ──────────────────────────────────────────────────────────────────────
   Add a delivery — chooser → (scan invoice | pick items)
   A delivery ADDS stock on top of what's on hand (counting REPLACES it —
   that's Count Mode's job). Two ways in:
     • Scan the invoice — the existing ScanInvoiceSheet flow, untouched.
     • Pick items — a few dropdown rows (pick an item + how many arrived,
       "+ Add another item" for more). A delivery is usually one or two
       things, so you pick rather than scroll the whole catalog. Saving logs
       one received order per item and re-baselines stock to on-hand +
       received, matching the invoice commit (inventory-invoice-commit.ts).
   ────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import {
  addInventoryOrder,
  fetchInventoryStockByIds,
  updateInventoryItem,
} from '@/lib/db';
import type { InvCat } from '../tokens';
import { T, fonts } from '../tokens';
import { Btn } from '../Btn';
import { Serif } from '../Serif';
import { Motion } from '../motion';
import { Overlay } from './Overlay';
import { numGuard } from './form-kit';
import { ScanInvoiceSheet } from './ScanInvoiceSheet';
import type { DisplayItem } from '../types';
import { catLabelFor, type Lang } from '../inv-i18n';

interface DeliverySheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  display: DisplayItem[];
}

// The save is idempotent for the whole time the sheet is open (a "session"):
// each item's stock baseline is captured ONCE, its order row inserts at most
// once, and its stock is rewritten only when the target (baseline + typed qty)
// differs from what already landed. So retries after a partial failure — and
// even edits between retries — can never duplicate an order row or compound
// the added quantity onto already-updated stock.

function dsStrings(lang: Lang) {
  return {
    en: {
      title: 'Add a delivery',
      scanOption: '📷 Scan the invoice',
      manualOption: 'Pick items',
      selectItem: 'Select an item…',
      qtyPh: 'Qty',
      addAnother: '+ Add another item',
      remove: 'Remove',
      back: 'Back',
      saving: 'Saving…',
      addBtn: '✓ Add to inventory',
      discardConfirm: 'You have an unsaved delivery. Close and discard it?',
      saveFailed: 'Saving the delivery failed. Please try again.',
      note: 'Delivery — added manually',
    },
    es: {
      title: 'Agregar entrega',
      scanOption: '📷 Escanear la factura',
      manualOption: 'Elegir artículos',
      selectItem: 'Elige un artículo…',
      qtyPh: 'Cant.',
      addAnother: '+ Agregar otro artículo',
      remove: 'Quitar',
      back: 'Atrás',
      saving: 'Guardando…',
      addBtn: '✓ Agregar al inventario',
      discardConfirm: 'Tienes una entrega sin guardar. ¿Cerrar y descartarla?',
      saveFailed: 'No se pudo guardar la entrega. Inténtalo de nuevo.',
      note: 'Entrega — agregada a mano',
    },
  }[lang];
}

type Mode = null | 'manual' | 'scan';
type Row = { key: number; itemId: string; qty: string };

const CAT_ORDER: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

export function DeliverySheet({ lang, open, onClose, display }: DeliverySheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const ds = dsStrings(lang);
  const [mode, setMode] = useState<Mode>(null);
  const [rows, setRows] = useState<Row[]>([{ key: 0, itemId: '', qty: '' }]);
  const rowSeq = useRef(1);
  const [saving, setSaving] = useState(false);
  // Session-scoped write ledger (see the idempotence note above).
  const sessionBaseline = useRef<Map<string, number>>(new Map());
  const orderedEver = useRef<Set<string>>(new Set());
  const writtenFinal = useRef<Map<string, number>>(new Map());

  const resetRows = () => { setRows([{ key: 0, itemId: '', qty: '' }]); rowSeq.current = 1; };

  // Fresh chooser on every open.
  useEffect(() => {
    if (open) {
      setMode(null);
      resetRows();
      sessionBaseline.current = new Map();
      orderedEver.current = new Set();
      writtenFinal.current = new Map();
    }
  }, [open]);

  if (!open) return null;

  // Scan path — the existing invoice flow, whole. Its close exits the sheet.
  if (mode === 'scan') {
    return <ScanInvoiceSheet lang={lang} open onClose={onClose} display={display} />;
  }

  const dirty = rows.some((r) => r.itemId !== '' || r.qty !== '');
  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirm(ds.discardConfirm)) return;
    onClose();
  };

  // Chooser — two ways to log the delivery. Switching to the scan flow
  // discards any picked rows (its close exits the whole sheet), so a dirty
  // manual draft asks first.
  if (mode === null) {
    const pickScan = () => {
      if (dirty && !confirm(ds.discardConfirm)) return;
      resetRows();
      setMode('scan');
    };
    return (
      <Overlay open onClose={requestClose} width={520} title={ds.title}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <OptionRow title={ds.scanOption} onPick={pickScan} />
          <OptionRow title={ds.manualOption} onPick={() => setMode('manual')} />
        </div>
      </Overlay>
    );
  }

  // ── Manual path — dropdown rows ────────────────────────────────────
  const updateRow = (key: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () =>
    setRows((prev) => [...prev, { key: rowSeq.current++, itemId: '', qty: '' }]);
  const removeRow = (key: number) =>
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));

  // Whole units. Coalesce by itemId (a safety net — the dropdowns already hide
  // an item picked in another row) so a duplicate pick sums instead of racing.
  const picked = new Map<string, number>();
  for (const r of rows) {
    if (!r.itemId) continue;
    const n = Math.round(Number(r.qty));
    if (!Number.isFinite(n) || n < 1) continue;
    picked.set(r.itemId, (picked.get(r.itemId) ?? 0) + n);
  }
  const entered = [...picked].flatMap(([itemId, n]) => {
    const d = display.find((x) => x.id === itemId);
    return d ? [{ d, n }] : [];
  });

  const selectedIds = new Set(rows.map((r) => r.itemId).filter(Boolean));
  const canAddRow = selectedIds.size < display.length && rows.every((r) => r.itemId !== '');

  const handleSave = async () => {
    if (!user || !activePropertyId || saving || entered.length === 0) return;
    setSaving(true);
    try {
      const now = new Date();

      // Baselines: fetch fresh stock ONCE per item per session — final stock is
      // always sessionBaseline + typed qty, so rewrites are idempotent and a
      // retry (or an edited retry) can never compound the addition.
      const missing = entered.filter(({ d }) => !sessionBaseline.current.has(d.id));
      if (missing.length > 0) {
        const fresh = await fetchInventoryStockByIds(
          user.uid, activePropertyId, missing.map(({ d }) => d.id),
        );
        for (const { d } of missing) {
          sessionBaseline.current.set(
            d.id,
            Math.max(0, d.id in fresh ? fresh[d.id] : (d.raw.currentStock ?? 0)),
          );
        }
      }

      // 1. One received order per item (the delivery ledger / spend record) —
      // at most once per session, so a retry never duplicates the row.
      // totalCost is deliberately omitted: addInventoryOrder computes it with
      // cents rounding (the float-artefact fix).
      const pendingOrders = entered.filter(({ d }) => !orderedEver.current.has(d.id));
      const orderResults = await Promise.allSettled(
        pendingOrders.map(({ d, n }) =>
          addInventoryOrder(user.uid, activePropertyId, {
            propertyId: activePropertyId,
            itemId: d.id,
            itemName: d.name,
            quantity: n,
            unitCost: d.unitCost || undefined,
            vendorName: d.vendor || undefined,
            orderedAt: null,
            receivedAt: now,
            notes: ds.note,
          }),
        ),
      );
      orderResults.forEach((r, i) => {
        if (r.status === 'fulfilled') orderedEver.current.add(pendingOrders[i].d.id);
      });
      const orderFailure = orderResults.find((r) => r.status === 'rejected');
      if (orderFailure) throw (orderFailure as PromiseRejectedResult).reason;

      // 2. Re-baseline stock: baseline + received (same semantics as the
      // invoice commit, incl. the lastCountedAt re-anchor). Skips items whose
      // exact target already landed; rewrites when an edit changed the target.
      const pendingStock = entered
        .map(({ d, n }) => ({ d, final: (sessionBaseline.current.get(d.id) ?? 0) + n }))
        .filter(({ d, final }) => writtenFinal.current.get(d.id) !== final);
      const stockResults = await Promise.allSettled(
        pendingStock.map(({ d, final }) =>
          updateInventoryItem(user.uid, activePropertyId, d.id, {
            currentStock: final,
            lastCountedAt: now,
          }),
        ),
      );
      stockResults.forEach((r, i) => {
        if (r.status === 'fulfilled') writtenFinal.current.set(pendingStock[i].d.id, pendingStock[i].final);
      });
      const stockFailure = stockResults.find((r) => r.status === 'rejected');
      if (stockFailure) throw (stockFailure as PromiseRejectedResult).reason;

      onClose();
    } catch (err) {
      console.error('[delivery-sheet] save failed', err);
      alert(ds.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      open
      onClose={requestClose}
      italic={ds.title}
      width={520}
      footer={
        <>
          <span style={{ marginRight: 'auto' }} />
          <Btn variant="ghost" size="md" onClick={() => setMode(null)} disabled={saving}>
            {ds.back}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || entered.length === 0}>
            {saving ? ds.saving : `${ds.addBtn} · ${entered.length}`}
          </Btn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => {
          // A row's dropdown offers items not picked in OTHER rows (+ its own).
          const availableFor = (cat: InvCat) =>
            display.filter((d) => d.cat === cat && (d.id === r.itemId || !selectedIds.has(d.id)));
          return (
            <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select
                value={r.itemId}
                onChange={(e) => updateRow(r.key, { itemId: e.target.value })}
                style={{
                  flex: 1, minWidth: 0, height: 40, padding: '0 12px', borderRadius: 9,
                  boxSizing: 'border-box', cursor: 'pointer', outline: 'none',
                  background: T.bg, border: `1px solid ${T.rule}`,
                  fontFamily: fonts.sans, fontSize: 14, fontWeight: 600,
                  color: r.itemId ? T.ink : T.dim,
                }}
              >
                <option value="">{ds.selectItem}</option>
                {CAT_ORDER.filter((c) => display.some((d) => d.cat === c)).map((cat) => {
                  const opts = availableFor(cat);
                  if (opts.length === 0) return null;
                  return (
                    <optgroup key={cat} label={catLabelFor(lang, cat)}>
                      {opts.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              <input
                type="number"
                min="0"
                inputMode="decimal"
                value={r.qty}
                onChange={(e) => { const v = e.target.value; if (numGuard(v)) updateRow(r.key, { qty: v }); }}
                placeholder={ds.qtyPh}
                aria-label={ds.qtyPh}
                style={{
                  width: 76, height: 40, borderRadius: 9, boxSizing: 'border-box',
                  flex: 'none', textAlign: 'center', outline: 'none',
                  background: T.bg, border: `1px solid ${T.rule}`,
                  fontFamily: fonts.sans, fontSize: 15, fontWeight: 600, color: T.ink,
                  letterSpacing: '-0.02em',
                }}
              />
              <button
                type="button"
                onClick={() => removeRow(r.key)}
                aria-label={ds.remove}
                disabled={rows.length === 1}
                style={{
                  width: 30, height: 30, flex: 'none', borderRadius: 8, padding: 0,
                  cursor: rows.length === 1 ? 'default' : 'pointer',
                  background: 'transparent', border: 'none',
                  color: rows.length === 1 ? T.ruleFaint : T.dim,
                  fontFamily: fonts.sans, fontSize: 18, lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addRow}
        disabled={!canAddRow}
        style={{
          marginTop: 12,
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', borderRadius: 999,
          cursor: canAddRow ? 'pointer' : 'not-allowed',
          background: canAddRow ? T.tealDim : 'transparent',
          color: canAddRow ? T.tealText : T.faint,
          border: `1px solid ${canAddRow ? 'rgba(92,122,96,0.28)' : T.rule}`,
          fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600,
        }}
      >
        {ds.addAnother}
      </button>
    </Overlay>
  );
}

// One chooser row: serif label + arrow (CountSheet's ScopeOption idiom).
function OptionRow({ title, onPick }: { title: string; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => { Motion.pop(ref.current, 0.98); onPick(); }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.ink; e.currentTarget.style.background = T.inkWash; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.rule; e.currentTarget.style.background = T.bg; }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 15,
        padding: '18px 20px',
        borderRadius: 13,
        cursor: 'pointer',
        background: T.bg,
        border: `1px solid ${T.rule}`,
        textAlign: 'left',
        width: '100%',
      }}
    >
      <Serif size={23} style={{ letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{title}</Serif>
      <Serif size={20} color={T.dim}>→</Serif>
    </button>
  );
}
