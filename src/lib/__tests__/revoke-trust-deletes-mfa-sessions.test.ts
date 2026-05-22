/**
 * Tests for the mfa_verified_sessions delete added to /api/auth/revoke-trust
 * in the 2026-05-22 Phase 2B audit. Sign-out should kill ALL of the user's
 * sessions' mfa_verified state, not just the current one (matches the
 * existing trusted_devices "delete-all-for-account" semantics).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/auth/revoke-trust/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

type GetUserFn = typeof supabaseAdmin.auth.getUser;
type FromFn = typeof supabaseAdmin.from;
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

interface MockState {
  user: { id: string } | null;
  account: { id: string } | null;
  trustedDevicesDeleteError: { message: string } | null;
  mfaSessionsDeleteError: { message: string } | null;
  mfaSessionsDeleteCalls: Array<{ userId: string }>;
  insertedEvents: Array<{ event_type: string; metadata: Record<string, unknown> }>;
}
const state: MockState = {
  user: null,
  account: null,
  trustedDevicesDeleteError: null,
  mfaSessionsDeleteError: null,
  mfaSessionsDeleteCalls: [],
  insertedEvents: [],
};

beforeEach(() => {
  state.user = null;
  state.account = null;
  state.trustedDevicesDeleteError = null;
  state.mfaSessionsDeleteError = null;
  state.mfaSessionsDeleteCalls = [];
  state.insertedEvents = [];

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
        delete: () => ({
          eq: async () => ({ error: state.trustedDevicesDeleteError, count: 1 }),
        }),
      };
    }
    if (table === 'mfa_verified_sessions') {
      return {
        delete: () => ({
          eq: async (_col: string, val: string) => {
            state.mfaSessionsDeleteCalls.push({ userId: val });
            return { error: state.mfaSessionsDeleteError, count: 2 };
          },
        }),
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

const USER_ID = '11111111-2222-3333-4444-555555555555';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(): NextRequest {
  return {
    url: 'https://staxis.test/api/auth/revoke-trust',
    method: 'POST',
    headers: new Headers({
      authorization: 'Bearer fake-but-mock-accepts',
      'content-type': 'application/json',
    }),
    cookies: { get: () => undefined },
    json: async () => ({ source: 'signout' }),
  } as unknown as NextRequest;
}

function ok(): void {
  state.user = { id: USER_ID };
  state.account = { id: ACCOUNT_ID };
}

describe('revoke-trust — mfa_verified_sessions delete (Phase 2B)', () => {
  test('happy path → trusted_devices deleted AND mfa_verified_sessions deleted for user', async () => {
    ok();
    const res = await POST(mockReq());
    assert.equal(res.status, 200);
    assert.equal(state.mfaSessionsDeleteCalls.length, 1, 'must delete from mfa_verified_sessions exactly once');
    assert.equal(state.mfaSessionsDeleteCalls[0].userId, USER_ID, 'scoped to the user, not the account');
    // Audit event includes both counts.
    const ev = state.insertedEvents.find((e) => e.event_type === 'auth.trust_revoked');
    assert.ok(ev);
    assert.equal(ev?.metadata.mfaSessionsDeletedCount, 2);
  });

  test('mfa_verified_sessions delete fails → non-fatal, route still 200, trusted_devices delete succeeded', async () => {
    // Primary action (trusted_devices delete + cookie clear) still
    // happened. The auth-hook layer may briefly serve stale mfa_verified
    // claims until the FK CASCADE or janitor cron cleans up, but the
    // website-layer (Phase 1) gate is still closed.
    ok();
    state.mfaSessionsDeleteError = { message: 'transient db error' };
    const res = await POST(mockReq());
    assert.equal(res.status, 200, 'route must succeed even if mfa_verified_sessions delete fails');
  });

  test('trusted_devices delete fails → route still 500 (existing behavior preserved)', async () => {
    ok();
    state.trustedDevicesDeleteError = { message: 'transient db error' };
    const res = await POST(mockReq());
    assert.equal(res.status, 500);
    // mfa_verified_sessions delete is gated on trusted_devices succeeding —
    // existing flow returns early on trusted_devices error, so we don't
    // even attempt the mfa delete.
    assert.equal(state.mfaSessionsDeleteCalls.length, 0);
  });
});
