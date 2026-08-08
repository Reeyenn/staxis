/**
 * The Home hub's occupancy tile must never disagree with the Dashboard ring.
 *
 * THE BUG: `today_property_counts_v1` COALESCEs the in-house snapshot to 0 and
 * counts `total_rooms` from a different table entirely. The Home tile used to
 * divide one by the other, so a hotel with a learned room roster and a silent
 * counts feed read "0% occupied" in the green all-is-well tone while the
 * Dashboard, on the same RPC row in the same second, correctly read
 * "—  waiting for PMS data". The manager's overview page said the hotel was
 * empty.
 *
 * Every case below is stated twice on purpose: what the tile says, and that it
 * says exactly what occupancyPctFromCounts (the Dashboard's own derivation)
 * says. The second assertion is the one that fails the day somebody re-inlines
 * the arithmetic.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeHomeOccupancy } from '@/lib/home-occupancy-summary';
import { occupancyPctFromCounts } from '@/app/dashboard/_components/counts-hold';
import type { TodayPropertyCounts } from '@/lib/db/today-room-work';

/** The RPC row, with the COALESCE-to-0 shape it really returns. */
function rpcRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    checkouts: 0,
    stayovers: 0,
    vacant_clean: 0,
    vacant_dirty: 0,
    ooo: 0,
    total_rooms: 0,
    total_checkouts_today: 0,
    in_house: 0,
    ...over,
  };
}

/** The same row as the Dashboard's counts shape, for the agreement assertion. */
function asCounts(row: Record<string, unknown>): TodayPropertyCounts {
  return {
    checkouts: Number(row.checkouts ?? 0),
    stayovers: Number(row.stayovers ?? 0),
    vacant_clean: Number(row.vacant_clean ?? 0),
    vacant_dirty: Number(row.vacant_dirty ?? 0),
    ooo: Number(row.ooo ?? 0),
    total_rooms: Number(row.total_rooms ?? 0),
    total_checkouts_today: Number(row.total_checkouts_today ?? 0),
    in_house: Number(row.in_house ?? 0),
  };
}

describe('summarizeHomeOccupancy — the fabricated zero', () => {
  test('a learned room roster with a silent counts feed is unknown, not 0% occupied', () => {
    // 74 rooms in pms_rooms_inventory, nothing in pms_in_house_snapshot.
    // The old tile printed "0% occupied" in the green tone.
    const row = rpcRow({ total_rooms: 74 });
    assert.equal(summarizeHomeOccupancy(row, 74), null);
    assert.equal(occupancyPctFromCounts(asCounts(row), 74), null);
  });

  test('a snapshot with vacants but no occupied count agrees with the Dashboard, not with zero', () => {
    // The 65-point disagreement. The snapshot reports the vacant columns and
    // leaves total_occupied_rooms null, so the honest answer is
    // 74 − 20 − 5 − 1 = 48 of 74 = 65%. The old tile said 0%.
    const row = rpcRow({ total_rooms: 74, vacant_clean: 20, vacant_dirty: 5, ooo: 1 });
    const line = summarizeHomeOccupancy(row, 74);
    assert.deepEqual(line, { en: '65% occupied', tone: 'ok' });
    assert.equal(occupancyPctFromCounts(asCounts(row), 74), 65);
  });

  test('a genuinely empty hotel that reported its mix still reads 0%', () => {
    // Every room vacant and the snapshot said so. This zero is measured, not
    // fabricated, and suppressing it would be the opposite lie.
    const row = rpcRow({ total_rooms: 74, vacant_clean: 74 });
    assert.deepEqual(summarizeHomeOccupancy(row, 74), { en: '0% occupied', tone: 'ok' });
    assert.equal(occupancyPctFromCounts(asCounts(row), 74), 0);
  });

  test('a reported occupancy renders and matches the Dashboard exactly', () => {
    const row = rpcRow({ total_rooms: 74, in_house: 60, vacant_clean: 10, vacant_dirty: 3, ooo: 1 });
    assert.deepEqual(summarizeHomeOccupancy(row, 74), { en: '81% occupied', tone: 'ok' });
    assert.equal(occupancyPctFromCounts(asCounts(row), 74), 81);
  });
});

describe('summarizeHomeOccupancy — the denominator', () => {
  test('divides by the hotel\'s configured inventory, never the PMS partial sample', () => {
    // pms_rooms_inventory has only learned 48 of the hotel's 74 rooms. Dividing
    // by 48 reads 125% — a hotel more than full. The Dashboard divides by the
    // configured 74 and reads 81%.
    const row = rpcRow({ total_rooms: 48, in_house: 60 });
    assert.deepEqual(summarizeHomeOccupancy(row, 74), { en: '81% occupied', tone: 'ok' });
    assert.equal(occupancyPctFromCounts(asCounts(row), 74), 81);
  });

  test('falls back to the PMS count when the property has no configured inventory', () => {
    const row = rpcRow({ total_rooms: 50, in_house: 25 });
    assert.deepEqual(summarizeHomeOccupancy(row, null), { en: '50% occupied', tone: 'ok' });
    assert.deepEqual(summarizeHomeOccupancy(row, 0), { en: '50% occupied', tone: 'ok' });
  });

  test('never renders past 100% even when the configured count lags the PMS', () => {
    const row = rpcRow({ total_rooms: 74, in_house: 80 });
    assert.deepEqual(summarizeHomeOccupancy(row, 74), { en: '100% occupied', tone: 'ok' });
  });
});

describe('summarizeHomeOccupancy — unusable input', () => {
  test('no row at all is unknown', () => {
    assert.equal(summarizeHomeOccupancy(null, 74), null);
    assert.equal(summarizeHomeOccupancy(undefined, 74), null);
  });

  test('no room inventory anywhere is unknown, not a division by zero', () => {
    assert.equal(summarizeHomeOccupancy(rpcRow(), null), null);
  });

  test('a garbled column reads as no data rather than NaN%', () => {
    const line = summarizeHomeOccupancy(
      rpcRow({ total_rooms: 74, in_house: 'forty' }),
      74,
    );
    // in_house is unusable, and nothing else reported, so there is no mix.
    assert.equal(line, null);
  });
});
