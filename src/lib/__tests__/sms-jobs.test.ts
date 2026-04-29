/**
 * Tests for src/lib/sms-jobs.ts pure helpers.
 *
 * Run via: npx tsx --test src/lib/__tests__/sms-jobs.test.ts
 *
 * The full enqueue/process flow needs a live Supabase or a heavy mocking
 * harness; that's deferred to a real integration test pass. This file
 * pins the pieces that don't need I/O:
 *
 *   - computeBackoffSeconds — the retry curve. Wrong values here mean
 *     transient Twilio failures either retry too fast (rate-limit ourselves)
 *     or too slow (Mario's housekeeper never gets the text in time).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeBackoffSeconds } from '../sms-jobs';

describe('computeBackoffSeconds', () => {
  test('first attempt waits 30 seconds', () => {
    assert.equal(computeBackoffSeconds(1), 30);
  });

  test('second attempt waits 2 minutes', () => {
    assert.equal(computeBackoffSeconds(2), 120);
  });

  test('third attempt waits 5 minutes', () => {
    assert.equal(computeBackoffSeconds(3), 300);
  });

  test('fourth and beyond cap at 10 minutes', () => {
    assert.equal(computeBackoffSeconds(4), 600);
    assert.equal(computeBackoffSeconds(10), 600);
    assert.equal(computeBackoffSeconds(100), 600);
  });

  test('backoff is monotonically non-decreasing', () => {
    let prev = 0;
    for (let i = 1; i <= 8; i++) {
      const cur = computeBackoffSeconds(i);
      assert.ok(cur >= prev, `attempt ${i}: ${cur} < ${prev}`);
      prev = cur;
    }
  });

  test('backoff total under cap is bounded', () => {
    // Sum of attempts 1..3 = 30 + 120 + 300 = 450 seconds (7.5 min) of
    // total wait before a job is declared dead at default max_attempts=3.
    // This pins the contract: a transient Twilio outage shorter than ~8
    // minutes won't kill all queued texts.
    const total = computeBackoffSeconds(1) + computeBackoffSeconds(2) + computeBackoffSeconds(3);
    assert.equal(total, 450);
  });
});
