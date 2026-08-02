import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { classifyCanonicalPlanOutcome } from '@/lib/rules-engine/engine';

describe('rules-engine canonical plan outcome contract', () => {
  test('counts inserts and real updates as upserted', () => {
    assert.equal(classifyCanonicalPlanOutcome('inserted'), 'upserted');
    assert.equal(classifyCanonicalPlanOutcome('updated'), 'upserted');
  });

  test('counts only a non-mutable skip as skipped_in_progress', () => {
    assert.equal(classifyCanonicalPlanOutcome('skipped_non_mutable'), 'skipped_in_progress');
    assert.equal(classifyCanonicalPlanOutcome('unchanged'), 'unchanged');
    assert.notEqual(classifyCanonicalPlanOutcome('unchanged'), 'skipped_in_progress');
  });

  test('does not turn an unknown contract value into a workflow skip', () => {
    assert.equal(classifyCanonicalPlanOutcome('skipped'), 'ignored');
  });
});
