/**
 * Public surface of the housekeeping auto-assignment engine.
 *
 * Callers (the cron route, the reassign API, the manager UI's preview
 * tool) should only import from here. Everything else under
 * src/lib/assignment-engine/ is internal scaffolding.
 *
 * The engine is pure: given the same (tasks, housekeepers, config), it
 * returns the same AssignmentResult. Side effects (DB writes,
 * notifications) live in callers — see src/app/api/cron/run-auto-assign.
 */

export { assignTasks, rebalanceForSickCallout, previewReassignment } from './assign';

export {
  scoreAssignment,
  buildReason,
  isEligible,
  parseFloor,
  resolveDurationMinutes,
  // Per-feature scorers are exported so tests can lock each feature's
  // shape independently of the composite. Not expected to be used by
  // production callers.
  scorePriority,
  scoreUrgency,
  scoreFloorMatch,
  scoreLanguageMatch,
  scoreSkillMatch,
  scoreWorkloadBalance,
  scoreOvertime,
  scoreTraineePenalty,
  scoreRushBoost,
  initHkState,
  type HkState,
  type ScoringContext,
} from './scoring';

export type {
  AssignmentTask,
  AssignmentHousekeeper,
  AssignmentConfig,
  AssignmentResult,
  AssignmentDecision,
  UnassignedTask,
  ScoreBreakdown,
  ScoringWeights,
  HkAssignmentRow,
  AssignmentTaskPriority,
  AssignmentHkLanguage,
} from '@/types/assignments';

export {
  DEFAULT_WEIGHTS,
  DEFAULT_BASE_DURATIONS,
  ASSIGNMENT_PRIORITY_RANK,
  makeAssignmentConfig,
} from '@/types/assignments';

export {
  toShadowAssignmentTask,
  buildDurationConfig,
  computeWorkloadByHk,
} from './board-helpers';
export type { ShadowTaskInput, WorkloadTask } from './board-helpers';
