'use client';

// Review half of the scan-invoice flow: the per-line review-row model and its
// UI. Extracted verbatim from ScanInvoiceSheet — the sheet keeps the row
// state + handlers; this module owns the shapes and the rendering.

import React from 'react';
import { matchInvoiceLine, type MatchCandidate } from '@/lib/inventory-match';
import { T, fonts, type InvCat } from '../tokens';
import { inputSm } from './form-kit';
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
    unitCostInput: raw.unit_cost != null ? String(raw.unit_cost) : '',
    afterInput: String(onHand + qty),
    afterDirty: false,
    newCategory: 'housekeeping',
    newUnit: 'each',
    newPar: '0',
    saved: false,
  };
}

export function ReviewRowView({
  lang,
  row,
  onHand,
  matchedCounted,
  onDecision,
  onQty,
  onUnitCost,
  onAfter,
  onNewCategory,
  onNewUnit,
  onNewPar,
}: {
  lang: Lang;
  row: ReviewRow;
  onHand: number;
  matchedCounted: number;
  onDecision: (v: string) => void;
  onQty: (v: string) => void;
  onUnitCost: (v: string) => void;
  onAfter: (v: string) => void;
  onNewCategory: (c: InvCat) => void;
  onNewUnit: (v: string) => void;
  onNewPar: (v: string) => void;
}) {
  const ss = ssStrings(lang);
  const skipped = row.decision === 'skip';
  const selectValue = row.decision === 'create' ? '__create__' : row.decision === 'skip' ? '__skip__' : row.matchedItemId ?? '__create__';
  // Loud if we'd re-baseline to roughly just the received qty even though the
  // item has stored stock — usually a stale usage rate, worth a second look.
  const staleEstimate = row.decision === 'match' && onHand === 0 && matchedCounted > 0;
  const caseCaption =
    row.raw.quantity_cases && row.raw.pack_size ? ss.cases(row.raw.quantity_cases, row.raw.pack_size) : null;

  return (
    <div
      style={{
        border: `1px solid ${row.error ? `${T.warm}55` : T.rule}`,
        borderRadius: 12,
        padding: '12px 14px',
        background: skipped ? T.ruleSoft : row.saved ? T.sageDim : T.paper,
        opacity: skipped ? 0.6 : 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 13, color: T.ink, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {row.saved && '✓ '}
            {row.raw.item_name}
          </div>
          {caseCaption && <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.ink3 }}>{caseCaption}</div>}
        </div>
        <select value={selectValue} onChange={(e) => onDecision(e.target.value)} style={{ ...inputSm, width: 'auto', flex: '1 1 200px', cursor: 'pointer' }}>
          {row.candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({Math.round(c.score * 100)}%)
            </option>
          ))}
          <option value="__create__">{ss.createNew}</option>
          <option value="__skip__">{ss.skipLine}</option>
        </select>
      </div>

      {row.ambiguous && row.decision === 'match' && (
        <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.caramel }}>{ss.twoCloseMatches}</div>
      )}
      {row.error && <div style={{ fontFamily: fonts.sans, fontSize: 11.5, color: T.warm }}>{row.error}</div>}

      {!skipped && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: '0 0 92px' }}>
            <span style={miniLabel}>{ss.qtyReceived}</span>
            <input value={row.qtyInput} inputMode="decimal" onChange={(e) => onQty(e.target.value)} style={inputSm} />
          </label>
          <label style={{ flex: '0 0 100px' }}>
            <span style={miniLabel}>{ss.unitCost}</span>
            <input value={row.unitCostInput} inputMode="decimal" placeholder="—" onChange={(e) => onUnitCost(e.target.value)} style={inputSm} />
          </label>

          {row.decision === 'match' && (
            <label style={{ flex: '1 1 160px' }}>
              <span style={miniLabel}>
                {ss.onHand(onHand)}{staleEstimate ? ss.checkSuffix : ''}
              </span>
              <input
                value={row.afterInput}
                inputMode="decimal"
                onChange={(e) => onAfter(e.target.value)}
                style={{ ...inputSm, borderColor: staleEstimate ? `${T.warm}66` : T.rule }}
              />
            </label>
          )}

          {row.decision === 'create' && (
            <>
              <label style={{ flex: '0 0 150px' }}>
                <span style={miniLabel}>{ss.newItemCategory}</span>
                <select value={row.newCategory} onChange={(e) => onNewCategory(e.target.value as InvCat)} style={{ ...inputSm, cursor: 'pointer' }}>
                  {(['housekeeping', 'maintenance', 'breakfast'] as InvCat[]).map((c) => (
                    <option key={c} value={c}>
                      {catLabelFor(lang, c)}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: '0 0 90px' }}>
                <span style={miniLabel}>{ss.unit}</span>
                <input value={row.newUnit} onChange={(e) => onNewUnit(e.target.value)} style={inputSm} />
              </label>
              <label style={{ flex: '0 0 80px' }}>
                <span style={miniLabel}>{ss.par}</span>
                <input value={row.newPar} inputMode="decimal" onChange={(e) => onNewPar(e.target.value)} style={inputSm} />
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const miniLabel: React.CSSProperties = {
  display: 'block',
  fontFamily: fonts.mono,
  fontSize: 9.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: T.ink3,
  marginBottom: 4,
  fontWeight: 600,
};
