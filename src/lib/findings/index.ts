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
  FindingJudgeSummary,
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

/**
 * The judge — the ONLY place a model touches a finding. It may sort, rank,
 * phrase and explain. It may not add a finding, change a number, change a price
 * range, or bring back something the silencer killed; each of those is refused
 * structurally rather than asked for politely (see judge.ts and prose-guard.ts).
 */
export {
  JUDGE_RESERVATION_USD,
  JUDGE_SYSTEM_PROMPT,
  JudgeContractError,
  MAX_JUDGED_FINDINGS,
  buildJudgeUserMessage,
  judgeFindingsForProperty,
  judgeInputHash,
  loadJudgeCandidates,
  loadJudgeKnowledge,
  needsJudging,
  orderCandidates,
  parseJudgeReplyStrict,
  persistJudgments,
  templateJudgment,
  type JudgeCandidate,
  type JudgeItem,
  type JudgeMode,
  type JudgeRunResult,
  type Judgment,
} from './judge';

/** "No number without a receipt", enforced rather than requested. */
export {
  buildProseReceipt,
  checkBilingualProse,
  checkProse,
  foldForProseMatch,
  type ProseGuardResult,
  type ProseReceipt,
  type ProseViolation,
} from './prose-guard';

export {
  FINDINGS_BACKGROUND_SHARE,
  deriveJudgeReservationUsd,
  findingsPropertyDailyCapUsd,
} from './judge-budget';

/**
 * Self-demotion — the only part of this layer that makes it SMALLER. A check
 * this hotel is shown and never engages with steps down propose → recommend →
 * fyi and eventually rests. Per hotel, always: one hotel's indifference has no
 * way to reach another's screen.
 *
 * Indifference is not the only way down. A check whose cards this hotel keeps
 * REFUSING — five separate problems muted over a week or more, with nothing
 * taken up in between — walks the same ladder, because "not doing this" said
 * often enough is a request for less of something, not more. And a quietened
 * check that somebody takes up again climbs back a rung on its own.
 */
export {
  DEMOTION_LADDER,
  DEMOTION_THRESHOLDS,
  DORMANT,
  applyDemotionPass,
  demoteDisposition,
  engagementSince,
  evaluateDemotion,
  evaluateRearm,
  isDormantAt,
  loadDetectorEngagement,
  loadDetectorStates,
  positiveEngagement,
  rearmDetector,
  type DeclinedProblem,
  type DemotionThresholds,
  type DemotionTransition,
  type DetectorEngagement,
  type DetectorLedger,
  type DetectorState,
  type EffectiveDisposition,
  type RearmVerdict,
} from './demotion';

export { recordFindingActed, recordFindingsShown } from './store';

/**
 * The weekly sweep — discovery that has to survive being checked. The model
 * proposes hypotheses from a closed vocabulary; deterministic queries reproduce
 * them or kill them; survivors become a recommendation at that hotel, and only
 * a candidate two hotels have independently reproduced may be PROPOSED (never
 * registered) as shared knowledge.
 */
export {
  MAX_HYPOTHESES,
  SWEEP_RESERVATION_USD,
  SWEEP_SAMPLE_SIZE,
  SWEEP_SYSTEM_PROMPT,
  SweepContractError,
  buildSweepUserMessage,
  parseSweepReplyStrict,
  selectSweepSample,
  sweepFleet,
  sweepProperty,
  type SweepCandidateProperty,
  type SweepMode,
  type SweepRunResult,
} from './sweep';

export {
  CHECK_KINDS,
  THRESHOLD_DERIVATIONS,
  buildSweepSummary,
  candidateSignature,
  coveredBy,
  reproduceHypothesis,
  type CheckKind,
  type Hypothesis,
  type Reproduction,
  type SweepFeeds,
  type SweepSummary,
  type ThresholdDerivation,
} from './sweep-checks';

/** "A promoted detector encoding one hotel's numbers is a tenant leak dressed
 *  as a feature." The guard that makes that impossible by construction. */
export {
  MIN_SUPPORTING_HOTELS,
  buildPromotionDraft,
  propertyAgnosticViolations,
  routeCandidateToPromotion,
  type AgnosticViolation,
  type PromotionDraft,
  type PromotionOutcome,
} from './sweep-promotion';

/** A judged-`ask` finding, in the shape the ONE existing question card eats. */
export { findingAskCandidates, findingQuestionTopic, toQuestionCandidate } from './ask-drip';
