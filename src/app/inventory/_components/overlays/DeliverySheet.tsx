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
import type { InventoryDeliveryLine } from '@/lib/inventory-atomic';
import type { InvCat } from '../tokens';
import { T, fonts } from '../tokens';
import { Btn } from '../Btn';
import { Serif } from '../Serif';
import { Motion } from '../motion';
import { Overlay } from './Overlay';
import { numGuard, warnBannerStyle } from './form-kit';
import { ScanInvoiceSheet } from './ScanInvoiceSheet';
import {
  clearDeliveryAttempt,
  isDefinitiveDeliveryFailure,
  loadDeliveryAttempt,
  persistDeliveryAttempt,
  retainOrCreateDeliveryAttempt,
  submitFrozenDeliveryAttempt,
  type FrozenDeliveryAttempt,
} from './scan-commit';
import type { DisplayItem } from '../types';
import { catLabelFor, type Lang } from '../inv-i18n';

interface DeliverySheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  display: DisplayItem[];
}

// Delivery rows and stock increments commit in one database transaction. A
// retry of an unchanged draft reuses the same request UUID, so a response lost
// after commit cannot add the delivery twice.

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
      retryPending: 'The result could not be confirmed. This exact delivery is locked until you retry it successfully.',
      retryBtn: 'Retry exact delivery',
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
      retryPending: 'No se pudo confirmar el resultado. Esta entrega exacta está bloqueada hasta que la reintentes correctamente.',
      retryBtn: 'Reintentar la misma entrega',
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
  const saveAttempt = useRef<FrozenDeliveryAttempt | null>(null);
  const [retryLocked, setRetryLocked] = useState(false);

  const resetRows = () => { setRows([{ key: 0, itemId: '', qty: '' }]); rowSeq.current = 1; };

  // Fresh chooser on every open.
  useEffect(() => {
    if (!open) return;
    const restored = activePropertyId
      ? loadDeliveryAttempt('manual', activePropertyId)
      : null;
    saveAttempt.current = restored;
    setRetryLocked(!!restored);
    if (restored) {
      const restoredRows = restored.lines.flatMap((line, index) =>
        line.itemId ? [{ key: index, itemId: line.itemId, qty: String(line.quantity) }] : [],
      );
      setRows(restoredRows.length > 0 ? restoredRows : [{ key: 0, itemId: '', qty: '' }]);
      rowSeq.current = Math.max(1, restoredRows.length);
      setMode('manual');
    } else {
      setMode(null);
      resetRows();
    }
  }, [open, activePropertyId]);

  if (!open) return null;

  // Scan path — the existing invoice flow, whole. Its close exits the sheet.
  if (mode === 'scan') {
    return <ScanInvoiceSheet lang={lang} open onClose={onClose} display={display} />;
  }

  const dirty = rows.some((r) => r.itemId !== '' || r.qty !== '');
  const requestClose = () => {
    if (saving || retryLocked) return;
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
    if (!user || !activePropertyId || saving || (!saveAttempt.current && entered.length === 0)) return;
    setSaving(true);
    try {
      if (!saveAttempt.current) {
        const lines: InventoryDeliveryLine[] = entered.map(({ d, n }, index) => ({
          // The item id makes this deterministic even if row order changes; the
          // suffix is a defensive guard if future UI allows duplicate item rows.
          lineKey: `${d.id}:${index}`,
          itemId: d.id,
          quantity: n,
          unitCost: d.unitCost || undefined,
        }));
        const vendorNames = new Set(
          entered.map(({ d }) => d.vendor.trim()).filter(Boolean),
        );
        // Manual entry has no delivery-wide vendor field. Preserve the linked
        // vendor when every selected item agrees; mixed-vendor deliveries stay
        // intentionally unlabeled rather than recording the wrong supplier.
        const vendorName = vendorNames.size === 1 ? [...vendorNames][0] : null;
        saveAttempt.current = retainOrCreateDeliveryAttempt(null, {
          kind: 'manual', propertyId: activePropertyId, receivedAt: new Date(),
          vendorName, notes: ds.note, lines,
        });
      }
      const attempt = saveAttempt.current;
      persistDeliveryAttempt(attempt);
      setRetryLocked(true);
      await submitFrozenDeliveryAttempt(attempt, { uid: user.uid, pid: activePropertyId });
      clearDeliveryAttempt('manual', activePropertyId);
      saveAttempt.current = null;
      setRetryLocked(false);

      onClose();
    } catch (err) {
      console.error('[delivery-sheet] save failed', err);
      if (isDefinitiveDeliveryFailure(err, retryLocked)) {
        clearDeliveryAttempt('manual', activePropertyId);
        saveAttempt.current = null;
        setRetryLocked(false);
      } else if (saveAttempt.current) {
        setRetryLocked(true);
      } else {
        // Local validation failed before a request was sent; the draft is safe
        // to edit because there is no uncertain database result to replay.
        setRetryLocked(false);
      }
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
          <Btn variant="ghost" size="md" onClick={() => setMode(null)} disabled={saving || retryLocked}>
            {ds.back}
          </Btn>
          <Btn variant="primary" size="md" onClick={handleSave} disabled={saving || (!retryLocked && entered.length === 0)}>
            {saving
              ? ds.saving
              : retryLocked
                ? ds.retryBtn
                : `${ds.addBtn} · ${entered.length}`}
          </Btn>
        </>
      }
    >
      {retryLocked && <div style={warnBannerStyle}>{ds.retryPending}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => {
          // A row's dropdown offers items not picked in OTHER rows (+ its own).
          const availableFor = (cat: InvCat) =>
            display.filter((d) => d.cat === cat && (d.id === r.itemId || !selectedIds.has(d.id)));
          return (
            <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select
                value={r.itemId}
                disabled={saving || retryLocked}
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
                disabled={saving || retryLocked}
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
                disabled={rows.length === 1 || saving || retryLocked}
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
        disabled={!canAddRow || saving || retryLocked}
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
