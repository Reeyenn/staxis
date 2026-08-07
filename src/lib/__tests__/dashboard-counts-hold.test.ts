/**
 * Tests for the dashboard's counts → ring-occupancy path
 * (src/app/dashboard/_components/counts-hold.ts, plus the live anchor in
 * src/lib/dashboard/today-series.ts).
 *
 * fetchTodayPropertyCounts collapses RPC errors to an ALL-ZERO shape; the
 * dashboard used to setCounts() unconditionally, so one failed 30s poll
 * flipped a live wall-TV dashboard to the blank '—' ring and a 0 Departures
 * tile until the next poll. holdLastGoodCounts keeps the previous real
 * numbers through that error-fallback while still letting genuine data
 * (including genuine zero fields) land.
 *
 * occupancyPctFromCounts turns that shape into the headline figure. It must
 * read in_house (tonight's occupied rooms) rather than stayovers + checkouts
 * (two different nights added together), and a real 0 must survive all the way
 * into the chart's today row instead of being replaced by a generated one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  holdLastGoodCounts,
  isZeroCounts,
  occupancyPctFromCounts,
} from '@/app/dashboard/_components/counts-hold';
import { buildHistory } from '@/lib/dashboard/today-series';
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

describe('occupancyPctFromCounts', () => {
  test('reads tonight\'s occupied rooms, not stayovers + checkouts', () => {
    // 60 in house of 74 = 81%. Adding the 12 departures that left this
    // morning would read 81 rooms of 74, i.e. a hotel over 100% full.
    assert.equal(occupancyPctFromCounts(REAL, 74), 81);
  });

  test('agrees with the Home tile formula for the same snapshot', () => {
    const homeTilePct = Math.round((REAL.in_house / REAL.total_rooms) * 100);
    assert.equal(occupancyPctFromCounts(REAL, REAL.total_rooms), homeTilePct);
  });

  test('an empty hotel with a reported snapshot is a real 0, not unknown', () => {
    const empty = { ...ZERO, total_rooms: 74, vacant_clean: 70, vacant_dirty: 4 };
    assert.equal(occupancyPctFromCounts(empty, 74), 0);
  });

  test('falls back to the seal-daily subtraction when in_house is missing', () => {
    // 74 rooms, 20 clean + 4 dirty vacant, 2 out of order → 48 occupied.
    const noInHouse = { ...ZERO, total_rooms: 74, vacant_clean: 20, vacant_dirty: 4, ooo: 2 };
    assert.equal(occupancyPctFromCounts(noInHouse, 74), Math.round((48 / 74) * 100));
  });

  test('inventory with no snapshot yet stays unknown, never a full hotel', () => {
    // The subtraction fallback on an all-zero snapshot would say 74 of 74.
    assert.equal(occupancyPctFromCounts({ ...ZERO, total_rooms: 74 }, 74), null);
  });

  test('no counts / no inventory stays unknown', () => {
    assert.equal(occupancyPctFromCounts(null, 74), null);
    assert.equal(occupancyPctFromCounts(ZERO, 74), null);
  });

  test('never reads past 100% when the configured room count lags the PMS', () => {
    const overflowing = { ...ZERO, total_rooms: 120, in_house: 118 };
    assert.equal(occupancyPctFromCounts(overflowing, 74), 100);
  });
});

describe('ring center never fabricates an occupancy figure', () => {
  const todayRow = (anchor: number | null) => buildHistory(108, anchor).slice(-1)[0];

  test('a real 0 pins today\'s row instead of leaving a generated percentage', () => {
    const row = todayRow(0);
    assert.equal(row.occ, 0);
    assert.equal(row.rooms, 0);
    // Generated rows never sit at 0, so this proves the anchor ran.
    assert.notEqual(todayRow(null).occ, 0);
  });

  test('a real reading still pins today\'s row', () => {
    assert.equal(todayRow(81).occ, 81);
    assert.equal(todayRow(81).rooms, Math.round(0.81 * 108));
  });
});
