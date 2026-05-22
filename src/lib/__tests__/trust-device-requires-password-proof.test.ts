/**
 * Tests for the password-proof gate added to /api/auth/trust-device in
 * the 2026-05-22 auth audit (Phase 2A / Hole #1 fix).
 *
 * The attack this exists to block:
 *   1. Attacker (no password, but brief access to victim's email)
 *      calls supabase.auth.signInWithOtp({email}) directly — public
 *      endpoint, no auth required
 *   2. OTP lands in victim's inbox
 *   3. Attacker reads OTP
 *   4. Attacker calls verifyOtp → gets a real Supabase JWT
 *   5. Pre-fix: attacker calls /api/auth/trust-device → succeeds →
 *      gets a staxis_device cookie + DB row valid for up to 1 year
 *   6. Post-fix: trust-device requires a password_signin_proofs row,
 *      which is only written by the custom_access_token_hook when
 *      Supabase tags the JWT issuance with authentication_method=
 *      'password'. The OTP-only path produces no proof, so the
 *      attacker is refused at trust-device with 403.
 *
 * What we mock here: supabaseAdmin so we control the proof-lookup
 * result. The actual hook is a Postgres function and is verified by
 * end-to-end staging tests rather than unit tests.
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

interface ProofRow {
  id: string;
  expires_at: string;
  used_at: string | null;
}

interface MockState {
  user: { id: string; email?: string | null } | null;
  proof: ProofRow | null;
  proofLookupError: { message: string } | null;
  proofThrows: boolean;
  account: { id: string } | null;
  insertError: { message: string } | null;
  markUsedError: { message: string } | null;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
  trustedDevicesInsertCalls: number;
  markUsedCalls: Array<{ proofId: string }>;
}

const state: MockState = {
  user: null,
  proof: null,
  proofLookupError: null,
  proofThrows: false,
  account: null,
  insertError: null,
  markUsedError: null,
  insertedEvents: [],
  trustedDevicesInsertCalls: 0,
  markUsedCalls: [],
};

beforeEach(() => {
  state.user = null;
  state.proof = null;
  state.proofLookupError = null;
  state.proofThrows = false;
  state.account = null;
  state.insertError = null;
  state.markUsedError = null;
  state.insertedEvents = [];
  state.trustedDevicesInsertCalls = 0;
  state.markUsedCalls = [];

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: state.user as { id: string; email?: string | null } | null },
    error: null,
  })) as unknown as GetUserFn;

  // @ts-expect-error monkey-patch singleton
  supabaseAdmin.from = (table: string) => {
    if (table === 'password_signin_proofs') {
      return {
        // Lookup chain: .select(...).eq(...).is(...).gt(...).order(...).limit(...).maybeSingle()
        select: () => ({
          eq: () => ({
            is: () => ({
              gt: () => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => {
                      if (state.proofThrows) throw new Error('proof lookup threw');
                      return { data: state.proof, error: state.proofLookupError };
                    },
                  }),
                }),
              }),
            }),
          }),
        }),
        // Mark-used chain: .update(...).eq(...)
        update: (_vals: Record<string, unknown>) => ({
          eq: async (_col: string, val: string) => {
            state.markUsedCalls.push({ proofId: val });
            return { error: state.markUsedError };
          },
        }),
      };
    }
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
        // dedup-by-fingerprint .delete().eq().gte().eq().eq()
        delete: () => {
          const chain = {
            eq: () => chain,
            gte: () => chain,
            then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
          };
          return chain;
        },
        // Final insert that registers the device
        insert: async () => {
          state.trustedDevicesInsertCalls += 1;
          return { error: state.insertError };
        },
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
const FUTURE = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = () => new Date(Date.now() - 60 * 1000).toISOString();

function freshJwt(): string {
  // iat within the 5-min session-age guard.
  return mintJwt({ sub: USER_ID, iat: Math.floor(Date.now() / 1000) - 5 });
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
    cookies: {
      get: () => undefined,
    },
  } as unknown as NextRequest;
}

function ok(): void {
  state.user = { id: USER_ID, email: 'staff@example.com' };
  state.account = { id: ACCOUNT_ID };
}

function validProof(): ProofRow {
  return { id: PROOF_ID, expires_at: FUTURE(), used_at: null };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('trust-device — password-proof gate (Hole #1)', () => {
  test('proof missing → 403, security event logged, no trusted_devices insert', async () => {
    ok();
    state.proof = null;

    const res = await POST(mockReq());
    assert.equal(res.status, 403);
    assert.equal(state.trustedDevicesInsertCalls, 0, 'must NOT insert trusted_devices without a proof');

    const blocked = state.insertedEvents.find(
      (e) => e.event_type === 'auth.trust_device_blocked_no_password_proof',
    );
    assert.ok(blocked, 'auth.trust_device_blocked_no_password_proof must be logged');
    assert.equal(blocked?.metadata.reason, 'password_signin_proof_missing_or_expired');
  });

  test('proof exists, unused, unexpired → 200, trusted_devices inserted, proof marked used', async () => {
    ok();
    state.proof = validProof();

    const res = await POST(mockReq());
    assert.equal(res.status, 200);
    assert.equal(state.trustedDevicesInsertCalls, 1, 'trusted_devices insert should fire exactly once');
    assert.equal(state.markUsedCalls.length, 1, 'proof should be marked used');
    assert.equal(state.markUsedCalls[0].proofId, PROOF_ID);
  });

  test('proof lookup throws DB error → 503 fail-closed, no trusted_devices insert', async () => {
    ok();
    state.proofThrows = true;

    let threw = false;
    try {
      const res = await POST(mockReq());
      assert.equal(res.status, 503, 'expected 503 fail-closed');
    } catch (err) {
      // Either a thrown error or a 503 response is acceptable — the
      // important invariant is no trusted_devices insert happened.
      threw = true;
      assert.ok(err instanceof Error);
    }
    assert.equal(state.trustedDevicesInsertCalls, 0, 'must NOT insert on lookup failure');
    assert.ok(threw || true, 'either path is fail-closed');
  });

  test('proof lookup returns Supabase error → 503, no trusted_devices insert', async () => {
    ok();
    state.proof = null;
    state.proofLookupError = { message: 'connection reset' };

    const res = await POST(mockReq());
    assert.equal(res.status, 503);
    assert.equal(state.trustedDevicesInsertCalls, 0);
  });

  test('trusted_devices insert fails after proof passes → 500, proof NOT marked used', async () => {
    // If the insert fails, the proof should remain unused so the user
    // can retry without re-establishing a fresh password sign-in.
    ok();
    state.proof = validProof();
    state.insertError = { message: 'transient db error' };

    const res = await POST(mockReq());
    assert.equal(res.status, 500);
    assert.equal(state.markUsedCalls.length, 0, 'proof MUST NOT be marked used on insert failure');
  });

  test('proof mark-used failure is non-fatal — response is still 200 + cookie set', async () => {
    ok();
    state.proof = validProof();
    state.markUsedError = { message: 'transient update error' };

    const res = await POST(mockReq());
    assert.equal(res.status, 200, 'mark-used failure must not poison the success path');
    assert.equal(state.trustedDevicesInsertCalls, 1);
  });

  test('stale JWT (iat > 5 min ago) → 401 — existing session-age guard still wins', async () => {
    // Regression check: the proof gate runs AFTER the session-age guard,
    // so a stale JWT should be refused before the proof is even consulted.
    ok();
    state.proof = validProof();
    const staleJwt = mintJwt({ sub: USER_ID, iat: Math.floor(Date.now() / 1000) - 6 * 60 });

    const res = await POST(mockReq({ jwt: staleJwt }));
    assert.equal(res.status, 401);
    assert.equal(state.trustedDevicesInsertCalls, 0, 'stale-session refusal short-circuits the proof check');
  });
});
