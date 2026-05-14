'use client';

// ─── Floating cursor + target highlight ──────────────────────────────────
// Pure presentational. Owns no state of its own — the overlay tells it
// where to be and whether to pulse. Two visuals:
//
//   Desktop (mouse): an SVG arrow that flies on a CSS-transitioned path
//     to the target's bounding box. When `pulsing` is true the arrow
//     scales gently to draw the eye.
//
//   Touch: no flying cursor. Instead the WalkthroughOverlay renders a
//     <TargetHighlight /> outline on the target element directly. We
//     handle both presentations here so the overlay can render one
//     conditionally.
//
// Both sit at z-index 9998 — below modals (9999+) but above everything
// else. pointer-events: none — the user clicks through the cursor.

import type { CSSProperties } from 'react';

export interface CursorProps {
  /** Viewport-pixel position (cursor TIP, not bounding-box origin). */
  x: number;
  y: number;
  visible: boolean;
  pulsing: boolean;
}

export function Cursor({ x, y, visible, pulsing }: CursorProps) {
  if (!visible) return null;
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        // Round to whole pixels so the cursor doesn't sub-pixel jitter mid-flight.
        transform: `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`,
        transition: 'transform 700ms cubic-bezier(0.4, 0.0, 0.2, 1)',
        pointerEvents: 'none',
        zIndex: 9998,
        willChange: 'transform',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: 36,
          height: 36,
          // Anchor the SVG tip to (0,0) of the wrapper so the (x,y) prop
          // means "where the cursor is pointing", not the top-left of the box.
          transform: 'translate(-4px, -2px)',
          animation: pulsing
            ? 'staxis-cursor-pulse 1100ms cubic-bezier(0.4, 0, 0.6, 1) infinite'
            : 'none',
        }}
      >
        <svg
          width="36"
          height="36"
          viewBox="0 0 36 36"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{
            filter: 'drop-shadow(0 4px 10px rgba(31, 35, 28, 0.25)) drop-shadow(0 1px 3px rgba(31, 35, 28, 0.15))',
          }}
        >
          {/* Classic arrow shape filled with Snow caramel. */}
          <path
            d="M5 3 L5 27 L11.5 21 L15.5 30 L19 28.5 L15 19.5 L24 19.5 Z"
            fill="var(--snow-caramel, #C99644)"
            stroke="var(--snow-ink, #1F231C)"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}

// ─── Target highlight ────────────────────────────────────────────────────
// Wraps a soft outline around the element the cursor is pointing at, so the
// user sees what to click. On touch screens this REPLACES the cursor.

export interface TargetHighlightProps {
  rect: { x: number; y: number; width: number; height: number } | null;
  visible: boolean;
}

export function TargetHighlight({ rect, visible }: TargetHighlightProps) {
  if (!visible || !rect) return null;
  const pad = 6;
  const style: CSSProperties = {
    position: 'fixed',
    top: Math.round(rect.y - pad),
    left: Math.round(rect.x - pad),
    width: Math.round(rect.width + pad * 2),
    height: Math.round(rect.height + pad * 2),
    borderRadius: 10,
    boxShadow:
      '0 0 0 2px var(--snow-caramel, #C99644), 0 0 0 6px rgba(201, 150, 68, 0.20)',
    pointerEvents: 'none',
    zIndex: 9997,
    transition: 'top 700ms cubic-bezier(0.4, 0.0, 0.2, 1), left 700ms cubic-bezier(0.4, 0.0, 0.2, 1), width 300ms ease, height 300ms ease',
    animation: 'staxis-target-pulse 1400ms ease-in-out infinite',
  };
  return <div aria-hidden style={style} />;
}
