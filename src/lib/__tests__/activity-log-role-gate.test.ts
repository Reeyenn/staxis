/**
 * Legacy canManageTeam helper — pins the original manager-only trio.
 *
 * NOTE: as of the per-hotel access-control work, the activity-log surface no
 * longer routes through canManageTeam — it uses the `view_activity_log`
 * capability, which defaults to EVERY role and is restricted per hotel from the
 * Access tab (see capabilities-resolver.test.ts). This file now just keeps the
 * legacy canManageTeam helper honest for the callers that still use it
 * (verifyTeamManager's legacy path, display logic).
 *
 *   admin / owner / general_manager → true
 *   front_desk / housekeeping / maintenance / staff → false
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
