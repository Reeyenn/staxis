/**
 * Tests for the one-time legacy localStorage → cookie migration shim.
 *
 * After the cookie migration ships, existing users have a `staxis-auth`
 * blob sitting in localStorage from the old storage backend. The shim runs
 * on app mount, extracts access_token + refresh_token, forwards them to
 * supabase.auth.setSession (which the new SSR client writes to cookies),
 * and ONLY THEN removes the legacy key. These tests pin:
 *
 *   1. valid blob + setSession returns a session → key cleared
 *   2. corrupt JSON → no setSession call, key cleared (dead data)
 *   3. blob shape without tokens → no setSession call, key cleared (dead data)
 *   4. no localStorage at all → no-op
 *   5. setSession returns {error} → key NOT cleared (data-safety, Codex HIGH)
 *   6. setSession throws → key NOT cleared (data-safety, Codex HIGH)
 *   7. setSession returns success with null session → key NOT cleared (defensive)
 *
 * The data-safety invariant in 5/6/7 is the fix for Codex's HIGH finding on
 * commit aa270b6. The earlier version cleared the legacy key in a `finally`
 * block, so a transient Supabase 5xx or revoked refresh token wiped the
 * only copy of the user's session.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabase } from '@/lib/supabase';
import { migrateLegacySessionIfPresent } from '@/lib/auth-storage-migration';

// ─── Test-time mocking ────────────────────────────────────────────────────

const LEGACY_KEY = 'staxis-auth';

type SetSessionArgs = { access_token: string; refresh_token: string };
type SetSessionResult = {
  data: { session: { access_token: string; refresh_token: string } | null; user: unknown };
  error: { message: string; status?: number; name?: string } | null;
};
type SetSessionFn = (args: SetSessionArgs) => Promise<SetSessionResult>;

const originalSetSession = supabase.auth.setSession.bind(supabase.auth);
let setSessionCalls: SetSessionArgs[] = [];
let nextSetSession: SetSessionFn;

// Minimal localStorage shim — node:test runs in node, so `window.localStorage`
// is undefined by default. The shim checks `typeof window === 'undefined'`
// and bails, so we have to install a window too.
type StorageLike = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
  _store: Map<string, string>;
};

function makeStorage(): StorageLike {
  const store = new Map<string, string>();
  return {
    _store: store,
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => { store.set(k, v); },
    removeItem: (k) => { store.delete(k); },
  };
}

let storage: StorageLike;
const originalWindow = (globalThis as { window?: unknown }).window;
const originalConsoleError = console.error;

beforeEach(() => {
  storage = makeStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage } as unknown;

  setSessionCalls = [];
  // Default mock: setSession succeeds and returns a session. Individual
  // tests override `nextSetSession` to simulate failure modes.
  nextSetSession = async (args: SetSessionArgs) => ({
    data: { session: { access_token: args.access_token, refresh_token: args.refresh_token }, user: {} },
    error: null,
  });

  (supabase.auth as unknown as { setSession: SetSessionFn }).setSession =
    async (args: SetSessionArgs) => {
      setSessionCalls.push(args);
      return nextSetSession(args);
    };

  // Silence console.error so the test output isn't cluttered when we
  // intentionally exercise the failure paths.
  console.error = () => {};
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (supabase.auth as unknown as { setSession: typeof originalSetSession }).setSession = originalSetSession;
  console.error = originalConsoleError;
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('migrateLegacySessionIfPresent — happy paths', () => {
  test('supabase-js v2 shape with currentSession → setSession called + key cleared', async () => {
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify({
        currentSession: {
          access_token: 'AT-123',
          refresh_token: 'RT-456',
          user: { id: 'uuid' },
        },
      }),
    );

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 1);
    assert.deepEqual(setSessionCalls[0], { access_token: 'AT-123', refresh_token: 'RT-456' });
    assert.equal(storage.getItem(LEGACY_KEY), null, 'legacy key should be removed on confirmed session');
  });

  test('bare session object (newer shape) → setSession called + key cleared', async () => {
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify({ access_token: 'A', refresh_token: 'R', user: { id: 'u' } }),
    );

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 1);
    assert.deepEqual(setSessionCalls[0], { access_token: 'A', refresh_token: 'R' });
    assert.equal(storage.getItem(LEGACY_KEY), null);
  });
});

describe('migrateLegacySessionIfPresent — no-op paths', () => {
  test('no legacy entry → no-op, no setSession call', async () => {
    await migrateLegacySessionIfPresent();
    assert.equal(setSessionCalls.length, 0);
  });

  test('SSR context (no window) → no-op', async () => {
    (globalThis as { window?: unknown }).window = undefined;
    await migrateLegacySessionIfPresent();
    assert.equal(setSessionCalls.length, 0);
  });
});

describe('migrateLegacySessionIfPresent — corrupt or dead data is cleared', () => {
  test('corrupt JSON → no setSession call, key cleared', async () => {
    storage.setItem(LEGACY_KEY, '{not json');

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 0);
    assert.equal(storage.getItem(LEGACY_KEY), null, 'corrupt key should be cleared (dead data)');
  });

  test('blob missing tokens → no setSession call, key cleared', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify({ user: { id: 'u' } }));

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 0);
    assert.equal(storage.getItem(LEGACY_KEY), null);
  });

  test('partial tokens (access only, no refresh) → no setSession call, key cleared', async () => {
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify({ currentSession: { access_token: 'A' } }),
    );

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 0);
    assert.equal(storage.getItem(LEGACY_KEY), null);
  });
});

describe('migrateLegacySessionIfPresent — failure paths preserve legacy data (Codex HIGH fix)', () => {
  const validBlob = JSON.stringify({
    currentSession: { access_token: 'AT-fail', refresh_token: 'RT-fail' },
  });

  test('setSession returns {error} → legacy key intact', async () => {
    storage.setItem(LEGACY_KEY, validBlob);
    nextSetSession = async () => ({
      data: { session: null, user: null },
      error: { message: 'invalid_grant', status: 400, name: 'AuthApiError' },
    });

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 1, 'setSession should have been called');
    assert.equal(
      storage.getItem(LEGACY_KEY),
      validBlob,
      'legacy key MUST survive when setSession rejected — Codex HIGH finding',
    );
  });

  test('setSession throws → legacy key intact', async () => {
    storage.setItem(LEGACY_KEY, validBlob);
    nextSetSession = async () => {
      throw new Error('network down');
    };

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 1);
    assert.equal(
      storage.getItem(LEGACY_KEY),
      validBlob,
      'legacy key MUST survive when setSession threw — Codex HIGH finding',
    );
  });

  test('setSession returns success but null session → legacy key intact', async () => {
    // Defensive: shouldn't happen per auth-js semantics, but cheap to pin.
    storage.setItem(LEGACY_KEY, validBlob);
    nextSetSession = async () => ({
      data: { session: null, user: null },
      error: null,
    });

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 1);
    assert.equal(
      storage.getItem(LEGACY_KEY),
      validBlob,
      'legacy key MUST survive when setSession returned no session',
    );
  });
});
