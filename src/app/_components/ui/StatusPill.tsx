'use client';

// Shared StatusPill / StatusDot — theme-parameterized promotion of the
// inventory tab's originals (src/app/inventory/_components/StatusPill.tsx,
// which stay untouched). Instead of reading the Triage palette from
// inventory tokens, these take color / tint / label / font as props so each
// area keeps its exact current look when it migrates.

import React from 'react';

export function StatusDot({
  color,
  size = 8,
  ring = false,
  style,
}: {
  /** Solid status color (e.g. the area's forest/gold/terra). */
  color: string;
  size?: number;
  /** Soft halo ring in the same color (matches inventory's `${c}22`). */
  ring?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        boxShadow: ring ? `0 0 0 3px ${color}22` : 'none',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

// Mono uppercase status pill. `filled` paints it solid in the status color
// (white text); otherwise a soft tint with a leading dot.
export function StatusPill({
  label,
  color,
  tint,
  filled = false,
  fontFamily,
  style,
}: {
  /** Already-translated label text (callers own i18n, e.g. statusLabelFor). */
  label: React.ReactNode;
  /** Solid status color. */
  color: string;
  /**
   * Soft tint background for the unfilled variant. Pass the area's exact
   * tint token (e.g. inventory's statusTint) to keep looks byte-identical;
   * defaults to a hex-alpha wash of `color`.
   */
  tint?: string;
  filled?: boolean;
  /** The area's mono font stack (e.g. inventory's fonts.mono). */
  fontFamily?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px 2px 7px',
        borderRadius: 999,
        background: filled ? color : (tint ?? `${color}1F`),
        color: filled ? '#fff' : color,
        border: filled ? 'none' : `1px solid ${color}33`,
        fontFamily,
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {!filled && <StatusDot color={color} size={6} />}
      {label}
    </span>
  );
}
