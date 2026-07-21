/**
 * Direct contract tests for /api/auth/team.
 *
 * These exercise the real route boundary (session + trusted-device check,
 * manager-floor capability, selected-hotel scope, hierarchy, mutation, and API
 * envelope) over an in-memory Supabase stub. The load-bearing scenario is a
 * Hotel A manager looking at an employee who also works at Hotel B: Hotel A
 * access may be detached, but account-wide name/role/password changes must be
 * refused unless the caller manages both hotels.
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';

import { DELETE, GET, PUT } from '@/app/api/auth/team/route';
import { supabaseAdmin } from '@/lib/supabase-admin';

const HOTEL_A = '11111111-1111-1111-1111-111111111111';
const HOTEL_B = '22222222-2222-2222-2222-222222222222';
const HOTEL_C = '33333333-3333-3333-3333-333333333333';
const CALLER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MULTI_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LOCAL_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OWNER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const PEER_GM_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CALLER_USER_ID = '10000000-0000-0000-0000-000000000001';

type TestRole = 'admin' | 'owner' | 'general_manager' | 'front_desk' | 'housekeeping' | 'maintenance' | 'staff';

interface AccountFixture {
  id: string;
  username: string;
  display_name: string;
  role: TestRole;
  property_access: string[];
  created_at: string;
  data_user_id: string;
  staff_id: string | null;
  updated_at: string;
  skip_2fa: boolean;
}

interface TestState {
  accounts: AccountFixture[];
  accountUpdates: Array<{ accountId: string; values: Record<string, unknown> }>;
  passwordUpdates: Array<{ userId: string; password: string }>;
  auditRows: Array<Record<string, unknown>>;
  roleChangeRows: Array<Record<string, unknown>>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  capabilityOverrides: Array<{ property_id: string; capability: string; role: string; allowed: boolean }>;
  capabilityOverrideError: { message: string } | null;
  staffLinks: Array<{ account_id: string; property_id: string; staff_id: string; is_active: boolean }>;
  accountUpdateConflicts: Set<string>;
  removalConflicts: Set<string>;
}

let state: TestState;

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
type GetUserFn = typeof supabaseAdmin.auth.getUser;
type ListUsersFn = typeof supabaseAdmin.auth.admin.listUsers;
type UpdateUserFn = typeof supabaseAdmin.auth.admin.updateUserById;

const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalListUsers: ListUsersFn = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);
const originalUpdateUser: UpdateUserFn = supabaseAdmin.auth.admin.updateUserById.bind(supabaseAdmin.auth.admin);

function fixture(
  id: string,
  role: TestRole,
  propertyAccess: string[],
  displayName: string,
  dataUserId = `90000000-0000-0000-0000-${id.slice(0, 12)}`,
): AccountFixture {
  return {
    id,
    username: displayName.toLowerCase().replaceAll(' ', '.'),
    display_name: displayName,
    role,
    property_access: propertyAccess,
    created_at: '2026-07-01T12:00:00.000Z',
    data_user_id: dataUserId,
    staff_id: null,
    updated_at: '2026-07-01T12:00:00.000Z',
    skip_2fa: false,
  };
}

function resetState(): void {
  state = {
    accounts: [
      fixture(CALLER_ID, 'general_manager', [HOTEL_A], 'Alex Manager', CALLER_USER_ID),
      fixture(MULTI_ID, 'housekeeping', [HOTEL_A, HOTEL_B], 'Morgan Multi'),
      fixture(LOCAL_ID, 'housekeeping', [HOTEL_A], 'Leslie Local'),
      fixture(OWNER_ID, 'owner', [HOTEL_A], 'Olivia Owner'),
      fixture(PEER_GM_ID, 'general_manager', [HOTEL_A], 'Gina Manager'),
    ],
    accountUpdates: [],
    passwordUpdates: [],
    auditRows: [],
    roleChangeRows: [],
    rpcCalls: [],
    capabilityOverrides: [],
    capabilityOverrideError: null,
    staffLinks: [],
    accountUpdateConflicts: new Set(),
    removalConflicts: new Set(),
  };
}

function installSupabaseStub(): void {
  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: CALLER_USER_ID, email: 'alex@hotel-a.test' } },
    error: null,
  })) as unknown as GetUserFn;

  supabaseAdmin.auth.admin.listUsers = (async () => ({
    data: {
      users: state.accounts.map((account) => ({
        id: account.data_user_id,
        email: `${account.username}@example.test`,
      })),
      aud: 'authenticated',
      nextPage: null,
      lastPage: 1,
      total: state.accounts.length,
    },
    error: null,
  })) as unknown as ListUsersFn;

  supabaseAdmin.auth.admin.updateUserById = (async (userId: string, attrs: { password?: string }) => {
    if (attrs.password) state.passwordUpdates.push({ userId, password: attrs.password });
    return { data: { user: null }, error: null };
  }) as unknown as UpdateUserFn;

  supabaseAdmin.rpc = (async (fn: string, args?: Record<string, unknown>) => {
    const safeArgs = args ?? {};
    state.rpcCalls.push({ fn, args: safeArgs });
    if (fn === 'staxis_remove_property_access_guarded') {
      const target = state.accounts.find((account) => account.id === safeArgs.p_account_id);
      if (!target) return { data: { status: 'not_found' }, error: null };
      if (state.removalConflicts.has(target.id)) {
        return { data: { status: 'conflict' }, error: null };
      }
      if (target.role !== safeArgs.p_expected_role || target.updated_at !== safeArgs.p_expected_updated_at) {
        return { data: { status: 'conflict' }, error: null };
      }
      target.property_access = target.property_access.filter((hotelId) => hotelId !== safeArgs.p_hotel_id);
      target.updated_at = '2026-07-01T12:00:01.000Z';
      return { data: { status: 'ok', remaining_hotels: target.property_access.length }, error: null };
    }
    return { data: null, error: null };
  }) as unknown as RpcFn;

  supabaseAdmin.from = ((table: string) => {
    if (table === 'accounts') return accountBuilder();

    if (table === 'account_property_staff_links') {
      const equals = new Map<string, unknown>();
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          equals.set(column, value);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.staffLinks.filter((row) => [...equals].every(
            ([column, value]) => (row as unknown as Record<string, unknown>)[column] === value,
          )),
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'trusted_devices') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: {
            id: 'trusted-device',
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            absolute_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          },
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'app_settings') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: { two_factor_enabled: true }, error: null }),
      };
      return builder;
    }

    if (table === 'capability_overrides') {
      let propertyId: string | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          if (column === 'property_id') propertyId = value as string;
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: state.capabilityOverrideError
            ? null
            : state.capabilityOverrides.filter((row) => row.property_id === propertyId),
          error: state.capabilityOverrideError,
        }),
      };
      return builder;
    }

    if (table === 'admin_audit_log') {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.auditRows.push(row);
          return { error: null };
        },
      };
    }

    if (table === 'role_changes') {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.roleChangeRows.push(row);
          return { error: null };
        },
      };
    }

    if (table === 'staff') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return builder;
    }

    throw new Error(`Unexpected table in auth-team route test: ${table}`);
  }) as unknown as FromFn;
}

function accountBuilder(): Record<string, unknown> {
  const equals = new Map<string, unknown>();
  const notEquals = new Map<string, unknown>();
  let updateValues: Record<string, unknown> | null = null;

  const matching = () => state.accounts.filter((account) => {
    for (const [column, value] of equals) {
      if ((account as unknown as Record<string, unknown>)[column] !== value) return false;
    }
    for (const [column, value] of notEquals) {
      if ((account as unknown as Record<string, unknown>)[column] === value) return false;
    }
    return true;
  });

  const result = () => {
    if (updateValues) {
      const accountId = equals.get('id');
      if (typeof accountId === 'string' && state.accountUpdateConflicts.has(accountId)) {
        const target = state.accounts.find((account) => account.id === accountId);
        if (target) target.updated_at = '2026-07-01T12:00:02.000Z';
      }
    }
    const rows = matching();
    if (updateValues) {
      for (const account of rows) {
        Object.assign(account, updateValues);
        account.updated_at = '2026-07-01T12:00:01.000Z';
        state.accountUpdates.push({ accountId: account.id, values: { ...updateValues } });
      }
    }
    return { data: rows, error: null };
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      equals.set(column, value);
      return builder;
    },
    neq: (column: string, value: unknown) => {
      notEquals.set(column, value);
      return builder;
    },
    order: () => builder,
    update: (values: Record<string, unknown>) => {
      updateValues = values;
      return builder;
    },
    maybeSingle: async () => {
      const { data, error } = result();
      return { data: data[0] ?? null, error };
    },
    then: (resolve: (value: unknown) => unknown) => resolve(result()),
  };
  return builder;
}

function request(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: Record<string, unknown>): NextRequest {
  return new NextRequest(`https://staxis.test${path}`, {
    method,
    headers: {
      authorization: 'Bearer route-contract-token',
      cookie: `staxis_device=${'a'.repeat(64)}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function account(accountId: string): AccountFixture {
  const found = state.accounts.find((row) => row.id === accountId);
  assert.ok(found, `missing fixture ${accountId}`);
  return found;
}

beforeEach(() => {
  resetState();
  installSupabaseStub();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.auth.admin.listUsers = originalListUsers;
  supabaseAdmin.auth.admin.updateUserById = originalUpdateUser;
});

describe('GET /api/auth/team action contract', () => {
  test('returns truthful row permissions and global-impact metadata', async () => {
    const hotelAStaff = '44444444-4444-4444-4444-444444444444';
    const hotelBStaff = '55555555-5555-5555-5555-555555555555';
    account(MULTI_ID).staff_id = hotelBStaff;
    state.staffLinks.push(
      { account_id: MULTI_ID, property_id: HOTEL_A, staff_id: hotelAStaff, is_active: true },
      { account_id: MULTI_ID, property_id: HOTEL_B, staff_id: hotelBStaff, is_active: true },
    );
    const response = await GET(request('GET', `/api/auth/team?hotelId=${HOTEL_A}`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.data.team));

    const byId = new Map<string, Record<string, unknown>>(
      body.data.team.map((row: Record<string, unknown>) => [row.accountId as string, row]),
    );

    const self = byId.get(CALLER_ID)!;
    assert.deepEqual(self.actions, {
      canEditProfile: true,
      canChangeRole: false,
      canResetPassword: true,
      canRemove: false,
    });
    assert.equal(self.isSelf, true);

    const local = byId.get(LOCAL_ID)!;
    assert.deepEqual(local.actions, {
      canEditProfile: true,
      canChangeRole: true,
      canResetPassword: false,
      canRemove: true,
    });
    assert.equal(local.canChangeRole, true, 'flat alias matches grouped action');
    assert.equal(local.hasOtherHotelAccess, false);

    const multi = byId.get(MULTI_ID)!;
    assert.deepEqual(multi.actions, {
      canEditProfile: false,
      canChangeRole: false,
      canResetPassword: false,
      canRemove: true,
    });
    assert.equal(multi.hotelAccessCount, 2);
    assert.equal(multi.hasOtherHotelAccess, true);
    assert.equal(multi.staffId, hotelAStaff, 'staff identity must be scoped to the selected hotel');
    assert.deepEqual(multi.globalImpact, {
      displayNameAffectsAllHotels: true,
      roleAffectsAllHotels: true,
      passwordAffectsAllHotels: true,
      hotelAccessCount: 2,
      hasOtherHotelAccess: true,
    });

    // A GM cannot mutate an owner or a peer GM through this route.
    for (const protectedId of [OWNER_ID, PEER_GM_ID]) {
      assert.deepEqual(byId.get(protectedId)!.actions, {
        canEditProfile: false,
        canChangeRole: false,
        canResetPassword: false,
        canRemove: false,
      });
    }
  });
});

describe('PUT /api/auth/team cross-hotel account safety', () => {
  test('capability override read outages fail closed with a retryable 503', async () => {
    state.capabilityOverrideError = { message: 'simulated capability store outage' };

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Must Not Save',
    }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'upstream_failure');
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(state.accountUpdates.length, 0);
  });

  test('Hotel A manager cannot rename a Hotel A + B employee', async () => {
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      displayName: 'Renamed Everywhere',
    }));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /manager of every hotel.*change this person's name/i);
    assert.equal(account(MULTI_ID).display_name, 'Morgan Multi');
    assert.equal(state.accountUpdates.length, 0);
  });

  test('Hotel A manager cannot change the global role of a Hotel A + B employee', async () => {
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      role: 'maintenance',
    }));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /manager of every hotel.*change this person's role/i);
    assert.equal(account(MULTI_ID).role, 'housekeeping');
    assert.equal(state.roleChangeRows.length, 0);
  });

  test('Hotel A manager cannot reset a Hotel A + B employee password', async () => {
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      password: 'new-password-123',
    }));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.error, /reset their own password/i);
    assert.equal(state.passwordUpdates.length, 0);
  });

  test('cannot replace the legacy global staff link for a multi-hotel account', async () => {
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      staffId: '66666666-6666-6666-6666-666666666666',
    }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /multiple hotels/i);
    assert.equal(state.accountUpdates.length, 0);
  });

  test('a manager of every target hotel may change profile fields but not set another password', async () => {
    account(CALLER_ID).property_access = [HOTEL_A, HOTEL_B];
    const profileResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      displayName: 'Morgan Updated',
      role: 'maintenance',
    }));
    assert.equal(profileResponse.status, 200);
    assert.deepEqual((await profileResponse.json()).data, { success: true });

    const passwordResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      password: 'new-password-123',
    }));
    assert.equal(passwordResponse.status, 403);
    assert.match((await passwordResponse.json()).error, /reset their own password/i);
    assert.equal(account(MULTI_ID).display_name, 'Morgan Updated');
    assert.equal(account(MULTI_ID).role, 'maintenance');
    assert.equal(state.passwordUpdates.length, 0);
    assert.equal(state.auditRows.length, 1);
    assert.equal(state.roleChangeRows.length, 1);
  });

  test('rejects password combined with a name, role, or staff link before either store changes', async () => {
    account(CALLER_ID).property_access = [HOTEL_A, HOTEL_B];
    const profileMutations = [
      { displayName: 'Must Not Partially Save' },
      { role: 'maintenance' },
      { staffId: null },
    ];
    for (const mutation of profileMutations) {
      const response = await PUT(request('PUT', '/api/auth/team', {
        hotelId: HOTEL_A,
        accountId: MULTI_ID,
        ...mutation,
        password: 'new-password-123',
      }));
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.match(body.error, /password changes must be saved separately/i);
    }

    assert.equal(account(MULTI_ID).display_name, 'Morgan Multi');
    assert.equal(account(MULTI_ID).role, 'housekeeping');
    assert.equal(state.passwordUpdates.length, 0);
    assert.equal(state.accountUpdates.length, 0);
    assert.equal(state.auditRows.length, 0);
  });

  test('hotel access alone is insufficient when manage_team is restricted at another hotel', async () => {
    account(CALLER_ID).property_access = [HOTEL_A, HOTEL_C];
    account(MULTI_ID).property_access = [HOTEL_A, HOTEL_C];
    state.capabilityOverrides.push({
      property_id: HOTEL_C,
      capability: 'manage_team',
      role: 'general_manager',
      allowed: false,
    });

    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      displayName: 'Must Not Change',
    }));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /hotel you do not manage/i);
    assert.equal(account(MULTI_ID).display_name, 'Morgan Multi');
  });

  test('self-service name and password edits remain allowed', async () => {
    account(CALLER_ID).property_access = [HOTEL_A, HOTEL_B];
    const profileResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: CALLER_ID,
      displayName: 'Alex Updated',
    }));
    assert.equal(profileResponse.status, 200);
    const passwordResponse = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: CALLER_ID,
      password: 'self-password-123',
    }));
    assert.equal(passwordResponse.status, 200);
    assert.equal(account(CALLER_ID).display_name, 'Alex Updated');
    assert.deepEqual(state.passwordUpdates, [{
      userId: CALLER_USER_ID,
      password: 'self-password-123',
    }]);
  });

  test('platform admin may update a multi-hotel non-admin account', async () => {
    account(CALLER_ID).role = 'admin';
    account(CALLER_ID).property_access = ['*'];
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: MULTI_ID,
      displayName: 'Admin Approved Name',
      role: 'front_desk',
    }));
    assert.equal(response.status, 200);
    assert.equal(account(MULTI_ID).display_name, 'Admin Approved Name');
    assert.equal(account(MULTI_ID).role, 'front_desk');
  });

  test('a concurrent account change makes the profile write return 409 without an audit', async () => {
    state.accountUpdateConflicts.add(LOCAL_ID);
    const response = await PUT(request('PUT', '/api/auth/team', {
      hotelId: HOTEL_A,
      accountId: LOCAL_ID,
      displayName: 'Stale Edit',
    }));
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /changed while you were editing/i);
    assert.equal(account(LOCAL_ID).display_name, 'Leslie Local');
    assert.equal(state.accountUpdates.length, 0);
    assert.equal(state.auditRows.length, 0);
  });
});

describe('DELETE /api/auth/team remains selected-hotel scoped', () => {
  test('Hotel A manager may detach Hotel A from a multi-hotel employee without touching Hotel B', async () => {
    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${MULTI_ID}`,
    ));
    assert.equal(response.status, 200);
    assert.deepEqual(account(MULTI_ID).property_access, [HOTEL_B]);
    assert.equal(state.rpcCalls.at(-1)?.fn, 'staxis_remove_property_access_guarded');
    assert.equal(state.auditRows.length, 1);
  });

  test('a concurrent target change makes hotel removal return 409 without detaching', async () => {
    state.removalConflicts.add(MULTI_ID);
    const response = await DELETE(request(
      'DELETE',
      `/api/auth/team?hotelId=${HOTEL_A}&accountId=${MULTI_ID}`,
    ));
    assert.equal(response.status, 409);
    assert.deepEqual(account(MULTI_ID).property_access, [HOTEL_A, HOTEL_B]);
    assert.equal(state.auditRows.length, 0);
  });
});
