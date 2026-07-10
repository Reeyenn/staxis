'use client';

import React from 'react';
import { fonts, statusColor, statusText, statusTint, type StockStatus } from './tokens';
import { statusLabelFor, type Lang } from './inv-i18n';

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

// Mono uppercase status pill (Triage). `filled` paints it solid in the status
// color (white text); otherwise a soft tint with a leading dot.
export function StatusPill({
  s,
  filled = false,
  style,
  lang = 'en',
}: {
  s: StockStatus;
  filled?: boolean;
  style?: React.CSSProperties;
  lang?: Lang;
}) {
  const c = statusColor[s];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px 2px 7px',
        borderRadius: 999,
        background: filled ? c : statusTint[s],
        color: filled ? '#fff' : statusText[s],
        border: filled ? 'none' : `1px solid ${c}33`,
        fontFamily: fonts.mono,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {!filled && <StatusDot s={s} size={6} />}
      {statusLabelFor(lang, s)}
    </span>
  );
}
