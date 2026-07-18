/**
 * Tests for the role-escalation guards on POST /api/auth/use-join-code.
 *
 * Two gates are load-bearing for this route's security:
 *
 *   1. Owner / general_manager codes are an ownership-ASSIGNMENT primitive:
 *      the redeem path rewrites properties.owner_id when finalRole='owner'.
 *      The lean self-onboarding flow (admin "+ New hotel") legitimately
 *      needs exactly one — a SINGLE-USE owner/GM code on a hotel that hasn't
 *      finished onboarding yet (owner_id still the admin placeholder). That
 *      is ALLOWED. Everything else stays locked (audit finding F-06):
 *        • multi-use owner/GM codes  → 410 (displacement vector), and
 *        • owner/GM code on a hotel that already COMPLETED onboarding
 *          (a live, claimed hotel) → 410 (can't displace an established
 *          owner).
 *
 *   2. New-flow codes (row.role=null) let the user pick their role from the
 *      request body, but the route restricts that choice to
 *      STAFF_SIGNUP_ROLES (front_desk, housekeeping, maintenance). Asking
 *      for role='admin'/'owner'/'general_manager' in the body returns 400
 *      without creating an account.
 *
 * Strategy: mock supabaseAdmin.from for the tables the route touches
 * (api_limits, hotel_join_codes, properties, app_events) and mock
 * auth.admin.createUser so the "allowed" path returns a clean failure past
 * the guard instead of hitting real Supabase. The end-to-end happy path
 * (account actually created + owner_id transferred) is verified live
 * against the deployed endpoint with throwaway data — it needs real auth.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { POST } from '@/app/api/auth/use-join-code/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const adminAuth = supabaseAdmin.auth.admin as unknown as {
  createUser: (...args: unknown[]) => Promise<{ data: { user: unknown }; error: unknown }>;
};
const originalCreateUser = adminAuth.createUser.bind(adminAuth);

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
  /** Drives the properties.onboarding_completed_at lookup in the F-06 gate. */
  propertyOnboardingCompletedAt: string | null;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
  casUpdateCalls: number;
}

const state: MockState = {
  joinCode: null,
  casConflict: false,
  propertyOnboardingCompletedAt: null,
  insertedEvents: [],
  casUpdateCalls: 0,
};

beforeEach(() => {
  state.joinCode = null;
  state.casConflict = false;
  state.propertyOnboardingCompletedAt = null;
  state.insertedEvents = [];
  state.casUpdateCalls = 0;

  // Mock createUser so any test that gets PAST the F-06 gate returns a
  // clean "Failed to create account" (400) instead of hitting real auth.
  adminAuth.createUser = async () => ({
    data: { user: null },
    error: { message: 'mocked: no real auth in unit tests' },
  });

  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'api_limits') {
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
        update: (_vals: Record<string, unknown>) => {
          state.casUpdateCalls += 1;
          return ({
          eq: (_col1: string, _val1: string) => ({
            eq: (_col2: string, _val2: string) => ({
              select: () => ({
                maybeSingle: async () =>
                  state.casConflict ? { data: null, error: null } : { data: { id: 'code-1' }, error: null },
              }),
            }),
          }),
          });
        },
      };
    }
    if (table === 'properties') {
      // The F-06 gate reads onboarding_completed_at to tell an unclaimed
      // onboarding hotel from a live, claimed one.
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { onboarding_completed_at: state.propertyOnboardingCompletedAt },
              error: null,
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
  adminAuth.createUser = originalCreateUser;
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

describe('use-join-code — F-06 displacement lock (still enforced)', () => {
  test('MULTI-USE owner code → 410, security event logged, no account', async () => {
    state.joinCode = {
      id: 'code-multi-owner',
      hotel_id: HOTEL_ID,
      role: 'owner',
      expires_at: FUTURE_EXP,
      max_uses: 2,           // not single-use → displacement vector → blocked
      used_count: 0,
      revoked_at: null,
    };

    const res = await POST(
      mockReq({
        code: 'MULTI001',
        email: 'attacker@example.com',
        displayName: 'A',
        password: 'pw_long_enough',
        role: 'housekeeping',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 410);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.legacy_privileged_code_rejected',
    );
    assert.ok(refused, 'auth.legacy_privileged_code_rejected must be logged');
    assert.equal(refused?.metadata.bakedRole, 'owner');
    assert.equal(refused?.metadata.maxUses, 2);
  });

  test('single-use owner code on an ALREADY-ONBOARDED hotel → 410 (no hijack of a live hotel)', async () => {
    state.joinCode = {
      id: 'code-owner-live',
      hotel_id: HOTEL_ID,
      role: 'owner',
      expires_at: FUTURE_EXP,
      max_uses: 1,
      used_count: 0,
      revoked_at: null,
    };
    state.propertyOnboardingCompletedAt = '2026-06-01T00:00:00Z'; // hotel is live/claimed

    const res = await POST(
      mockReq({
        code: 'LIVE0001',
        email: 'attacker@example.com',
        displayName: 'A',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 410);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.legacy_privileged_code_rejected',
    );
    assert.ok(refused, 'displacement attempt on a live hotel must be logged + blocked');
    assert.equal(refused?.metadata.onboardingComplete, true);
  });

  test('MULTI-USE general_manager code → 410, event logged', async () => {
    state.joinCode = {
      id: 'code-multi-gm',
      hotel_id: HOTEL_ID,
      role: 'general_manager',
      expires_at: FUTURE_EXP,
      max_uses: 3,
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
      (e) => e.event_type === 'auth.legacy_privileged_code_rejected',
    );
    assert.ok(refused);
    assert.equal(refused?.metadata.bakedRole, 'general_manager');
  });
});

describe('use-join-code — lean single-use owner invite (now allowed)', () => {
  test('single-use owner code on an UNCLAIMED (mid-onboarding) hotel passes F-06', async () => {
    state.joinCode = {
      id: 'code-lean-owner',
      hotel_id: HOTEL_ID,
      role: 'owner',
      expires_at: FUTURE_EXP,
      max_uses: 1,           // single-use
      used_count: 0,
      revoked_at: null,
    };
    state.propertyOnboardingCompletedAt = null; // unclaimed — onboarding not done

    const res = await POST(
      mockReq({
        code: 'LEAN0001',
        email: 'realowner@example.com',
        displayName: 'Real Owner',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );
    // It must NOT be rejected by the F-06 gate. (It then fails at the mocked
    // createUser with 400 — proving it got PAST the gate; the real happy
    // path is verified live.)
    assert.notEqual(res.status, 410);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.legacy_privileged_code_rejected',
    );
    assert.equal(refused, undefined, 'a legitimate single-use onboarding invite must NOT be F-06-rejected');
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
    assert.equal(state.casUpdateCalls, 0, 'invalid role must not consume a join-code slot');
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
    assert.equal(state.casUpdateCalls, 0, 'invalid role must not consume a join-code slot');
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
    assert.equal(state.casUpdateCalls, 0, 'invalid role must not consume a join-code slot');
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
    assert.equal(state.casUpdateCalls, 0, 'missing role must not consume a join-code slot');
  });
});
