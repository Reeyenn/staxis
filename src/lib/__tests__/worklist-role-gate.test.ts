/**
 * Worklist source-visibility gate + taxonomy.
 *
 * worklistSeesAllSources is the security boundary that keeps management-gated
 * complaints (and the other cross-department sources) out of a floor-staff
 * To-do view — /communications is in the base nav for EVERY role, so a
 * regression here would leak complaint descriptions (possible guest PII) to
 * housekeeping/maintenance. The role set must also stay in lock-step with the
 * dashboard card gate (canManageTeam || front_desk). These tests pin it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { worklistSeesAllSources, WORKLIST_DEEPLINK } from '@/lib/worklist/core';
import { WORKLIST_SOURCE_TYPES } from '@/lib/worklist/types';
import { canManageTeam, ALL_ROLES } from '@/lib/roles';

describe('worklistSeesAllSources — complaint / work-order visibility gate', () => {
  test('management + front desk see all sources', () => {
    for (const role of ['admin', 'owner', 'general_manager', 'front_desk']) {
      assert.equal(worklistSeesAllSources(role), true, `${role} should see all sources`);
    }
  });

  test('floor staff + legacy + unknown roles see only their manual to-dos', () => {
    for (const role of ['housekeeping', 'maintenance', 'staff', 'unknown', '']) {
      assert.equal(worklistSeesAllSources(role), false, `${role} must NOT see cross-department sources`);
    }
  });

  test('gate stays in lock-step with the dashboard card gate (canManageTeam || front_desk)', () => {
    for (const role of ALL_ROLES) {
      const cardGate = canManageTeam(role) || role === 'front_desk';
      assert.equal(worklistSeesAllSources(role), cardGate, `divergence for ${role}`);
    }
  });
});

describe('worklist source taxonomy', () => {
  test('the source set is exactly the five known sources', () => {
    assert.deepEqual([...WORKLIST_SOURCE_TYPES].sort(), ['complaint', 'inspection', 'pm', 'task', 'workorder']);
  });

  test('every source type has an absolute-path deep-link target', () => {
    for (const t of WORKLIST_SOURCE_TYPES) {
      assert.equal(typeof WORKLIST_DEEPLINK[t], 'string', `${t} missing deep-link`);
      assert.ok(WORKLIST_DEEPLINK[t].startsWith('/'), `${t} deep-link must be an absolute path`);
    }
  });
});
