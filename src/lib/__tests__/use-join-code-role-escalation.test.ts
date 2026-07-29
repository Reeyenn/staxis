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
 * Strategy: mock the closed join-code capability RPC plus the other tables the
 * route touches (api_limits, properties, app_events) and mock
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
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const adminAuth = supabaseAdmin.auth.admin as unknown as {
  createUser: (...args: unknown[]) => Promise<{ data: { user: unknown }; error: unknown }>;
  listUsers: (...args: unknown[]) => Promise<{ data: { users: unknown[] }; error: unknown }>;
  deleteUser: (...args: unknown[]) => Promise<{ data: unknown; error: unknown }>;
};
const originalCreateUser = adminAuth.createUser.bind(adminAuth);
const originalListUsers = adminAuth.listUsers.bind(adminAuth);
const originalDeleteUser = adminAuth.deleteUser.bind(adminAuth);

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
  capabilityUnavailable: boolean;
  finalizerUnavailable: boolean;
  databaseLifecycleConflict: boolean;
  createAuthUser: boolean;
  cleanupFindsLinkedAccount: boolean;
  /** Drives the properties.onboarding_completed_at lookup in the F-06 gate. */
  propertyOnboardingCompletedAt: string | null;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
  finalizationCalls: number;
  authDeleteCalls: number;
}

const state: MockState = {
  joinCode: null,
  capabilityUnavailable: false,
  finalizerUnavailable: false,
  databaseLifecycleConflict: false,
  createAuthUser: false,
  cleanupFindsLinkedAccount: false,
  propertyOnboardingCompletedAt: null,
  insertedEvents: [],
  finalizationCalls: 0,
  authDeleteCalls: 0,
};

beforeEach(() => {
  state.joinCode = null;
  state.capabilityUnavailable = false;
  state.finalizerUnavailable = false;
  state.databaseLifecycleConflict = false;
  state.createAuthUser = false;
  state.cleanupFindsLinkedAccount = false;
  state.propertyOnboardingCompletedAt = null;
  state.insertedEvents = [];
  state.finalizationCalls = 0;
  state.authDeleteCalls = 0;

  // Mock createUser so any test that gets PAST the F-06 gate returns a
  // clean "Failed to create account" (400) instead of hitting real auth.
  adminAuth.createUser = async () => state.createAuthUser
    ? ({ data: { user: { id: AUTH_USER_ID } }, error: null })
    : ({
        data: { user: null },
        error: { message: 'mocked: no real auth in unit tests' },
      });
  adminAuth.listUsers = async () => ({ data: { users: [] }, error: null });
  adminAuth.deleteUser = async () => {
    state.authDeleteCalls += 1;
    return { data: null, error: null };
  };

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
      throw new Error('use-join-code must not access hotel_join_codes directly');
    }
    if (table === 'properties') {
      // The F-06 gate reads onboarding_completed_at to tell an unclaimed
      // onboarding hotel from a live, claimed one.
      return {
        select: (columns: string) => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: columns === 'onboarding_completed_at'
                ? { onboarding_completed_at: state.propertyOnboardingCompletedAt }
                : null,
              error: null,
            }),
            limit: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      };
    }
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: state.cleanupFindsLinkedAccount ? { id: ACCOUNT_ID } : null,
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

  // @ts-expect-error narrow RPC facade for the serialized 0396 finalizer
  supabaseAdmin.rpc = async (fn: string, args?: Record<string, unknown>) => {
    if (fn === 'staxis_api_limit_hit') {
      return { data: 1, error: null };
    }
    if (fn === 'staxis_resolve_join_code_capability') {
      if (state.capabilityUnavailable) {
        return { data: null, error: { code: 'PGRST202', message: 'missing function' } };
      }
      const row = state.joinCode;
      if (!row) return { data: { ok: false, status: 'not_found' }, error: null };
      const expired = Date.parse(row.expires_at) <= Date.now();
      const status = row.revoked_at
        ? 'revoked'
        : expired
          ? 'expired'
          : row.used_count >= row.max_uses
            ? 'used_up'
            : 'active';
      return {
        data: {
          ok: true,
          schemaVersion: 'join-code-capability-v1',
          status,
          codeId: CODE_ID,
          hotelId: HOTEL_ID,
          codeKind: row.role === 'owner' || row.role === 'general_manager'
            ? 'privileged_onboarding'
            : 'staff_signup',
          role: row.role,
          expiresAt: row.expires_at,
          maxUses: row.max_uses,
          usedCount: row.used_count,
        },
        error: null,
      };
    }
    if (fn === 'staxis_finalize_join_code_signup') {
      state.finalizationCalls += 1;
      if (state.finalizerUnavailable) {
        return { data: null, error: { code: 'PGRST202', message: 'missing finalizer' } };
      }
      if (state.databaseLifecycleConflict) {
        return { data: { ok: false, status: 'revoked' }, error: null };
      }
      return {
        data: {
          ok: true,
          schemaVersion: 'join-code-signup-finalization-v1',
          status: 'finalized',
          codeId: CODE_ID,
          hotelId: HOTEL_ID,
          accountId: ACCOUNT_ID,
          finalRole: args?.p_requested_role,
          username: args?.p_username,
          pendingApproval: state.joinCode?.role === null,
          usedCount: Number(args?.p_expected_used_count) + 1,
        },
        error: null,
      };
    }
    return { data: null, error: { message: `unexpected RPC ${fn}` } };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  adminAuth.createUser = originalCreateUser;
  adminAuth.listUsers = originalListUsers;
  adminAuth.deleteUser = originalDeleteUser;
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

const HOTEL_ID = '90000000-0000-4000-8000-000000000001';
const CODE_ID = '90000000-0000-4000-8000-000000000002';
const AUTH_USER_ID = '90000000-0000-4000-8000-000000000003';
const ACCOUNT_ID = '90000000-0000-4000-8000-000000000004';
const FUTURE_EXP = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

// ─── Tests ───────────────────────────────────────────────────────────────

describe('use-join-code — F-06 displacement lock (still enforced)', () => {
  test('poisoned multi-use owner receipt fails closed before claim', async () => {
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
    assert.equal(res.status, 503);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.legacy_privileged_code_rejected',
    );
    assert.equal(refused, undefined, 'malformed DB capability is not trusted enough to audit as a fact');
    assert.equal(state.finalizationCalls, 0);
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

  test('poisoned multi-use general_manager receipt fails closed before claim', async () => {
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
    assert.equal(res.status, 503);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.legacy_privileged_code_rejected',
    );
    assert.equal(refused, undefined);
    assert.equal(state.finalizationCalls, 0);
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
    assert.equal(res.status, 400);
    assert.equal(state.finalizationCalls, 0);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.legacy_privileged_code_rejected',
    );
    assert.equal(refused, undefined, 'a legitimate single-use onboarding invite must NOT be F-06-rejected');
  });

  test('database lifecycle recheck can veto a stale unclaimed precheck', async () => {
    state.joinCode = {
      id: 'code-stale-owner',
      hotel_id: HOTEL_ID,
      role: 'owner',
      expires_at: FUTURE_EXP,
      max_uses: 1,
      used_count: 0,
      revoked_at: null,
    };
    state.propertyOnboardingCompletedAt = null;
    state.databaseLifecycleConflict = true;
    state.createAuthUser = true;

    const res = await POST(
      mockReq({
        code: 'STALE001',
        email: 'late@example.com',
        displayName: 'Late Claim',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 410);
    assert.equal(state.finalizationCalls, 1);
    assert.equal(state.authDeleteCalls, 1, 'a refused finalization removes the unlinked Auth identity');
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.legacy_privileged_code_rejected',
    );
    assert.equal(refused?.metadata.reason, 'database_finalization_recheck');
  });
});

describe('use-join-code — new-flow role gating', () => {
  test('missing resolver during app-first rollout fails retryably and does not touch the table', async () => {
    state.capabilityUnavailable = true;

    const res = await POST(
      mockReq({
        code: 'ROLL-ABCD234567',
        email: 'retry@example.com',
        displayName: 'Retry',
        password: 'pw_long_enough',
        role: 'front_desk',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '5');
    assert.equal(state.finalizationCalls, 0);
  });

  test('missing finalizer after Auth creation retries, cleans the unlinked identity, and never falls back', async () => {
    state.joinCode = {
      id: 'code-app-first-staff',
      hotel_id: HOTEL_ID,
      role: null,
      expires_at: FUTURE_EXP,
      max_uses: 100,
      used_count: 0,
      revoked_at: null,
    };
    state.createAuthUser = true;
    state.finalizerUnavailable = true;

    const res = await POST(
      mockReq({
        code: 'ROLL-BCDE234567',
        email: 'retry-finalizer@example.com',
        displayName: 'Retry Finalizer',
        password: 'pw_long_enough',
        role: 'front_desk',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '5');
    assert.equal(state.finalizationCalls, 2, 'idempotent finalizer is retried once');
    assert.equal(state.authDeleteCalls, 1, 'the still-unlinked Auth identity is removed');
  });

  test('an ambiguous finalizer transport failure never deletes an Auth identity with a committed account edge', async () => {
    state.joinCode = {
      id: 'code-ambiguous-staff',
      hotel_id: HOTEL_ID,
      role: null,
      expires_at: FUTURE_EXP,
      max_uses: 100,
      used_count: 0,
      revoked_at: null,
    };
    state.createAuthUser = true;
    state.finalizerUnavailable = true;
    state.cleanupFindsLinkedAccount = true;

    const res = await POST(
      mockReq({
        code: 'ROLL-CDEF234567',
        email: 'ambiguous@example.com',
        displayName: 'Ambiguous Commit',
        password: 'pw_long_enough',
        role: 'maintenance',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 503);
    assert.equal(state.finalizationCalls, 2);
    assert.equal(state.authDeleteCalls, 0, 'deletion would cascade a committed account');
  });

  test('valid staff signup delegates its only relational write to the atomic finalizer', async () => {
    state.joinCode = {
      id: 'code-valid-staff',
      hotel_id: HOTEL_ID,
      role: null,
      expires_at: FUTURE_EXP,
      max_uses: 100,
      used_count: 0,
      revoked_at: null,
    };
    state.createAuthUser = true;

    const res = await POST(
      mockReq({
        code: 'GOOD-ABCD234567',
        email: 'new.housekeeper@example.com',
        displayName: 'New Housekeeper',
        password: 'pw_long_enough',
        role: 'housekeeping',
      }) as unknown as Parameters<typeof POST>[0],
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { data: { pendingApproval: boolean } };
    assert.equal(body.data.pendingApproval, true);
    assert.equal(state.finalizationCalls, 1);
    assert.equal(state.authDeleteCalls, 0);
  });

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
    assert.equal(state.finalizationCalls, 0, 'invalid role must not consume a join-code slot');
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
    assert.equal(state.finalizationCalls, 0, 'invalid role must not consume a join-code slot');
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
    assert.equal(state.finalizationCalls, 0, 'invalid role must not consume a join-code slot');
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
    assert.equal(state.finalizationCalls, 0, 'missing role must not consume a join-code slot');
  });
});
