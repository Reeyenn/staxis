/**
 * Tests for the role-escalation guards on POST /api/auth/use-join-code.
 *
 * Two gates are load-bearing for this route's security:
 *
 *   1. Legacy join codes baked with role=owner or role=general_manager
 *      are REJECTED at line 115 of route.ts (audit finding F-06, plus
 *      migration 0150 revoking historical rows). Possession of such a
 *      code used to be an ownership-transfer primitive — the redeem
 *      path unconditionally rewrites properties.owner_id when
 *      finalRole='owner'.
 *
 *   2. New-flow codes (row.role=null) let the user pick their role
 *      from the request body, but the route restricts that choice to
 *      STAFF_SIGNUP_ROLES (front_desk, housekeeping, maintenance).
 *      Asking for role='admin' or 'owner' or 'general_manager' in the
 *      body returns 400 without creating an account. Without this,
 *      anyone with any shared code could self-promote.
 *
 * The audit added these tests after observing the route doesn't have a
 * regression test for either. Strategy: mock supabaseAdmin.from for the
 * tables the route touches (api_limits, hotel_join_codes) and call
 * the POST handler with crafted payloads.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { POST } from '@/app/api/auth/use-join-code/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

interface JoinCodeRow {
  id: string;
  hotel_id: string;
  role: string | null;
  expires_at: string;
  max_uses: number;
  used_count: number;
  revoked_at: string | null;
}

interface MockState {
  joinCode: JoinCodeRow | null;
  casConflict: boolean;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
}

const state: MockState = {
  joinCode: null,
  casConflict: false,
  insertedEvents: [],
};

beforeEach(() => {
  state.joinCode = null;
  state.casConflict = false;
  state.insertedEvents = [];

  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'api_limits') {
      // Rate limit: just return "allowed" (no existing row, insert succeeds).
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              gte: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
        insert: async () => ({ error: null }),
        update: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
        upsert: async () => ({ error: null }),
      };
    }
    if (table === 'hotel_join_codes') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: state.joinCode, error: null }),
          }),
        }),
        update: (_vals: Record<string, unknown>) => ({
          eq: (_col1: string, _val1: string) => ({
            eq: (_col2: string, _val2: string) => ({
              select: () => ({
                maybeSingle: async () =>
                  state.casConflict ? { data: null, error: null } : { data: { id: 'code-1' }, error: null },
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'app_events' || table === 'audit_log') {
      return {
        insert: async (row: { event_type?: string; metadata?: Record<string, unknown> }) => {
          if (row.event_type) {
            state.insertedEvents.push({
              event_type: row.event_type,
              metadata: row.metadata ?? {},
            });
          }
          return { error: null };
        },
      };
    }
    // Permissive default so a probe of an unmocked table doesn't crash mid-test.
    return {
      insert: async () => ({ error: null }),
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      update: () => ({
        eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function mockReq(body: Record<string, unknown>): Request {
  return new Request('https://staxis.test/api/auth/use-join-code', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.1',
    },
    body: JSON.stringify(body),
  });
}

const HOTEL_ID = 'hotel-uuid-1';
const FUTURE_EXP = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

// ─── Tests ───────────────────────────────────────────────────────────────

// Single-use owner/GM codes are NOW a legitimate onboarding primitive
// (migration 0273) — their full behavior, including the anti-displacement
// unclaimed-hotel guard, is covered in use-join-code-owner-onboarding.test.ts.
// What MUST stay forbidden here is the shared-code takeover vector that 0152
// closed: a MULTI-USE owner/GM code. A reusable privileged code, if leaked,
// is a "seize this hotel" token, so it's rejected before any account is made.
describe('use-join-code — multi-use privileged code rejection (F-06 / 0273)', () => {
  test('multi-use owner code → 410, security event logged, no auth user created', async () => {
    state.joinCode = {
      id: 'code-multiuse-owner',
      hotel_id: HOTEL_ID,
      role: 'owner',
      expires_at: FUTURE_EXP,
      max_uses: 5,  // multi-use = shared = forbidden
      used_count: 0,
      revoked_at: null,
    };

    const res = await POST(
      mockReq({
        code: 'MULTI001',
        email: 'attacker@example.com',
        displayName: 'A',
        password: 'pw_long_enough',
        role: 'housekeeping',  // ignored — baked role wins
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 410);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.privileged_multiuse_code_rejected',
    );
    assert.ok(refused, 'auth.privileged_multiuse_code_rejected must be logged');
    assert.equal(refused?.metadata.bakedRole, 'owner');
  });

  test('multi-use general_manager code → 410, event logged', async () => {
    state.joinCode = {
      id: 'code-multiuse-gm',
      hotel_id: HOTEL_ID,
      role: 'general_manager',
      expires_at: FUTURE_EXP,
      max_uses: 5,
      used_count: 0,
      revoked_at: null,
    };

    const res = await POST(
      mockReq({
        code: 'MULTI002',
        email: 'attacker@example.com',
        displayName: 'A',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 410);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.privileged_multiuse_code_rejected',
    );
    assert.ok(refused);
    assert.equal(refused?.metadata.bakedRole, 'general_manager');
  });
});

describe('use-join-code — new-flow role gating', () => {
  test('new-flow code + role=admin in body → 400, role-required error (NOT created as admin)', async () => {
    state.joinCode = {
      id: 'code-new-flow',
      hotel_id: HOTEL_ID,
      role: null,  // new-flow
      expires_at: FUTURE_EXP,
      max_uses: 5,
      used_count: 0,
      revoked_at: null,
    };

    const res = await POST(
      mockReq({
        code: 'NEW00001',
        email: 'attacker@example.com',
        displayName: 'A',
        password: 'pw_long_enough',
        role: 'admin',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    // Validate error mentions valid roles (no admin in the list).
    assert.match(JSON.stringify(body), /front_desk|housekeeping|maintenance/);
    // Critically — body must NOT silently accept role=admin.
    assert.doesNotMatch(JSON.stringify(body), /trusted":\s*true/);
  });

  test('new-flow code + role=owner in body → 400 (no self-promotion to owner)', async () => {
    state.joinCode = {
      id: 'code-new-flow',
      hotel_id: HOTEL_ID,
      role: null,
      expires_at: FUTURE_EXP,
      max_uses: 5,
      used_count: 0,
      revoked_at: null,
    };

    const res = await POST(
      mockReq({
        code: 'NEW00002',
        email: 'a@b.com',
        displayName: 'A',
        password: 'pw_long_enough',
        role: 'owner',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 400);
  });

  test('new-flow code + role=general_manager in body → 400 (no self-promotion to GM)', async () => {
    state.joinCode = {
      id: 'code-new-flow',
      hotel_id: HOTEL_ID,
      role: null,
      expires_at: FUTURE_EXP,
      max_uses: 5,
      used_count: 0,
      revoked_at: null,
    };

    const res = await POST(
      mockReq({
        code: 'NEW00003',
        email: 'a@b.com',
        displayName: 'A',
        password: 'pw_long_enough',
        role: 'general_manager',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 400);
  });

  test('new-flow code + missing role in body → 400 (role is required)', async () => {
    state.joinCode = {
      id: 'code-new-flow',
      hotel_id: HOTEL_ID,
      role: null,
      expires_at: FUTURE_EXP,
      max_uses: 5,
      used_count: 0,
      revoked_at: null,
    };

    const res = await POST(
      mockReq({
        code: 'NEW00004',
        email: 'a@b.com',
        displayName: 'A',
        password: 'pw_long_enough',
        // no role
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 400);
  });
});
