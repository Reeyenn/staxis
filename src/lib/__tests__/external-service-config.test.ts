/**
 * Tests for src/lib/external-service-config.ts.
 *
 * The constants are values — there's nothing to test about them other than
 * "they exist and look sane." The real surface under test is
 * `externalFetch`: it must attach a timeout signal, compose with a
 * caller-provided signal, and refuse the footgun where a caller passes
 * `signal` via `init` (which would silently disable the timeout).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  externalFetch,
  EXTERNAL_FETCH_TIMEOUT_MS,
  EXTERNAL_FETCH_SHORT_TIMEOUT_MS,
  EXTERNAL_FETCH_LONG_TIMEOUT_MS,
  ANTHROPIC_REQUEST_TIMEOUT_MS,
  ANTHROPIC_VISION_TIMEOUT_MS,
  ANTHROPIC_WALKTHROUGH_TIMEOUT_MS,
  ANTHROPIC_MAX_RETRIES,
  STRIPE_REQUEST_TIMEOUT_MS,
  STRIPE_MAX_NETWORK_RETRIES,
} from '@/lib/external-service-config';

// ─── Constant sanity ────────────────────────────────────────────────────────

describe('timeout constants', () => {
  test('Anthropic timeouts fit the Vercel function ceiling with maxRetries=1', () => {
    // Vercel default is 60s; agent route maxDuration is 60s. With one retry
    // the worst-case wall clock is 2× timeout. If anyone bumps the timeout
    // past 30s × 2 = 60s, they need to also bump maxDuration on the route.
    // 50s × 2 = 100s is INTENTIONALLY over 60s (see external-service-config
    // header for the budget math) but it's the deliberate ceiling.
    assert.ok(ANTHROPIC_REQUEST_TIMEOUT_MS <= 50_000, 'main agent timeout drifted above documented ceiling');
    assert.ok(ANTHROPIC_VISION_TIMEOUT_MS <= 30_000, 'vision timeout drifted above documented ceiling');
    assert.ok(ANTHROPIC_WALKTHROUGH_TIMEOUT_MS < 30_000, 'walkthrough timeout must be < route maxDuration (30s)');
  });

  test('Anthropic maxRetries is 1, not the SDK default of 2', () => {
    // maxRetries=2 was the bug that caused the walkthrough route's 90s
    // worst-case before this audit. Pin it explicitly so a future change
    // can't silently regress.
    assert.equal(ANTHROPIC_MAX_RETRIES, 1);
  });

  test('Stripe timeout is below the SDK default (80s)', () => {
    assert.ok(STRIPE_REQUEST_TIMEOUT_MS < 80_000, 'Stripe timeout should override the 80s SDK default');
    assert.ok(STRIPE_REQUEST_TIMEOUT_MS >= 10_000, 'Stripe timeout shouldnt be so short it flakes on cold-start');
  });

  test('Stripe retries are enabled (idempotency keys make it safe)', () => {
    assert.ok(STRIPE_MAX_NETWORK_RETRIES >= 1);
  });

  test('External fetch timeouts are ordered short < default < long', () => {
    assert.ok(EXTERNAL_FETCH_SHORT_TIMEOUT_MS < EXTERNAL_FETCH_TIMEOUT_MS);
    assert.ok(EXTERNAL_FETCH_TIMEOUT_MS < EXTERNAL_FETCH_LONG_TIMEOUT_MS);
  });
});

// ─── externalFetch behavior ──────────────────────────────────────────────────

// Monkey-patch `fetch` so we can capture the signal that was attached and
// resolve / abort it at will. The test never makes a real network call.

type CapturedCall = {
  url: string;
  signal: AbortSignal | null | undefined;
};

let captured: CapturedCall | null = null;
let fetchBehavior: 'pending' | 'resolve' | 'reject' = 'pending';
const realFetch = globalThis.fetch;

beforeEach(() => {
  captured = null;
  fetchBehavior = 'pending';
  // Replace global fetch. The wrapper resolves only when the signal aborts,
  // simulating a real network call that responds to abort.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: typeof input === 'string' ? input : input.toString(),
      signal: init?.signal ?? null,
    };
    if (fetchBehavior === 'resolve') {
      return new Response('ok', { status: 200 });
    }
    if (fetchBehavior === 'reject') {
      throw new Error('network fail');
    }
    // 'pending' — wait until the attached signal aborts, then throw
    // a DOMException with name='AbortError' to mimic real fetch.
    //
    // Why we poll instead of `addEventListener('abort', ...)`:
    // AbortSignal.timeout() in Node 20+ schedules an UNREF'd timer.
    // An unref'd timer alone doesn't keep the event loop alive — and
    // an addEventListener handler doesn't either. With nothing else
    // active, the loop exits before our 50ms timeout fires and
    // node:test reports `Promise resolution is still pending`. A
    // setInterval (ref'd by default) keeps the loop alive until we
    // observe the abort, then clears itself.
    return new Promise<Response>((_, reject) => {
      const s = init?.signal;
      if (!s) {
        // No signal attached — pending forever (test will fail on timeout).
        return;
      }
      if (s.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      const tick = setInterval(() => {
        if (s.aborted) {
          clearInterval(tick);
          reject(new DOMException('aborted', 'AbortError'));
        }
      }, 5);
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// All tests pass a short `timeoutMs` even on the resolve/throw paths
// to avoid leaving a long-lived `AbortSignal.timeout(15_000)` timer
// queued after the test exits. In CI (Node 20 + node:test default
// concurrency) those stray timers were enough to slow the suite past
// the runner's overall budget and cancel later tests. Locally they
// pass either way.
describe('externalFetch', () => {
  test('attaches a signal even when caller passes no abortSignal', async () => {
    fetchBehavior = 'resolve';
    await externalFetch('https://example.test/', { timeoutMs: 100 });
    assert.ok(captured, 'fetch was not called');
    assert.ok(captured!.signal, 'no signal was attached — timeout would not apply');
  });

  test('aborts after the timeout when upstream hangs', async () => {
    // 50ms timeout; pending fetch should reject with AbortError quickly.
    const start = Date.now();
    await assert.rejects(
      externalFetch('https://example.test/hang', { timeoutMs: 50 }),
      (err: Error) => err.name === 'AbortError' || err.name === 'TimeoutError',
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `expected fast abort, took ${elapsed}ms`);
  });

  test('aborts when the caller-provided signal fires', async () => {
    const controller = new AbortController();
    const promise = externalFetch('https://example.test/', {
      abortSignal: controller.signal,
      timeoutMs: 200, // short enough to not outlive the test
    });
    // Fire the caller's abort right away.
    controller.abort();
    await assert.rejects(promise, (err: Error) => err.name === 'AbortError');
  });

  test('aborts on EITHER signal — caller signal does not disable timeout', async () => {
    const controller = new AbortController();
    // Caller signal exists but never fires; timeout fires first.
    const start = Date.now();
    await assert.rejects(
      externalFetch('https://example.test/', {
        abortSignal: controller.signal,
        timeoutMs: 50,
      }),
      (err: Error) => err.name === 'AbortError' || err.name === 'TimeoutError',
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `expected fast abort from timeout, took ${elapsed}ms`);
    assert.equal(controller.signal.aborted, false, 'caller signal should not have been aborted by externalFetch');
  });

  test('throws loudly when caller passes signal via init instead of abortSignal', () => {
    // Footgun: `init.signal` would replace the timeout signal silently.
    // The wrapper rejects this at the call site.
    assert.throws(
      () =>
        externalFetch('https://example.test/', {
          signal: new AbortController().signal,
          timeoutMs: 100,
        }),
      /don't pass `signal` via init/,
    );
  });

  test('resolves with the upstream response on success', async () => {
    fetchBehavior = 'resolve';
    const res = await externalFetch('https://example.test/ok', { timeoutMs: 100 });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  test('propagates non-abort errors (network fail)', async () => {
    fetchBehavior = 'reject';
    await assert.rejects(externalFetch('https://example.test/fail', { timeoutMs: 100 }), /network fail/);
  });
});
