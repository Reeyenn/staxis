/**
 * Activity log role gate — verifies which roles can read the page.
 *
 * The HTTP gate routes through verifyTeamManager → canManageTeam.
 * We test canManageTeam directly so the contract is pinned even if
 * verifyTeamManager swaps implementations.
 *
 *   admin           → allowed
 *   owner           → allowed
 *   general_manager → allowed
 *   front_desk      → denied
 *   housekeeping    → denied
 *   maintenance     → denied
 *   staff           → denied
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { canManageTeam, type AppRole } from '../roles';

describe('Activity log role gate', () => {
  const cases: Array<[AppRole, boolean]> = [
    ['admin', true],
    ['owner', true],
    ['general_manager', true],
    ['front_desk', false],
    ['housekeeping', false],
    ['maintenance', false],
    ['staff', false],
  ];

  for (const [role, allowed] of cases) {
    test(`${role} ${allowed ? 'can' : 'cannot'} view the activity log`, () => {
      assert.equal(canManageTeam(role), allowed);
    });
  }
});
