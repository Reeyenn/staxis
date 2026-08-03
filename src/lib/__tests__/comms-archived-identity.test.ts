import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { NextRequest } from 'next/server';

import { POST as commsDmPost } from '@/app/api/comms/dm/route';
import { POST as housekeeperDmPost } from '@/app/api/housekeeper/messages/dm/route';
import { invalidateTwoFactorCache } from '@/lib/two-factor';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { hashStaffLinkToken } from '@/lib/staff-link-auth';
import { commsStaffIdentityId } from '@/lib/comms/identity';
import {
  ARCHIVED_AT_PROPERTY,
  resolveStaffIdForAccount,
} from '@/lib/comms/core';
import { commsContext } from '@/lib/comms/route-helpers';

const PROPERTY = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CALLER = '44444444-4444-4444-8444-444444444444';
const PARTNER = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'test-staff-link-token';

interface StaffRecord {
  id: string;
  property_id: string;
  name: string;
  department: string | null;
  is_active: boolean | null;
  language: string | null;
  auth_user_id?: string | null;
  is_senior?: boolean | null;
}

interface MockError { message: string; code?: string }
interface QueryResult { data: unknown; error: MockError | null }
interface QueryCall {
  table: string;
  operation: 'read' | 'insert' | 'update' | 'upsert';
  filters: Record<string, unknown>;
  selection: string | null;
}

interface QueryBuilder {
  select(columns?: string): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  is(column: string, value: unknown): QueryBuilder;
  order(column: string, options?: unknown): QueryBuilder;
  limit(value: number): QueryBuilder;
  insert(row: unknown): QueryBuilder;
  update(row: unknown): QueryBuilder;
  upsert(rows: unknown, options?: unknown): QueryBuilder;
  maybeSingle(): Promise<QueryResult>;
  then(resolve: (result: QueryResult) => unknown): Promise<unknown>;
}

interface MockState {
  mode: 'resolver' | 'comms' | 'housekeeper';
  deterministicRows: Array<Record<string, unknown> | null>;
  insertResult: QueryResult;
  partner: StaffRecord | null;
  conversation: { id: string } | null;
  fromCalls: QueryCall[];
  inserts: Array<{ table: string; row: unknown }>;
}

const state: MockState = {
  mode: 'resolver',
  deterministicRows: [],
  insertResult: { data: null, error: null },
  partner: null,
  conversation: { id: CONVERSATION },
  fromCalls: [],
  inserts: [],
};

const caller: StaffRecord = {
  id: CALLER,
  property_id: PROPERTY,
  name: 'Caller',
  department: 'front_desk',
  is_active: true,
  language: 'en',
  auth_user_id: USER,
  is_senior: false,
};

const archivedPartner: StaffRecord = {
  id: PARTNER,
  property_id: PROPERTY,
  name: 'Archived Partner',
  department: 'housekeeping',
  is_active: false,
  language: 'en',
  is_senior: false,
};

const activePartner: StaffRecord = {
  ...archivedPartner,
  name: 'Active Partner',
  is_active: true,
};

const account = {
  id: ACCOUNT,
  active: true,
  role: 'staff',
  staff_id: null,
  display_name: 'Caller',
  preferred_language: 'en',
};

const authority = {
  ok: true,
  all: true,
  authorityMode: 'normalized',
  authorityVersion: 1,
  effectiveAccessHash: 'a'.repeat(64),
  propertyIds: [],
  legacyPropertyIds: [],
  membershipPropertyIds: [],
  propertyStandings: [],
};

type FromFn = typeof supabaseAdmin.from;
type RpcFn = typeof supabaseAdmin.rpc;
type GetUserFn = typeof supabaseAdmin.auth.getUser;

const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser: GetUserFn = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

function resetState(): void {
  state.mode = 'resolver';
  state.deterministicRows = [];
  state.insertResult = { data: null, error: null };
  state.partner = null;
  state.conversation = { id: CONVERSATION };
  state.fromCalls = [];
  state.inserts = [];
}

function rowFor(table: string, filters: Record<string, unknown>, selection: string | null): QueryResult {
  if (table === 'app_settings') return { data: { two_factor_enabled: false }, error: null };
  if (table === 'properties') return { data: { enabled_sections: null }, error: null };
  if (table === 'accounts') return { data: account, error: null };
  if (table === 'account_property_staff_links') return { data: null, error: null };

  if (table === 'staff_link_tokens') {
    if (filters.token_hash === hashStaffLinkToken(TOKEN)) {
      return {
        data: {
          staff_id: CALLER,
          property_id: PROPERTY,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          revoked_at: null,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  if (table === 'staff') {
    if (state.mode === 'resolver') {
      if (filters.id === commsStaffIdentityId(PROPERTY, ACCOUNT)
        && filters.property_id === PROPERTY) {
        return { data: state.deterministicRows.shift() ?? null, error: null };
      }
      return { data: null, error: null };
    }

    if (filters.id === PARTNER) return { data: state.partner, error: null };
    if (filters.id === CALLER || filters.auth_user_id === USER) {
      return { data: caller, error: null };
    }
    return { data: null, error: null };
  }

  if (table === 'comms_conversations') return { data: state.conversation, error: null };
  if (table === 'comms_members') return { data: null, error: null };
  void selection;
  return { data: null, error: null };
}

function installMocks(): void {
  supabaseAdmin.from = ((table: string) => {
    let operation: QueryCall['operation'] = 'read';
    let filters: Record<string, unknown> = {};
    let selection: string | null = null;
    const builder = {} as QueryBuilder;

    const record = (): void => {
      state.fromCalls.push({ table, operation, filters: { ...filters }, selection });
    };
    const currentResult = (): QueryResult => {
      record();
      if (operation === 'insert') return state.insertResult;
      return rowFor(table, filters, selection);
    };

    builder.select = (columns?: string) => {
      selection = columns ?? null;
      return builder;
    };
    builder.eq = (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    };
    builder.is = (column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    };
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.insert = (row: unknown) => {
      operation = 'insert';
      state.inserts.push({ table, row });
      return builder;
    };
    builder.update = () => {
      operation = 'update';
      return builder;
    };
    builder.upsert = () => {
      operation = 'upsert';
      return builder;
    };
    builder.maybeSingle = async () => currentResult();
    builder.then = (resolve) => Promise.resolve(resolve(currentResult()));
    return builder;
  }) as unknown as FromFn;

  supabaseAdmin.rpc = (async (fn: string) => {
    if (fn === 'staxis_list_account_authorized_properties') return { data: authority, error: null };
    if (fn === 'staxis_api_limit_hit') return { data: 0, error: null };
    return { data: null, error: null };
  }) as unknown as RpcFn;

  supabaseAdmin.auth.getUser = (async () => ({
    data: { user: { id: USER, email: 'caller@example.test' } },
    error: null,
  })) as unknown as GetUserFn;
}

function request(path: string, body: Record<string, unknown>): NextRequest {
  return new Request(`https://staxis.test${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function housekeeperRequest(body: Record<string, unknown>): NextRequest {
  return new Request('https://staxis.test/api/housekeeper/messages/dm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const accountInput = {
  accountId: ACCOUNT,
  authUserId: USER,
  role: 'staff',
  staffId: null,
  displayName: 'Caller',
};

beforeEach(() => {
  resetState();
  installMocks();
  invalidateTwoFactorCache();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  invalidateTwoFactorCache();
});

describe('archived caller identity resolution', () => {
  test('throws the exact archived sentinel before inserting a deterministic row', async () => {
    state.deterministicRows = [{
      id: commsStaffIdentityId(PROPERTY, ACCOUNT),
      property_id: PROPERTY,
      auth_user_id: USER,
      is_active: false,
    }];

    await assert.rejects(
      resolveStaffIdForAccount(PROPERTY, accountInput),
      (error: unknown) => error instanceof Error && error.message === ARCHIVED_AT_PROPERTY,
    );

    assert.equal(state.inserts.length, 0);
    const deterministicRead = state.fromCalls.find((call) =>
      call.table === 'staff' && call.filters.id === commsStaffIdentityId(PROPERTY, ACCOUNT));
    assert.deepEqual(deterministicRead?.filters, {
      id: commsStaffIdentityId(PROPERTY, ACCOUNT),
      property_id: PROPERTY,
    });
  });

  test('reuses an active deterministic row without inserting', async () => {
    const deterministicId = commsStaffIdentityId(PROPERTY, ACCOUNT);
    state.deterministicRows = [{
      id: deterministicId,
      property_id: PROPERTY,
      auth_user_id: USER,
      is_active: true,
    }];

    assert.equal(await resolveStaffIdForAccount(PROPERTY, accountInput), deterministicId);
    assert.equal(state.inserts.length, 0);
  });

  test('inserts only when no deterministic row exists', async () => {
    const deterministicId = commsStaffIdentityId(PROPERTY, ACCOUNT);
    state.deterministicRows = [null];
    state.insertResult = {
      data: { id: deterministicId, property_id: PROPERTY, auth_user_id: USER },
      error: null,
    };

    assert.equal(await resolveStaffIdForAccount(PROPERTY, accountInput), deterministicId);
    assert.deepEqual(state.inserts, [{
      table: 'staff',
      row: {
        id: deterministicId,
        property_id: PROPERTY,
        auth_user_id: USER,
        name: 'Caller',
        department: 'other',
        is_active: true,
        language: 'en',
      },
    }]);
  });

  test('maps an archived insert-race row to the exact sentinel', async () => {
    const deterministicId = commsStaffIdentityId(PROPERTY, ACCOUNT);
    state.deterministicRows = [null, {
      id: deterministicId,
      property_id: PROPERTY,
      auth_user_id: USER,
      is_active: false,
    }];
    state.insertResult = {
      data: null,
      error: { message: 'duplicate key value violates unique constraint' },
    };

    await assert.rejects(
      resolveStaffIdForAccount(PROPERTY, accountInput),
      (error: unknown) => error instanceof Error && error.message === ARCHIVED_AT_PROPERTY,
    );
  });
});

test('commsContext maps an archived deterministic identity to the existing 403 envelope', async () => {
  const deterministicId = commsStaffIdentityId(PROPERTY, ACCOUNT);
  state.deterministicRows = [null, {
    id: deterministicId,
    property_id: PROPERTY,
    auth_user_id: USER,
    is_active: false,
  }];
  state.insertResult = {
    data: null,
    error: { message: 'duplicate key value violates unique constraint' },
  };

  const result = await commsContext(
    request(`/api/comms/bootstrap?pid=${PROPERTY}`, { pid: PROPERTY }),
    PROPERTY,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.response.status, 403);
  assert.equal(result.response.headers.get('x-request-id')?.length, 8);
  assert.deepEqual(await result.response.json(), {
    ok: false,
    requestId: result.response.headers.get('x-request-id'),
    error: 'property access denied',
    code: 'forbidden',
  });
  assert.equal(state.inserts.length, 1);
});

describe('DM partner archival gates', () => {
  test('authenticated comms DMs hide archived partners as not found', async () => {
    state.mode = 'comms';
    state.partner = archivedPartner;

    const result = await commsDmPost(request('/api/comms/dm', {
      pid: PROPERTY,
      otherStaffId: PARTNER,
    }));

    assert.equal(result.status, 404);
    const body = await result.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Not found');
    assert.equal(body.code, 'not_found');
    assert.equal(state.fromCalls.some((call) => call.table === 'comms_conversations'), false);
  });

  test('housekeeper DMs hide archived partners as not found', async () => {
    state.mode = 'housekeeper';
    state.partner = archivedPartner;

    const result = await housekeeperDmPost(housekeeperRequest({
      pid: PROPERTY,
      staffId: CALLER,
      otherStaffId: PARTNER,
      tok: TOKEN,
    }));

    assert.equal(result.status, 404);
    const body = await result.json();
    assert.equal(body.error, 'Not found');
    assert.equal(body.code, 'not_found');
    assert.equal(state.fromCalls.some((call) => call.table === 'comms_conversations'), false);
  });

  test('active same-property partners still open DMs on both surfaces', async () => {
    state.mode = 'comms';
    state.partner = activePartner;
    const authenticated = await commsDmPost(request('/api/comms/dm', {
      pid: PROPERTY,
      otherStaffId: PARTNER,
    }));
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).data.conversationId, CONVERSATION);

    state.fromCalls = [];
    state.mode = 'housekeeper';
    const housekeeper = await housekeeperDmPost(housekeeperRequest({
      pid: PROPERTY,
      staffId: CALLER,
      otherStaffId: PARTNER,
      tok: TOKEN,
    }));
    assert.equal(housekeeper.status, 200);
    assert.equal((await housekeeper.json()).data.conversationId, CONVERSATION);
  });
});
