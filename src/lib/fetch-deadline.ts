/**
 * Browser-safe request deadlines and AbortSignal composition.
 *
 * Fetch accepts only one signal, while callers commonly have two already:
 * the signal carried by a Request and an init.signal supplied by the current
 * component. A deadline is a third. This module composes all three without
 * dropping any of them and also provides a prompt Promise race for APIs that
 * do not accept a signal themselves (notably supabase.auth.getSession()).
 */

export class RequestTimeoutError extends Error {
  readonly code = 'request_timeout';
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out. Check your connection and try again.`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).addEventListener === 'function',
  );
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

/** Signals carried by both accepted fetch inputs. Neither may replace the other. */
export function requestAbortSignals(
  input: RequestInfo | URL,
  init?: RequestInit,
): AbortSignal[] {
  const signals: AbortSignal[] = [];
  const requestSignal = typeof input === 'object' && input !== null
    ? (input as { signal?: unknown }).signal
    : undefined;
  if (isAbortSignal(requestSignal)) signals.push(requestSignal);
  if (isAbortSignal(init?.signal)) signals.push(init.signal);
  return [...new Set(signals)];
}

/**
 * Return one signal that aborts when any input signal aborts.
 *
 * AbortSignal.any is the native, lifetime-safe implementation. The fallback
 * keeps support for older Safari builds; its listeners are one-shot and are
 * removed together as soon as the first signal wins.
 */
export function composeAbortSignals(
  signals: readonly (AbortSignal | null | undefined)[],
): AbortSignal | undefined {
  const active = [...new Set(signals.filter(isAbortSignal))];
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);

  const controller = new AbortController();
  const onAbort = (event: Event) => {
    const source = event.target;
    if (isAbortSignal(source) && !controller.signal.aborted) {
      controller.abort(abortReason(source));
    }
    for (const signal of active) signal.removeEventListener('abort', onAbort);
  };
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      return controller.signal;
    }
  }
  for (const signal of active) {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/** AbortSignal.timeout with a small fallback for older Safari releases. */
export function timeoutAbortSignal(timeoutMs: number): AbortSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
  }, timeoutMs);
  return controller.signal;
}

/** Reject promptly on abort even when the wrapped Promise ignores its signal. */
export function raceWithAbortSignal<T>(
  promise: PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

export interface DeadlineAbortScope {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  dispose(): void;
}

/**
 * A cancellable scope for work that must include response-body processing.
 * Unlike AbortSignal.timeout, its timer is disposable once all work settles.
 */
export function createDeadlineAbortScope(options: {
  timeoutMs: number | null;
  label?: string;
  signals?: readonly (AbortSignal | null | undefined)[];
}): DeadlineAbortScope {
  const { timeoutMs, label = 'Request', signals = [] } = options;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new RangeError('timeoutMs must be a positive finite number or null');
  }

  const controller = new AbortController();
  const external = composeAbortSignals(signals);
  const onExternalAbort = () => {
    if (external && !controller.signal.aborted) controller.abort(abortReason(external));
  };
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = timeoutMs === null
    ? null
    : setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new RequestTimeoutError(label, timeoutMs));
      }
    }, timeoutMs);

  const dispose = () => {
    if (timer !== null) clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  };

  return {
    signal: controller.signal,
    abort(reason = new DOMException('The operation was aborted', 'AbortError')) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose,
  };
}

/** Apply a deadline to a Promise, including Promises with no cancellation API. */
export async function withPromiseDeadline<T>(
  promise: PromiseLike<T>,
  options: {
    timeoutMs: number;
    label?: string;
    signals?: readonly (AbortSignal | null | undefined)[];
  },
): Promise<T> {
  const scope = createDeadlineAbortScope({
    timeoutMs: options.timeoutMs,
    label: options.label,
    signals: options.signals,
  });
  try {
    return await raceWithAbortSignal(promise, scope.signal);
  } finally {
    scope.dispose();
  }
}

export interface FetchDeadlineOptions {
  timeoutMs: number;
  label?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch with an upper bound while preserving Request.signal and init.signal.
 * The timeout signal deliberately remains attached after response headers so
 * a stalled response body is aborted too.
 */
export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: FetchDeadlineOptions,
): Promise<Response> {
  const { timeoutMs, label = 'Request', fetchImpl = globalThis.fetch } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }

  const timeoutSignal = timeoutAbortSignal(timeoutMs);
  const signal = composeAbortSignals([
    ...requestAbortSignals(input, init),
    timeoutSignal,
  ]);
  const requestInit = { ...init, signal };

  try {
    return await raceWithAbortSignal(fetchImpl(input, requestInit), signal);
  } catch (error) {
    if (timeoutSignal.aborted) throw new RequestTimeoutError(label, timeoutMs);
    throw error;
  }
}
