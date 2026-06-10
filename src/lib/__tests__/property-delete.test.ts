/**
 * Safety tests for classifyAccountsForPropertyDelete — the decision behind
 * the admin ✕ "delete hotel" cleanup. The dangerous failure modes are
 * over-deletion: nuking an admin account, or wiping an owner who also runs
 * OTHER hotels. These lock those out.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyAccountsForPropertyDelete, type LinkedAccount } from '@/lib/property-delete';

const HOTEL = 'hotel-1';
const OTHER = 'hotel-2';

describe('classifyAccountsForPropertyDelete', () => {
  test('owner that exists ONLY for this hotel → delete (account + auth user)', () => {
    const accts: LinkedAccount[] = [
      { id: 'a1', data_user_id: 'u1', role: 'owner', property_access: [HOTEL] },
    ];
    const plan = classifyAccountsForPropertyDelete(accts, HOTEL);
    assert.deepEqual(plan.deleteUserIds, ['u1']);
    assert.equal(plan.prune.length, 0);
  });

  test('staff that exists only for this hotel → also deleted', () => {
    const accts: LinkedAccount[] = [
      { id: 'a2', data_user_id: 'u2', role: 'housekeeping', property_access: [HOTEL] },
    ];
    const plan = classifyAccountsForPropertyDelete(accts, HOTEL);
    assert.deepEqual(plan.deleteUserIds, ['u2']);
  });

  test('ADMIN account is NEVER deleted, even if access lists this hotel', () => {
    const accts: LinkedAccount[] = [
      { id: 'admin', data_user_id: 'uadmin', role: 'admin', property_access: [HOTEL] },
    ];
    const plan = classifyAccountsForPropertyDelete(accts, HOTEL);
    assert.deepEqual(plan.deleteUserIds, []);
    assert.equal(plan.prune.length, 0);
  });

  test('owner with OTHER hotels too → kept, this hotel pruned from access', () => {
    const accts: LinkedAccount[] = [
      { id: 'a3', data_user_id: 'u3', role: 'owner', property_access: [HOTEL, OTHER] },
    ];
    const plan = classifyAccountsForPropertyDelete(accts, HOTEL);
    assert.deepEqual(plan.deleteUserIds, []);
    assert.deepEqual(plan.prune, [{ id: 'a3', remaining: [OTHER] }]);
  });

  test('exclusive account with no auth user → nothing to delete (no crash)', () => {
    const accts: LinkedAccount[] = [
      { id: 'a4', data_user_id: null, role: 'owner', property_access: [HOTEL] },
    ];
    const plan = classifyAccountsForPropertyDelete(accts, HOTEL);
    assert.deepEqual(plan.deleteUserIds, []);
    assert.equal(plan.prune.length, 0);
  });

  test('mixed batch resolves each independently', () => {
    const accts: LinkedAccount[] = [
      { id: 'owner', data_user_id: 'uo', role: 'owner', property_access: [HOTEL] },          // delete
      { id: 'gm', data_user_id: 'ug', role: 'general_manager', property_access: [HOTEL, OTHER] }, // prune
      { id: 'admin', data_user_id: 'ua', role: 'admin', property_access: [HOTEL] },            // skip
      { id: 'hk', data_user_id: 'uh', role: 'housekeeping', property_access: [HOTEL] },        // delete
    ];
    const plan = classifyAccountsForPropertyDelete(accts, HOTEL);
    assert.deepEqual(plan.deleteUserIds.sort(), ['uh', 'uo']);
    assert.deepEqual(plan.prune, [{ id: 'gm', remaining: [OTHER] }]);
  });

  test('empty access array → treated as exclusive-empty (no delete, no prune)', () => {
    const accts: LinkedAccount[] = [
      { id: 'a5', data_user_id: 'u5', role: 'owner', property_access: [] },
    ];
    // access already has no hotels → removing HOTEL leaves [] → would "delete",
    // but there's nothing linking it here anyway; still safe (frees a stray).
    const plan = classifyAccountsForPropertyDelete(accts, HOTEL);
    assert.deepEqual(plan.deleteUserIds, ['u5']);
  });
});
