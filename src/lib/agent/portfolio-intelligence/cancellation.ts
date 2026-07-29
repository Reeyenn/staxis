import 'server-only';

export type PortfolioQueryInterruptionReason = 'cancelled' | 'timed_out';

export class PortfolioQueryInterruptedError extends Error {
  constructor(readonly reason: PortfolioQueryInterruptionReason) {
    super(reason === 'cancelled'
      ? 'The portfolio query was cancelled before all authorized hotels could be read.'
      : 'The portfolio query exceeded its deterministic read budget before all authorized hotels could be read.');
    this.name = 'PortfolioQueryInterruptedError';
  }
}

export class PortfolioPropertyReadTimeoutError extends Error {
  constructor() {
    super('portfolio property read timed out');
    this.name = 'PortfolioPropertyReadTimeoutError';
  }
}

export function interruptionReason(input: {
  deadlineAt: number;
}): PortfolioQueryInterruptionReason {
  return Date.now() < input.deadlineAt ? 'cancelled' : 'timed_out';
}

export function throwIfPortfolioQueryInterrupted(input: {
  signal: AbortSignal;
  deadlineAt: number;
}): void {
  if (input.signal.aborted || input.deadlineAt <= Date.now()) {
    throw new PortfolioQueryInterruptedError(interruptionReason(input));
  }
}

/** One signal for the whole deterministic phase. It follows the browser
 * signal and also aborts at the absolute request-derived deadline. */
export function createPortfolioQueryAbortContext(input: {
  deadlineAt: number;
  parentSignal?: AbortSignal;
}): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.parentSignal?.reason);
  if (input.parentSignal?.aborted) abortFromParent();
  else input.parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  const remaining = input.deadlineAt - Date.now();
  const timer = remaining <= 0
    ? null
    : setTimeout(() => controller.abort(new PortfolioQueryInterruptedError('timed_out')), remaining);
  if (remaining <= 0) controller.abort(new PortfolioQueryInterruptedError('timed_out'));

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== null) clearTimeout(timer);
      input.parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

type AbortablePromiseLike<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
};

/**
 * Applies `.abortSignal(...)` to a PostgREST builder, and races it against the
 * same parent signal plus the per-property timeout. The race is needed for
 * hermetic adapters that expose only PromiseLike; production PostgREST also
 * receives the signal so the HTTP/database request itself is cancelled.
 */
export async function runAbortablePostgrest<T>(input: {
  query: AbortablePromiseLike<T>;
  signal: AbortSignal;
  deadlineAt: number;
  timeoutMs: number;
}): Promise<T> {
  throwIfPortfolioQueryInterrupted(input);
  const controller = new AbortController();
  let rejectBoundary: ((reason: unknown) => void) | null = null;
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
  const onGlobalAbort = () => {
    controller.abort(input.signal.reason);
    rejectBoundary?.(new PortfolioQueryInterruptedError(interruptionReason(input)));
  };
  input.signal.addEventListener('abort', onGlobalAbort, { once: true });
  if (input.signal.aborted) onGlobalAbort();
  const remaining = Math.max(1, Math.min(input.timeoutMs, input.deadlineAt - Date.now()));
  const timer = setTimeout(() => {
    controller.abort(new PortfolioPropertyReadTimeoutError());
    rejectBoundary?.(new PortfolioPropertyReadTimeoutError());
  }, remaining);

  try {
    const query = typeof input.query.abortSignal === 'function'
      ? input.query.abortSignal(controller.signal)
      : input.query;
    return await Promise.race([Promise.resolve(query), boundary]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', onGlobalAbort);
  }
}
