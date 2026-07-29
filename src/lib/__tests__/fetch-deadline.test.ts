import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  composeAbortSignals,
  createDeadlineAbortScope,
  fetchWithDeadline,
  requestAbortSignals,
  RequestTimeoutError,
  raceWithAbortSignal,
  withPromiseDeadline,
} from '@/lib/fetch-deadline';

describe('AbortSignal composition', () => {
  test('preserves both Request.signal and init.signal', () => {
    const fromRequest = new AbortController();
    const fromInit = new AbortController();
    const request = new Request('https://example.test/data', { signal: fromRequest.signal });

    // Request clones the supplied signal, so compare with request.signal (the
    // signal fetch actually carries), not the controller's original object.
    assert.deepEqual(
      requestAbortSignals(request, { signal: fromInit.signal }),
      [request.signal, fromInit.signal],
    );

    const composed = composeAbortSignals([request.signal, fromInit.signal]);
    assert.ok(composed);
    fromInit.abort(new DOMException('caller cancelled', 'AbortError'));
    assert.equal(composed.aborted, true);
    assert.equal((composed.reason as Error).name, 'AbortError');
  });

  test('deduplicates the same signal', () => {
    const controller = new AbortController();
    assert.equal(composeAbortSignals([controller.signal, controller.signal]), controller.signal);
  });
});

describe('Promise deadlines', () => {
  test('a never-resolving Promise reaches a typed terminal timeout', async () => {
    await assert.rejects(
      withPromiseDeadline(new Promise<never>(() => {}), {
        timeoutMs: 25,
        label: 'Session check',
      }),
      (error: Error) => {
        assert.ok(error instanceof RequestTimeoutError);
        assert.equal(error.code, 'request_timeout');
        assert.match(error.message, /Session check timed out/);
        return true;
      },
    );
  });

  test('caller cancellation wins without being mislabeled as a timeout', async () => {
    const caller = new AbortController();
    const pending = withPromiseDeadline(new Promise<never>(() => {}), {
      timeoutMs: 200,
      signals: [caller.signal],
    });
    caller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  });

  test('a deadline scope also terminates work that ignores its signal', async () => {
    const scope = createDeadlineAbortScope({ timeoutMs: 25, label: 'Navigation data' });
    try {
      await assert.rejects(
        raceWithAbortSignal(new Promise<never>(() => {}), scope.signal),
        (error: Error) => error instanceof RequestTimeoutError,
      );
    } finally {
      scope.dispose();
    }
  });
});

describe('fetchWithDeadline', () => {
  test('aborts a hung fetch at the deadline', async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const timer = setInterval(() => {
          if (init?.signal?.aborted) {
            clearInterval(timer);
            reject(init.signal.reason);
          }
        }, 2);
      });
    }) as typeof fetch;

    await assert.rejects(
      fetchWithDeadline('https://example.test/hung', undefined, {
        timeoutMs: 25,
        label: 'Database request',
        fetchImpl,
      }),
      (error: Error) => error instanceof RequestTimeoutError
        && /Database request timed out/.test(error.message),
    );
  });

  test('caller abort remains an AbortError', async () => {
    const caller = new AbortController();
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return raceWithAbortSignal(new Promise<Response>(() => {}), init?.signal ?? undefined);
    }) as typeof fetch;
    const pending = fetchWithDeadline('https://example.test/data', { signal: caller.signal }, {
      timeoutMs: 200,
      fetchImpl,
    });
    caller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  });
});
