/**
 * Direct route-boundary tests for hotel account invitations.
 *
 * These use the real POST handlers and an in-memory Supabase adapter. They pin
 * both halves of the authorization decision: who may create a privileged
 * invite, and whether that authority still exists when the recipient accepts.
 */

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';

import { POST as acceptInvite } from '@/app/api/auth/accept-invite/route';
import { POST as createInvite } from '@/app/api/auth/invites/route';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { invalidateTwoFactorCache } from '@/lib/two-factor';
import type { AppRole } from '@/lib/roles';

const HOTEL_A = '11111111-1111-1111-1111-111111111111';
const HOTEL_B = '22222222-2222-2222-2222-222222222222';
const CALLER_ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CALLER_AUTH_ID = '10000000-0000-0000-0000-000000000001';
const CREATED_AUTH_ID = '10000000-0000-0000-0000-000000000099';

interface AccountRow {
  id: string;
  role: AppRole;
  property_access: string[];
  active: boolean;
  data_user_id: string;
  display_name: string;
  username: string;
}

interface InviteRow {
  id: string;
  hotel_id: string;
  email: string;
  role: string;
  token_hash: string;
  expires_at: string;
  accepted_at: string | null;
  invited_by: string;
  created_at: string;
}

interface TestState {
  accounts: AccountRow[];
  invites: InviteRow[];
  capabilityOverrides: Array<{
    property_id: string;
    capability: string;
    role: string;
    allowed: boolean;
  }>;
  createdAuthUsers: Array<{ id: string; email: string }>;
  auditRows: Array<Record<string, unknown>>;
}

let state: TestState;

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
type GetUserFn = typeof supabaseAdmin.auth.getUser;
type CreateUserFn = typeof supabaseAdmin.auth.admin.createUser;
type DeleteUserFn = typeof supabaseAdmin.auth.admin.deleteUser;
type ListUsersFn = typeof supabaseAdmin.auth.admin.listUsers;

const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);
const originalCreateUser: CreateUserFn = supabaseAdmin.auth.admin.createUser.bind(supabaseAdmin.auth.admin);
const originalDeleteUser: DeleteUserFn = supabaseAdmin.auth.admin.deleteUser.bind(supabaseAdmin.auth.admin);
const originalListUsers: ListUsersFn = supabaseAdmin.auth.admin.listUsers.bind(supabaseAdmin.auth.admin);
const originalResendKey = process.env.RESEND_API_KEY;

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function resetState(): void {
  state = {
    accounts: [{
      id: CALLER_ACCOUNT_ID,
      role: 'general_manager',
      property_access: [HOTEL_A],
      active: true,
      data_user_id: CALLER_AUTH_ID,
      display_name: 'Alex Manager',
      username: 'alex.manager',
    }],
    invites: [],
    capabilityOverrides: [],
    createdAuthUsers: [],
    auditRows: [],
  };
}

function caller(): AccountRow {
  return state.accounts[0]!;
}

function seedInvite(role: string, token = `invite-token-${role}`): string {
  state.invites.push({
    id: `invite-${state.invites.length + 1}`,
    hotel_id: HOTEL_A,
    email: `${role}@example.test`,
    role,
    token_hash: tokenHash(token),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    accepted_at: null,
    invited_by: CALLER_ACCOUNT_ID,
    created_at: new Date().toISOString(),
  });
  return token;
}

function installSupabaseStub(): void {
  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: CALLER_AUTH_ID, email: 'alex@example.test' } },
    error: null,
  })) as unknown as GetUserFn;

  supabaseAdmin.auth.admin.createUser = (async (input: { email: string }) => {
    const user = {
      id: CREATED_AUTH_ID,
      email: input.email,
      created_at: new Date().toISOString(),
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
    };
    state.createdAuthUsers.push({ id: user.id, email: input.email });
    return { data: { user }, error: null };
  }) as unknown as CreateUserFn;

  supabaseAdmin.auth.admin.deleteUser = (async () => ({ data: {}, error: null })) as unknown as DeleteUserFn;
  supabaseAdmin.auth.admin.listUsers = (async () => ({
    data: { users: [], aud: 'authenticated', nextPage: null, lastPage: 1, total: 0 },
    error: null,
  })) as unknown as ListUsersFn;

  supabaseAdmin.rpc = (async (fn: string) => {
    if (fn === 'staxis_api_limit_hit') return { data: 1, error: null };
    return { data: null, error: null };
  }) as unknown as RpcFn;

  supabaseAdmin.from = ((table: string) => {
    if (table === 'accounts') return accountsBuilder();
    if (table === 'account_invites') return invitesBuilder();
    if (table === 'capability_overrides') return capabilityOverridesBuilder();

    if (table === 'properties') {
      let hotelId: unknown;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          if (column === 'id') hotelId = value;
          return builder;
        },
        maybeSingle: async () => ({
          data: hotelId === HOTEL_A ? { id: HOTEL_A, name: 'Hotel A' } : null,
          error: null,
        }),
      };
      return builder;
    }

    if (table === 'trusted_devices') {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
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

    if (table === 'admin_audit_log') {
      return {
        insert: async (row: Record<string, unknown>) => {
          state.auditRows.push(row);
          return { error: null };
        },
      };
    }

    throw new Error(`Unexpected table in invitation authorization test: ${table}`);
  }) as unknown as FromFn;
}

function accountsBuilder(): Record<string, unknown> {
  const equals = new Map<string, unknown>();
  let insertValues: Record<string, unknown> | null = null;
  const matches = () => state.accounts.filter((row) => {
    for (const [column, value] of equals) {
      if ((row as unknown as Record<string, unknown>)[column] !== value) return false;
    }
    return true;
  });
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      equals.set(column, value);
      return builder;
    },
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
    insert: (values: Record<string, unknown>) => {
      insertValues = values;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown) => {
      if (insertValues) {
        state.accounts.push({
          id: `created-account-${state.accounts.length}`,
          role: insertValues.role as AppRole,
          property_access: insertValues.property_access as string[],
          active: true,
          data_user_id: insertValues.data_user_id as string,
          display_name: insertValues.display_name as string,
          username: insertValues.username as string,
        });
      }
      return resolve({ data: null, error: null });
    },
  };
  return builder;
}

function invitesBuilder(): Record<string, unknown> {
  const equals = new Map<string, unknown>();
  const nullColumns = new Set<string>();
  let insertValues: Record<string, unknown> | null = null;
  let updateValues: Record<string, unknown> | null = null;

  const matches = () => state.invites.filter((row) => {
    for (const [column, value] of equals) {
      if ((row as unknown as Record<string, unknown>)[column] !== value) return false;
    }
    for (const column of nullColumns) {
      if ((row as unknown as Record<string, unknown>)[column] !== null) return false;
    }
    return true;
  });

  const applyInsert = (): InviteRow | null => {
    if (!insertValues) return null;
    const inserted: InviteRow = {
      id: `created-invite-${state.invites.length + 1}`,
      hotel_id: insertValues.hotel_id as string,
      email: insertValues.email as string,
      role: insertValues.role as string,
      token_hash: insertValues.token_hash as string,
      expires_at: insertValues.expires_at as string,
      accepted_at: null,
      invited_by: insertValues.invited_by as string,
      created_at: new Date().toISOString(),
    };
    state.invites.push(inserted);
    insertValues = null;
    return inserted;
  };

  const applyUpdate = (): InviteRow | null => {
    const row = matches()[0] ?? null;
    if (row && updateValues) Object.assign(row, updateValues);
    return row;
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      equals.set(column, value);
      return builder;
    },
    is: (column: string, value: unknown) => {
      if (value === null) nullColumns.add(column);
      return builder;
    },
    order: () => builder,
    insert: (values: Record<string, unknown>) => {
      insertValues = values;
      return builder;
    },
    update: (values: Record<string, unknown>) => {
      updateValues = values;
      return builder;
    },
    single: async () => {
      const inserted = applyInsert();
      return { data: inserted ? { id: inserted.id } : null, error: null };
    },
    maybeSingle: async () => ({
      data: updateValues ? applyUpdate() : matches()[0] ?? null,
      error: null,
    }),
    then: (resolve: (value: unknown) => unknown) => resolve({ data: matches(), error: null }),
  };
  return builder;
}

function capabilityOverridesBuilder(): Record<string, unknown> {
  let propertyId: string | null = null;
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      if (column === 'property_id') propertyId = value as string;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown) => resolve({
      data: state.capabilityOverrides.filter((row) => row.property_id === propertyId),
      error: null,
    }),
  };
  return builder;
}

function managerRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://staxis.test/api/auth/invites', {
    method: 'POST',
    headers: {
      authorization: 'Bearer route-contract-token',
      cookie: `staxis_device=${'a'.repeat(64)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function acceptanceRequest(token: string): NextRequest {
  return new NextRequest('https://staxis.test/api/auth/accept-invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': '203.0.113.5',
    },
    body: JSON.stringify({ token, displayName: 'New Teammate', password: 'safe-password-123' }),
  });
}

beforeEach(() => {
  process.env.RESEND_API_KEY = '';
  resetState();
  invalidateTwoFactorCache();
  installSupabaseStub();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  supabaseAdmin.auth.admin.createUser = originalCreateUser;
  supabaseAdmin.auth.admin.deleteUser = originalDeleteUser;
  supabaseAdmin.auth.admin.listUsers = originalListUsers;
  if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalResendKey;
  invalidateTwoFactorCache();
});

describe('POST /api/auth/invites hierarchy', () => {
  test('a General Manager cannot invite a peer GM or owner', async () => {
    for (const role of ['general_manager', 'owner']) {
      const response = await createInvite(managerRequest({
        hotelId: HOTEL_A,
        email: `${role}@example.test`,
        role,
      }));
      assert.equal(response.status, 403);
      assert.match((await response.json()).error, /only an owner or admin/i);
    }
    assert.equal(state.invites.length, 0);
  });

  test('a General Manager can still invite operational staff', async () => {
    const response = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'frontdesk@example.test',
      role: 'front_desk',
    }));
    assert.equal(response.status, 201);
    assert.equal(state.invites.at(-1)?.role, 'front_desk');
  });

  test('an owner and admin can create privileged invitations', async () => {
    caller().role = 'owner';
    const ownerResponse = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'gm-by-owner@example.test',
      role: 'general_manager',
    }));
    assert.equal(ownerResponse.status, 201);

    caller().role = 'admin';
    caller().property_access = ['*'];
    const adminResponse = await createInvite(managerRequest({
      hotelId: HOTEL_A,
      email: 'owner-by-admin@example.test',
      role: 'owner',
    }));
    assert.equal(adminResponse.status, 201);
    assert.deepEqual(state.invites.map((invite) => invite.role), ['general_manager', 'owner']);
  });
});

describe('POST /api/auth/accept-invite revalidates current authority', () => {
  test('rejects an invite from a deactivated inviter before creating an auth user', async () => {
    caller().role = 'owner';
    caller().active = false;
    const response = await acceptInvite(acceptanceRequest(seedInvite('general_manager')));
    assert.equal(response.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.invites[0]?.accepted_at, null);
  });

  test('rejects an invite after manage_team is revoked for the inviter at that hotel', async () => {
    caller().role = 'owner';
    state.capabilityOverrides.push({
      property_id: HOTEL_A,
      capability: 'manage_team',
      role: 'owner',
      allowed: false,
    });
    const response = await acceptInvite(acceptanceRequest(seedInvite('front_desk')));
    assert.equal(response.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
    assert.equal(state.invites[0]?.accepted_at, null);
  });

  test('requires the exact hotel in a non-admin inviter scope', async () => {
    caller().role = 'owner';
    caller().property_access = ['*', HOTEL_B];
    const response = await acceptInvite(acceptanceRequest(seedInvite('front_desk')));
    assert.equal(response.status, 410);
    assert.equal(state.createdAuthUsers.length, 0);
  });

  test('rejects stale GM invitations that grant GM or owner', async () => {
    caller().role = 'general_manager';
    for (const role of ['general_manager', 'owner']) {
      state.invites = [];
      state.createdAuthUsers = [];
      const response = await acceptInvite(acceptanceRequest(seedInvite(role, `stale-${role}`)));
      assert.equal(response.status, 410);
      assert.equal(state.createdAuthUsers.length, 0);
      assert.equal(state.invites[0]?.accepted_at, null);
    }
  });

  test('accepts a GM invitation from an active owner with current hotel authority', async () => {
    caller().role = 'owner';
    const response = await acceptInvite(acceptanceRequest(seedInvite('general_manager')));
    assert.equal(response.status, 200);
    assert.equal(state.createdAuthUsers.length, 1);
    assert.equal(state.accounts.at(-1)?.role, 'general_manager');
    assert.ok(state.invites[0]?.accepted_at);
  });

  test('accepts an owner invitation from an active platform admin', async () => {
    caller().role = 'admin';
    caller().property_access = [];
    const response = await acceptInvite(acceptanceRequest(seedInvite('owner')));
    assert.equal(response.status, 200);
    assert.equal(state.createdAuthUsers.length, 1);
    assert.equal(state.accounts.at(-1)?.role, 'owner');
    assert.ok(state.invites[0]?.accepted_at);
  });
});
