'use client';

// ═══════════════════════════════════════════════════════════════════════════
// useReportedValue — hand a derived value UP to a callback prop, exactly once
// per change of the value, no matter how the caller wrote the callback.
//
// ─── the hazard this exists to remove ─────────────────────────────────────
// The obvious way to report a value up is
//
//     useEffect(() => { onThing?.(thing); }, [thing, onThing]);
//
// which is correct only while every caller happens to pass a REFERENTIALLY
// STABLE callback. A `useState` setter is stable, so the shape works, and it
// keeps working right up until somebody writes the natural thing instead:
//
//     <Child onThing={(t) => setThing(t)} />
//
// That arrow is a new function on every parent render, so the effect re-fires
// on every parent render. In this subsystem that is not a wasted tick, it is a
// loop: the value is reported up into the parent's setState, the parent
// re-renders, the child gets a fresh arrow, the effect fires again. The
// readState edge running HotelQueue → StaxisList → FindingCards is precisely
// that loop, and it is one half of what turned a latent key collision into an
// outage. The full writeup, including why it is completely silent in
// production, is in src/components/concourse/hotel-queue-keys.ts.
//
// So the identity of the callback must not be able to schedule work. This hook
// keeps the latest callback in a ref and depends only on the VALUE, which
// makes an inline arrow the same cost as a stable setter and removes the trap
// rather than documenting it.
//
// The ref is refreshed in its own effect declared BEFORE the reporting effect.
// Effects in one component commit in declaration order, so by the time a
// report fires the ref already holds the callback from this very render. It is
// deliberately not written during render: the react-compiler lint forbids that,
// and it would be wrong under a discarded render pass anyway.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef } from 'react';

/**
 * Report `value` through `report` whenever `value` changes, and never merely
 * because `report` is a different function than it was last render.
 *
 * Comparison is `Object.is`, the same test React uses to bail out of a
 * setState, so reporting a value the parent already holds costs nothing.
 *
 * @param value  the derived value to hand upward
 * @param report the caller's callback. May be undefined, and may be a fresh
 *               inline arrow on every render.
 */
export function useReportedValue<T>(
  value: T,
  report: ((value: T) => void) | undefined,
): void {
  const reportRef = useRef(report);
  // Every commit, so the ref is never a render behind. Declared first so it
  // has already run when the effect below fires in the same commit.
  useEffect(() => {
    reportRef.current = report;
  });

  useEffect(() => {
    reportRef.current?.(value);
  }, [value]);
}
