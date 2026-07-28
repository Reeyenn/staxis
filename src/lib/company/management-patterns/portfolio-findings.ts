import 'server-only';

import { z } from 'zod';

import { companyFactIsSafe } from '@/lib/agent/prompt-tiers';
import { supabaseAdmin } from '@/lib/supabase-admin';

import { stableFingerprint } from './canonical';

/** Must move in lockstep with the portfolio consumer contract at cutover. */
export const MANAGEMENT_PATTERN_PORTFOLIO_FINDING_CONTRACT_VERSION =
  'portfolio-finding.v1' as const;
export const MANAGEMENT_PATTERN_PORTFOLIO_LOAD_VERSION =
  'management-pattern-portfolio-load.v1' as const;
export const MANAGEMENT_PATTERN_PORTFOLIO_MAX_FINDINGS = 40;
/** Weekly cadence plus one day for a delayed scheduled run. */
export const MANAGEMENT_PATTERN_PORTFOLIO_VALIDITY_DAYS = 8;

const identifier = z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9._:@/-]+$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();
const instant = z.string().datetime({ offset: true });

function uniqueArray<T extends z.ZodTypeAny>(item: T, maximum: number, minimum = 1) {
  return z.array(item).min(minimum).max(maximum).superRefine((values, context) => {
    if (new Set(values.map((value) => String(value))).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'values must be unique' });
    }
  });
}

const propertyIds = uniqueArray(uuid, 250);
const optionalPropertyIds = uniqueArray(uuid, 250, 0);
const authorizationPropertyIds = uniqueArray(uuid, 5_000);
const versionReceiptSchema = z.object({
  id: identifier,
  versions: uniqueArray(identifier, 20),
}).strict();

const runSchema = z.object({
  id: uuid.nullable(),
  projection_mode: z.enum(['active', 'shadow']),
  engine_version: identifier,
  evidence_schema_version: z.number().int().positive(),
  cohort_policy_version: identifier,
  normalization_policy_version: identifier,
  dedupe_policy_version: identifier,
  scope_policy_version: identifier,
  input_hash: hash.nullable(),
  portfolio_snapshot_hash: hash.nullable(),
  evaluation_at: instant,
  source_as_of: instant,
  window_start: instant,
  window_end: instant,
  completed_at: instant,
  terminal_status: z.enum(['succeeded', 'abstained']),
  source_query_id: identifier,
  source_query_version: identifier,
  valid_through: instant,
  coverage: z.object({
    selected_property_count: z.number().int().min(1).max(250),
    snapshot_property_count: z.number().int().nonnegative().max(250),
    included_property_count: z.number().int().nonnegative().max(250),
    excluded_property_count: z.number().int().nonnegative().max(250),
    missing_from_run_count: z.number().int().nonnegative().max(250),
    exclusion_reasons: z.array(z.object({
      code: identifier,
      count: z.number().int().positive().max(250),
    }).strict()).max(50),
    exclusion_reason_code_count: z.number().int().nonnegative(),
    exclusion_reasons_truncated: z.boolean(),
  }).strict(),
}).strict();

const direction = z.enum([
  'high',
  'low',
  'increasing',
  'decreasing',
  'stopped',
  'resumed',
  'not_applicable',
]);

const claimReceiptSchema = z.object({
  schema_version: z.literal(1),
  status: z.literal('supported'),
  pattern_key: hash,
  occurrence_key: hash,
  assertion: z.enum(['issue_present', 'issue_absent']),
  directions: uniqueArray(direction, 7),
  analysis_window_key: identifier,
}).strict();

const sourceCandidateSchema = z.object({
  candidate_id: uuid,
  candidate_hash: hash,
  root_key: hash,
  semantic_family: identifier,
  classified_scope: z.enum([
    'property_local',
    'peer_cohort',
    'group_region',
    'company_wide',
  ]),
  scope_evidence: z.record(z.string(), z.unknown()),
  summary: z.string().min(1).max(500),
  decision: z.literal('emit'),
  receipt_query_id: identifier,
  effective_at: instant,
  materiality_score: z.number().nonnegative(),
  claim_receipt: claimReceiptSchema,
  reconciliation_hash: hash,
  reconciliation_conclusion: z.literal('present'),
  detector_receipts: z.array(versionReceiptSchema).min(1).max(20),
  eligible_property_ids: propertyIds,
  evaluated_property_ids: propertyIds,
  affected_property_ids: propertyIds,
  metric_receipts: z.array(versionReceiptSchema).min(1).max(20),
  source_query_receipts: z.array(versionReceiptSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  for (const [field, receipts] of [
    ['detector_receipts', value.detector_receipts],
    ['metric_receipts', value.metric_receipts],
    ['source_query_receipts', value.source_query_receipts],
  ] as const) {
    if (new Set(receipts.map((receipt) => receipt.id)).size !== receipts.length) {
      context.addIssue({ code: 'custom', path: [field], message: 'receipt ids must be unique' });
    }
  }
});

const sourcePackageSchema = z.object({
  schema_version: z.literal(1),
  scope_receipt_id: uuid,
  account_id: uuid,
  organization_id: uuid.nullable(),
  selected_property_ids: optionalPropertyIds,
  authorized_property_count: z.number().int().positive().nullable(),
  authorization_hash: hash.nullable(),
  scope_hash: hash.nullable(),
  scope_receipt_expires_at: instant.nullable(),
  selection_was_truncated: z.literal(false),
  as_of: instant,
  max_findings: z.number().int().min(1).max(MANAGEMENT_PATTERN_PORTFOLIO_MAX_FINDINGS),
  status: z.enum([
    'loaded',
    'no_applicable_findings',
    'no_finalized_run',
    'stale',
    'abstained',
    'shadow_only',
    'incomplete_scope',
    'scope_too_large',
    'authorization_refused',
  ]),
  authorization_reason: identifier.nullable(),
  projection_mode: z.enum(['active', 'shadow']).nullable(),
  run: runSchema.nullable(),
  available_candidate_count: z.number().int().nonnegative(),
  candidates: z.array(sourceCandidateSchema).max(MANAGEMENT_PATTERN_PORTFOLIO_MAX_FINDINGS),
}).strict().superRefine((value, context) => {
  if (value.candidates.length > value.max_findings) {
    context.addIssue({ code: 'custom', path: ['candidates'], message: 'candidate page exceeds requested limit' });
  }
  for (const field of ['candidate_id', 'candidate_hash'] as const) {
    if (new Set(value.candidates.map((candidate) => candidate[field])).size !== value.candidates.length) {
      context.addIssue({ code: 'custom', path: ['candidates'], message: `${field} must be unique` });
    }
  }
});

const assertedReceiptSchema = z.object({
  id: uuid,
  accountId: uuid,
  organizationId: uuid,
  authorizedPropertyIds: authorizationPropertyIds,
  propertyIds: authorizationPropertyIds,
  authorizedPropertyCount: z.number().int().positive(),
  selectedPropertyCount: z.number().int().positive(),
  authorizationHash: hash,
  scopeHash: hash,
  expiresAt: instant,
}).passthrough();

const authorizationAssertionSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), receipt: assertedReceiptSchema }).passthrough(),
  z.object({ ok: z.literal(false), reason: identifier }).passthrough(),
]);

const scopeEvidenceSchema = z.object({
  organizationId: uuid,
  rootKey: hash,
  scope: z.enum(['property_local', 'peer_cohort', 'group_region', 'company_wide']),
  eligiblePropertyIds: propertyIds,
  evaluatedPropertyIds: propertyIds,
  affectedPropertyIds: propertyIds,
  matchedGroup: z.object({ groupId: identifier }).passthrough().nullable(),
  fingerprint: hash,
}).passthrough();

type SourcePackage = z.infer<typeof sourcePackageSchema>;
type SourceCandidate = z.infer<typeof sourceCandidateSchema>;
type SourceRun = z.infer<typeof runSchema>;
type ClaimBearingSourceRun = SourceRun & Readonly<{
  id: string;
  projection_mode: 'active';
  input_hash: string;
  portfolio_snapshot_hash: string;
}>;

function isClaimBearingSourceRun(run: SourceRun | null): run is ClaimBearingSourceRun {
  return run !== null
    && run.id !== null
    && run.projection_mode === 'active'
    && run.input_hash !== null
    && run.portfolio_snapshot_hash !== null
    && run.terminal_status === 'succeeded';
}

export interface ManagementPatternPortfolioFindingV1 {
  readonly version: typeof MANAGEMENT_PATTERN_PORTFOLIO_FINDING_CONTRACT_VERSION;
  readonly findingId: string;
  readonly organizationId: string;
  readonly producer: Readonly<{
    engineId: 'management-patterns';
    engineVersion: string;
    runId: string;
    runFingerprint: string;
    producedAt: string;
  }>;
  readonly lifecycle: Readonly<{
    status: 'active';
    validThrough: string;
  }>;
  readonly scope: Readonly<{
    organizationId: string;
    kind: 'property_local' | 'peer_cohort' | 'group_region' | 'company_wide';
    evaluatedPropertyIds: readonly string[];
    affectedPropertyIds: readonly string[];
    groupId: string | null;
    scopeFingerprint: string;
  }>;
  readonly claim: Readonly<{
    kind: 'pattern';
    statement: string;
    patternKey: string;
    assertion: 'issue_present' | 'issue_absent';
    direction: z.infer<typeof direction>;
    support: 'supported';
  }>;
  readonly evidence: Readonly<{
    evidenceFingerprint: string;
    queryId: string;
    queryVersion: string;
    metricIds: readonly string[];
    asOf: string;
    analysisWindowKey: string;
    sourceVersions: readonly Readonly<{ component: string; version: string }>[];
    coverage: Readonly<{ eligible: number; evaluated: number; affected: number }>;
  }>;
  readonly privacy: Readonly<{
    mode: 'named_authorized_properties';
    propertyCount: number;
  }>;
}

export type ManagementPatternPortfolioLoadStatus =
  | Exclude<SourcePackage['status'], 'authorization_refused'>
  | 'scope_changed'
  | 'unavailable';
export type ManagementPatternPortfolioRejectionCode =
  | 'unsafe_statement'
  | 'unsupported_direction_set'
  | 'contract_budget_exceeded';

export interface ManagementPatternPortfolioLoadReceipt {
  readonly version: typeof MANAGEMENT_PATTERN_PORTFOLIO_LOAD_VERSION;
  readonly accountId: string;
  readonly organizationId: string | null;
  readonly scopeReceiptId: string;
  readonly selectedPropertyIds: readonly string[];
  readonly authorizationHash: string | null;
  readonly scopeHash: string | null;
  readonly loadedAt: string;
  readonly status: ManagementPatternPortfolioLoadStatus;
  readonly projectionMode: 'active' | 'shadow' | null;
  readonly run: null | Readonly<{
    runId: string | null;
    runFingerprint: string | null;
    portfolioSnapshotFingerprint: string | null;
    projectionMode: 'active' | 'shadow';
    engineVersion: string;
    evidenceSchemaVersion: number;
    cohortPolicyVersion: string;
    normalizationPolicyVersion: string;
    dedupePolicyVersion: string;
    scopePolicyVersion: string;
    sourceQueryId: string;
    sourceQueryVersion: string;
    evaluationAt: string;
    sourceAsOf: string;
    windowStart: string;
    windowEnd: string;
    completedAt: string;
    validThrough: string;
    terminalStatus: 'succeeded' | 'abstained';
    coverage: Readonly<{
      selectedPropertyCount: number;
      snapshotPropertyCount: number;
      includedPropertyCount: number;
      excludedPropertyCount: number;
      missingFromRunCount: number;
      exclusionReasons: readonly Readonly<{ code: string; count: number }>[];
      exclusionReasonCodeCount: number;
      exclusionReasonsTruncated: boolean;
    }>;
  }>;
  readonly sourceAvailableCandidateCount: number;
  readonly omittedByLimitCount: number;
  readonly selectionWasTruncated: false;
  readonly coverage: Readonly<{
    authorizedPropertyCount: number | null;
    selectedPropertyCount: number;
    evaluatedPropertyCount: number;
    affectedPropertyCount: number;
    sourceCandidateCount: number;
    findingCount: number;
  }>;
  readonly truncation: Readonly<{
    occurred: boolean;
    limit: number;
    omittedCount: number;
  }>;
  readonly outage: Readonly<{
    occurred: boolean;
    stage: 'authorization_before_read' | 'source_read' | 'authorization_after_read' | null;
    reason: string | null;
  }>;
  readonly exclusions: readonly Readonly<{
    code: string;
    count: number;
  }>[];
  readonly rejectedCandidates: readonly Readonly<{
    candidateId: string;
    code: ManagementPatternPortfolioRejectionCode;
  }>[];
  readonly findings: readonly ManagementPatternPortfolioFindingV1[];
  readonly fingerprint: string;
}

interface RpcError {
  readonly message?: string;
}

export interface ManagementPatternPortfolioRpcCall extends PromiseLike<{
  readonly data: unknown;
  readonly error: RpcError | null;
}> {
  abortSignal?(signal: AbortSignal): ManagementPatternPortfolioRpcCall;
}

export interface ManagementPatternPortfolioRpcClient {
  rpc(functionName: string, args: Record<string, unknown>): ManagementPatternPortfolioRpcCall;
}

export interface ManagementPatternPortfolioAuthorizationAssertion {
  (input: Readonly<{ receiptId: string; accountId: string }>): Promise<unknown>;
}

export interface ManagementPatternPortfolioLoaderDependencies {
  readonly client?: ManagementPatternPortfolioRpcClient;
  readonly assertAuthorizationScopeReceipt?: ManagementPatternPortfolioAuthorizationAssertion;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isSubset(values: readonly string[], universe: ReadonlySet<string>): boolean {
  return values.every((value) => universe.has(value));
}

const UNPRINTABLE_RX = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

function cleanStoredText(value: string): string {
  return value
    .replace(UNPRINTABLE_RX, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function versionEntries(
  componentKind: 'detector' | 'metric' | 'source-query',
  receipts: readonly z.infer<typeof versionReceiptSchema>[],
): readonly Readonly<{ component: string; version: string }>[] {
  return Object.freeze(receipts.flatMap((receipt) => (
    [...receipt.versions].sort().map((version, index) => Object.freeze({
      component: `${componentKind}/${receipt.id}@${index + 1}`,
      version,
    }))
  )));
}

function sourceVersions(
  run: SourceRun,
  candidate: SourceCandidate,
): readonly Readonly<{ component: string; version: string }>[] | null {
  const values = [
    { component: 'management-pattern-engine', version: run.engine_version },
    { component: 'management-pattern-evidence-schema', version: `v${run.evidence_schema_version}` },
    { component: 'management-pattern-cohort-policy', version: run.cohort_policy_version },
    { component: 'management-pattern-normalization-policy', version: run.normalization_policy_version },
    { component: 'management-pattern-dedupe-policy', version: run.dedupe_policy_version },
    { component: 'management-pattern-scope-policy', version: run.scope_policy_version },
    ...versionEntries('detector', candidate.detector_receipts),
    ...versionEntries('metric', candidate.metric_receipts),
    ...versionEntries('source-query', candidate.source_query_receipts),
  ].sort((left, right) => (
    left.component.localeCompare(right.component) || left.version.localeCompare(right.version)
  ));
  if (values.length > 20 || new Set(values.map((value) => value.component)).size !== values.length) {
    return null;
  }
  return values.every((value) => (
    identifier.safeParse(value.component).success && identifier.safeParse(value.version).success
  )) ? Object.freeze(values.map((value) => Object.freeze(value))) : null;
}

function requireSourcePackageConsistency(source: SourcePackage, input: {
  accountId: string;
  scopeReceiptId: string;
  receipt: z.infer<typeof assertedReceiptSchema>;
  selectedPropertyIds: readonly string[];
  asOf: string;
  maxFindings: number;
}): void {
  if (
    source.account_id !== input.accountId
    || source.scope_receipt_id !== input.scopeReceiptId
    || Date.parse(source.as_of) !== Date.parse(input.asOf)
    || source.max_findings !== input.maxFindings
  ) throw new Error('management pattern portfolio source receipt does not match the request');
  if (source.status === 'authorization_refused') {
    if (
      source.organization_id !== null
      || source.selected_property_ids.length !== 0
      || source.run !== null
      || source.candidates.length !== 0
      || source.available_candidate_count !== 0
      || source.authorization_reason === null
    ) throw new Error('management pattern portfolio authorization refusal is inconsistent');
    return;
  }
  if (
    source.organization_id !== input.receipt.organizationId
    || !sameValues(source.selected_property_ids, input.selectedPropertyIds)
    || source.authorized_property_count !== input.receipt.authorizedPropertyCount
    || source.authorization_hash !== input.receipt.authorizationHash
    || source.scope_hash !== input.receipt.scopeHash
    || source.scope_receipt_expires_at !== input.receipt.expiresAt
    || source.authorization_reason !== null
  ) throw new Error('management pattern portfolio source authorization receipt changed');
  if (source.available_candidate_count < source.candidates.length) {
    throw new Error('management pattern portfolio source candidate count is inconsistent');
  }
  if (source.status === 'loaded') {
    if (
      source.projection_mode !== 'active'
      || !isClaimBearingSourceRun(source.run)
      || source.run.coverage.missing_from_run_count !== 0
      || source.candidates.length === 0
    ) throw new Error('management pattern portfolio loaded receipt is inconsistent');
    const validThroughMs = Date.parse(source.run.valid_through);
    const expectedValidThrough = Date.parse(source.run.evaluation_at)
      + MANAGEMENT_PATTERN_PORTFOLIO_VALIDITY_DAYS * 86_400_000;
    if (validThroughMs !== expectedValidThrough || validThroughMs <= Date.parse(source.as_of)) {
      throw new Error('management pattern portfolio source used an invalid validity policy');
    }
  } else if (['no_finalized_run', 'scope_too_large'].includes(source.status)) {
    if (source.run !== null || source.projection_mode !== null) {
      throw new Error('management pattern portfolio empty receipt contains run metadata');
    }
  } else {
    if (
      source.run === null
      || source.run.id !== null
      || source.run.input_hash !== null
      || source.run.portfolio_snapshot_hash !== null
      || source.run.projection_mode !== source.projection_mode
    ) throw new Error('management pattern portfolio redacted run receipt is inconsistent');
    const validThroughMs = Date.parse(source.run.valid_through);
    const expectedValidThrough = Date.parse(source.run.evaluation_at)
      + MANAGEMENT_PATTERN_PORTFOLIO_VALIDITY_DAYS * 86_400_000;
    if (validThroughMs !== expectedValidThrough) {
      throw new Error('management pattern portfolio redacted run used an invalid validity policy');
    }
    if (
      (source.status === 'shadow_only' && source.run.projection_mode !== 'shadow')
      || (['stale', 'abstained', 'no_applicable_findings', 'incomplete_scope'].includes(source.status)
        && source.run.projection_mode !== 'active')
      || (source.status === 'stale' && validThroughMs > Date.parse(source.as_of))
      || (['abstained', 'no_applicable_findings', 'incomplete_scope'].includes(source.status)
        && validThroughMs <= Date.parse(source.as_of))
      || (source.status === 'abstained' && source.run.terminal_status !== 'abstained')
      || (source.status === 'no_applicable_findings'
        && (
          source.run.terminal_status !== 'succeeded'
          || source.run.coverage.missing_from_run_count !== 0
        ))
      || (source.status === 'incomplete_scope'
        && (
          source.run.coverage.missing_from_run_count === 0
          || source.run.terminal_status !== 'succeeded'
        ))
    ) throw new Error('management pattern portfolio source status/projection mode is inconsistent');
  }
  if (source.status !== 'loaded' && (
    source.candidates.length !== 0 || source.available_candidate_count !== 0
  )) {
    throw new Error('management pattern portfolio non-loaded receipt contains claim metadata');
  }
  if (source.run !== null) {
    if (
      Date.parse(source.run.window_start) >= Date.parse(source.run.window_end)
      || Date.parse(source.run.source_as_of) > Date.parse(source.run.evaluation_at)
      || Date.parse(source.run.source_as_of) > Date.parse(source.run.completed_at)
      || Date.parse(source.run.evaluation_at) > Date.parse(source.run.completed_at)
      || Date.parse(source.run.completed_at) > Date.parse(source.run.valid_through)
    ) throw new Error('management pattern portfolio run timestamps are contradictory');
    const coverage = source.run.coverage;
    const exclusionReasonCodes = coverage.exclusion_reasons.map((reason) => reason.code);
    if (
      coverage.selected_property_count !== source.selected_property_ids.length
      || coverage.snapshot_property_count
        !== coverage.included_property_count + coverage.excluded_property_count
      || coverage.selected_property_count
        !== coverage.snapshot_property_count + coverage.missing_from_run_count
      || coverage.exclusion_reasons.length
        !== Math.min(coverage.exclusion_reason_code_count, 50)
      || new Set(exclusionReasonCodes).size !== exclusionReasonCodes.length
      || coverage.exclusion_reasons_truncated !== (coverage.exclusion_reason_code_count > 50)
    ) throw new Error('management pattern portfolio run coverage receipt is inconsistent');
  }
}

function findingFromSource(
  organizationId: string,
  selected: ReadonlySet<string>,
  run: ClaimBearingSourceRun,
  candidate: SourceCandidate,
): ManagementPatternPortfolioFindingV1 | ManagementPatternPortfolioRejectionCode {
  const scopeResult = scopeEvidenceSchema.safeParse(candidate.scope_evidence);
  if (!scopeResult.success) {
    throw new Error(`management pattern candidate ${candidate.candidate_id} has malformed scope evidence`);
  }
  const scope = scopeResult.data;
  const eligible = sortedUnique(candidate.eligible_property_ids);
  const evaluated = sortedUnique(candidate.evaluated_property_ids);
  const affected = sortedUnique(candidate.affected_property_ids);
  if (
    scope.organizationId !== organizationId
    || scope.rootKey !== candidate.root_key
    || scope.scope !== candidate.classified_scope
    || !sameValues(scope.eligiblePropertyIds, eligible)
    || !sameValues(scope.evaluatedPropertyIds, evaluated)
    || !sameValues(scope.affectedPropertyIds, affected)
    || !isSubset(affected, new Set(evaluated))
    || !isSubset(evaluated, new Set(eligible))
    || !isSubset(eligible, selected)
  ) throw new Error(`management pattern candidate ${candidate.candidate_id} scope graph is inconsistent`);
  if (
    (scope.scope === 'property_local' && affected.length !== 1)
    || (scope.scope === 'company_wide' && evaluated.length < 2)
    || (scope.scope === 'group_region') !== (scope.matchedGroup !== null)
  ) throw new Error(`management pattern candidate ${candidate.candidate_id} scope classification is inconsistent`);
  if (
    candidate.claim_receipt.pattern_key !== candidate.root_key
    || candidate.claim_receipt.directions.length !== 1
  ) return 'unsupported_direction_set';
  if (candidate.receipt_query_id !== run.source_query_id) {
    throw new Error(`management pattern candidate ${candidate.candidate_id} query receipt is inconsistent`);
  }
  const statement = cleanStoredText(candidate.summary);
  if (!statement || !companyFactIsSafe(candidate.summary)) return 'unsafe_statement';
  const metricIds = sortedUnique(candidate.metric_receipts.map((receipt) => receipt.id));
  const versions = sourceVersions(run, candidate);
  if (metricIds.length > 12 || versions === null) return 'contract_budget_exceeded';
  const evidenceFingerprint = stableFingerprint({
    candidateHash: candidate.candidate_hash,
    reconciliationHash: candidate.reconciliation_hash,
    runInputHash: run.input_hash,
    evaluatedPropertyIds: evaluated,
    affectedPropertyIds: affected,
    metricReceipts: candidate.metric_receipts,
    sourceQueryReceipts: candidate.source_query_receipts,
  }, 'portfolio-finding-evidence');
  return Object.freeze({
    version: MANAGEMENT_PATTERN_PORTFOLIO_FINDING_CONTRACT_VERSION,
    findingId: candidate.candidate_id,
    organizationId,
    producer: Object.freeze({
      engineId: 'management-patterns' as const,
      engineVersion: run.engine_version,
      runId: run.id,
      runFingerprint: run.input_hash,
      producedAt: run.completed_at,
    }),
    lifecycle: Object.freeze({
      status: 'active' as const,
      validThrough: run.valid_through,
    }),
    scope: Object.freeze({
      organizationId,
      kind: scope.scope,
      evaluatedPropertyIds: evaluated,
      affectedPropertyIds: affected,
      groupId: scope.matchedGroup?.groupId ?? null,
      scopeFingerprint: scope.fingerprint,
    }),
    claim: Object.freeze({
      kind: 'pattern' as const,
      statement,
      patternKey: candidate.claim_receipt.pattern_key,
      assertion: candidate.claim_receipt.assertion,
      direction: candidate.claim_receipt.directions[0],
      support: 'supported' as const,
    }),
    evidence: Object.freeze({
      evidenceFingerprint,
      queryId: run.source_query_id,
      queryVersion: run.source_query_version,
      metricIds,
      asOf: run.source_as_of,
      analysisWindowKey: candidate.claim_receipt.analysis_window_key,
      sourceVersions: versions,
      coverage: Object.freeze({
        eligible: eligible.length,
        evaluated: evaluated.length,
        affected: affected.length,
      }),
    }),
    privacy: Object.freeze({
      mode: 'named_authorized_properties' as const,
      propertyCount: evaluated.length,
    }),
  });
}

type AssertedReceipt = z.infer<typeof assertedReceiptSchema>;

async function defaultAuthorizationAssertion(input: Readonly<{
  receiptId: string;
  accountId: string;
}>): Promise<unknown> {
  // Kept dynamic so the producer's pure contract tests can inject the exact
  // assertion boundary. The production path always resolves this server-only
  // authoritative implementation; there is no permissive fallback.
  const authorization = await import('@/lib/authorization/server');
  return authorization.assertAuthorizationScopeReceipt(input);
}

function assertedReceipt(result: unknown, assertedAtMs: number):
  | Readonly<{ ok: true; receipt: AssertedReceipt }>
  | Readonly<{ ok: false; reason: string }> {
  const parsed = authorizationAssertionSchema.safeParse(result);
  if (!parsed.success) return { ok: false, reason: 'store_unavailable' };
  if (!parsed.data.ok) return parsed.data;
  const receipt = parsed.data.receipt;
  if (
    receipt.authorizedPropertyCount !== receipt.authorizedPropertyIds.length
    || receipt.selectedPropertyCount !== receipt.propertyIds.length
    || !isSubset(receipt.propertyIds, new Set(receipt.authorizedPropertyIds))
    || Date.parse(receipt.expiresAt) <= assertedAtMs
  ) return { ok: false, reason: 'store_unavailable' };
  return { ok: true, receipt };
}

function sameAssertedReceipt(left: AssertedReceipt, right: AssertedReceipt): boolean {
  return left.id === right.id
    && left.accountId === right.accountId
    && left.organizationId === right.organizationId
    && left.authorizationHash === right.authorizationHash
    && left.scopeHash === right.scopeHash
    && left.expiresAt === right.expiresAt
    && left.authorizedPropertyCount === right.authorizedPropertyCount
    && left.selectedPropertyCount === right.selectedPropertyCount
    && sameValues(left.authorizedPropertyIds, right.authorizedPropertyIds)
    && sameValues(left.propertyIds, right.propertyIds);
}

type LoaderOutageStage = ManagementPatternPortfolioLoadReceipt['outage']['stage'];

function emptyLoadReceipt(input: {
  accountId: string;
  scopeReceiptId: string;
  selectedPropertyIds: readonly string[];
  asOf: string;
  maxFindings: number;
  status: 'scope_changed' | 'scope_too_large' | 'unavailable';
  receipt?: AssertedReceipt | null;
  outageStage?: Exclude<LoaderOutageStage, null> | null;
  reason: string;
}): ManagementPatternPortfolioLoadReceipt {
  const receipt = input.receipt ?? null;
  const outage = input.status === 'unavailable';
  const payload = {
    version: MANAGEMENT_PATTERN_PORTFOLIO_LOAD_VERSION,
    accountId: input.accountId,
    organizationId: receipt?.organizationId ?? null,
    scopeReceiptId: input.scopeReceiptId,
    selectedPropertyIds: Object.freeze([...input.selectedPropertyIds]),
    authorizationHash: receipt?.authorizationHash ?? null,
    scopeHash: receipt?.scopeHash ?? null,
    loadedAt: input.asOf,
    status: input.status,
    projectionMode: null,
    run: null,
    sourceAvailableCandidateCount: 0,
    omittedByLimitCount: 0,
    selectionWasTruncated: false as const,
    coverage: Object.freeze({
      authorizedPropertyCount: receipt?.authorizedPropertyCount ?? null,
      selectedPropertyCount: input.selectedPropertyIds.length,
      evaluatedPropertyCount: 0,
      affectedPropertyCount: 0,
      sourceCandidateCount: 0,
      findingCount: 0,
    }),
    truncation: Object.freeze({
      occurred: false,
      limit: input.maxFindings,
      omittedCount: 0,
    }),
    outage: Object.freeze({
      occurred: outage,
      stage: outage ? input.outageStage ?? 'source_read' : null,
      reason: outage ? input.reason : null,
    }),
    exclusions: Object.freeze([Object.freeze({ code: input.reason, count: 1 })]),
    rejectedCandidates: Object.freeze([]),
    findings: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    fingerprint: stableFingerprint(payload, 'management-pattern-portfolio-load'),
  });
}

function runReceipt(run: SourceRun): NonNullable<ManagementPatternPortfolioLoadReceipt['run']> {
  return Object.freeze({
    runId: run.id,
    runFingerprint: run.input_hash,
    portfolioSnapshotFingerprint: run.portfolio_snapshot_hash,
    projectionMode: run.projection_mode,
    engineVersion: run.engine_version,
    evidenceSchemaVersion: run.evidence_schema_version,
    cohortPolicyVersion: run.cohort_policy_version,
    normalizationPolicyVersion: run.normalization_policy_version,
    dedupePolicyVersion: run.dedupe_policy_version,
    scopePolicyVersion: run.scope_policy_version,
    sourceQueryId: run.source_query_id,
    sourceQueryVersion: run.source_query_version,
    evaluationAt: run.evaluation_at,
    sourceAsOf: run.source_as_of,
    windowStart: run.window_start,
    windowEnd: run.window_end,
    completedAt: run.completed_at,
    validThrough: run.valid_through,
    terminalStatus: run.terminal_status,
    coverage: Object.freeze({
      selectedPropertyCount: run.coverage.selected_property_count,
      snapshotPropertyCount: run.coverage.snapshot_property_count,
      includedPropertyCount: run.coverage.included_property_count,
      excludedPropertyCount: run.coverage.excluded_property_count,
      missingFromRunCount: run.coverage.missing_from_run_count,
      exclusionReasons: Object.freeze(run.coverage.exclusion_reasons.map((reason) => Object.freeze({
        code: reason.code,
        count: reason.count,
      }))),
      exclusionReasonCodeCount: run.coverage.exclusion_reason_code_count,
      exclusionReasonsTruncated: run.coverage.exclusion_reasons_truncated,
    }),
  });
}

/**
 * Read-only, service-role producer over the immutable evidence plane. It never
 * reads or activates the mutable company_findings projection. Authorization
 * is asserted before, inside, and after the atomic evidence read; organization
 * and property scope come only from that account-bound receipt. Shadow runs
 * remain observable as an explicit zero-claim status but never enter prompts.
 */
export async function loadManagementPatternPortfolioFindings(
  input: {
    readonly accountId: string;
    readonly scopeReceiptId: string;
    readonly selectedPropertyIds: readonly string[];
    readonly asOf?: Date;
    readonly maxFindings?: number;
    readonly signal?: AbortSignal;
  },
  dependencies: ManagementPatternPortfolioLoaderDependencies = {},
): Promise<ManagementPatternPortfolioLoadReceipt> {
  const asOf = input.asOf ? new Date(input.asOf.getTime()) : new Date();
  if (Number.isNaN(asOf.getTime())) throw new TypeError('asOf must be a valid Date');
  const parsedInput = z.object({
    accountId: uuid,
    scopeReceiptId: uuid,
    selectedPropertyIds: propertyIds,
    maxFindings: z.number().int().min(1).max(MANAGEMENT_PATTERN_PORTFOLIO_MAX_FINDINGS),
  }).strict().parse({
    accountId: input.accountId,
    scopeReceiptId: input.scopeReceiptId,
    selectedPropertyIds: input.selectedPropertyIds,
    maxFindings: input.maxFindings ?? MANAGEMENT_PATTERN_PORTFOLIO_MAX_FINDINGS,
  });
  const asOfIso = asOf.toISOString();
  const selectedPropertyIds = sortedUnique(parsedInput.selectedPropertyIds);
  const assertAuthorization = dependencies.assertAuthorizationScopeReceipt
    ?? defaultAuthorizationAssertion;
  let before: ReturnType<typeof assertedReceipt>;
  try {
    before = assertedReceipt(await assertAuthorization({
      receiptId: parsedInput.scopeReceiptId,
      accountId: parsedInput.accountId,
    }), asOf.getTime());
  } catch {
    before = { ok: false, reason: 'store_unavailable' };
  }
  if (!before.ok) {
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: before.reason === 'store_unavailable' ? 'unavailable' : 'scope_changed',
      outageStage: 'authorization_before_read',
      reason: before.reason,
    });
  }
  if (
    before.receipt.id !== parsedInput.scopeReceiptId
    || before.receipt.accountId !== parsedInput.accountId
    || !sameValues(selectedPropertyIds, before.receipt.propertyIds)
  ) {
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: 'scope_changed',
      receipt: before.receipt,
      reason: 'selected_scope_mismatch',
    });
  }
  if (input.signal?.aborted) {
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: 'unavailable',
      receipt: before.receipt,
      outageStage: 'source_read',
      reason: 'request_aborted',
    });
  }

  const client = dependencies.client
    ?? supabaseAdmin as unknown as ManagementPatternPortfolioRpcClient;
  let rawData: unknown;
  try {
    const request = client.rpc('load_management_pattern_portfolio_findings_source', {
      p_scope_receipt_id: parsedInput.scopeReceiptId,
      p_account_id: parsedInput.accountId,
      p_as_of: asOfIso,
      p_max_findings: parsedInput.maxFindings,
    });
    const { data, error } = await (input.signal && request.abortSignal
      ? request.abortSignal(input.signal)
      : request);
    if (error) throw new Error('source RPC failed');
    rawData = data;
  } catch {
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: 'unavailable',
      receipt: before.receipt,
      outageStage: 'source_read',
      reason: input.signal?.aborted ? 'request_aborted' : 'source_unavailable',
    });
  }
  const sourceResult = sourcePackageSchema.safeParse(rawData);
  if (!sourceResult.success) {
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: 'unavailable',
      receipt: before.receipt,
      outageStage: 'source_read',
      reason: 'source_contract_mismatch',
    });
  }
  const source = sourceResult.data;
  try {
    requireSourcePackageConsistency(source, {
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      receipt: before.receipt,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
    });
  } catch {
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: 'unavailable',
      receipt: before.receipt,
      outageStage: 'source_read',
      reason: 'source_receipt_mismatch',
    });
  }

  let after: ReturnType<typeof assertedReceipt>;
  try {
    after = assertedReceipt(await assertAuthorization({
      receiptId: parsedInput.scopeReceiptId,
      accountId: parsedInput.accountId,
    }), asOf.getTime());
  } catch {
    after = { ok: false, reason: 'store_unavailable' };
  }
  if (!after.ok || !sameAssertedReceipt(before.receipt, after.receipt)) {
    const reason = after.ok ? 'scope_changed' : after.reason;
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: reason === 'store_unavailable' ? 'unavailable' : 'scope_changed',
      receipt: before.receipt,
      outageStage: 'authorization_after_read',
      reason,
    });
  }
  if (source.status === 'authorization_refused') {
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: source.authorization_reason === 'store_unavailable' ? 'unavailable' : 'scope_changed',
      receipt: after.receipt,
      outageStage: 'source_read',
      reason: source.authorization_reason ?? 'scope_changed',
    });
  }

  const findings: ManagementPatternPortfolioFindingV1[] = [];
  const rejectedCandidates: {
    candidateId: string;
    code: ManagementPatternPortfolioRejectionCode;
  }[] = [];
  try {
    if (source.status === 'loaded') {
      if (!isClaimBearingSourceRun(source.run)) throw new Error('claim-bearing run missing');
      const selected = new Set(selectedPropertyIds);
      for (const candidate of source.candidates) {
        const mapped = findingFromSource(
          before.receipt.organizationId,
          selected,
          source.run,
          candidate,
        );
        if (typeof mapped === 'string') {
          rejectedCandidates.push({ candidateId: candidate.candidate_id, code: mapped });
        } else {
          findings.push(mapped);
        }
      }
    }
  } catch {
    return emptyLoadReceipt({
      accountId: parsedInput.accountId,
      scopeReceiptId: parsedInput.scopeReceiptId,
      selectedPropertyIds,
      asOf: asOfIso,
      maxFindings: parsedInput.maxFindings,
      status: 'unavailable',
      receipt: after.receipt,
      outageStage: 'source_read',
      reason: 'candidate_graph_mismatch',
    });
  }
  findings.sort((left, right) => left.findingId.localeCompare(right.findingId));
  rejectedCandidates.sort((left, right) => (
    left.candidateId.localeCompare(right.candidateId) || left.code.localeCompare(right.code)
  ));
  const omittedByLimitCount = Math.max(
    0,
    source.available_candidate_count - source.candidates.length,
  );
  const evaluatedPropertyIds = sortedUnique(findings.flatMap((finding) => (
    finding.scope.evaluatedPropertyIds
  )));
  const affectedPropertyIds = sortedUnique(findings.flatMap((finding) => (
    finding.scope.affectedPropertyIds
  )));
  const exclusions = new Map<string, number>();
  const addExclusion = (code: string, count: number) => {
    if (count > 0) exclusions.set(code, (exclusions.get(code) ?? 0) + count);
  };
  if (source.status !== 'loaded') addExclusion(source.status, 1);
  if (source.run !== null) {
    addExclusion('property_missing_from_run', source.run.coverage.missing_from_run_count);
    for (const reason of source.run.coverage.exclusion_reasons) {
      addExclusion(`run/${reason.code}`, reason.count);
    }
    if (source.run.coverage.exclusion_reasons_truncated) {
      addExclusion(
        'run/exclusion_reason_budget',
        source.run.coverage.exclusion_reason_code_count
          - source.run.coverage.exclusion_reasons.length,
      );
    }
  }
  for (const rejected of rejectedCandidates) addExclusion(`candidate/${rejected.code}`, 1);
  addExclusion('finding_limit', omittedByLimitCount);
  const exclusionRows = Object.freeze([...exclusions.entries()]
    .map(([code, count]) => Object.freeze({ code, count }))
    .sort((left, right) => left.code.localeCompare(right.code)));
  const payload = {
    version: MANAGEMENT_PATTERN_PORTFOLIO_LOAD_VERSION,
    accountId: parsedInput.accountId,
    organizationId: before.receipt.organizationId,
    scopeReceiptId: parsedInput.scopeReceiptId,
    selectedPropertyIds,
    authorizationHash: before.receipt.authorizationHash,
    scopeHash: before.receipt.scopeHash,
    loadedAt: asOfIso,
    status: source.status,
    projectionMode: source.projection_mode,
    run: source.run === null ? null : runReceipt(source.run),
    sourceAvailableCandidateCount: source.available_candidate_count,
    omittedByLimitCount,
    selectionWasTruncated: false as const,
    coverage: Object.freeze({
      authorizedPropertyCount: before.receipt.authorizedPropertyCount,
      selectedPropertyCount: selectedPropertyIds.length,
      evaluatedPropertyCount: evaluatedPropertyIds.length,
      affectedPropertyCount: affectedPropertyIds.length,
      sourceCandidateCount: source.available_candidate_count,
      findingCount: findings.length,
    }),
    truncation: Object.freeze({
      occurred: omittedByLimitCount > 0,
      limit: parsedInput.maxFindings,
      omittedCount: omittedByLimitCount,
    }),
    outage: Object.freeze({
      occurred: false,
      stage: null,
      reason: null,
    }),
    exclusions: exclusionRows,
    rejectedCandidates: Object.freeze(rejectedCandidates.map((item) => Object.freeze(item))),
    findings: Object.freeze(findings),
  };
  return Object.freeze({
    ...payload,
    fingerprint: stableFingerprint(payload, 'management-pattern-portfolio-load'),
  });
}
