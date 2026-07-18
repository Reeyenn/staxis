/** Ensure a structured API error cannot leave the Live admin surface spinning. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(
    process.cwd(),
    'src', 'app', 'admin', '_components', 'studio', 'surfaces', 'LiveSurface.tsx',
  ),
  'utf8',
);

describe('Live admin loading failures', () => {
  test('checks both HTTP status and the standard response envelope', () => {
    assert.match(source, /!response\.ok \|\| payload\?\.ok !== true/);
  });

  test('turns any failed dataset into a visible error and exits the load', () => {
    assert.match(source, /const failed = loads\.find/);
    assert.match(source, /setError\(`Could not load \$\{failed\.label\}: \$\{apiMessage\}`\);\s*return;/);
  });
});

describe('Live admin server-side filters', () => {
  test('sends no_pms to the API instead of filtering an unfiltered page', () => {
    assert.match(source, /status: statusFilter/);
    assert.doesNotMatch(source, /statusFilter === ['"]no_pms['"] \? ['"]all['"]/);
  });

  test('shares the API staleness threshold', () => {
    assert.match(source, /syncFreshnessMin > FLEET_STALE_SYNC_MINUTES/);
  });
});
