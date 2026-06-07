/**
 * Behavior tests for owner / GM self-onboarding via POST /api/auth/use-join-code.
 *
 * Context: Phase M1.5 designed hotel-owner self-onboarding around an
 * admin-issued single-use join code. Migration 0152 had blanket-banned all
 * owner/GM codes (closing the shared-code takeover hole); migration 0273
 * re-allows them ONLY when single-use, and this route adds the second half
 * of the invariant — an anti-displacement guard that only honours an owner/GM
 * code on an UNCLAIMED hotel (still owned by the admin placeholder, onboarding
 * not yet completed).
 *
 * These tests prove the three load-bearing cases:
 *   (a) single-use OWNER code on an UNCLAIMED hotel → succeeds, creates an
 *       owner account, and TRANSFERS properties.owner_id to the new owner.
 *   (b) single-use OWNER code on an ALREADY-CLAIMED hotel → REJECTED, no
 *       account, no owner_id transfer (displacement is impossible).
 *   (c) MULTI-USE owner code → REJECTED (shared-code takeover stays closed).
 *   (+) single-use GM code on an unclaimed hotel → succeeds with
 *       property_access but NO owner_id transfer (GM isn't owner of record).
 *
 * Strategy mirrors use-join-code-role-escalation.test.ts: monkey-patch
 * supabaseAdmin.from for the tables the route touches, plus the auth-admin
 * createUser/deleteUser methods, and call the POST handler directly.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { POST } from '@/app/api/auth/use-join-code/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
// Loosely-typed handles so the tests can swap auth-admin + rpc methods for
// stubs (no real Supabase in unit tests). The no-explicit-any lint rule is
// not enabled in this project, so these casts need no disable directive.
const adminAuth = supabaseAdmin.auth.admin as any;
const originalCreateUser = adminAuth.createUser.bind(adminAuth);
const originalDeleteUser = adminAuth.deleteUser.bind(adminAuth);
const originalRpc = (supabaseAdmin as any).rpc.bind(supabaseAdmin);

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
  /** properties row returned by the unclaimed-guard read. */
  property: { owner_id: string | null; onboarding_completed_at: string | null } | null;
  propertyReadError: boolean;
  /** role of the accounts row whose data_user_id === property.owner_id. */
  ownerAccountRole: string | null;
  /** whether the owner-transfer CAS matches a row (false = concurrent claim). */
  ownerTransferMiss: boolean;
  casConflict: boolean;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
  accountsInserted: Array<Record<string, unknown>>;
  ownerTransfers: Array<Record<string, unknown>>;
  accountsDeleted: string[];
  createUserCalls: number;
  deleteUserCalls: number;
}

const NEW_OWNER_UID = 'new-owner-auth-uid';
const ADMIN_UID = 'admin-placeholder-auth-uid';
const REAL_OWNER_UID = 'real-owner-auth-uid';

const state: MockState = {
  joinCode: null,
  property: null,
  propertyReadError: false,
  ownerAccountRole: null,
  ownerTransferMiss: false,
  casConflict: false,
  insertedEvents: [],
  accountsInserted: [],
  ownerTransfers: [],
  accountsDeleted: [],
  createUserCalls: 0,
  deleteUserCalls: 0,
};

beforeEach(() => {
  state.joinCode = null;
  state.property = null;
  state.propertyReadError = false;
  state.ownerAccountRole = null;
  state.ownerTransferMiss = false;
  state.casConflict = false;
  state.insertedEvents = [];
  state.accountsInserted = [];
  state.ownerTransfers = [];
  state.accountsDeleted = [];
  state.createUserCalls = 0;
  state.deleteUserCalls = 0;

  adminAuth.createUser = async () => {
    state.createUserCalls += 1;
    return { data: { user: { id: NEW_OWNER_UID } }, error: null };
  };
  adminAuth.deleteUser = async (uid: string) => {
    state.deleteUserCalls += 1;
    return { data: { user: null }, error: null, uid };
  };
  (supabaseAdmin as any).rpc = async () => ({ data: null, error: null });

  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'api_limits') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              gte: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            }),
          }),
        }),
        insert: async () => ({ error: null }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
        upsert: async () => ({ error: null }),
      };
    }

    if (table === 'hotel_join_codes') {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: state.joinCode, error: null }) }),
        }),
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({
                maybeSingle: async () =>
                  state.casConflict ? { data: null, error: null } : { data: { id: 'code-1' }, error: null },
              }),
            }),
          }),
        }),
      };
    }

    if (table === 'properties') {
      return {
        // Unclaimed-guard read: .select(...).eq('id', x).maybeSingle()
        select: () => ({
          eq: () => ({
            maybeSingle: async () =>
              state.propertyReadError
                ? { data: null, error: { message: 'read failed' } }
                : { data: state.property, error: null },
          }),
        }),
        // Owner-transfer CAS: .update(v).eq().eq().is().select('id').maybeSingle()
        update: (vals: Record<string, unknown>) => {
          const builder: Record<string, unknown> = {};
          builder.eq = () => builder;
          builder.is = () => builder;
          builder.select = () => ({
            maybeSingle: async () => {
              state.ownerTransfers.push(vals);
              return state.ownerTransferMiss
                ? { data: null, error: null }
                : { data: { id: 'hotel-1' }, error: null };
            },
          });
          return builder;
        },
      };
    }

    if (table === 'accounts') {
      return {
        // Guard owner-role lookup: .select('role').eq('data_user_id', x).maybeSingle()
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: state.ownerAccountRole ? { role: state.ownerAccountRole } : null,
              error: null,
            }),
          }),
        }),
        // Account creation.
        insert: async (row: Record<string, unknown>) => {
          state.accountsInserted.push(row);
          return { error: null };
        },
        // Rollback on owner-transfer CAS miss.
        delete: () => ({
          eq: async (_col: string, val: string) => {
            state.accountsDeleted.push(val);
            return { error: null };
          },
        }),
      };
    }

    if (table === 'password_signin_proofs') {
      return { insert: async () => ({ error: null }) };
    }

    if (table === 'app_events') {
      return {
        insert: async (row: { event_type?: string; metadata?: Record<string, unknown> }) => {
          if (row.event_type) {
            state.insertedEvents.push({ event_type: row.event_type, metadata: row.metadata ?? {} });
          }
          return { error: null };
        },
      };
    }

    if (table === 'admin_audit_log' || table === 'audit_log') {
      return { insert: async () => ({ error: null }) };
    }

    // Permissive default.
    return {
      insert: async () => ({ error: null }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    };
  };
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  adminAuth.createUser = originalCreateUser;
  adminAuth.deleteUser = originalDeleteUser;
  (supabaseAdmin as any).rpc = originalRpc;
});

function mockReq(body: Record<string, unknown>): Request {
  return new Request('https://staxis.test/api/auth/use-join-code', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
      'user-agent': 'test-agent',
    },
    body: JSON.stringify(body),
  });
}

const HOTEL_ID = 'hotel-uuid-1';
const FUTURE_EXP = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function singleUseCode(role: 'owner' | 'general_manager'): JoinCodeRow {
  return {
    id: `code-${role}`,
    hotel_id: HOTEL_ID,
    role,
    expires_at: FUTURE_EXP,
    max_uses: 1,
    used_count: 0,
    revoked_at: null,
  };
}

// ─── (a) success on an unclaimed hotel ──────────────────────────────────────

describe('use-join-code — owner onboarding (a) success on unclaimed hotel', () => {
  test('single-use owner code on unclaimed hotel → 200, owner account created, owner_id transferred', async () => {
    state.joinCode = singleUseCode('owner');
    // Unclaimed: owner_id is the admin placeholder, onboarding not completed.
    state.property = { owner_id: ADMIN_UID, onboarding_completed_at: null };
    state.ownerAccountRole = 'admin';

    const res = await POST(
      mockReq({
        code: 'OWNER001',
        email: 'realowner@hotel.com',
        displayName: 'Real Owner',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // Exactly one account created, as OWNER, with access to the hotel.
    assert.equal(state.accountsInserted.length, 1);
    const acct = state.accountsInserted[0];
    assert.equal(acct.role, 'owner');
    assert.deepEqual(acct.property_access, [HOTEL_ID]);
    assert.equal(acct.data_user_id, NEW_OWNER_UID);

    // owner_id transferred to the new owner.
    assert.equal(state.ownerTransfers.length, 1);
    assert.equal(state.ownerTransfers[0].owner_id, NEW_OWNER_UID);

    // No displacement/rejection security events on the happy path.
    assert.equal(
      state.insertedEvents.filter((e) => e.event_type.startsWith('auth.privileged')).length,
      0,
    );
  });
});

// ─── (b) rejection on an already-claimed hotel (no displacement) ────────────

describe('use-join-code — owner onboarding (b) displacement blocked', () => {
  test('single-use owner code on hotel already owned by a real owner → 410, no account, no transfer', async () => {
    state.joinCode = singleUseCode('owner');
    // Claimed: current owner_id belongs to a real OWNER account, not the admin.
    state.property = { owner_id: REAL_OWNER_UID, onboarding_completed_at: null };
    state.ownerAccountRole = 'owner';

    const res = await POST(
      mockReq({
        code: 'OWNER002',
        email: 'attacker@example.com',
        displayName: 'Attacker',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );

    assert.equal(res.status, 410);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.privileged_code_displacement_blocked',
    );
    assert.ok(refused, 'displacement-blocked security event must be logged');
    assert.equal(refused?.metadata.reason, 'already_claimed');

    // CRITICAL: nothing was created, nothing was transferred.
    assert.equal(state.createUserCalls, 0);
    assert.equal(state.accountsInserted.length, 0);
    assert.equal(state.ownerTransfers.length, 0);
  });

  test('single-use owner code on a hotel whose onboarding already completed → 410, no account', async () => {
    state.joinCode = singleUseCode('owner');
    // Even if owner_id still looks like the admin placeholder, a completed
    // onboarding means the hotel is set up — reject.
    state.property = { owner_id: ADMIN_UID, onboarding_completed_at: new Date().toISOString() };
    state.ownerAccountRole = 'admin';

    const res = await POST(
      mockReq({
        code: 'OWNER003',
        email: 'attacker@example.com',
        displayName: 'Attacker',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );

    assert.equal(res.status, 410);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.privileged_code_displacement_blocked',
    );
    assert.ok(refused);
    assert.equal(refused?.metadata.reason, 'onboarding_completed');
    assert.equal(state.accountsInserted.length, 0);
    assert.equal(state.ownerTransfers.length, 0);
  });

  test('property read failure → fail CLOSED (410, no account)', async () => {
    state.joinCode = singleUseCode('owner');
    state.propertyReadError = true;

    const res = await POST(
      mockReq({
        code: 'OWNER004',
        email: 'attacker@example.com',
        displayName: 'Attacker',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );

    assert.equal(res.status, 410);
    assert.equal(state.accountsInserted.length, 0);
    assert.equal(state.ownerTransfers.length, 0);
  });
});

// ─── concurrent-claim: owner_id CAS miss must roll back the redemption ───────

describe('use-join-code — owner onboarding: concurrent-claim CAS miss rolls back', () => {
  test('owner code where the owner_id transfer CAS misses → 409, account + auth user rolled back, ownership not seized', async () => {
    state.joinCode = singleUseCode('owner');
    // Guard sees the hotel as unclaimed (admin placeholder)…
    state.property = { owner_id: ADMIN_UID, onboarding_completed_at: null };
    state.ownerAccountRole = 'admin';
    // …but the owner_id CAS matches no rows (a concurrent redemption of a
    // second owner code claimed the hotel first).
    state.ownerTransferMiss = true;

    const res = await POST(
      mockReq({
        code: 'OWNER006',
        email: 'second@hotel.com',
        displayName: 'Second Owner',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );

    assert.equal(res.status, 409);
    // The account was created, then fully rolled back.
    assert.equal(state.accountsInserted.length, 1);
    assert.deepEqual(state.accountsDeleted, [NEW_OWNER_UID]);
    assert.equal(state.deleteUserCalls, 1);
    // The CAS-miss was surfaced as a security event.
    const missed = state.insertedEvents.find((e) => e.event_type === 'auth.owner_transfer_cas_missed');
    assert.ok(missed, 'auth.owner_transfer_cas_missed must be logged');
  });
});

// ─── (c) multi-use owner code still rejected ────────────────────────────────

describe('use-join-code — owner onboarding (c) multi-use still forbidden', () => {
  test('multi-use owner code → 410 before any account creation', async () => {
    state.joinCode = { ...singleUseCode('owner'), max_uses: 2 };
    // Even if the hotel WERE unclaimed, multi-use is rejected outright.
    state.property = { owner_id: ADMIN_UID, onboarding_completed_at: null };
    state.ownerAccountRole = 'admin';

    const res = await POST(
      mockReq({
        code: 'OWNER005',
        email: 'attacker@example.com',
        displayName: 'Attacker',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );

    assert.equal(res.status, 410);
    const refused = state.insertedEvents.find(
      (e) => e.event_type === 'auth.privileged_multiuse_code_rejected',
    );
    assert.ok(refused, 'multi-use rejection event must be logged');
    assert.equal(state.createUserCalls, 0);
    assert.equal(state.accountsInserted.length, 0);
    assert.equal(state.ownerTransfers.length, 0);
  });
});

// ─── (+) GM single-use: access granted, NO owner_id transfer ────────────────

describe('use-join-code — GM onboarding grants access without owner transfer', () => {
  test('single-use GM code on unclaimed hotel → 200, GM account, NO owner_id transfer', async () => {
    state.joinCode = singleUseCode('general_manager');
    state.property = { owner_id: ADMIN_UID, onboarding_completed_at: null };
    state.ownerAccountRole = 'admin';

    const res = await POST(
      mockReq({
        code: 'GMONE001',
        email: 'gm@hotel.com',
        displayName: 'GM',
        password: 'pw_long_enough',
      }) as unknown as Parameters<typeof POST>[0],
    );

    assert.equal(res.status, 200);
    assert.equal(state.accountsInserted.length, 1);
    assert.equal(state.accountsInserted[0].role, 'general_manager');
    assert.deepEqual(state.accountsInserted[0].property_access, [HOTEL_ID]);
    // GM is NOT owner of record — owner_id must not be touched.
    assert.equal(state.ownerTransfers.length, 0);
  });
});
