import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';

import type {
  ManagementPatternInputBatch,
  ManagementPatternResultBatch,
} from './persistence-bundle';

type JsonObject = Readonly<Record<string, unknown>>;

interface RpcErrorShape {
  readonly code?: string;
  readonly message?: string;
  readonly details?: string;
  readonly hint?: string;
}

export interface ManagementPatternRpcCall extends PromiseLike<{
  readonly data: unknown;
  readonly error: RpcErrorShape | null;
}> {
  abortSignal?(signal: AbortSignal): ManagementPatternRpcCall;
}

export interface ManagementPatternRpcClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): ManagementPatternRpcCall;
}

export class ManagementPatternStoreError extends Error {
  readonly rpcName: string;
  readonly code: string | null;
  readonly ambiguousCommit: boolean;

  constructor(input: {
    rpcName: string;
    code: string | null;
    message: string;
    ambiguousCommit: boolean;
  }) {
    super(`${input.rpcName} failed${input.code ? ` (${input.code})` : ''}: ${input.message}`);
    this.name = 'ManagementPatternStoreError';
    this.rpcName = input.rpcName;
    this.code = input.code;
    this.ambiguousCommit = input.ambiguousCommit;
  }
}

export type ManagementPatternClaimOutcome =
  | 'claimed'
  | 'resumed'
  | 'reclaimed'
  | 'busy'
  | 'already_complete'
  | 'terminal_failed'
  | 'input_conflict'
  | 'partial_evidence_sealed';

export interface ManagementPatternClaim {
  readonly outcome: ManagementPatternClaimOutcome;
  readonly runId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
}

export interface ClaimManagementPatternRunInput {
  readonly organizationId: string;
  readonly runKey: string;
  readonly ownerToken: string;
  readonly engineVersion: string;
  readonly evidenceSchemaVersion: number;
  readonly cohortPolicyVersion: string;
  readonly normalizationPolicyVersion: string;
  readonly dedupePolicyVersion: string;
  readonly scopePolicyVersion: string;
  readonly inputHash: string;
  readonly portfolioSnapshot: JsonObject;
  readonly portfolioSnapshotHash: string;
  readonly evaluationAt: string;
  readonly sourceAsOf: string;
  readonly topologyAsOf: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly triggeredBy: 'scheduled' | 'manual' | 'backfill' | 'replay';
  readonly inputManifest: JsonObject;
  readonly leaseSeconds: number;
  readonly supersedesRunId: string | null;
  readonly durationBudgetMs: number;
  readonly dbQueryBudget: number;
}

export interface FinalizeManagementPatternRunInput {
  readonly organizationId: string;
  readonly runId: string;
  readonly ownerToken: string;
  readonly fencingToken: number;
  readonly terminalStatus: 'succeeded' | 'abstained' | 'failed';
  readonly counts: Readonly<{
    properties: number;
    includedProperties: number;
    excludedProperties: number;
    cohorts: number;
    cohortMembers: number;
    observations: number;
    sourceFacts: number;
    observationLinks: number;
    checks: number;
    outcomes: number;
    candidates: number;
    abstentions: number;
    qualityFailures: number;
  }>;
  readonly dbQueryCount: number;
  readonly durationMs: number;
  readonly qualitySummary: JsonObject;
  readonly performanceSummary: JsonObject;
  readonly errorDetail: JsonObject;
}

export interface ManagementPatternResultBatchReceipt {
  readonly outcome: 'applied' | 'already_applied';
  readonly batchHash: string;
  readonly rowCounts: Readonly<Record<string, number>>;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneRow(data: unknown, rpcName: string): Record<string, unknown> {
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) {
    throw new ManagementPatternStoreError({
      rpcName,
      code: null,
      message: 'database returned a malformed receipt',
      ambiguousCommit: true,
    });
  }
  return data[0];
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`management pattern receipt field ${key} is invalid`);
  }
  return value;
}

function requiredNonNegativeInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`management pattern receipt field ${key} is invalid`);
  }
  return value;
}

function isAmbiguousTransportError(error: RpcErrorShape): boolean {
  const message = [error.message, error.details, error.hint]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/\b(fetch|network|socket|timeout|timed out|connection|econn|aborted)\b/.test(message)) {
    return true;
  }
  return !error.code;
}

function rpcError(rpcName: string, error: RpcErrorShape): ManagementPatternStoreError {
  const message = error.message?.trim() || 'unknown database error';
  return new ManagementPatternStoreError({
    rpcName,
    code: error.code?.trim() || null,
    message,
    ambiguousCommit: isAmbiguousTransportError(error),
  });
}

/**
 * Service-role-only persistence boundary. Every mutation is organization-
 * scoped in both its RPC arguments and its database CAS; no table write is
 * exposed to browser code.
 */
export class ManagementPatternStore {
  private queryCountValue = 0;

  constructor(
    private readonly client: ManagementPatternRpcClient = supabaseAdmin as unknown as ManagementPatternRpcClient,
    private readonly signal?: AbortSignal,
  ) {}

  get queryCount(): number {
    return this.queryCountValue;
  }

  private async call(
    rpcName: string,
    args: Record<string, unknown>,
    retryAmbiguous: boolean,
  ): Promise<unknown> {
    const attempts = retryAmbiguous ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.queryCountValue += 1;
      const builder = this.client.rpc(rpcName, args);
      const request = this.signal && builder.abortSignal
        ? builder.abortSignal(this.signal)
        : builder;
      const { data, error } = await request;
      if (!error) return data;
      const wrapped = rpcError(rpcName, error);
      if (
        !wrapped.ambiguousCommit
        || this.signal?.aborted
        || attempt === attempts - 1
      ) throw wrapped;
    }
    throw new TypeError('unreachable management pattern RPC retry state');
  }

  async claimRun(input: ClaimManagementPatternRunInput): Promise<ManagementPatternClaim> {
    const rpcName = 'claim_management_pattern_run';
    const data = await this.call(rpcName, {
      p_organization_id: input.organizationId,
      p_run_key: input.runKey,
      p_owner_token: input.ownerToken,
      p_engine_version: input.engineVersion,
      p_evidence_schema_version: input.evidenceSchemaVersion,
      p_cohort_policy_version: input.cohortPolicyVersion,
      p_normalization_policy_version: input.normalizationPolicyVersion,
      p_dedupe_policy_version: input.dedupePolicyVersion,
      p_scope_policy_version: input.scopePolicyVersion,
      p_input_hash: input.inputHash,
      p_portfolio_snapshot: input.portfolioSnapshot,
      p_portfolio_snapshot_hash: input.portfolioSnapshotHash,
      p_evaluation_at: input.evaluationAt,
      p_source_as_of: input.sourceAsOf,
      p_topology_as_of: input.topologyAsOf,
      p_window_start: input.windowStart,
      p_window_end: input.windowEnd,
      // This runner is intentionally shadow-only. Active mode requires a
      // separately reviewed cutover path and cannot be selected by an API.
      p_projection_mode: 'shadow',
      p_triggered_by: input.triggeredBy,
      p_input_manifest: input.inputManifest,
      p_lease_seconds: input.leaseSeconds,
      p_supersedes_run_id: input.supersedesRunId,
      p_model_versions: {},
      p_model_call_budget: 0,
      p_token_budget: 0,
      p_cost_budget_microusd: 0,
      p_duration_budget_ms: input.durationBudgetMs,
      p_db_query_budget: input.dbQueryBudget,
    }, true);
    const row = oneRow(data, rpcName);
    const outcome = requiredString(row, 'outcome');
    if (![
      'claimed', 'resumed', 'reclaimed', 'busy', 'already_complete',
      'terminal_failed', 'input_conflict', 'partial_evidence_sealed',
    ].includes(outcome)) throw new TypeError(`unknown management pattern claim outcome ${outcome}`);
    const runId = requiredString(row, 'run_id');
    const fencingToken = requiredNonNegativeInteger(row, 'fencing_token');
    const leaseExpiresAt = requiredString(row, 'lease_expires_at');
    if (!UUID_RX.test(runId) || fencingToken < 1 || !Number.isFinite(Date.parse(leaseExpiresAt))) {
      throw new TypeError('management pattern claim receipt is invalid');
    }
    return Object.freeze({
      outcome: outcome as ManagementPatternClaimOutcome,
      runId,
      fencingToken,
      leaseExpiresAt,
    });
  }

  async appendInputBatch(input: {
    organizationId: string;
    runId: string;
    ownerToken: string;
    fencingToken: number;
    batch: ManagementPatternInputBatch;
  }): Promise<Readonly<{
    runPropertiesInserted: number;
    metricObservationsInserted: number;
    metricSourceFactsInserted: number;
  }>> {
    const rpcName = 'append_management_pattern_input_batch';
    const data = await this.call(rpcName, {
      p_organization_id: input.organizationId,
      p_run_id: input.runId,
      p_owner_token: input.ownerToken,
      p_fencing_token: input.fencingToken,
      p_run_properties: input.batch.runProperties,
      p_metric_observations: input.batch.metricObservations,
      p_metric_source_facts: input.batch.metricSourceFacts,
    }, true);
    const row = oneRow(data, rpcName);
    return Object.freeze({
      runPropertiesInserted: requiredNonNegativeInteger(row, 'run_properties_inserted'),
      metricObservationsInserted: requiredNonNegativeInteger(row, 'metric_observations_inserted'),
      metricSourceFactsInserted: requiredNonNegativeInteger(row, 'metric_source_facts_inserted'),
    });
  }

  async appendResultBatch(input: {
    organizationId: string;
    runId: string;
    ownerToken: string;
    fencingToken: number;
    results: ManagementPatternResultBatch;
  }): Promise<ManagementPatternResultBatchReceipt> {
    const rpcName = 'append_management_pattern_result_batch';
    const data = await this.call(rpcName, {
      p_organization_id: input.organizationId,
      p_run_id: input.runId,
      p_owner_token: input.ownerToken,
      p_fencing_token: input.fencingToken,
      p_results: input.results,
    }, true);
    const row = oneRow(data, rpcName);
    const outcome = requiredString(row, 'outcome');
    const batchHash = requiredString(row, 'batch_hash');
    if ((outcome !== 'applied' && outcome !== 'already_applied') || !SHA256_RX.test(batchHash)) {
      throw new TypeError('management pattern result-batch receipt is invalid');
    }
    const rawCounts = row.row_counts;
    if (!isRecord(rawCounts)) throw new TypeError('management pattern result-batch counts are invalid');
    const rowCounts: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawCounts)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`management pattern result-batch count ${key} is invalid`);
      }
      rowCounts[key] = value;
    }
    return Object.freeze({
      outcome,
      batchHash,
      rowCounts: Object.freeze(rowCounts),
    });
  }

  async finalizeRun(input: FinalizeManagementPatternRunInput): Promise<'finalized' | 'already_finalized'> {
    const rpcName = 'finalize_management_pattern_run';
    const counts = input.counts;
    const data = await this.call(rpcName, {
      p_organization_id: input.organizationId,
      p_run_id: input.runId,
      p_owner_token: input.ownerToken,
      p_fencing_token: input.fencingToken,
      p_terminal_status: input.terminalStatus,
      p_property_count: counts.properties,
      p_included_property_count: counts.includedProperties,
      p_excluded_property_count: counts.excludedProperties,
      p_cohort_count: counts.cohorts,
      p_cohort_member_count: counts.cohortMembers,
      p_observation_count: counts.observations,
      p_source_fact_count: counts.sourceFacts,
      p_observation_link_count: counts.observationLinks,
      p_check_count: counts.checks,
      p_outcome_count: counts.outcomes,
      p_candidate_count: counts.candidates,
      p_abstention_count: counts.abstentions,
      p_quality_failure_count: counts.qualityFailures,
      p_model_call_count: 0,
      p_prompt_token_count: 0,
      p_completion_token_count: 0,
      p_estimated_cost_microusd: 0,
      p_db_query_count: input.dbQueryCount,
      p_duration_ms: input.durationMs,
      p_quality_summary: input.qualitySummary,
      p_performance_summary: input.performanceSummary,
      p_cost_summary: {
        deterministic_checks_first: true,
        ai_calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        estimated_cost_microusd: 0,
      },
      p_error_detail: input.errorDetail,
    }, true);
    const row = oneRow(data, rpcName);
    const outcome = requiredString(row, 'outcome');
    const runId = requiredString(row, 'run_id');
    if ((outcome !== 'finalized' && outcome !== 'already_finalized') || runId !== input.runId) {
      throw new TypeError('management pattern finalize receipt is invalid');
    }
    return outcome;
  }
}
