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

const CAT_ORDER: InvCat[] = ['housekeeping', 'maintenance', 'breakfast'];

// Receipt-style line: the item name IS the control (a borderless select —
// tap it to fix a wrong match or make it a new item), a quantity box, and ✕
// to drop the line. Unit cost isn't shown — the scanned cost still saves with
// the delivery, it just isn't a decision the manager makes on this screen.
//
// The ⇄ button beside the quantity box opens the WHOLE catalog (grouped by
// category) — the rescue for when the invoice's wording is nothing like the
// inventory name and the matcher's shortlist missed it entirely.
export function ReviewRowView({
  lang,
  row,
  display,
  onDecision,
  onQty,
  onNewCategory,
  onSkip,
  onUnskip,
}: {
  lang: Lang;
  row: ReviewRow;
  display: DisplayItem[];
  onDecision: (v: string) => void;
  onQty: (v: string) => void;
  onNewCategory: (c: InvCat) => void;
  onSkip: () => void;
  onUnskip: () => void;
}) {
  const ss = ssStrings(lang);
  const creating = row.decision === 'create';
  const skipped = row.decision === 'skip';
  const selectValue = creating ? '__create__' : row.matchedItemId ?? '__create__';
  const chosen = creating ? null : row.candidates.find((c) => c.id === row.matchedItemId);
  const norm = (s: string) => s.trim().toLowerCase();
  // Echo the invoice's own wording only when it differs from the matched item
  // (that's when the manager needs it to judge the match) or when the case
  // math explains the quantity.
  const rawEcho = chosen && norm(chosen.name) !== norm(row.raw.item_name) ? row.raw.item_name : null;
  const caseCaption =
    row.raw.quantity_cases && row.raw.pack_size ? ss.cases(row.raw.quantity_cases, row.raw.pack_size) : null;
  const caption = [rawEcho, caseCaption].filter(Boolean).join(' · ');

  if (skipped) {
    return (
      <div style={{ ...lineShell, display: 'flex', alignItems: 'center', gap: 10 }}>
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
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', maxWidth: '100%' }}>
            {row.saved && <span style={{ color: T.forestText, marginRight: 5, fontSize: 13 }}>✓</span>}
            {/* The name is the control. A select sizes itself to its LONGEST
                option, so any positioned chevron drifts away from the visible
                text — a dotted underline is the tap affordance instead. */}
            <select
              value={selectValue}
              onChange={(e) => onDecision(e.target.value)}
              style={{
                appearance: 'none',
                WebkitAppearance: 'none',
                border: 'none',
                background: 'transparent',
                fontFamily: fonts.sans,
                fontSize: 15,
                fontWeight: 600,
                color: row.ambiguous && !creating ? T.caramel : T.ink,
                textDecoration: 'underline',
                textDecorationStyle: 'dotted',
                textDecorationColor: row.ambiguous && !creating ? T.caramel : T.faint,
                textUnderlineOffset: 4,
                padding: 0,
                margin: 0,
                cursor: 'pointer',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {row.candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="__create__">{ss.newItemOpt(row.raw.item_name)}</option>
            </select>
          </span>
          {caption && <div style={captionStyle}>{caption}</div>}
          {row.ambiguous && !creating && (
            <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.caramel, marginTop: 3 }}>{ss.twoCloseMatches}</div>
          )}
          {row.error && (
            <div style={{ fontFamily: fonts.sans, fontSize: 11, color: T.warm, marginTop: 3 }}>{row.error}</div>
          )}
          {creating && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 9.5,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: T.ink3,
                  fontWeight: 600,
                }}
              >
                {ss.goesIn}
              </span>
              <select
                value={row.newCategory}
                onChange={(e) => onNewCategory(e.target.value as InvCat)}
                style={{
                  appearance: 'none',
                  WebkitAppearance: 'none',
                  border: 'none',
                  background: 'transparent',
                  fontFamily: fonts.sans,
                  fontSize: 12,
                  fontWeight: 500,
                  color: T.ink2,
                  textDecoration: 'underline',
                  textDecorationStyle: 'dotted',
                  textDecorationColor: T.faint,
                  textUnderlineOffset: 3,
                  padding: 0,
                  cursor: 'pointer',
                }}
              >
                {(['housekeeping', 'maintenance', 'breakfast'] as InvCat[]).map((c) => (
                  <option key={c} value={c}>
                    {catLabelFor(lang, c)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {display.length > 0 && (
          <span title={ss.pickDifferent} style={pickerShell}>
            <span aria-hidden style={{ fontSize: 12, color: T.ink3, lineHeight: 1 }}>⇄</span>
            {/* Invisible select stretched over the icon — tapping the button
                opens the native full-catalog picker. value stays '' so it acts
                as a menu, never a display. */}
            <select
              value=""
              onChange={(e) => { if (e.target.value) onDecision(e.target.value); }}
              aria-label={ss.pickDifferent}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
            >
              <option value="" disabled>
                {ss.pickDifferent}
              </option>
              {CAT_ORDER.filter((c) => display.some((d) => d.cat === c)).map((cat) => (
                <optgroup key={cat} label={catLabelFor(lang, cat)}>
                  {display
                    .filter((d) => d.cat === cat)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </span>
        )}
        <input
          value={row.qtyInput}
          inputMode="decimal"
          onChange={(e) => onQty(e.target.value)}
          aria-label={ss.qtyReceived}
          style={{ ...inputSm, width: 58, textAlign: 'center', flex: 'none' }}
        />
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

const captionStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 10.5,
  color: T.faint,
  marginTop: 3,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const pickerShell: React.CSSProperties = {
  position: 'relative',
  flex: 'none',
  width: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: `1px solid ${T.rule}`,
  borderRadius: 6,
  background: 'transparent',
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
