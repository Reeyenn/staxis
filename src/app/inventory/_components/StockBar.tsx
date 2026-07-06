'use client';

import React, { useEffect, useRef } from 'react';
import { statusColor, T, type StockStatus } from './tokens';
import { EASE } from './motion';

// Stock-vs-par bar (Triage). Fill = min(1, current/par) in the status color
// over a soft track; a 1.5px ink "par" tick marks where par sits once the item
// is OVER par (so the fill staying pinned at 100% still reads as "above par").
//
// The fill inks itself in: on mount it sweeps from empty to its level, and on
// any later change (a recount, an order received) it glides from the previous
// level. WAAPI so it plays under reduced motion, like all functional movement
// on this tab. Critical bars additionally carry a slow shimmer (decorative,
// CSS-gated) so the most urgent items catch the eye without shouting.
export function StockBar({
  current,
  par,
  status,
  width = '100%',
  height = 6,
  showPar = true,
  track = T.ruleSoft,
  neutral = false,
  shimmer = false,
}: {
  current: number;
  par: number;
  status: StockStatus;
  width?: number | string;
  height?: number;
  showPar?: boolean;
  track?: string;
  /** Never-counted item: render an empty grey track (no status color, no par
   *  tick) so a brand-new item reads as "unknown", not red "critical". */
  neutral?: boolean;
  /** Slow highlight sweep across the fill — used on critical board cards. */
  shimmer?: boolean;
}) {
  const c = neutral ? T.dim : statusColor[status];
  const pct = neutral ? 0 : (par > 0 ? Math.min(1.15, current / par) : 0);
  const over = pct > 1;
  const fillPct = Math.min(1, pct);

  const fillRef = useRef<HTMLSpanElement>(null);
  const prevPct = useRef(0);
  useEffect(() => {
    const el = fillRef.current;
    if (!el) return;
    const from = prevPct.current;
    if (from !== fillPct) {
      el.animate(
        [{ width: `${from * 100}%` }, { width: `${fillPct * 100}%` }],
        { duration: 850, easing: EASE.settle, fill: 'none' },
      );
    }
    prevPct.current = fillPct;
  }, [fillPct]);

  return (
    <span
      style={{
        position: 'relative',
        display: 'block',
        width,
        height,
        borderRadius: height,
        background: track,
        overflow: 'visible',
      }}
    >
      <span style={{ position: 'absolute', inset: 0, borderRadius: height, overflow: 'hidden' }}>
        <span
          ref={fillRef}
          style={{
            display: 'block',
            height: '100%',
            width: `${fillPct * 100}%`,
            background: c,
            borderRadius: height,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {shimmer && !neutral && <span className="inv-shimmer" />}
        </span>
      </span>
      {showPar && (
        <span
          title="par level"
          style={{
            position: 'absolute',
            left: `${Math.min(100, (1 / Math.max(pct, 1)) * 100)}%`,
            top: -2,
            bottom: -2,
            width: 1.5,
            background: over ? T.ink : 'transparent',
          }}
        />
      )}
    </span>
  );
}
