'use client';

// Shared EmptyState — generalization of financials' Notice
// (src/app/financials/_components/fin-ui.tsx, which stays untouched).
// Adds optional icon / title / body / retry button / whole-area onClick
// (Notice's invisible click-anywhere-to-retry); every color comes in via
// props so each area keeps its exact current look.

import React from 'react';

export function EmptyState({
  icon,
  title,
  body,
  retry,
  onClick,
  color,
  titleColor,
  fontFamily,
  padding = '40px 20px',
  style,
}: {
  /** Optional glyph/illustration node rendered above the text. */
  icon?: React.ReactNode;
  /** Optional heading line. */
  title?: React.ReactNode;
  /** Body text (the original Notice's `text`). */
  body?: React.ReactNode;
  /**
   * Optional retry button. Label is required (callers own i18n — no baked-in
   * English). Colors default to the surrounding text color + a hairline
   * border; pass the area's exact tokens to restyle.
   */
  retry?: {
    label: React.ReactNode;
    onClick: () => void;
    color?: string;
    border?: string;
    background?: string;
  };
  /**
   * Whole-area click — financials' Notice makes the entire text area
   * clickable to retry (no visible button, cursor pointer). Pass this for
   * a look/behavior-identical migration of that pattern; use `retry` when
   * the area wants an explicit button instead.
   */
  onClick?: () => void;
  /** Body/base text color (e.g. financials' T.ink2). */
  color?: string;
  /** Title color — defaults to `color`. */
  titleColor?: string;
  /** The area's sans font stack (e.g. financials' FONT_SANS). */
  fontFamily?: string;
  padding?: string | number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding,
        textAlign: 'center',
        fontFamily,
        fontSize: 14,
        color,
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
    >
      {icon != null && (
        <div style={{ marginBottom: 10, lineHeight: 1 }}>{icon}</div>
      )}
      {title != null && (
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: titleColor ?? color,
            marginBottom: body != null ? 4 : 0,
          }}
        >
          {title}
        </div>
      )}
      {body != null && <div>{body}</div>}
      {retry && (
        <button
          type="button"
          onClick={retry.onClick}
          style={{
            marginTop: 14,
            padding: '6px 16px',
            borderRadius: 999,
            border: retry.border ?? `1px solid ${retry.color ?? color ?? 'currentColor'}33`,
            background: retry.background ?? 'transparent',
            color: retry.color ?? color,
            fontFamily,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {retry.label}
        </button>
      )}
    </div>
  );
}
