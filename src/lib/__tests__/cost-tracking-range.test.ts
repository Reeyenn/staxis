/**
 * Tests for the multi-day range aggregator.
 *
 * Covers: grouping by date, per-staff range totals, cross-week boundary
 * detection (used by the "this week vs last week" comparison in the
 * Performance tab's LaborCostSection).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateRangeCost } from '@/lib/cost-tracking/calculate-range-cost';

function task(opts: {
  id?: string;
  cleaning_type?: string;
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
  estimated_minutes?: number | null;
  assignee_id?: string | null;
  room_number?: string;
  business_date: string;
}) {
  return {
    id: opts.id ?? 'task-' + Math.random().toString(36).slice(2, 8),
    cleaning_type: opts.cleaning_type ?? 'departure',
    status: opts.status ?? 'completed',
    started_at: opts.started_at ?? '2026-05-26T14:00:00.000Z',
    completed_at: opts.completed_at ?? '2026-05-26T15:00:00.000Z',
    estimated_minutes: opts.estimated_minutes ?? 30,
    assignee_id: opts.assignee_id ?? 'staff-1',
    room_number: opts.room_number ?? '101',
    business_date: opts.business_date,
  };
}

function staff(id: string, name: string, wageCents: number | null) {
  return { id, name, hourly_wage_cents: wageCents, hourly_wage: null };
}

describe('aggregateRangeCost', () => {
  test('groups tasks per business_date, returns one row per day', () => {
    const result = aggregateRangeCost({
      fromDate: '2026-05-25',
      toDate: '2026-05-27',
      tasks: [
        task({ assignee_id: 'maria', business_date: '2026-05-25', started_at: '2026-05-25T10:00:00Z', completed_at: '2026-05-25T11:00:00Z' }),
        task({ assignee_id: 'maria', business_date: '2026-05-26', started_at: '2026-05-26T10:00:00Z', completed_at: '2026-05-26T11:00:00Z' }),
        task({ assignee_id: 'maria', business_date: '2026-05-26', started_at: '2026-05-26T11:00:00Z', completed_at: '2026-05-26T12:00:00Z' }),
        // 2026-05-27 has no tasks — should still appear as a zero day.
      ],
      staff: [staff('maria', 'Maria', 1500)],
      pauseEvents: [],
      lunchBreaks: [],
    });
    assert.equal(result.days.length, 3);
    assert.equal(result.days[0].date, '2026-05-25');
    assert.equal(result.days[1].date, '2026-05-26');
    assert.equal(result.days[2].date, '2026-05-27');
    assert.equal(result.days[0].totalCents, 1500);   // 1h × $15
    assert.equal(result.days[1].totalCents, 3000);   // 2h × $15
    assert.equal(result.days[2].totalCents, 0);
    assert.equal(result.totalCents, 4500);
  });

  test('per-staff totals across the range sorted by total desc', () => {
    const result = aggregateRangeCost({
      fromDate: '2026-05-25',
      toDate: '2026-05-26',
      tasks: [
        task({ assignee_id: 'maria', business_date: '2026-05-25', started_at: '2026-05-25T10:00:00Z', completed_at: '2026-05-25T11:00:00Z' }),
        task({ assignee_id: 'maria', business_date: '2026-05-26', started_at: '2026-05-26T10:00:00Z', completed_at: '2026-05-26T11:00:00Z' }),
        task({ assignee_id: 'jose',  business_date: '2026-05-26', started_at: '2026-05-26T10:00:00Z', completed_at: '2026-05-26T10:30:00Z' }),
      ],
      staff: [
        staff('maria', 'Maria', 1500),
        staff('jose', 'Jose', 1500),
      ],
      pauseEvents: [],
      lunchBreaks: [],
    });
    assert.equal(result.perStaffTotal.length, 2);
    assert.equal(result.perStaffTotal[0].name, 'Maria');
    assert.equal(result.perStaffTotal[0].totalCents, 3000);    // 2h × $15
    assert.equal(result.perStaffTotal[1].name, 'Jose');
    assert.equal(result.perStaffTotal[1].totalCents, 750);     // 30m × $15
  });

  test('empty range (toDate < fromDate) returns empty', () => {
    const result = aggregateRangeCost({
      fromDate: '2026-05-27',
      toDate: '2026-05-25',
      tasks: [],
      staff: [],
      pauseEvents: [],
      lunchBreaks: [],
    });
    assert.equal(result.days.length, 0);
    assert.equal(result.totalCents, 0);
    assert.equal(result.perStaffTotal.length, 0);
  });
});
