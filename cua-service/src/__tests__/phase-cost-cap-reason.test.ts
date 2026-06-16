import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isCostCapReason } from '../mapper.js';

// The terminal board PHASE splits a cost-cap soft-abort out of the generic
// 'failed' bucket by reading the bail reason text. The persisted `status`
// stays 'failed' regardless — this only picks the finer phase.
test('isCostCapReason matches the cost-cap bail reasons the mapper emits', () => {
  // The two real soft-abort reasons (per-target + cumulative).
  assert.equal(isCostCapReason('per-target cost cap exceeded for report_menu ($0.60)'), true);
  assert.equal(isCostCapReason('cost cap hit'), true);
  // Case-insensitive.
  assert.equal(isCostCapReason('Cost Cap reached'), true);
});

test('isCostCapReason is false for ordinary not-found / unavailable reasons', () => {
  assert.equal(isCostCapReason('could not find the arrivals page'), false);
  assert.equal(isCostCapReason('feed not available in this PMS'), false);
  assert.equal(isCostCapReason(''), false);
  assert.equal(isCostCapReason(null), false);
  assert.equal(isCostCapReason(undefined), false);
});
