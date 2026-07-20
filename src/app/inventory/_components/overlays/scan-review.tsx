'use client';

// Review half of the scan-invoice flow: the per-line review-row model and its
// UI. Extracted verbatim from ScanInvoiceSheet — the sheet keeps the row
// state + handlers; this module owns the shapes and the rendering.

import React from 'react';
import { matchInvoiceLine, type MatchCandidate } from '@/lib/inventory-match';
import { T, fonts, type InvCat } from '../tokens';
import { inputSm } from './form-kit';
import { StaxisMenu, type MenuGroup } from './menu-kit';
import type { DisplayItem } from '../types';
import { catLabelFor, type Lang } from '../inv-i18n';
import { ssStrings } from './scan-i18n';
import type { InventoryCustomCategory } from '@/types';

export interface RawInvoiceLine {
  item_name: string;
  quantity: number;
  quantity_cases: number | null;
  pack_size: number | null;
  unit_cost: number | null;
  total_cost: number | null;
}

export type LineDecision = 'match' | 'create' | 'skip';

export interface ReviewRow {
  key: string;
  raw: RawInvoiceLine;
  decision: LineDecision;
  matchedItemId: string | null;
  candidates: MatchCandidate[];
  ambiguous: boolean;
  /** Unsafe matcher suggestions remain blocked until a manager explicitly
   * confirms the suggested SKU or chooses another one. */
  matchConfirmed: boolean;
  qtyInput: string;
  unitCostInput: string;
  /** True once the manager edits cost; hidden OCR totals must no longer win. */
  unitCostDirty: boolean;
  afterInput: string;   // resulting on-hand for a matched line (editable)
  afterDirty: boolean;  // operator overrode the resulting stock
  newName: string;
  newCategory: InvCat;
  newCustomCategoryId: string | null;
  newUnit: string;
  newPar: string;
  newSetAside: string;
  saved: boolean;
  error?: string;
}

export function buildRow(raw: RawInvoiceLine, i: number, display: DisplayItem[]): ReviewRow {
  const m = matchInvoiceLine(raw.item_name, display);
  const qty = raw.quantity > 0 ? raw.quantity : 1;
  const matchedItemId = m.best?.id ?? null;
  const onHand = matchedItemId
    ? Math.max(0, Math.round(display.find((d) => d.id === matchedItemId)?.estimated ?? 0))
    : 0;
  return {
    key: `${i}-${raw.item_name.slice(0, 24)}`,
    raw,
    decision: m.candidates.length > 0 ? 'match' : 'create',
    matchedItemId,
    candidates: m.candidates,
    ambiguous: m.ambiguous,
    matchConfirmed: m.autoSelect,
    qtyInput: String(qty),
    unitCostInput: effectiveInvoiceUnitCost(raw, qty),
    unitCostDirty: false,
    afterInput: String(onHand + qty),
    afterDirty: false,
    newName: raw.item_name.trim(),
    newCategory: 'housekeeping',
    newCustomCategoryId: null,
    newUnit: 'each',
    // A silent par=0 makes the new SKU look complete while disabling its low-
    // stock signal. Require the manager to provide the operational par.
    newPar: '',
    newSetAside: '0',
    saved: false,
  };
}

export function effectiveInvoiceUnitCost(raw: RawInvoiceLine, quantity: number): string {
  const total = Number(raw.total_cost);
  if (raw.total_cost != null && Number.isFinite(total) && total >= 0 && quantity > 0) {
    return String(total / quantity);
  }
  const unit = Number(raw.unit_cost);
  return raw.unit_cost != null && Number.isFinite(unit) && unit >= 0 ? String(unit) : '';
}

export function reviewRowHasCompleteCost(row: ReviewRow): boolean {
  if (row.decision === 'skip') return true;
  if (row.unitCostInput.trim() === '') return false;
  const value = Number(row.unitCostInput);
  return Number.isFinite(value) && value >= 0;
}

export function reviewRowHasCompleteNewItem(row: ReviewRow): boolean {
  if (row.decision !== 'create') return true;
  const par = Number(row.newPar);
  const setAside = Number(row.newSetAside);
  const quantity = Number(row.qtyInput);
  return row.newName.trim().length > 0
    && row.newUnit.trim().length > 0
    && row.newPar.trim().length > 0
    && Number.isFinite(par)
    && par >= 0
    && row.newSetAside.trim().length > 0
    && Number.isInteger(setAside)
    && setAside >= 0
    && Number.isFinite(quantity)
    && setAside <= quantity;
}

/** One fail-closed predicate controls both the Save button and the submit
 * handler. A skipped line is intentionally resolved; every other line needs a
 * positive quantity, a visible cost, and either a confirmed match or complete
 * new-item fields. */
export function reviewRowIsReady(row: ReviewRow): boolean {
  if (row.decision === 'skip') return true;
  const quantity = Number(row.qtyInput);
  if (!Number.isFinite(quantity) || quantity <= 0 || !reviewRowHasCompleteCost(row)) return false;
  if (row.decision === 'match') return Boolean(row.matchedItemId) && row.matchConfirmed;
  return reviewRowHasCompleteNewItem(row);
}

export function invoiceReviewHasUnsavedWork(input: {
  phase: 'upload' | 'reading' | 'review' | 'verifying' | 'committing' | 'done' | 'error';
  hasStagedFile: boolean;
  rowCount: number;
}): boolean {
  if (input.phase === 'done') return false;
  return input.hasStagedFile
    || input.phase === 'reading'
    || ((input.phase === 'review' || input.phase === 'verifying' || input.phase === 'committing')
      && input.rowCount > 0);
}

const CAT_ORDER: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

// Receipt-style line: [⇄ full-catalog picker] [name] ………… [qty] [✕].
//
// The ⇄ button on the far left opens the WHOLE catalog (grouped by category,
// via the custom StaxisMenu) — the rescue for when the invoice's wording is
// nothing like the inventory name and the matcher's shortlist missed it
// entirely. The name itself is also a menu (the matcher's shortlist + "＋ New
// item") for the quick fix. Quantity and unit cost are both explicit manager
// decisions because they become the received-purchase ledger and month close.
export function ReviewRowView({
  lang,
  row,
  display,
  customCategories = [],
  hiddenBuiltins = [],
  onDecision,
  onQty,
  onUnitCost,
  onConfirmMatch,
  onNewName,
  onNewCategory,
  onNewCustomCategoryId,
  onNewUnit,
  onNewPar,
  onNewSetAside,
  onSkip,
  onUnskip,
}: {
  lang: Lang;
  row: ReviewRow;
  display: DisplayItem[];
  customCategories?: InventoryCustomCategory[];
  hiddenBuiltins?: readonly string[];
  onDecision: (v: string) => void;
  onQty: (v: string) => void;
  onUnitCost: (v: string) => void;
  onConfirmMatch: () => void;
  onNewName: (v: string) => void;
  onNewCategory: (c: InvCat) => void;
  onNewCustomCategoryId: (id: string | null) => void;
  onNewUnit: (v: string) => void;
  onNewPar: (v: string) => void;
  onNewSetAside: (v: string) => void;
  onSkip: () => void;
  onUnskip: () => void;
}) {
  const ss = ssStrings(lang);
  const creating = row.decision === 'create';
  const skipped = row.decision === 'skip';
  const costComplete = reviewRowHasCompleteCost(row);
  const newItemComplete = reviewRowHasCompleteNewItem(row);
  const chosen = creating ? null : row.candidates.find((c) => c.id === row.matchedItemId);
  const needsMatchConfirmation = !creating && !row.matchConfirmed;
  const warn = needsMatchConfirmation;
  const hasPicker = display.length > 0;
  const norm = (s: string) => s.trim().toLowerCase();
  // Echo the invoice's own wording only when it differs from the matched item
  // (that's when the manager needs it to judge the match) or when the case
  // math explains the quantity.
  const rawEcho = chosen && norm(chosen.name) !== norm(row.raw.item_name) ? row.raw.item_name : null;
  const caseCaption =
    row.raw.quantity_cases && row.raw.pack_size ? ss.cases(row.raw.quantity_cases, row.raw.pack_size) : null;
  const caption = [rawEcho, caseCaption].filter(Boolean).join(' · ');
  const visibleBuiltins = CAT_ORDER.filter((category) => (
    category === 'breakfast'
      ? !hiddenBuiltins.includes('breakfast')
      : !hiddenBuiltins.includes('general')
  ));
  const categoryOptions = [
    ...visibleBuiltins.map((category) => ({ value: category, label: catLabelFor(lang, category) })),
    ...customCategories.map((category) => ({ value: `custom:${category.id}`, label: category.name })),
  ];
  if (categoryOptions.length === 0) {
    categoryOptions.push(...CAT_ORDER.map((category) => ({ value: category, label: catLabelFor(lang, category) })));
  }
  const categoryValue = row.newCustomCategoryId
    ? `custom:${row.newCustomCategoryId}`
    : row.newCategory;
  const categoryLabel = row.newCustomCategoryId
    ? customCategories.find((category) => category.id === row.newCustomCategoryId)?.name ?? ss.category
    : catLabelFor(lang, row.newCategory);

  const nameGroups: MenuGroup[] = [
    {
      options: [
        ...row.candidates.map((c) => ({ value: c.id, label: c.name })),
        { value: '__create__', label: ss.newItemOpt(row.raw.item_name) },
      ],
    },
  ];
  const catalogGroups: MenuGroup[] = CAT_ORDER.filter((c) => display.some((d) => d.cat === c)).map((cat) => ({
    label: catLabelFor(lang, cat),
    options: display.filter((d) => d.cat === cat).map((d) => ({ value: d.id, label: d.name })),
  }));

  if (skipped) {
    return (
      <div className="scan-review-main" style={{ ...lineShell, display: 'flex', alignItems: 'center', gap: 10 }}>
        {hasPicker && <span style={{ width: 44, flex: 'none' }} />}
        <span
          style={{
            flex: '1 1 0',
            minWidth: 0,
            fontFamily: fonts.sans,
            fontSize: 14.5,
            color: T.faint,
            textDecoration: 'line-through',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {chosen?.name ?? row.raw.item_name}
        </span>
        <button type="button" onClick={onUnskip} style={putBackBtn}>
          {ss.putBack}
        </button>
      </div>
    );
  }

  return (
    <div className="scan-review-row" style={{ ...lineShell, background: row.saved ? T.sageDim : undefined }}>
      <div className="scan-review-main" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {hasPicker && (
          <div className="scan-review-picker">
            <StaxisMenu
              groups={catalogGroups}
              selected={creating ? null : row.matchedItemId}
              onPick={onDecision}
              title={ss.pickDifferent}
              menuWidth={280}
              triggerStyle={pickerShell}
              triggerLabel={<span aria-hidden style={{ fontSize: 12, color: T.ink3, lineHeight: 1 }}>⇄</span>}
            />
          </div>
        )}

        <div className="scan-review-name" style={{ flex: '1 1 0', minWidth: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%' }}>
            {row.saved && <span style={{ color: T.forestText, marginRight: 5, fontSize: 13 }}>✓</span>}
            <StaxisMenu
              groups={nameGroups}
              selected={creating ? '__create__' : row.matchedItemId ?? '__create__'}
              onPick={onDecision}
              menuWidth={280}
              triggerStyle={nameTrigger}
              triggerLabel={
                <>
                  <span
                    style={{
                      color: warn ? T.caramel : T.ink,
                      textDecoration: 'underline',
                      textDecorationStyle: 'dotted',
                      textDecorationColor: warn ? T.caramel : T.faint,
                      textUnderlineOffset: 4,
                    }}
                  >
                    {creating ? ss.newItemOpt(row.raw.item_name) : chosen?.name ?? row.raw.item_name}
                  </span>
                  <span aria-hidden style={{ marginLeft: 6, fontSize: 8.5, color: T.faint }}>▾</span>
                </>
              }
            />
          </span>
          {caption && <div style={captionStyle}>{caption}</div>}
          {warn && (
            <div role="alert" style={matchWarningStyle}>
              <span>{row.ambiguous ? ss.twoCloseMatches : ss.reviewSuggestedMatch}</span>
              <button type="button" onClick={onConfirmMatch} style={confirmMatchBtn}>
                {ss.confirmMatch}
              </button>
            </div>
          )}
          {row.error && (
            <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.warm, marginTop: 3 }}>{row.error}</div>
          )}
        </div>

        <label className="scan-review-qty" style={compactField}>
          <span style={compactLabel}>{ss.qty}</span>
          <input
            value={row.qtyInput}
            inputMode="decimal"
            onChange={(e) => onQty(e.target.value)}
            aria-label={ss.qtyReceived}
            style={{ ...inputSm, width: 58, minHeight: 44, textAlign: 'center', flex: 'none' }}
          />
        </label>
        <label className="scan-review-cost" style={compactField}>
          <span style={{ ...compactLabel, color: costComplete ? T.ink3 : T.warm }}>{ss.unitCost}</span>
          <input
            value={row.unitCostInput}
            inputMode="decimal"
            onChange={(e) => onUnitCost(e.target.value)}
            aria-label={ss.unitCost}
            aria-invalid={!costComplete}
            placeholder="0.00"
            style={{
              ...inputSm,
              width: 72,
              minHeight: 44,
              textAlign: 'right',
              flex: 'none',
              borderColor: costComplete ? T.rule : T.warm,
            }}
          />
        </label>
        <button className="scan-review-remove" type="button" onClick={onSkip} aria-label={ss.skipLine} style={removeBtn}>
          ✕
        </button>
      </div>
      {creating && (
        <div className="scan-new-item-grid" style={newItemGrid}>
          <label className="scan-new-item-name" style={newItemField}>
            <span style={newItemLabel}>{ss.newItemName}</span>
            <input
              value={row.newName}
              onChange={(event) => onNewName(event.target.value)}
              aria-invalid={row.newName.trim().length === 0}
              style={{
                ...inputSm,
                minHeight: 44,
                width: '100%',
                borderColor: row.newName.trim().length > 0 ? T.rule : T.warm,
              }}
            />
          </label>
          <div style={newItemField}>
            <span style={newItemLabel}>{ss.category}</span>
            <StaxisMenu
              groups={[{ options: categoryOptions }]}
              selected={categoryValue}
              onPick={(value) => {
                if (value.startsWith('custom:')) {
                  onNewCustomCategoryId(value.slice('custom:'.length));
                } else {
                  onNewCustomCategoryId(null);
                  onNewCategory(value as InvCat);
                }
              }}
              menuWidth={200}
              triggerStyle={newItemSelect}
              title={ss.category}
              triggerLabel={
                <>
                  <span>{categoryLabel}</span>
                  <span aria-hidden style={{ marginLeft: 6, fontSize: 8, color: T.ink3 }}>▾</span>
                </>
              }
            />
          </div>
          <label style={newItemField}>
            <span style={newItemLabel}>{ss.unit}</span>
            <input
              value={row.newUnit}
              onChange={(event) => onNewUnit(event.target.value)}
              aria-invalid={row.newUnit.trim().length === 0}
              style={{
                ...inputSm,
                minHeight: 44,
                width: '100%',
                borderColor: row.newUnit.trim().length > 0 ? T.rule : T.warm,
              }}
            />
          </label>
          <label style={newItemField}>
            <span style={newItemLabel}>{ss.parLevel}</span>
            <input
              value={row.newPar}
              inputMode="decimal"
              onChange={(event) => onNewPar(event.target.value)}
              aria-invalid={row.newPar.trim() === '' || !Number.isFinite(Number(row.newPar)) || Number(row.newPar) < 0}
              placeholder="0"
              style={{
                ...inputSm,
                minHeight: 44,
                width: '100%',
                borderColor: row.newPar.trim() !== '' && Number.isFinite(Number(row.newPar)) && Number(row.newPar) >= 0
                  ? T.rule
                  : T.warm,
              }}
            />
          </label>
          <label style={newItemField}>
            <span style={newItemLabel}>{ss.setAside}</span>
            <input
              value={row.newSetAside}
              inputMode="numeric"
              onChange={(event) => onNewSetAside(event.target.value)}
              aria-invalid={
                row.newSetAside.trim() === ''
                || !Number.isInteger(Number(row.newSetAside))
                || Number(row.newSetAside) < 0
                || Number(row.newSetAside) > Number(row.qtyInput)
              }
              placeholder="0"
              style={{
                ...inputSm,
                minHeight: 44,
                width: '100%',
                borderColor: row.newSetAside.trim() !== ''
                  && Number.isInteger(Number(row.newSetAside))
                  && Number(row.newSetAside) >= 0
                  && Number(row.newSetAside) <= Number(row.qtyInput)
                  ? T.rule
                  : T.warm,
              }}
            />
          </label>
          {!newItemComplete && (
            <div role="alert" style={newItemError}>{ss.completeNewItem}</div>
          )}
        </div>
      )}
    </div>
  );
}

const lineShell: React.CSSProperties = {
  borderBottom: `1px solid ${T.ruleFaint}`,
  padding: '10px 2px',
  minHeight: 50,
  boxSizing: 'border-box',
};

const compactField: React.CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 3,
  flex: 'none',
};

const compactLabel: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 8.5,
  lineHeight: 1,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: T.ink3,
  textAlign: 'center',
};

const captionStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 10.5,
  color: T.faint,
  marginTop: 3,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const nameTrigger: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  margin: 0,
  fontFamily: fonts.sans,
  fontSize: 15,
  fontWeight: 600,
  color: T.ink,
  cursor: 'pointer',
  minHeight: 44,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left',
};

const matchWarningStyle: React.CSSProperties = {
  alignItems: 'center',
  color: T.caramel,
  display: 'flex',
  flexWrap: 'wrap',
  fontFamily: fonts.sans,
  fontSize: 11.5,
  fontWeight: 600,
  gap: 6,
  lineHeight: 1.4,
  marginTop: 5,
};

const confirmMatchBtn: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${T.caramel}66`,
  borderRadius: 8,
  color: T.caramel,
  cursor: 'pointer',
  fontFamily: fonts.sans,
  fontSize: 11.5,
  fontWeight: 650,
  minHeight: 44,
  padding: '4px 9px',
};

const newItemGrid: React.CSSProperties = {
  background: T.paper,
  border: `1px solid ${T.rule}`,
  borderRadius: 12,
  display: 'grid',
  gap: 10,
  margin: '10px 36px 2px',
  padding: 12,
};

const newItemField: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  minWidth: 0,
};

const newItemLabel: React.CSSProperties = {
  color: T.ink2,
  fontFamily: fonts.sans,
  fontSize: 12,
  fontWeight: 650,
  lineHeight: 1.3,
};

const newItemSelect: React.CSSProperties = {
  alignItems: 'center',
  background: T.bg,
  border: `1px solid ${T.rule}`,
  borderRadius: 8,
  color: T.ink,
  cursor: 'pointer',
  display: 'inline-flex',
  fontFamily: fonts.sans,
  fontSize: 13,
  fontWeight: 600,
  justifyContent: 'space-between',
  minHeight: 44,
  padding: '0 10px',
  width: '100%',
};

const newItemError: React.CSSProperties = {
  color: T.warm,
  fontFamily: fonts.sans,
  fontSize: 11.5,
  fontWeight: 600,
  gridColumn: '1 / -1',
  lineHeight: 1.4,
};

const pickerShell: React.CSSProperties = {
  flex: 'none',
  width: 44,
  height: 44,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${T.rule}`,
  borderRadius: 6,
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
};

const removeBtn: React.CSSProperties = {
  flex: 'none',
  width: 44,
  height: 44,
  border: 'none',
  background: 'transparent',
  color: T.ink3,
  fontFamily: fonts.sans,
  fontSize: 13,
  lineHeight: 1,
  cursor: 'pointer',
  borderRadius: 6,
};

const putBackBtn: React.CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  color: T.ink2,
  fontFamily: fonts.sans,
  fontSize: 12,
  fontWeight: 500,
  textDecoration: 'underline',
  cursor: 'pointer',
  minHeight: 44,
  padding: '4px 10px',
};
