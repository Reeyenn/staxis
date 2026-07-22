'use client';

/* ───────────────────────────────────────────────────────────────────────
   Admin Studio — shared surface primitives.

   Small dark-surface building blocks that several Studio surfaces had each
   copy-pasted as inline style blocks. Each renders the exact chrome the
   surfaces used, so a call site swaps its literal <div>/<button> for one of
   these with no visual change. Per-site variation rides on `style`.

   Colors come from surface-kit's `dimWhite` so these match every dark
   surface's translucent-white system.
   ─────────────────────────────────────────────────────────────────────── */

import React from 'react';
import { FONT_MONO } from './kit';
import { dimWhite } from './surface-kit';

/** Full-width, left-aligned list row rendered as a button on the dark
 *  surface — the standard clickable card in the Onboarding bay lists. */
export function RowButton({
  children, onClick, style,
}: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void; style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9,
        background: dimWhite(.05), border: `1px solid ${dimWhite(.12)}`, borderRadius: 10,
        padding: '9px 12px', cursor: 'pointer', color: '#fff', width: '100%', ...style,
      }}
    >{children}</button>
  );
}

/** A flex list item separated from the next by a hairline rule — the shared
 *  row chrome for the ML cockpit's overrides / anomalies tables. */
export function DividerRow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${dimWhite(.08)}`, ...style }}>
      {children}
    </div>
  );
}

/** A mono micro-label in translucent white — the recurring small caption the
 *  mapper stamps under rows/values. `size`/`o` carry each site's original
 *  font-size and opacity so the inline style is byte-for-byte unchanged. */
export function MonoDim({ children, size = 10.5, o = .5, style }: { children: React.ReactNode; size?: number; o?: number; style?: React.CSSProperties }) {
  return <span style={{ fontFamily: FONT_MONO, fontSize: size, color: dimWhite(o), ...style }}>{children}</span>;
}
