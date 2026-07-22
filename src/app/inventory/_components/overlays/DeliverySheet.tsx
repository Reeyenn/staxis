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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useProperty } from '@/contexts/PropertyContext';
import type { InventoryDeliveryLine } from '@/lib/inventory-atomic';
import type { InvCat } from '../tokens';
import { T, fonts } from '../tokens';
import { Btn } from '../Btn';
import { Serif } from '../Serif';
import { Motion } from '../motion';
import { Overlay, useOverlayPresence } from './Overlay';
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
import { catLabelFor, t as invT, type Lang } from '../inv-i18n';
import type { InventoryCustomCategory, InventoryTabLayout } from '@/types';
import {
  clearInventoryOverlayDraft,
  loadInventoryOverlayDraft,
  persistInventoryOverlayDraft,
} from './inventory-overlay-draft';
import overlayStyles from './Overlay.module.css';

interface DeliverySheetProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  display: DisplayItem[];
  /** IANA timezone for the active hotel. Scanned invoice dates use the hotel
   * calendar even when the manager is working remotely. */
  timezone: string;
  /** Hotel-defined custom tabs + layout — the item dropdown groups by the
   *  hotel's VISIBLE tabs, not by built-in categories it may have hidden. */
  customCategories?: InventoryCustomCategory[];
  tabLayout?: InventoryTabLayout;
  /** Costs and invoice OCR are financial evidence and stay out of browsers
   * whose hotel role lacks view_financials. */
  canViewFinancials: boolean;
  /** Invoice OCR additionally requires inventory-management access. Keeping
   * this explicit prevents a future non-manager caller from exposing scan. */
  canScanInvoices: boolean;
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
      costPh: 'Unit $',
      costRequired: 'Complete the item, quantity, and actual unit cost on every started row.',
      fieldsRequired: 'Complete the item and quantity on every started row.',
      costsHidden: 'Costs are hidden for your role. A manager can add the verified invoice cost later.',
      addAnother: '+ Add another item',
      remove: 'Remove',
      back: 'Back',
      saving: 'Saving…',
      addBtn: '✓ Add to inventory',
      discardConfirm: 'You have an unsaved delivery. Close and discard it?',
      draftRestored: 'Your unsaved delivery was restored.',
      noItems: 'There are no active inventory items to receive. Add an item first.',
      itemLabel: 'Item',
      quantityLabel: 'Quantity received',
      unitCostLabel: 'Actual unit cost',
      saveFailed: 'Saving the delivery failed. Please try again.',
      retryPending: 'The result could not be confirmed. This exact delivery is locked until you retry it successfully.',
      retryBtn: 'Retry exact delivery',
      note: 'Delivery — added manually',
      otherGroup: 'Other',
    },
    es: {
      title: 'Agregar entrega',
      scanOption: '📷 Escanear la factura',
      manualOption: 'Elegir artículos',
      selectItem: 'Elige un artículo…',
      qtyPh: 'Cant.',
      costPh: '$ unidad',
      costRequired: 'Completa el artículo, la cantidad y el costo unitario real en cada fila iniciada.',
      fieldsRequired: 'Completa el artículo y la cantidad en cada fila iniciada.',
      costsHidden: 'Los costos están ocultos para tu función. Un gerente puede agregar después el costo verificado de la factura.',
      addAnother: '+ Agregar otro artículo',
      remove: 'Quitar',
      back: 'Atrás',
      saving: 'Guardando…',
      addBtn: '✓ Agregar al inventario',
      discardConfirm: 'Tienes una entrega sin guardar. ¿Cerrar y descartarla?',
      draftRestored: 'Se restauró tu entrega sin guardar.',
      noItems: 'No hay artículos activos para recibir. Agrega un artículo primero.',
      itemLabel: 'Artículo',
      quantityLabel: 'Cantidad recibida',
      unitCostLabel: 'Costo unitario real',
      saveFailed: 'No se pudo guardar la entrega. Inténtalo de nuevo.',
      retryPending: 'No se pudo confirmar el resultado. Esta entrega exacta está bloqueada hasta que la reintentes correctamente.',
      retryBtn: 'Reintentar la misma entrega',
      note: 'Entrega — agregada a mano',
      otherGroup: 'Otros',
    },
  }[lang];
}

type Mode = null | 'manual' | 'scan';
type Row = { key: number; itemId: string; qty: string; cost: string };

interface DeliveryOverlayDraft {
  mode: null | 'manual';
  rows: Row[];
}

function validDeliveryDraft(value: unknown): DeliveryOverlayDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Partial<DeliveryOverlayDraft>;
  if ((draft.mode !== null && draft.mode !== 'manual') || !Array.isArray(draft.rows) || draft.rows.length === 0) return null;
  if (!draft.rows.every((row) => row
    && Number.isInteger(row.key)
    && row.key >= 0
    && typeof row.itemId === 'string'
    && typeof row.qty === 'string'
    && typeof row.cost === 'string')) return null;
  return draft as DeliveryOverlayDraft;
}

const CAT_ORDER: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

export function DeliverySheet({ lang, open, onClose, display, timezone, customCategories = [], tabLayout, canViewFinancials, canScanInvoices }: DeliverySheetProps) {
  const present = useOverlayPresence(open);
  const { user } = useAuth();
  const { activePropertyId } = useProperty();
  const ds = dsStrings(lang);
  const [mode, setMode] = useState<Mode>(null);
  const [rows, setRows] = useState<Row[]>([{ key: 0, itemId: '', qty: '', cost: '' }]);
  const rowSeq = useRef(1);
  const [saving, setSaving] = useState(false);
  const saveAttempt = useRef<FrozenDeliveryAttempt | null>(null);
  const [retryLocked, setRetryLocked] = useState(false);
  const [formError, setFormError] = useState('');
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftReadyContext, setDraftReadyContext] = useState('');
  const draftContext = user?.uid && activePropertyId ? `${user.uid}:${activePropertyId}` : '';
  const draftStorageInput = useMemo(() => user?.uid && activePropertyId
    ? { kind: 'delivery' as const, userId: user.uid, propertyId: activePropertyId }
    : null, [activePropertyId, user?.uid]);

  const resetRows = () => { setRows([{ key: 0, itemId: '', qty: '', cost: '' }]); rowSeq.current = 1; };

  // Fresh chooser on every open.
  useEffect(() => {
    if (!open) return;
    setFormError('');
    setDraftRestored(false);
    const restored = activePropertyId
      ? loadDeliveryAttempt('manual', activePropertyId)
      : null;
    const savedDraft = !restored && draftStorageInput
      ? validDeliveryDraft(loadInventoryOverlayDraft<DeliveryOverlayDraft>(draftStorageInput))
      : null;
    saveAttempt.current = restored;
    setRetryLocked(!!restored);
    if (restored) {
      const restoredRows = restored.lines.flatMap((line, index) =>
        line.itemId ? [{
          key: index,
          itemId: line.itemId,
          qty: String(line.quantity),
          cost: canViewFinancials && line.unitCost != null ? String(line.unitCost) : '',
        }] : [],
      );
      setRows(restoredRows.length > 0 ? restoredRows : [{ key: 0, itemId: '', qty: '', cost: '' }]);
      rowSeq.current = Math.max(1, ...restoredRows.map((row) => row.key + 1));
      setMode('manual');
    } else if (savedDraft) {
      setRows(canViewFinancials
        ? savedDraft.rows
        : savedDraft.rows.map((row) => ({ ...row, cost: '' })));
      rowSeq.current = Math.max(1, ...savedDraft.rows.map((row) => row.key + 1));
      setMode(savedDraft.mode);
      setDraftRestored(true);
    } else {
      setMode(canViewFinancials ? null : 'manual');
      resetRows();
    }
    setDraftReadyContext(draftContext);
  }, [open, activePropertyId, canViewFinancials, draftContext, draftStorageInput]);

  const dirty = rows.some((r) => r.itemId !== '' || r.qty !== '' || r.cost !== '');
  const currentDraft = useMemo<DeliveryOverlayDraft>(() => ({
    mode: mode === 'manual' ? 'manual' : null,
    rows,
  }), [mode, rows]);

  useEffect(() => {
    if (!open || mode === 'scan' || !draftStorageInput || draftReadyContext !== draftContext) return;
    if (dirty || retryLocked) {
      persistInventoryOverlayDraft({ ...draftStorageInput, data: currentDraft });
    } else {
      clearInventoryOverlayDraft(draftStorageInput);
    }
  }, [
    open, mode, draftStorageInput, draftReadyContext, draftContext,
    dirty, retryLocked, currentDraft,
  ]);

  // Keep draft state mounted between opens, but stop rebuilding this large tree
  // after the shared Overlay / ScanInvoiceSheet exit window has elapsed. A
  // direct `if (!open)` would still tear down the exit animation immediately.
  if (!present) return null;

  // Scan path — the existing invoice flow, whole. Its close exits the sheet.
  if (mode === 'scan' && canScanInvoices) {
    return (
      <ScanInvoiceSheet
        lang={lang}
        open={open}
        onClose={onClose}
        display={display}
        timezone={timezone}
        customCategories={customCategories}
        tabLayout={tabLayout}
      />
    );
  }

  const requestClose = () => {
    if (saving || retryLocked) return;
    if (dirty && !confirm(ds.discardConfirm)) return;
    if (draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
    onClose();
  };

  // Chooser — two ways to log the delivery. Switching to the scan flow
  // discards any picked rows (its close exits the whole sheet), so a dirty
  // manual draft asks first.
  if (mode === null) {
    const pickScan = () => {
      if (dirty && !confirm(ds.discardConfirm)) return;
      if (draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
      resetRows();
      setMode('scan');
    };
    return (
      <Overlay open={open} onClose={requestClose} hasUnsavedChanges={dirty} width={520} title={ds.title}>
        {draftRestored && <div role="status" style={deliveryDraftStyle}>{ds.draftRestored}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {canScanInvoices && <OptionRow title={ds.scanOption} onPick={pickScan} />}
          <OptionRow title={ds.manualOption} onPick={() => setMode('manual')} />
        </div>
      </Overlay>
    );
  }

  // ── Manual path — dropdown rows ────────────────────────────────────
  const updateRow = (key: number, patch: Partial<Row>) => {
    setFormError('');
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const addRow = () =>
    setRows((prev) => [...prev, { key: rowSeq.current++, itemId: '', qty: '', cost: '' }]);
  const removeRow = (key: number) =>
    setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : prev));

  // Whole units + actual per-unit cost. Coalesce by itemId (a safety net — the
  // dropdowns already hide an item picked in another row) using a weighted
  // cost so a duplicate pick cannot lose purchase value.
  const picked = new Map<string, { quantity: number; totalCost: number }>();
  for (const r of rows) {
    if (!r.itemId) continue;
    const n = Math.round(Number(r.qty));
    const unitCost = Number(r.cost);
    if (!Number.isFinite(n) || n < 1) continue;
    if (canViewFinancials && (r.cost.trim() === '' || !Number.isFinite(unitCost) || unitCost < 0)) continue;
    const prior = picked.get(r.itemId) ?? { quantity: 0, totalCost: 0 };
    picked.set(r.itemId, {
      quantity: prior.quantity + n,
      totalCost: prior.totalCost + (canViewFinancials ? n * unitCost : 0),
    });
  }
  const entered = [...picked].flatMap(([itemId, values]) => {
    const d = display.find((x) => x.id === itemId);
    return d ? [{
      d,
      n: values.quantity,
      unitCost: canViewFinancials ? values.totalCost / values.quantity : null,
    }] : [];
  });
  const hasIncompleteLine = rows.some((r) => {
    if (!r.itemId && !r.qty && !r.cost) return false;
    const qty = Number(r.qty);
    const cost = Number(r.cost);
    return !r.itemId || !Number.isFinite(qty) || qty < 1
      || (canViewFinancials && (r.cost.trim() === '' || !Number.isFinite(cost) || cost < 0));
  });
  const canSubmit = entered.length > 0 && !hasIncompleteLine;

  const selectedIds = new Set(rows.map((r) => r.itemId).filter(Boolean));
  const canAddRow = selectedIds.size < display.length && rows.every((r) => r.itemId !== '');

  const handleSave = async () => {
    if (!user || !activePropertyId || saving || (!saveAttempt.current && !canSubmit)) return;
    setFormError('');
    setSaving(true);
    try {
      if (!saveAttempt.current) {
        const lines: InventoryDeliveryLine[] = entered.map(({ d, n, unitCost }, index) => ({
          // The item id makes this deterministic even if row order changes; the
          // suffix is a defensive guard if future UI allows duplicate item rows.
          lineKey: `${d.id}:${index}`,
          itemId: d.id,
          quantity: n,
          unitCost,
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
      clearDeliveryAttempt('manual', activePropertyId, attempt.requestId);
      if (draftStorageInput) clearInventoryOverlayDraft(draftStorageInput);
      saveAttempt.current = null;
      setRetryLocked(false);

      onClose();
    } catch (err) {
      console.error('[delivery-sheet] save failed', err);
      if (isDefinitiveDeliveryFailure(err, retryLocked)) {
        if (saveAttempt.current) {
          clearDeliveryAttempt('manual', activePropertyId, saveAttempt.current.requestId);
        }
        saveAttempt.current = null;
        setRetryLocked(false);
      } else if (saveAttempt.current) {
        setRetryLocked(true);
      } else {
        // Local validation failed before a request was sent; the draft is safe
        // to edit because there is no uncertain database result to replay.
        setRetryLocked(false);
      }
      setFormError(ds.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Overlay
      open={open}
      onClose={requestClose}
      hasUnsavedChanges={dirty}
      italic={ds.title}
      width={520}
      footer={
        <>
          <span style={{ marginRight: 'auto' }} />
          {canViewFinancials && (
            <Btn variant="ghost" size="md" onClick={() => setMode(null)} disabled={saving || retryLocked}>
              {ds.back}
            </Btn>
          )}
          <Btn
            variant="primary"
            size="md"
            onClick={handleSave}
            disabled={saving || (!retryLocked && !canSubmit)}
            aria-busy={saving}
          >
            {saving
              ? ds.saving
              : retryLocked
                ? ds.retryBtn
                : `${ds.addBtn} · ${entered.length}`}
          </Btn>
        </>
      }
    >
      {draftRestored && <div role="status" style={deliveryDraftStyle}>{ds.draftRestored}</div>}
      {retryLocked && <div style={warnBannerStyle}>{ds.retryPending}</div>}
      {!canViewFinancials && <div role="note" style={deliveryDraftStyle}>{ds.costsHidden}</div>}
      {formError && <div role="alert" style={deliveryErrorStyle}>{formError}</div>}
      {display.length === 0 && <div role="status" style={deliveryEmptyStyle}>{ds.noItems}</div>}
      <div className={overlayStyles.deliveryRows} aria-busy={saving}>
        {hasIncompleteLine && (
          <div role="alert" style={{ fontFamily: fonts.sans, fontSize: 12.5, fontWeight: 600, color: T.warm }}>
            {canViewFinancials ? ds.costRequired : ds.fieldsRequired}
          </div>
        )}
        {rows.map((r) => {
          // A row's dropdown offers items not picked in OTHER rows (+ its own).
          // Dropdown groups mirror the hotel's VISIBLE tabs when any built-in
          // tab is hidden (custom tabs by name, hidden-bucket leftovers under
          // "Other"); default hotels keep the built-in category groups.
          const hiddenTabs = new Set(tabLayout?.hidden ?? []);
          const groupDefs: Array<{ key: string; label: string; match: (d: DisplayItem) => boolean }> =
            hiddenTabs.size > 0 && customCategories.length > 0
              ? [
                  ...(!hiddenTabs.has('general')
                    ? [{ key: 'general', label: invT(lang).generalInventory, match: (d: DisplayItem) => !d.customCategoryId && d.cat !== 'breakfast' }]
                    : []),
                  ...(!hiddenTabs.has('breakfast')
                    ? [{ key: 'breakfast', label: invT(lang).breakfastInventory, match: (d: DisplayItem) => !d.customCategoryId && d.cat === 'breakfast' }]
                    : []),
                  ...customCategories.map((cc) => ({
                    key: cc.id, label: cc.name, match: (d: DisplayItem) => d.customCategoryId === cc.id,
                  })),
                  {
                    key: 'other',
                    label: ds.otherGroup,
                    match: (d: DisplayItem) => !d.customCategoryId
                      && (d.cat === 'breakfast' ? hiddenTabs.has('breakfast') : hiddenTabs.has('general')),
                  },
                ]
              : CAT_ORDER.map((c) => ({ key: c as string, label: catLabelFor(lang, c), match: (d: DisplayItem) => d.cat === c }));
          const availableFor = (g: { match: (d: DisplayItem) => boolean }) =>
            display.filter((d) => g.match(d) && (d.id === r.itemId || !selectedIds.has(d.id)));
          return (
            <div key={r.key} className={`${overlayStyles.deliveryRow} ${!canViewFinancials ? overlayStyles.deliveryRowNoCost : ''}`}>
              <label className={overlayStyles.deliveryItemField} style={deliveryFieldStyle}>
                <span className={overlayStyles.fieldLabel}>{ds.itemLabel}</span>
                <select
                  className={overlayStyles.formControl}
                  value={r.itemId}
                  disabled={saving || retryLocked}
                  onChange={(e) => {
                    const itemId = e.target.value;
                    const selected = display.find((d) => d.id === itemId);
                    updateRow(r.key, {
                      itemId,
                      cost: canViewFinancials && selected?.raw.unitCost != null ? String(selected.raw.unitCost) : '',
                    });
                  }}
                  style={{
                    width: '100%', minWidth: 0, height: 44, padding: '0 12px', borderRadius: 9,
                    boxSizing: 'border-box', cursor: 'pointer', outline: 'none',
                    background: T.bg, border: `1px solid ${T.controlBorder}`,
                    fontFamily: fonts.sans, fontSize: 14, fontWeight: 600,
                    color: r.itemId ? T.ink : T.ink2,
                  }}
                >
                  <option value="" style={{ color: T.ink2, fontWeight: 600 }}>{ds.selectItem}</option>
                  {groupDefs.map((g) => {
                    const opts = availableFor(g);
                    if (opts.length === 0) return null;
                    return (
                      <optgroup key={g.key} label={g.label} style={{ color: T.ink2, fontWeight: 600 }}>
                        {opts.map((d) => (
                          <option key={d.id} value={d.id} style={{ color: T.ink, fontWeight: 500 }}>{d.name}</option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </label>
              <label style={deliveryFieldStyle}>
                <span className={overlayStyles.fieldLabel}>{ds.quantityLabel}</span>
                <input
                  className={overlayStyles.formControl}
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  value={r.qty}
                  disabled={saving || retryLocked}
                  onChange={(e) => { const v = e.target.value; if (numGuard(v)) updateRow(r.key, { qty: v }); }}
                  placeholder={ds.qtyPh}
                  style={{
                    width: '100%', height: 44, borderRadius: 9, boxSizing: 'border-box',
                    textAlign: 'center', outline: 'none',
                    background: T.bg, border: `1px solid ${T.controlBorder}`,
                    fontFamily: fonts.sans, fontSize: 15, fontWeight: 600, color: T.ink,
                    letterSpacing: '-0.02em',
                  }}
                />
              </label>
              {canViewFinancials && (
                <label style={deliveryFieldStyle}>
                  <span className={overlayStyles.fieldLabel}>{ds.unitCostLabel}</span>
                  <input
                    className={overlayStyles.formControl}
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={r.cost}
                    disabled={saving || retryLocked}
                    onChange={(e) => { const v = e.target.value; if (numGuard(v)) updateRow(r.key, { cost: v }); }}
                    placeholder={ds.costPh}
                    style={{
                      width: '100%', height: 44, borderRadius: 9, boxSizing: 'border-box',
                      textAlign: 'center', outline: 'none',
                      background: T.bg, border: `1px solid ${T.controlBorder}`,
                      fontFamily: fonts.sans, fontSize: 14, fontWeight: 600, color: T.ink,
                      letterSpacing: '-0.02em',
                    }}
                  />
                </label>
              )}
              <button
                type="button"
                className={overlayStyles.deliveryRemove}
                onClick={() => removeRow(r.key)}
                aria-label={ds.remove}
                disabled={rows.length === 1 || saving || retryLocked}
                style={{
                  width: 44, height: 44, flex: 'none', borderRadius: 8, padding: 0,
                  cursor: rows.length === 1 ? 'default' : 'pointer',
                  background: T.bg, border: `1px solid ${rows.length === 1 ? T.rule : T.controlBorder}`,
                  color: rows.length === 1 ? T.faint : T.ink2,
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
        className={overlayStyles.compactButton}
        onClick={addRow}
        disabled={!canAddRow || saving || retryLocked}
        style={{
          marginTop: 12,
          display: 'inline-flex', alignItems: 'center', gap: 6,
          minHeight: 44, padding: '8px 14px', borderRadius: 999,
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

const deliveryFieldStyle: React.CSSProperties = {
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: 6,
};

const deliveryDraftStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '10px 12px',
  borderRadius: 9,
  background: T.tealDim,
  color: T.tealText,
  fontFamily: fonts.sans,
  fontSize: 12.5,
  fontWeight: 600,
};

const deliveryErrorStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '10px 12px',
  borderRadius: 9,
  border: `1px solid ${T.warm}55`,
  background: T.warmDim,
  color: T.warm,
  fontFamily: fonts.sans,
  fontSize: 12.5,
  fontWeight: 600,
};

const deliveryEmptyStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '28px 18px',
  border: `1px dashed ${T.controlBorder}`,
  borderRadius: 12,
  color: T.ink2,
  fontFamily: fonts.sans,
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'center',
};

// One chooser row: serif label + arrow (CountSheet's ScopeOption idiom).
function OptionRow({ title, onPick }: { title: string; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      className={overlayStyles.compactButton}
      onClick={() => { Motion.pop(ref.current, 0.98); onPick(); }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.ink; e.currentTarget.style.background = T.inkWash; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.controlBorder; e.currentTarget.style.background = T.bg; }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 15,
        minHeight: 56,
        padding: '18px 20px',
        borderRadius: 13,
        cursor: 'pointer',
        background: T.bg,
        border: `1px solid ${T.controlBorder}`,
        textAlign: 'left',
        width: '100%',
      }}
    >
      <Serif size={23} style={{ letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{title}</Serif>
      <Serif size={20} color={T.ink2}>→</Serif>
    </button>
  );
}
