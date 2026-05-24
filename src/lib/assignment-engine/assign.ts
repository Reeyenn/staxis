/**
 * Greedy assignment driver.
 *
 * Iterates the input tasks in priority order, scores every (task, hk)
 * pair, and assigns each task to the highest-scoring eligible HK. Then
 * sorts each HK's queue by (priority, due_by, floor proximity) so the
 * housekeeper-facing list is in a sensible work order.
 *
 * Pure: same inputs → same outputs. No DB, no Date.now() unless
 * cfg.nowMs is unset. Side effects (writes to hk_assignments,
 * notifications) live in persist.ts and the cron route.
 *
 * Why greedy: with O(tasks × hks) decisions per shift and small N
 * (~30 tasks × ~5 HKs at one property), an exact optimizer is
 * overkill — greedy returns near-optimal results in 1 ms and is easy
 * to debug. If the property scales up, we can swap in a min-cost-flow
 * solver behind the same assignTasks() interface.
 */

import type {
  AssignmentTask,
  AssignmentHousekeeper,
  AssignmentConfig,
  AssignmentResult,
  AssignmentDecision,
  UnassignedTask,
} from '@/types/assignments';
import { ASSIGNMENT_PRIORITY_RANK } from '@/types/assignments';

import {
  initHkState,
  isEligible,
  parseFloor,
  resolveDurationMinutes,
  scoreAssignment,
  buildReason,
  type HkState,
  type ScoringContext,
} from './scoring';

/**
 * Compute the minimum workload across all eligible HKs for a given
 * task. Used to feed the relative-gap workload-balance feature. We
 * include only ELIGIBLE HKs (those that pass isEligible) because a
 * trainee blocked from inspection_only work shouldn't anchor the
 * minimum for that task.
 */
function computeScoringContext(
  task: AssignmentTask,
  states: ReadonlyMap<string, HkState>,
): ScoringContext {
  let min = Number.POSITIVE_INFINITY;
  for (const state of states.values()) {
    const elig = isEligible(state.hk, task);
    if (!elig.ok) continue;
    if (state.workloadMinutes < min) min = state.workloadMinutes;
  }
  if (!Number.isFinite(min)) min = 0;
  return { minWorkloadMinutes: min };
}

// ───────────────────────────────────────────────────────────────────────
// Sort helpers
// ───────────────────────────────────────────────────────────────────────

function dueByMs(t: AssignmentTask): number {
  if (!t.due_by) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(t.due_by);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Sort tasks for the greedy intake pass: priority desc, then due_by asc,
 * then room number asc as a stable deterministic tiebreak.
 */
function sortForIntake(tasks: readonly AssignmentTask[]): AssignmentTask[] {
  return [...tasks].sort((a, b) => {
    const pa = ASSIGNMENT_PRIORITY_RANK[a.priority] ?? 0;
    const pb = ASSIGNMENT_PRIORITY_RANK[b.priority] ?? 0;
    if (pa !== pb) return pb - pa;
    const da = dueByMs(a);
    const db = dueByMs(b);
    if (da !== db) return da - db;
    return a.room_number.localeCompare(b.room_number);
  });
}

/**
 * Per-HK queue ordering: priority desc → due_by asc → floor proximity
 * to the HK's starting floor. The proximity tiebreak lets each HK walk
 * a sensible path even when the engine's greedy intake interleaved
 * floors during scoring.
 */
function sortQueue(
  taskIds: readonly string[],
  taskById: Map<string, AssignmentTask>,
  startFloor: number | null,
): string[] {
  return [...taskIds].sort((aId, bId) => {
    const a = taskById.get(aId)!;
    const b = taskById.get(bId)!;
    const pa = ASSIGNMENT_PRIORITY_RANK[a.priority] ?? 0;
    const pb = ASSIGNMENT_PRIORITY_RANK[b.priority] ?? 0;
    if (pa !== pb) return pb - pa;
    const da = dueByMs(a);
    const db = dueByMs(b);
    if (da !== db) return da - db;
    if (startFloor != null) {
      const fa = parseFloor(a.room_number);
      const fb = parseFloor(b.room_number);
      const da2 = fa != null ? Math.abs(fa - startFloor) : 999;
      const db2 = fb != null ? Math.abs(fb - startFloor) : 999;
      if (da2 !== db2) return da2 - db2;
    }
    return a.room_number.localeCompare(b.room_number);
  });
}

// ───────────────────────────────────────────────────────────────────────
// Main entry point
// ───────────────────────────────────────────────────────────────────────

/**
 * Greedy assignment over the input task / hk lists.
 *
 * Algorithm:
 *   1. Filter out hks that aren't actually working today (isActive=false
 *      or isOutToday=true).
 *   2. Sort tasks by (priority desc, due_by asc, room_number asc).
 *   3. For each task in order:
 *        a. Find all eligible hks (passes isEligible).
 *        b. Score each (task, hk) pair using current HK state.
 *        c. Pick the highest composite. Ties broken deterministically
 *           by hk.id.
 *        d. Update that HK's state (currentFloor, workloadMinutes,
 *           queuedTaskIds).
 *   4. After all tasks placed, sort each HK's queue by
 *      (priority desc, due_by asc, floor proximity).
 *   5. Return the full AssignmentResult.
 *
 * Tasks for which no HK is eligible end up in `unassigned`.
 */
export function assignTasks(
  tasks: readonly AssignmentTask[],
  housekeepers: readonly AssignmentHousekeeper[],
  cfg: AssignmentConfig,
): AssignmentResult {
  const states = new Map<string, HkState>();
  for (const hk of housekeepers) {
    if (!hk.isActive || hk.isOutToday) continue;
    states.set(hk.id, initHkState(hk));
  }

  const decisions: AssignmentDecision[] = [];
  const unassigned: UnassignedTask[] = [];
  const taskById = new Map<string, AssignmentTask>();
  for (const t of tasks) taskById.set(t.id, t);

  const ordered = sortForIntake(tasks);

  for (const task of ordered) {
    type Candidate = {
      hkId: string;
      score: number;
      breakdown: ReturnType<typeof scoreAssignment>;
    };
    const candidates: Candidate[] = [];
    let lastEligibilityReason = 'no eligible housekeepers';
    // Recompute min workload per task — the lightest HK may have shifted
    // as earlier tasks in this loop got placed.
    const ctx = computeScoringContext(task, states);
    for (const [hkId, state] of states) {
      const elig = isEligible(state.hk, task);
      if (!elig.ok) {
        lastEligibilityReason = elig.reason;
        continue;
      }
      const breakdown = scoreAssignment(task, state, ctx, cfg);
      candidates.push({ hkId, score: breakdown.composite, breakdown });
    }

    if (candidates.length === 0) {
      unassigned.push({ taskId: task.id, reason: lastEligibilityReason });
      continue;
    }

    // Pick highest composite. Tiebreak by hk id for determinism — tests
    // depend on this. Without it, two HKs with identical scores could
    // flip between runs depending on Map iteration order.
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.hkId.localeCompare(b.hkId);
    });
    const winner = candidates[0];

    const state = states.get(winner.hkId)!;
    const minutes = resolveDurationMinutes(task, cfg);
    state.workloadMinutes += minutes;
    state.currentFloor = parseFloor(task.room_number) ?? state.currentFloor;
    state.queuedTaskIds.push(task.id);

    decisions.push({
      taskId: task.id,
      housekeeperId: winner.hkId,
      queueOrder: 0, // re-numbered after final sort below
      score: winner.score,
      reason: buildReason(winner.breakdown, state.hk),
      breakdown: winner.breakdown,
    });
  }

  const queueByHk: Record<string, string[]> = {};
  const workloadByHk: Record<string, number> = {};
  for (const [hkId, state] of states) {
    const sortedQueue = sortQueue(state.queuedTaskIds, taskById, state.hk.homeFloor ?? null);
    queueByHk[hkId] = sortedQueue;
    workloadByHk[hkId] = state.workloadMinutes;
  }

  // Re-number queue_order based on final sorted queues. The decision's
  // queueOrder reflects where the task ended up in its HK's final list,
  // not where greedy intake placed it.
  const orderByTask = new Map<string, number>();
  for (const [hkId, queue] of Object.entries(queueByHk)) {
    queue.forEach((taskId, idx) => orderByTask.set(taskId, idx));
    // Touch hkId so the linter knows it's referenced (we only need the
    // values from Object.entries; keeping the name preserves readability
    // for future maintainers).
    void hkId;
  }
  for (const d of decisions) {
    d.queueOrder = orderByTask.get(d.taskId) ?? 0;
  }

  return { decisions, unassigned, workloadByHk, queueByHk };
}

// ───────────────────────────────────────────────────────────────────────
// Sick-callout rebalancing
// ───────────────────────────────────────────────────────────────────────

/**
 * Re-spread one HK's queue across the remaining roster. Used when a
 * housekeeper calls out mid-shift: feed in `existingDecisions` (what
 * was already assigned), the `outHkId`, and the current roster minus
 * the out person; we return a NEW assignment for just the out person's
 * tasks. The caller is responsible for replacing the audit rows.
 *
 * In-progress tasks (status='in_progress' or later) should be filtered
 * out by the caller BEFORE invoking this helper — we only re-spread
 * tasks that haven't been started yet.
 *
 * Tasks the rest of the crew can't absorb come back as `unassigned`.
 * The manager UI surfaces those with a "needs manual placement" badge.
 */
export function rebalanceForSickCallout(
  tasksToRespread: readonly AssignmentTask[],
  remainingHks: readonly AssignmentHousekeeper[],
  workloadByHk: Readonly<Record<string, number>>,
  cfg: AssignmentConfig,
): AssignmentResult {
  // Seed the engine with the remaining HKs' current workloads so the
  // workload-balance feature reflects what they already have on their
  // plate. Without this seed, the engine would think everyone starts
  // empty and pile everything on the first scorer.
  const states = new Map<string, HkState>();
  for (const hk of remainingHks) {
    if (!hk.isActive || hk.isOutToday) continue;
    const s = initHkState(hk);
    s.workloadMinutes = workloadByHk[hk.id] ?? 0;
    states.set(hk.id, s);
  }

  // Reuse the main loop by re-implementing intake here (vs. recursing
  // into assignTasks) so we can seed the workloadMinutes pre-loop.
  const decisions: AssignmentDecision[] = [];
  const unassigned: UnassignedTask[] = [];
  const taskById = new Map<string, AssignmentTask>();
  for (const t of tasksToRespread) taskById.set(t.id, t);

  const ordered = sortForIntake(tasksToRespread);
  for (const task of ordered) {
    type Candidate = {
      hkId: string; score: number; breakdown: ReturnType<typeof scoreAssignment>;
    };
    const candidates: Candidate[] = [];
    let lastEligibilityReason = 'no eligible housekeepers (sick callout)';
    const ctx = computeScoringContext(task, states);
    for (const [hkId, state] of states) {
      const elig = isEligible(state.hk, task);
      if (!elig.ok) {
        lastEligibilityReason = elig.reason;
        continue;
      }
      const breakdown = scoreAssignment(task, state, ctx, cfg);
      candidates.push({ hkId, score: breakdown.composite, breakdown });
    }
    if (candidates.length === 0) {
      unassigned.push({ taskId: task.id, reason: lastEligibilityReason });
      continue;
    }
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.hkId.localeCompare(b.hkId);
    });
    const winner = candidates[0];
    const state = states.get(winner.hkId)!;
    const minutes = resolveDurationMinutes(task, cfg);
    state.workloadMinutes += minutes;
    state.currentFloor = parseFloor(task.room_number) ?? state.currentFloor;
    state.queuedTaskIds.push(task.id);
    decisions.push({
      taskId: task.id,
      housekeeperId: winner.hkId,
      queueOrder: 0,
      score: winner.score,
      reason: `rebalanced: ${buildReason(winner.breakdown, state.hk)}`,
      breakdown: winner.breakdown,
    });
  }

  const queueByHk: Record<string, string[]> = {};
  const workloadOut: Record<string, number> = {};
  for (const [hkId, state] of states) {
    queueByHk[hkId] = sortQueue(state.queuedTaskIds, taskById, state.hk.homeFloor ?? null);
    workloadOut[hkId] = state.workloadMinutes;
  }
  const orderByTask = new Map<string, number>();
  for (const queue of Object.values(queueByHk)) {
    queue.forEach((taskId, idx) => orderByTask.set(taskId, idx));
  }
  for (const d of decisions) d.queueOrder = orderByTask.get(d.taskId) ?? 0;

  return { decisions, unassigned, workloadByHk: workloadOut, queueByHk };
}

// ───────────────────────────────────────────────────────────────────────
// Reassignment preview — drag-and-drop helper for the manager UI
// ───────────────────────────────────────────────────────────────────────

/**
 * Compute the new workload totals for two HKs if one task moved between
 * them. Used by the manager drag-and-drop preview before the drop is
 * committed (per Flexkeeping pattern: see HOUSEKEEPING_FEATURES.md
 * "Reassignment from room detail with workload preview").
 *
 * Returns { from: { id, before, after }, to: { id, before, after } }
 * with all minute totals as integers. Pure — no DB.
 */
export function previewReassignment(input: {
  task: AssignmentTask;
  fromHkId: string;
  toHkId: string;
  workloadByHk: Readonly<Record<string, number>>;
  cfg: AssignmentConfig;
}): {
  from: { id: string; before: number; after: number };
  to: { id: string; before: number; after: number };
  taskMinutes: number;
} {
  const minutes = resolveDurationMinutes(input.task, input.cfg);
  const fromBefore = input.workloadByHk[input.fromHkId] ?? 0;
  const toBefore = input.workloadByHk[input.toHkId] ?? 0;
  return {
    from: { id: input.fromHkId, before: fromBefore, after: Math.max(0, fromBefore - minutes) },
    to: { id: input.toHkId, before: toBefore, after: toBefore + minutes },
    taskMinutes: minutes,
  };
}
