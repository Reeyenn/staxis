/**
 * Tests for the cost-tracking module.
 *
 * Covers the three pure layers:
 *   • calculateTaskCost — single-task math (wages, pauses, lunch, live)
 *   • aggregateDayCost  — day-level rollup (per-staff, by-type, lunch
 *                          distribution, mixed-wage handling)
 *   • projectFromRows   — end-of-day projection (assigned vs. avg wage,
 *                          basedOnHistoricalPace flag)
 *
 * No DB access — the DB-aware wrappers (calculatePropertyDayCost,
 * projectEndOfDayCost) are thin I/O shims over these.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeMinutes,
  calculateTaskCost,
} from '@/lib/cost-tracking/calculate-task-cost';
import { aggregateDayCost } from '@/lib/cost-tracking/calculate-day-cost';
import { projectFromRows } from '@/lib/cost-tracking/project-end-of-day';

// ── Helpers ─────────────────────────────────────────────────────────────

const T0 = '2026-05-26T14:00:00.000Z';
const T1H = '2026-05-26T15:00:00.000Z';   // T0 + 1 hour
const T30M = '2026-05-26T14:30:00.000Z';  // T0 + 30 min
const T15M = '2026-05-26T14:15:00.000Z';
const T45M = '2026-05-26T14:45:00.000Z';
const NOW = new Date('2026-05-26T16:00:00.000Z');

function task(overrides: Record<string, unknown>) {
  return {
    id: 'task-' + Math.random().toString(36).slice(2, 8),
    cleaning_type: 'departure',
    status: 'completed',
    started_at: T0,
    completed_at: T1H,
    estimated_minutes: 30,
    assignee_id: 'staff-1',
    room_number: '101',
    ...overrides,
  };
}

function staff(id: string, name: string, wageCents: number | null) {
  return {
    id, name,
    hourly_wage_cents: wageCents,
    hourly_wage: null,
  };
}

// ── activeMinutes ───────────────────────────────────────────────────────

describe('activeMinutes', () => {
  test('null startedAt → 0 minutes', () => {
    const r = activeMinutes({ startedAt: null, completedAt: T1H });
    assert.equal(r.minutes, 0);
  });

  test('completed in 1 hour with no pauses → 60 minutes', () => {
    const r = activeMinutes({ startedAt: T0, completedAt: T1H });
    assert.equal(r.minutes, 60);
  });

  test('reversed timestamps clamp to 0 (defensive)', () => {
    const r = activeMinutes({ startedAt: T1H, completedAt: T0 });
    assert.equal(r.minutes, 0);
  });

  test('in-progress task uses now', () => {
    const r = activeMinutes({ startedAt: T0, completedAt: null, now: NOW });
    // T0 → 16:00Z = 120 minutes
    assert.equal(r.minutes, 120);
  });

  test('single pause interval subtracted', () => {
    const r = activeMinutes({
      startedAt: T0,
      completedAt: T1H,
      pauseEvents: [{ pausedAt: T15M, resumedAt: T30M }],   // 15 min pause
    });
    assert.equal(r.minutes, 45);
  });

  test('multiple pauses summed', () => {
    const r = activeMinutes({
      startedAt: T0,
      completedAt: T1H,
      pauseEvents: [
        { pausedAt: T15M, resumedAt: '2026-05-26T14:20:00.000Z' },   // 5 min
        { pausedAt: T30M, resumedAt: T45M },                          // 15 min
      ],
    });
    assert.equal(r.minutes, 40);
  });

  test('pause that overlaps task start clips to task window', () => {
    const r = activeMinutes({
      startedAt: T0,
      completedAt: T1H,
      pauseEvents: [{
        pausedAt: '2026-05-26T13:30:00.000Z',   // 30 min before task
        resumedAt: T15M,                        // 15 min into task
      }],
    });
    // Only 15 min of pause overlap counts.
    assert.equal(r.minutes, 45);
  });

  test('ongoing pause on a live task counts up to now', () => {
    const r = activeMinutes({
      startedAt: T0,
      completedAt: null,
      pauseEvents: [{ pausedAt: T1H, resumedAt: null }],    // paused at 15:00Z
      now: NOW,                                              // now = 16:00Z
    });
    // 120 min gross − 60 min pause = 60 min active.
    assert.equal(r.minutes, 60);
  });

  test('ongoing pause on a completed task ignored (stale event)', () => {
    const r = activeMinutes({
      startedAt: T0,
      completedAt: T1H,
      pauseEvents: [{ pausedAt: T30M, resumedAt: null }],
    });
    // Stale pause skipped → 60 minutes gross.
    assert.equal(r.minutes, 60);
  });
});

// ── calculateTaskCost ───────────────────────────────────────────────────

describe('calculateTaskCost', () => {
  test('1 hour at $15/hr = 1500 cents', () => {
    const r = calculateTaskCost({
      startedAt: T0, completedAt: T1H,
      hourlyWageCents: 1500,
    });
    assert.equal(r.cents, 1500);
    assert.equal(r.wageKnown, true);
    assert.equal(r.isLive, false);
  });

  test('null wage → cents=0, wageKnown=false (UI shows "—")', () => {
    const r = calculateTaskCost({
      startedAt: T0, completedAt: T1H,
      hourlyWageCents: null,
    });
    assert.equal(r.cents, 0);
    assert.equal(r.wageKnown, false);
    assert.equal(r.billableMinutes, 60);
  });

  test('zero wage explicit → cents=0, wageKnown=true', () => {
    const r = calculateTaskCost({
      startedAt: T0, completedAt: T1H,
      hourlyWageCents: 0,
    });
    assert.equal(r.cents, 0);
    assert.equal(r.wageKnown, true);
  });

  test('in-progress task at $14.50/hr produces live cost', () => {
    const r = calculateTaskCost({
      startedAt: T0,
      completedAt: null,
      hourlyWageCents: 1450,
      now: NOW,    // 120 min after T0
    });
    // 120 min × $14.50 / 60 = $29.00
    assert.equal(r.cents, 2900);
    assert.equal(r.isLive, true);
  });

  test('pauses subtracted before wage applied', () => {
    const r = calculateTaskCost({
      startedAt: T0, completedAt: T1H,    // 60 min gross
      hourlyWageCents: 1500,
      pauseEvents: [{ pausedAt: T15M, resumedAt: T30M }],    // 15 min pause
    });
    // 45 min × $15/hr = $11.25
    assert.equal(r.cents, 1125);
  });

  test('lunch break subtracted regardless of overlap', () => {
    const r = calculateTaskCost({
      startedAt: T0, completedAt: T1H,
      hourlyWageCents: 1500,
      lunchBreakMinutes: 30,
    });
    // (60 − 30) × $15/hr = $7.50
    assert.equal(r.cents, 750);
  });

  test('lunch larger than active minutes floors at 0 cents (no negative pay)', () => {
    const r = calculateTaskCost({
      startedAt: T0, completedAt: T30M,    // 30 min task
      hourlyWageCents: 1500,
      lunchBreakMinutes: 45,                // longer than the task
    });
    assert.equal(r.cents, 0);
    assert.equal(r.billableMinutes, 0);
  });

  test('rounding stays at whole cents (no half-cent drift)', () => {
    // 12.5 min at $15/hr = 312.5 cents → rounds to 313.
    const r = calculateTaskCost({
      startedAt: T0,
      completedAt: '2026-05-26T14:12:30.000Z',    // 12.5 min
      hourlyWageCents: 1500,
    });
    assert.equal(r.cents, 313);
  });
});

// ── aggregateDayCost ────────────────────────────────────────────────────

describe('aggregateDayCost', () => {
  test('two housekeepers, two tasks each, all wages set', () => {
    const tasks = [
      task({ id: 'A1', assignee_id: 'maria', cleaning_type: 'departure', started_at: T0, completed_at: T1H }),
      task({ id: 'A2', assignee_id: 'maria', cleaning_type: 'stayover',  started_at: T0, completed_at: T30M }),
      task({ id: 'B1', assignee_id: 'jose',  cleaning_type: 'departure', started_at: T0, completed_at: T1H }),
      task({ id: 'B2', assignee_id: 'jose',  cleaning_type: 'departure', started_at: T0, completed_at: T1H }),
    ];
    const result = aggregateDayCost({
      tasks,
      staff: [staff('maria', 'Maria', 1500), staff('jose', 'Jose', 1600)],
      pauseEvents: [],
      lunchBreaks: [],
    });
    // Maria: 60+30 min × $15 = $22.50
    // Jose:  60+60 min × $16 = $32.00
    assert.equal(result.totalCents, 2250 + 3200);
    const maria = result.perHousekeeper.find(p => p.staffId === 'maria')!;
    const jose = result.perHousekeeper.find(p => p.staffId === 'jose')!;
    assert.equal(maria.cents, 2250);
    assert.equal(jose.cents, 3200);
    // byCleaningType sums across staff.
    assert.equal(result.byCleaningType.departure, 1500 + 1600 + 1600);
    assert.equal(result.byCleaningType.stayover, 750);
    assert.equal(result.anyWageUnknown, false);
    // perHousekeeper sorted by cents desc.
    assert.equal(result.perHousekeeper[0].staffId, 'jose');
  });

  test('mixed wages — anyWageUnknown flips when one staff has no wage', () => {
    const tasks = [
      task({ id: 'A1', assignee_id: 'maria', started_at: T0, completed_at: T1H }),
      task({ id: 'B1', assignee_id: 'jose',  started_at: T0, completed_at: T1H }),
    ];
    const result = aggregateDayCost({
      tasks,
      staff: [
        staff('maria', 'Maria', 1500),
        staff('jose', 'Jose', null),     // wage not set
      ],
      pauseEvents: [],
      lunchBreaks: [],
    });
    assert.equal(result.anyWageUnknown, true);
    const jose = result.perHousekeeper.find(p => p.staffId === 'jose')!;
    assert.equal(jose.cents, 0);
    assert.equal(jose.wageUnknown, true);
    assert.equal(result.totalCents, 1500);    // Maria only
  });

  test('lunch break distributed proportionally across same-staff tasks', () => {
    const tasks = [
      // Two 60-min tasks for maria
      task({ id: 'A1', assignee_id: 'maria', cleaning_type: 'departure', started_at: T0, completed_at: T1H }),
      task({ id: 'A2', assignee_id: 'maria', cleaning_type: 'stayover',  started_at: T0, completed_at: T1H }),
    ];
    const result = aggregateDayCost({
      tasks,
      staff: [staff('maria', 'Maria', 1500)],
      pauseEvents: [],
      lunchBreaks: [{ staff_id: 'maria', started_at: T0, ended_at: T30M }],  // 30 min lunch
    });
    // Gross: 120 min × $15 = $30.00
    // Lunch: 30 min × $15 = $7.50
    // Net day total: $22.50
    assert.equal(result.totalCents, 2250);
    // byCleaningType split: each task got 50% of lunch cents (3.75 → 375 each... wait, 375 cents is $3.75)
    // Actually: lunch_cents = 750, each task absorbs 50% = 375 cents
    // each task gross = 1500 cents, net = 1500 − 375 = 1125 cents
    assert.equal(result.byCleaningType.departure, 1125);
    assert.equal(result.byCleaningType.stayover, 1125);
  });

  test('open (un-ended) lunch break not deducted', () => {
    const tasks = [task({ id: 'A1', assignee_id: 'maria', started_at: T0, completed_at: T1H })];
    const result = aggregateDayCost({
      tasks,
      staff: [staff('maria', 'Maria', 1500)],
      pauseEvents: [],
      lunchBreaks: [{ staff_id: 'maria', started_at: T0, ended_at: null }],
    });
    assert.equal(result.totalCents, 1500);    // No lunch deduction
  });

  test('task without assignee skipped (no one to bill)', () => {
    const tasks = [
      task({ id: 'A1', assignee_id: null, started_at: T0, completed_at: T1H }),
      task({ id: 'A2', assignee_id: 'maria', started_at: T0, completed_at: T1H }),
    ];
    const result = aggregateDayCost({
      tasks,
      staff: [staff('maria', 'Maria', 1500)],
      pauseEvents: [],
      lunchBreaks: [],
    });
    assert.equal(result.totalCents, 1500);
    assert.equal(result.perHousekeeper.length, 1);
  });

  test('task in superseded/cancelled status skipped', () => {
    const tasks = [
      task({ id: 'A1', assignee_id: 'maria', status: 'superseded', started_at: T0, completed_at: T1H }),
      task({ id: 'A2', assignee_id: 'maria', status: 'cancelled',  started_at: T0, completed_at: T1H }),
      task({ id: 'A3', assignee_id: 'maria', status: 'completed',  started_at: T0, completed_at: T1H }),
    ];
    const result = aggregateDayCost({
      tasks,
      staff: [staff('maria', 'Maria', 1500)],
      pauseEvents: [],
      lunchBreaks: [],
    });
    assert.equal(result.totalCents, 1500);    // Only the completed task
  });

  test('pause attributed by overlap with task window (staff-wide fallback)', () => {
    const tasks = [
      // Maria: 60-min task with a 15-min pause inside it.
      task({ id: 'A1', assignee_id: 'maria', started_at: T0, completed_at: T1H, room_number: '101' }),
    ];
    const result = aggregateDayCost({
      tasks,
      staff: [staff('maria', 'Maria', 1500)],
      pauseEvents: [
        // room_number=null → falls back to staff-wide attribution.
        { staff_id: 'maria', room_number: null, paused_at: T15M, resumed_at: T30M },
      ],
      lunchBreaks: [],
    });
    // 45 min × $15 = $11.25
    assert.equal(result.totalCents, 1125);
  });

  test('room-scoped pause subtracts only from matching room\'s task', () => {
    const tasks = [
      // Two parallel-ish tasks for one staff — Rm 101 has a pause, Rm 102 does not.
      task({ id: 'A1', assignee_id: 'maria', started_at: T0, completed_at: T1H, room_number: '101' }),
      task({ id: 'A2', assignee_id: 'maria', started_at: T0, completed_at: T1H, room_number: '102' }),
    ];
    const result = aggregateDayCost({
      tasks,
      staff: [staff('maria', 'Maria', 1500)],
      pauseEvents: [
        // 15-min pause attached to Rm 101 only — should NOT subtract
        // from Rm 102's billable.
        { staff_id: 'maria', room_number: '101', paused_at: T15M, resumed_at: T30M },
      ],
      lunchBreaks: [],
    });
    // Rm 101: 45 min × $15 = $11.25
    // Rm 102: 60 min × $15 = $15.00
    // Total: $26.25
    assert.equal(result.totalCents, 1125 + 1500);
  });

  test('legacy hourly_wage (dollar column) used when cents not set', () => {
    const tasks = [task({ id: 'A1', assignee_id: 'maria', started_at: T0, completed_at: T1H })];
    const result = aggregateDayCost({
      tasks,
      staff: [{
        id: 'maria', name: 'Maria',
        hourly_wage_cents: null,
        hourly_wage: 14.50,    // legacy column
      }],
      pauseEvents: [],
      lunchBreaks: [],
    });
    // 60 min × $14.50 = $14.50 → 1450 cents
    assert.equal(result.totalCents, 1450);
    assert.equal(result.anyWageUnknown, false);
  });
});

// ── projectFromRows ─────────────────────────────────────────────────────

describe('projectFromRows', () => {
  test('projects scheduled tasks with assigned wage', () => {
    const tasks = [
      task({ id: 'A1', assignee_id: 'maria', status: 'completed', started_at: T0, completed_at: T1H }),
      task({ id: 'A2', assignee_id: 'maria', status: 'scheduled', started_at: null, completed_at: null, estimated_minutes: 60 }),
    ];
    const staffRows = [staff('maria', 'Maria', 1500)];
    const dayCost = aggregateDayCost({ tasks, staff: staffRows, pauseEvents: [], lunchBreaks: [] });
    const proj = projectFromRows({ tasks, staff: staffRows, dayCost });
    assert.equal(proj.accruedCents, 1500);
    assert.equal(proj.remainingEstimateCents, 1500);   // 60 min × $15
    assert.equal(proj.projectedCents, 3000);
    assert.equal(proj.basedOnHistoricalPace, true);
  });

  test('unassigned scheduled task uses property avg wage', () => {
    const tasks = [
      task({ id: 'A1', assignee_id: 'maria', status: 'completed', started_at: T0, completed_at: T1H }),
      task({ id: 'A2', assignee_id: null,    status: 'ready_now', started_at: null, completed_at: null, estimated_minutes: 60 }),
    ];
    const staffRows = [
      staff('maria', 'Maria', 1500),
      staff('jose', 'Jose', 1700),
    ];
    const dayCost = aggregateDayCost({ tasks, staff: staffRows, pauseEvents: [], lunchBreaks: [] });
    const proj = projectFromRows({ tasks, staff: staffRows, dayCost });
    // avg wage = 1600, 60 min × 1600 / 60 = 1600 cents
    assert.equal(proj.remainingEstimateCents, 1600);
  });

  test('missing estimated_minutes falls back to 30', () => {
    const tasks = [
      task({ id: 'A1', assignee_id: 'maria', status: 'scheduled', started_at: null, completed_at: null, estimated_minutes: null }),
    ];
    const staffRows = [staff('maria', 'Maria', 1500)];
    const dayCost = aggregateDayCost({ tasks, staff: staffRows, pauseEvents: [], lunchBreaks: [] });
    const proj = projectFromRows({ tasks, staff: staffRows, dayCost });
    assert.equal(proj.remainingEstimateCents, 750);    // 30 min × $15/hr
  });

  test('no wages anywhere → basedOnHistoricalPace=false', () => {
    const tasks = [
      task({ id: 'A1', assignee_id: 'maria', status: 'scheduled', started_at: null, completed_at: null, estimated_minutes: 60 }),
    ];
    const staffRows = [staff('maria', 'Maria', null)];
    const dayCost = aggregateDayCost({ tasks, staff: staffRows, pauseEvents: [], lunchBreaks: [] });
    const proj = projectFromRows({ tasks, staff: staffRows, dayCost });
    assert.equal(proj.remainingEstimateCents, 0);
    assert.equal(proj.basedOnHistoricalPace, false);
  });
});
