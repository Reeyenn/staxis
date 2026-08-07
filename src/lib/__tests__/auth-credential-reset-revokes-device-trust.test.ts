/**
 * Resetting somebody ELSE's password must take their second factor with it.
 *
 * THE HOLE THIS PINS (auth sweep 2026-08-07).
 *
 * `/api/auth/revoke-trust` exists because F-02 in the original auth plan found
 * that rotating a password was a no-op against a stolen `staxis_device`
 * cookie: the `trusted_devices` row is written with a ten-year `expires_at`,
 * the cookie rolls forward 400 days on every sign-in, and the per-session
 * `mfa_verified_sessions` row keeps that browser's database reads open. Sign-out
 * and the self-service reset at `/signin/reset` both call it.
 *
 * Neither path where somebody else does the reset did:
 *
 *   PUT /api/auth/team      — a manager resetting a staff member's password
 *                             from My Hotel -> People.
 *   PUT /api/auth/accounts  — a platform admin resetting any password or
 *                             rotating a sign-in email.
 *
 * Those are the levers a hotel reaches for when a phone is lost or somebody is
 * let go. Leaving the trust behind means the reset takes away one of the two
 * things standing between that browser and the hotel's data, and the manager is
 * told it worked.
 *
 * These tests exercise the real PUT handler and the shared revoker.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { PUT } from '@/app/api/auth/accounts/route';
import { revokeAllDeviceTrustForAccount } from '@/lib/auth-revoke-device-trust';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { invalidateTwoFactorCache } from '@/lib/two-factor';

type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;
type UpdateUserFn = typeof supabaseAdmin.auth.admin.updateUserById;

const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalUpdateUser: UpdateUserFn = supabaseAdmin.auth.admin.updateUserById.bind(
  supabaseAdmin.auth.admin,
);

const ADMIN_AUTH_USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_AUTH_USER_ID = '44444444-4444-4444-8444-444444444444';

interface Deletion { table: string; column: string; value: string }

interface MockState {
  deletions: Deletion[];
  events: Array<{ event_type: string; metadata: Record<string, unknown> }>;
  passwordUpdates: Array<{ id: string; attrs: Record<string, unknown> }>;
  deleteError: { message: string } | null;
}

const state: MockState = { deletions: [], events: [], passwordUpdates: [], deleteError: null };

function accountsTable() {
  return {
    select: () => ({
      eq: (column: string, value: string) => ({
        maybeSingle: async () => {
          if (column === 'data_user_id' && value === ADMIN_AUTH_USER_ID) {
            return {
              data: { id: ADMIN_ACCOUNT_ID, role: 'admin', active: true, skip_2fa: false },
              error: null,
            };
          }
          if (column === 'id' && value === TARGET_ACCOUNT_ID) {
            return {
              data: {
                id: TARGET_ACCOUNT_ID,
                data_user_id: TARGET_AUTH_USER_ID,
                role: 'housekeeping',
                display_name: 'Maria',
                active: true,
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      }),
    }),
    update: () => ({ eq: async () => ({ error: null }) }),
  };
}

function deletingTable(table: string) {
  return {
    delete: () => ({
      eq: async (column: string, value: string) => {
        if (state.deleteError) return { error: state.deleteError, count: null };
        state.deletions.push({ table, column, value });
        return { error: null, count: 1 };
      },
    }),
  };
}

beforeEach(() => {
  invalidateTwoFactorCache();
  state.deletions = [];
  state.events = [];
  state.passwordUpdates = [];
  state.deleteError = null;

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: ADMIN_AUTH_USER_ID, email: 'admin@staxis.test' } },
    error: null,
  })) as unknown as GetUserFn;

  supabaseAdmin.auth.admin.updateUserById = (async (id: string, attrs: Record<string, unknown>) => {
    state.passwordUpdates.push({ id, attrs });
    return { data: { user: { id } }, error: null };
  }) as unknown as UpdateUserFn;

  // @ts-expect-error monkey-patch
  supabaseAdmin.from = (table: string) => {
    if (table === 'app_settings') {
      // Global 2FA switch OFF so requireSession's device gate short-circuits;
      // this test is about the revocation, not about the gate.
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { two_factor_enabled: false }, error: null }) }),
        }),
      };
    }
    if (table === 'accounts') return accountsTable();
    if (table === 'trusted_devices' || table === 'mfa_verified_sessions') return deletingTable(table);
    if (table === 'app_events') {
      return {
        insert: async (row: { event_type: string; metadata: Record<string, unknown> }) => {
          state.events.push(row);
          return { error: null };
        },
      };
    }
    if (table === 'admin_audit_log') return { insert: async () => ({ error: null }) };
    throw new Error(`unexpected table: ${table}`);
  };
});

afterEach(() => {
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.auth.admin.updateUserById = originalUpdateUser;
  supabaseAdmin.from = originalFrom;
  invalidateTwoFactorCache();
});

function mockPut(body: Record<string, unknown>): import('next/server').NextRequest {
  const headers = new Headers({
    authorization: 'Bearer header.payload.signature',
    'content-type': 'application/json',
    'x-account-id': ADMIN_ACCOUNT_ID,
  });
  return {
    url: 'https://staxis.test/api/auth/accounts',
    method: 'PUT',
    headers: { get: (name: string) => headers.get(name) },
    cookies: { get: () => undefined },
    json: async () => body,
  } as unknown as import('next/server').NextRequest;
}

describe('admin password reset revokes the target account device trust', () => {
  test('resetting another account password deletes its trusted devices and MFA sessions', async () => {
    const res = await PUT(mockPut({ accountId: TARGET_ACCOUNT_ID, password: 'brand-new-pass' }));
    assert.equal(res.status, 200, 'the reset itself must still succeed');
    assert.equal(state.passwordUpdates.length, 1, 'the password must actually be rotated');

    const devices = state.deletions.find((d) => d.table === 'trusted_devices');
    assert.ok(
      devices,
      'the target trusted_devices rows must be deleted — otherwise the old browser keeps the '
      + 'second factor for up to a year after the password it no longer knows was replaced',
    );
    assert.equal(devices?.column, 'account_id');
    assert.equal(devices?.value, TARGET_ACCOUNT_ID);

    const sessions = state.deletions.find((d) => d.table === 'mfa_verified_sessions');
    assert.ok(sessions, 'the target per-session MFA verifications must be deleted too');
    assert.equal(sessions?.column, 'user_id');
    assert.equal(
      sessions?.value,
      TARGET_AUTH_USER_ID,
      'mfa_verified_sessions is keyed by auth user, not by account',
    );
  });

  test('the revocation is recorded, and it names the target rather than the actor alone', async () => {
    await PUT(mockPut({ accountId: TARGET_ACCOUNT_ID, password: 'brand-new-pass' }));
    const revoked = state.events.find((e) => e.event_type === 'auth.trust_revoked');
    assert.ok(revoked, 'a trust revocation must leave an append-only record');
    assert.equal(revoked?.metadata.source, 'admin_password_reset');
    assert.equal(revoked?.metadata.accountId, TARGET_ACCOUNT_ID);
    assert.equal(revoked?.metadata.targetAuthUserId, TARGET_AUTH_USER_ID);
  });

  test('an update that touches no credential leaves device trust alone', async () => {
    const res = await PUT(mockPut({ accountId: TARGET_ACCOUNT_ID, displayName: 'Maria G' }));
    assert.equal(res.status, 200);
    assert.equal(
      state.deletions.length,
      0,
      'renaming somebody must not sign them out of every device they own',
    );
  });

  test('a failed revocation does not report the password reset as failed, but is recorded', async () => {
    state.deleteError = { message: 'connection reset' };
    const res = await PUT(mockPut({ accountId: TARGET_ACCOUNT_ID, password: 'brand-new-pass' }));
    assert.equal(
      res.status,
      200,
      'the password has already been rotated, so telling the admin it failed would be a lie',
    );
    const failure = state.events.find((e) => e.event_type === 'auth.trust_revoke_failed');
    assert.ok(failure, 'the gap must be visible rather than silent');
  });
});

describe('revokeAllDeviceTrustForAccount', () => {
  test('deletes from both tables and reports what it removed', async () => {
    const result = await revokeAllDeviceTrustForAccount({
      accountId: TARGET_ACCOUNT_ID,
      authUserId: TARGET_AUTH_USER_ID,
      reason: 'manager_password_reset',
      actorUserId: ADMIN_AUTH_USER_ID,
      requestId: 'req-1',
    });
    assert.equal(result.ok, true);
    assert.equal(result.trustedDevicesDeleted, 1);
    assert.equal(result.mfaSessionsDeleted, 1);
    assert.deepEqual(
      state.deletions.map((d) => d.table).sort(),
      ['mfa_verified_sessions', 'trusted_devices'],
    );
  });

  test('reports ok:false when a delete fails so the caller can decide', async () => {
    state.deleteError = { message: 'connection reset' };
    const result = await revokeAllDeviceTrustForAccount({
      accountId: TARGET_ACCOUNT_ID,
      authUserId: TARGET_AUTH_USER_ID,
      reason: 'admin_password_reset',
    });
    assert.equal(result.ok, false);
  });
});
