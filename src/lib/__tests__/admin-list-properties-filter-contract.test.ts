/**
 * Regression guards for fleet filters whose values are derived from live
 * property-session state rather than a properties-table column.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src', 'app', 'api', 'admin', 'list-properties', 'route.ts'),
  'utf8',
);

describe('admin computed property filters', () => {
  test('loads computed-filter candidates in batches before slicing the requested page', () => {
    assert.match(source, /if \(isComputedStatus\)[\s\S]*for \(let offset = 0; ; offset \+= batchSize\)/);
    assert.match(source, /const propertiesForPage = isComputedStatus[\s\S]*filtered\.slice\(from, to \+ 1\)/);

    const computedBranch = source.match(
      /if \(isComputedStatus\) \{([\s\S]*?)\n  \} else \{/,
    )?.[1] ?? '';
    assert.ok(computedBranch, 'expected a computed-filter query branch');
    assert.doesNotMatch(computedBranch, /\.range\(from, to\)/);
  });

  test('treats the canonical stopped session state as disconnected', () => {
    assert.match(source, /session \? session\.status !== ['"]stopped['"] : !!p\.pms_connected/);
  });

  test('filters no-system hotels in the database before pagination', () => {
    assert.match(source, /status === ['"]no_pms['"][\s\S]*query = query\.is\(['"]pms_type['"], null\)/);
  });

  test('uses the shared 12-hour staleness threshold', () => {
    assert.match(source, /syncFreshnessMin > FLEET_STALE_SYNC_MINUTES/);
    assert.doesNotMatch(source, /syncFreshnessMin > 120/);
  });

  test('fails closed when related session or staff queries fail', () => {
    assert.match(source, /if \(sessionsErr\)[\s\S]*status: 500/);
    assert.match(source, /if \(staffErr\)[\s\S]*status: 500/);
  });
});
