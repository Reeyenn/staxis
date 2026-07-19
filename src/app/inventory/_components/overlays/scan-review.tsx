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
  qtyInput: string;
  unitCostInput: string;
  /** True once the manager edits cost; hidden OCR totals must no longer win. */
  unitCostDirty: boolean;
  afterInput: string;   // resulting on-hand for a matched line (editable)
  afterDirty: boolean;  // operator overrode the resulting stock
  newCategory: InvCat;
  newUnit: string;
  newPar: string;
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
    qtyInput: String(qty),
    unitCostInput: effectiveInvoiceUnitCost(raw, qty),
    unitCostDirty: false,
    afterInput: String(onHand + qty),
    afterDirty: false,
    newCategory: 'housekeeping',
    newUnit: 'each',
    newPar: '0',
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
  onDecision,
  onQty,
  onUnitCost,
  onNewCategory,
  onSkip,
  onUnskip,
}: {
  lang: Lang;
  row: ReviewRow;
  display: DisplayItem[];
  onDecision: (v: string) => void;
  onQty: (v: string) => void;
  onUnitCost: (v: string) => void;
  onNewCategory: (c: InvCat) => void;
  onSkip: () => void;
  onUnskip: () => void;
}) {
  const ss = ssStrings(lang);
  const creating = row.decision === 'create';
  const skipped = row.decision === 'skip';
  const costComplete = reviewRowHasCompleteCost(row);
  const chosen = creating ? null : row.candidates.find((c) => c.id === row.matchedItemId);
  const warn = row.ambiguous && !creating;
  const hasPicker = display.length > 0;
  const norm = (s: string) => s.trim().toLowerCase();
  // Echo the invoice's own wording only when it differs from the matched item
  // (that's when the manager needs it to judge the match) or when the case
  // math explains the quantity.
  const rawEcho = chosen && norm(chosen.name) !== norm(row.raw.item_name) ? row.raw.item_name : null;
  const caseCaption =
    row.raw.quantity_cases && row.raw.pack_size ? ss.cases(row.raw.quantity_cases, row.raw.pack_size) : null;
  const caption = [rawEcho, caseCaption].filter(Boolean).join(' · ');

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
      <div style={{ ...lineShell, display: 'flex', alignItems: 'center', gap: 10 }}>
        {hasPicker && <span style={{ width: 26, flex: 'none' }} />}
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
    <div style={{ ...lineShell, background: row.saved ? T.sageDim : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {hasPicker && (
          <StaxisMenu
            groups={catalogGroups}
            selected={creating ? null : row.matchedItemId}
            onPick={onDecision}
            title={ss.pickDifferent}
            menuWidth={280}
            triggerStyle={pickerShell}
            triggerLabel={<span aria-hidden style={{ fontSize: 12, color: T.ink3, lineHeight: 1 }}>⇄</span>}
          />
        )}

        <div style={{ flex: '1 1 0', minWidth: 0 }}>
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
            <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.caramel, marginTop: 3 }}>{ss.twoCloseMatches}</div>
          )}
          {row.error && (
            <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.warm, marginTop: 3 }}>{row.error}</div>
          )}
          {creating && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <span style={goesInLabel}>{ss.goesIn}</span>
              <StaxisMenu
                groups={[{ options: CAT_ORDER.map((c) => ({ value: c, label: catLabelFor(lang, c) })) }]}
                selected={row.newCategory}
                onPick={(v) => onNewCategory(v as InvCat)}
                menuWidth={200}
                triggerStyle={catTrigger}
                triggerLabel={
                  <>
                    <span
                      style={{
                        textDecoration: 'underline',
                        textDecorationStyle: 'dotted',
                        textDecorationColor: T.faint,
                        textUnderlineOffset: 3,
                      }}
                    >
                      {catLabelFor(lang, row.newCategory)}
                    </span>
                    <span aria-hidden style={{ marginLeft: 4, fontSize: 7.5, color: T.faint }}>▾</span>
                  </>
                }
              />
            </div>
          )}
        </div>

        <label style={compactField}>
          <span style={compactLabel}>{ss.qty}</span>
          <input
            value={row.qtyInput}
            inputMode="decimal"
            onChange={(e) => onQty(e.target.value)}
            aria-label={ss.qtyReceived}
            style={{ ...inputSm, width: 58, minHeight: 40, textAlign: 'center', flex: 'none' }}
          />
        </label>
        <label style={compactField}>
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
              minHeight: 40,
              textAlign: 'right',
              flex: 'none',
              borderColor: costComplete ? T.rule : T.warm,
            }}
          />
        </label>
        <button type="button" onClick={onSkip} aria-label={ss.skipLine} style={removeBtn}>
          ✕
        </button>
      </div>
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
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left',
};

const catTrigger: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: 0,
  fontFamily: fonts.sans,
  fontSize: 12,
  fontWeight: 500,
  color: T.ink2,
  cursor: 'pointer',
};

const goesInLabel: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 9.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: T.ink3,
  fontWeight: 600,
};

const pickerShell: React.CSSProperties = {
  flex: 'none',
  width: 26,
  height: 26,
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
  width: 26,
  height: 26,
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
  padding: '4px 2px',
};
