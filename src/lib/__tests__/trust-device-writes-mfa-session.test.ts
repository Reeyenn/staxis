/**
 * Tests for the mfa_verified_sessions write added to /api/auth/trust-device
 * in the 2026-05-22 Phase 2B audit (Door B fix).
 *
 * The scenario this exists to pin down:
 *   - trust-device extracts session_id from the bearer JWT
 *   - After the trusted_devices insert succeeds, it inserts a
 *     mfa_verified_sessions row keyed on session_id
 *   - The custom_access_token_hook reads that row to compute
 *     mfa_verified=true for THIS specific session
 *   - An attacker creating a fresh session via stolen password gets a
 *     different session_id with no matching row → false → blocked.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/auth/trust-device/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infrastructure ─────────────────────────────────────────────────

type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

interface MockState {
  user: { id: string } | null;
  account: { id: string } | null;
  trustedDevicesInsertError: { message: string } | null;
  mfaSessionsInsertError: { message: string; code?: string } | null;
  mfaSessionsInserts: Array<{
    session_id: string;
    user_id: string;
  }>;
}
const state: MockState = {
  user: null,
  account: null,
  trustedDevicesInsertError: null,
  mfaSessionsInsertError: null,
  mfaSessionsInserts: [],
};

beforeEach(() => {
  state.user = null;
  state.account = null;
  state.trustedDevicesInsertError = null;
  state.mfaSessionsInsertError = null;
  state.mfaSessionsInserts = [];

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: state.user },
    error: null,
  })) as unknown as GetUserFn;

  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.account, error: null }),
          }),
        }),
      };
    }
    if (table === 'trusted_devices') {
      return {
        // dedup-by-fingerprint .delete() chain
        delete: () => {
          const chain = {
            eq: () => chain,
            gte: () => chain,
            then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
          };
          return chain;
        },
        // The insert
        insert: async () => ({ error: state.trustedDevicesInsertError }),
      };
    }
    if (table === 'mfa_verified_sessions') {
      return {
        insert: async (row: { session_id: string; user_id: string }) => {
          state.mfaSessionsInserts.push({
            session_id: row.session_id,
            user_id: row.user_id,
          });
          return { error: state.mfaSessionsInsertError };
        },
      };
    }
    throw new Error(`unexpected table: ${table}`);
  };
});

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.from = originalFrom;
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function mintJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

const USER_ID = '11111111-2222-3333-4444-555555555555';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION_ID = '99999999-8888-7777-6666-555555555555';

function freshJwt(extraClaims: Record<string, unknown> = {}): string {
  return mintJwt({
    sub: USER_ID,
    iat: Math.floor(Date.now() / 1000) - 5,
    ...extraClaims,
  });
}

function mockReq(opts: { jwt?: string } = {}): NextRequest {
  const jwt = opts.jwt ?? freshJwt({ session_id: SESSION_ID });
  return {
    url: 'https://staxis.test/api/auth/trust-device',
    method: 'POST',
    headers: new Headers({
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
      'user-agent': 'test-agent',
      'x-forwarded-for': '203.0.113.7',
    }),
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

function ok(): void {
  state.user = { id: USER_ID };
  state.account = { id: ACCOUNT_ID };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('trust-device — mfa_verified_sessions write (Phase 2B / Door B)', () => {
  test('JWT with session_id → trusted_devices insert succeeds → mfa_verified_sessions row inserted with that session_id', async () => {
    ok();
    const res = await POST(mockReq());
    assert.equal(res.status, 200);
    assert.equal(state.mfaSessionsInserts.length, 1, 'must insert exactly one mfa_verified_sessions row');
    assert.equal(state.mfaSessionsInserts[0].session_id, SESSION_ID);
    assert.equal(state.mfaSessionsInserts[0].user_id, USER_ID);
  });

  test('JWT lacks session_id claim → mfa_verified_sessions write SKIPPED (route still 200, just warns)', async () => {
    // Defensive: log a warning if Supabase ever changes the claim shape.
    // trusted_devices is still inserted (the website-layer Phase 1 gate
    // still works).
    ok();
    const noSessionJwt = freshJwt({ /* no session_id */ });
    const res = await POST(mockReq({ jwt: noSessionJwt }));
    assert.equal(res.status, 200, 'route succeeds despite missing session_id');
    assert.equal(state.mfaSessionsInserts.length, 0, 'no mfa_verified_sessions row should be written');
  });

  test('trusted_devices insert fails → mfa_verified_sessions row NOT written (atomicity)', async () => {
    // If we wrote the mfa_verified_sessions row anyway, the user would
    // appear verified to the hook without having actually established
    // device trust.
    ok();
    state.trustedDevicesInsertError = { message: 'transient db error' };
    const res = await POST(mockReq());
    assert.equal(res.status, 500);
    assert.equal(state.mfaSessionsInserts.length, 0, 'mfa_verified_sessions write skipped on trusted_devices failure');
  });

  test('mfa_verified_sessions duplicate (23505) → non-fatal, route still 200', async () => {
    // Idempotent on conflict — a repeat trust-device call for the same
    // session should not 500. The mfa_verified_sessions table is
    // session_id PK, so a re-call from the same session naturally
    // conflicts and is fine to ignore.
    ok();
    state.mfaSessionsInsertError = { message: 'duplicate key', code: '23505' };
    const res = await POST(mockReq());
    assert.equal(res.status, 200);
  });

  test('mfa_verified_sessions insert fails with other error → non-fatal (Phase 1 still works)', async () => {
    // The trusted_devices row is in place; worst case user gets RLS
    // denials from PostgREST and signs in again. The website-layer
    // (Phase 1) gate still keeps them logged in.
    ok();
    state.mfaSessionsInsertError = { message: 'unexpected db error', code: '42P01' };
    const res = await POST(mockReq());
    assert.equal(res.status, 200);
  });
});
