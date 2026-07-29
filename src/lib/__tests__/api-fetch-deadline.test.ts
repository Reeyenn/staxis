import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetInFlightRefreshForTesting,
  __resetSessionEndForTesting,
  __setAuthOperationTimeoutForTesting,
  fetchWithAuth,
} from '@/lib/api-fetch';
import { RequestTimeoutError } from '@/lib/fetch-deadline';
import { supabase } from '@/lib/supabase';

type AuthMock = {
  getSession: typeof supabase.auth.getSession;
  refreshSession: typeof supabase.auth.refreshSession;
  signOut: typeof supabase.auth.signOut;
};

const authMock = supabase.auth as unknown as AuthMock;
const originalAuth = {
  getSession: authMock.getSession,
  refreshSession: authMock.refreshSession,
  signOut: authMock.signOut,
};
const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: typeof globalThis.window }).window;
let signOutCalls = 0;

function validSession() {
  return {
    data: {
      session: {
        access_token: 'token',
        expires_at: Math.floor(Date.now() / 1000) + 3_600,
      },
    },
    error: null,
  };
}

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function expired(): Response {
  return new Response(JSON.stringify({ ok: false, code: 'token_expired' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  __resetInFlightRefreshForTesting();
  __resetSessionEndForTesting();
  __setAuthOperationTimeoutForTesting(25);
  signOutCalls = 0;

  (globalThis as { window: unknown }).window = {
    location: {
      pathname: '/inventory',
      search: '',
      hash: '',
      assign() {},
    },
  };
  authMock.getSession = (async () => validSession()) as typeof supabase.auth.getSession;
  authMock.refreshSession = (async () => ({
    data: {
      session: {
        access_token: 'fresh-token',
        expires_at: Math.floor(Date.now() / 1000) + 3_600,
      },
      user: null,
    },
    error: null,
  })) as typeof supabase.auth.refreshSession;
  authMock.signOut = (async () => {
    signOutCalls += 1;
    return { error: null };
  }) as typeof supabase.auth.signOut;
  globalThis.fetch = (async () => ok()) as typeof fetch;
});

afterEach(() => {
  authMock.getSession = originalAuth.getSession;
  authMock.refreshSession = originalAuth.refreshSession;
  authMock.signOut = originalAuth.signOut;
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window: unknown }).window = originalWindow;
  __resetInFlightRefreshForTesting();
  __resetSessionEndForTesting();
  __setAuthOperationTimeoutForTesting();
});

describe('fetchWithAuth deadlines', () => {
  test('a hung getSession reaches a retryable terminal error without sending or signing out', async () => {
    let fetchCalls = 0;
    authMock.getSession = (() => new Promise(() => {})) as typeof supabase.auth.getSession;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return ok();
    }) as typeof fetch;

    await assert.rejects(
      fetchWithAuth('/api/inventory', { timeoutMs: 200 }),
      (error: Error) => error instanceof RequestTimeoutError
        && /Session check timed out/.test(error.message),
    );
    assert.equal(fetchCalls, 0, 'must not turn an auth timeout into an unauthenticated request');
    assert.equal(signOutCalls, 0, 'a timeout is transient, never a dead-session verdict');
  });

  test('a hung navigation GET terminates at its end-to-end request budget', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
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
      fetchWithAuth('/api/inventory', { timeoutMs: 30 }),
      (error: Error) => error instanceof RequestTimeoutError
        && /Request timed out/.test(error.message),
    );
  });

  test('an explicitly bounded auth POST also aborts a stalled response body', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          signal?.addEventListener('abort', () => {
            controller.error(signal.reason);
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const response = await fetchWithAuth('/api/auth/check-trust', {
      method: 'POST',
      headers: { Authorization: 'Bearer sign-in-token' },
      timeoutMs: 30,
    });
    // Node's native AbortSignal.timeout timer is unref'ed. Keep the test event
    // loop alive long enough to observe the response-body abort just as a
    // browser page naturally would.
    const keepAlive = setInterval(() => {}, 5);
    try {
      await assert.rejects(
        response.json(),
        (error: Error) => error.name === 'TimeoutError'
          || error instanceof RequestTimeoutError,
      );
    } finally {
      clearInterval(keepAlive);
    }
    assert.equal(signOutCalls, 0, 'the pre-session trust read must never run session recovery');
  });

  test('a hung refresh settles as transient, and the next request can succeed without hard refresh', async () => {
    globalThis.fetch = (async () => expired()) as typeof fetch;
    authMock.refreshSession = (() => new Promise(() => {})) as typeof supabase.auth.refreshSession;

    const first = await fetchWithAuth('/api/staff', { timeoutMs: 200 });
    assert.equal(first.status, 401, 'refresh timeout should surface the retryable server response');
    assert.equal(signOutCalls, 0);

    __resetInFlightRefreshForTesting();
    globalThis.fetch = (async () => ok()) as typeof fetch;
    const second = await fetchWithAuth('/api/staff', { timeoutMs: 200 });
    assert.equal(second.status, 200, 'later navigation must work without reloading the document');
  });

  test('mutations have no implicit network deadline', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal;
      await new Promise((resolve) => setTimeout(resolve, 45));
      return ok();
    }) as typeof fetch;

    const response = await fetchWithAuth('/api/upload', {
      method: 'POST',
      body: 'large-body-placeholder',
    });
    assert.equal(response.status, 200);
    assert.equal(capturedSignal, undefined, 'write/upload transport remains caller-budgeted');
  });

  test('caller cancellation wins over the navigation timeout', async () => {
    const caller = new AbortController();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        const timer = setInterval(() => {
          if (init?.signal?.aborted) {
            clearInterval(timer);
            reject(init.signal.reason);
          }
        }, 2);
      });
    }) as typeof fetch;

    const pending = fetchWithAuth('/api/dashboard', {
      signal: caller.signal,
      timeoutMs: 200,
    });
    caller.abort(new DOMException('route changed', 'AbortError'));
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  });
});
