'use client';

// WAAPI motion helpers for the Triage inventory tab.
//
// Why WAAPI and not CSS keyframes: this UI must animate even under
// `prefers-reduced-motion: reduce`, which suppresses CSS animations. The Web
// Animations API (`element.animate`) plays regardless, so the physical
// card-flip + rise-in + button-pop survive reduced-motion (the design's crew
// browse with it on). Ported 1:1 from the handoff's `Motion` in core.js.

import { useEffect, useLayoutEffect, useRef, useState, type DependencyList } from 'react';

// Layout-effect that is SSR-safe (the shell only client-renders, but the
// loading branch can be server-rendered — never call useLayoutEffect there).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Shared easing vocabulary — "paper physics": quick departure, soft settle.
export const EASE = {
  settle: 'cubic-bezier(.16,.84,.3,1)',   // rise-in / draw-in
  spring: 'cubic-bezier(.22,1.4,.36,1)',  // slight overshoot on arrival
  glide:  'cubic-bezier(.2,.9,.25,1)',    // FLIP position moves
} as const;

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

// ── FLIP layout animation ─────────────────────────────────────────────────
// Put the returned ref on a container; every `[data-flip-id]` descendant gets
// tracked across renders. When a card's on-screen position changes (filter,
// search, a count moving it between triage columns) it glides from its old
// spot instead of teleporting; brand-new cards rise in with a cascade stagger.
// Removed cards unmount instantly — the survivors' glide carries the eye.
// WAAPI, so it plays under prefers-reduced-motion like the rest of this file.
export function useFlipList<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const rects = useRef<Map<string, DOMRect>>(new Map());

  useIsoLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const prev = rects.current;
    const next = new Map<string, DOMRect>();
    // Positions are stored relative to the container, not the viewport —
    // otherwise a page scroll between two renders would read as movement and
    // send every card gliding.
    const origin = root.getBoundingClientRect();
    const kids = root.querySelectorAll<HTMLElement>('[data-flip-id]');
    kids.forEach((k) => {
      const id = k.dataset.flipId;
      if (!id) return;
      const r = k.getBoundingClientRect();
      next.set(id, new DOMRect(r.left - origin.left, r.top - origin.top, r.width, r.height));
    });
    let enterIndex = 0;
    kids.forEach((k) => {
      const id = k.dataset.flipId;
      if (!id) return;
      const a = prev.get(id);
      const b = next.get(id)!;
      if (a) {
        const dx = a.left - b.left;
        const dy = a.top - b.top;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          k.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
            { duration: 430, easing: EASE.glide, fill: 'none' },
          );
        }
      } else {
        // Entering card — rise-and-settle, staggered but capped so a long
        // board never keeps the tail invisible for more than ~a third of a second.
        k.animate(
          [
            { opacity: 0, transform: 'translateY(12px) scale(.985)' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: 400,
            delay: Math.min(enterIndex * 22, 330),
            easing: EASE.settle,
            fill: 'none',
          },
        );
        enterIndex += 1;
      }
    });
    rects.current = next;
  });

  return ref;
}

// ── Count-up ──────────────────────────────────────────────────────────────
// rAF number tween — the "ledger being tallied" feel on the masthead stats and
// column counts. Animates from the previously shown value (0 on first mount,
// so the page-load moment counts everything up from zero). Ease-out cubic.
export function useCountUp(target: number, duration = 850): number {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  const shownRef = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(target)) return;
    const from = fromRef.current;
    if (from === target) {
      setValue(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * eased;
      shownRef.current = v;
      setValue(v);
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Interrupted mid-tween (target changed again) — continue from where
      // the number visually is, not from the stale start value.
      fromRef.current = shownRef.current;
    };
  }, [target, duration]);

  return value;
}
