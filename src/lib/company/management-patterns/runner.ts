import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  ACTIVITY_HISTORY_DAYS,
  MANAGEMENT_PATTERN_HARD_TIMEOUT_MS,
  MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES,
  MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES,
  MANAGEMENT_PATTERN_PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
} from './definitions';
import { stableFingerprint } from './canonical';
import { evaluateManagementPatterns, type ManagementPatternEvaluation } from './evaluator';
import {
  buildManagementPatternPersistenceBundle,
  MANAGEMENT_PATTERN_RUN_RECEIPT,
  managementPatternTerminalStatus,
  type ManagementPatternPersistenceBundle,
} from './persistence-bundle';
import {
  prepareManagementPatternInputs,
  type PreparedManagementPatternInputs,
} from './prepare-inputs';
import {
  latestManagementPatternWeeklyEvaluationAt,
  managementPatternRunKey,
  type ManagementPatternRunMode,
} from './schedule';
import {
  completedSupplyWindow,
  loadManagementPatternSourceSnapshot,
  type ManagementPatternSourceSnapshot,
} from './source-snapshot';
import {
  ManagementPatternStore,
  ManagementPatternStoreError,
  type ManagementPatternClaim,
} from './store';

const MANAGEMENT_PATTERN_DB_QUERY_BUDGET = 20;
const MANAGEMENT_PATTERN_LEASE_SECONDS = 90;
const MANAGEMENT_PATTERN_MAX_CLAIM_REVISIONS = 3;
const MANAGEMENT_PATTERN_RESULT_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const MANAGEMENT_PATTERN_SOURCE_QUERY_ID = 'management_pattern_source_snapshot';
const MANAGEMENT_PATTERN_RUN_WINDOW_POLICY_VERSION = 'management-pattern-run-window.v3';
const MANAGEMENT_PATTERN_MAX_POSITIVE_UTC_OFFSET_HOURS = 14;
// The SQL activity boundary can combine a far-west portfolio end date with a
// far-east property's UTC conversion. Four additional calendar days safely
// cover the <50-hour timezone/cutoff envelope beyond the 98 policy days.
const MANAGEMENT_PATTERN_ACTIVITY_RUN_WINDOW_SAFETY_DAYS = 4;
export const MANAGEMENT_PATTERN_MAX_BACKFILL_AGE_DAYS = 366;

type RunCounts = ManagementPatternPersistenceBundle['counts'];

export interface ManagementPatternRunSummary {
  readonly outcome: 'completed' | 'already_complete' | 'busy';
  readonly terminalStatus: 'succeeded' | 'abstained' | null;
  readonly projectionMode: 'shadow';
  readonly organizationId: string;
  readonly runId: string;
  readonly runKey: string;
  readonly triggeredBy: 'scheduled' | 'backfill';
  readonly evaluationAt: string;
  readonly sourceAsOf: string;
  readonly topologyAsOf: string;
  readonly analysisWindowAnchor: string;
  readonly evidenceBytes: number;
  readonly inputBatchBytes: number;
  readonly resultBatchBytes: number;
  readonly dbQueryCount: number;
  readonly durationMs: number;
  readonly counts: RunCounts | null;
  readonly evaluationFingerprint: string;
}

export interface ManagementPatternRunnerDependencies {
  readonly loadSource?: (input: {
    organizationId: string;
    evaluationAt: Date;
    sourceAsOf: Date;
    topologyAsOf: Date;
    signal?: AbortSignal;
  }) => Promise<ManagementPatternSourceSnapshot>;
  readonly prepare?: (snapshot: ManagementPatternSourceSnapshot) => PreparedManagementPatternInputs;
  readonly evaluate?: (prepared: PreparedManagementPatternInputs) => ManagementPatternEvaluation;
  readonly buildBundle?: (
    prepared: PreparedManagementPatternInputs,
    evaluation: ManagementPatternEvaluation,
  ) => ManagementPatternPersistenceBundle;
  readonly createStore?: (signal: AbortSignal) => ManagementPatternStore;
  readonly ownerToken?: () => string;
}

interface ManagementPatternExecutionPlan {
  readonly organizationId: string;
  /** Later immutable decision/receipt instant stored on the run. */
  readonly evaluationAt: Date;
  /** Latest source revision visible to this evaluation. */
  readonly sourceAsOf: Date;
  /** Historical topology boundary, frozen for the analysis being revised. */
  readonly topologyAsOf: Date;
  /** Historical weekly boundary that selects evidence windows and freshness. */
  readonly analysisWindowAnchor: Date;
  readonly runMode: Extract<ManagementPatternRunMode, 'scheduled' | 'backfill'>;
  readonly triggeredBy: 'scheduled' | 'backfill';
  readonly initialSupersedesRunId: string | null;
}

class ManagementPatternTimeoutError extends Error {
  constructor() {
    super(`management pattern run exceeded ${MANAGEMENT_PATTERN_HARD_TIMEOUT_MS}ms`);
    this.name = 'ManagementPatternTimeoutError';
  }
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Math.round(Date.now() - startedAtMs));
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ManagementPatternTimeoutError();
}

function enforceDeadline(startedAtMs: number, controller: AbortController): void {
  if (Date.now() - startedAtMs >= MANAGEMENT_PATTERN_HARD_TIMEOUT_MS) controller.abort();
  throwIfAborted(controller.signal);
}

function evidenceByteCount(evaluation: ManagementPatternEvaluation): number {
  return jsonBytes(evaluation);
}

function runWindow(
  analysisWindowAnchor: Date,
): Readonly<{ windowStart: string; windowEnd: string }> {
  const anchorMs = analysisWindowAnchor.getTime();
  const supplyWindow = completedSupplyWindow(analysisWindowAnchor);
  const earliestSupplyStartMs = (
    Date.parse(`${supplyWindow.startDate}T00:00:00.000Z`)
    - MANAGEMENT_PATTERN_MAX_POSITIVE_UTC_OFFSET_HOURS * 60 * 60_000
  );
  const earliestActivityStartMs = (
    anchorMs
    - (
      ACTIVITY_HISTORY_DAYS
      + MANAGEMENT_PATTERN_ACTIVITY_RUN_WINDOW_SAFETY_DAYS
    ) * 86_400_000
  );
  // Run identity must not depend on which facts happened to be usable. A
  // sparse/abstained parent and a later corrected backfill describe the same
  // frozen policy envelope and therefore receive byte-identical boundaries.
  // The start is the earlier of the local-month and activity-policy bounds.
  return Object.freeze({
    windowStart: new Date(Math.min(
      earliestSupplyStartMs,
      earliestActivityStartMs,
    )).toISOString(),
    // Local manifestation receipts occur exactly at the frozen analysis
    // anchor; the run window is half-open, so preserve one millisecond beyond
    // that instant.
    windowEnd: new Date(anchorMs + 1).toISOString(),
  });
}

function assertEvidenceWithinRunWindow(
  bundle: ManagementPatternPersistenceBundle,
  window: Readonly<{ windowStart: string; windowEnd: string }>,
): void {
  const windowStartMs = Date.parse(window.windowStart);
  const windowEndMs = Date.parse(window.windowEnd);
  for (const observation of bundle.input.metricObservations) {
    for (const [startKey, endKey] of [
      ['window_start_utc', 'window_end_utc'],
      ['denominator_window_start_utc', 'denominator_window_end_utc'],
    ] as const) {
      const start = observation[startKey];
      const end = observation[endKey];
      if (start === null && end === null && startKey.startsWith('denominator_')) continue;
      const startMs = typeof start === 'string' ? Date.parse(start) : Number.NaN;
      const endMs = typeof end === 'string' ? Date.parse(end) : Number.NaN;
      if (
        !Number.isFinite(startMs)
        || !Number.isFinite(endMs)
        || startMs < windowStartMs
        || endMs > windowEndMs
      ) {
        throw new Error(`management pattern ${startKey.replace('_start_utc', '')} evidence escapes the frozen run window`);
      }
    }
  }
  for (const instance of bundle.results.candidate_local_instances) {
    const occurrenceAt = instance.occurrence_at;
    const occurrenceMs = typeof occurrenceAt === 'string'
      ? Date.parse(occurrenceAt)
      : Number.NaN;
    if (
      !Number.isFinite(occurrenceMs)
      || occurrenceMs < windowStartMs
      || occurrenceMs >= windowEndMs
    ) {
      throw new Error('management pattern local instance escapes the frozen run window');
    }
  }
}

function portfolioSnapshot(
  prepared: PreparedManagementPatternInputs,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: MANAGEMENT_PATTERN_PORTFOLIO_SNAPSHOT_SCHEMA_VERSION,
    organization_id: prepared.snapshot.organization.id,
    organization_type: prepared.snapshot.organization.organization_type,
    evaluation_at: prepared.snapshot.evaluation_at,
    source_as_of: prepared.snapshot.source_as_of,
    topology_as_of: prepared.snapshot.topology_as_of,
    analysis_window_anchor: prepared.snapshot.analysis_window_anchor,
    property_count: prepared.snapshot.property_count,
    source_budget_exceeded: prepared.snapshot.source_budget_exceeded,
    properties: prepared.properties.map((property) => Object.freeze({
      property_id: property.source.property_id,
      relationship_id: property.source.relationship.id,
      property_snapshot_hash: property.fingerprint,
      eligibility_status: property.runExclusionCodes.length === 0 ? 'included' : 'excluded',
      exclusion_codes: property.runExclusionCodes,
    })),
  });
}

function inputManifest(
  prepared: PreparedManagementPatternInputs,
  evaluation: ManagementPatternEvaluation,
  bundle: ManagementPatternPersistenceBundle,
): Readonly<Record<string, unknown>> {
  const expectedSupplyWindow = completedSupplyWindow(
    new Date(prepared.snapshot.analysis_window_anchor),
  );
  return Object.freeze({
    source_query_id: MANAGEMENT_PATTERN_SOURCE_QUERY_ID,
    source_query_version: prepared.snapshot.query_version,
    source_schema_version: prepared.snapshot.schema_version,
    analysis_window_anchor: prepared.snapshot.analysis_window_anchor,
    run_window_policy_version: MANAGEMENT_PATTERN_RUN_WINDOW_POLICY_VERSION,
    run_window_supply_start_date: expectedSupplyWindow.startDate,
    run_window_max_positive_utc_offset_hours:
      MANAGEMENT_PATTERN_MAX_POSITIVE_UTC_OFFSET_HOURS,
    run_window_activity_history_days: ACTIVITY_HISTORY_DAYS,
    run_window_activity_safety_days:
      MANAGEMENT_PATTERN_ACTIVITY_RUN_WINDOW_SAFETY_DAYS,
    source_receipt_fingerprint: stableFingerprint(
      prepared.snapshot,
      'management-pattern-source-snapshot',
    ),
    prepared_input_fingerprint: prepared.fingerprint,
    evaluation_fingerprint: evaluation.fingerprint,
    persistence_bundle_fingerprint: bundle.fingerprint,
    policy_manifest: evaluation.policyManifest,
    deterministic: true,
    model_versions: {},
    model_call_budget: 0,
    token_budget: 0,
    cost_budget_microusd: 0,
    checks: evaluation.rootEvaluations.map((root) => Object.freeze({
      semantic_family: root.semanticFamily,
      root_key: root.rootKey,
      check_ids: root.checkIds,
      check_versions: root.checkVersions,
      root_fingerprint: root.fingerprint,
    })),
  });
}

function partialCounts(
  complete: RunCounts,
  stage: 'claimed' | 'input' | 'results',
  failed: boolean,
): RunCounts {
  if (stage === 'results') {
    return Object.freeze({
      ...complete,
      qualityFailures: complete.qualityFailures + (failed ? 1 : 0),
    });
  }
  if (stage === 'input') {
    return Object.freeze({
      properties: complete.properties,
      includedProperties: complete.includedProperties,
      excludedProperties: complete.excludedProperties,
      cohorts: 0,
      cohortMembers: 0,
      observations: complete.observations,
      // The input RPC commits observations and their exact source facts in one
      // transaction. Once that boundary succeeds, a later result-stage
      // failure must retain the complete input evidence receipt.
      sourceFacts: complete.sourceFacts,
      observationLinks: 0,
      checks: 0,
      outcomes: 0,
      candidates: 0,
      abstentions: 0,
      qualityFailures: failed ? 1 : 0,
    });
  }
  return Object.freeze({
    properties: 0,
    includedProperties: 0,
    excludedProperties: 0,
    cohorts: 0,
    cohortMembers: 0,
    observations: 0,
    sourceFacts: 0,
    observationLinks: 0,
    checks: 0,
    outcomes: 0,
    candidates: 0,
    abstentions: 0,
    qualityFailures: failed ? 1 : 0,
  });
}

function qualitySummary(
  prepared: PreparedManagementPatternInputs,
  evaluation: ManagementPatternEvaluation,
): Readonly<Record<string, unknown>> {
  const roots = { present: 0, absent: 0, abstained: 0 };
  for (const root of evaluation.rootEvaluations) roots[root.conclusion] += 1;
  return Object.freeze({
    deterministic: true,
    ai_calls: 0,
    included_property_count: prepared.includedProperties.length,
    excluded_property_count: prepared.excludedProperties.length,
    root_conclusions: roots,
    emitted_candidate_count: evaluation.candidates.filter((item) => item.decision === 'emit').length,
    suppressed_candidate_count: evaluation.candidates.filter((item) => item.decision === 'suppress').length,
    reason_codes: evaluation.reasonCodes,
  });
}

function safeErrorReceipt(error: unknown, stage: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    code: 'management_pattern_run_failed',
    stage,
    error_kind: error instanceof ManagementPatternStoreError
      ? 'database_boundary'
      : error instanceof ManagementPatternTimeoutError
        ? 'timeout'
        : 'runtime',
    database_code: error instanceof ManagementPatternStoreError ? error.code : null,
    ambiguous_commit: error instanceof ManagementPatternStoreError
      ? error.ambiguousCommit
      : false,
  });
}

function expectedResultRowCounts(
  bundle: ManagementPatternPersistenceBundle,
): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(bundle.results).map(([key, rows]) => [key, rows.length]),
  ));
}

function assertResultReceipt(
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
): void {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  if (keys.some((key) => expected[key] !== actual[key])) {
    throw new ManagementPatternStoreError({
      rpcName: 'append_management_pattern_result_batch',
      code: 'receipt_mismatch',
      message: 'database result-batch row counts differ from the submitted graph',
      ambiguousCommit: true,
    });
  }
}

function assertInputReceipt(
  bundle: ManagementPatternPersistenceBundle,
  actual: Readonly<{
    runPropertiesInserted: number;
    metricObservationsInserted: number;
    metricSourceFactsInserted: number;
  }>,
): void {
  const expected = [
    bundle.input.runProperties.length,
    bundle.input.metricObservations.length,
    bundle.input.metricSourceFacts.length,
  ];
  const received = [
    actual.runPropertiesInserted,
    actual.metricObservationsInserted,
    actual.metricSourceFactsInserted,
  ];
  // The RPC is one transaction. A first application inserts the whole graph;
  // an exact retry after a lost response inserts zero rows after verifying all
  // immutable payloads. Any mixed/partial receipt is therefore impossible.
  const firstApplication = received.every((count, index) => count === expected[index]);
  const exactRetry = received.every((count) => count === 0);
  if (!firstApplication && !exactRetry) {
    throw new ManagementPatternStoreError({
      rpcName: 'append_management_pattern_input_batch',
      code: 'receipt_mismatch',
      message: 'database input-batch row counts are neither a full application nor an exact retry',
      ambiguousCommit: true,
    });
  }
}

async function claimWritableRun(input: {
  organizationId: string;
  runIdentityAt: Date;
  runMode: Extract<ManagementPatternRunMode, 'scheduled' | 'backfill'>;
  triggeredBy: 'scheduled' | 'backfill';
  initialSupersedesRunId: string | null;
  ownerToken: string;
  portfolio: Readonly<Record<string, unknown>>;
  portfolioHash: string;
  prepared: PreparedManagementPatternInputs;
  evaluation: ManagementPatternEvaluation;
  bundle: ManagementPatternPersistenceBundle;
  windowStart: string;
  windowEnd: string;
  store: ManagementPatternStore;
  signal: AbortSignal;
}): Promise<Readonly<{ claim: ManagementPatternClaim; runKey: string }> | ManagementPatternRunSummary> {
  const baseRunKey = managementPatternRunKey({
    mode: input.runMode,
    evaluationAt: input.runIdentityAt,
  });
  let runKey = baseRunKey;
  let supersedesRunId: string | null = input.initialSupersedesRunId;
  const manifest = inputManifest(input.prepared, input.evaluation, input.bundle);

  for (let revision = 0; revision < MANAGEMENT_PATTERN_MAX_CLAIM_REVISIONS; revision += 1) {
    throwIfAborted(input.signal);
    const claim = await input.store.claimRun({
      organizationId: input.organizationId,
      runKey,
      ownerToken: input.ownerToken,
      ...MANAGEMENT_PATTERN_RUN_RECEIPT,
      inputHash: input.evaluation.inputFingerprint,
      portfolioSnapshot: input.portfolio,
      portfolioSnapshotHash: input.portfolioHash,
      evaluationAt: input.prepared.snapshot.evaluation_at,
      sourceAsOf: input.prepared.snapshot.source_as_of,
      topologyAsOf: input.prepared.snapshot.topology_as_of,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      triggeredBy: input.triggeredBy,
      inputManifest: manifest,
      leaseSeconds: MANAGEMENT_PATTERN_LEASE_SECONDS,
      supersedesRunId,
      durationBudgetMs: MANAGEMENT_PATTERN_HARD_TIMEOUT_MS,
      dbQueryBudget: MANAGEMENT_PATTERN_DB_QUERY_BUDGET,
    });
    if (claim.outcome === 'already_complete') {
      return Object.freeze({
        outcome: 'already_complete',
        terminalStatus: null,
        projectionMode: 'shadow',
        organizationId: input.organizationId,
        runId: claim.runId,
        runKey,
        triggeredBy: input.triggeredBy,
        evaluationAt: input.prepared.snapshot.evaluation_at,
        sourceAsOf: input.prepared.snapshot.source_as_of,
        topologyAsOf: input.prepared.snapshot.topology_as_of,
        analysisWindowAnchor: input.prepared.snapshot.analysis_window_anchor,
        evidenceBytes: evidenceByteCount(input.evaluation),
        inputBatchBytes: jsonBytes(input.bundle.input),
        resultBatchBytes: jsonBytes(input.bundle.results),
        dbQueryCount: 1 + input.store.queryCount,
        durationMs: 0,
        counts: null,
        evaluationFingerprint: input.evaluation.fingerprint,
      });
    }
    if (claim.outcome === 'busy') {
      return Object.freeze({
        outcome: 'busy',
        terminalStatus: null,
        projectionMode: 'shadow',
        organizationId: input.organizationId,
        runId: claim.runId,
        runKey,
        triggeredBy: input.triggeredBy,
        evaluationAt: input.prepared.snapshot.evaluation_at,
        sourceAsOf: input.prepared.snapshot.source_as_of,
        topologyAsOf: input.prepared.snapshot.topology_as_of,
        analysisWindowAnchor: input.prepared.snapshot.analysis_window_anchor,
        evidenceBytes: evidenceByteCount(input.evaluation),
        inputBatchBytes: jsonBytes(input.bundle.input),
        resultBatchBytes: jsonBytes(input.bundle.results),
        dbQueryCount: 1 + input.store.queryCount,
        durationMs: 0,
        counts: null,
        evaluationFingerprint: input.evaluation.fingerprint,
      });
    }
    if (claim.outcome === 'claimed' || claim.outcome === 'resumed' || claim.outcome === 'reclaimed') {
      return Object.freeze({ claim, runKey });
    }
    supersedesRunId = claim.runId;
    const revisionHash = stableFingerprint({
      baseRunKey,
      priorRunKey: runKey,
      priorRunId: claim.runId,
      priorOutcome: claim.outcome,
      inputHash: input.evaluation.inputFingerprint,
      bundleFingerprint: input.bundle.fingerprint,
    }, 'management-pattern-run-revision');
    runKey = managementPatternRunKey({
      mode: input.runMode,
      evaluationAt: input.runIdentityAt,
      revisionHash,
    });
  }
  throw new Error('management pattern run exhausted bounded revision claims');
}

/** Shared evidence-only executor. Public wrappers construct a closed plan; no
 * caller-controlled option can request active projection. */
async function executeManagementPatterns(
  input: ManagementPatternExecutionPlan,
  dependencies: ManagementPatternRunnerDependencies = {},
): Promise<ManagementPatternRunSummary> {
  const startedAtMs = Date.now();
  const evaluationAt = new Date(input.evaluationAt.getTime());
  const sourceAsOf = new Date(input.sourceAsOf.getTime());
  const topologyAsOf = new Date(input.topologyAsOf.getTime());
  const analysisWindowAnchor = new Date(input.analysisWindowAnchor.getTime());
  for (const [field, value] of [
    ['evaluationAt', evaluationAt],
    ['sourceAsOf', sourceAsOf],
    ['topologyAsOf', topologyAsOf],
    ['analysisWindowAnchor', analysisWindowAnchor],
  ] as const) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid Date`);
  }
  if (
    topologyAsOf.getTime() !== analysisWindowAnchor.getTime()
    || analysisWindowAnchor.getTime() > sourceAsOf.getTime()
    || sourceAsOf.getTime() > evaluationAt.getTime()
  ) {
    throw new TypeError(
      'require topologyAsOf = analysisWindowAnchor <= sourceAsOf <= evaluationAt',
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANAGEMENT_PATTERN_HARD_TIMEOUT_MS);
  const loadSource = dependencies.loadSource ?? loadManagementPatternSourceSnapshot;
  const prepare = dependencies.prepare ?? prepareManagementPatternInputs;
  const evaluate = dependencies.evaluate ?? evaluateManagementPatterns;
  const buildBundle = dependencies.buildBundle ?? buildManagementPatternPersistenceBundle;
  const store = dependencies.createStore?.(controller.signal)
    ?? new ManagementPatternStore(undefined, controller.signal);
  const ownerToken = dependencies.ownerToken?.() ?? randomUUID();
  let claim: ManagementPatternClaim | null = null;
  let runKey = managementPatternRunKey({
    mode: input.runMode,
    evaluationAt: analysisWindowAnchor,
  });
  let stage: 'claimed' | 'input' | 'results' = 'claimed';
  let writeInFlight = false;
  let bundle: ManagementPatternPersistenceBundle | null = null;
  let evidenceBytes = 0;
  let inputBatchBytes = 0;
  let resultBatchBytes = 0;

  try {
    const snapshot = await loadSource({
      organizationId: input.organizationId,
      evaluationAt,
      sourceAsOf,
      topologyAsOf,
      signal: controller.signal,
    });
    throwIfAborted(controller.signal);
    if (
      snapshot.organization.id !== input.organizationId
      || Date.parse(snapshot.evaluation_at) !== evaluationAt.getTime()
      || Date.parse(snapshot.source_as_of) !== sourceAsOf.getTime()
      || Date.parse(snapshot.topology_as_of) !== topologyAsOf.getTime()
      || Date.parse(snapshot.analysis_window_anchor) !== analysisWindowAnchor.getTime()
    ) {
      throw new Error('management pattern source snapshot does not match the execution plan');
    }
    const prepared = prepare(snapshot);
    const evaluation = evaluate(prepared);
    if (Date.parse(evaluation.evaluatedAt) !== analysisWindowAnchor.getTime()) {
      throw new Error('management pattern evaluation moved the frozen analysis window anchor');
    }
    bundle = buildBundle(prepared, evaluation);
    enforceDeadline(startedAtMs, controller);
    evidenceBytes = evidenceByteCount(evaluation);
    inputBatchBytes = jsonBytes(bundle.input);
    resultBatchBytes = jsonBytes(bundle.results);
    if (evidenceBytes > MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES) {
      throw new Error(`management pattern evidence exceeds ${MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES} bytes`);
    }
    if (inputBatchBytes > MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES) {
      throw new Error(`management pattern input batch exceeds ${MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES} bytes`);
    }
    if (resultBatchBytes > MANAGEMENT_PATTERN_RESULT_BATCH_MAX_BYTES) {
      throw new Error('management pattern result batch exceeds the fixed database budget');
    }
    const portfolio = portfolioSnapshot(prepared);
    const portfolioHash = stableFingerprint(portfolio, 'management-pattern-portfolio-snapshot');
    const window = runWindow(analysisWindowAnchor);
    assertEvidenceWithinRunWindow(bundle, window);
    const claimed = await claimWritableRun({
      organizationId: input.organizationId,
      runIdentityAt: analysisWindowAnchor,
      runMode: input.runMode,
      triggeredBy: input.triggeredBy,
      initialSupersedesRunId: input.initialSupersedesRunId,
      ownerToken,
      portfolio,
      portfolioHash,
      prepared,
      evaluation,
      bundle,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      store,
      signal: controller.signal,
    });
    if ('outcome' in claimed) {
      return Object.freeze({ ...claimed, durationMs: elapsedMs(startedAtMs) });
    }
    claim = claimed.claim;
    runKey = claimed.runKey;
    enforceDeadline(startedAtMs, controller);

    writeInFlight = true;
    const inputReceipt = await store.appendInputBatch({
      organizationId: input.organizationId,
      runId: claim.runId,
      ownerToken,
      fencingToken: claim.fencingToken,
      batch: bundle.input,
    });
    assertInputReceipt(bundle, inputReceipt);
    writeInFlight = false;
    stage = 'input';
    enforceDeadline(startedAtMs, controller);

    writeInFlight = true;
    const resultReceipt = await store.appendResultBatch({
      organizationId: input.organizationId,
      runId: claim.runId,
      ownerToken,
      fencingToken: claim.fencingToken,
      results: bundle.results,
    });
    stage = 'results';
    writeInFlight = false;
    assertResultReceipt(expectedResultRowCounts(bundle), resultReceipt.rowCounts);
    enforceDeadline(startedAtMs, controller);

    const terminalStatus = managementPatternTerminalStatus(evaluation);
    const durationBeforeFinalize = elapsedMs(startedAtMs);
    await store.finalizeRun({
      organizationId: input.organizationId,
      runId: claim.runId,
      ownerToken,
      fencingToken: claim.fencingToken,
      terminalStatus,
      counts: bundle.counts,
      // Reserve both exact-retry finalize attempts. If the first response is
      // lost after commit, the sealed row cannot be updated with knowledge of
      // the second request; a conservative upper bound keeps budgets honest.
      dbQueryCount: 1 + store.queryCount + 2,
      durationMs: durationBeforeFinalize,
      qualitySummary: qualitySummary(prepared, evaluation),
      performanceSummary: {
        hard_timeout_ms: MANAGEMENT_PATTERN_HARD_TIMEOUT_MS,
        evidence_bytes: evidenceBytes,
        input_batch_bytes: inputBatchBytes,
        input_batch_max_bytes: MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES,
        result_batch_bytes: resultBatchBytes,
        source_query_count: 1,
        persistence_query_count_upper_bound_including_finalize: store.queryCount + 2,
        query_count_receipt_kind: 'conservative_upper_bound',
      },
      errorDetail: {},
    });

    return Object.freeze({
      outcome: 'completed',
      terminalStatus,
      projectionMode: 'shadow',
      organizationId: input.organizationId,
      runId: claim.runId,
      runKey,
      triggeredBy: input.triggeredBy,
      evaluationAt: evaluationAt.toISOString(),
      sourceAsOf: sourceAsOf.toISOString(),
      topologyAsOf: topologyAsOf.toISOString(),
      analysisWindowAnchor: analysisWindowAnchor.toISOString(),
      evidenceBytes,
      inputBatchBytes,
      resultBatchBytes,
      dbQueryCount: 1 + store.queryCount,
      durationMs: elapsedMs(startedAtMs),
      counts: bundle.counts,
      evaluationFingerprint: evaluation.fingerprint,
    });
  } catch (error) {
    const ambiguousCommit = (
      writeInFlight && !(error instanceof ManagementPatternStoreError)
    ) || (
      error instanceof ManagementPatternStoreError && error.ambiguousCommit
    );
    if (claim && bundle && !ambiguousCommit) {
      try {
        await store.finalizeRun({
          organizationId: input.organizationId,
          runId: claim.runId,
          ownerToken,
          fencingToken: claim.fencingToken,
          terminalStatus: 'failed',
          counts: partialCounts(bundle.counts, stage, true),
          dbQueryCount: 1 + store.queryCount + 2,
          durationMs: elapsedMs(startedAtMs),
          qualitySummary: {
            deterministic: true,
            ai_calls: 0,
            failure_stage: stage,
          },
          performanceSummary: {
            hard_timeout_ms: MANAGEMENT_PATTERN_HARD_TIMEOUT_MS,
            evidence_bytes: evidenceBytes,
            input_batch_bytes: inputBatchBytes,
            input_batch_max_bytes: MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES,
            result_batch_bytes: resultBatchBytes,
            source_query_count: 1,
            persistence_query_count_upper_bound_including_finalize: store.queryCount + 2,
            query_count_receipt_kind: 'conservative_upper_bound',
          },
          errorDetail: safeErrorReceipt(error, stage),
        });
      } catch {
        // Preserve the originating exception. The fenced lease and partial-
        // evidence seal prevent another writer from mixing generations.
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Evaluate and persist one management/ownership company at the stable weekly
 * boundary. Delayed invocations reuse the same evidence identity.
 */
export async function runScheduledManagementPatterns(
  input: {
    readonly organizationId: string;
    readonly now?: Date;
  },
  dependencies: ManagementPatternRunnerDependencies = {},
): Promise<ManagementPatternRunSummary> {
  const now = input.now ? new Date(input.now.getTime()) : new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const evaluationAt = latestManagementPatternWeeklyEvaluationAt(now);
  return executeManagementPatterns({
    organizationId: input.organizationId,
    evaluationAt,
    sourceAsOf: evaluationAt,
    topologyAsOf: evaluationAt,
    analysisWindowAnchor: evaluationAt,
    runMode: 'scheduled',
    triggeredBy: 'scheduled',
    initialSupersedesRunId: null,
  }, dependencies);
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Explicit projection-neutral correction of one historical weekly epoch.
 * The caller must name the immutable parent run and every temporal boundary;
 * no Date.now-derived evidence boundary or broad historical sweep exists.
 */
export async function runManagementPatternBackfill(
  input: {
    readonly organizationId: string;
    readonly analysisWindowAnchor: Date;
    readonly sourceAsOf: Date;
    readonly evaluationAt: Date;
    readonly supersedesRunId: string;
  },
  dependencies: ManagementPatternRunnerDependencies = {},
): Promise<ManagementPatternRunSummary> {
  const analysisWindowAnchor = new Date(input.analysisWindowAnchor.getTime());
  const sourceAsOf = new Date(input.sourceAsOf.getTime());
  const evaluationAt = new Date(input.evaluationAt.getTime());
  for (const [field, value] of [
    ['analysisWindowAnchor', analysisWindowAnchor],
    ['sourceAsOf', sourceAsOf],
    ['evaluationAt', evaluationAt],
  ] as const) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid Date`);
  }
  if (!UUID_RX.test(input.organizationId) || !UUID_RX.test(input.supersedesRunId)) {
    throw new TypeError('backfill organizationId and supersedesRunId must be UUIDs');
  }
  if (
    latestManagementPatternWeeklyEvaluationAt(analysisWindowAnchor).getTime()
    !== analysisWindowAnchor.getTime()
  ) {
    throw new TypeError('backfill analysisWindowAnchor must be an exact weekly evaluation boundary');
  }
  if (
    analysisWindowAnchor.getTime() > sourceAsOf.getTime()
    || sourceAsOf.getTime() > evaluationAt.getTime()
  ) {
    throw new TypeError('require analysisWindowAnchor <= sourceAsOf <= evaluationAt');
  }
  const maximumAgeMs = MANAGEMENT_PATTERN_MAX_BACKFILL_AGE_DAYS * 86_400_000;
  if (evaluationAt.getTime() - analysisWindowAnchor.getTime() > maximumAgeMs) {
    throw new TypeError(
      `backfill age exceeds ${MANAGEMENT_PATTERN_MAX_BACKFILL_AGE_DAYS} days`,
    );
  }
  return executeManagementPatterns({
    organizationId: input.organizationId,
    evaluationAt,
    sourceAsOf,
    topologyAsOf: analysisWindowAnchor,
    analysisWindowAnchor,
    runMode: 'backfill',
    triggeredBy: 'backfill',
    initialSupersedesRunId: input.supersedesRunId,
  }, dependencies);
}
