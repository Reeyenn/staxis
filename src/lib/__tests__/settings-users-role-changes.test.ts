/**
 * Tests for the role-change audit writer (writeRoleChange) used by
 * /api/settings/users and the /api/auth/team mirror.
 *
 * The writer is best-effort: a failure does not throw. The asserts:
 *   - Inserts a row into role_changes with the right column shape
 *   - Logs and swallows when the insert errors
 *   - Each change_kind value is accepted
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { writeRoleChange } from '@/app/api/settings/users/route';

interface InsertedRow {
  account_id: string;
  property_id: string;
  changed_by_account_id: string;
  old_role: string | null;
  new_role: string;
  change_kind: string;
  reason: string | null;
}

interface MockState {
  inserted: InsertedRow[];
  errorOnInsert: { message: string } | null;
}

let state: MockState;
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installStub() {
  (supabaseAdmin as { from: unknown }).from = (table: string) => {
    if (table === 'role_changes') {
      return {
        insert: async (row: InsertedRow) => {
          if (state.errorOnInsert) return { error: state.errorOnInsert };
          state.inserted.push(row);
          return { error: null };
        },
      };
    }
    return { insert: async () => ({ error: null }) };
  };
}

function restoreStub() {
  (supabaseAdmin as { from: unknown }).from = originalFrom;
}

beforeEach(() => {
  state = { inserted: [], errorOnInsert: null };
  installStub();
});

afterEach(restoreStub);

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';
const PROPERTY_ID = '00000000-0000-0000-0000-000000000002';
const ACTOR_ID = '00000000-0000-0000-0000-000000000003';

describe('writeRoleChange', () => {
  test('inserts a row with the right shape for role_change', async () => {
    await writeRoleChange({
      accountId: ACCOUNT_ID, propertyId: PROPERTY_ID,
      changedByAccountId: ACTOR_ID,
      oldRole: 'general_manager', newRole: 'front_desk',
      changeKind: 'role_change',
      reason: 'voluntary demotion',
    });
    assert.equal(state.inserted.length, 1);
    const row = state.inserted[0];
    assert.equal(row.account_id, ACCOUNT_ID);
    assert.equal(row.property_id, PROPERTY_ID);
    assert.equal(row.changed_by_account_id, ACTOR_ID);
    assert.equal(row.old_role, 'general_manager');
    assert.equal(row.new_role, 'front_desk');
    assert.equal(row.change_kind, 'role_change');
    assert.equal(row.reason, 'voluntary demotion');
  });

  test('accepts each change_kind value', async () => {
    const kinds: Array<'role_change' | 'deactivate' | 'reactivate' | 'transfer_ownership'> = [
      'role_change', 'deactivate', 'reactivate', 'transfer_ownership',
    ];
    for (const kind of kinds) {
      await writeRoleChange({
        accountId: ACCOUNT_ID, propertyId: PROPERTY_ID,
        changedByAccountId: ACTOR_ID,
        oldRole: 'owner', newRole: 'general_manager',
        changeKind: kind, reason: null,
      });
    }
    assert.equal(state.inserted.length, kinds.length);
    assert.deepEqual(state.inserted.map(r => r.change_kind), kinds);
  });

  test('swallows insert error without throwing', async () => {
    state.errorOnInsert = { message: 'simulated failure' };
    await assert.doesNotReject(writeRoleChange({
      accountId: ACCOUNT_ID, propertyId: PROPERTY_ID,
      changedByAccountId: ACTOR_ID,
      oldRole: 'owner', newRole: 'general_manager',
      changeKind: 'transfer_ownership', reason: null,
    }));
    assert.equal(state.inserted.length, 0);
  });
});
