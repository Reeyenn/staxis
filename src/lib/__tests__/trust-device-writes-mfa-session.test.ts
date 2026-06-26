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
import { TRUST_COOKIE_NAME } from '@/lib/trusted-device';

// ─── Mock infrastructure ─────────────────────────────────────────────────

type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

interface MockState {
  user: { id: string } | null;
  account: { id: string } | null;
  trustedDevicesInsertError: { message: string } | null;
  mfaSessionsInsertError: { message: string; code?: string } | null;
  mfaSessionsInserts: Array<{
    session_id: string;
    user_id: string;
  }>;
  /** How many times trusted_devices.insert was called (0 when remember=false). */
  trustedDevicesInserts: number;
  /**
   * Phase A + atomic-claim RPC (Codex finding #3, migration 0164). The
   * RPC returns a proof id when one was atomically claimed, null when
   * no unused+unexpired proof was available. Default: a dummy id, so
   * the happy-path tests don't all need to set it.
   */
  claimedProofId: string | null;
  claimRpcError: { message: string } | null;
  claimRpcCalls: number;
  releaseRpcCalls: number;
}
const state: MockState = {
  user: null,
  account: null,
  trustedDevicesInsertError: null,
  mfaSessionsInsertError: null,
  mfaSessionsInserts: [],
  trustedDevicesInserts: 0,
  claimedProofId: 'proof-id-from-rpc',
  claimRpcError: null,
  claimRpcCalls: 0,
  releaseRpcCalls: 0,
};

beforeEach(() => {
  state.user = null;
  state.account = null;
  state.trustedDevicesInsertError = null;
  state.mfaSessionsInsertError = null;
  state.mfaSessionsInserts = [];
  state.trustedDevicesInserts = 0;
  state.claimedProofId = 'proof-id-from-rpc';
  state.claimRpcError = null;
  state.claimRpcCalls = 0;
  state.releaseRpcCalls = 0;

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: state.user },
    error: null,
  })) as unknown as GetUserFn;

  // Mock supabaseAdmin.rpc — Phase A's atomic-claim RPC (migration 0164)
  // and the release helper. Both run under service_role only.
  supabaseAdmin.rpc = (async (fn: string) => {
    if (fn === 'staxis_claim_password_signin_proof') {
      state.claimRpcCalls += 1;
      return { data: state.claimedProofId, error: state.claimRpcError };
    }
    if (fn === 'staxis_release_password_signin_proof') {
      state.releaseRpcCalls += 1;
      return { data: null, error: null };
    }
    throw new Error(`unexpected rpc: ${fn}`);
  }) as unknown as RpcFn;

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
        insert: async () => {
          state.trustedDevicesInserts += 1;
          return { error: state.trustedDevicesInsertError };
        },
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
  supabaseAdmin.rpc = originalRpc;
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

function mockReq(opts: { jwt?: string; body?: unknown } = {}): NextRequest {
  const jwt = opts.jwt ?? freshJwt({ session_id: SESSION_ID });
  const base: Record<string, unknown> = {
    url: 'https://staxis.test/api/auth/trust-device',
    method: 'POST',
    headers: new Headers({
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
      'user-agent': 'test-agent',
      'x-forwarded-for': '203.0.113.7',
    }),
    cookies: { get: () => undefined },
  };
  // Only attach a json() method when a body is supplied. With no body, calling
  // req.json() throws (no such method) → the route falls back to remember=true,
  // matching the real onboarding caller that posts with no body.
  if (opts.body !== undefined) {
    base.json = async () => opts.body;
  }
  return base as unknown as NextRequest;
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

describe('trust-device — remember flag (unchecked "Trust this device")', () => {
  test('remember:false → mfa_verified_sessions row written, NO trusted_devices row, NO durable cookie, 200', async () => {
    ok();
    const res = await POST(mockReq({ body: { remember: false } }));
    assert.equal(res.status, 200);
    assert.equal(state.mfaSessionsInserts.length, 1, 'per-session verification must still be written');
    assert.equal(state.mfaSessionsInserts[0].session_id, SESSION_ID);
    assert.equal(state.trustedDevicesInserts, 0, 'no durable trusted_devices row when remember=false');
    assert.equal(res.cookies.get(TRUST_COOKIE_NAME), undefined, 'no durable staxis_device cookie when remember=false');
  });

  test('remember:true (explicit) → trusted_devices row + durable cookie + mfa_verified_sessions row, 200', async () => {
    ok();
    const res = await POST(mockReq({ body: { remember: true } }));
    assert.equal(res.status, 200);
    assert.equal(state.trustedDevicesInserts, 1);
    assert.equal(state.mfaSessionsInserts.length, 1);
    const cookie = res.cookies.get(TRUST_COOKIE_NAME);
    assert.ok(cookie && cookie.value, 'durable cookie must be set when remember=true');
  });

  test('no body (legacy/onboard caller) → defaults to remember=true (cookie + trusted_devices)', async () => {
    ok();
    const res = await POST(mockReq());  // no body → req.json() throws → remember=true
    assert.equal(res.status, 200);
    assert.equal(state.trustedDevicesInserts, 1);
    assert.ok(res.cookies.get(TRUST_COOKIE_NAME), 'no-body callers keep today durable-trust behavior');
  });

  test('remember:false + persistent mfa_verified_sessions error → retried once then 500 + proof released', async () => {
    // No cookie covers Door B, so a row we cannot write means the app would be
    // blank → fail loudly (and un-burn the proof) instead.
    ok();
    state.mfaSessionsInsertError = { message: 'db down', code: '42P01' };
    const res = await POST(mockReq({ body: { remember: false } }));
    assert.equal(res.status, 500);
    assert.equal(state.mfaSessionsInserts.length, 2, 'must retry the insert once before giving up');
    assert.equal(state.releaseRpcCalls, 1, 'proof must be released so a fresh sign-in is not blocked');
    assert.equal(state.trustedDevicesInserts, 0);
  });

  test('remember:false + transient mfa error that clears on retry → 200', async () => {
    // First insert fails, second succeeds. We model this by failing once.
    ok();
    let calls = 0;
    // @ts-expect-error monkey-patch within test
    supabaseAdmin.from = ((table: string) => {
      if (table === 'accounts') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.account, error: null }) }) }) };
      }
      if (table === 'mfa_verified_sessions') {
        return {
          insert: async (row: { session_id: string; user_id: string }) => {
            calls += 1;
            state.mfaSessionsInserts.push({ session_id: row.session_id, user_id: row.user_id });
            return { error: calls === 1 ? { message: 'transient', code: '40001' } : null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });
    const res = await POST(mockReq({ body: { remember: false } }));
    assert.equal(res.status, 200);
    assert.equal(calls, 2, 'second attempt should succeed');
    assert.equal(state.releaseRpcCalls, 0, 'no proof release on eventual success');
  });
});

describe('trust-device — atomic password-proof claim (Codex review #3, migration 0164)', () => {
  test('RPC returns proof id → flow continues, mfa_verified_sessions row written', async () => {
    ok();
    state.claimedProofId = 'real-proof-uuid';
    const res = await POST(mockReq());
    assert.equal(res.status, 200);
    assert.equal(state.claimRpcCalls, 1, 'RPC must be called exactly once per request');
    assert.equal(state.releaseRpcCalls, 0, 'release RPC must NOT fire on happy path');
    assert.equal(state.mfaSessionsInserts.length, 1);
  });

  test('RPC returns NULL (no unused proof) → 403, no trusted_devices write, no mfa_verified_sessions write', async () => {
    // The Hole #1 attack: caller has a valid Supabase JWT (from signInWithOtp,
    // not signInWithPassword) → no proof exists → RPC returns null → must
    // 403, NOT mint a trust cookie.
    ok();
    state.claimedProofId = null;
    const res = await POST(mockReq());
    assert.equal(res.status, 403);
    assert.equal(state.claimRpcCalls, 1);
    assert.equal(state.mfaSessionsInserts.length, 0, 'no mfa_verified_sessions write when proof claim fails');
  });

  test('RPC errors transiently → fail-closed 503, no trust mint, no release', async () => {
    ok();
    state.claimRpcError = { message: 'connection reset' };
    state.claimedProofId = null;
    const res = await POST(mockReq());
    assert.equal(res.status, 503);
    assert.equal(state.releaseRpcCalls, 0, 'nothing to release — never successfully claimed');
    assert.equal(state.mfaSessionsInserts.length, 0);
  });

  test('proof claimed but trusted_devices insert fails → release RPC fires (proof not burned)', async () => {
    // Otherwise a transient failure during the trust mint would burn the
    // claim and force the user back to a fresh password sign-in.
    ok();
    state.claimedProofId = 'real-proof-uuid';
    state.trustedDevicesInsertError = { message: 'transient db error' };
    const res = await POST(mockReq());
    assert.equal(res.status, 500);
    assert.equal(state.claimRpcCalls, 1);
    assert.equal(state.releaseRpcCalls, 1, 'release RPC must fire to un-burn the proof');
    assert.equal(state.mfaSessionsInserts.length, 0);
  });
});
