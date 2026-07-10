/**
 * Regression tests for the front-desk register silent-empty-wipe bug.
 *
 * Bug (wave-2 verified): fetchPackages / fetchLostFoundRegister returned an
 * EMPTY payload on any non-ok envelope (e.g. a transient HTTP 500), and the
 * 30s poll pushed that EMPTY payload over the real list — the Packages tab
 * flipped to "No packages held" (and L&F to "Nothing here yet") during a
 * brief server blip. The subscribe fns' "keep last good" catch only covered
 * thrown network errors, not HTTP error responses.
 *
 * Contract after the fix:
 *   1. The fetch fns THROW on a non-ok envelope (so callers' catches fire).
 *   2. subscribe* never calls onData with a fabricated empty payload on a
 *      failed poll — it keeps last good and signals the new onError hook.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchPackages, subscribePackages } from '@/lib/db/packages';
import {
  fetchLostFoundRegister,
  fetchLostFoundCounts,
  subscribeLostFound,
} from '@/lib/db/lost-and-found';

const PID = '00000000-0000-4000-8000-000000000001';

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Install a fetch stub whose response body/status we can flip per call. */
function stubFetch(next: () => { body: unknown; status: number }): void {
  globalThis.fetch = (async () => {
    const { body, status } = next();
    return jsonResponse(body, status);
  }) as typeof fetch;
}

beforeEach(() => {
  // nothing — each test installs its own stub
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('register fetches throw on error envelopes (no fake-empty payloads)', () => {
  test('fetchPackages rejects on a 500 error envelope', async () => {
    stubFetch(() => ({ body: { ok: false, error: 'db_down' }, status: 500 }));
    await assert.rejects(() => fetchPackages(PID), /packages_list_failed_500/);
  });

  test('fetchPackages rejects on 200-with-ok:false (RLS-style silent failure)', async () => {
    stubFetch(() => ({ body: { ok: false, error: 'nope' }, status: 200 }));
    await assert.rejects(() => fetchPackages(PID));
  });

  test('fetchPackages resolves with real data on a good envelope', async () => {
    const payload = { items: [{ id: 'p1' }], counts: { held: 1, pickedUp: 0 } };
    stubFetch(() => ({ body: { ok: true, data: payload }, status: 200 }));
    const got = await fetchPackages(PID);
    assert.deepEqual(got, payload);
  });

  test('fetchLostFoundRegister rejects on a 500 error envelope', async () => {
    stubFetch(() => ({ body: { ok: false, error: 'db_down' }, status: 500 }));
    await assert.rejects(() => fetchLostFoundRegister(PID), /lost_found_list_failed_500/);
  });

  test('fetchLostFoundCounts rejects instead of reporting zeros on failure', async () => {
    stubFetch(() => ({ body: { ok: false, error: 'db_down' }, status: 503 }));
    await assert.rejects(() => fetchLostFoundCounts(PID), /lost_found_counts_failed_503/);
  });
});

describe('subscribe* keeps last good data on a failed poll', () => {
  test('subscribePackages: failed refresh never emits an empty payload; onError fires', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1
        ? { body: { ok: true, data: { items: [{ id: 'p1' }], counts: { held: 1, pickedUp: 0 } } }, status: 200 }
        : { body: { ok: false, error: 'db_down' }, status: 500 };
    });

    const emitted: Array<{ items: unknown[] }> = [];
    let errors = 0;
    const unsub = subscribePackages(PID, (p) => emitted.push(p), 15, () => { errors += 1; });

    // Poll with a ref'd interval (node:test AbortSignal gotcha) until the
    // failing second poll has run.
    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (calls >= 2 && errors >= 1) { clearInterval(iv); resolve(); }
      }, 10);
    });
    unsub();

    assert.equal(emitted.length, 1, 'only the successful poll emitted data');
    assert.equal((emitted[0].items[0] as { id: string }).id, 'p1');
    assert.ok(errors >= 1, 'failed poll signalled onError');
  });

  test('subscribeLostFound: first-load failure emits nothing but signals onError', async () => {
    stubFetch(() => ({ body: { ok: false, error: 'db_down' }, status: 500 }));

    const emitted: unknown[] = [];
    let errors = 0;
    const unsub = subscribeLostFound(PID, (p) => emitted.push(p), 60_000, () => { errors += 1; });

    await new Promise<void>((resolve) => {
      const iv = setInterval(() => {
        if (errors >= 1) { clearInterval(iv); resolve(); }
      }, 10);
    });
    unsub();

    assert.equal(emitted.length, 0, 'no fake-empty payload reached the UI');
    assert.ok(errors >= 1);
  });
});
