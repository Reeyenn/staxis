/**
 * Tests for the one-time legacy localStorage → cookie migration shim.
 *
 * After the cookie migration ships, existing users have a `staxis-auth`
 * blob sitting in localStorage from the old storage backend. The shim runs
 * on app mount, extracts access_token + refresh_token, forwards them to
 * supabase.auth.setSession (which the new SSR client writes to cookies),
 * and removes the legacy key. These tests pin:
 *   1. valid blob → setSession called with the right tokens
 *   2. corrupt JSON → no throw, key still removed
 *   3. blob shape without tokens → no setSession call, key still removed
 *   4. no localStorage at all → no-op
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabase } from '@/lib/supabase';
import { migrateLegacySessionIfPresent } from '@/lib/auth-storage-migration';

// ─── Test-time mocking ────────────────────────────────────────────────────

const LEGACY_KEY = 'staxis-auth';

type SetSessionArgs = { access_token: string; refresh_token: string };
const originalSetSession = supabase.auth.setSession.bind(supabase.auth);
let setSessionCalls: SetSessionArgs[] = [];

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

beforeEach(() => {
  storage = makeStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage } as unknown;

  setSessionCalls = [];
  (supabase.auth as unknown as { setSession: (args: SetSessionArgs) => Promise<unknown> }).setSession =
    async (args: SetSessionArgs) => {
      setSessionCalls.push(args);
      return { data: { session: null, user: null }, error: null };
    };
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (supabase.auth as unknown as { setSession: typeof originalSetSession }).setSession = originalSetSession;
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('migrateLegacySessionIfPresent', () => {
  test('happy path — supabase-js v2 shape with currentSession', async () => {
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
    assert.equal(storage.getItem(LEGACY_KEY), null, 'legacy key should be removed');
  });

  test('happy path — bare session object (newer shape)', async () => {
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify({ access_token: 'A', refresh_token: 'R', user: { id: 'u' } }),
    );

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 1);
    assert.deepEqual(setSessionCalls[0], { access_token: 'A', refresh_token: 'R' });
    assert.equal(storage.getItem(LEGACY_KEY), null);
  });

  test('no legacy entry → no-op, no setSession call', async () => {
    await migrateLegacySessionIfPresent();
    assert.equal(setSessionCalls.length, 0);
  });

  test('corrupt JSON → no throw, key removed', async () => {
    storage.setItem(LEGACY_KEY, '{not json');

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 0);
    assert.equal(storage.getItem(LEGACY_KEY), null, 'corrupt key should still be cleared');
  });

  test('blob missing tokens → no setSession call, key removed', async () => {
    storage.setItem(LEGACY_KEY, JSON.stringify({ user: { id: 'u' } }));

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 0);
    assert.equal(storage.getItem(LEGACY_KEY), null);
  });

  test('partial tokens (access only, no refresh) → no setSession call, key removed', async () => {
    storage.setItem(
      LEGACY_KEY,
      JSON.stringify({ currentSession: { access_token: 'A' } }),
    );

    await migrateLegacySessionIfPresent();

    assert.equal(setSessionCalls.length, 0);
    assert.equal(storage.getItem(LEGACY_KEY), null);
  });

  test('SSR context (no window) → no-op', async () => {
    (globalThis as { window?: unknown }).window = undefined;
    await migrateLegacySessionIfPresent();
    assert.equal(setSessionCalls.length, 0);
  });
});
