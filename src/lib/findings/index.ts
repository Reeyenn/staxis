/**
 * Public surface of the findings layer — the spine the later phases plug into.
 *
 * WHAT THIS IS
 * One model for "Staxis noticed something wrong here", one registry of
 * detectors, one runner, one ledger table. It replaces three unrelated
 * detection systems' private notions of "have I already said this?" with a
 * guarantee the database keeps: one problem, one row.
 *
 * HOW A LATER PHASE ADDS A DETECTOR
 *   1. Write a pure `(ctx, params) => FindingDraft[]`.
 *   2. Give it a declaration: id, the feeds it reads, the minimum data it needs
 *      before it may speak, its receipt query, default disposition + severity,
 *      an escalation policy (or null), a per-run cap, a staleness window, and
 *      at least one eval case.
 *   3. `registerDetector(...)` at module scope and export it from
 *      `detectors/index.ts`.
 * That is all. Dedupe, caps, staleness, the silenced states and the run summary
 * are applied by the runner from the declaration — there is nothing to remember
 * and nothing to get wrong.
 *
 * HOW A LATER PHASE READS FINDINGS
 *   `listFindings(propertyId, { statuses })` → the queue, worst first.
 *   `setFindingStatus(propertyId, id, status, accountId)` → the manager's
 *   verdict. Moving to 'known_problem' records the magnitude they consented to,
 *   which is what makes escalation honest.
 *   `latestRun(propertyId)` → "checked N detectors, M findings", the proof the
 *   system is alive on a night it found nothing.
 */

export type {
  AnyDetector,
  DataRequirement,
  Detector,
  DetectorContext,
  DetectorDeclaration,
  DetectorEvalCase,
  DetectorParams,
  EscalationPolicy,
  FeedId,
  FeedOutcome,
  FeedResult,
  FeedShapes,
  Finding,
  FindingDisposition,
  FindingDraft,
  FindingEvidence,
  FindingRunSummary,
  FindingSeverity,
  FindingStatus,
  PriceRange,
} from './types';

export {
  ACTIVE_STATUSES,
  SILENCED_STATUSES,
  isUsablePriceRange,
  readFeed,
} from './types';

export {
  DetectorDeclarationError,
  allDetectors,
  getDetector,
  registerDetector,
  requiredFeeds,
  validateDeclaration,
} from './registry';

export {
  capDrafts,
  decideAction,
  dedupeDrafts,
  dedupeKeyFor,
  evidenceMoved,
  shouldEscalate,
  type ExistingFinding,
  type SilencerAction,
} from './silencer';

export {
  listFindings,
  latestRun,
  setFindingStatus,
  type ListFindingsOptions,
} from './store';

export {
  runFindingsForAllProperties,
  runFindingsForProperty,
  type FindingsRunOptions,
  type FleetRunResult,
} from './runner';

export { runAllDetectorEvalCases, runDetectorEvalCases, type EvalCaseResult } from './evals';
