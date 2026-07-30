// ─── The ordering panel's async machinery, lifted out of the component ──────
//
// Co-located with OrderingPanel.tsx (same as ordering-i18n.ts) rather than put
// under src/lib/ordering/, which is server-side: db.ts there imports
// supabase-admin and throws at module load in a browser.
//
// This exists because all three of the bugs it fixes were bugs of PLACEMENT,
// not of logic, and the placement was only possible while this code lived
// inline in a render body:
//
//   • the send fired from inside a setState updater. React is allowed to
//     invoke an updater twice, and twice here is two purchase orders in a real
//     vendor's inbox. It now fires from the interval callback, once, behind a
//     flag, with the timer torn down first.
//   • a rejected fetch threw out of an async IIFE nobody was awaiting, so a
//     failed send showed the manager nothing at all and they believed the
//     vendor had it.
//   • a rejected fetch also skipped the `setBusy(null)` that followed it, and
//     because the panel stays mounted across close and reopen, every control
//     on the screen stayed disabled until a full page reload.
//
// The rule these three share: a failure the manager cannot see is worse than
// an error message. Everything here reports, and everything releases.

/** POST one action to the ordering route. Never throws, never rejects: a
 *  dropped connection is a `false` the caller must show, not an exception
 *  thrown into a void. */
export async function postOrdering(
  propertyId: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/inventory/ordering', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: propertyId, ...body }),
    });
    const json = await res.json().catch(() => null);
    return Boolean((json as { ok?: unknown } | null)?.ok);
  } catch {
    return false;
  }
}

/**
 * Run one panel action: mark busy, post, release, report, reload.
 *
 * The release is in a `finally` and the post is wrapped in a `catch` for the
 * same reason: every call site is `void runOrderingAction(...)`, so anything
 * that escapes here escapes into nothing. Before the finally, one dropped
 * request left the busy key set forever and wedged the whole panel.
 *
 * The reload runs whether or not the write succeeded. A failed write is
 * exactly when the screen is most likely to be out of step with the database,
 * because the usual reason for the failure is that something changed.
 */
export async function runOrderingAction(opts: {
  key: string;
  post: () => Promise<boolean>;
  setBusy: (key: string | null) => void;
  onResult: (succeeded: boolean) => void;
  reload: () => Promise<void>;
}): Promise<boolean> {
  opts.setBusy(opts.key);
  let succeeded = false;
  try {
    succeeded = await opts.post();
  } catch {
    succeeded = false;
  } finally {
    opts.setBusy(null);
  }
  opts.onResult(succeeded);
  await opts.reload();
  return succeeded;
}

export interface SendCountdown {
  /** Begin the visible countdown for `key`. `run` is called exactly once,
   *  after the final second, and only if nothing cancelled it first. */
  start(key: string, run: () => Promise<void>): void;
  cancel(key: string): void;
  /** Tear every countdown down without running anything. This is what makes
   *  "close the screen and nothing goes out" true rather than a hopeful
   *  sentence. */
  stopAll(): void;
  isCounting(key: string): boolean;
}

/**
 * The 60 seconds before a purchase order leaves the building.
 *
 * The send is deliberately not called until the countdown ends, so "undo" is
 * really "we have not started yet", which is stronger than a recall.
 *
 * FIRES ONCE. Three separate things enforce that, because the cost of being
 * wrong is a second real order to a real supplier: the interval is cleared
 * before the send is dispatched, `firing` blocks a re-entrant start, and the
 * send lives in the interval callback rather than in a state updater that
 * React may legitimately invoke twice.
 */
export function createSendCountdown(opts: {
  seconds: number;
  /** Called with the seconds remaining, and with `null` when the countdown is
   *  over or cancelled. The component turns this into what the button says. */
  onSecond: (key: string, secondsLeft: number | null) => void;
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}): SendCountdown {
  const setI = opts.setIntervalImpl ?? ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown);
  const clearI = opts.clearIntervalImpl
    ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  const timers = new Map<string, unknown>();
  const remaining = new Map<string, number>();
  const firing = new Set<string>();

  function stop(key: string): void {
    const handle = timers.get(key);
    if (handle !== undefined) clearI(handle);
    timers.delete(key);
    remaining.delete(key);
  }

  return {
    isCounting: (key) => timers.has(key),

    start(key, run) {
      // Already counting, or its send is still in flight: a second tap must
      // never queue a second order.
      if (timers.has(key) || firing.has(key)) return;
      remaining.set(key, opts.seconds);
      opts.onSecond(key, opts.seconds);

      const handle = setI(() => {
        // No countdown on record means this key was cancelled or has already
        // fired, and this tick is a straggler. Checking here rather than
        // trusting clearInterval to have landed is what makes the once-only
        // promise hold even if the teardown is missed.
        const current = remaining.get(key);
        if (current === undefined) return;
        const next = current - 1;
        if (next > 0) {
          remaining.set(key, next);
          opts.onSecond(key, next);
          return;
        }
        // Down the timer BEFORE dispatching, so there is no window in which a
        // second tick could reach the send.
        stop(key);
        opts.onSecond(key, null);
        if (firing.has(key)) return;
        firing.add(key);
        void (async () => {
          try {
            await run();
          } catch {
            // `run` owns its own reporting; this only stops an unhandled
            // rejection from escaping the timer.
          } finally {
            firing.delete(key);
          }
        })();
      }, 1000);
      timers.set(key, handle);
    },

    cancel(key) {
      stop(key);
      opts.onSecond(key, null);
    },

    stopAll() {
      for (const key of [...timers.keys()]) stop(key);
    },
  };
}
