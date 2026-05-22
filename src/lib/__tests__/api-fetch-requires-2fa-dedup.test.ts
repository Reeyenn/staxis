/**
 * Tests for the module-scoped dedup added to fetchWithAuth in the
 * 2026-05-22 auth audit (Phase 1, finding H2).
 *
 * Scenario this exists to catch:
 *   The dashboard renders, fans out a dozen concurrent fetchWithAuth
 *   calls. The user's staxis_device cookie is cleared (private window,
 *   manual delete, expired) but their Supabase JWT is still valid.
 *   Every single API call returns 401 { code: 'requires_2fa' }. Before
 *   this fix, every one of those 401s would independently call
 *   supabase.auth.signOut() and window.location.assign(...) — 12
 *   signOuts in flight at once, multiple navigations stomping each
 *   other, the wrong "reason" winning. After this fix, the first 401
 *   pins the redirect; all subsequent ones throw SessionEndedError
 *   silently without firing duplicate signOut/assign.
 *
 *   Also covered: the requires_2fa branch preserves the user's current
 *   path as `redirect=…` so the OTP completion can return them where
 *   they were.
 */

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchWithAuth,
  SessionEndedError,
  __resetSessionEndForTesting,
} from '@/lib/api-fetch';

// ─── Browser-globals stub ────────────────────────────────────────────────
//
// fetchWithAuth runs in browser context. node:test doesn't ship a DOM, so
// we install minimal `window` + `fetch` + `supabase` mocks just for these
// tests. Real browser tests would catch the same regressions via Playwright;
// this is the fast unit-level guard.

interface LocationLike {
  assign: (url: string) => void;
  assignCalls: string[];
  pathname: string;
  search: string;
  hash: string;
}

let location: LocationLike;
let signOutCalls = 0;
let originalWindow: typeof globalThis.window | undefined;
let originalFetch: typeof globalThis.fetch | undefined;

// Mock the supabase client that fetchWithAuth imports. Use mock.module
// or rely on the import being already-evaluated. Simpler: stub via a
// global supabase reference. fetchWithAuth imports from '@/lib/supabase';
// we mock it lazily.
beforeEach(async () => {
  signOutCalls = 0;
  location = {
    pathname: '/dashboard',
    search: '',
    hash: '',
    assignCalls: [],
    assign(url: string) {
      this.assignCalls.push(url);
    },
  };

  originalWindow = (globalThis as { window?: typeof globalThis.window }).window;
  (globalThis as { window: unknown }).window = { location };

  originalFetch = globalThis.fetch;
  // Default mock: every call 401s with requires_2fa.
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ ok: false, code: 'requires_2fa', reason: 'no_cookie' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;

  // Reset the module-scoped one-shot guard between tests.
  __resetSessionEndForTesting();

  // Stub the supabase auth methods used by fetchWithAuth + the redirect path.
  // We import the real module and replace methods on the singleton.
  const { supabase } = await import('@/lib/supabase');
  // @ts-expect-error monkey-patch test singleton
  supabase.auth.getSession = async () => ({
    data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
    error: null,
  });
  // @ts-expect-error monkey-patch
  supabase.auth.signOut = async () => {
    signOutCalls += 1;
    return { error: null };
  };
  // @ts-expect-error monkey-patch
  supabase.auth.refreshSession = async () => ({ data: { session: null }, error: null });
});

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window: unknown }).window = originalWindow;
  }
  if (originalFetch) globalThis.fetch = originalFetch;
  __resetSessionEndForTesting();
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('fetchWithAuth — requires_2fa dedup', () => {
  test('12 concurrent fetches all returning requires_2fa → exactly ONE signOut + ONE redirect', async () => {
    const N = 12;
    const promises = Array.from({ length: N }, () => fetchWithAuth('/api/protected'));
    const results = await Promise.allSettled(promises);

    // Every concurrent caller should reject with SessionEndedError.
    for (const r of results) {
      assert.equal(r.status, 'rejected');
      if (r.status === 'rejected') {
        assert.ok(r.reason instanceof SessionEndedError);
      }
    }

    // Critically: signOut + window.location.assign each fire ONCE.
    assert.equal(signOutCalls, 1, `expected exactly 1 signOut, got ${signOutCalls}`);
    assert.equal(location.assignCalls.length, 1, `expected exactly 1 redirect, got ${location.assignCalls.length}`);
  });

  test('requires_2fa redirect uses reason=2fa_required and preserves redirect=<current path>', async () => {
    location.pathname = '/dashboard';
    location.search = '?tab=rooms';
    location.hash = '#today';

    await fetchWithAuth('/api/protected').catch((e) => {
      if (!(e instanceof SessionEndedError)) throw e;
    });

    assert.equal(location.assignCalls.length, 1);
    const url = location.assignCalls[0];
    assert.match(url, /^\/signin\?/);
    const qs = new URLSearchParams(url.split('?')[1]);
    assert.equal(qs.get('reason'), '2fa_required');
    // redirect= preserves search + hash so deep links survive OTP bounce.
    assert.equal(qs.get('redirect'), '/dashboard?tab=rooms#today');
  });

  test('requires_2fa does NOT redirect when already on a /signin/* path', async () => {
    location.pathname = '/signin/verify';

    await fetchWithAuth('/api/some-call').catch((e) => {
      if (!(e instanceof SessionEndedError)) throw e;
    });

    assert.equal(signOutCalls, 0, 'signOut must not fire from /signin pages');
    assert.equal(location.assignCalls.length, 0, 'no redirect from /signin pages');
  });

  test('non-requires_2fa unknown 401 code still triggers session-ended path (regression guard)', async () => {
    // Replace the fetch mock with one returning a different unrecoverable code.
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ code: 'user_not_found' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await fetchWithAuth('/api/protected').catch((e) => {
      if (!(e instanceof SessionEndedError)) throw e;
    });

    assert.equal(location.assignCalls.length, 1);
    const qs = new URLSearchParams(location.assignCalls[0].split('?')[1]);
    assert.equal(qs.get('reason'), 'session-ended');
  });
});

// Silences "test file unused" warning when only one suite runs.
test('module-level guard sanity', () => {
  assert.equal(typeof __resetSessionEndForTesting, 'function');
  // The mock import is used to satisfy node:test runtime.
  assert.equal(typeof mock, 'object');
});
