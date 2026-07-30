import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PMS_ROBOT_ENABLED } from '../robot-status.js';

describe('retired PMS browser robot', () => {
  test('cannot be enabled by deployment configuration', () => {
    assert.equal(PMS_ROBOT_ENABLED, false);

    const statusSource = readFileSync(resolve(process.cwd(), 'src/robot-status.ts'), 'utf8');
    assert.match(statusSource, /PMS_ROBOT_ENABLED: boolean = false/);
    assert.doesNotMatch(statusSource, /process\.env|env\./);
  });

  test('every worker entry boundary checks the compile-time switch', () => {
    for (const file of ['index.ts', 'session-supervisor.ts', 'workflow-runtime.ts']) {
      const contents = readFileSync(resolve(process.cwd(), `src/${file}`), 'utf8');
      assert.match(contents, /!PMS_ROBOT_ENABLED/);
    }
  });
});
