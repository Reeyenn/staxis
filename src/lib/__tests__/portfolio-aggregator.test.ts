/**
 * Tests for src/lib/portfolio/aggregator.ts — the pure-function math
 * that produces portfolio-wide totals and per-module averages.
 *
 * Focus areas:
 *   • Averages ignore null contributors (a property with no inspections
 *     doesn't drag the portfolio pass-rate down to 0).
 *   • Totals treat null as zero (banner stays informative).
 *   • Distinct-property counting handles duplicate / multi-module tiles.
 *   • Empty / single / many property cases.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeModuleAverages, computeSummary } from '@/lib/portfolio/aggregator';
import type { PortfolioTileData } from '@/lib/portfolio/types';

function hkTile(propertyId: string, overrides: Partial<Extract<PortfolioTileData, { module: 'housekeeping' }>> = {}): PortfolioTileData {
  return {
    module: 'housekeeping',
    propertyId,
    property: { id: propertyId, name: `Hotel ${propertyId.slice(0, 2)}`, totalRooms: 100 },
    roomsTurned: 10,
    roomsRemaining: 5,
    inspectionPassRate: 0.95,
    avgMinutesPerDeparture: 25,
    laborCostTodayCents: 50000,
    laborBudgetTodayCents: 60000,
    staffActiveCount: 3,
    staffScheduledCount: 4,
    accuracyLabel: 'industry_estimate_learning',
    ...overrides,
  };
}

describe('computeModuleAverages — housekeeping', () => {
  test('returns empty array when no tiles given', () => {
    const out = computeModuleAverages([]);
    assert.deepEqual(out, []);
  });

  test('single-property: average == that property', () => {
    const out = computeModuleAverages([hkTile('a', { roomsTurned: 7, inspectionPassRate: 0.8 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].propertiesIncluded, 1);
    assert.equal(out[0].avgRoomsTurned, 7);
    assert.equal(out[0].avgInspectionPassRate, 0.8);
  });

  test('two properties: simple mean', () => {
    const out = computeModuleAverages([
      hkTile('a', { roomsTurned: 10 }),
      hkTile('b', { roomsTurned: 20 }),
    ]);
    assert.equal(out[0].avgRoomsTurned, 15);
  });

  test('null inspection-pass-rate excluded from average', () => {
    // One property with no inspections today (null) + one at 90%. The
    // average MUST be 90%, not 45% — null is "no data", not zero.
    const out = computeModuleAverages([
      hkTile('a', { inspectionPassRate: null }),
      hkTile('b', { inspectionPassRate: 0.9 }),
    ]);
    assert.equal(out[0].avgInspectionPassRate, 0.9);
    assert.equal(out[0].propertiesIncluded, 2);
  });

  test('all-null metric returns null', () => {
    const out = computeModuleAverages([
      hkTile('a', { inspectionPassRate: null, avgMinutesPerDeparture: null }),
      hkTile('b', { inspectionPassRate: null, avgMinutesPerDeparture: null }),
    ]);
    assert.equal(out[0].avgInspectionPassRate, null);
    assert.equal(out[0].avgMinutesPerDeparture, null);
  });
});

describe('computeSummary — banner totals', () => {
  test('empty tile list → zeros', () => {
    const s = computeSummary([], 0);
    assert.equal(s.propertiesCount, 0);
    assert.equal(s.totalRoomsTurned, 0);
    assert.equal(s.totalRoomsRemaining, 0);
    assert.equal(s.totalLaborCostTodayCents, 0);
    assert.equal(s.totalLaborBudgetTodayCents, 0);
    assert.equal(s.anomalyCount, 0);
  });

  test('totals sum across properties', () => {
    const s = computeSummary([
      hkTile('a', { roomsTurned: 10, roomsRemaining: 5, laborCostTodayCents: 100, laborBudgetTodayCents: 200 }),
      hkTile('b', { roomsTurned: 20, roomsRemaining: 8, laborCostTodayCents: 300, laborBudgetTodayCents: 400 }),
    ], 0);
    assert.equal(s.propertiesCount, 2);
    assert.equal(s.totalRoomsTurned, 30);
    assert.equal(s.totalRoomsRemaining, 13);
    assert.equal(s.totalLaborCostTodayCents, 400);
    assert.equal(s.totalLaborBudgetTodayCents, 600);
  });

  test('null cost/budget treated as zero in totals', () => {
    const s = computeSummary([
      hkTile('a', { laborCostTodayCents: null, laborBudgetTodayCents: null }),
      hkTile('b', { laborCostTodayCents: 500, laborBudgetTodayCents: 800 }),
    ], 0);
    assert.equal(s.totalLaborCostTodayCents, 500);
    assert.equal(s.totalLaborBudgetTodayCents, 800);
  });

  test('propertiesCount is distinct (across modules)', () => {
    // Two housekeeping tiles for the same property would still count
    // as ONE property (future-proofs when multiple modules attach).
    const s = computeSummary([
      hkTile('a'),
      hkTile('a'),
      hkTile('b'),
    ], 0);
    assert.equal(s.propertiesCount, 2);
  });

  test('anomalyCount echoed through', () => {
    const s = computeSummary([hkTile('a')], 7);
    assert.equal(s.anomalyCount, 7);
  });
});
