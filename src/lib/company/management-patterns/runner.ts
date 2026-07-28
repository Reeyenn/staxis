import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  MANAGEMENT_PATTERN_HARD_TIMEOUT_MS,
  MANAGEMENT_PATTERN_MAX_EVIDENCE_BYTES,
  MANAGEMENT_PATTERN_MAX_INPUT_BATCH_BYTES,
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
} from './schedule';
import {
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

type RunCounts = ManagementPatternPersistenceBundle['counts'];

export interface ManagementPatternRunSummary {
  readonly outcome: 'completed' | 'already_complete' | 'busy';
  readonly terminalStatus: 'succeeded' | 'abstained' | null;
  readonly projectionMode: 'shadow';
  readonly organizationId: string;
  readonly runId: string;
  readonly runKey: string;
  readonly evaluationAt: string;
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
  evaluationAt: string,
  bundle: ManagementPatternPersistenceBundle,
): Readonly<{ windowStart: string; windowEnd: string }> {
  const starts: number[] = [];
  const ends: number[] = [Date.parse(evaluationAt) + 1];
  for (const row of bundle.input.metricObservations) {
    for (const key of ['window_start_utc', 'denominator_window_start_utc']) {
      const value = row[key];
      if (typeof value === 'string' && Number.isFinite(Date.parse(value))) starts.push(Date.parse(value));
    }
    for (const key of ['window_end_utc', 'denominator_window_end_utc']) {
      const value = row[key];
      if (typeof value === 'string' && Number.isFinite(Date.parse(value))) ends.push(Date.parse(value));
    }
  }
  if (starts.length === 0) starts.push(Date.parse(evaluationAt) - 98 * 86_400_000);
  return Object.freeze({
    windowStart: new Date(Math.min(...starts)).toISOString(),
    // Local manifestation receipts occur exactly at evaluationAt; the run
    // window is half-open, so preserve one millisecond beyond that instant.
    windowEnd: new Date(Math.max(...ends)).toISOString(),
  });
}

function portfolioSnapshot(
  prepared: PreparedManagementPatternInputs,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema_version: 1,
    organization_id: prepared.snapshot.organization.id,
    organization_type: prepared.snapshot.organization.organization_type,
    evaluation_at: prepared.snapshot.evaluation_at,
    source_as_of: prepared.snapshot.source_as_of,
    topology_as_of: prepared.snapshot.topology_as_of,
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
  return Object.freeze({
    source_query_id: MANAGEMENT_PATTERN_SOURCE_QUERY_ID,
    source_query_version: prepared.snapshot.query_version,
    source_schema_version: prepared.snapshot.schema_version,
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
  evaluationAt: Date;
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
    mode: 'scheduled',
    evaluationAt: input.evaluationAt,
  });
  let runKey = baseRunKey;
  let supersedesRunId: string | null = null;
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
      triggeredBy: 'scheduled',
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
        evaluationAt: input.evaluationAt.toISOString(),
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
        evaluationAt: input.evaluationAt.toISOString(),
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
      mode: 'scheduled',
      evaluationAt: input.evaluationAt,
      revisionHash,
    });
  }
  throw new Error('management pattern run exhausted bounded revision claims');
}

/**
 * Evaluate and persist one management/ownership company at the stable weekly
 * boundary. This path is intentionally evidence-only: no caller-controlled
 * option can request active projection.
 */
export async function runScheduledManagementPatterns(
  input: {
    readonly organizationId: string;
    readonly now?: Date;
  },
  dependencies: ManagementPatternRunnerDependencies = {},
): Promise<ManagementPatternRunSummary> {
  const startedAtMs = Date.now();
  const now = input.now ? new Date(input.now.getTime()) : new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const evaluationAt = latestManagementPatternWeeklyEvaluationAt(now);
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
  let runKey = managementPatternRunKey({ mode: 'scheduled', evaluationAt });
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
      sourceAsOf: evaluationAt,
      topologyAsOf: evaluationAt,
      signal: controller.signal,
    });
    throwIfAborted(controller.signal);
    const prepared = prepare(snapshot);
    const evaluation = evaluate(prepared);
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
    const window = runWindow(evaluation.evaluatedAt, bundle);
    const claimed = await claimWritableRun({
      organizationId: input.organizationId,
      evaluationAt,
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
      evaluationAt: evaluationAt.toISOString(),
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
