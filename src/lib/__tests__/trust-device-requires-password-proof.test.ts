/**
 * Tests for the password-proof gate on /api/auth/trust-device.
 *
 * Original Phase A (2026-05-22 audit, Hole #1) gated trust-device on a
 * password_signin_proofs row written by the custom_access_token_hook
 * when Supabase tagged the JWT issuance with authentication_method=
 * 'password'. The lookup was SELECT … FOR UPDATE-NOTHING then
 * UPDATE used_at=now() — two statements with a race.
 *
 * Phase B follow-up (Codex review #3, migration 0164) made the claim
 * atomic via `staxis_claim_password_signin_proof(uuid)` RPC. This file
 * tests the post-integration behavior (RPC-based) since that's the
 * version that ships once Phase B merges on top of Phase A.
 *
 * The attack this exists to block:
 *   1. Attacker (no password, but brief access to victim's email)
 *      calls supabase.auth.signInWithOtp({email}) directly — public
 *      endpoint, no auth required
 *   2. OTP lands in victim's inbox; attacker reads it
 *   3. Attacker calls verifyOtp → gets a real Supabase JWT
 *   4. Pre-fix: attacker calls /api/auth/trust-device → succeeds → gets
 *      a staxis_device cookie + DB row valid for up to 1 year
 *   5. Post-fix: trust-device calls staxis_claim_password_signin_proof
 *      RPC, which returns NULL because the hook only writes a proof
 *      when authentication_method='password' (not 'otp'). Attacker is
 *      refused with 403.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/auth/trust-device/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infrastructure ─────────────────────────────────────────────────

type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;

const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

interface MockState {
  user: { id: string; email?: string | null } | null;
  account: { id: string } | null;
  claimedProofId: string | null;
  claimRpcError: { message: string } | null;
  claimRpcThrows: boolean;
  insertError: { message: string } | null;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
  trustedDevicesInsertCalls: number;
  claimRpcCalls: number;
  releaseRpcCalls: number;
}

const state: MockState = {
  user: null,
  account: null,
  claimedProofId: null,
  claimRpcError: null,
  claimRpcThrows: false,
  insertError: null,
  insertedEvents: [],
  trustedDevicesInsertCalls: 0,
  claimRpcCalls: 0,
  releaseRpcCalls: 0,
};

beforeEach(() => {
  state.user = null;
  state.account = null;
  state.claimedProofId = null;
  state.claimRpcError = null;
  state.claimRpcThrows = false;
  state.insertError = null;
  state.insertedEvents = [];
  state.trustedDevicesInsertCalls = 0;
  state.claimRpcCalls = 0;
  state.releaseRpcCalls = 0;

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: state.user as { id: string; email?: string | null } | null },
    error: null,
  })) as unknown as GetUserFn;

  supabaseAdmin.rpc = (async (fn: string) => {
    if (fn === 'staxis_claim_password_signin_proof') {
      state.claimRpcCalls += 1;
      if (state.claimRpcThrows) throw new Error('rpc threw');
      return { data: state.claimedProofId, error: state.claimRpcError };
    }
    if (fn === 'staxis_release_password_signin_proof') {
      state.releaseRpcCalls += 1;
      return { data: null, error: null };
    }
    throw new Error(`unexpected rpc: ${fn}`);
  }) as unknown as RpcFn;

  // @ts-expect-error monkey-patch singleton
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
        delete: () => {
          const chain = {
            eq: () => chain,
            neq: () => chain,
            gte: () => chain,
            then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
          };
          return chain;
        },
        insert: async () => {
          state.trustedDevicesInsertCalls += 1;
          return { error: state.insertError };
        },
      };
    }
    if (table === 'mfa_verified_sessions') {
      // Phase B addition — not the focus of this file but the integrated
      // route writes here too. Default: success, no-op for these tests.
      return {
        insert: async () => ({ error: null }),
      };
    }
    if (table === 'app_events') {
      return {
        insert: async (row: { event_type: string; metadata: Record<string, unknown> }) => {
          state.insertedEvents.push(row);
          return { error: null };
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
const PROOF_ID = 'pppppppp-pppp-pppp-pppp-pppppppppppp';
const SESSION_ID = '99999999-8888-7777-6666-555555555555';

function freshJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  return mintJwt({
    sub: USER_ID,
    iat: now - 5,
    session_id: SESSION_ID,
    amr: [{ method: 'otp', timestamp: now - 5 }],
  });
}

function mockReq(opts: { jwt?: string } = {}): NextRequest {
  const jwt = opts.jwt ?? freshJwt();
  const headers = new Headers({
    authorization: `Bearer ${jwt}`,
    'content-type': 'application/json',
    'user-agent': 'test-agent',
    'x-forwarded-for': '203.0.113.7',
  });
  return {
    url: 'https://staxis.test/api/auth/trust-device',
    method: 'POST',
    headers,
    cookies: { get: () => undefined },
  } as unknown as NextRequest;
}

function ok(): void {
  state.user = { id: USER_ID, email: 'staff@example.com' };
  state.account = { id: ACCOUNT_ID };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('trust-device — password-proof gate (Hole #1, RPC-based)', () => {
  test('password-only JWT + valid proof → 403 before the proof is claimed', async () => {
    ok();
    state.claimedProofId = PROOF_ID;
    const now = Math.floor(Date.now() / 1000);
    const passwordJwt = mintJwt({
      sub: USER_ID,
      iat: now - 5,
      session_id: SESSION_ID,
      amr: [{ method: 'password', timestamp: now - 5 }],
    });

    const res = await POST(mockReq({ jwt: passwordJwt }));
    assert.equal(res.status, 403);
    assert.equal(state.claimRpcCalls, 0, 'non-OTP JWT must not burn the password proof');
    assert.equal(state.trustedDevicesInsertCalls, 0);
    const blocked = state.insertedEvents.find(
      (e) => e.event_type === 'auth.trust_device_blocked_without_fresh_otp',
    );
    assert.equal(blocked?.metadata.reason, 'otp_method_missing');
  });

  test('missing AMR → 403 before the proof is claimed', async () => {
    ok();
    state.claimedProofId = PROOF_ID;
    const jwt = mintJwt({
      sub: USER_ID,
      iat: Math.floor(Date.now() / 1000) - 5,
      session_id: SESSION_ID,
    });

    const res = await POST(mockReq({ jwt }));
    assert.equal(res.status, 403);
    assert.equal(state.claimRpcCalls, 0);
    assert.equal(state.trustedDevicesInsertCalls, 0);
  });

  test('stale or future OTP proof → 403 before the password proof is claimed', async () => {
    ok();
    state.claimedProofId = PROOF_ID;
    const now = Math.floor(Date.now() / 1000);
    for (const timestamp of [now - 6 * 60, now + 60]) {
      const jwt = mintJwt({
        sub: USER_ID,
        iat: now - 5,
        session_id: SESSION_ID,
        amr: [{ method: 'otp', timestamp }],
      });
      const res = await POST(mockReq({ jwt }));
      assert.equal(res.status, 403);
    }
    assert.equal(state.claimRpcCalls, 0);
    assert.equal(state.trustedDevicesInsertCalls, 0);
  });

  test('RPC returns NULL (no proof) → 403, security event logged, no trusted_devices insert', async () => {
    ok();
    state.claimedProofId = null;

    const res = await POST(mockReq());
    assert.equal(res.status, 403);
    assert.equal(state.trustedDevicesInsertCalls, 0, 'must NOT insert trusted_devices without a proof');

    const blocked = state.insertedEvents.find(
      (e) => e.event_type === 'auth.trust_device_blocked_no_password_proof',
    );
    assert.ok(blocked, 'auth.trust_device_blocked_no_password_proof must be logged');
    assert.equal(
      blocked?.metadata.reason,
      'password_signin_proof_missing_or_expired_or_used',
    );
  });

  test('RPC returns proof id → 200, trusted_devices inserted exactly once', async () => {
    ok();
    state.claimedProofId = PROOF_ID;

    const res = await POST(mockReq());
    assert.equal(res.status, 200);
    assert.equal(state.trustedDevicesInsertCalls, 1, 'trusted_devices insert should fire exactly once');
    assert.equal(state.claimRpcCalls, 1, 'RPC must be called exactly once — atomic single-use claim');
    assert.equal(state.releaseRpcCalls, 0, 'no release on happy path');
  });

  test('RPC errors (Supabase error) → 503 fail-closed, no trusted_devices insert', async () => {
    ok();
    state.claimedProofId = null;
    state.claimRpcError = { message: 'connection reset' };

    const res = await POST(mockReq());
    assert.equal(res.status, 503);
    assert.equal(state.trustedDevicesInsertCalls, 0);
    assert.equal(state.releaseRpcCalls, 0, 'never claimed → nothing to release');
  });

  test('RPC throws → fail-closed, no trusted_devices insert', async () => {
    ok();
    state.claimRpcThrows = true;

    let threw = false;
    try {
      const res = await POST(mockReq());
      // Either a 5xx response or a thrown error is acceptable — invariant
      // is no trusted_devices insert.
      assert.ok(res.status >= 500, 'expected fail-closed response');
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
    }
    assert.equal(state.trustedDevicesInsertCalls, 0, 'must NOT insert on RPC failure');
    assert.ok(threw || true, 'either path is fail-closed');
  });

  test('trusted_devices insert fails after RPC claim succeeds → 500, release RPC fires (proof not burned)', async () => {
    // The proof was atomically claimed (used_at=now()). If the downstream
    // trusted_devices insert fails, we MUST release the claim — otherwise
    // a transient DB error during the trust mint burns the proof and
    // forces the user to a fresh password sign-in.
    ok();
    state.claimedProofId = PROOF_ID;
    state.insertError = { message: 'transient db error' };

    const res = await POST(mockReq());
    assert.equal(res.status, 500);
    assert.equal(state.releaseRpcCalls, 1, 'release RPC must fire on trusted_devices failure');
  });

  test('stale JWT (iat > 5 min ago) → 403 and short-circuits the proof RPC', async () => {
    ok();
    state.claimedProofId = PROOF_ID;
    const now = Math.floor(Date.now() / 1000);
    const staleJwt = mintJwt({
      sub: USER_ID,
      iat: now - 6 * 60,
      session_id: SESSION_ID,
      amr: [{ method: 'otp', timestamp: now - 6 * 60 }],
    });

    const res = await POST(mockReq({ jwt: staleJwt }));
    assert.equal(res.status, 403);
    assert.equal(state.trustedDevicesInsertCalls, 0, 'stale-session refusal short-circuits the proof check');
    assert.equal(state.claimRpcCalls, 0, 'RPC should not run for a stale JWT — wastes a single-use claim');
  });
});
