'use client';

// ─── useLiveQuery: mount/unmount plumbing for db/* realtime subscriptions ───
// Every staff page today hand-writes the same effect around a db-subscribe
// helper:
//
//   useEffect(() => {
//     if (!user || !activePropertyId) return;
//     const unsub = subscribeToPreventiveTasks(user.uid, activePropertyId, setTasks);
//     return () => unsub();
//   }, [user, activePropertyId]);
//
// This hook is that effect, nothing more:
//
//   const { uid, pid, ready } = useScope();
//   useLiveQuery(
//     () => ready && subscribeToPreventiveTasks(uid!, pid!, setTasks),
//     [ready, uid, pid],
//   );
//
// The factory runs on mount and whenever `deps` change; whatever unsubscribe
// function it returns is called on cleanup. Return null / undefined / false
// (or nothing) from the factory to signal "not ready yet" — the hook simply
// waits for the next deps change. Multi-callback helpers (e.g.
// subscribeToRooms' `(rooms, feedStatus) => ...`) fit unchanged because the
// consumer's callbacks live inside the factory closure.
//
// ⚠️ Semantics live elsewhere — do NOT grow this file.
// ALL realtime behavior (refetch-on-any-change, burst debounce, out-of-order
// publish guards, reducer fast path, iOS Safari backgrounded-WebSocket
// recovery via visibilitychange) is implemented once in
// src/lib/db/_common.ts::subscribeTable and delegated to 100% here. This
// wrapper must never diff-merge events, convert to polling, retry, or add
// its own visibility handling — read _common.ts before touching this.

import { useEffect, type DependencyList } from 'react';

/** The teardown function returned by every db/* subscribe helper. */
export type Unsubscribe = () => void;

/**
 * What a subscribe factory may return: the helper's unsubscribe function,
 * or any non-function value (null / undefined / false / void) meaning
 * "not ready — don't subscribe yet". `false` is allowed so factories can
 * use the terse `() => ready && subscribeToX(...)` guard form.
 */
export type SubscribeFactoryResult = Unsubscribe | null | undefined | false | void;

/**
 * Normalize a factory result into a React effect cleanup: functions pass
 * through, everything else means "nothing to clean up". Exported for unit
 * tests (pure — see use-live-query.test.ts).
 */
export function toCleanup(result: SubscribeFactoryResult): Unsubscribe | undefined {
  return typeof result === 'function' ? result : undefined;
}

/**
 * Subscribe to a realtime db/* helper for the lifetime of the component,
 * resubscribing whenever `deps` change.
 *
 * `deps` is the caller's dependency list, exactly as they would have passed
 * to the useEffect this replaces — it must cover everything the factory
 * closes over (uid, pid, date, setters are stable and may be omitted, same
 * rules as any effect).
 */
export function useLiveQuery(
  subscribeFactory: () => SubscribeFactoryResult,
  deps: DependencyList,
): void {
  // The factory is intentionally NOT in the dependency list — callers pass
  // inline closures (new reference every render); `deps` is the contract.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => toCleanup(subscribeFactory()), deps);
}
