/**
 * Pure-function policy for sick-callout redistribution + revert.
 *
 * Kept separate from the DB-touching code so we can unit-test the hard
 * cases (in-progress task stays with new assignee, dedup logic, naive
 * round-robin fairness) without standing up Supabase.
 *
 * The smart re-spread (skill match, floor cohesion, language match,
 * workload balancing) is owned by feature/hk-auto-assignment. Until
 * that lands, we use the naive round-robin in pickRedistributionAssignee
 * below — it produces a working demo with sensible distribution and is
 * a one-function swap when the smart engine lands.
 */

import type { ImpactedAssignment, RevertOutcomeEntry } from './types';

/**
 * Minimal shape we need from a cleaning_tasks row to decide redistribution.
 * Kept narrow so the test fixtures stay small.
 */
export interface RedistributableTask {
  id: string;
  room_number: string;
  assignee_id: string | null;
  status: string;
  started_at: string | null;
}

export interface RedistributionEligibleStaff {
  id: string;
  /** Existing rooms already in this HK's queue today — used to rank pickups so
      we don't pile new work on someone already at the top of the list. */
  current_load: number;
}

export interface RedistributionPlan {
  /** One entry per task that needs reassignment. Source rows that were
      already started/completed are dropped here (preserved as-is on the
      callout audit log via the caller). */
  assignments: Array<{
    task: RedistributableTask;
    new_assignee_id: string | null;   // null when no eligible staff exists
  }>;
  /** Tasks that should stay with the sick HK (because they were already
      started or completed). Carried through for the audit log so the
      manager UI can show "credit stayed with Maria for room 301". */
  retained_with_sick: RedistributableTask[];
}

/**
 * Decide which tasks need new assignees and which stay with the sick HK.
 * Per spec: "Started/completed tasks stay credited to the sick person."
 *
 * The status check is the authoritative signal — we use it instead of
 * `started_at IS NOT NULL` because a task could have been started AND
 * reset back to scheduled in the same shift, in which case started_at
 * may linger from the earlier attempt. Status reflects current intent.
 */
const STATUSES_TASK_ALREADY_OWNED = new Set([
  'in_progress',
  'paused',
  'completed',
  'inspection_pending',
  'inspected_pass',
  'inspected_fail',
  'correction_pending',
  'correction_complete',
  'check_pending',
  'check_complete',
]);

export function planRedistribution(
  sickStaffTasks: RedistributableTask[],
  eligibleStaff: RedistributionEligibleStaff[],
): RedistributionPlan {
  const assignments: RedistributionPlan['assignments'] = [];
  const retained: RedistributableTask[] = [];

  // Mutable copy so we can rebalance load as we hand out tasks.
  const load = new Map<string, number>();
  for (const s of eligibleStaff) load.set(s.id, s.current_load);

  // Sort tasks deterministically so the test assertions don't depend on
  // input order. Room number ASC — same convention as the housekeeper
  // page's sortRooms().
  const ordered = [...sickStaffTasks].sort((a, b) => {
    const an = parseInt(a.room_number, 10);
    const bn = parseInt(b.room_number, 10);
    if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) return an - bn;
    return a.room_number.localeCompare(b.room_number);
  });

  for (const task of ordered) {
    if (STATUSES_TASK_ALREADY_OWNED.has(task.status)) {
      retained.push(task);
      continue;
    }
    // No one to give it to → unassigned. Auto-assignment cron will pick
    // it up once it lands; in the meantime the room shows up in Maria's
    // "unassigned" lane on the manager dashboard.
    if (eligibleStaff.length === 0) {
      assignments.push({ task, new_assignee_id: null });
      continue;
    }
    // Pick the eligible HK with the lowest current load. Ties break on
    // staff_id for determinism.
    let winnerId = eligibleStaff[0].id;
    let winnerLoad = load.get(winnerId) ?? 0;
    for (const s of eligibleStaff) {
      const l = load.get(s.id) ?? 0;
      if (l < winnerLoad || (l === winnerLoad && s.id < winnerId)) {
        winnerId = s.id;
        winnerLoad = l;
      }
    }
    assignments.push({ task, new_assignee_id: winnerId });
    load.set(winnerId, winnerLoad + 1);
  }

  return { assignments, retained_with_sick: retained };
}

/**
 * Build the impacted_assignments payload from a redistribution plan.
 * Captured exactly as planRedistribution decided so the revert path can
 * reverse what actually happened (not what we wish had happened).
 */
export function buildImpactedAssignments(
  plan: RedistributionPlan,
  sickStaffId: string,
): ImpactedAssignment[] {
  return plan.assignments.map(({ task, new_assignee_id }) => ({
    task_id: task.id,
    room_number: task.room_number,
    original_assignee_id: sickStaffId,
    redistributed_to: new_assignee_id,
    task_status_at_redistribute: task.status,
  }));
}

// ───────────────────────────────────────────────────────────────────────
// REVERT POLICY
// ───────────────────────────────────────────────────────────────────────

/** Statuses that mean the new assignee has touched the task — anything
    beyond 'scheduled'/'ready_now'. Once started, the room stays with the
    person who picked it up. The exception is 'cancelled'/'superseded' —
    those are non-states from the new assignee's perspective; we still
    return them to the original HK so they don't get stranded. */
const STATUSES_NEW_ASSIGNEE_TOUCHED = new Set([
  'in_progress',
  'paused',
  'completed',
  'inspection_pending',
  'inspected_pass',
  'inspected_fail',
  'correction_pending',
  'correction_complete',
  'check_pending',
  'check_complete',
]);

export interface CurrentTaskState {
  id: string;
  status: string;
  assignee_id: string | null;
}

export interface RevertDecision {
  task_id: string;
  /** Apply this assignee_id on the cleaning_tasks row. null = unassigned
      (caller may decide to leave it alone instead). */
  new_assignee_id: string | null;
  /** False when we should NOT touch the row (already finished, gone, etc.). */
  apply: boolean;
  /** Audit row appended to revert_outcome on the callout event. */
  outcome: RevertOutcomeEntry;
}

/**
 * For each impacted task, decide whether the revert should put it back
 * with the original (sick) housekeeper or leave it with whoever picked
 * it up. Inputs are intentionally narrow so the test fixtures are simple:
 * pass the impacted_assignments snapshot from the callout row plus the
 * CURRENT state of each task as it stands today.
 *
 * Returns one decision per impacted entry. The caller applies the DB
 * updates and writes the revert_outcome jsonb back to callout_events.
 */
export function planRevert(
  impacted: ImpactedAssignment[],
  currentByTaskId: Map<string, CurrentTaskState>,
): RevertDecision[] {
  return impacted.map((entry) => {
    const current = currentByTaskId.get(entry.task_id);

    // Task vanished from cleaning_tasks (e.g., engine ran a cleanup pass
    // that dropped a superseded row). Nothing to do; record for audit.
    if (!current) {
      return {
        task_id: entry.task_id,
        new_assignee_id: null,
        apply: false,
        outcome: {
          task_id: entry.task_id,
          room_number: entry.room_number,
          returned_to_original: false,
          stayed_with: null,
          reason: 'task_missing',
        },
      };
    }

    // Already completed/inspected — don't reassign a done room. Credit
    // stays with whoever finished it.
    if (
      current.status === 'completed' ||
      current.status === 'inspection_pending' ||
      current.status === 'inspected_pass' ||
      current.status === 'inspected_fail' ||
      current.status === 'correction_pending' ||
      current.status === 'correction_complete' ||
      current.status === 'check_pending' ||
      current.status === 'check_complete'
    ) {
      return {
        task_id: entry.task_id,
        new_assignee_id: null,
        apply: false,
        outcome: {
          task_id: entry.task_id,
          room_number: entry.room_number,
          returned_to_original: false,
          stayed_with: current.assignee_id,
          reason: 'task_completed',
        },
      };
    }

    // The new assignee already started cleaning it — leave it with them.
    if (STATUSES_NEW_ASSIGNEE_TOUCHED.has(current.status)) {
      return {
        task_id: entry.task_id,
        new_assignee_id: null,
        apply: false,
        outcome: {
          task_id: entry.task_id,
          room_number: entry.room_number,
          returned_to_original: false,
          stayed_with: current.assignee_id,
          reason: 'already_started',
        },
      };
    }

    // Untouched (still scheduled / ready_now / deferred). Return it.
    return {
      task_id: entry.task_id,
      new_assignee_id: entry.original_assignee_id,
      apply: true,
      outcome: {
        task_id: entry.task_id,
        room_number: entry.room_number,
        returned_to_original: true,
        stayed_with: null,
        reason: 'returned',
      },
    };
  });
}

// ───────────────────────────────────────────────────────────────────────
// SCHEDULING POLICY — when should the redistribute actually fire?
// ───────────────────────────────────────────────────────────────────────

/**
 * Compute the redistribute_at timestamp for a callout based on the
 * leave_timing the housekeeper chose. Mid-shift "in_15_min" delays the
 * actual reassignment by 15 minutes so they can finish their current
 * room and walk off the floor without a teammate showing up to take
 * a room they're about to clean. "after_current_room" is handled by the
 * cron processor checking for any remaining in-progress tasks before
 * firing — encoded by setting redistribute_at to a far-future placeholder
 * (the cron processor's predicate looks for in_progress tasks separately).
 */
export function computeRedistributeAt(
  reportedAt: Date,
  leaveTiming: 'now' | 'in_15_min' | 'after_current_room' | null,
): Date {
  if (leaveTiming === 'in_15_min') {
    return new Date(reportedAt.getTime() + 15 * 60_000);
  }
  if (leaveTiming === 'after_current_room') {
    // Sentinel far-future date — the cron processor uses the presence of
    // in-progress tasks (not the timestamp) to decide when to fire for
    // this variant. We still want a value (not null) so the partial
    // index on (redistribute_at) keeps this row visible to the cron query.
    return new Date(reportedAt.getTime() + 24 * 60 * 60_000);
  }
  // 'now' or unspecified (pre-shift callout) → fire immediately.
  return reportedAt;
}
