'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The cursor, rebuilt on the anchor vocabulary.
//
// ─── WHAT CHANGED FROM THE ONE THIS REPLACES ───────────────────────────────
//
// The old cursor (src/components/walkthrough/Cursor.tsx) was handed a rect
// that a model had chosen, from a list of every clickable thing on the screen,
// by matching an accessible name against a synthetic id that was re-derived on
// every snapshot. The component itself was fine. Everything upstream of it was
// a guess, and the documented escape hatch for a control with no readable name
// was never built.
//
// This one takes an ANCHOR KEY. It resolves it through the same
// `anchorSelector` the chat pointer and the discovery pointer use, which is an
// exact attribute match against a registry a person wrote. There is no branch
// that accepts a selector, a coordinate, a description or a name. A key that
// resolves to nothing draws nothing and says so to its caller, rather than
// flying to the closest thing with a similar label.
//
// ─── AND IT STILL NEVER PRESSES ANYTHING ───────────────────────────────────
//
// Charter clause 1, kept exactly as the old overlay kept it: the cursor is a
// picture. It has `pointer-events: none`, it dispatches nothing, and there is
// no code path in this file that calls `.click()`. The tour points; the person
// acts.
//
// ─── THE MOVEMENT ──────────────────────────────────────────────────────────
//
// One transform transition, and it deliberately does NOT try to track a
// scrolling page: the pointer next door learned that lesson the expensive way
// (see PointerPopup's scroll effect). The cursor parks at the control's left
// edge rather than its centre, because centre anchoring covers the label on a
// wide button, which is the one thing a person is trying to read.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { anchorSelector, type CompanionAnchorKey } from '@/lib/companion/anchors';

/** How long the hop takes. Long enough to follow with your eyes, short enough
 *  that a nine-stop tour is not mostly waiting. */
export const CURSOR_FLIGHT_MS = 620;

/** How long the cursor keeps looking for a control that has not rendered yet. */
const GIVE_UP_AFTER_MS = 1_200;

export interface TourCursorProps {
  /** Which control. A key from the registry, never a selector. */
  anchor: CompanionAnchorKey;
  /** Fired once when the control could not be found. The caller shows the
   *  sentence without an arrow rather than pretending. */
  onNoTarget?: () => void;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function TourCursor({ anchor, onNoTarget }: TourCursorProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const selector = useMemo(() => anchorSelector(anchor), [anchor]);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const startedAtRef = useRef(0);
  const gaveUpRef = useRef(false);
  const noTargetCb = useRef(onNoTarget);
  useEffect(() => { noTargetCb.current = onNoTarget; });

  // A new anchor is a new flight. Reset during render, the same way
  // PointerPopup does, so no frame is painted with the new key and the old
  // coordinates.
  const [lastSelector, setLastSelector] = useState(selector);
  if (selector !== lastSelector) {
    setLastSelector(selector);
    startedAtRef.current = 0;
    gaveUpRef.current = false;
    // The position is deliberately NOT cleared: the cursor flies from where it
    // was to where it is going, which is the whole point of it. Clearing would
    // teleport it to the corner and back on every stop.
  }

  useLayoutEffect(() => {
    if (typeof document === 'undefined' || !selector) {
      if (!selector && !gaveUpRef.current) {
        gaveUpRef.current = true;
        noTargetCb.current?.();
      }
      return;
    }
    let cancelled = false;
    if (startedAtRef.current === 0) startedAtRef.current = Date.now();

    const measure = () => {
      if (cancelled) return;
      const node = document.querySelector<HTMLElement>(selector);
      const box = node?.getBoundingClientRect();
      // Missing, or measuring as nothing, which is what everything inside a
      // hidden branch measures as. A phone that hides the desktop pill bar
      // gets the sentence and no cursor, which is honest.
      if (!node || !box || box.width <= 0 || box.height <= 0) {
        if (!gaveUpRef.current && Date.now() - startedAtRef.current >= GIVE_UP_AFTER_MS) {
          gaveUpRef.current = true;
          noTargetCb.current?.();
        }
        return;
      }
      setAt({
        // Left edge, not centre. See the header.
        x: Math.round(box.left + Math.min(10, box.width * 0.18)),
        y: Math.round(box.top + box.height / 2),
      });
    };

    // Two frames plus a settle, matching PointerPopup: one frame for a scroll
    // to start, one for layout, a timer for a smooth scroll to land, and a
    // final look after the give-up clock so the decision to stop is taken by a
    // measurement rather than by whatever fired last.
    const raf = requestAnimationFrame(() => requestAnimationFrame(measure));
    const settle = setTimeout(measure, reduced ? 60 : 420);
    const verdict = setTimeout(measure, GIVE_UP_AFTER_MS + 60);
    window.addEventListener('resize', measure);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(settle);
      clearTimeout(verdict);
      window.removeEventListener('resize', measure);
    };
  }, [selector, reduced]);

  if (typeof document === 'undefined' || at === null) return null;

  return createPortal(
    <div
      className="ctc-root"
      data-testid="tour-cursor"
      data-tour-cursor-anchor={anchor}
      aria-hidden
      style={{
        transform: `translate3d(${at.x}px, ${at.y}px, 0)`,
        transition: reduced ? 'none' : `transform ${CURSOR_FLIGHT_MS}ms cubic-bezier(.22,1,.36,1)`,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: CURSOR_CSS }} />
      {/* The companion's own sage, not the caramel the old overlay used. The
          arrow, the pointer's hairline and the panel are one object reaching
          onto the page, and three inks would read as three products. */}
      <svg width="30" height="30" viewBox="0 0 30 30" className="ctc-arrow">
        <path
          d="M5 3 L5 23 L10 18.5 L13.5 26 L16.5 24.7 L13 17.5 L20.5 17.5 Z"
          fill="#5C7A60"
          stroke="#FCFDFB"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>,
    document.body,
  );
}

const CURSOR_CSS = `
.ctc-root{position:fixed;left:0;top:0;z-index:54;pointer-events:none;
  filter:drop-shadow(0 3px 7px rgba(31,42,32,.34));}
.ctc-arrow{display:block;animation:ctcPulse 1.5s ease-in-out infinite;}
@keyframes ctcPulse{0%,100%{opacity:1;}50%{opacity:.72;}}
@media (prefers-reduced-motion: reduce){
  .ctc-root{transition:none !important;}
  .ctc-arrow{animation:none;}
}
`;
