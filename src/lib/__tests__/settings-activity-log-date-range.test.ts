// Regression tests for the Settings → Activity Log date-range math
// (src/app/settings/activity-log/date-range.ts).
//
// The server query is end-EXCLUSIVE (occurred_at >= from AND < to), so the
// custom range's `to` must be local midnight of the day AFTER the chosen end
// date. The pre-fix code sent midnight at the START of the end date — parsed
// as UTC via new Date('YYYY-MM-DD') — which dropped the entire end day and
// made same-day custom ranges always return zero events.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rangeFor } from '@/app/settings/activity-log/date-range';

// Fixed "now": July 10 2026, 15:30 local.
const NOW = new Date(2026, 6, 10, 15, 30, 0);
const localMidnight = (y: number, m1: number, d: number) => new Date(y, m1 - 1, d).toISOString();

describe('rangeFor — custom range', () => {
  test('same-day custom range spans the full local day (never empty)', () => {
    const r = rangeFor('custom', '2026-07-08', '2026-07-08', NOW);
    assert.equal(r.from, localMidnight(2026, 7, 8));
    assert.equal(r.to, localMidnight(2026, 7, 9)); // exclusive bound = next local midnight
    assert.ok(new Date(r.to).getTime() > new Date(r.from).getTime());
  });

  test('multi-day custom range includes the entire selected end day', () => {
    const r = rangeFor('custom', '2026-07-08', '2026-07-10', NOW);
    assert.equal(r.from, localMidnight(2026, 7, 8));
    // An event at 23:59 local on July 10 must satisfy occurred_at < to.
    const lateOnEndDay = new Date(2026, 6, 10, 23, 59, 59).toISOString();
    assert.ok(lateOnEndDay < r.to);
    assert.equal(r.to, localMidnight(2026, 7, 11));
  });

  test('bounds are LOCAL midnights, not UTC parses of YYYY-MM-DD', () => {
    const r = rangeFor('custom', '2026-07-08', '2026-07-09', NOW);
    // new Date('2026-07-08') would be UTC midnight; the fix must produce the
    // machine's LOCAL midnight. (On UTC CI these coincide; on any offset
    // machine — like the hotels' — they differ, and this asserts local.)
    assert.equal(r.from, new Date(2026, 6, 8).toISOString());
  });

  test('empty custom inputs fall back to last-7-days-through-today', () => {
    const r = rangeFor('custom', '', '', NOW);
    // Default from: 7×24h before today's local midnight (no DST boundary in
    // early July anywhere the CI runs, so this is exactly July 3 midnight).
    assert.equal(r.from, new Date(new Date(2026, 6, 10).getTime() - 7 * 86400000).toISOString());
    assert.equal(r.to, localMidnight(2026, 7, 11)); // tomorrow — today fully included
  });
});

describe('rangeFor — presets keep their existing semantics', () => {
  test('today = [local midnight, next local midnight)', () => {
    const r = rangeFor('today', undefined, undefined, NOW);
    assert.equal(r.from, localMidnight(2026, 7, 10));
    assert.equal(r.to, localMidnight(2026, 7, 11));
  });

  test('yesterday = [yesterday local midnight, today local midnight)', () => {
    const r = rangeFor('yesterday', undefined, undefined, NOW);
    assert.equal(r.from, localMidnight(2026, 7, 9));
    assert.equal(r.to, localMidnight(2026, 7, 10));
  });

  test('custom same-day equals the today preset when the day is today', () => {
    const preset = rangeFor('today', undefined, undefined, NOW);
    const custom = rangeFor('custom', '2026-07-10', '2026-07-10', NOW);
    assert.deepEqual(custom, preset);
  });
});
