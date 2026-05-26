/**
 * Public surface for the cost-tracking module.
 *
 * Importing anything from `@/lib/cost-tracking` pulls from here so the
 * inner file layout (calculate-task-cost / calculate-day-cost /
 * project-end-of-day) can be refactored without touching every call
 * site.
 */

export {
  activeMinutes,
  calculateTaskCost,
  type CalculateTaskCostInput,
  type CalculatedTaskCost,
  type PauseInterval,
} from './calculate-task-cost';

export {
  aggregateDayCost,
  calculatePropertyDayCost,
  summarizeRemainingWork,
  asCleaningTaskRows,
  type PerHousekeeperCost,
  type PropertyDayCost,
  type PropertyDayCostInput,
  type RemainingWorkSummary,
} from './calculate-day-cost';

export {
  projectEndOfDayCost,
  projectFromRows,
  type ProjectedEndOfDayCost,
} from './project-end-of-day';

export {
  aggregateRangeCost,
  calculatePropertyRangeCost,
  MAX_RANGE_DAYS,
  type PropertyRangeCost,
  type RangeDailyCost,
  type RangePerStaffTotal,
} from './calculate-range-cost';

export {
  classifyOvertimeLevel,
  isoWeekParts,
  APPROACHING_OT_HOURS,
  DEFAULT_OT_THRESHOLD_HOURS,
  type OvertimeLevel,
} from './overtime';
