/**
 * /api/auth/check-trust must bind the session it just trusted.
 *
 * THE HOLE THIS PINS (auth sweep 2026-08-07).
 *
 * There are two doors into a hotel's data:
 *
 *   Door B — `requireSession` / `validateDeviceTrust` — guards `/api/*` and
 *   accepts the `staxis_device` cookie.
 *
 *   Door A — the ~117 RLS policies calling `public.mfa_verified_or_grace()` —
 *   guards PostgREST and Realtime, which the browser talks to DIRECTLY on the
 *   Supabase origin using the public anon key. Door A reads the `mfa_verified`
 *   JWT claim, and `custom_access_token_hook` mints that claim ONLY when a
 *   `mfa_verified_sessions` row exists for the session id.
 *
 * Only `/api/auth/trust-device` (the fresh-OTP path) ever wrote that row. The
 * returning user on a trusted device comes through check-trust instead, so
 * their session never got the claim. That is why the database still has to
 * treat a MISSING claim as verified, and that permissive default is what lets
 * a session built from a stolen password alone satisfy every RLS 2FA gate:
 * it has no claim either.
 *
 * Migration 0162 was written to remove the permissive default and could not be
 * applied for exactly this reason (see the header of 0311). Writing the row
 * here is the prerequisite, and it grants nothing new: the caller has already
 * presented a valid, non-expired trusted_devices cookie, which is what Door B
 * accepts on its own.
 *
 * These tests exercise the real POST handler.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { POST } from '@/app/api/auth/check-trust/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { hashDeviceToken } from '@/lib/trusted-device';
import { invalidateTwoFactorCache } from '@/lib/two-factor';

type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;

const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

const USER_ID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_ID = '77777777-6666-4555-8444-333333333333';
const DEVICE_TOKEN = 'f'.repeat(64);

/** A three-part JWT whose payload carries the session_id the hook keys on. */
function jwtWithSessionId(sessionId: string | null): string {
  const payload = sessionId === null
    ? { sub: USER_ID }
    : { sub: USER_ID, session_id: sessionId };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${b64}.signature`;
}

interface MfaInsert { session_id: string; user_id: string }

interface MockState {
  mfaInserts: MfaInsert[];
  mfaInsertError: { message: string; code?: string } | null;
  deviceRow: { id: string; expires_at: string; absolute_expires_at: string } | null;
}

const state: MockState = { mfaInserts: [], mfaInsertError: null, deviceRow: null };

beforeEach(() => {
  invalidateTwoFactorCache();
  state.mfaInserts = [];
  state.mfaInsertError = null;
  state.deviceRow = {
    id: 'device-1',
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: USER_ID } },
    error: null,
  })) as unknown as GetUserFn;

  // The privileged-refusal branch only runs for skip_2fa accounts; this one is
  // not, so the canonical resolver is never consulted. Fail loudly if it is.
  supabaseAdmin.rpc = (async (fn: string) => {
    throw new Error(`unexpected rpc: ${fn}`);
  }) as unknown as RpcFn;

  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'app_settings') {
      // 2FA ON. With the global switch off, check-trust short-circuits before
      // the cookie path and there is no session to bind.
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { two_factor_enabled: true }, error: null }) }),
        }),
      };
    }
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: ACCOUNT_ID, skip_2fa: false, role: 'general_manager' },
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === 'trusted_devices') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.deviceRow, error: null }) }),
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === 'mfa_verified_sessions') {
      return {
        insert: async (row: MfaInsert) => {
          if (state.mfaInsertError) return { error: state.mfaInsertError };
          state.mfaInserts.push(row);
          return { error: null };
        },
      };
    }
    if (table === 'app_events') {
      return { insert: async () => ({ error: null }) };
    }
    throw new Error(`unexpected table: ${table}`);
  };
});

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  invalidateTwoFactorCache();
});

function mockReq(opts: { jwt: string; deviceCookie?: string }): import('next/server').NextRequest {
  const headers = new Headers({
    authorization: `Bearer ${opts.jwt}`,
    'content-type': 'application/json',
  });
  const cookies = new Map<string, { value: string }>();
  if (opts.deviceCookie) cookies.set('staxis_device', { value: opts.deviceCookie });
  return {
    url: 'https://staxis.test/api/auth/check-trust',
    method: 'POST',
    headers: { get: (name: string) => headers.get(name) },
    cookies: { get: (name: string) => cookies.get(name) ?? undefined },
    json: async () => ({}),
  } as unknown as import('next/server').NextRequest;
}

describe('check-trust binds the trusted session so RLS agrees with the API gate', () => {
  test('a valid device cookie writes an mfa_verified_sessions row for THIS session', async () => {
    const res = await POST(mockReq({ jwt: jwtWithSessionId(SESSION_ID), deviceCookie: DEVICE_TOKEN }));
    const body = await res.json() as { data?: { trusted?: boolean } };

    assert.equal(body.data?.trusted, true, 'a valid, non-expired device cookie must still be trusted');
    assert.equal(
      state.mfaInserts.length,
      1,
      'check-trust must record the per-session verification — without it the JWT carries no '
      + 'mfa_verified claim and the database has to keep treating a missing claim as verified',
    );
    assert.equal(state.mfaInserts[0]?.session_id, SESSION_ID);
    assert.equal(state.mfaInserts[0]?.user_id, USER_ID);
  });

  test('a duplicate row (23505) is success, not failure — the session is already bound', async () => {
    state.mfaInsertError = { message: 'duplicate key', code: '23505' };
    const res = await POST(mockReq({ jwt: jwtWithSessionId(SESSION_ID), deviceCookie: DEVICE_TOKEN }));
    const body = await res.json() as { data?: { trusted?: boolean } };
    assert.equal(body.data?.trusted, true, 'a second check-trust for the same session must stay trusted');
  });

  test('a persistent write failure refuses trust rather than handing back a session RLS will deny', async () => {
    state.mfaInsertError = { message: 'connection reset', code: '08006' };
    const res = await POST(mockReq({ jwt: jwtWithSessionId(SESSION_ID), deviceCookie: DEVICE_TOKEN }));
    const body = await res.json() as { data?: { trusted?: boolean } };
    assert.equal(
      body.data?.trusted,
      false,
      'without the row this session cannot satisfy the database gate, so the honest answer '
      + 'is "not trusted" and one OTP, not a 200 into an app whose every read denies',
    );
  });

  test('no device cookie means no binding — trust is not invented for an unverified session', async () => {
    const res = await POST(mockReq({ jwt: jwtWithSessionId(SESSION_ID) }));
    const body = await res.json() as { data?: { trusted?: boolean } };
    assert.equal(body.data?.trusted, false);
    assert.equal(state.mfaInserts.length, 0, 'a session with no proof must never be bound');
  });

  test('an expired device row is not trusted and is not bound', async () => {
    state.deviceRow = {
      id: 'device-1',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const res = await POST(mockReq({ jwt: jwtWithSessionId(SESSION_ID), deviceCookie: DEVICE_TOKEN }));
    const body = await res.json() as { data?: { trusted?: boolean } };
    assert.equal(body.data?.trusted, false);
    assert.equal(state.mfaInserts.length, 0);
  });

  test('the cookie is looked up by its hash, never by its raw value', async () => {
    // Guards the storage contract the binding now depends on: a database read
    // must never be enough to reconstruct a usable cookie.
    assert.notEqual(hashDeviceToken(DEVICE_TOKEN), DEVICE_TOKEN);
    assert.match(hashDeviceToken(DEVICE_TOKEN), /^[0-9a-f]{64}$/);
  });
});
