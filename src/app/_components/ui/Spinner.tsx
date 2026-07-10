'use client';

// Shared Spinner primitive (F8): <Spinner/> + <PageLoader/>.
//
// Replaces the per-page `<style>{'@keyframes spin …'}</style>` copies
// (settings/pms, laundry, property-selector, admin/*) — the @keyframes is
// declared ONCE, injected into <head> id-guarded on first mount. Size,
// color, and track are props with neutral defaults ('currentColor' arc) so
// every area keeps its exact current look. No palette constants here.

import React, { useEffect } from 'react';
import {
  SPIN_KEYFRAMES_CSS,
  SPIN_KEYFRAMES_ID,
  spinnerStyle,
  type SpinnerStyleOptions,
} from './spinner-core';

// Inject the single @keyframes rule into <head>, once per document. Never
// removed on unmount — it's one tiny rule shared by every spinner instance.
function useSpinKeyframes(): void {
  useEffect(() => {
    if (document.getElementById(SPIN_KEYFRAMES_ID)) return;
    const style = document.createElement('style');
    style.id = SPIN_KEYFRAMES_ID;
    style.textContent = SPIN_KEYFRAMES_CSS;
    document.head.appendChild(style);
  }, []);
}

export interface SpinnerProps extends SpinnerStyleOptions {
  /** Accessible label. Omitted (default) = decorative, hidden from SRs. */
  label?: string;
  style?: React.CSSProperties;
}

export function Spinner({ label, style, ...opts }: SpinnerProps): React.ReactElement {
  useSpinKeyframes();
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ ...spinnerStyle(opts), ...style }}
    />
  );
}

export interface PageLoaderProps extends SpinnerStyleOptions {
  /** Text under the spinner (e.g. 'Loading rooms…'). */
  label?: React.ReactNode;
  /** Vertical space the loader centers within. Default '40vh'. */
  minHeight?: number | string;
  labelColor?: string;
  fontFamily?: string;
  fontSize?: number | string;
  style?: React.CSSProperties;
}

export function PageLoader({
  label,
  minHeight = '40vh',
  labelColor,
  fontFamily,
  fontSize = 14,
  style,
  ...opts
}: PageLoaderProps): React.ReactElement {
  return (
    <div
      role="status"
      style={{
        minHeight,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        ...style,
      }}
    >
      <Spinner size={opts.size ?? 28} {...opts} />
      {label != null && (
        <span
          style={{
            color: labelColor ?? 'inherit',
            fontFamily: fontFamily ?? 'inherit',
            fontSize,
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
