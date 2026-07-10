/**
 * Tests for the dashboard counts last-good hold
 * (src/app/dashboard/_components/counts-hold.ts).
 *
 * fetchTodayPropertyCounts collapses RPC errors to an ALL-ZERO shape; the
 * dashboard used to setCounts() unconditionally, so one failed 30s poll
 * flipped a live wall-TV dashboard to the blank '—' ring and a 0 Departures
 * tile until the next poll. holdLastGoodCounts keeps the previous real
 * numbers through that error-fallback while still letting genuine data
 * (including genuine zero fields) land.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { holdLastGoodCounts, isZeroCounts } from '@/app/dashboard/_components/counts-hold';
import type { TodayPropertyCounts } from '@/lib/db/today-room-work';

const ZERO: TodayPropertyCounts = {
  checkouts: 0, stayovers: 0, vacant_clean: 0, vacant_dirty: 0,
  ooo: 0, total_rooms: 0, total_checkouts_today: 0, in_house: 0,
};

const REAL: TodayPropertyCounts = {
  checkouts: 12, stayovers: 48, vacant_clean: 10, vacant_dirty: 3,
  ooo: 1, total_rooms: 74, total_checkouts_today: 14, in_house: 60,
};

describe('isZeroCounts', () => {
  test('true only for the all-zero error-fallback shape', () => {
    assert.equal(isZeroCounts(ZERO), true);
    assert.equal(isZeroCounts(REAL), false);
    // A real snapshot always carries a non-zero total_rooms even on a dead
    // day — one non-zero field is enough to count as data.
    assert.equal(isZeroCounts({ ...ZERO, total_rooms: 74 }), false);
  });
});

describe('holdLastGoodCounts', () => {
  test('holds real numbers through an error-fallback poll (the 30s flap)', () => {
    assert.equal(holdLastGoodCounts(REAL, ZERO), REAL);
  });

  test('first load lands even when all-zero (bootstrap window)', () => {
    assert.equal(holdLastGoodCounts(null, ZERO), ZERO);
  });

  test('fresh real data always replaces the previous value', () => {
    const next = { ...REAL, checkouts: 9 };
    assert.equal(holdLastGoodCounts(REAL, next), next);
    assert.equal(holdLastGoodCounts(ZERO, next), next);
  });

  test('zero-to-zero stays on the new value (no stale identity)', () => {
    const nextZero = { ...ZERO };
    assert.equal(holdLastGoodCounts(ZERO, nextZero), nextZero);
  });

  test('a quiet-but-real snapshot (only total_rooms set) still lands', () => {
    const quiet = { ...ZERO, total_rooms: 74 };
    assert.equal(holdLastGoodCounts(REAL, quiet), quiet);
  });
});
