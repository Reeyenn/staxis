/**
 * Pure scoring functions for the housekeeping auto-assignment engine.
 *
 * Everything here is deterministic — given the same (task, housekeeper,
 * context, config), the same numbers come out. No DB, no Date.now()
 * unless config.nowMs is unset. That's load-bearing for the unit tests
 * in src/lib/__tests__/assignment-engine-scoring.test.ts.
 *
 * The engine evaluates each (task, housekeeper) pair across nine
 * features, sums weighted contributions, and returns a composite score
 * plus a per-feature breakdown for explainability.
 *
 * See src/types/assignments.ts for the input/output shapes and the
 * default weights.
 */

import type {
  AssignmentTask,
  AssignmentHousekeeper,
  AssignmentConfig,
  ScoreBreakdown,
} from '@/types/assignments';
import { ASSIGNMENT_PRIORITY_RANK } from '@/types/assignments';

// ───────────────────────────────────────────────────────────────────────
// HK runtime state during greedy assignment
// ───────────────────────────────────────────────────────────────────────

/**
 * Working state for each HK as greedy assignment progresses.
 *
 * `currentFloor` is the floor of the last task placed in this HK's
 * queue (or homeFloor if the queue is empty). Used by the floor-match
 * feature so the engine clusters consecutive tasks on the same floor.
 *
 * `workloadMinutes` tracks running sum of estimated_minutes; used by
 * workload-balance and overtime features.
 */
export interface HkState {
  hk: AssignmentHousekeeper;
  currentFloor: number | null;
  workloadMinutes: number;
  /** Task ids already placed in this HK's queue, in order. */
  queuedTaskIds: string[];
}

export function initHkState(hk: AssignmentHousekeeper): HkState {
  return {
    hk,
    currentFloor: hk.homeFloor ?? null,
    workloadMinutes: 0,
    queuedTaskIds: [],
  };
}

/**
 * Shared context passed into the scorers. Computed once per intake-loop
 * iteration in assign.ts. The single load-bearing field is
 * `minWorkloadMinutes` — used by scoreWorkloadBalance to measure
 * imbalance relative to the lightest-loaded eligible HK, rather than
 * absolutely. Without this, the engine piles all the work on whoever
 * scored first because the absolute "load fraction of cap" doesn't
 * punish until very high loads. With it, the engine actively
 * distributes minutes across HKs.
 */
export interface ScoringContext {
  minWorkloadMinutes: number;
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

/**
 * Parse a floor number from a room number. Conservative: handles both
 * the common 3-digit pattern (203 → 2) and the 4-digit-plus pattern
 * for high-rises (1015 → 10). Returns null for non-numeric, single-
 * digit, or unparseable inputs so the floor-match feature degrades to
 * neutral rather than throwing.
 */
export function parseFloor(roomNumber: string): number | null {
  if (!roomNumber) return null;
  const digits = roomNumber.replace(/[^0-9]/g, '');
  if (digits.length < 2) return null;
  // Last two digits are the room slot; everything before is the floor.
  const floorStr = digits.slice(0, digits.length - 2);
  const floor = parseInt(floorStr, 10);
  return Number.isFinite(floor) ? floor : null;
}

/**
 * Resolve the task duration. Caller-supplied estimated_minutes wins;
 * otherwise we fall back to the base map by cleaning_type. If the
 * cleaning_type isn't in the base map, return a conservative 20 min
 * so the engine still places the task (rather than dividing by zero or
 * silently allocating 0 minutes).
 */
export function resolveDurationMinutes(
  task: AssignmentTask,
  cfg: AssignmentConfig,
): number {
  if (task.estimated_minutes != null && task.estimated_minutes >= 0) {
    return task.estimated_minutes;
  }
  const base = cfg.baseDurations[task.cleaning_type];
  if (typeof base === 'number' && base >= 0) return base;
  return 20;
}

/**
 * True if the housekeeper is even allowed to take this task right now.
 * Hard gate that runs BEFORE scoring — out-today / inactive HKs never
 * appear in the candidate list. Returns the reason string for the
 * unassigned-tasks audit when no HK is eligible.
 */
export function isEligible(
  hk: AssignmentHousekeeper,
  task: AssignmentTask,
): { ok: true } | { ok: false; reason: string } {
  if (!hk.isActive) return { ok: false, reason: 'hk inactive' };
  if (hk.isOutToday) return { ok: false, reason: 'hk out today' };
  // Inspection / supervisor-inspection extras require a senior HK.
  // Trainees CAN still be ASSIGNED inspection-required cleans (they
  // clean; a senior inspects); the gate is only when the task itself
  // is inspection_only or carries supervisor_inspection — those need
  // a senior to execute.
  const supervisorOnly =
    task.cleaning_type === 'inspection_only' ||
    task.extras.includes('supervisor_inspection');
  if (supervisorOnly && !hk.isSenior) {
    return { ok: false, reason: 'requires senior; hk is trainee' };
  }
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────
// Per-feature scoring
// Each returns a number in [-1, 1] (or in some cases [0, 1] / [-1, 0]).
// Composite combines them via the weights on the config.
// ───────────────────────────────────────────────────────────────────────

/** Priority of the task. Maps urgent=1, high=0.66, normal=0.33, low=0. */
export function scorePriority(task: AssignmentTask): number {
  const rank = ASSIGNMENT_PRIORITY_RANK[task.priority] ?? 0;
  return rank / 3;
}

/**
 * Urgency: how close is the task's due_by? Returns 1 if overdue or
 * within urgentWindowMinutes, decays linearly to 0 by 4× the window,
 * and stays at 0 thereafter. No due_by → 0 (neutral).
 */
export function scoreUrgency(task: AssignmentTask, cfg: AssignmentConfig): number {
  if (!task.due_by) return 0;
  const now = cfg.nowMs ?? Date.now();
  const due = Date.parse(task.due_by);
  if (!Number.isFinite(due)) return 0;
  const minutesUntilDue = (due - now) / 60_000;
  const w = cfg.urgentWindowMinutes;
  if (minutesUntilDue <= w) return 1;
  if (minutesUntilDue >= 4 * w) return 0;
  // Linear decay from 1 at w to 0 at 4w.
  return Math.max(0, 1 - (minutesUntilDue - w) / (3 * w));
}

/**
 * Floor match: reward clustering consecutive rooms on the same floor.
 * Same floor → 1. One floor away → 0.4. Two floors away → 0. Three+
 * floors away → -0.2 (penalize big floor jumps). No current-floor data
 * → 0 (neutral; first room of the day can be anywhere).
 */
export function scoreFloorMatch(task: AssignmentTask, state: HkState): number {
  if (state.currentFloor == null) return 0;
  const taskFloor = parseFloor(task.room_number);
  if (taskFloor == null) return 0;
  const delta = Math.abs(taskFloor - state.currentFloor);
  if (delta === 0) return 1;
  if (delta === 1) return 0.4;
  if (delta === 2) return 0;
  return -0.2;
}

/**
 * Language match: reward a Spanish-speaking HK on a Spanish-preferred
 * guest's room (and vice versa). No guest language hint → neutral 0.
 * Mismatch → small -0.2 penalty. The engine intentionally doesn't
 * REQUIRE a match; it just nudges so when there's a tie, the
 * language-matched HK wins.
 */
export function scoreLanguageMatch(
  task: AssignmentTask,
  hk: AssignmentHousekeeper,
): number {
  const guest = task.guest_language;
  if (!guest) return 0;
  if (hk.language === guest) return 1;
  return -0.2;
}

/**
 * Skill match: reward a senior HK for tasks that benefit from
 * experience (inspection-required cleans, deep cleans, supervisor
 * inspection extras). Neutral for routine cleans regardless of skill.
 *
 * The isEligible() gate above already blocks trainees from
 * inspection_only / supervisor_inspection tasks — this feature just
 * gives a soft boost to seniors on the "this is finicky" cases that
 * aren't hard-gated.
 */
export function scoreSkillMatch(
  task: AssignmentTask,
  hk: AssignmentHousekeeper,
): number {
  const isFinicky =
    task.requires_inspection ||
    task.cleaning_type === 'deep' ||
    task.cleaning_type === 'departure_deep' ||
    task.extras.includes('safety_check');
  if (!isFinicky) return 0;
  return hk.isSenior ? 0.7 : -0.3;
}

/**
 * Workload balance: penalize being more loaded than the lightest
 * eligible HK. Relative-gap based, not absolute — at low overall loads
 * an absolute (frac-of-cap)² penalty doesn't bite hard enough to break
 * the engine's tendency to pile on the first-scored HK. The relative
 * gap fixes that: if I have 60 min and the lightest has 0, my gap is
 * 60 even if 60 is a tiny fraction of my cap.
 *
 * Formula: penalty = -min(1, 0.3 + (gapFrac)² × 4)
 *   - Floor of -0.3 means "any positive gap costs at least 0.3", so
 *     the lightest HK always has a leg up on tied other features.
 *   - Quadratic on gapFrac so bigger gaps escalate hard.
 *   - Capped at -1 to bound the composite.
 *
 * Returns 0 when this HK IS the lightest (or tied for it).
 */
export function scoreWorkloadBalance(
  state: HkState,
  ctx: ScoringContext,
  cfg: AssignmentConfig,
): number {
  if (cfg.shiftMinutes <= 0) return 0;
  const gap = state.workloadMinutes - ctx.minWorkloadMinutes;
  if (gap <= 0) return 0;
  const gapFrac = gap / cfg.shiftMinutes;
  return -Math.min(1, 0.3 + gapFrac * gapFrac * 4);
}

/**
 * Overtime: hard penalty when the HK is already past their weekly cap.
 * Returns -1 if over the cap, 0 otherwise. The hefty default weight
 * (2.0) means an over-cap HK loses unless there are literally no other
 * options.
 */
export function scoreOvertime(hk: AssignmentHousekeeper): number {
  const max = hk.maxWeeklyHours;
  const cur = hk.weeklyHours;
  if (typeof max !== 'number' || typeof cur !== 'number') return 0;
  if (max <= 0) return 0;
  return cur >= max ? -1 : 0;
}

/**
 * Trainee penalty: trainees (isSenior=false) take a hit on VIP-flavored
 * tasks (urgent priority, welcome amenities, honeymoon/anniversary
 * extras, requires_inspection). Returns -1 if all three are true (a
 * trainee + VIP-flavored + senior alternatives matter), 0 otherwise.
 *
 * The isEligible() gate covers the hardest case (inspection_only and
 * supervisor_inspection). This feature handles the softer "you'd
 * RATHER not give a trainee the honeymoon suite arrival" case.
 */
export function scoreTraineePenalty(
  task: AssignmentTask,
  hk: AssignmentHousekeeper,
): number {
  if (hk.isSenior) return 0;
  const isVipFlavored =
    task.priority === 'urgent' ||
    task.requires_inspection ||
    task.extras.includes('welcome_amenity') ||
    task.extras.includes('honeymoon_amenity') ||
    task.extras.includes('anniversary_amenity') ||
    task.extras.includes('fruit_basket') ||
    task.extras.includes('champagne');
  return isVipFlavored ? -1 : 0;
}

/**
 * Rush boost: pure priority signal. Returns 1 for urgent, 0.3 for
 * high, 0 for normal/low. Combines with the urgency feature (which
 * looks at due_by) to ensure rush-flagged rooms get placed first
 * even if they have no deadline.
 */
export function scoreRushBoost(task: AssignmentTask): number {
  if (task.priority === 'urgent') return 1;
  if (task.priority === 'high') return 0.3;
  return 0;
}

// ───────────────────────────────────────────────────────────────────────
// Composite + reason
// ───────────────────────────────────────────────────────────────────────

export function scoreAssignment(
  task: AssignmentTask,
  state: HkState,
  ctx: ScoringContext,
  cfg: AssignmentConfig,
): ScoreBreakdown {
  const f = {
    priority: scorePriority(task),
    urgency: scoreUrgency(task, cfg),
    floorMatch: scoreFloorMatch(task, state),
    languageMatch: scoreLanguageMatch(task, state.hk),
    skillMatch: scoreSkillMatch(task, state.hk),
    workloadBalance: scoreWorkloadBalance(state, ctx, cfg),
    overtimePenalty: scoreOvertime(state.hk),
    traineePenalty: scoreTraineePenalty(task, state.hk),
    rushBoost: scoreRushBoost(task),
  };
  const w = cfg.weights;
  const composite =
    w.priority * f.priority +
    w.urgency * f.urgency +
    w.floorMatch * f.floorMatch +
    w.languageMatch * f.languageMatch +
    w.skillMatch * f.skillMatch +
    w.workloadBalance * f.workloadBalance +
    w.overtimePenalty * f.overtimePenalty +
    w.traineePenalty * f.traineePenalty +
    w.rushBoost * f.rushBoost;
  return { ...f, composite };
}

/**
 * Build a short human-readable reason string from a score breakdown.
 * The engine writes this onto the hk_assignments row so support can
 * answer "why did Maria get this room?" by reading the audit field
 * rather than re-running the engine.
 *
 * Picks the top 2-3 positive contributors and (if present) the most
 * notable negative one. Skips zero/neutral contributors.
 */
export function buildReason(b: ScoreBreakdown, hk: AssignmentHousekeeper): string {
  type Tag = { label: string; value: number };
  const tags: Tag[] = [
    { label: 'floor match', value: b.floorMatch },
    { label: 'workload balance', value: -b.workloadBalance }, // negative-better → flip
    { label: 'language match', value: b.languageMatch },
    { label: 'skill match', value: b.skillMatch },
    { label: 'urgent', value: b.rushBoost + b.urgency },
    { label: 'priority', value: b.priority },
  ];
  const positives = tags
    .filter(t => t.value > 0.05)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map(t => t.label);
  const flags: string[] = [];
  if (b.overtimePenalty < 0) flags.push('over weekly hours');
  if (b.traineePenalty < 0) flags.push(`trainee ${hk.name}`);
  const reason = positives.length > 0 ? positives.join(' + ') : 'best available';
  return flags.length > 0 ? `${reason} (warn: ${flags.join(', ')})` : reason;
}
