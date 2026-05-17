'use client';

import React from 'react';
import { fonts, statusColor, statusLabel, type StockStatus } from './tokens';

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

export function StatusPill({
  s,
  style,
}: {
  s: StockStatus;
  style?: React.CSSProperties;
}) {
  const c = statusColor[s];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px 3px 8px',
        borderRadius: 999,
        height: 22,
        background: `${c}14`,
        color: c,
        border: `1px solid ${c}33`,
        fontFamily: fonts.sans,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      <StatusDot s={s} size={6} />
      {statusLabel[s]}
    </span>
  );
}
