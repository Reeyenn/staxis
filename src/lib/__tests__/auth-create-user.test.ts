/**
 * Tests for src/lib/auth-create-user.ts — createOrReclaimAuthUser.
 *
 * The helper is the single choke point the three account-creation flows use
 * to mint a Supabase Auth login. Its job is to reclaim ORPHAN logins (an
 * auth.users row left behind by a flaked hotel-delete, with no accounts row)
 * that would otherwise make createUser fail with "email already registered"
 * for up to a week.
 *
 * The ONE hard rule under test: a login that already has an accounts row is
 * a REAL account and must NEVER be deleted. We assert deleteUser is not
 * called in that case.
 *
 * Mock infra mutates the supabaseAdmin singleton's auth.admin + from()
 * surfaces (same pattern as cron-sweep-orphan-auth-users.test.ts) and
 * restores them in afterEach.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { createOrReclaimAuthUser } from '@/lib/auth-create-user';

interface MockUser { id: string; email: string }

interface MockState {
  /** Auth users that currently exist (drives createUser collision + listUsers). */
  authUsers: MockUser[];
  /** data_user_ids that have a matching `accounts` row. */
  accountUserIds: string[];
  /** auth user ids referenced by properties.owner_id. */
  propertyOwnerUserIds: string[];
  /** Every id passed to deleteUser, in order. */
  deletedUserIds: string[];
  /** How many times createUser was invoked. */
  createUserCalls: number;
  /** When set, createUser fails with this error regardless of collisions. */
  forceCreateError: { message: string; status?: number } | null;
  /** When true, the accounts lookup returns an error (can't confirm orphan). */
  accountsLookupError: boolean;
  /** When true, the property-owner lookup returns an error. */
  propertiesLookupError: boolean;
  /** Monotonic id source for freshly-created users. */
  nextId: number;
}

let state: MockState;

const originalAuthAdmin = supabaseAdmin.auth.admin;
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installStub(): void {
  (supabaseAdmin as { auth: unknown }).auth = {
    admin: {
      createUser: async (attrs: { email: string }) => {
        state.createUserCalls += 1;
        if (state.forceCreateError) {
          return { data: { user: null }, error: state.forceCreateError };
        }
        const email = (attrs.email ?? '').toLowerCase();
        if (state.authUsers.some(u => u.email.toLowerCase() === email)) {
          return {
            data: { user: null },
            error: { message: 'A user with this email address has already been registered', status: 422 },
          };
        }
        const user = { id: `created-${state.nextId++}`, email };
        state.authUsers.push(user);
        return { data: { user }, error: null };
      },
      deleteUser: async (id: string) => {
        state.deletedUserIds.push(id);
        state.authUsers = state.authUsers.filter(u => u.id !== id);
        return { data: null, error: null };
      },
      listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
        const start = (page - 1) * perPage;
        return { data: { users: state.authUsers.slice(start, start + perPage) }, error: null };
      },
    },
  };

  (supabaseAdmin as { from: unknown }).from = (table: string) => {
    if (table === 'accounts') {
      return {
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => {
              if (state.accountsLookupError) {
                return { data: null, error: { message: 'db down' } };
              }
              return {
                data: state.accountUserIds.includes(val) ? { id: `acct-${val}` } : null,
                error: null,
              };
            },
          }),
        }),
      };
    }
    if (table === 'properties') {
      return {
        select: () => ({
          eq: (_col: string, val: string) => ({
            limit: () => ({
              maybeSingle: async () => {
                if (state.propertiesLookupError) {
                  return { data: null, error: { message: 'properties db down' } };
                }
                return {
                  data: state.propertyOwnerUserIds.includes(val) ? { id: `property-${val}` } : null,
                  error: null,
                };
              },
            }),
          }),
        }),
      };
    }
    throw new Error(`unexpected from('${table}') in createOrReclaimAuthUser test`);
  };
}

function restoreStub(): void {
  (supabaseAdmin as { auth: unknown }).auth = { admin: originalAuthAdmin };
  (supabaseAdmin as { from: unknown }).from = originalFrom;
}

beforeEach(() => {
  state = {
    authUsers: [],
    accountUserIds: [],
    propertyOwnerUserIds: [],
    deletedUserIds: [],
    createUserCalls: 0,
    forceCreateError: null,
    accountsLookupError: false,
    propertiesLookupError: false,
    nextId: 1,
  };
  installStub();
});

afterEach(() => {
  restoreStub();
});

describe('createOrReclaimAuthUser', () => {
  test('happy path: createUser succeeds, no reclaim, deleteUser never called', async () => {
    const res = await createOrReclaimAuthUser({ email: 'new@example.com', password: 'hunter2pw' });

    assert.ok(res.user, 'expected a created user');
    assert.equal(res.reclaimed, false);
    assert.equal(res.alreadyHasAccount, undefined);
    assert.equal(state.createUserCalls, 1);
    assert.deepEqual(state.deletedUserIds, [], 'deleteUser must not be called on the happy path');
  });

  test('ORPHAN (login exists, no accounts row) is reclaimed: deleteUser called then recreated', async () => {
    state.authUsers = [{ id: 'orphan-1', email: 'taken@example.com' }];
    state.accountUserIds = []; // no accounts row → orphan

    const res = await createOrReclaimAuthUser({ email: 'taken@example.com', password: 'hunter2pw' });

    assert.ok(res.user, 'expected a recreated user');
    assert.equal(res.reclaimed, true);
    assert.equal(res.alreadyHasAccount, undefined);
    assert.deepEqual(state.deletedUserIds, ['orphan-1'], 'the orphan must be deleted');
    assert.notEqual(res.user!.id, 'orphan-1', 'reclaimed user is a fresh auth row');
    assert.equal(state.createUserCalls, 2, 'createUser attempted, then retried after delete');
  });

  test('REAL account (login WITH accounts row) returns alreadyHasAccount and NEVER deletes', async () => {
    state.authUsers = [{ id: 'real-1', email: 'taken@example.com' }];
    state.accountUserIds = ['real-1']; // has an accounts row → REAL account

    const res = await createOrReclaimAuthUser({ email: 'taken@example.com', password: 'hunter2pw' });

    assert.equal(res.alreadyHasAccount, true);
    assert.equal(res.user, undefined, 'must not return or create a user');
    // THE important assertion: a real account's login is never deleted.
    assert.deepEqual(state.deletedUserIds, [], 'deleteUser must NEVER be called for a real account');
    assert.equal(state.createUserCalls, 1, 'no retry — we refused to reclaim');
  });

  test('property owner without an accounts row is protected and NEVER deleted', async () => {
    state.authUsers = [{ id: 'owner-1', email: 'owner@example.com' }];
    state.propertyOwnerUserIds = ['owner-1'];

    const res = await createOrReclaimAuthUser({ email: 'owner@example.com', password: 'hunter2pw' });

    assert.equal(res.alreadyHasAccount, true);
    assert.equal(res.user, undefined);
    assert.deepEqual(state.deletedUserIds, [], 'deleteUser must NEVER be called for a property owner');
    assert.equal(state.createUserCalls, 1);
  });

  test('no existing login: original createUser error is surfaced, nothing deleted', async () => {
    state.authUsers = [];
    state.forceCreateError = { message: 'Password should be at least 6 characters', status: 422 };

    const res = await createOrReclaimAuthUser({ email: 'weak@example.com', password: 'x' });

    assert.equal(res.user, undefined);
    assert.equal(res.alreadyHasAccount, undefined);
    assert.equal(res.error?.message, 'Password should be at least 6 characters');
    assert.deepEqual(state.deletedUserIds, [], 'no existing login → nothing to delete');
  });

  test('accounts lookup error: fail safe — refuse to reclaim, never delete', async () => {
    state.authUsers = [{ id: 'maybe-real', email: 'taken@example.com' }];
    state.accountsLookupError = true; // can't confirm orphan status

    const res = await createOrReclaimAuthUser({ email: 'taken@example.com', password: 'hunter2pw' });

    assert.equal(res.user, undefined);
    assert.equal(res.alreadyHasAccount, undefined);
    assert.ok(res.error, 'surfaces the original createUser error');
    assert.deepEqual(state.deletedUserIds, [], 'must not delete when orphan status is unconfirmed');
  });

  test('property-owner lookup error: fail safe — refuse to reclaim, never delete', async () => {
    state.authUsers = [{ id: 'maybe-owner', email: 'taken@example.com' }];
    state.propertiesLookupError = true;

    const res = await createOrReclaimAuthUser({ email: 'taken@example.com', password: 'hunter2pw' });

    assert.equal(res.user, undefined);
    assert.ok(res.error, 'surfaces the original createUser error');
    assert.deepEqual(state.deletedUserIds, [], 'must not delete when owner status is unconfirmed');
  });
});
