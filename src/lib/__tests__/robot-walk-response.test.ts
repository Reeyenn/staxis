import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isRobotWalkAuthRetryStatus,
  ROBOT_WALK_AUTH_RETRY_STATUS,
} from '@/lib/automation/robot-walk';

describe('robot walkthrough response retry guard', () => {
  test('skips only the auth refresh response and observes terminal statuses', () => {
    assert.equal(ROBOT_WALK_AUTH_RETRY_STATUS, 401);
    assert.equal(isRobotWalkAuthRetryStatus(401), true);

    for (const status of [200, 201, 400, 403, 404, 429, 500]) {
      assert.equal(isRobotWalkAuthRetryStatus(status), false, `status ${status} must remain observable`);
    }
  });
});
