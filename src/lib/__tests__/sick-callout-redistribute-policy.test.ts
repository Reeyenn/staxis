/**
 * Tests for the redistribute + revert policy decisions.
 *
 * Run via: npx tsx --test src/lib/__tests__/sick-callout-redistribute-policy.test.ts
 *
 * These are the pure functions that decide:
 *   - which tasks need new assignees
 *   - which housekeepers pick them up (naive balance until
 *     feature/hk-auto-assignment lands)
 *   - which tasks get returned on revert vs stay with the new assignee
 *   - when the redistribute should actually fire (now / in 15 min / after
 *     current room)
 *
 * The DB-touching code in service.ts wraps these functions, so getting
 * the policy right here pins down the user-facing behavior independent
 * of any Supabase mocking.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  planRedistribution,
  planRevert,
  buildImpactedAssignments,
  computeRedistributeAt,
} from '../sick-callout/redistribute-policy';
import type {
  RedistributableTask,
  RedistributionEligibleStaff,
  CurrentTaskState,
} from '../sick-callout/redistribute-policy';
import type { ImpactedAssignment } from '../sick-callout/types';

function task(
  id: string,
  room: string,
  status: string = 'scheduled',
  assignee: string | null = 'sick-staff',
  started_at: string | null = null,
): RedistributableTask {
  return { id, room_number: room, assignee_id: assignee, status, started_at };
}

// ───────────────────────────────────────────────────────────────────────
// REDISTRIBUTION
// ───────────────────────────────────────────────────────────────────────

describe('planRedistribution', () => {
  test('empty input → empty output', () => {
    const plan = planRedistribution([], []);
    assert.equal(plan.assignments.length, 0);
    assert.equal(plan.retained_with_sick.length, 0);
  });

  test('no eligible staff → tasks become unassigned', () => {
    const plan = planRedistribution([task('t1', '101'), task('t2', '102')], []);
    assert.equal(plan.assignments.length, 2);
    assert.equal(plan.assignments[0].new_assignee_id, null);
    assert.equal(plan.assignments[1].new_assignee_id, null);
  });

  test('round-robin to least-loaded HK', () => {
    const eligible: RedistributionEligibleStaff[] = [
      { id: 'a', current_load: 0 },
      { id: 'b', current_load: 0 },
      { id: 'c', current_load: 0 },
    ];
    const plan = planRedistribution(
      [task('t1', '101'), task('t2', '102'), task('t3', '103')],
      eligible,
    );
    // With a tie on load=0, smallest staff_id wins each pick after the
    // load bumps. Order: a (load 0→1), then b (load 0→1), then c.
    assert.equal(plan.assignments[0].new_assignee_id, 'a');
    assert.equal(plan.assignments[1].new_assignee_id, 'b');
    assert.equal(plan.assignments[2].new_assignee_id, 'c');
  });

  test('respects pre-existing load — heaviest does not get more', () => {
    const eligible: RedistributionEligibleStaff[] = [
      { id: 'busy', current_load: 10 },
      { id: 'free', current_load: 0 },
    ];
    const plan = planRedistribution([task('t1', '101'), task('t2', '102')], eligible);
    assert.equal(plan.assignments[0].new_assignee_id, 'free');
    assert.equal(plan.assignments[1].new_assignee_id, 'free');
  });

  test('started tasks stay with sick HK (retained, not reassigned)', () => {
    const tasks = [
      task('t1', '101', 'in_progress'),
      task('t2', '102', 'scheduled'),
      task('t3', '103', 'completed'),
      task('t4', '104', 'paused'),
    ];
    const eligible: RedistributionEligibleStaff[] = [{ id: 'a', current_load: 0 }];
    const plan = planRedistribution(tasks, eligible);

    const retainedRooms = plan.retained_with_sick.map((t) => t.room_number).sort();
    assert.deepEqual(retainedRooms, ['101', '103', '104']);

    const assignedRooms = plan.assignments.map((a) => a.task.room_number);
    assert.deepEqual(assignedRooms, ['102']);
    assert.equal(plan.assignments[0].new_assignee_id, 'a');
  });

  test('sort is by room number — handles non-numeric labels', () => {
    const eligible: RedistributionEligibleStaff[] = [{ id: 'a', current_load: 0 }];
    const plan = planRedistribution(
      [task('t1', '201'), task('t2', '101'), task('t3', '101A')],
      eligible,
    );
    const order = plan.assignments.map((a) => a.task.room_number);
    assert.deepEqual(order, ['101', '101A', '201']);
  });
});

// ───────────────────────────────────────────────────────────────────────
// REVERT
// ───────────────────────────────────────────────────────────────────────

function impacted(
  task_id: string,
  room: string,
  redistributed_to: string | null = 'new-hk',
  status_at_redistribute: string = 'scheduled',
): ImpactedAssignment {
  return {
    task_id,
    room_number: room,
    original_assignee_id: 'sick-staff',
    redistributed_to,
    task_status_at_redistribute: status_at_redistribute,
  };
}

function current(id: string, status: string, assignee: string | null): CurrentTaskState {
  return { id, status, assignee_id: assignee };
}

describe('planRevert', () => {
  test('untouched task → returned to original (apply=true)', () => {
    const impactedList = [impacted('t1', '101')];
    const cur = new Map([['t1', current('t1', 'scheduled', 'new-hk')]]);
    const decisions = planRevert(impactedList, cur);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].apply, true);
    assert.equal(decisions[0].new_assignee_id, 'sick-staff');
    assert.equal(decisions[0].outcome.returned_to_original, true);
    assert.equal(decisions[0].outcome.reason, 'returned');
  });

  test('in_progress task → stays with new assignee (apply=false)', () => {
    const impactedList = [impacted('t1', '101')];
    const cur = new Map([['t1', current('t1', 'in_progress', 'new-hk')]]);
    const decisions = planRevert(impactedList, cur);
    assert.equal(decisions[0].apply, false);
    assert.equal(decisions[0].outcome.returned_to_original, false);
    assert.equal(decisions[0].outcome.stayed_with, 'new-hk');
    assert.equal(decisions[0].outcome.reason, 'already_started');
  });

  test('completed task → credit stays with whoever finished (not reassigned)', () => {
    const impactedList = [impacted('t1', '101')];
    const cur = new Map([['t1', current('t1', 'completed', 'new-hk')]]);
    const decisions = planRevert(impactedList, cur);
    assert.equal(decisions[0].apply, false);
    assert.equal(decisions[0].outcome.returned_to_original, false);
    assert.equal(decisions[0].outcome.reason, 'task_completed');
  });

  test('missing task → recorded as task_missing, no apply', () => {
    const impactedList = [impacted('t1', '101')];
    const cur = new Map<string, CurrentTaskState>();
    const decisions = planRevert(impactedList, cur);
    assert.equal(decisions[0].apply, false);
    assert.equal(decisions[0].outcome.reason, 'task_missing');
  });

  test('mixed scenario — 7 of 8 return, 1 stays with Carlos (matches spec)', () => {
    // Spec example: "7 of 8 rooms returned to Maria. Carlos already
    // started 308 — that stays with him."
    const impactedList = [
      impacted('t1', '301', 'carlos'),
      impacted('t2', '302', 'carlos'),
      impacted('t3', '303', 'lupe'),
      impacted('t4', '304', 'lupe'),
      impacted('t5', '305', 'lupe'),
      impacted('t6', '306', 'ana'),
      impacted('t7', '307', 'ana'),
      impacted('t8', '308', 'carlos'),     // Carlos already started this
    ];
    const cur = new Map([
      ['t1', current('t1', 'scheduled', 'carlos')],
      ['t2', current('t2', 'scheduled', 'carlos')],
      ['t3', current('t3', 'scheduled', 'lupe')],
      ['t4', current('t4', 'scheduled', 'lupe')],
      ['t5', current('t5', 'scheduled', 'lupe')],
      ['t6', current('t6', 'scheduled', 'ana')],
      ['t7', current('t7', 'scheduled', 'ana')],
      ['t8', current('t8', 'in_progress', 'carlos')],  // ← started!
    ]);
    const decisions = planRevert(impactedList, cur);
    const returned = decisions.filter((d) => d.outcome.returned_to_original);
    const stayed = decisions.filter((d) => !d.outcome.returned_to_original);
    assert.equal(returned.length, 7);
    assert.equal(stayed.length, 1);
    assert.equal(stayed[0].task_id, 't8');
    assert.equal(stayed[0].outcome.stayed_with, 'carlos');
  });
});

// ───────────────────────────────────────────────────────────────────────
// SCHEDULING
// ───────────────────────────────────────────────────────────────────────

describe('computeRedistributeAt', () => {
  const NOW = new Date('2026-05-24T09:00:00.000Z');

  test('null timing → fires immediately', () => {
    const result = computeRedistributeAt(NOW, null);
    assert.equal(result.toISOString(), NOW.toISOString());
  });

  test('"now" → fires immediately', () => {
    const result = computeRedistributeAt(NOW, 'now');
    assert.equal(result.toISOString(), NOW.toISOString());
  });

  test('"in_15_min" → fires 15 minutes later', () => {
    const result = computeRedistributeAt(NOW, 'in_15_min');
    const expected = new Date(NOW.getTime() + 15 * 60_000);
    assert.equal(result.toISOString(), expected.toISOString());
  });

  test('"after_current_room" → sentinel far future (cron uses task-state check)', () => {
    const result = computeRedistributeAt(NOW, 'after_current_room');
    assert.ok(result.getTime() > NOW.getTime() + 60 * 60_000);
  });
});

// ───────────────────────────────────────────────────────────────────────
// IMPACTED ASSIGNMENTS PAYLOAD
// ───────────────────────────────────────────────────────────────────────

describe('buildImpactedAssignments', () => {
  test('captures original assignee + new assignee + status at redistribute', () => {
    const plan = planRedistribution(
      [task('t1', '101', 'scheduled'), task('t2', '102', 'scheduled')],
      [{ id: 'a', current_load: 0 }, { id: 'b', current_load: 0 }],
    );
    const impactedList = buildImpactedAssignments(plan, 'sick-uuid');
    assert.equal(impactedList.length, 2);
    for (const i of impactedList) {
      assert.equal(i.original_assignee_id, 'sick-uuid');
      assert.equal(i.task_status_at_redistribute, 'scheduled');
    }
    assert.ok(impactedList.some((i) => i.redistributed_to === 'a'));
    assert.ok(impactedList.some((i) => i.redistributed_to === 'b'));
  });
});
