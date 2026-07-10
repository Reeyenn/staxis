'use client';

import React, { useRef, useState } from 'react';
import { T, fonts, statusText, catGlyph } from './tokens';
import { Thumb } from './ItemThumb';
import { StockBar } from './StockBar';
import { Serif } from './Serif';
import { Motion } from './motion';
import { fmtMoney, fmtInt } from './format';
import type { DisplayItem } from './types';
import { t, type Lang } from './inv-i18n';

interface BoardCardProps {
  lang: Lang;
  it: DisplayItem;
  /** Open the Add/Edit sheet for this item. */
  onEdit?: (item: DisplayItem) => void;
  /** Open the Count overlay. */
  onCount?: () => void;
  /** Open the Reorder overlay. */
  onReorder?: () => void;
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

// The flip unit on the Triage board. Front = at-a-glance stock; tapping the
// card flips it (physical Y-axis turn) to a back face with row actions.
// The outer wrapper carries `data-flip-id` so useFlipList in StockList can
// glide the card between positions/columns; the inner card gets the hover
// paper-lift (.inv-card) so lift and FLIP transforms never fight.
export function BoardCard({ lang, it, onEdit, onCount, onReorder }: BoardCardProps) {
  const tx = t(lang);
  const [flipped, setFlipped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const uncounted = it.uncounted;
  const c = uncounted ? T.dim : statusText[it.status];
  const flip = () =>
    Motion.flip(ref.current, () => setFlipped((f) => !f), { axis: 'y', d1: 145, d2: 215 });

  return (
    <div data-flip-id={it.id} style={{ perspective: 800 }}>
      <div
        ref={ref}
        className="inv-card"
        style={{
          background: T.bg,
          border: `1px solid ${T.rule}`,
          borderRadius: 14,
          padding: 12,
          transformStyle: 'preserve-3d',
          minHeight: 96,
        }}
      >
        {!flipped ? (
          <div onClick={flip} style={{ cursor: 'pointer' }}>
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
              <span
                className="inv-flip-hint"
                style={{ fontFamily: fonts.mono, fontSize: 11, color: T.dim }}
                aria-hidden
              >
                ↻
              </span>
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
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 96 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontFamily: fonts.sans,
                  fontSize: 12.5,
                  fontWeight: 600,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {it.name}
              </span>
              <button
                type="button"
                onClick={flip}
                aria-label={tx.flipBack}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: T.dim,
                  fontFamily: fonts.mono,
                  fontSize: 13,
                  flex: 'none',
                }}
              >
                ↺
              </button>
            </div>
            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 9.5,
                color: T.dim,
                lineHeight: 1.6,
                letterSpacing: '0.02em',
              }}
            >
              {tx.value} {fmtMoney(it.value)} · {tx.lead} {it.leadDays}d{it.graduated ? ` · ${tx.aiTracked}` : ''}
            </div>
            <div style={{ marginTop: 'auto', display: 'flex', gap: 6 }}>
              <CardAct label={tx.count} onClick={() => onCount?.()} />
              <CardAct
                label={tx.reorder}
                tone={!uncounted && it.status === 'critical' ? 'terra' : undefined}
                onClick={() => onReorder?.()}
              />
              <CardAct label={tx.edit} onClick={() => onEdit?.(it)} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CardAct({
  label,
  onClick,
  tone,
}: {
  label: string;
  onClick: () => void;
  tone?: 'terra';
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => { Motion.pop(ref.current, 0.94); onClick(); }}
      style={{
        flex: 1,
        padding: '7px 4px',
        borderRadius: 999,
        cursor: 'pointer',
        background: tone === 'terra' ? T.terra : T.inkWash,
        color: tone === 'terra' ? '#fff' : T.ink,
        border: 'none',
        fontFamily: fonts.sans,
        fontSize: 11.5,
        fontWeight: 600,
      }}
    >
      {label}
    </button>
  );
}
