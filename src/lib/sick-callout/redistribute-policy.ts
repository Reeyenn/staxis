/**
 * Pure-function policy for sick-callout revert + scheduling.
 *
 * Kept separate from the DB-touching code so we can unit-test the hard
 * cases (in-progress task stays with new assignee, far-future cron
 * sentinel) without standing up Supabase.
 *
 * The redistribute SCORING itself is owned by `rebalanceForSickCallout`
 * in `@/lib/assignment-engine` — that's the production engine that does
 * floor cohesion, language match, skill match, workload balancing,
 * overtime caps, etc. This file only handles the policy decisions that
 * are SPECIFIC to the sick-callout flow: revert behaviour (started rooms
 * stay with the new assignee) and timing (when to fire the redistribute
 * for mid-shift "in 15 min" / "after current room" variants).
 */

import type { ImpactedAssignment, RevertOutcomeEntry } from './types';

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
