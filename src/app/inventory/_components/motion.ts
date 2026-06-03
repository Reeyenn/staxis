'use client';

// WAAPI motion helpers for the Triage inventory tab.
//
// Why WAAPI and not CSS keyframes: this UI must animate even under
// `prefers-reduced-motion: reduce`, which suppresses CSS animations. The Web
// Animations API (`element.animate`) plays regardless, so the physical
// card-flip + rise-in + button-pop survive reduced-motion (the design's crew
// browse with it on). Ported 1:1 from the handoff's `Motion` in core.js.

import { useEffect, useRef, type DependencyList } from 'react';

type FlipOpts = { axis?: 'x' | 'y'; perspective?: number; d1?: number; d2?: number };

export const Motion = {
  // Physical flip: rotate the element on an axis, swap faces at mid-turn via
  // `onMid`. CRITICAL: both half-animations are cancelled and the inline
  // transform cleared on finish (with a timer fallback at d2+80ms) so the card
  // always resolves to its visible identity state — otherwise a throttled
  // (background-tab) timeline can leave it stuck edge-on and appear blank.
  flip(el: HTMLElement | null, onMid?: () => void, opts: FlipOpts = {}): void {
    if (!el) return;
    const axis = opts.axis === 'y' ? 'rotateY' : 'rotateX';
    const persp = opts.perspective ?? 700;
    const d1 = opts.d1 ?? 150;
    const d2 = opts.d2 ?? 230;
    el.style.transformStyle = 'preserve-3d';
    el.style.backfaceVisibility = 'hidden';
    const a1 = el.animate(
      [
        { transform: `perspective(${persp}px) ${axis}(0deg)` },
        { transform: `perspective(${persp}px) ${axis}(-90deg)` },
      ],
      { duration: d1, easing: 'cubic-bezier(.45,0,.9,.35)', fill: 'forwards' },
    );
    setTimeout(() => {
      if (onMid) onMid();
      const a2 = el.animate(
        [
          { transform: `perspective(${persp}px) ${axis}(90deg)` },
          { transform: `perspective(${persp}px) ${axis}(0deg)` },
        ],
        { duration: d2, easing: 'cubic-bezier(.1,.7,.2,1)', fill: 'forwards' },
      );
      let cleaned = false;
      const done = () => {
        if (cleaned) return;
        cleaned = true;
        try { a1.cancel(); } catch { /* noop */ }
        try { a2.cancel(); } catch { /* noop */ }
        el.style.transform = '';
      };
      a2.onfinish = done;
      setTimeout(done, d2 + 80);
    }, d1);
  },

  // Button press feedback: scale 1 → s → 1.
  pop(el: HTMLElement | null, scale = 0.95): Animation | undefined {
    if (!el) return;
    return el.animate(
      [{ transform: 'scale(1)' }, { transform: `scale(${scale})` }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'cubic-bezier(.2,.9,.25,1)' },
    );
  },

  // Staggered list entrance. `fill:'none'` so the resting state is the
  // element's own visible base style — if the timeline is throttled, content
  // is never left invisible. Base delay 60ms keeps it frozen-safe.
  riseIn(els: ArrayLike<Element>, opts: { step?: number; dist?: number } = {}): void {
    const step = opts.step ?? 36;
    const dist = opts.dist ?? 14;
    Array.from(els).forEach((el, i) => {
      (el as HTMLElement).animate(
        [
          { opacity: 0, transform: `translateY(${dist}px)` },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 460, delay: 60 + i * step, easing: 'cubic-bezier(.16,.84,.3,1)', fill: 'none' },
      );
    });
  },
};

// Run a staggered rise-in over any `[data-rise]` descendants whenever `deps`
// change (e.g. bucket / search). Returns a ref to put on the container.
export function useRiseIn<T extends HTMLElement>(
  deps: DependencyList,
  opts?: { step?: number; dist?: number },
) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const kids = ref.current.querySelectorAll('[data-rise]');
    if (kids.length) Motion.riseIn(kids, opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
