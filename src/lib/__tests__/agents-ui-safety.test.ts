// Agent Builder UI — safety-dial floor logic (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDisabled, allowedModes, clampMode, ALL_MODES } from '@/app/settings/agents/_lib/safety';

test('auto is disabled only when the approvalFloor is approve_first', () => {
  assert.equal(autoDisabled({ approvalFloor: 'approve_first' }), true);
  assert.equal(autoDisabled({ approvalFloor: 'suggest' }), false);
  assert.equal(autoDisabled({ approvalFloor: 'auto' }), false);
});

test('allowedModes excludes auto for flagged actions, includes it otherwise', () => {
  assert.deepEqual(allowedModes({ approvalFloor: 'approve_first' }), ['suggest', 'approve_first']);
  assert.deepEqual(allowedModes({ approvalFloor: 'suggest' }), ALL_MODES);
});

test('clampMode never lets auto through an approve_first floor', () => {
  assert.equal(clampMode('auto', 'approve_first'), 'approve_first');
  assert.equal(clampMode('auto', 'suggest'), 'auto');
  assert.equal(clampMode('suggest', 'approve_first'), 'suggest');
  assert.equal(clampMode('approve_first', 'approve_first'), 'approve_first');
});
