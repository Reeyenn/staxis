/**
 * Unit tests for verifyStaffLinkToken (src/lib/staff-link-auth.ts).
 *
 * Security audit 2026-06-26 #1 — the per-staff link token is now the credential
 * for the whole public mobile surface. These tests pin the token model so a
 * future refactor that relaxes ANY axis (expiry, revoke, staff-binding,
 * property-binding, is_active, rate-limit) lands as a red diff BEFORE it ships.
 *
 * The credential is the token; a raw (pid, staffId) tuple must NOT be
 * sufficient. Every failure path must return an indistinguishable 401 so an
 * attacker can't tell WHICH axis failed.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { verifyStaffLinkToken, hashStaffLinkToken } from '@/lib/staff-link-auth';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const PROPERTY_A = '11111111-1111-1111-1111-111111111111';
const PROPERTY_B = '22222222-2222-2222-2222-222222222222';
const STAFF_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const STAFF_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const RAW_VALID = 'valid-raw-token-000000000000000000000000000000000000000000000001';
const RAW_EXPIRED = 'expired-raw-token-00000000000000000000000000000000000000000000002';
const RAW_REVOKED = 'revoked-raw-token-00000000000000000000000000000000000000000000003';
const RAW_WRONG_STAFF = 'wrongstaff-raw-token-000000000000000000000000000000000000000000004';
const RAW_WRONG_PROP = 'wrongprop-raw-token-0000000000000000000000000000000000000000000005';
const RAW_INACTIVE = 'inactive-raw-token-0000000000000000000000000000000000000000000006';
const RAW_UNKNOWN = 'unknown-raw-token-00000000000000000000000000000000000000000000007';

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const PAST = new Date(Date.now() - 86_400_000).toISOString();

interface TokenRow {
  token_hash: string;
  staff_id: string;
  property_id: string;
  expires_at: string;
  revoked_at: string | null;
}

const h = (raw: string) => createHash('sha256').update(raw).digest('hex');

const TOKENS: Record<string, TokenRow> = {
  [h(RAW_VALID)]:       { token_hash: h(RAW_VALID),       staff_id: STAFF_A, property_id: PROPERTY_A, expires_at: FUTURE, revoked_at: null },
  [h(RAW_EXPIRED)]:     { token_hash: h(RAW_EXPIRED),     staff_id: STAFF_A, property_id: PROPERTY_A, expires_at: PAST,   revoked_at: null },
  [h(RAW_REVOKED)]:     { token_hash: h(RAW_REVOKED),     staff_id: STAFF_A, property_id: PROPERTY_A, expires_at: FUTURE, revoked_at: PAST },
  [h(RAW_WRONG_STAFF)]: { token_hash: h(RAW_WRONG_STAFF), staff_id: STAFF_B, property_id: PROPERTY_A, expires_at: FUTURE, revoked_at: null },
  [h(RAW_WRONG_PROP)]:  { token_hash: h(RAW_WRONG_PROP),  staff_id: STAFF_A, property_id: PROPERTY_B, expires_at: FUTURE, revoked_at: null },
  [h(RAW_INACTIVE)]:    { token_hash: h(RAW_INACTIVE),    staff_id: STAFF_A, property_id: PROPERTY_A, expires_at: FUTURE, revoked_at: null },
};

// STAFF_A is active; the token for RAW_INACTIVE points at STAFF_A too, so we
// model the inactive case by flipping is_active for a dedicated staff row.
const STAFF_INACTIVE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
TOKENS[h(RAW_INACTIVE)].staff_id = STAFF_INACTIVE;

const STAFF: Record<string, { id: string; name: string; language: string; department: string | null; is_senior: boolean; is_active: boolean }> = {
  [STAFF_A]:        { id: STAFF_A,        name: 'Alice', language: 'es', department: 'housekeeping', is_senior: true,  is_active: true },
  [STAFF_B]:        { id: STAFF_B,        name: 'Bob',   language: 'en', department: 'laundry',      is_senior: false, is_active: true },
  [STAFF_INACTIVE]: { id: STAFF_INACTIVE, name: 'Carol', language: 'en', department: null,          is_senior: false, is_active: false },
};

// ─── Mock infrastructure ─────────────────────────────────────────────────

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);

// Toggle to simulate the rate-limit backend denying (returns a count over cap).
let rateLimitAllow = true;

beforeEach(() => {
  rateLimitAllow = true;
  supabaseAdmin.from = ((table: string) => {
    const filter: Record<string, unknown> = {};
    const rowsFor = (): Record<string, unknown>[] => {
      if (table === 'staff_link_tokens') {
        const th = filter.token_hash as string | undefined;
        const row = th ? TOKENS[th] : undefined;
        return row ? [row as unknown as Record<string, unknown>] : [];
      }
      if (table === 'staff') {
        const id = filter.id as string | undefined;
        const pid = filter.property_id as string | undefined;
        const s = id ? STAFF[id] : undefined;
        if (!s) return [];
        if (pid && s.id && STAFF[s.id] && filterPropMatches(s.id, pid)) return [s as unknown as Record<string, unknown>];
        // property_id binding: the token row already carries property_id; the
        // staff lookup filters on (id, property_id). Model that.
        if (pid && !tokenPropForStaff(s.id, pid)) return [];
        return [s as unknown as Record<string, unknown>];
      }
      return [];
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => { filter[col] = val; return builder; },
      is: () => builder, order: () => builder, limit: () => builder,
      update: () => builder, insert: () => builder,
      maybeSingle: async () => { const r = rowsFor(); return { data: r[0] ?? null, error: null }; },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rowsFor(), error: null }),
    };
    return builder;
  }) as unknown as FromFn;

  supabaseAdmin.rpc = (async (fn: string) => {
    if (fn === 'staxis_api_limit_hit') {
      // The limiter reads .current / allowed off the returned count vs cap.
      // Return a small count when allowing, a huge one when denying.
      return { data: rateLimitAllow ? 1 : 999999, error: null };
    }
    return { data: null, error: null };
  }) as unknown as RpcFn;
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

// Helpers modelling the (id, property_id) staff filter against the token's prop.
function tokenPropForStaff(staffId: string, pid: string): boolean {
  // Staff belongs to PROPERTY_A in all fixtures except STAFF_B (also A).
  // The route always passes the URL's pid; a mismatch returns no row.
  const staffPropMap: Record<string, string> = {
    [STAFF_A]: PROPERTY_A,
    [STAFF_B]: PROPERTY_A,
    [STAFF_INACTIVE]: PROPERTY_A,
  };
  return staffPropMap[staffId] === pid;
}
function filterPropMatches(staffId: string, pid: string): boolean {
  return tokenPropForStaff(staffId, pid);
}

function makeReq(tok?: string): NextRequest {
  const url = tok
    ? `https://staxis.test/api/housekeeper/rooms?tok=${encodeURIComponent(tok)}`
    : 'https://staxis.test/api/housekeeper/rooms';
  return new Request(url, { method: 'GET' }) as unknown as NextRequest;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('hashStaffLinkToken', () => {
  test('is sha256 hex of the raw token', () => {
    assert.equal(hashStaffLinkToken(RAW_VALID), h(RAW_VALID));
    assert.equal(hashStaffLinkToken(RAW_VALID).length, 64);
  });
});

describe('verifyStaffLinkToken', () => {
  test('valid token bound to (pid, staffId) → ok + identity', async () => {
    const res = await verifyStaffLinkToken(makeReq(RAW_VALID), {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r1',
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.staff.staffId, STAFF_A);
      assert.equal(res.staff.propertyId, PROPERTY_A);
      assert.equal(res.staff.name, 'Alice');
      assert.equal(res.staff.language, 'es');
      assert.equal(res.staff.isSenior, true);
    }
  });

  test('missing token → 401', async () => {
    const res = await verifyStaffLinkToken(makeReq(undefined), {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r2',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.response.status, 401);
  });

  test('garbage / unknown token → 401', async () => {
    const res = await verifyStaffLinkToken(makeReq(RAW_UNKNOWN), {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r3',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.response.status, 401);
  });

  test('expired token → 401', async () => {
    const res = await verifyStaffLinkToken(makeReq(RAW_EXPIRED), {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r4',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.response.status, 401);
  });

  test('revoked token → 401', async () => {
    const res = await verifyStaffLinkToken(makeReq(RAW_REVOKED), {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r5',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.response.status, 401);
  });

  test('token bound to a DIFFERENT staff → 401 (no cross-staff pivot)', async () => {
    // RAW_WRONG_STAFF is bound to STAFF_B; caller claims STAFF_A.
    const res = await verifyStaffLinkToken(makeReq(RAW_WRONG_STAFF), {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r6',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.response.status, 401);
  });

  test('token bound to a DIFFERENT property → 401 (no cross-tenant pivot)', async () => {
    // RAW_WRONG_PROP is bound to PROPERTY_B; caller claims PROPERTY_A.
    const res = await verifyStaffLinkToken(makeReq(RAW_WRONG_PROP), {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r7',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.response.status, 401);
  });

  test('valid token for a DEACTIVATED staff → 401', async () => {
    const res = await verifyStaffLinkToken(makeReq(RAW_INACTIVE), {
      pid: PROPERTY_A, staffId: STAFF_INACTIVE, requestId: 'r8',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.response.status, 401);
  });

  test('rate-limited failure path → 429', async () => {
    rateLimitAllow = false;
    const res = await verifyStaffLinkToken(makeReq(RAW_UNKNOWN), {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r9',
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.response.status, 429);
  });

  test('token accepted from POST body (bodyToken) as well as query', async () => {
    const req = new Request('https://staxis.test/api/housekeeper/room-action', {
      method: 'POST',
    }) as unknown as NextRequest;
    const res = await verifyStaffLinkToken(req, {
      pid: PROPERTY_A, staffId: STAFF_A, requestId: 'r10', bodyToken: RAW_VALID,
    });
    assert.equal(res.ok, true);
  });
});
