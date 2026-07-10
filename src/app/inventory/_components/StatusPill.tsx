'use client';

import React from 'react';
import { statusColor, type StockStatus } from './tokens';

export function StatusDot({
  s,
  size = 8,
  ring = false,
  style,
}: {
  s: StockStatus;
  size?: number;
  ring?: boolean;
  style?: React.CSSProperties;
}) {
  const c = statusColor[s];
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: c,
        boxShadow: ring ? `0 0 0 3px ${c}22` : 'none',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
