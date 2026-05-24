/**
 * Public surface of the rules engine.
 *
 * Callers (the cron route, the future CUA-trigger endpoint, the
 * housekeeping UI's "preview" tool) should only import from here —
 * everything else under src/lib/rules-engine/ is internal.
 */

export {
  runRulesEngineForProperty,
  runRulesEngineForAllProperties,
  type EngineOptions,
  type PropertyRunResult,
  type RoomEngineOutcome,
} from './engine';

export { ALL_RULES, evaluateRoomRules } from './rules';

export { mergePartials, contextToTaskRow, newEngineRunId } from './merger';

export { assembleRoomContexts } from './context';

export type {
  PropertyContext,
  RoomContext,
  DepartingReservation,
  ArrivingReservation,
  StayingReservation,
  Rule,
  RuleFireResult,
  PartialTaskSpec,
} from './types';
