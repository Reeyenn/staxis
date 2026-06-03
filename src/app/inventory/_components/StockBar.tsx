'use client';

import React from 'react';
import { statusColor, T, type StockStatus } from './tokens';

// Stock-vs-par bar (Triage). Fill = min(1, current/par) in the status color
// over a soft track; a 1.5px ink "par" tick marks where par sits once the item
// is OVER par (so the fill staying pinned at 100% still reads as "above par").
export function StockBar({
  current,
  par,
  status,
  width = '100%',
  height = 6,
  showPar = true,
  track = T.ruleSoft,
}: {
  current: number;
  par: number;
  status: StockStatus;
  width?: number | string;
  height?: number;
  showPar?: boolean;
  track?: string;
}) {
  const c = statusColor[status];
  const pct = par > 0 ? Math.min(1.15, current / par) : 0;
  const over = pct > 1;
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
          style={{
            display: 'block',
            height: '100%',
            width: `${Math.min(1, pct) * 100}%`,
            background: c,
            borderRadius: height,
          }}
        />
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
