/**
 * Ingest anomaly detectors (src/lib/pms/ingest-anomaly.ts).
 *
 * The detectors exist to say "this report looks odd" WITHOUT ever refusing
 * it. A hotel really can sell out overnight and a work-order report really
 * can be empty on a good day, so every detector here is deliberately
 * conservative: a floor, a minimum history, and abstention whenever the
 * baseline is not meaningful. The failure mode being avoided is a founder who
 * learns to ignore the flag.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectIngestAnomalies,
  detectOccupancyJump,
  detectRevenueCollapse,
  detectRowCountCollapse,
  detectSnapshotRoomSumMismatch,
  median,
} from '@/lib/pms/ingest-anomaly';

describe('median', () => {
  it('is the middle of an odd series and the mean of the middle two of an even one', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  it('is null for an empty series and ignores non-finite values', () => {
    assert.equal(median([]), null);
    assert.equal(median([Number.NaN, 5, Number.POSITIVE_INFINITY]), 5);
  });
});

describe('detectOccupancyJump', () => {
  it('flags a 45-point move', () => {
    const a = detectOccupancyJump(85, 40);
    assert.ok(a);
    assert.equal(a.kind, 'occupancy_jump');
    assert.match(a.detail, /up 45 points/);
  });

  it('flags a 45-point DROP too — a collapse is as suspicious as a spike', () => {
    const a = detectOccupancyJump(40, 85);
    assert.ok(a);
    assert.match(a.detail, /down 45 points/);
  });

  it('does NOT flag a 5-point move', () => {
    assert.equal(detectOccupancyJump(45, 40), null);
  });

  it('does not flag exactly at the threshold — the boundary is strictly past it', () => {
    assert.equal(detectOccupancyJump(80, 40), null);
    assert.ok(detectOccupancyJump(80.5, 40));
  });

  it('abstains with no previous reading — no baseline is not an anomaly', () => {
    assert.equal(detectOccupancyJump(85, null), null);
    assert.equal(detectOccupancyJump(null, 40), null);
  });
});

describe('detectRevenueCollapse', () => {
  const week = [1_200_00, 1_100_00, 1_350_00, 900_00, 1_250_00, 1_400_00, 1_150_00];

  it('flags $0 today against a real revenue history', () => {
    const a = detectRevenueCollapse(0, week);
    assert.ok(a);
    assert.equal(a.kind, 'revenue_collapse');
    assert.equal(a.observed, 0);
  });

  it('does NOT flag $0 with no history — 0 → 0 is a hotel that never reported revenue', () => {
    assert.equal(detectRevenueCollapse(0, [0, 0, 0, 0]), null);
    assert.equal(detectRevenueCollapse(0, []), null);
  });

  it('does not flag a merely LOW figure — that is an early-in-the-day reading', () => {
    assert.equal(detectRevenueCollapse(5_00, week), null);
  });

  it('ignores a hotel whose usual day is under the floor', () => {
    assert.equal(detectRevenueCollapse(0, [50_00, 40_00, 60_00]), null);
  });
});

describe('detectRowCountCollapse', () => {
  const usual = [42, 45, 38, 40, 44, 41, 43];

  it('flags a report carrying a fraction of its usual rows', () => {
    const a = detectRowCountCollapse('roomStatus', 5, usual);
    assert.ok(a);
    assert.equal(a.feedKey, 'roomStatus');
    assert.equal(a.observed, 5);
  });

  it('flags zero rows against a real history', () => {
    assert.ok(detectRowCountCollapse('roomStatus', 0, usual));
  });

  it('does not flag a normal day', () => {
    assert.equal(detectRowCountCollapse('roomStatus', 39, usual), null);
  });

  it('abstains for a feed whose usual row count is tiny — 3 → 1 means nothing', () => {
    assert.equal(detectRowCountCollapse('workOrders', 1, [3, 2, 4, 3]), null);
  });

  it('abstains with no history at all', () => {
    assert.equal(detectRowCountCollapse('workOrders', 0, []), null);
  });
});

describe('detectSnapshotRoomSumMismatch', () => {
  it('flags house counts that do not add up to the hotel', () => {
    const a = detectSnapshotRoomSumMismatch(
      { totalOccupiedRooms: 40, totalVacantClean: 10, totalVacantDirty: 5, totalOoo: 1 },
      80,
    );
    assert.ok(a);
    assert.equal(a.observed, 56);
    assert.equal(a.baseline, 80);
  });

  it('tolerates a couple of rooms moving between the report sections', () => {
    assert.equal(
      detectSnapshotRoomSumMismatch(
        { totalOccupiedRooms: 40, totalVacantClean: 20, totalVacantDirty: 18, totalOoo: 3 },
        80,
      ),
      null,
    );
  });

  it('abstains on a partial snapshot — a missing number is not a wrong number', () => {
    assert.equal(
      detectSnapshotRoomSumMismatch(
        { totalOccupiedRooms: 40, totalVacantClean: 10, totalVacantDirty: null, totalOoo: 1 },
        80,
      ),
      null,
    );
  });

  it('abstains when the hotel room count is unknown', () => {
    assert.equal(
      detectSnapshotRoomSumMismatch(
        { totalOccupiedRooms: 40, totalVacantClean: 10, totalVacantDirty: 5, totalOoo: 1 },
        null,
      ),
      null,
    );
  });
});

describe('detectIngestAnomalies — the batch entry point', () => {
  it('returns every finding for one delivery', () => {
    const found = detectIngestAnomalies({
      occupancyPct: 85,
      previousOccupancyPct: 40,
      revenueTodayCents: 0,
      recentDailyRevenueCents: [1_200_00, 1_100_00, 1_350_00],
      feedRowCounts: [{ feedKey: 'roomStatus', rows: 2, recent: [42, 45, 38] }],
      snapshotSums: { totalOccupiedRooms: 40, totalVacantClean: 10, totalVacantDirty: 5, totalOoo: 1 },
      totalRooms: 80,
    });
    assert.deepEqual(found.map((f) => f.kind).sort(), [
      'occupancy_jump',
      'revenue_collapse',
      'row_count_collapse',
      'snapshot_room_sum_mismatch',
    ]);
  });

  it('returns nothing for an ordinary delivery', () => {
    const found = detectIngestAnomalies({
      occupancyPct: 62,
      previousOccupancyPct: 58,
      revenueTodayCents: 1_180_00,
      recentDailyRevenueCents: [1_200_00, 1_100_00, 1_350_00],
      feedRowCounts: [{ feedKey: 'roomStatus', rows: 41, recent: [42, 45, 38] }],
      snapshotSums: { totalOccupiedRooms: 50, totalVacantClean: 20, totalVacantDirty: 9, totalOoo: 1 },
      totalRooms: 80,
    });
    assert.deepEqual(found, []);
  });

  it('returns nothing when it has nothing to compare against', () => {
    assert.deepEqual(detectIngestAnomalies({}), []);
  });

  it('is a PURE function of its input — no findings can reach a write path from here', () => {
    // Structural guarantee behind "an anomaly flags, it never alerts and never
    // blocks a write": this module returns values and takes no sink. Running
    // it twice on the same input must therefore be indistinguishable.
    const input = { occupancyPct: 85, previousOccupancyPct: 40 };
    assert.deepEqual(detectIngestAnomalies(input), detectIngestAnomalies(input));
    assert.deepEqual(input, { occupancyPct: 85, previousOccupancyPct: 40 });
  });
});
