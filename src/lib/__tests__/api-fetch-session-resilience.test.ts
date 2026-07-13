/**
 * Tests for the 2026-07-13 session-resilience policy in fetchWithAuth.
 *
 * The bug this guards against: the owner was randomly hard-logged-out
 * mid-session ("/signin?reason=session-ended") because the old 401 path
 * treated ANY failed token refresh — including a one-off network blip or
 * a Supabase 5xx — as a dead session. The new policy only signs out when
 * the session is DEFINITIVELY dead:
 *   · Supabase's auth API explicitly rejects the refresh token, or
 *   · a freshly-refreshed token still 401s (after a short-delay second
 *     retry) with a server-issued identity code.
 * Transient refresh failures return the 401 to the caller (retryable
 * error, session survives). 401s without our envelope code (proxies,
 * non-requireSession layers) are never treated as session verdicts.
 *
 * Harness mirrors api-fetch-requires-2fa-dedup.test.ts — see the ESM
 * cache-key note there for why `supabase` must be imported statically.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchWithAuth,
  SessionEndedError,
  __resetSessionEndForTesting,
  __resetInFlightRefreshForTesting,
} from '@/lib/api-fetch';
import { supabase } from '@/lib/supabase';

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

type AuthMock = {
  getSession: typeof supabase.auth.getSession;
  signOut: typeof supabase.auth.signOut;
  refreshSession: typeof supabase.auth.refreshSession;
};
const authMock = supabase.auth as unknown as AuthMock;

function json401(code: string | null): Response {
  const body = code === null ? { error: 'nope' } : { ok: false, code };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

function ok200(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Install a fetch mock that returns the queued responses in order and
 *  keeps returning the last one if called more times. */
function queueFetch(...responses: (() => Response)[]): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    const idx = Math.min(calls, responses.length - 1);
    calls += 1;
    return responses[idx]();
  }) as typeof globalThis.fetch;
  return () => calls;
}

beforeEach(() => {
  signOutCalls = 0;
  location = {
    pathname: '/inventory',
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
  __resetSessionEndForTesting();
  __resetInFlightRefreshForTesting();

  authMock.getSession = (async () => ({
    data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
    error: null,
  })) as typeof supabase.auth.getSession;
  authMock.signOut = (async () => {
    signOutCalls += 1;
    return { error: null };
  }) as typeof supabase.auth.signOut;
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

const refreshSucceeds = (async () => ({
  data: {
    session: { access_token: 'refreshed-tok', expires_at: Math.floor(Date.now() / 1000) + 3600 },
    user: null,
  },
  error: null,
})) as typeof supabase.auth.refreshSession;

const refreshNetworkThrow = (async () => {
  throw new TypeError('Failed to fetch');
}) as typeof supabase.auth.refreshSession;

const refreshTransientError = (async () => ({
  data: { session: null, user: null },
  error: { status: 503, message: 'upstream unavailable', name: 'AuthRetryableFetchError' },
})) as unknown as typeof supabase.auth.refreshSession;

const refreshTerminalError = (async () => ({
  data: { session: null, user: null },
  error: { status: 400, message: 'Invalid Refresh Token: Already Used', name: 'AuthApiError' },
})) as unknown as typeof supabase.auth.refreshSession;

describe('fetchWithAuth — session survives transient refresh failures', () => {
  test('401 token_expired + refresh THROWS (network blip) → 401 returned, NO signout', async () => {
    queueFetch(() => json401('token_expired'));
    authMock.refreshSession = refreshNetworkThrow;

    const res = await fetchWithAuth('/api/protected');
    assert.equal(res.status, 401);
    assert.equal(signOutCalls, 0);
    assert.equal(location.assignCalls.length, 0);
  });

  test('401 token_expired + refresh 503s (Supabase outage) → 401 returned, NO signout', async () => {
    queueFetch(() => json401('token_expired'));
    authMock.refreshSession = refreshTransientError;

    const res = await fetchWithAuth('/api/protected');
    assert.equal(res.status, 401);
    assert.equal(signOutCalls, 0);
    assert.equal(location.assignCalls.length, 0);
  });

  test('requires_2fa + refresh fails transiently → 401 returned, NO signout', async () => {
    queueFetch(() => json401('requires_2fa'));
    authMock.refreshSession = refreshNetworkThrow;

    const res = await fetchWithAuth('/api/protected');
    assert.equal(res.status, 401);
    assert.equal(signOutCalls, 0);
    assert.equal(location.assignCalls.length, 0);
  });

  test('fresh token, first retry 401s, delayed second retry succeeds → 200, NO signout', async () => {
    const calls = queueFetch(
      () => json401('token_expired'), // original request
      () => json401('token_expired'), // immediate retry with fresh token
      () => ok200(),                  // delayed second retry
    );
    authMock.refreshSession = refreshSucceeds;

    const res = await fetchWithAuth('/api/protected');
    assert.equal(res.status, 200);
    assert.equal(calls(), 3);
    assert.equal(signOutCalls, 0);
  });

  test('401 with NO envelope code (proxy 401) survives retries → returned to caller, NO signout', async () => {
    queueFetch(() => json401(null));
    authMock.refreshSession = refreshSucceeds;

    const res = await fetchWithAuth('/api/protected');
    assert.equal(res.status, 401);
    assert.equal(signOutCalls, 0);
    assert.equal(location.assignCalls.length, 0);
  });
});

describe('fetchWithAuth — definitively dead sessions still sign out', () => {
  test('refresh token explicitly rejected by Supabase → ONE signout, reason=session-ended', async () => {
    queueFetch(() => json401('token_expired'));
    authMock.refreshSession = refreshTerminalError;

    await assert.rejects(fetchWithAuth('/api/protected'), SessionEndedError);
    assert.equal(signOutCalls, 1);
    assert.equal(location.assignCalls.length, 1);
    assert.match(location.assignCalls[0], /reason=session-ended/);
  });

  test('fresh token still 401s with identity code after both retries → signout', async () => {
    queueFetch(() => json401('token_expired')); // every call 401s
    authMock.refreshSession = refreshSucceeds;

    await assert.rejects(fetchWithAuth('/api/protected'), SessionEndedError);
    assert.equal(signOutCalls, 1);
    assert.match(location.assignCalls[0], /reason=session-ended/);
    // Deep-link back to where the user was.
    assert.match(location.assignCalls[0], /redirect=%2Finventory/);
  });

  test('requires_2fa persists after refresh+retry → signout with reason=2fa_required', async () => {
    queueFetch(() => json401('requires_2fa'));
    authMock.refreshSession = refreshSucceeds;

    await assert.rejects(fetchWithAuth('/api/protected'), SessionEndedError);
    assert.equal(signOutCalls, 1);
    assert.match(location.assignCalls[0], /reason=2fa_required/);
  });
});
