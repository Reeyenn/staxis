import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { deleteCreatedIdentity } from '@/lib/company-access/registration-identity-rollback';
import { supabaseAdmin } from '@/lib/supabase-admin';

type AccountDeleteMode = 'success' | 'returned-error' | 'throw';

let accountDeleteMode: AccountDeleteMode;
let accountDeleteIds: string[];
let authDeleteIds: string[];

const originalAuthAdmin = supabaseAdmin.auth.admin;
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

beforeEach(() => {
  accountDeleteMode = 'success';
  accountDeleteIds = [];
  authDeleteIds = [];

  (supabaseAdmin as { from: unknown }).from = (table: string) => {
    assert.equal(table, 'accounts');
    return {
      delete: () => ({
        eq: async (_column: string, id: string) => {
          accountDeleteIds.push(id);
          if (accountDeleteMode === 'throw') throw new Error('account delete transport failed');
          if (accountDeleteMode === 'returned-error') {
            return { data: null, error: { code: '08006', message: 'connection failure' } };
          }
          return { data: null, error: null };
        },
      }),
    };
  };
  (supabaseAdmin as { auth: unknown }).auth = {
    admin: {
      ...originalAuthAdmin,
      deleteUser: async (id: string) => {
        authDeleteIds.push(id);
        return { data: null, error: null };
      },
    },
  };
});

afterEach(() => {
  (supabaseAdmin as { from: unknown }).from = originalFrom;
  (supabaseAdmin as { auth: unknown }).auth = { admin: originalAuthAdmin };
});

describe('public invitation registration identity rollback', () => {
  test('deletes Auth only after the account DELETE succeeds', async () => {
    const result = await deleteCreatedIdentity('account-1', 'auth-1', 'request-1');

    assert.deepEqual(accountDeleteIds, ['account-1']);
    assert.deepEqual(authDeleteIds, ['auth-1']);
    assert.deepEqual(result, {
      accountDeleteConfirmed: true,
      authDeleteAttempted: true,
      authDeleted: true,
    });
  });

  test('preserves Auth when account DELETE returns an error', async () => {
    accountDeleteMode = 'returned-error';

    const result = await deleteCreatedIdentity('account-2', 'auth-2', 'request-2');

    assert.deepEqual(accountDeleteIds, ['account-2']);
    assert.deepEqual(authDeleteIds, []);
    assert.equal(result.accountDeleteConfirmed, false);
    assert.equal(result.authDeleteAttempted, false);
  });

  test('preserves Auth when account DELETE throws', async () => {
    accountDeleteMode = 'throw';

    const result = await deleteCreatedIdentity('account-3', 'auth-3', 'request-3');

    assert.deepEqual(accountDeleteIds, ['account-3']);
    assert.deepEqual(authDeleteIds, []);
    assert.equal(result.accountDeleteConfirmed, false);
    assert.equal(result.authDeleteAttempted, false);
  });

  test('preserves Auth when no account rollback target is known', async () => {
    const result = await deleteCreatedIdentity(null, 'auth-4', 'request-4');

    assert.deepEqual(accountDeleteIds, []);
    assert.deepEqual(authDeleteIds, []);
    assert.equal(result.accountDeleteConfirmed, false);
    assert.equal(result.authDeleteAttempted, false);
  });
});
