/**
 * Behavior tests for the daily-report anomaly detector.
 *
 * Each anomaly type fires under specific conditions described in
 * anomaly-detector.ts; this file pins those thresholds with concrete
 * inputs and asserts the right messages are produced. Also exercises
 * the silence path — when nothing's unusual, no anomalies are returned.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { detectAnomalies, type DailyBaselineSlice } from '@/lib/reports/anomaly-detector';
import type { DailyReportPayload } from '@/lib/reports/types';

function makeBaseline(values: Array<Partial<DailyBaselineSlice> & { date: string }>): DailyBaselineSlice[] {
  return values.map(v => ({
    reportDate: v.date,
    passRatePct: v.passRatePct ?? 95,
    workOrdersCreatedToday: v.workOrdersCreatedToday ?? 2,
    sickCalloutsToday: v.sickCalloutsToday ?? 0,
  }));
}

function makeReport(overrides: Partial<{
  passRatePct: number; inspectionsCompleted: number; topFailureReasons: Array<{ reason: string; count: number }>;
  sickCalloutsToday: number; workOrdersCreatedToday: number;
}> = {}): DailyReportPayload {
  return {
    propertyId: 'p1',
    propertyName: 'Test Property',
    reportDate: '2026-05-23',
    timezone: 'America/Chicago',
    operations: {
      roomsCleanedToday: 18, totalRoomsOnBoard: 22,
      roomsOOO: 1, roomsOOS: 0,
      occupancyPct: 75,
      avgMinutesPerDeparture: 32, avgMinutesPerStayover: 18, avgMinutesPerDeepClean: 95,
      roomsPerHousekeeper: 6,
    },
    quality: {
      inspectionsCompleted: overrides.inspectionsCompleted ?? 10,
      inspectionsPassed: 9,
      passRatePct: overrides.passRatePct ?? 90,
      reclearRequestedCount: 1, reclearRatePct: 10,
      topFailureReasons: overrides.topFailureReasons ?? [],
    },
    labor: {
      totalHoursWorked: 24, totalOvertimeHours: 0,
      costPerOccupiedRoomCents: 1200, laborCostCents: 30000,
      laborBudgetCents: 50000,
      sickCalloutsToday: overrides.sickCalloutsToday ?? 0,
    },
    issues: {
      workOrdersCreatedToday: overrides.workOrdersCreatedToday ?? 2,
      urgentItemsStillPending: 0,
    },
    tomorrow: {
      arrivals: 12, departures: 10, projectedRoomsToClean: 14,
      recommendedHeadcount: 3, recommendedLaborCostCents: 24000,
      roomsPendingOOO: 1, roomsPendingInspection: 0,
    },
    anomalies: [],
    dashboardUrl: 'https://getstaxis.com/housekeeping',
  };
}

describe('detectAnomalies — speed_outlier', () => {
  test('fires when a housekeeper does >2x the team median AND >4 rooms', () => {
    const today = makeReport();
    const anomalies = detectAnomalies({
      today,
      baseline: [],
      perStaffRoomsToday: [
        { staffId: 'maria', name: 'Maria', rooms: 12 },
        { staffId: 'rosa',  name: 'Rosa',  rooms: 4 },
        { staffId: 'paula', name: 'Paula', rooms: 5 },
      ],
    });
    const speed = anomalies.find(a => a.kind === 'speed_outlier');
    assert.ok(speed, 'expected speed_outlier anomaly');
    assert.match(speed!.message, /Maria.*12 rooms/);
  });

  test('does NOT fire when the absolute count is too small', () => {
    const today = makeReport();
    const anomalies = detectAnomalies({
      today, baseline: [],
      perStaffRoomsToday: [
        { staffId: 'maria', name: 'Maria', rooms: 4 },
        { staffId: 'rosa',  name: 'Rosa',  rooms: 2 },
      ],
    });
    assert.equal(anomalies.find(a => a.kind === 'speed_outlier'), undefined);
  });
});

describe('detectAnomalies — pass_rate_drop', () => {
  test('fires when today is 15+ points below the rolling average', () => {
    const today = makeReport({ passRatePct: 75, inspectionsCompleted: 12, topFailureReasons: [{ reason: 'Mirror smudges', count: 3 }] });
    const baseline = makeBaseline([
      { date: '2026-05-16', passRatePct: 95 },
      { date: '2026-05-17', passRatePct: 92 },
      { date: '2026-05-18', passRatePct: 93 },
      { date: '2026-05-19', passRatePct: 94 },
    ]);
    const anomalies = detectAnomalies({ today, baseline, perStaffRoomsToday: [] });
    const drop = anomalies.find(a => a.kind === 'pass_rate_drop');
    assert.ok(drop, 'expected pass_rate_drop anomaly');
    assert.match(drop!.message, /pass rate dropped/);
    assert.match(drop!.message, /Mirror smudges/);
  });

  test('does NOT fire when fewer than 3 valid baseline points', () => {
    const today = makeReport({ passRatePct: 60, inspectionsCompleted: 5 });
    const baseline = makeBaseline([
      { date: '2026-05-22', passRatePct: 95 },
      { date: '2026-05-21', passRatePct: 92 },
    ]);
    const anomalies = detectAnomalies({ today, baseline, perStaffRoomsToday: [] });
    assert.equal(anomalies.find(a => a.kind === 'pass_rate_drop'), undefined);
  });

  test('does NOT fire when today has fewer than 3 inspections (small sample)', () => {
    const today = makeReport({ passRatePct: 40, inspectionsCompleted: 2 });
    const baseline = makeBaseline([
      { date: '2026-05-22', passRatePct: 95 },
      { date: '2026-05-21', passRatePct: 95 },
      { date: '2026-05-20', passRatePct: 95 },
    ]);
    const anomalies = detectAnomalies({ today, baseline, perStaffRoomsToday: [] });
    assert.equal(anomalies.find(a => a.kind === 'pass_rate_drop'), undefined);
  });
});

describe('detectAnomalies — callout_spike', () => {
  test('fires at 3 callouts', () => {
    const today = makeReport({ sickCalloutsToday: 3 });
    const anomalies = detectAnomalies({ today, baseline: [], perStaffRoomsToday: [] });
    assert.ok(anomalies.find(a => a.kind === 'callout_spike'));
  });

  test('does not fire at 2 callouts', () => {
    const today = makeReport({ sickCalloutsToday: 2 });
    const anomalies = detectAnomalies({ today, baseline: [], perStaffRoomsToday: [] });
    assert.equal(anomalies.find(a => a.kind === 'callout_spike'), undefined);
  });
});

describe('detectAnomalies — work_order_spike', () => {
  test('fires only when both ratio AND absolute threshold are crossed', () => {
    const today = makeReport({ workOrdersCreatedToday: 8 });
    const baseline = makeBaseline([
      { date: '2026-05-22', workOrdersCreatedToday: 2 },
      { date: '2026-05-21', workOrdersCreatedToday: 3 },
      { date: '2026-05-20', workOrdersCreatedToday: 1 },
    ]);
    const anomalies = detectAnomalies({ today, baseline, perStaffRoomsToday: [] });
    assert.ok(anomalies.find(a => a.kind === 'work_order_spike'));
  });

  test('does NOT fire when ratio is high but absolute is low (avg=1, today=3)', () => {
    const today = makeReport({ workOrdersCreatedToday: 3 });
    const baseline = makeBaseline([
      { date: '2026-05-22', workOrdersCreatedToday: 1 },
      { date: '2026-05-21', workOrdersCreatedToday: 1 },
      { date: '2026-05-20', workOrdersCreatedToday: 1 },
    ]);
    const anomalies = detectAnomalies({ today, baseline, perStaffRoomsToday: [] });
    assert.equal(anomalies.find(a => a.kind === 'work_order_spike'), undefined);
  });
});

describe('detectAnomalies — silence path', () => {
  test('quiet day produces no anomalies', () => {
    const today = makeReport();
    const baseline = makeBaseline([
      { date: '2026-05-22', passRatePct: 92, workOrdersCreatedToday: 2 },
      { date: '2026-05-21', passRatePct: 91, workOrdersCreatedToday: 2 },
      { date: '2026-05-20', passRatePct: 93, workOrdersCreatedToday: 3 },
    ]);
    const anomalies = detectAnomalies({
      today, baseline,
      perStaffRoomsToday: [
        { staffId: 'maria', name: 'Maria', rooms: 6 },
        { staffId: 'rosa',  name: 'Rosa',  rooms: 6 },
        { staffId: 'paula', name: 'Paula', rooms: 6 },
      ],
    });
    assert.equal(anomalies.length, 0);
  });
});
