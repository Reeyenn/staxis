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

// ── No entrance choreography ──────────────────────────────────────────────
// Load-time cascades (rise-in stagger, FLIP first-population stagger,
// count-up-from-zero) are permanently retired: on both hard loads and tab
// switches the page renders already settled. Motion remains only for things
// the user does mid-session — filter/search reorders glide (FLIP), newly
// added cards rise in, live value changes tween. The load-time version read
// as a glitch ("weird animation ... boxes pop up over again"), Reeyen 2026-07-13.

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
  // Entrance retired — [data-rise] elements render at rest. The hook (and the
  // data-rise markers) stay so a future design pass can re-enable motion in
  // one place. `deps`/`opts` are accepted and ignored.
  void deps; void opts;
  return ref;
}

// ── FLIP layout animation ─────────────────────────────────────────────────
// Put the returned ref on a container; every `[data-flip-id]` descendant gets
// tracked across renders. When a card's/row's on-screen position changes
// (filter, search, a sort, or an insert pushing others down) it glides from its
// old spot instead of teleporting — that glide is what "makes room" for a new
// item. Brand-new items slide in from the left (matching the Staff → Schedule
// add-staff entrance) so you can see exactly what was just added, and the
// newest one scrolls into view. Removed items unmount instantly. WAAPI, so it
// plays under prefers-reduced-motion like the rest of this file.
//
// `revealNew` (opt-in) scrolls the single newest item into view after an add —
// the sorted list can drop it anywhere, so without this the entrance can play
// off-screen where you'd never see it.
const ENTER_EASE = 'cubic-bezier(.2,.85,.3,1)'; // Staff add-staff easing.

export function useFlipList<T extends HTMLElement>(opts: { revealNew?: boolean } = {}) {
  const { revealNew = false } = opts;
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
    // First population always renders settled — no stagger. (Items added later
    // mid-session still individually slide in.)
    const initialPopulation = prev.size === 0;
    let enterIndex = 0;
    const entered: HTMLElement[] = [];
    kids.forEach((k) => {
      const id = k.dataset.flipId;
      if (!id) return;
      const a = prev.get(id);
      const b = next.get(id)!;
      if (initialPopulation) return;
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
        // Entering item — slide in from the left + fade, like the add-staff
        // board. Siblings gliding (above) is the "make room" motion. Staggered
        // but capped so a bulk add never keeps the tail invisible for long.
        k.animate(
          [
            { opacity: 0, transform: 'translateX(-26px)' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration: 440,
            delay: Math.min(enterIndex * 24, 240),
            easing: ENTER_EASE,
            fill: 'none',
          },
        );
        entered.push(k);
        enterIndex += 1;
      }
    });
    rects.current = next;

    // Bring the just-added item into view so the entrance is actually seen.
    // Only for a small add (1–3) — a bulk import shouldn't yank the scroll.
    // block:'nearest' no-ops when it's already visible.
    if (revealNew && entered.length > 0 && entered.length <= 3) {
      // Direct call (not rAF-wrapped): this is a layout effect, so the new row
      // is already at its final position. block:'nearest' no-ops if visible.
      try { entered[entered.length - 1].scrollIntoView({ block: 'nearest' }); } catch { /* noop */ }
    }
  });

  return ref;
}

// ── Count-up ──────────────────────────────────────────────────────────────
// rAF number tween — the "ledger being tallied" feel on the masthead stats and
// column counts. Animates from the previously shown value (0 on first mount,
// so the page-load moment counts everything up from zero). Ease-out cubic.
export function useCountUp(target: number, duration = 850): number {
  // Numbers land already settled on mount; only later live changes tween.
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const shownRef = useRef(target);

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
