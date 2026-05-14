/**
 * Tests for computeOccupancySummary in src/lib/agent/tools/_helpers.ts —
 * the pure function the AI's get_occupancy tool now relies on.
 *
 * Round 14 (2026-05-14). After the user got "100% occupancy, 70 rooms,
 * 0 vacant" for a 74-room property because the tool read
 * count(rooms today) as the denominator, the math moved to this pure
 * helper so we can unit-test it without spinning up supabase.
 *
 * The contract: total comes from inventory length when configured;
 * occupied is checkout-or-stayover; missing rooms count as vacant.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeOccupancySummary } from '@/lib/agent/tools/_helpers';

describe('computeOccupancySummary', () => {
  it('reports inventory length as total when seed matches', () => {
    // 74 rooms in inventory, 74 in today's seed — 50 occupied, 24 vacant.
    const seeded = [
      ...Array(30).fill('checkout'),
      ...Array(20).fill('stayover'),
      ...Array(24).fill('vacant'),
    ];
    const s = computeOccupancySummary(74, seeded);
    assert.equal(s.total, 74);
    assert.equal(s.occupied, 50);
    assert.equal(s.vacant, 24);
    assert.equal(s.occupancyPercent, 67.6);
    assert.equal(s.seedingGap, 0);
  });

  it('uses inventory length even when seed is short — the 2026-05-14 fix', () => {
    // 74 rooms in inventory but only 70 in seed (Choice CSV dropped 4
    // vacant-clean rooms). All 70 are non-vacant. Pre-fix: 100% / 70 / 0.
    // Post-fix: gap surfaces, vacant counts the 4 missing as vacant.
    const seeded = [
      ...Array(40).fill('checkout'),
      ...Array(30).fill('stayover'),
    ];
    const s = computeOccupancySummary(74, seeded);
    assert.equal(s.total, 74);
    assert.equal(s.occupied, 70);
    assert.equal(s.vacant, 4);
    assert.equal(s.seedingGap, 4);
    // 70/74 = 94.594...% → rounded to 94.6
    assert.equal(s.occupancyPercent, 94.6);
  });

  it('falls back to seed count when inventory is empty (legacy property)', () => {
    const seeded = [
      ...Array(20).fill('checkout'),
      ...Array(10).fill('vacant'),
    ];
    const s = computeOccupancySummary(0, seeded);
    assert.equal(s.total, 30);
    assert.equal(s.occupied, 20);
    assert.equal(s.vacant, 10);
    assert.equal(s.seedingGap, 0);
    assert.equal(s.occupancyPercent, 66.7);
  });

  it('returns all zeros when both inventory and seed are empty', () => {
    const s = computeOccupancySummary(0, []);
    assert.equal(s.total, 0);
    assert.equal(s.occupied, 0);
    assert.equal(s.vacant, 0);
    assert.equal(s.occupancyPercent, 0);
    assert.equal(s.seedingGap, 0);
  });

  it('reports gap = inventory length when nothing is seeded', () => {
    // The cron just hasn't run; inventory says 74; seed is empty.
    // Agent should report 74 total, 0 occupied, 74 vacant.
    const s = computeOccupancySummary(74, []);
    assert.equal(s.total, 74);
    assert.equal(s.occupied, 0);
    assert.equal(s.vacant, 74);
    assert.equal(s.seedingGap, 74);
    assert.equal(s.occupancyPercent, 0);
  });

  it('null and unknown room types do not count as occupied', () => {
    // Defensive: if a row landed with type=null (shouldn't, but the
    // schema CHECK allows only checkout/stayover/vacant — older rows or
    // weird import paths might leave it blank), it shouldn't inflate
    // the occupied count.
    const seeded: Array<string | null> = ['checkout', null, 'stayover', null, 'vacant', undefined as unknown as string];
    const s = computeOccupancySummary(74, seeded);
    assert.equal(s.occupied, 2);
  });

  it('vacant never goes negative when seeded contains more occupied than total', () => {
    // Pathological — inventory=2 but seed has 5 occupied rooms. Should
    // not produce a negative vacant count; this is the safety floor.
    const seeded = ['checkout', 'checkout', 'stayover', 'stayover', 'checkout'];
    const s = computeOccupancySummary(2, seeded);
    assert.equal(s.total, 2);
    assert.equal(s.occupied, 5);
    assert.equal(s.vacant, 0);  // clamped at 0, not -3
  });

  it('occupancyPercent rounds to one decimal', () => {
    // 1 occupied / 3 total = 33.333... → 33.3
    const s = computeOccupancySummary(3, ['checkout', 'vacant', 'vacant']);
    assert.equal(s.occupancyPercent, 33.3);
  });
});
