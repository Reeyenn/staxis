/**
 * Regression guard for GM onboarding. General managers receive property_access
 * but do not become properties.owner_id, so Add Team must use the shared
 * manager-capability gate rather than exact owner-id equality.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'onboarding', 'complete', 'route.ts'),
  'utf8',
);

describe('onboarding complete authorization', () => {
  test('uses the shared manage-team property gate', () => {
    assert.match(
      source,
      /accountCanForProperty\(session\.userId,\s*['"]manage_team['"],\s*pidV\.value!/,
    );
  });

  test('does not require the caller to equal properties.owner_id', () => {
    assert.doesNotMatch(source, /property\.owner_id\s*!==\s*session\.userId/);
    assert.doesNotMatch(source, /select\(['"][^'"]*owner_id/);
  });

  test('requires settings capability before changing enabled services', () => {
    assert.match(
      source,
      /Object\.keys\(services\)\.length > 0[\s\S]*accountCanForProperty\(session\.userId,\s*['"]manage_settings['"],\s*pidV\.value!/,
    );
  });
});
