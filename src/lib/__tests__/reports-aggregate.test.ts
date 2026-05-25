/**
 * Behavior tests for the pure report aggregators in src/lib/reports/aggregate.ts.
 *
 * Per Phase L discipline rule #2: seed inputs and assert outputs.
 * No source-grep, no DB I/O — these functions are deliberately pure.
 *
 * What this file covers:
 *   - Rooms cleaned today is the count of completed-status tasks
 *   - Average minutes per cleaning type uses started→completed deltas,
 *     skips null/negative durations, clamps absurdly long ones
 *   - Quality block computes pass rate, top-3 failure reasons by count
 *   - Labor block sums per-staff minutes and applies the 1.5x OT
 *     multiplier above 8h on a single day
 *   - Issues block filters work_orders by reportDate in TZ-local time
 *
 * The exact daily-report-builder I/O wrapper is exercised by a
 * subsequent integration test against a real schema (manual run).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildIssuesBlock,
  buildLaborBlock,
  buildOperationsBlock,
  buildQualityBlock,
  isoDateInTz,
  rankStaffPerformance,
  type CleaningTaskRow,
  type HkAssignmentRow,
  type InHouseSnapshot,
  type InspectionRow,
  type StaffRow,
  type CalloutRow,
  type WorkOrderRow,
} from '@/lib/reports/aggregate';

const PROPERTY_TZ = 'America/Chicago';
const REPORT_DATE = '2026-05-23';

function task(overrides: Partial<CleaningTaskRow>): CleaningTaskRow {
  return {
    id: overrides.id ?? `t_${Math.random().toString(36).slice(2)}`,
    cleaning_type: 'departure',
    status: 'completed',
    started_at: '2026-05-23T15:00:00Z',
    completed_at: '2026-05-23T15:30:00Z',
    assignee_id: 'staff_a',
    requires_inspection: false,
    ...overrides,
  };
}

describe('buildOperationsBlock', () => {
  test('counts completed tasks across all "done" statuses', () => {
    const tasks: CleaningTaskRow[] = [
      task({ status: 'completed' }),
      task({ status: 'inspected_pass' }),
      task({ status: 'check_complete' }),
      task({ status: 'correction_complete' }),
      task({ status: 'in_progress' }),  // NOT counted
      task({ status: 'scheduled' }),    // NOT counted
    ];
    const block = buildOperationsBlock({
      tasks, assignments: [], inHouse: null, workOrders: [],
      totalRoomsOnProperty: 50,
    });
    assert.equal(block.roomsCleanedToday, 4);
    assert.equal(block.totalRoomsOnBoard, 6);
  });

  test('per-cleaning-type averages bucket cleaning_type correctly', () => {
    const tasks: CleaningTaskRow[] = [
      task({ cleaning_type: 'departure',       started_at: '2026-05-23T10:00:00Z', completed_at: '2026-05-23T10:30:00Z' }),
      task({ cleaning_type: 'departure',       started_at: '2026-05-23T11:00:00Z', completed_at: '2026-05-23T11:45:00Z' }),
      task({ cleaning_type: 'departure_deep',  started_at: '2026-05-23T12:00:00Z', completed_at: '2026-05-23T13:00:00Z' }),
      task({ cleaning_type: 'stayover',        started_at: '2026-05-23T14:00:00Z', completed_at: '2026-05-23T14:20:00Z' }),
      task({ cleaning_type: 'deep',            started_at: '2026-05-23T15:00:00Z', completed_at: '2026-05-23T17:30:00Z' }),
    ];
    const block = buildOperationsBlock({
      tasks, assignments: [], inHouse: null, workOrders: [],
      totalRoomsOnProperty: 50,
    });
    // departure: 30 + 45 + 60 = 135 / 3 = 45
    assert.equal(block.avgMinutesPerDeparture, 45);
    assert.equal(block.avgMinutesPerStayover, 20);
    assert.equal(block.avgMinutesPerDeepClean, 150);
  });

  test('skips negative durations and clamps over-12h outliers', () => {
    const tasks: CleaningTaskRow[] = [
      task({ cleaning_type: 'stayover', started_at: '2026-05-23T15:00:00Z', completed_at: '2026-05-23T15:30:00Z' }),  // 30
      task({ cleaning_type: 'stayover', started_at: '2026-05-23T16:00:00Z', completed_at: '2026-05-23T15:30:00Z' }),  // negative → drop
      task({ cleaning_type: 'stayover', started_at: '2026-05-23T00:00:00Z', completed_at: '2026-05-23T18:00:00Z' }),  // 18h → drop
      task({ cleaning_type: 'stayover', started_at: null,                    completed_at: '2026-05-23T15:30:00Z' }),  // null → drop
    ];
    const block = buildOperationsBlock({
      tasks, assignments: [], inHouse: null, workOrders: [],
      totalRoomsOnProperty: 50,
    });
    assert.equal(block.avgMinutesPerStayover, 30);
  });

  test('rooms-per-housekeeper uses active assignments when available', () => {
    const tasks = [task({ id: 't1' }), task({ id: 't2' }), task({ id: 't3' }), task({ id: 't4' })];
    const assignments: HkAssignmentRow[] = [
      { housekeeper_id: 'maria', cleaning_task_id: 't1', is_active: true },
      { housekeeper_id: 'maria', cleaning_task_id: 't2', is_active: true },
      { housekeeper_id: 'rosa',  cleaning_task_id: 't3', is_active: true },
      { housekeeper_id: 'rosa',  cleaning_task_id: 't4', is_active: false }, // inactive — old assignment
    ];
    const block = buildOperationsBlock({
      tasks, assignments, inHouse: null, workOrders: [],
      totalRoomsOnProperty: 50,
    });
    // 4 completed / 2 active housekeepers = 2.0
    assert.equal(block.roomsPerHousekeeper, 2);
  });

  test('occupancy uses in_house snapshot when present, clamps to 100', () => {
    const inHouse: InHouseSnapshot = {
      total_occupied_rooms: 80,
      total_vacant_clean: 10,
      total_vacant_dirty: 5,
      total_ooo: 5,
      arrivals_remaining_today: 0,
      departures_remaining_today: 0,
      checked_in_today_count: 0,
      checked_out_today_count: 0,
    };
    const block = buildOperationsBlock({
      tasks: [], assignments: [], inHouse, workOrders: [],
      totalRoomsOnProperty: 100,
    });
    assert.equal(block.occupancyPct, 80);
    // Clamping: occupied > total shouldn't return >100.
    const clamped = buildOperationsBlock({
      tasks: [], assignments: [], inHouse: { ...inHouse, total_occupied_rooms: 150 },
      workOrders: [], totalRoomsOnProperty: 100,
    });
    assert.equal(clamped.occupancyPct, 100);
  });
});

describe('buildQualityBlock', () => {
  test('pass rate excludes in-progress and cancelled inspections', () => {
    const inspections: InspectionRow[] = [
      { id: 'i1', result: 'pass',        failed_items: [], housekeeper_staff_id: null, completed_at: '2026-05-23T16:00:00Z' },
      { id: 'i2', result: 'pass',        failed_items: [], housekeeper_staff_id: null, completed_at: '2026-05-23T16:30:00Z' },
      { id: 'i3', result: 'fail',        failed_items: [{ label: 'Mirror smudges' }], housekeeper_staff_id: null, completed_at: '2026-05-23T17:00:00Z' },
      { id: 'i4', result: 'in_progress', failed_items: [], housekeeper_staff_id: null, completed_at: null },
      { id: 'i5', result: 'cancelled',   failed_items: [], housekeeper_staff_id: null, completed_at: null },
    ];
    const ql = buildQualityBlock(inspections);
    assert.equal(ql.inspectionsCompleted, 3);
    assert.equal(ql.inspectionsPassed, 2);
    assert.equal(ql.passRatePct, 66.7);
    assert.equal(ql.reclearRequestedCount, 1);
    assert.equal(ql.reclearRatePct, 33.3);
  });

  test('top 3 failure reasons sorted by count', () => {
    const failures = ['Mirror smudges', 'Mirror smudges', 'Mirror smudges',
                      'Towels low', 'Towels low',
                      'Bedspread wrinkled',
                      'Dust bunny', 'Dust bunny'];
    const inspections: InspectionRow[] = failures.map((label, i) => ({
      id: `i${i}`,
      result: 'fail',
      failed_items: [{ label }],
      housekeeper_staff_id: null,
      completed_at: '2026-05-23T16:00:00Z',
    }));
    const ql = buildQualityBlock(inspections);
    assert.deepEqual(ql.topFailureReasons.map(r => r.reason), ['Mirror smudges', 'Towels low', 'Dust bunny']);
    assert.deepEqual(ql.topFailureReasons.map(r => r.count), [3, 2, 2]);
  });

  test('empty input returns zero pass rate', () => {
    const ql = buildQualityBlock([]);
    assert.equal(ql.inspectionsCompleted, 0);
    assert.equal(ql.passRatePct, 0);
    assert.deepEqual(ql.topFailureReasons, []);
  });
});

describe('buildLaborBlock', () => {
  test('sums per-staff minutes and converts to hours', () => {
    const tasks: CleaningTaskRow[] = [
      task({ assignee_id: 'maria', started_at: '2026-05-23T08:00:00Z', completed_at: '2026-05-23T08:30:00Z' }),
      task({ assignee_id: 'maria', started_at: '2026-05-23T09:00:00Z', completed_at: '2026-05-23T09:45:00Z' }),
      task({ assignee_id: 'rosa',  started_at: '2026-05-23T10:00:00Z', completed_at: '2026-05-23T11:00:00Z' }),
    ];
    const staff: StaffRow[] = [
      { id: 'maria', name: 'Maria',  hourly_wage: 18 },
      { id: 'rosa',  name: 'Rosa',   hourly_wage: 20 },
    ];
    const lb = buildLaborBlock({
      tasks, staff, inHouse: { total_occupied_rooms: 30 } as InHouseSnapshot,
      callouts: [], weeklyBudgetCents: 700_00,  // $100/day budget
    });
    // 30 + 45 + 60 = 135 min = 2.25h
    assert.equal(lb.totalHoursWorked, 2.3);
    assert.equal(lb.totalOvertimeHours, 0);
    // (1.25 * 18) + (1 * 20) = 22.5 + 20 = 42.5  → 4250 cents
    assert.equal(lb.laborCostCents, 42_50);
    assert.equal(lb.sickCalloutsToday, 0);
    assert.equal(lb.laborBudgetCents, 100_00);  // 1/7 of 700
    assert.equal(lb.costPerOccupiedRoomCents, Math.round(42_50 / 30));
  });

  test('OT kicks in past 8h on a single day at 1.5x wage', () => {
    const tasks: CleaningTaskRow[] = [
      task({ assignee_id: 'maria', started_at: '2026-05-23T08:00:00Z', completed_at: '2026-05-23T16:00:00Z' }),  // 8h regular
      task({ assignee_id: 'maria', started_at: '2026-05-23T16:00:00Z', completed_at: '2026-05-23T18:00:00Z' }),  // 2h OT
    ];
    const staff: StaffRow[] = [{ id: 'maria', name: 'Maria', hourly_wage: 20 }];
    const lb = buildLaborBlock({
      tasks, staff, inHouse: null, callouts: [], weeklyBudgetCents: null,
    });
    assert.equal(lb.totalHoursWorked, 10);
    assert.equal(lb.totalOvertimeHours, 2);
    // 8h * $20 + 2h * $20 * 1.5 = 160 + 60 = 220 → 22000 cents
    assert.equal(lb.laborCostCents, 220_00);
  });

  test('callouts count is just the length of the input', () => {
    const callouts: CalloutRow[] = [
      { business_date: REPORT_DATE, reason: 'sick' },
      { business_date: REPORT_DATE, reason: 'family' },
    ];
    const lb = buildLaborBlock({
      tasks: [], staff: [], inHouse: null, callouts, weeklyBudgetCents: null,
    });
    assert.equal(lb.sickCalloutsToday, 2);
  });
});

describe('buildIssuesBlock', () => {
  test('counts work orders reported today in the property timezone', () => {
    const workOrders: WorkOrderRow[] = [
      { id: 'w1', status: 'open',        priority: 'urgent', out_of_order: false,
        reported_at: '2026-05-24T01:30:00Z' },  // 2026-05-23 in Chicago (UTC-5 DST)
      { id: 'w2', status: 'closed',      priority: 'low',    out_of_order: false,
        reported_at: '2026-05-22T18:00:00Z' },  // 2026-05-22 — not today
      { id: 'w3', status: 'in_progress', priority: 'high',   out_of_order: false,
        reported_at: '2026-05-23T19:00:00Z' },
    ];
    const block = buildIssuesBlock({ workOrders, reportDate: REPORT_DATE, timezone: PROPERTY_TZ });
    assert.equal(block.workOrdersCreatedToday, 2);  // w1 + w3
    assert.equal(block.urgentItemsStillPending, 2); // w1 + w3 (urgent OR high, open/in_progress)
  });
});

describe('isoDateInTz', () => {
  test('converts UTC midnight to property-local date', () => {
    // 2026-05-23 23:00 UTC = 2026-05-23 18:00 Chicago (DST CDT = UTC-5)
    assert.equal(isoDateInTz('2026-05-23T23:00:00Z', 'America/Chicago'), '2026-05-23');
    // 2026-05-24 04:00 UTC = 2026-05-23 23:00 Chicago — STILL the 23rd locally
    assert.equal(isoDateInTz('2026-05-24T04:00:00Z', 'America/Chicago'), '2026-05-23');
    // 2026-05-24 06:00 UTC = 2026-05-24 01:00 Chicago — now the 24th
    assert.equal(isoDateInTz('2026-05-24T06:00:00Z', 'America/Chicago'), '2026-05-24');
  });
});

describe('rankStaffPerformance', () => {
  test('ranks by rooms cleaned with pass rate when housekeeper had inspections', () => {
    const tasks: CleaningTaskRow[] = [
      task({ id: 't1', assignee_id: 'maria', status: 'completed' }),
      task({ id: 't2', assignee_id: 'maria', status: 'completed' }),
      task({ id: 't3', assignee_id: 'maria', status: 'inspected_pass' }),
      task({ id: 't4', assignee_id: 'rosa',  status: 'completed' }),
    ];
    const inspections: InspectionRow[] = [
      { id: 'i1', result: 'pass', failed_items: [], housekeeper_staff_id: 'maria', completed_at: null },
      { id: 'i2', result: 'fail', failed_items: [{ label: 'x' }], housekeeper_staff_id: 'maria', completed_at: null },
      { id: 'i3', result: 'pass', failed_items: [], housekeeper_staff_id: 'rosa',  completed_at: null },
    ];
    const staff: StaffRow[] = [
      { id: 'maria', name: 'Maria', hourly_wage: 18 },
      { id: 'rosa',  name: 'Rosa',  hourly_wage: 20 },
    ];
    const ranked = rankStaffPerformance({ tasks, inspections, staff });
    const maria = ranked.find(r => r.staffId === 'maria')!;
    const rosa  = ranked.find(r => r.staffId === 'rosa')!;
    assert.equal(maria.roomsCleaned, 3);
    assert.equal(maria.inspectionPassRatePct, 50);
    assert.equal(rosa.roomsCleaned, 1);
    assert.equal(rosa.inspectionPassRatePct, 100);
  });

  test('staff with no inspections has null pass rate', () => {
    const tasks: CleaningTaskRow[] = [task({ assignee_id: 'maria' })];
    const ranked = rankStaffPerformance({
      tasks, inspections: [], staff: [{ id: 'maria', name: 'Maria', hourly_wage: null }],
    });
    assert.equal(ranked[0].inspectionPassRatePct, null);
  });
});
