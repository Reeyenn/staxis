'use client';

import React from 'react';
import { T, fonts, statusText, catGlyph } from './tokens';
import { Thumb } from './ItemThumb';
import { StockBar } from './StockBar';
import { Serif } from './Serif';
import { fmtInt } from './format';
import type { DisplayItem } from './types';
import { t, type Lang } from './inv-i18n';

interface BoardCardProps {
  lang: Lang;
  it: DisplayItem;
  /** Open the item's edit sheet — the SAME pop-up a Ledger row opens. */
  onEdit?: (item: DisplayItem) => void;
}

// Honesty rule: a burn rate from the par/60 fallback (or no data at all) is not
// a forecast, so render the days-left as an em-dash — only ml / rule-occupancy
// items show a real number. Mirrors ItemRow's behaviour + selectBurnRate.
function daysLeftLabel(it: DisplayItem, lang: Lang): string {
  if (it.uncounted) return '—';
  if (it.burnSource === 'fallback-60d' || it.burnSource === 'no-data') return '—';
  const tx = t(lang);
  if (it.daysLeft >= 90) return tx.daysLeft90;
  return `${it.daysLeft}${tx.daysLeft}`;
}

// A card on the Triage board. Clicking it opens the item's edit sheet — the
// exact same pop-up a Ledger row click opens (no flip animation). The outer
// wrapper keeps `data-flip-id` so useFlipList in StockList still glides the
// card between columns when a recount moves it; the inner card keeps the hover
// paper-lift (.inv-card).
export function BoardCard({ lang, it, onEdit }: BoardCardProps) {
  const uncounted = it.uncounted;
  const c = uncounted ? T.dim : statusText[it.status];
  const open = () => onEdit?.(it);

  return (
    <div data-flip-id={it.id}>
      <div
        className="inv-card"
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        }}
        style={{
          background: T.bg,
          border: `1px solid ${T.rule}`,
          borderRadius: 14,
          padding: 12,
          minHeight: 96,
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
          <Thumb name={it.name} cat={it.cat} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: fonts.sans, fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 }}>
              {it.name}
            </div>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 9,
                color: T.dim,
                marginTop: 2,
                letterSpacing: '0.03em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {catGlyph[it.cat]} · {it.vendor || '—'}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <StockBar
            current={it.estimated}
            par={it.par}
            status={it.status}
            height={6}
            neutral={uncounted}
            shimmer={!uncounted && it.status === 'critical'}
          />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            marginTop: 8,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
            <Serif size={21} color={c}>{uncounted ? '—' : fmtInt(it.estimated)}</Serif>
            <span style={{ fontFamily: fonts.sans, fontSize: 10.5, color: T.dim }}>
              / {it.par} {it.unit}
            </span>
          </span>
          <span style={{ fontFamily: fonts.sans, fontSize: 11.5, color: c, fontWeight: 600 }}>
            {daysLeftLabel(it, lang)}
          </span>
        </div>
      </div>
    </div>
  );
}
