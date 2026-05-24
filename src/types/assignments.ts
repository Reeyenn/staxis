/**
 * Auto-assignment engine types.
 *
 * The engine consumes:
 *   - cleaning tasks (from migration 0210 / src/lib/rules-engine)
 *   - housekeepers (subset of staff)
 *   - a scoring config (weights, shift minutes, base durations)
 *
 * and produces:
 *   - an AssignmentResult: per-task housekeeper + queue order + reason
 *
 * The shapes here intentionally DUPLICATE the subset of fields the engine
 * needs from cleaning_tasks and staff rather than importing CleaningTask
 * or StaffMember directly. Reasons:
 *
 *   1. Decoupling — the scoring engine is a pure function. It should
 *      compile cleanly even when the rules-engine branch hasn't merged
 *      yet (which would mean @/types/cleaning-tasks doesn't exist on
 *      this branch).
 *
 *   2. Testability — tests can construct minimal AssignmentTask /
 *      AssignmentHousekeeper objects without satisfying the full 30+
 *      fields on the production types.
 *
 *   3. Forward-compat — when the engine eventually accepts inputs from a
 *      different upstream (e.g. work orders, deep cleans), the consumer
 *      adapts to AssignmentTask rather than the engine learning a new
 *      type per source.
 *
 * Production callers map cleaning_tasks rows → AssignmentTask at the
 * route boundary (see src/app/api/cron/run-auto-assign/route.ts).
 */

// ───────────────────────────────────────────────────────────────────────
// Inputs
// ───────────────────────────────────────────────────────────────────────

export type AssignmentTaskPriority = 'urgent' | 'high' | 'normal' | 'low';

/** Numeric rank — higher = more urgent. Matches PRIORITY_RANK on cleaning_tasks. */
export const ASSIGNMENT_PRIORITY_RANK: Record<AssignmentTaskPriority, number> = {
  urgent: 3,
  high: 2,
  normal: 1,
  low: 0,
};

/**
 * Minimal cleaning task shape the engine reads. Maps 1:1 onto a row from
 * the cleaning_tasks table (migration 0210) — the engine itself stays
 * source-agnostic.
 */
export interface AssignmentTask {
  id: string;
  property_id: string;
  room_number: string;
  cleaning_type: string;
  priority: AssignmentTaskPriority;
  /** ISO timestamp. Used as a tiebreak after priority. Null = no deadline. */
  due_by: string | null;
  /** Engine-supplied minutes from rules-engine OR ML duration estimator.
   *  Null = no estimate; engine falls back to baseDurationMinutes(cleaning_type). */
  estimated_minutes: number | null;
  requires_inspection: boolean;
  /** Task extras (fruit_basket, supervisor_inspection, …). Used for skill / VIP signal. */
  extras: string[];
  /** Optional preferred-language hint from the reservation (e.g. 'es' for a
   *  guest's stay where the PMS recorded Spanish preference). The rules
   *  engine stashes this on the row when available; engine reads it for
   *  the language-match feature. Absent = neutral. */
  guest_language?: 'en' | 'es' | null;
}

export type AssignmentHkLanguage = 'en' | 'es';

/**
 * Minimal housekeeper shape the engine reads. Maps onto a subset of the
 * staff table (id, name, language, is_senior, weekly hour caps, etc.).
 */
export interface AssignmentHousekeeper {
  id: string;
  name: string;
  language: AssignmentHkLanguage;
  /** Senior housekeepers can take inspection/VIP work. Trainees can't. */
  isSenior: boolean;
  /** Is this person actually working today. Engine never assigns to
   *  inactive HKs; it's the caller's job to pass the right roster. */
  isActive: boolean;
  /** Pre-shift home floor — the floor this HK starts on (commonly where
   *  their cart lives or where they worked yesterday). Optional. */
  homeFloor?: number | null;
  /** Tracked hours for the week. Drives the overtime feature. */
  weeklyHours?: number;
  maxWeeklyHours?: number;
  /** Marks a HK as off today (sick, vacation). Engine excludes them. */
  isOutToday?: boolean;
}

// ───────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────

/**
 * Scoring weights. Each feature contributes `weight * featureScore` to
 * the composite. Defaults below were chosen so that priority + workload
 * balance dominate, with floor proximity and language match as tiebreaks.
 *
 * Bump a weight up to make that feature more decisive. Set to 0 to
 * disable a feature entirely (e.g. small properties with one floor can
 * set floorMatch: 0 since every room is on the same floor).
 */
export interface ScoringWeights {
  /** Priority of the task itself. Urgent rooms outscore low-priority. */
  priority: number;
  /** Penalty for falling behind a due_by time. Capped: arriving guest. */
  urgency: number;
  /** Reward for keeping the HK on their current floor. Penalize floor changes. */
  floorMatch: number;
  /** Reward for matching a Spanish-speaking HK to a Spanish-speaking guest. */
  languageMatch: number;
  /** Reward for matching skill — senior HK for inspection / VIP work. */
  skillMatch: number;
  /** Penalty for piling minutes on an already-loaded HK (fairness). */
  workloadBalance: number;
  /** Big penalty for pushing a HK past their weekly hour cap. */
  overtimePenalty: number;
  /** Penalty for giving a trainee a high-stakes task (VIP, inspection). */
  traineePenalty: number;
  /** Reward for assigning urgent tasks fast — picks up rush flags. */
  rushBoost: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  priority: 1.0,
  urgency: 0.8,
  floorMatch: 0.6,
  languageMatch: 0.4,
  skillMatch: 0.7,
  workloadBalance: 2.0,
  overtimePenalty: 2.0,
  traineePenalty: 1.0,
  rushBoost: 0.8,
};

export interface AssignmentConfig {
  /** Per-HK shift minutes. Used by workload + overtime features. */
  shiftMinutes: number;
  /** When estimated_minutes is null, fall back to this map by cleaning_type. */
  baseDurations: Record<string, number>;
  /** Weights for the composite score. */
  weights: ScoringWeights;
  /** Treat tasks with due_by within this many minutes as urgent for the
   *  urgency feature, even if priority isn't 'urgent'. */
  urgentWindowMinutes: number;
  /** "Now" reference for urgency calculations. Defaults to Date.now() at
   *  call time. Tests pass a fixed value for determinism. */
  nowMs?: number;
}

/** Base duration map. Conservative defaults based on Comfort Suites
 *  cleaning observation (May 2026). Override per-property via
 *  AssignmentConfig.baseDurations when ML supply estimates aren't wired
 *  up yet. */
export const DEFAULT_BASE_DURATIONS: Record<string, number> = {
  departure: 30,
  departure_deep: 60,
  stayover: 15,
  refresh: 10,
  deep: 60,
  room_check: 5,
  inspection_only: 8,
  no_clean: 0,
};

export function makeAssignmentConfig(overrides: Partial<AssignmentConfig> = {}): AssignmentConfig {
  return {
    shiftMinutes: overrides.shiftMinutes ?? 420,
    baseDurations: { ...DEFAULT_BASE_DURATIONS, ...(overrides.baseDurations ?? {}) },
    weights: { ...DEFAULT_WEIGHTS, ...(overrides.weights ?? {}) },
    urgentWindowMinutes: overrides.urgentWindowMinutes ?? 60,
    nowMs: overrides.nowMs,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Outputs
// ───────────────────────────────────────────────────────────────────────

/**
 * Per-feature breakdown of one (task, hk) score. The engine writes this
 * onto the audit row so support can answer "why did Maria get this
 * room?" without re-running the engine.
 */
export interface ScoreBreakdown {
  priority: number;
  urgency: number;
  floorMatch: number;
  languageMatch: number;
  skillMatch: number;
  workloadBalance: number;
  overtimePenalty: number;
  traineePenalty: number;
  rushBoost: number;
  /** Composite — sum of (weight_i * feature_i). Higher = better. */
  composite: number;
}

/**
 * One assignment in the engine's output: which task → which HK, where
 * in the queue, and why.
 */
export interface AssignmentDecision {
  taskId: string;
  housekeeperId: string;
  queueOrder: number;
  score: number;
  /** Short human-readable reason, e.g. "floor 2 match + workload balance + Spanish guest". */
  reason: string;
  breakdown: ScoreBreakdown;
}

export interface UnassignedTask {
  taskId: string;
  /** Why no HK was eligible. Common: "no eligible housekeepers (all over hours)" */
  reason: string;
}

export interface AssignmentResult {
  /** Final decisions, one per assigned task. */
  decisions: AssignmentDecision[];
  /** Tasks the engine could not place — usually no eligible HK. */
  unassigned: UnassignedTask[];
  /** Total estimated minutes per HK after assignment. */
  workloadByHk: Record<string, number>;
  /** Ordered task ids per HK, sorted by the queue ordering rules
   *  (priority → due_by → floor proximity). */
  queueByHk: Record<string, string[]>;
}

// ───────────────────────────────────────────────────────────────────────
// DB row shape (mirrors migration 0211)
// ───────────────────────────────────────────────────────────────────────

export interface HkAssignmentRow {
  id: string;
  property_id: string;
  cleaning_task_id: string;
  housekeeper_id: string;
  queue_order: number;
  is_active: boolean;
  assigned_at: string;
  assigned_by: 'auto' | 'manual' | 'rebalance';
  assigned_by_user_id: string | null;
  reason: string | null;
  score: number | null;
  created_at: string;
  updated_at: string;
}
