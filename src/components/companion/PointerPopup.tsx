'use client';

// ═══════════════════════════════════════════════════════════════════════════
// The pointer — the companion putting one sentence beside one control.
//
// ─── WHAT THE FIRST BUILD GOT WRONG, AND WHERE EACH FIX LIVES ──────────────
// The founder reviewed the original live and rejected it for three things:
//
//   it pushed the page down    → this is a PORTAL onto document.body, fixed
//                                positioned, drawn over the page. Nothing in
//                                the layout moves. A screen somebody came to
//                                read stays exactly where they left it.
//   it did not look like us    → the Obsidian tokens below are the SAME values
//                                the panel, the peek and the trace card use.
//                                Not a near miss: a second dark surface half a
//                                shade off the first reads as a second product.
//   "Show me" was a second step → gone. The popup IS the pointing: it draws a
//                                hairline to the real control and lights it
//                                up, in the same breath as saying what it is
//                                for. There is nothing left to reveal.
//
// ─── THE GEOMETRY IS NOT IN HERE ───────────────────────────────────────────
// It is `layoutPointer` in src/lib/companion/trace/geometry.ts, beside the
// trace's own, sharing its rectangle, its viewport, its inflation pad and its
// edge margin. Same reason the trace put it there: the server-conditions test
// suite cannot mount a component, so anything with a consequence has to be
// reachable without one. What is left here is measurement, listeners and
// pixels.
//
// ─── HONESTY RULES THAT LIVE IN THIS FILE ──────────────────────────────────
//   • A control that is not in the DOM, or measures as nothing because it is
//     inside a hidden branch, is NEVER pointed at. The popup does not appear,
//     and `onNoTarget` lets the caller give up without spending the pointer.
//   • A control that is off screen is scrolled to, once, gently, before
//     anything is drawn.
//   • The overlay does not eat clicks. Only the popup itself takes the mouse,
//     so the control the arrow lands on stays usable — which is the whole of
//     the tap-it-and-we-stop-asking path below.
//   • Reduced motion turns the drawing into a plain appearance.
// ═══════════════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  EDGE_MARGIN,
  isOnScreen,
  layoutPointer,
  type PointerGeometry,
  type TraceViewport,
} from '@/lib/companion/trace/geometry';
import {
  anchorSelector,
  type CompanionAnchorKey,
} from '@/lib/companion/anchors';
import type { PointerAnswer, PointerButton } from '@/lib/companion/copy';

/** How wide the popup is drawn, before the window is allowed to squeeze it. */
export const POINTER_CARD_WIDTH = 328;

/** Stand-in height for the one frame before the card has been measured. */
const CARD_FALLBACK_HEIGHT = 150;

/** The attribute the pointed-at control wears while it is lit. */
const LIT_ATTR = 'data-staxis-lit';

/** How long after mount a pointer is still allowed to be looking for its
 *  control. Past this, a control that has not appeared is not coming. */
const GIVE_UP_AFTER_MS = 1_200;

// ─── Who is lighting what ──────────────────────────────────────────────────
//
// The lit attribute lives on a node this component does NOT own, and more than
// one pointer can be up at once: the discovery pointer on the stockroom screen
// and a chat pointer answering "where is the importer" are two instances with
// two private opinions about one global attribute. With a plain set/remove the
// first to close strips the glow off a control the other is still pointing at.
//
// So it is reference counted, once, here. Nothing outside this module writes
// the attribute, and it comes off only when the last pointer holding it lets go.
const LIT_HOLDERS = new WeakMap<Element, number>();

function holdLit(node: HTMLElement): void {
  const held = (LIT_HOLDERS.get(node) ?? 0) + 1;
  LIT_HOLDERS.set(node, held);
  node.setAttribute(LIT_ATTR, '');
}

function releaseLit(node: HTMLElement): void {
  const held = (LIT_HOLDERS.get(node) ?? 1) - 1;
  if (held > 0) {
    LIT_HOLDERS.set(node, held);
    return;
  }
  LIT_HOLDERS.delete(node);
  node.removeAttribute(LIT_ATTR);
}

export interface PointerPopupProps {
  /** Which control. A key from the registry, never a selector. */
  anchor: CompanionAnchorKey;
  /** What it says. One entry per paragraph. */
  paragraphs: readonly string[];
  /** The ways out, left to right. */
  buttons: readonly PointerButton[];
  /** A button was pressed. */
  onAnswer: (answer: PointerAnswer) => void;
  /** They used the control the arrow lands on. They have found it. */
  onTargetUsed?: () => void;
  /** Fired once, the first time the popup actually draws. */
  onShown?: () => void;
  /** Fired once when there is nothing on this screen to point at. */
  onNoTarget?: () => void;
}

function readViewport(): TraceViewport {
  if (typeof window === 'undefined') return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function PointerPopup({
  anchor,
  paragraphs,
  buttons,
  onAnswer,
  onTargetUsed,
  onShown,
  onNoTarget,
}: PointerPopupProps) {
  const [geometry, setGeometry] = useState<PointerGeometry | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const scrolledRef = useRef(false);
  const shownRef = useRef(false);
  const gaveUpRef = useRef(false);
  const startedAtRef = useRef(0);
  const litRef = useRef<HTMLElement | null>(null);
  const reduced = useMemo(() => prefersReducedMotion(), []);
  const selector = useMemo(() => anchorSelector(anchor), [anchor]);

  // Handlers change identity on every parent render; the measure loop and the
  // document listener must not be torn down and rebuilt each time. Assigned in
  // an EFFECT rather than during render: a concurrent render that React then
  // discards would otherwise leave a callback from a tree that never committed.
  const shownCb = useRef(onShown);
  const noTargetCb = useRef(onNoTarget);
  const usedCb = useRef(onTargetUsed);
  useEffect(() => {
    shownCb.current = onShown;
    noTargetCb.current = onNoTarget;
    usedCb.current = onTargetUsed;
  });

  // ── A new anchor is a new pointer ────────────────────────────────────────
  //
  // Every ref below is a fact about ONE control: whether we scrolled to it,
  // whether it has been seen, whether we gave up on it, when we started
  // looking. A caller that swaps the anchor on a live instance (the chat
  // pointer answers a second question without unmounting) would otherwise get
  // the second control described in the first control's words and drawn at the
  // first control's coordinates, with `onShown` and `onNoTarget` both already
  // spent and therefore silent forever.
  //
  // Reset during RENDER, which is React's own answer to adjusting state when a
  // prop changes: it happens before the browser paints, so no frame is ever
  // shown with the new text and the old geometry. The lit attribute is DOM and
  // is released in the effect below instead, because render must not touch it.
  const [lastSelector, setLastSelector] = useState(selector);
  if (selector !== lastSelector) {
    setLastSelector(selector);
    setGeometry(null);
    scrolledRef.current = false;
    shownRef.current = false;
    gaveUpRef.current = false;
    startedAtRef.current = 0;
  }

  /** Light the control, releasing whatever this instance was holding before. */
  const light = useCallback((node: HTMLElement | null) => {
    if (litRef.current === node) return;
    if (litRef.current) releaseLit(litRef.current);
    litRef.current = node;
    if (node) holdLit(node);
  }, []);

  /**
   * Nothing to point at, this time round.
   *
   * ONE exit for every reason a measure can fail: the node is missing, it
   * measures as zero, it cannot be brought on screen, or the geometry refused
   * it. Before, only the first of those could ever give up, so a control that
   * existed but could not be scrolled to left the popup mounted and invisible
   * for as long as the person stayed on the page.
   *
   * The grace is a CLOCK, not a count of tries. Counting was wrong because the
   * scroll listener is capture-phase on the window: any scroller anywhere on
   * the page burned the allowance within milliseconds of mount and the pointer
   * gave up on a screen that was still rendering.
   */
  const nothingToPointAt = useCallback(() => {
    light(null);
    setGeometry(null);
    if (gaveUpRef.current || shownRef.current) return;
    const started = startedAtRef.current;
    if (started === 0 || Date.now() - started < GIVE_UP_AFTER_MS) return;
    gaveUpRef.current = true;
    noTargetCb.current?.();
  }, [light]);

  // Whether the control has been located, as a plain boolean rather than the
  // geometry object: the observer effect below only cares that there is now a
  // node to watch, and depending on the object would rebuild the observer on
  // every scroll frame.
  const found = geometry !== null;

  const measure = useCallback(() => {
    if (typeof document === 'undefined') return;
    if (startedAtRef.current === 0) startedAtRef.current = Date.now();
    // An anchor key that resolves to no selector cannot be looked for at all.
    // Unreachable through either call site today, both of which resolve the key
    // through `anchorFor` first, but a popup that sat there forever would be
    // the one failure with no symptom.
    if (!selector) { nothingToPointAt(); return; }

    const node = document.querySelector<HTMLElement>(selector);
    const box = node?.getBoundingClientRect();
    // Missing, or present but measuring as nothing — which is what every
    // control inside a `display: none` branch measures as, so a phone that
    // hides the desktop rail gets no arrow rather than an arrow to the corner.
    if (!node || !box || box.width <= 0 || box.height <= 0) { nothingToPointAt(); return; }

    const viewport = readViewport();
    const rect = { left: box.left, top: box.top, width: box.width, height: box.height };
    if (!isOnScreen(rect, viewport)) {
      if (!scrolledRef.current) {
        scrolledRef.current = true;
        node.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
      }
      // Nothing is drawn to a control nobody can see. The settle timer measures
      // again once the scroll has landed; if it never lands, the clock above
      // ends this rather than leaving an invisible popup mounted.
      nothingToPointAt();
      return;
    }

    const width = Math.min(POINTER_CARD_WIDTH, viewport.width - EDGE_MARGIN * 2);
    const measuredHeight = cardRef.current?.offsetHeight ?? 0;
    const height = measuredHeight > 0 ? measuredHeight : CARD_FALLBACK_HEIGHT;
    const next = layoutPointer(rect, viewport, { width, height });
    if (!next) { nothingToPointAt(); return; }

    light(node);
    setGeometry(next);
    if (!shownRef.current) {
      shownRef.current = true;
      shownCb.current?.();
    }
  }, [selector, light, reduced, nothingToPointAt]);

  // First measure. Two frames plus a settle, exactly like the trace: one frame
  // for a scroll to start, one for layout, and a timer for a smooth scroll to
  // land. Measuring once, early, is the version that drew to the wrong place.
  useLayoutEffect(() => {
    let cancelled = false;
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => { if (!cancelled) measure(); });
    });
    const settle = setTimeout(() => { if (!cancelled) measure(); }, reduced ? 60 : 420);
    // One more look after the give-up clock, so the decision to stop is taken
    // by a measurement rather than by whatever happened to fire last.
    const verdict = setTimeout(() => { if (!cancelled) measure(); }, GIVE_UP_AFTER_MS + 60);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      clearTimeout(settle);
      clearTimeout(verdict);
    };
  }, [measure, reduced]);

  // Re-measure on anything that can move the control. Coalesced into one frame:
  // a scroll fires this dozens of times a second and a layout per event is how
  // an overlay becomes the reason a page feels slow.
  useEffect(() => {
    const schedule = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        measure();
      });
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);

    // Scroll and resize are only the WINDOW moving. Most of what actually
    // moves a control is the page moving under it: the composer growing when
    // somebody taps into it, a board finishing its load, a row arriving, a font
    // landing late. None of those fire either event, and a pointer meant to sit
    // on screen for minutes would keep its hairline and its glow at
    // coordinates that stopped being true. Watching the control and the
    // document body catches both the control resizing and everything above it
    // reflowing.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && selector) {
      observer = new ResizeObserver(schedule);
      const node = typeof document === 'undefined' ? null : document.querySelector(selector);
      if (node) observer.observe(node);
      if (typeof document !== 'undefined' && document.body) observer.observe(document.body);
    }

    return () => {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
    // `found` re-runs this once the control has actually been located, which
    // is when there is a node worth observing: the first pass often runs
    // before the page has rendered it.
  }, [measure, selector, found]);

  // ── They used the thing ──────────────────────────────────────────────────
  //
  // The third way a pointer ends, and the only one that is not a button. It is
  // captured on the document rather than bound to the node, because the node
  // is re-found on every measure and a listener attached to one instance would
  // be attached to a node that had since been replaced. Capture phase so it
  // still counts when the control stops the event on its way up.
  //
  // The callback is read from the ref at CALL time, never at attach time: a
  // caller that supplies it a render later would otherwise never get a
  // listener at all, because the effect had already decided there was nothing
  // to call and returned.
  useEffect(() => {
    if (!selector) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest(selector)) return;
      usedCb.current?.();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [selector]);

  // Escape is the cheapest possible "not now". It never means never: giving up
  // a topic forever is a decision, and a decision needs a button.
  //
  // BUBBLE PHASE, AND IT DOES NOT STOP THE EVENT. The trace takes Escape at
  // capture and swallows it, which is right for a full-screen reveal that owns
  // the window. A pointer owns nothing: it is a tip beside a button, and it
  // may sit on a screen for minutes. Eating the Escape somebody meant for the
  // dialog they had open would be this feature reaching outside itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      onAnswer('later');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAnswer]);

  // Put the page back exactly as it was found.
  useEffect(() => () => { light(null); }, [light]);

  if (typeof document === 'undefined') return null;

  const viewport = readViewport();
  const width = Math.min(POINTER_CARD_WIDTH, Math.max(200, viewport.width - EDGE_MARGIN * 2));

  return createPortal(
    <div className={`cpt-root${reduced ? ' cpt-still' : ''}`} data-testid="companion-pointer">
      <style dangerouslySetInnerHTML={{ __html: POINTER_CSS }} />

      {geometry && (
        <svg
          className="cpt-lines"
          width={viewport.width}
          height={viewport.height}
          data-testid="companion-pointer-arrow"
          aria-hidden
        >
          {/* The control's own outline, so it is lit even where a parent clips
              the box-shadow the attribute below paints on it. */}
          <rect
            x={geometry.glow.left}
            y={geometry.glow.top}
            width={geometry.glow.width}
            height={geometry.glow.height}
            rx={12}
            className="cpt-glow"
          />
          <path
            d={`M${geometry.line.x1} ${geometry.line.y1} L${geometry.line.x2} ${geometry.line.y2}`}
            className="cpt-line cpt-draw"
          />
          {/* The rotation is a presentation ATTRIBUTE on the group and the
              animation is a class on the path inside it. Putting both on one
              node would let the reduced-motion rule's `transform: none` win
              over the attribute and drop the arrowhead onto the origin. */}
          <g transform={`translate(${geometry.head.x} ${geometry.head.y}) rotate(${geometry.head.angle})`}>
            <path d="M0 0 L-9 -4.5 L-9 4.5 Z" className="cpt-head cpt-pop" />
          </g>
        </svg>
      )}

      <div
        ref={cardRef}
        className="cpt-card"
        role="status"
        aria-live="polite"
        data-side={geometry?.side ?? 'below'}
        style={{
          width: `${width}px`,
          left: `${geometry ? geometry.card.left : EDGE_MARGIN}px`,
          top: `${geometry ? geometry.card.top : EDGE_MARGIN}px`,
          // Measured before it is placed. Hidden rather than unmounted, because
          // the height of the real text is the input the placement needs.
          visibility: geometry ? 'visible' : 'hidden',
        }}
      >
        <span className="cpt-star" aria-hidden>✦</span>
        {paragraphs.map((line, i) => (
          <p className="cpt-body" key={`p-${i}`}>{line}</p>
        ))}
        <div className="cpt-acts">
          {buttons.map((button, i) => (
            <button
              key={button.label}
              type="button"
              className={i === 0 && buttons.length === 1 ? 'cpt-btn cpt-btn-go' : 'cpt-btn'}
              onClick={() => onAnswer(button.answer)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────
//
// Scoped under `.cpt-*` and injected the same way AskStaxisBar and TraceLayer
// inject theirs, because App Router restricts plain global CSS imports to the
// root layout and this needs keyframes.
//
// The ink, the sage and the spring are the companion's own values, copied from
// nowhere: they are the same literals the panel, the peek and the trace card
// declare, because this IS the companion reaching onto the page.

const POINTER_CSS = `
.cpt-root{position:fixed;inset:0;z-index:53;pointer-events:none;
  --cpt-ink:#1F231C;--cpt-sage:#5C7A60;--cpt-sage-l:#9EB7A6;--cpt-white:#FCFDFB;
  --cpt-soft:#B9C0B8;--cpt-spring:cubic-bezier(.22,1,.36,1);
  font-family:var(--font-geist),-apple-system,BlinkMacSystemFont,sans-serif;}
.cpt-root *{box-sizing:border-box;}
.cpt-lines{position:fixed;left:0;top:0;pointer-events:none;}
.cpt-glow{fill:rgba(158,183,166,.12);stroke:var(--cpt-sage-l);stroke-width:2;
  animation:cptGlow 2.4s ease-in-out infinite;}
.cpt-line{fill:none;stroke:var(--cpt-sage);stroke-width:1.6;stroke-linecap:round;}
.cpt-head{fill:var(--cpt-sage);}
.cpt-draw{stroke-dasharray:600;animation:cptDraw .4s var(--cpt-spring) both;}
.cpt-pop{animation:cptFade .24s ease .3s both;}

.cpt-card{position:fixed;pointer-events:auto;border-radius:16px;padding:15px 17px 14px;
  background:radial-gradient(ellipse 320px 160px at 50% 130%,rgba(92,122,96,.30) 0%,rgba(92,122,96,0) 62%),var(--cpt-ink);
  box-shadow:inset 0 1px 0 rgba(158,183,166,.14),0 24px 52px -26px rgba(31,42,32,.7);
  animation:cptIn .3s var(--cpt-spring) both;max-height:calc(100vh - 48px);overflow:auto;}
.cpt-star{display:block;color:var(--cpt-sage-l);font-size:11px;line-height:1;}
.cpt-body{font-size:14px;line-height:1.55;color:var(--cpt-white);margin:9px 0 0;text-wrap:pretty;}
.cpt-acts{display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap;}
.cpt-btn{height:32px;padding:0 12px;border-radius:9px;border:none;cursor:pointer;font:inherit;
  font-size:12.5px;background:rgba(255,255,255,.09);color:var(--cpt-soft);}
.cpt-btn:hover{background:rgba(255,255,255,.16);color:var(--cpt-white);}
.cpt-btn-go{background:var(--cpt-sage-l);color:var(--cpt-ink);font-weight:700;padding:0 16px;}
.cpt-btn-go:hover{background:#B0C6B7;color:var(--cpt-ink);}
.cpt-btn:focus-visible{outline:2px solid var(--cpt-sage-l);outline-offset:2px;}

/* The control itself lights up, on the control itself. The SVG ring above is
   the twin of this for the cases where a parent clips a box-shadow. */
[data-staxis-lit]{box-shadow:0 0 0 2px rgba(158,183,166,.95),0 0 0 7px rgba(92,122,96,.22) !important;
  transition:box-shadow .3s ease;}

@keyframes cptFade{from{opacity:0;}to{opacity:1;}}
@keyframes cptDraw{from{stroke-dashoffset:600;}to{stroke-dashoffset:0;}}
@keyframes cptIn{from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:none;}}
@keyframes cptGlow{0%,100%{opacity:.55;}50%{opacity:1;}}

/* Reduced motion: everything is simply there. The information is identical. */
.cpt-still .cpt-draw,.cpt-still .cpt-pop,.cpt-still .cpt-card,.cpt-still .cpt-glow{
  animation:cptFade .12s linear both;stroke-dashoffset:0;transform:none;}
@media (prefers-reduced-motion: reduce){
  .cpt-draw,.cpt-pop,.cpt-card,.cpt-glow{
    animation:cptFade .12s linear both;stroke-dashoffset:0;transform:none;}
}
`;
