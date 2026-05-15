/**
 * Tests for computeOccupancySummary + computeRoomTotal in
 * src/lib/agent/tools/_helpers.ts — the pure functions the AI's
 * get_occupancy, get_today_summary, and buildHotelSnapshot all depend on.
 *
 * Round 14 (2026-05-14). Moved total computation into a pure helper so
 * the contract is unit-testable.
 *
 * Round 15 (2026-05-14, Codex finding A). Added `configuredTotalRooms`
 * as a third signal. Total = max(inventoryLength, configuredTotalRooms,
 * seededRowCount). Reasoning: the three SHOULD all agree (INV-24) but
 * during a transient drift the largest is the safer answer — the AI
 * never under-reports while the doctor pages SMS for the drift.
 *
 * The 2-arg signature was replaced; all tests now pass 3 args.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeOccupancySummary,
  computeRoomTotal,
} from '@/lib/agent/tools/_helpers';

describe('computeOccupancySummary', () => {
  it('reports the agreed total when inventory, total_rooms, and seed all match', () => {
    // 74 in all three — 50 occupied, 24 vacant.
    const seeded = [
      ...Array(30).fill('checkout'),
      ...Array(20).fill('stayover'),
      ...Array(24).fill('vacant'),
    ];
    const s = computeOccupancySummary(74, 74, seeded);
    assert.equal(s.total, 74);
    assert.equal(s.occupied, 50);
    assert.equal(s.vacant, 24);
    assert.equal(s.occupancyPercent, 67.6);
    assert.equal(s.seedingGap, 0);
  });

  it('uses max signal even when seed is short — the 2026-05-14 fix', () => {
    // 74 rooms in inventory + total_rooms, but only 70 in seed (Choice
    // CSV dropped 4 vacant-clean rooms). All 70 are non-vacant.
    // Pre-Round-14: 100% / 70 / 0. Post-fix: 74 total, 4 vacant.
    const seeded = [
      ...Array(40).fill('checkout'),
      ...Array(30).fill('stayover'),
    ];
    const s = computeOccupancySummary(74, 74, seeded);
    assert.equal(s.total, 74);
    assert.equal(s.occupied, 70);
    assert.equal(s.vacant, 4);
    assert.equal(s.seedingGap, 4);
    assert.equal(s.occupancyPercent, 94.6);
  });

  it('Round 15: takes max when inventory and total_rooms disagree (inventory stale)', () => {
    // Codex finding A scenario: total_rooms=74, inventory=70 (stale).
    // Round 14 would have reported 70. Round 15 reports 74 — the higher.
    // Doctor check fires SMS on the disagreement so it gets fixed fast.
    const seeded = [
      ...Array(40).fill('checkout'),
      ...Array(30).fill('vacant'),
    ];
    const s = computeOccupancySummary(70, 74, seeded);
    assert.equal(s.total, 74);
    assert.equal(s.seedingGap, 4);  // 74 - 70 seeded
  });

  it('Round 15: takes total_rooms when inventory is empty (pre-Round-14 properties)', () => {
    // total_rooms=74, room_inventory=[] (legacy properties not yet
    // backfilled). Pre-Round-15: AI fell back to seeded count.
    // Post-Round-15: AI reports total_rooms.
    const seeded = [
      ...Array(50).fill('checkout'),
    ];
    const s = computeOccupancySummary(0, 74, seeded);
    assert.equal(s.total, 74);
    assert.equal(s.occupied, 50);
    assert.equal(s.vacant, 24);
    assert.equal(s.seedingGap, 24);
  });

  it('falls back to seed count when both inventory and total_rooms are zero', () => {
    const seeded = [
      ...Array(20).fill('checkout'),
      ...Array(10).fill('vacant'),
    ];
    const s = computeOccupancySummary(0, 0, seeded);
    assert.equal(s.total, 30);
    assert.equal(s.occupied, 20);
    assert.equal(s.vacant, 10);
    assert.equal(s.seedingGap, 0);
  });

  it('returns all zeros when every signal is empty', () => {
    const s = computeOccupancySummary(0, 0, []);
    assert.equal(s.total, 0);
    assert.equal(s.occupied, 0);
    assert.equal(s.vacant, 0);
    assert.equal(s.occupancyPercent, 0);
    assert.equal(s.seedingGap, 0);
  });

  it('reports gap = total when nothing is seeded but inventory/total_rooms set', () => {
    const s = computeOccupancySummary(74, 74, []);
    assert.equal(s.total, 74);
    assert.equal(s.occupied, 0);
    assert.equal(s.vacant, 74);
    assert.equal(s.seedingGap, 74);
    assert.equal(s.occupancyPercent, 0);
  });

  it('null and unknown room types do not count as occupied', () => {
    const seeded: Array<string | null> = ['checkout', null, 'stayover', null, 'vacant', undefined as unknown as string];
    const s = computeOccupancySummary(74, 74, seeded);
    assert.equal(s.occupied, 2);
  });

  it('vacant never goes negative when seeded contains more occupied than total', () => {
    const seeded = ['checkout', 'checkout', 'stayover', 'stayover', 'checkout'];
    const s = computeOccupancySummary(2, 2, seeded);
    assert.equal(s.total, 5);  // seededRowCount wins because it's larger
    assert.equal(s.occupied, 5);
    assert.equal(s.vacant, 0);
  });

  it('occupancyPercent rounds to one decimal', () => {
    const s = computeOccupancySummary(3, 3, ['checkout', 'vacant', 'vacant']);
    assert.equal(s.occupancyPercent, 33.3);
  });

  it('negative signals get clamped to zero before max', () => {
    // Defensive: if a misconfigured property somehow yields a negative
    // value (shouldn't given CHECK > 0, but defense in depth), the max
    // ignores it rather than returning a negative total.
    const s = computeOccupancySummary(-5, -10, ['checkout', 'vacant']);
    assert.equal(s.total, 2);  // seededRowCount wins; negatives clamped to 0
  });
});

describe('computeRoomTotal', () => {
  it('picks the max of the three signals', () => {
    assert.deepEqual(computeRoomTotal(70, 74, 65), { total: 74, seedingGap: 9 });
    assert.deepEqual(computeRoomTotal(74, 70, 65), { total: 74, seedingGap: 9 });
    assert.deepEqual(computeRoomTotal(70, 65, 74), { total: 74, seedingGap: 0 });
  });

  it('seedingGap is total minus seeded, clamped at zero', () => {
    assert.deepEqual(computeRoomTotal(74, 74, 74), { total: 74, seedingGap: 0 });
    assert.deepEqual(computeRoomTotal(74, 74, 0), { total: 74, seedingGap: 74 });
    // seeded > both other signals → no gap
    assert.deepEqual(computeRoomTotal(2, 2, 5), { total: 5, seedingGap: 0 });
  });

  it('treats negative signals as zero', () => {
    assert.deepEqual(computeRoomTotal(-5, -10, 0), { total: 0, seedingGap: 0 });
    assert.deepEqual(computeRoomTotal(-5, 74, 70), { total: 74, seedingGap: 4 });
  });
});
