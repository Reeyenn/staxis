'use client';

/* ──────────────────────────────────────────────────────────────────────
   Add a delivery — chooser → (scan invoice | type it in)
   A delivery ADDS stock on top of what's on hand (counting REPLACES it —
   that's Count Mode's job). Two ways in:
     • Scan the invoice — the existing ScanInvoiceSheet flow, untouched.
     • Type it in — a slim list (item + how many arrived); saving logs one
       received order per item and re-baselines stock to on-hand + received,
       matching the invoice commit's semantics (inventory-invoice-commit.ts).
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
import { Caps } from '../Caps';
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
      manualOption: 'Type it in',
      arrived: 'How many arrived',
      cancel: 'Cancel',
      back: 'Back',
      saving: 'Saving…',
      addBtn: '✓ Add to inventory',
      discardConfirm: 'You have an unsaved delivery. Close and discard it?',
      saveFailed: 'Saving the delivery failed. Please try again.',
      note: 'Delivery — typed in',
    },
    es: {
      title: 'Agregar entrega',
      scanOption: '📷 Escanear la factura',
      manualOption: 'Escribirla a mano',
      arrived: 'Cuántos llegaron',
      cancel: 'Cancelar',
      back: 'Atrás',
      saving: 'Guardando…',
      addBtn: '✓ Agregar al inventario',
      discardConfirm: 'Tienes una entrega sin guardar. ¿Cerrar y descartarla?',
      saveFailed: 'No se pudo guardar la entrega. Inténtalo de nuevo.',
      note: 'Entrega — escrita a mano',
    },
  }[lang];
}

type Mode = null | 'manual' | 'scan';

export function DeliverySheet({ lang, open, onClose, display }: DeliverySheetProps) {
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const ds = dsStrings(lang);
  const [mode, setMode] = useState<Mode>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Session-scoped write ledger (see the idempotence note above).
  const sessionBaseline = useRef<Map<string, number>>(new Map());
  const orderedEver = useRef<Set<string>>(new Set());
  const writtenFinal = useRef<Map<string, number>>(new Map());

  // Fresh chooser on every open.
  useEffect(() => {
    if (open) {
      setMode(null);
      setQty({});
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

  const dirty = Object.values(qty).some((v) => v !== '');
  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirm(ds.discardConfirm)) return;
    onClose();
  };

  // Chooser — two ways to log the delivery. Switching to the scan flow
  // discards any typed quantities (its close exits the whole sheet), so a
  // dirty manual draft asks first.
  if (mode === null) {
    const pickScan = () => {
      if (dirty && !confirm(ds.discardConfirm)) return;
      setQty({});
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

  // Manual path — slim list: item name + "how many arrived". Whole units:
  // quantities are rounded at parse time so what the button counts is exactly
  // what gets written (a "0.4" that rounds to 0 never writes anything).
  const entered = display
    .map((d) => ({ d, n: Math.round(Number(qty[d.id])) }))
    .filter(({ d, n }) => qty[d.id] != null && qty[d.id] !== '' && Number.isFinite(n) && n >= 1);

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

  const allCats: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];
  const cats = allCats.filter((c) => display.some((d) => d.cat === c));
  const showDividers = cats.length > 1;

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
      <div style={{ textAlign: 'right', marginBottom: 4 }}>
        <Caps size={8.5}>{ds.arrived}</Caps>
      </div>
      {cats.map((cat) => (
        <div key={cat}>
          {showDividers && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0 2px' }}>
              <Caps size={8.5}>{catLabelFor(lang, cat)}</Caps>
              <span style={{ flex: 1, height: 1, background: T.ruleSoft }} />
            </div>
          )}
          {display.filter((d) => d.cat === cat).map((d) => (
            <div
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '8px 2px',
                borderBottom: `1px solid ${T.ruleFaint}`,
              }}
            >
              <span
                style={{
                  fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, color: T.ink,
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {d.name}
              </span>
              <input
                type="number"
                min="0"
                inputMode="decimal"
                value={qty[d.id] ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  if (numGuard(v)) setQty((prev) => ({ ...prev, [d.id]: v }));
                }}
                placeholder="—"
                style={{
                  width: 88, height: 34, borderRadius: 8, boxSizing: 'border-box',
                  flex: 'none', textAlign: 'center', outline: 'none',
                  background: T.bg, border: `1px solid ${T.rule}`,
                  fontFamily: fonts.sans, fontSize: 15, fontWeight: 600, color: T.ink,
                  letterSpacing: '-0.02em',
                }}
              />
            </div>
          ))}
        </div>
      ))}
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
