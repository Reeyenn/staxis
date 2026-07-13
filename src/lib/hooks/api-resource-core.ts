/**
 * Pure logic backing src/lib/hooks/use-api-resource.ts.
 *
 * Kept React-free in its own module so it can be unit-tested under
 * `npm run test` (the runner passes --conditions=react-server, under which
 * the react package doesn't ship client hooks — importing a 'use client'
 * hook module from a test is a trap). Everything here is deterministic and
 * synchronous; the hook wires it to fetch/setState/setInterval.
 */

/**
 * Monotonic ticket counter that drops stale async results.
 *
 * Usage: every request takes a ticket via begin(); when its response lands,
 * it only "wins" if isCurrent(ticket) — i.e. no newer request started and
 * nothing invalidated the gate (unmount, disable, URL switch) in between.
 * This is the guard against BOTH out-of-order responses (slow request A
 * resolving after fast request B and clobbering fresher data) and
 * setState-after-unmount.
 */
export interface RequestGate {
  /** Start a new request; returns its ticket and invalidates older ones. */
  begin(): number;
  /** True iff this ticket is still the newest and the gate wasn't invalidated. */
  isCurrent(ticket: number): boolean;
  /** Invalidate every outstanding ticket (unmount / disable / key switch). */
  invalidate(): void;
}

export function createRequestGate(): RequestGate {
  let seq = 0;
  return {
    begin() {
      return ++seq;
    },
    isCurrent(ticket: number) {
      return ticket === seq;
    },
    invalidate() {
      seq++;
    },
  };
}

/**
 * Whether a poll interval tick should actually fire a request.
 *
 *  - hidden: document.visibilityState === 'hidden' — several pages already
 *    gate their polls this way (housekeeper phones sit backgrounded for
 *    hours; polling a hidden tab burns battery + server for nothing).
 *  - inFlight: previous request hasn't resolved — never overlap; a slow
 *    server must not accumulate a queue of identical requests.
 *  - enabled: capability/section gating — disabled resources never fetch.
 */
export function shouldPollTick(state: {
  enabled: boolean;
  hidden: boolean;
  inFlight: boolean;
}): boolean {
  return state.enabled && !state.hidden && !state.inFlight;
}

/**
 * Whether a resource-identity change (URL switch) should HOLD the previous
 * data on screen instead of blanking + re-showing the loading spinner.
 *
 * Only true when ALL of:
 *  - the caller opted in (keepDataOnSourceChange) — default behavior stays
 *    "switching URL drops the old resource's data";
 *  - this is not the first identity (first mount / re-enable must still show
 *    the initial loading state);
 *  - there IS last-good data to hold (holding nothing = a silent blank page,
 *    worse than the spinner).
 *
 * The stale-drop guard is unaffected either way: the old identity's ticket
 * is invalidated, so a late response for the previous URL never lands.
 */
export function shouldHoldDataOnSourceChange(state: {
  keepDataOnSourceChange: boolean;
  isFirstIdentity: boolean;
  hasData: boolean;
}): boolean {
  return state.keepDataOnSourceChange && !state.isFirstIdentity && state.hasData;
}

/** Outcome of one settled request, normalized by the hook. */
export type ResourceOutcome<T> =
  | { kind: 'success'; data: T }
  | { kind: 'error'; message: string };

/**
 * Fold a settled request into the next { data, error } pair.
 *
 * keepDataOnError=false (default): an error blanks data — the classic
 * fetch-then-setState pages show their error state instead of stale rows.
 *
 * keepDataOnError=true: an error keeps the last-good data and only sets the
 * error message — CalloutBanner/laundry semantics, where a flapping network
 * mid-poll must NOT blank a page a housekeeper is actively working from.
 */
export function applyOutcome<T>(
  prevData: T | null,
  outcome: ResourceOutcome<T>,
  keepDataOnError: boolean,
): { data: T | null; error: string | null } {
  if (outcome.kind === 'success') {
    return { data: outcome.data, error: null };
  }
  return {
    data: keepDataOnError ? prevData : null,
    error: outcome.message,
  };
}
