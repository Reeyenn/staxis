'use client';

import React from 'react';
import { statusColor, T, type StockStatus } from './tokens';

// Thin progress track with a par-line marker at 60% of the bar width.
// Going above par stretches the fill toward the right end (max ~167% of par).
export function StockBar({
  current,
  par,
  status,
  width = '100%',
  height = 6,
  showPar = true,
}: {
  current: number;
  par: number;
  status: StockStatus;
  width?: number | string;
  height?: number;
  showPar?: boolean;
}) {
  const c = statusColor[status];
  const parPos = 0.6;
  const max = Math.max(par / parPos, 1);
  const pct = Math.max(0.02, Math.min(current / max, 1));
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width,
        height,
        borderRadius: height,
        background: T.rule,
        overflow: 'visible',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${pct * 100}%`,
          background: c,
          borderRadius: height,
        }}
      />
      {showPar && (
        <span
          title="par level"
          style={{
            position: 'absolute',
            left: `${parPos * 100}%`,
            top: -3,
            bottom: -3,
            width: 1.5,
            background: T.ink,
            opacity: 0.55,
          }}
        />
      )}
    </span>
  );
}
