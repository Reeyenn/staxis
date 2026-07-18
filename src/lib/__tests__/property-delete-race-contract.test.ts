/** Regression guard for the account-loss race in admin property deletion. */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'admin', 'properties', 'delete', 'route.ts'),
  'utf8',
);

describe('admin property deletion race containment', () => {
  test('requires the guarded delete to return a row', () => {
    assert.match(source, /delQuery\s*\.select\(['"]id['"]\)\s*\.maybeSingle\(\)/);
    assert.match(source, /if \(!deletedProperty\)[\s\S]*status: 409/);
  });

  test('does not prune account access until deletion is confirmed', () => {
    const confirmedIndex = source.indexOf('if (!deletedProperty)');
    const pruneIndex = source.indexOf('for (const p of plan.prune)');
    assert.ok(confirmedIndex >= 0, 'expected a zero-row delete guard');
    assert.ok(pruneIndex > confirmedIndex, 'account pruning must follow the guarded delete');
  });

  test('fails before deletion when the cleanup plan cannot be loaded', () => {
    assert.match(source, /if \(linkedErr\)[\s\S]*status: 500/);
  });
});
