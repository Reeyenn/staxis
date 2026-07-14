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
  onNewCategory: (c: InvCat) => void;
  onNewUnit: (v: string) => void;
  onNewPar: (v: string) => void;
}) {
  const ss = ssStrings(lang);
  const skipped = row.decision === 'skip';
  const matched = row.decision === 'match';
  const creating = row.decision === 'create';
  const selectValue = creating ? '__create__' : skipped ? '__skip__' : row.matchedItemId ?? '__create__';
  // Loud if we'd re-baseline to roughly just the received qty even though the
  // item has stored stock — usually a stale usage rate, worth a second look.
  const staleEstimate = matched && onHand === 0 && matchedCounted > 0;
  const caseCaption =
    row.raw.quantity_cases && row.raw.pack_size ? ss.cases(row.raw.quantity_cases, row.raw.pack_size) : null;
  // Drop the "(100%)" noise from confident matches; keep the score only when
  // it's worth a second look.
  const optLabel = (name: string, score: number) => (score >= 0.995 ? name : `${name} (${Math.round(score * 100)}%)`);

  const qtyField = (
    <label style={{ flex: 'none' }}>
      <span style={miniLabel}>{ss.qtyReceived}</span>
      <input
        value={row.qtyInput}
        inputMode="decimal"
        onChange={(e) => onQty(e.target.value)}
        style={{ ...inputSm, width: 58, textAlign: 'center' }}
        aria-label={ss.qtyReceived}
      />
    </label>
  );
  const costField = (
    <label style={{ flex: 'none' }}>
      <span style={miniLabel}>{ss.unitCost}</span>
      <input
        value={row.unitCostInput}
        inputMode="decimal"
        placeholder="—"
        onChange={(e) => onUnitCost(e.target.value)}
        style={{ ...inputSm, width: 68, textAlign: 'center' }}
        aria-label={ss.unitCost}
      />
    </label>
  );

  return (
    <div
      style={{
        borderBottom: `1px solid ${T.ruleFaint}`,
        padding: '9px 2px',
        background: row.saved ? T.sageDim : undefined,
        opacity: skipped ? 0.5 : 1,
      }}
    >
      {/* One tight line: what it is (dropdown) · how many · what it becomes. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <select
            value={selectValue}
            onChange={(e) => onDecision(e.target.value)}
            style={{ ...inputSm, width: '100%', cursor: 'pointer' }}
          >
            {row.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {optLabel(c.name, c.score)}
              </option>
            ))}
            <option value="__create__">{ss.createNew}</option>
            <option value="__skip__">{ss.skipLine}</option>
          </select>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: 10.5,
              color: T.faint,
              marginTop: 4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {row.saved && '✓ '}
            {row.raw.item_name}
            {caseCaption ? ` · ${caseCaption}` : ''}
          </div>
        </div>

        {matched && (
          <>
            {qtyField}
            {costField}
            <div style={{ flex: 'none', textAlign: 'right' }}>
              <span style={miniLabel}>{staleEstimate ? `→${ss.checkSuffix}` : '→'}</span>
              <div
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 16,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  color: staleEstimate ? T.warm : T.ink,
                  lineHeight: 1.3,
                }}
              >
                {row.afterInput}
              </div>
            </div>
          </>
        )}
      </div>

      {row.ambiguous && matched && (
        <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.caramel, marginTop: 6 }}>{ss.twoCloseMatches}</div>
      )}
      {row.error && (
        <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.warm, marginTop: 6 }}>{row.error}</div>
      )}

      {/* New item: the extra fields only this path needs, kept on one wrapped line. */}
      {creating && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
          {qtyField}
          {costField}
          <label style={{ flex: '0 0 140px' }}>
            <span style={miniLabel}>{ss.newItemCategory}</span>
            <select
              value={row.newCategory}
              onChange={(e) => onNewCategory(e.target.value as InvCat)}
              style={{ ...inputSm, cursor: 'pointer' }}
            >
              {(['housekeeping', 'maintenance', 'breakfast'] as InvCat[]).map((c) => (
                <option key={c} value={c}>
                  {catLabelFor(lang, c)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: '0 0 84px' }}>
            <span style={miniLabel}>{ss.unit}</span>
            <input value={row.newUnit} onChange={(e) => onNewUnit(e.target.value)} style={inputSm} />
          </label>
          <label style={{ flex: '0 0 70px' }}>
            <span style={miniLabel}>{ss.par}</span>
            <input value={row.newPar} inputMode="decimal" onChange={(e) => onNewPar(e.target.value)} style={inputSm} />
          </label>
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
