/**
 * Tests for src/lib/portfolio/anomaly-detector.ts — % deviation
 * thresholding + edge cases (n=1, n=2, identical metrics, division
 * by zero, only-below-average flagged, etc.).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectHousekeepingAnomalies,
  detectAnomalies,
  ANOMALY_THRESHOLD_PCT,
  SEVERE_THRESHOLD_PCT,
} from '@/lib/portfolio/anomaly-detector';
import type {
  HousekeepingTileData,
  PortfolioModuleAverages,
  PortfolioTileData,
} from '@/lib/portfolio/types';

function tile(overrides: Partial<HousekeepingTileData> & { propertyId: string; name?: string }): HousekeepingTileData {
  return {
    propertyId: overrides.propertyId,
    property: { id: overrides.propertyId, name: overrides.name ?? `Hotel ${overrides.propertyId}`, totalRooms: 100 },
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

function avg(overrides: Partial<PortfolioModuleAverages> = {}): PortfolioModuleAverages {
  return {
    module: 'housekeeping',
    propertiesIncluded: 3,
    avgRoomsTurned: 10,
    avgRoomsRemaining: 5,
    avgInspectionPassRate: 0.95,
    avgMinutesPerDeparture: 25,
    avgLaborCostTodayCents: 50000,
    avgLaborBudgetTodayCents: 60000,
    avgStaffActive: 3,
    avgStaffScheduled: 4,
    ...overrides,
  };
}

describe('detectHousekeepingAnomalies — edge cases', () => {
  test('n=1: no comparison possible → no anomalies', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', inspectionPassRate: 0.50 }),
      avg({ propertiesIncluded: 1, avgInspectionPassRate: 0.50 }),
    );
    assert.deepEqual(out, []);
  });

  test('identical metrics: no deviation → no anomalies', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', inspectionPassRate: 0.95, avgMinutesPerDeparture: 25, staffScheduledCount: 4 }),
      avg({ propertiesIncluded: 4 }),
    );
    assert.deepEqual(out, []);
  });

  test('null tile metric → that metric not flagged', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', inspectionPassRate: null }),
      avg({ propertiesIncluded: 4, avgInspectionPassRate: 0.95 }),
    );
    // Other metrics still match the average, so result is empty.
    assert.deepEqual(out, []);
  });

  test('baseline=0 → no division-by-zero flag', () => {
    // If every other property has 0 staff scheduled, comparing to that
    // is meaningless. Detector must return null deviation.
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', staffScheduledCount: 5 }),
      avg({ propertiesIncluded: 3, avgStaffScheduled: 0 }),
    );
    // No staff-scheduled anomaly because baseline is 0.
    assert.equal(out.find(a => a.metric === 'Staff scheduled'), undefined);
  });

  test('inspection pass rate ABOVE average is not an anomaly', () => {
    // We only flag when worse than the portfolio. Being a star isn't
    // an anomaly to investigate.
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', inspectionPassRate: 1.0 }),
      avg({ propertiesIncluded: 4, avgInspectionPassRate: 0.70 }),
    );
    assert.deepEqual(out, []);
  });

  test('inspection pass rate BELOW threshold → yellow', () => {
    // tile = 0.80, avg = 0.95 → dev = 0.158 (>15%, <30%) → yellow
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', inspectionPassRate: 0.80 }),
      avg({ propertiesIncluded: 4, avgInspectionPassRate: 0.95 }),
    );
    const passAnomaly = out.find(a => a.metric === 'Inspection pass rate');
    assert.ok(passAnomaly, 'pass-rate anomaly should be flagged');
    assert.equal(passAnomaly!.severity, 'yellow');
    // Sanity: the threshold is what we documented.
    assert.ok(ANOMALY_THRESHOLD_PCT < SEVERE_THRESHOLD_PCT);
  });

  test('inspection pass rate severely below → red', () => {
    // tile = 0.50, avg = 0.95 → dev ≈ 0.47 → red
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', inspectionPassRate: 0.50 }),
      avg({ propertiesIncluded: 4, avgInspectionPassRate: 0.95 }),
    );
    const a = out.find(x => x.metric === 'Inspection pass rate');
    assert.ok(a);
    assert.equal(a!.severity, 'red');
  });

  test('minutes per departure: HIGHER than average flagged (slow turnover)', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', avgMinutesPerDeparture: 35 }),
      avg({ propertiesIncluded: 4, avgMinutesPerDeparture: 25 }),
    );
    const a = out.find(x => x.metric === 'Minutes per departure');
    assert.ok(a, 'slow turnover should be flagged');
  });

  test('minutes per departure: LOWER than average is NOT flagged', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', avgMinutesPerDeparture: 15 }),
      avg({ propertiesIncluded: 4, avgMinutesPerDeparture: 25 }),
    );
    const a = out.find(x => x.metric === 'Minutes per departure');
    assert.equal(a, undefined);
  });

  test('labor cost overrun on own budget: yellow at +15%, red at +30%', () => {
    const yellow = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', laborCostTodayCents: 11500, laborBudgetTodayCents: 10000 }),
      avg({ propertiesIncluded: 4 }),
    );
    const y = yellow.find(a => a.metric === 'Labor cost');
    assert.ok(y);
    assert.equal(y!.severity, 'yellow');

    const red = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', laborCostTodayCents: 14000, laborBudgetTodayCents: 10000 }),
      avg({ propertiesIncluded: 4 }),
    );
    const r = red.find(a => a.metric === 'Labor cost');
    assert.ok(r);
    assert.equal(r!.severity, 'red');
  });

  test('labor cost UNDER budget: no anomaly', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', laborCostTodayCents: 5000, laborBudgetTodayCents: 10000 }),
      avg({ propertiesIncluded: 4 }),
    );
    const a = out.find(x => x.metric === 'Labor cost');
    assert.equal(a, undefined);
  });

  test('labor cost: missing budget → no anomaly', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', laborCostTodayCents: 50000, laborBudgetTodayCents: null }),
      avg({ propertiesIncluded: 4 }),
    );
    const a = out.find(x => x.metric === 'Labor cost');
    assert.equal(a, undefined);
  });

  test('staff scheduled BELOW average → flagged (under-staffed)', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', staffScheduledCount: 2 }),
      avg({ propertiesIncluded: 4, avgStaffScheduled: 4 }),
    );
    const a = out.find(x => x.metric === 'Staff scheduled');
    assert.ok(a, 'understaffing should be flagged');
  });

  test('staff scheduled ABOVE average → NOT flagged (overstaffing handled by labor-cost block)', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', staffScheduledCount: 10 }),
      avg({ propertiesIncluded: 4, avgStaffScheduled: 4 }),
    );
    const a = out.find(x => x.metric === 'Staff scheduled');
    assert.equal(a, undefined);
  });

  test('explanation text is plain English with property name', () => {
    const out = detectHousekeepingAnomalies(
      tile({ propertyId: 'a', name: 'Hotel Beta', inspectionPassRate: 0.50 }),
      avg({ propertiesIncluded: 4, avgInspectionPassRate: 0.95 }),
    );
    const a = out.find(x => x.metric === 'Inspection pass rate');
    assert.ok(a);
    assert.ok(a!.explanation.includes('Hotel Beta'));
    assert.ok(a!.explanation.includes('50%'));
    assert.ok(a!.explanation.includes('investigate'));
  });
});

describe('detectAnomalies — top-level dispatch', () => {
  test('returns empty when no housekeeping tiles', () => {
    const out = detectAnomalies([], []);
    assert.deepEqual(out, []);
  });

  test('skips non-housekeeping tiles for housekeeping detector', () => {
    // Today only housekeeping tiles exist. We assert the dispatch
    // routes correctly by passing a tile + matching averages and
    // confirming the housekeeping detector ran.
    const tiles: PortfolioTileData[] = [
      { module: 'housekeeping', ...tile({ propertyId: 'a', inspectionPassRate: 0.5 }) },
      { module: 'housekeeping', ...tile({ propertyId: 'b', inspectionPassRate: 0.95 }) },
    ];
    const averages = [avg({ propertiesIncluded: 2, avgInspectionPassRate: 0.725 })];
    const out = detectAnomalies(tiles, averages);
    // Property 'a' is 0.5 vs 0.725 avg, ≈ 31% below → should flag (red).
    assert.ok(out.some(a => a.propertyId === 'a'));
  });
});
