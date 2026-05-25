/**
 * Tests for the sick-callout revert + scheduling policy.
 *
 * Run via: npx tsx --test src/lib/__tests__/sick-callout-redistribute-policy.test.ts
 *
 * The redistribute SCORING engine (`rebalanceForSickCallout`) lives in
 * @/lib/assignment-engine and has its own test file. This file pins
 * down the policy that's SPECIFIC to the callout flow:
 *   - revert: started rooms stay with the new assignee; untouched rooms
 *     return to the original (sick) HK; completed rooms freeze credit.
 *   - scheduling: when to fire the redistribute (now / in 15 min /
 *     after current room).
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  planRevert,
  computeRedistributeAt,
} from '../sick-callout/redistribute-policy';
import type {
  CurrentTaskState,
} from '../sick-callout/redistribute-policy';
import type { ImpactedAssignment } from '../sick-callout/types';

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
