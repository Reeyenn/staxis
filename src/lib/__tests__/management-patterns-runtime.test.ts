import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deterministicUuidFromFingerprint } from '@/lib/company/management-patterns/identity';
import {
  latestManagementPatternWeeklyEvaluationAt,
  managementPatternRunKey,
} from '@/lib/company/management-patterns/schedule';

describe('management-pattern runtime identity', () => {
  test('weekly evaluation is a stable Monday 08:00 UTC boundary', () => {
    assert.equal(
      latestManagementPatternWeeklyEvaluationAt(new Date('2026-07-27T07:59:59.999Z')).toISOString(),
      '2026-07-20T08:00:00.000Z',
    );
    assert.equal(
      latestManagementPatternWeeklyEvaluationAt(new Date('2026-07-27T08:00:00.000Z')).toISOString(),
      '2026-07-27T08:00:00.000Z',
    );
    assert.equal(
      latestManagementPatternWeeklyEvaluationAt(new Date('2026-08-02T23:59:59.999Z')).toISOString(),
      '2026-07-27T08:00:00.000Z',
    );
  });

  test('revision identities retain the full collision-resistant digest', () => {
    const digest = 'a'.repeat(64);
    const key = managementPatternRunKey({
      mode: 'scheduled',
      evaluationAt: new Date('2026-07-27T08:00:00.000Z'),
      revisionHash: digest,
    });
    assert.match(key, new RegExp(`revision-${digest}$`));
    assert.ok(key.length <= 200);
    assert.throws(
      () => managementPatternRunKey({
        mode: 'replay',
        evaluationAt: new Date('2026-07-27T08:00:00.000Z'),
        revisionHash: 'short',
      }),
      /SHA-256/,
    );
  });

  test('relational UUIDs are deterministic RFC variant/version-5 values', () => {
    const digest = '0123456789abcdef'.repeat(4);
    const first = deterministicUuidFromFingerprint(digest);
    assert.equal(first, deterministicUuidFromFingerprint(digest));
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.throws(() => deterministicUuidFromFingerprint('x'.repeat(64)), /SHA-256/);
  });
});
