import {
  ACTION_CONTRACT_VERSION,
  LIFECYCLE_CONTRACT_VERSION,
  SOURCE_FACT_CONTRACT_VERSION,
  type ActionAdmissionContract,
  type ActionApprovalContract,
  type ActionAuthorityContract,
  type ActionEffectContract,
  type AuthorityKind,
  type ExecutionReceiptContract,
  type FrozenInputContract,
  type IdempotencyContract,
  type OutcomeContract,
  type OutcomeObservability,
  type OutcomeVerificationState,
  type SourceCompleteness,
  type SourceFreshness,
  type SourceKind,
  validateActionContract,
} from './foundation';

export { LIFECYCLE_CONTRACT_VERSION } from './foundation';

export const LIFECYCLE_STATES = [
  'observed',
  'proposed',
  'approved',
  'executed',
  'outcome_verified',
  'not_observable',
  'unverifiable',
] as const;
export type LifecycleState = typeof LIFECYCLE_STATES[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export interface LifecycleOwnerSnapshot {
  kind: AuthorityKind | 'unassigned';
  label: string | null;
  role: string | null;
}

export interface LifecycleSourceSummary {
  id: string;
  kind: SourceKind;
  label: string;
  reference: string;
  contractVersion: typeof SOURCE_FACT_CONTRACT_VERSION;
  sourceDefinitionId: string;
  claimScope: string;
  receiptId: string;
  receiptHash: string;
  effectiveAt: string;
  asOf: string;
  observedAt: string;
  receivedAt: string;
  completeness: SourceCompleteness;
  completenessReason: string | null;
  completenessRequired: SourceCompleteness;
  freshness: SourceFreshness;
  freshnessMaxAgeSeconds: number;
  owner: LifecycleOwnerSnapshot;
  authority: number;
  precedence: number;
}

export interface LifecycleActionProjection {
  id: string;
  kind: string;
  effect: ActionAdmissionContract['effect'];
  targetId: string | null;
  approval: ActionAdmissionContract['approval'] & {
    state: 'required' | 'approved' | 'rejected' | 'not_required';
  };
  frozenInput: ActionAdmissionContract['frozenInput'] & { hash: string | null };
  idempotency: ActionAdmissionContract['idempotency'];
  receipt: ActionAdmissionContract['receipt'];
  outcome: ActionAdmissionContract['outcome'] & {
    state: OutcomeVerificationState;
    basis: string | null;
    observedAt: string | null;
  };
}

export interface LifecycleDomainWorkItem {
  kind: string;
  id: string;
  label: string | null;
  href: null;
  owner: LifecycleOwnerSnapshot;
  /** Custody snapshot time; parser requires this even when owner is unassigned. */
  observedAt: string;
}

export interface LifecycleAuthorityScope {
  claimScope: string;
  authority: number;
  precedence: number;
}

export interface LifecycleOutcome {
  state: OutcomeVerificationState;
  basis: string | null;
  sourceFactId: string | null;
  observedAt: string | null;
}

export interface LifecycleProjection {
  contractVersion: typeof LIFECYCLE_CONTRACT_VERSION;
  id: string;
  propertyId: string;
  entity: { kind: string; id: string | null; label: string | null };
  title: string;
  summary: string;
  state: LifecycleState;
  priorStates: readonly LifecycleState[];
  findingId: string;
  proposalId: string | null;
  approvalId: string | null;
  executionReceiptId: string | null;
  sourceFactIds: readonly string[];
  sources: readonly LifecycleSourceSummary[];
  effectiveAt: string;
  asOf: string;
  observedAt: string;
  recordedAt: string;
  freshness: { status: SourceFreshness; maxAgeSeconds: number | null };
  completeness: { status: SourceCompleteness; reason: string | null };
  authority: { owner: LifecycleOwnerSnapshot; level: number | null; precedence: number | null; scopes: readonly LifecycleAuthorityScope[] };
  action: LifecycleActionProjection | null;
  domainWorkItem: LifecycleDomainWorkItem | null;
  outcome: LifecycleOutcome | null;
  outcomeEvidenceId: string | null;
  reason: string | null;
}

export interface LifecycleResponse {
  contractVersion: typeof LIFECYCLE_CONTRACT_VERSION;
  generatedAt: string;
  items: readonly LifecycleProjection[];
}

export const ACTION_RECEIPT_CONTRACT_VERSION = ACTION_CONTRACT_VERSION;

export function lifecycleStateRank(state: LifecycleState): number {
  return LIFECYCLE_STATES.indexOf(state);
}

/** Parse only the closed lifecycle vocabulary. Unknown values never become a success state. */
export function parseLifecycleState(value: unknown): LifecycleState | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'observed':
    case 'proposed':
    case 'approved':
    case 'executed':
    case 'outcome_verified':
    case 'not_observable':
    case 'unverifiable':
      return value;
    default:
      return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function text(value: unknown, max = 2_000): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function nullableText(value: unknown, max = 2_000): string | null | undefined {
  if (value === null) return null;
  const parsed = text(value, max);
  return parsed ?? undefined;
}

function uuid(value: unknown): string | null {
  if (typeof value !== 'string' || !UUID_RE.test(value)) return null;
  return value.toLowerCase();
}

function nullableUuid(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = uuid(value);
  return parsed ?? undefined;
}

function iso(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : null;
}

function nullableIso(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = iso(value);
  return parsed ?? undefined;
}

function authorityInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function sha256(value: unknown): string | null {
  return typeof value === 'string' && SHA256_RE.test(value) ? value : null;
}

function sourceKind(value: unknown): SourceKind | null {
  if (value === 'app_owned' || value === 'pms_report') return value;
  return null;
}

function sourceCompleteness(value: unknown): SourceCompleteness | null {
  if (value === 'complete' || value === 'partial' || value === 'unknown') return value;
  return null;
}

function sourceFreshness(value: unknown): SourceFreshness | null {
  if (value === 'fresh' || value === 'stale' || value === 'unknown') return value;
  return null;
}

function completenessMeets(actual: SourceCompleteness, required: SourceCompleteness): boolean {
  const rank: Record<SourceCompleteness, number> = { unknown: 0, partial: 1, complete: 2 };
  return rank[actual] >= rank[required];
}

function safeSourceReference(value: string): boolean {
  return !/[\\/]/.test(value)
    && !/(^|:)https?:\/\//i.test(value)
    && !/(attachment|storage|bucket|raw[_-]?path)/i.test(value);
}

function ownerKind(value: unknown): LifecycleOwnerSnapshot['kind'] | null {
  if (value === 'app' || value === 'pms' || value === 'hotel' || value === 'company' || value === 'staxis' || value === 'human' || value === 'system' || value === 'unknown' || value === 'unassigned') {
    return value;
  }
  return null;
}

function outcomeState(value: unknown): OutcomeVerificationState | null {
  if (value === 'pending' || value === 'verified' || value === 'not_observable' || value === 'unverifiable' || value === 'reverted') return value;
  return null;
}

function outcomeObservability(value: unknown): OutcomeObservability | null {
  if (value === 'observable' || value === 'conditional' || value === 'not_observable') return value;
  return null;
}

function approvalMode(value: unknown): ActionApprovalContract['mode'] | null {
  if (value === 'explicit_card' || value === 'conversation_confirmation') return value;
  return null;
}

function approvalTier(value: unknown): ActionApprovalContract['tier'] | null {
  if (value === 'quick' || value === 'card' || value === 'conversation') return value;
  return null;
}

function approvalState(value: unknown): LifecycleActionProjection['approval']['state'] | null {
  if (value === 'required' || value === 'approved' || value === 'rejected' || value === 'not_required') return value;
  return null;
}

function idempotencyScope(value: unknown): IdempotencyContract['scope'] | null {
  if (value === 'property_action' || value === 'property_action_and_input') return value;
  return null;
}

function idempotencyRetry(value: unknown): IdempotencyContract['retry'] | null {
  if (value === 'first_receipt' || value === 'same_proposal') return value;
  return null;
}

function uniqueStrings(value: unknown, maxLength: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const parsed = text(entry, maxLength);
    if (!parsed || seen.has(parsed)) return null;
    seen.add(parsed);
    result.push(parsed);
  }
  return result;
}

function uniqueUuids(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const parsed = uuid(entry);
    if (!parsed || seen.has(parsed)) return null;
    seen.add(parsed);
    result.push(parsed);
  }
  return result;
}

function ownerSnapshot(value: unknown, requireUsefulLabel: boolean): LifecycleOwnerSnapshot | null {
  if (!record(value) || !has(value, 'kind') || !has(value, 'label') || !has(value, 'role')) return null;
  const kind = ownerKind(value.kind);
  const label = nullableText(value.label, 200);
  const role = nullableText(value.role, 120);
  if (!kind || label === undefined || role === undefined) return null;
  if (requireUsefulLabel && kind !== 'unknown' && kind !== 'unassigned' && label === null && role === null) return null;
  return { kind, label, role };
}

function ordered(times: readonly (string | null)[]): boolean {
  let previous: number | null = null;
  for (const value of times) {
    if (value === null) continue;
    const current = Date.parse(value);
    if (!Number.isFinite(current) || (previous !== null && current < previous)) return false;
    previous = current;
  }
  return true;
}

function derivedFreshness(sources: readonly LifecycleSourceSummary[]): SourceFreshness {
  if (sources.some((source) => source.freshness === 'stale')) return 'stale';
  if (sources.some((source) => source.freshness === 'unknown')) return 'unknown';
  return 'fresh';
}

function derivedCompleteness(sources: readonly LifecycleSourceSummary[]): SourceCompleteness {
  if (sources.some((source) => source.completeness === 'unknown')) return 'unknown';
  if (sources.some((source) => source.completeness === 'partial')) return 'partial';
  return 'complete';
}

function derivedMinimumFreshnessAge(sources: readonly LifecycleSourceSummary[]): number {
  return Math.min(...sources.map((source) => source.freshnessMaxAgeSeconds));
}

function sameScope(
  claimScope: string,
  authority: number,
  precedence: number,
): string {
  return `${claimScope}\u0000${authority}\u0000${precedence}`;
}

function sourceSummary(value: unknown): LifecycleSourceSummary | null {
  if (!record(value)) return null;

  const id = uuid(value.id);
  const contractVersion = value.contractVersion;
  const kind = sourceKind(value.kind);
  const sourceDefinitionId = uuid(value.sourceDefinitionId);
  const claimScope = text(value.claimScope, 200);
  const label = text(value.label, 200);
  const reference = text(value.reference, 300);
  const receiptId = uuid(value.receiptId);
  const receiptHash = sha256(value.receiptHash);
  const effectiveAt = iso(value.effectiveAt);
  const asOf = iso(value.asOf);
  const observedAt = iso(value.observedAt);
  const receivedAt = iso(value.receivedAt);
  const completeness = sourceCompleteness(value.completeness);
  const freshness = sourceFreshness(value.freshness);
  const freshnessMaxAgeSeconds = positiveInteger(value.freshnessMaxAgeSeconds);
  const completenessRequired = sourceCompleteness(value.completenessRequired);
  const owner = ownerSnapshot(value.owner, true);
  const authority = authorityInteger(value.authority);
  const precedence = authorityInteger(value.precedence);

  if (contractVersion !== SOURCE_FACT_CONTRACT_VERSION || !id || !kind || !sourceDefinitionId || !claimScope || !label || !reference || !safeSourceReference(reference) || !receiptId || !receiptHash || !effectiveAt || !asOf || !observedAt || !receivedAt || !completeness || !freshness || !completenessRequired || !owner || authority === null || precedence === null) return null;
  const appOwnedOwner = owner.kind === 'app' || owner.kind === 'hotel' || owner.kind === 'company' || owner.kind === 'staxis' || owner.kind === 'human' || owner.kind === 'system';
  if ((kind === 'app_owned' && !appOwnedOwner) || (kind === 'pms_report' && owner.kind !== 'pms')) return null;
  if (!completenessMeets(completeness, completenessRequired)) return null;
  if (!ordered([asOf, observedAt, receivedAt])) return null;
  if (freshnessMaxAgeSeconds === null) return null;
  if (completeness === 'complete' && value.completenessReason !== null) return null;
  const completenessReason = nullableText(value.completenessReason, 500);
  if (completenessReason === undefined || (completeness !== 'complete' && completenessReason === null)) return null;

  return {
    id,
    kind,
    label,
    reference,
    contractVersion: SOURCE_FACT_CONTRACT_VERSION,
    sourceDefinitionId,
    claimScope,
    receiptId,
    receiptHash,
    effectiveAt,
    asOf,
    observedAt,
    receivedAt,
    completeness,
    completenessReason,
    completenessRequired,
    freshness,
    freshnessMaxAgeSeconds,
    owner,
    authority,
    precedence,
  };
}

function actionEffect(value: unknown): ActionEffectContract | null {
  if (!record(value) || !has(value, 'domain') || !has(value, 'operation') || !has(value, 'targetKind') || !has(value, 'boundary') || !has(value, 'statement') || !has(value, 'limit')) return null;
  const domain = text(value.domain, 80);
  const operation = text(value.operation, 120);
  const targetKind = text(value.targetKind, 80);
  const statement = text(value.statement, 1_000);
  const limit = text(value.limit, 1_000);
  if (!domain || !operation || !targetKind || value.boundary !== 'in_app_only' || !statement || !limit) return null;
  return { domain, operation, targetKind, boundary: 'in_app_only', statement, limit };
}

function actionAuthority(value: unknown): ActionAuthorityContract | null {
  if (!record(value) || !has(value, 'propertyScoped') || !has(value, 'roles') || !has(value, 'capability') || !has(value, 'surfaces')) return null;
  const roles = uniqueStrings(value.roles, 120);
  const surfaces = uniqueStrings(value.surfaces, 120);
  const capability = nullableText(value.capability, 120);
  if (value.propertyScoped !== true || !roles || roles.length === 0 || !surfaces || surfaces.length === 0 || capability !== null) return null;
  return { propertyScoped: true, roles, capability, surfaces };
}

function actionApproval(value: unknown): LifecycleActionProjection['approval'] | null {
  if (!record(value) || !has(value, 'mode') || !has(value, 'tier') || !has(value, 'policyId') || !has(value, 'state')) return null;
  const mode = approvalMode(value.mode);
  const tier = approvalTier(value.tier);
  const policyId = text(value.policyId, 120);
  const state = approvalState(value.state);
  if (!mode || !tier || !policyId || !state) return null;
  return { mode, tier, policyId, state };
}

function actionFrozenInput(value: unknown): LifecycleActionProjection['frozenInput'] | null {
  if (!record(value) || !has(value, 'immutable') || !has(value, 'fields') || !has(value, 'fingerprint') || !has(value, 'staleInput') || !has(value, 'hash')) return null;
  const fields = uniqueStrings(value.fields, 200);
  const hash = sha256(value.hash);
  if (value.immutable !== true || !fields || fields.length === 0 || value.fingerprint !== 'server_sha256' || value.staleInput !== 'decline' || !hash) return null;
  return { immutable: true, fields, fingerprint: 'server_sha256', staleInput: 'decline', hash };
}

function actionIdempotency(value: unknown): IdempotencyContract | null {
  if (!record(value) || !has(value, 'scope') || !has(value, 'keyFields') || !has(value, 'retry')) return null;
  const scope = idempotencyScope(value.scope);
  const keyFields = uniqueStrings(value.keyFields, 200);
  const retry = idempotencyRetry(value.retry);
  if (!scope || !keyFields || keyFields.length === 0 || !retry) return null;
  return { scope, keyFields, retry };
}

function actionReceipt(value: unknown): ExecutionReceiptContract | null {
  if (!record(value) || !has(value, 'contractVersion') || !has(value, 'requiredFields') || !has(value, 'internalOnly') || !has(value, 'physicalCompletionClaim')) return null;
  const requiredFields = uniqueStrings(value.requiredFields, 200);
  if (value.contractVersion !== ACTION_CONTRACT_VERSION || !requiredFields || requiredFields.length === 0 || value.internalOnly !== true || value.physicalCompletionClaim !== 'never') return null;
  return { contractVersion: ACTION_CONTRACT_VERSION, requiredFields, internalOnly: true, physicalCompletionClaim: 'never' };
}

interface ParsedOutcome {
  contract: OutcomeContract;
  state: OutcomeVerificationState;
  basis: string | null;
  observedAt: string | null;
}

function actionOutcome(value: unknown): ParsedOutcome | null {
  if (!record(value) || !has(value, 'observability') || !has(value, 'verificationState') || !has(value, 'verificationWindowDays') || !has(value, 'basisRequired') || !has(value, 'state') || !has(value, 'basis') || !has(value, 'observedAt')) return null;
  const observability = outcomeObservability(value.observability);
  const verificationState = outcomeState(value.verificationState);
  const verificationWindowDays = positiveInteger(value.verificationWindowDays);
  const state = outcomeState(value.state);
  const basis = nullableText(value.basis, 1_000);
  const observedAt = nullableIso(value.observedAt);
  if (!observability || !verificationState || verificationWindowDays === null || value.basisRequired !== true || !state || basis === undefined || observedAt === undefined || verificationState !== state) return null;
  if (state === 'pending' && (basis !== null || observedAt !== null)) return null;
  if (state !== 'pending' && (basis === null || observedAt === null)) return null;
  return {
    contract: { observability, verificationState, verificationWindowDays, basisRequired: true },
    state,
    basis,
    observedAt,
  };
}

function parseAction(value: unknown): LifecycleActionProjection | null {
  if (!record(value) || !has(value, 'id') || !has(value, 'kind') || !has(value, 'contractVersion') || !has(value, 'effect') || !has(value, 'targetId') || !has(value, 'authority') || !has(value, 'approval') || !has(value, 'frozenInput') || !has(value, 'idempotency') || !has(value, 'receipt') || !has(value, 'outcome')) return null;
  const id = uuid(value.id);
  const kind = text(value.kind, 120);
  const effect = actionEffect(value.effect);
  const targetId = nullableUuid(value.targetId);
  const authority = actionAuthority(value.authority);
  const approval = actionApproval(value.approval);
  const frozenInput = actionFrozenInput(value.frozenInput);
  const idempotency = actionIdempotency(value.idempotency);
  const receipt = actionReceipt(value.receipt);
  const outcome = actionOutcome(value.outcome);
  if (value.contractVersion !== ACTION_CONTRACT_VERSION || !id || !kind || !effect || targetId === undefined || !authority || !approval || !frozenInput || !idempotency || !receipt || !outcome) return null;

  const contract: ActionAdmissionContract = {
    contractVersion: ACTION_CONTRACT_VERSION,
    effect,
    authority,
    approval: { mode: approval.mode, tier: approval.tier, policyId: approval.policyId },
    frozenInput: { immutable: true, fields: frozenInput.fields, fingerprint: 'server_sha256', staleInput: 'decline' },
    idempotency,
    receipt,
    outcome: outcome.contract,
  };
  if (validateActionContract(contract).length > 0) return null;
  return {
    id,
    kind,
    effect,
    targetId,
    approval,
    frozenInput,
    idempotency,
    receipt,
    outcome: { ...outcome.contract, state: outcome.state, basis: outcome.basis, observedAt: outcome.observedAt },
  };
}

function parseTopLevelOutcome(value: unknown, outcomeEvidenceId: string | null): LifecycleOutcome | null | undefined {
  if (value === null) return outcomeEvidenceId === null ? null : undefined;
  if (!record(value) || !has(value, 'id') || !has(value, 'state') || !has(value, 'basis') || !has(value, 'sourceFactId') || !has(value, 'observed_at')) return undefined;
  const id = nullableUuid(value.id);
  const state = outcomeState(value.state);
  const basis = nullableText(value.basis, 1_000);
  const sourceFactId = nullableUuid(value.sourceFactId);
  const observedAt = nullableIso(value.observed_at);
  if (state === 'pending') {
    if (id !== null || outcomeEvidenceId !== null || basis !== null || sourceFactId !== null || observedAt !== null) return undefined;
    return { state, basis, sourceFactId, observedAt };
  }
  if (!id || outcomeEvidenceId === null || id !== outcomeEvidenceId || !state || basis === undefined || sourceFactId === undefined || observedAt === undefined) return undefined;
  if (basis === null || observedAt === null) return undefined;
  return { state, basis, sourceFactId, observedAt };
}

function parseDomainWorkItem(value: unknown): LifecycleDomainWorkItem | null | undefined {
  if (value === null) return null;
  if (!record(value) || !has(value, 'kind') || !has(value, 'id') || !has(value, 'label') || !has(value, 'href') || !has(value, 'owner') || !has(value, 'observedAt')) return undefined;
  const kind = text(value.kind, 120);
  const id = uuid(value.id);
  const label = nullableText(value.label, 300);
  const owner = ownerSnapshot(value.owner, true);
  const observedAt = iso(value.observedAt);
  if (!kind || !id || label === undefined || value.href !== null || !owner || !observedAt) return undefined;
  return { kind, id, label, href: null, owner, observedAt };
}

function expectedPriorStates(state: LifecycleState): readonly LifecycleState[] {
  if (state === 'not_observable' || state === 'unverifiable' || state === 'outcome_verified') return ['observed', 'proposed', 'approved', 'executed'];
  const rank = lifecycleStateRank(state);
  return LIFECYCLE_STATES.slice(0, rank);
}

function parseNullableId(value: Record<string, unknown>, key: string): string | null | undefined {
  return has(value, key) ? nullableUuid(value[key]) : undefined;
}

function parseNullableEntityId(value: Record<string, unknown>, key: string): string | null | undefined {
  return has(value, key) ? nullableText(value[key], 240) : undefined;
}

function parseNullableTime(value: Record<string, unknown>, key: string): string | null | undefined {
  return has(value, key) ? nullableIso(value[key]) : undefined;
}

/**
 * Parse one database-view row. Every nested element is validated; invalid
 * rows return null so the API can fail the complete response rather than
 * silently shrinking a tenant-scoped projection.
 */
export function parseLifecycleProjectionRow(row: unknown): LifecycleProjection | null {
  if (!record(row)) return null;

  const contractVersion = row.contract_version;
  const id = uuid(row.projection_id);
  const propertyId = uuid(row.property_id);
  const state = parseLifecycleState(row.state);
  const title = text(row.title, 300);
  const summary = text(row.summary, 2_000);
  const entityKind = text(row.entity_kind, 120);
  const entityId = parseNullableEntityId(row, 'entity_id');
  const entityLabel = has(row, 'entity_label') ? nullableText(row.entity_label, 200) : undefined;
  const recordedAt = iso(row.recorded_at);
  const effectiveAt = parseNullableTime(row, 'effective_at');
  const asOf = parseNullableTime(row, 'as_of');
  const observedAt = parseNullableTime(row, 'observed_at');
  const findingId = parseNullableId(row, 'finding_id');
  const proposalId = parseNullableId(row, 'proposal_id');
  const approvalId = parseNullableId(row, 'approval_id');
  const executionReceiptId = parseNullableId(row, 'execution_receipt_id');
  const outcomeEvidenceId = parseNullableId(row, 'outcome_evidence_id');
  const reason = has(row, 'reason') ? nullableText(row.reason, 1_000) : undefined;
  if (contractVersion !== LIFECYCLE_CONTRACT_VERSION || !id || !propertyId || !state || !title || !summary || !entityKind || entityId === undefined || entityLabel === undefined || !recordedAt || effectiveAt === undefined || asOf === undefined || observedAt === undefined || findingId === undefined || proposalId === undefined || approvalId === undefined || executionReceiptId === undefined || outcomeEvidenceId === undefined || reason === undefined) return null;
  if (!ordered([asOf, observedAt, recordedAt])) return null;

  const sourceFactIds = uniqueUuids(row.source_fact_ids);
  if (!sourceFactIds || sourceFactIds.length === 0 || findingId === null || effectiveAt === null || asOf === null || observedAt === null) return null;
  if (!Array.isArray(row.sources)) return null;
  const sources: LifecycleSourceSummary[] = [];
  const sourceIds = new Set<string>();
  for (const source of row.sources) {
    const parsed = sourceSummary(source);
    if (!parsed || sourceIds.has(parsed.id)) return null;
    sourceIds.add(parsed.id);
    sources.push(parsed);
  }
  if (sourceIds.size !== sourceFactIds.length || sourceFactIds.some((sourceId) => !sourceIds.has(sourceId))) return null;
  if (sources.some((source) => Date.parse(source.receivedAt) > Date.parse(recordedAt))) return null;
  if (sources.some((source) => Date.parse(source.asOf) > Date.parse(asOf) || Date.parse(source.observedAt) > Date.parse(observedAt))) return null;
  if (Date.parse(effectiveAt) !== Math.min(...sources.map((source) => Date.parse(source.effectiveAt)))) return null;
  if (Date.parse(asOf) !== Math.min(...sources.map((source) => Date.parse(source.asOf)))) return null;
  if (Date.parse(observedAt) !== Math.max(...sources.map((source) => Date.parse(source.observedAt)))) return null;

  if (!Array.isArray(row.prior_states)) return null;
  const priorStates: LifecycleState[] = [];
  for (const prior of row.prior_states) {
    const parsed = parseLifecycleState(prior);
    if (!parsed) return null;
    priorStates.push(parsed);
  }
  const expected = expectedPriorStates(state);
  if (priorStates.length !== expected.length || priorStates.some((prior, index) => prior !== expected[index])) return null;

  if (!record(row.freshness) || !has(row.freshness, 'status') || !has(row.freshness, 'max_age_seconds')) return null;
  const freshnessStatus = sourceFreshness(row.freshness.status);
  const freshnessMaxAgeSeconds = row.freshness.max_age_seconds === null ? null : positiveInteger(row.freshness.max_age_seconds);
  if (!freshnessStatus || freshnessMaxAgeSeconds === null || freshnessStatus !== derivedFreshness(sources) || freshnessMaxAgeSeconds !== derivedMinimumFreshnessAge(sources)) return null;

  if (!record(row.completeness) || !has(row.completeness, 'status') || !has(row.completeness, 'reason')) return null;
  const completenessStatus = sourceCompleteness(row.completeness.status);
  const completenessReason = nullableText(row.completeness.reason, 500);
  if (!completenessStatus || completenessReason === undefined || completenessStatus !== derivedCompleteness(sources) || (completenessStatus === 'complete' ? completenessReason !== null : completenessReason === null)) return null;

  if (!record(row.authority) || !has(row.authority, 'owner') || !has(row.authority, 'level') || !has(row.authority, 'precedence')) return null;
  const authorityOwner = ownerSnapshot(row.authority.owner, true);
  const authorityLevel = row.authority.level === null ? null : authorityInteger(row.authority.level);
  const authorityPrecedence = row.authority.precedence === null ? null : authorityInteger(row.authority.precedence);
  if (!authorityOwner || authorityLevel === null && row.authority.level !== null || authorityPrecedence === null && row.authority.precedence !== null) return null;
  if ((authorityLevel === null) !== (authorityPrecedence === null)) return null;
  if (!has(row.authority, 'scopes') || !Array.isArray(row.authority.scopes)) return null;
  const authorityScopes: LifecycleAuthorityScope[] = [];
  const authorityScopeIds = new Set<string>();
  for (const scope of row.authority.scopes) {
    if (!record(scope) || !has(scope, 'claimScope') || !has(scope, 'authority') || !has(scope, 'precedence')) return null;
    const claimScope = text(scope.claimScope, 200);
    const scopeAuthority = authorityInteger(scope.authority);
    const scopePrecedence = authorityInteger(scope.precedence);
    if (!claimScope || scopeAuthority === null || scopePrecedence === null || authorityScopeIds.has(claimScope)) return null;
    authorityScopeIds.add(claimScope);
    authorityScopes.push({ claimScope, authority: scopeAuthority, precedence: scopePrecedence });
  }
  if (authorityScopes.length === 0 && (authorityLevel !== null || authorityPrecedence !== null)) return null;
  if (authorityScopes.length === 1 && (authorityLevel !== authorityScopes[0].authority || authorityPrecedence !== authorityScopes[0].precedence)) return null;
  if (authorityScopes.length > 1 && (authorityLevel !== null || authorityPrecedence !== null)) return null;
  const sourceScopes = new Set(sources.map((source) => sameScope(source.claimScope, source.authority, source.precedence)));
  const declaredScopes = new Set(authorityScopes.map((scope) => sameScope(scope.claimScope, scope.authority, scope.precedence)));
  if (sourceScopes.size !== declaredScopes.size || [...sourceScopes].some((scope) => !declaredScopes.has(scope))) return null;

  if (!has(row, 'action')) return null;
  const actionRaw = row.action;
  const action = actionRaw === null ? null : parseAction(actionRaw);
  if (actionRaw !== null && !action) return null;

  const domainWorkItem = parseDomainWorkItem(row.domain_work_item);
  if (domainWorkItem === undefined) return null;
  if (domainWorkItem && Date.parse(domainWorkItem.observedAt) > Date.parse(recordedAt)) return null;
  const outcome = parseTopLevelOutcome(row.outcome, outcomeEvidenceId);
  if (outcome === undefined) return null;

  if (state === 'observed') {
    if (proposalId !== null || approvalId !== null || executionReceiptId !== null || domainWorkItem !== null || action !== null || outcome !== null || outcomeEvidenceId !== null) return null;
  } else {
    if (!action || proposalId === null || action.id !== proposalId) return null;
  }
  if (state === 'proposed' && (approvalId !== null || executionReceiptId !== null || domainWorkItem !== null || outcome !== null || outcomeEvidenceId !== null || action?.targetId !== null || action?.outcome.state !== 'pending')) return null;
  if (state === 'approved' && (approvalId === null || executionReceiptId !== null || domainWorkItem !== null || outcome !== null || outcomeEvidenceId !== null || action?.targetId !== null || action?.outcome.state !== 'pending')) return null;
  if ((state === 'executed' || state === 'outcome_verified' || state === 'not_observable' || state === 'unverifiable') && (approvalId === null || executionReceiptId === null || domainWorkItem === null || action?.targetId === null || action?.targetId !== domainWorkItem.id)) return null;
  if (state === 'executed' && outcomeEvidenceId !== null) return null;
  if (state === 'proposed' && action?.approval.state !== 'required') return null;
  if (state === 'approved' && action && action.approval.state !== 'approved' && action.approval.state !== 'not_required') return null;
  if ((state === 'executed' || state === 'outcome_verified' || state === 'not_observable' || state === 'unverifiable') && action && action.approval.state !== 'approved' && action.approval.state !== 'not_required') return null;
  if ((state === 'executed' || state === 'outcome_verified' || state === 'not_observable' || state === 'unverifiable') && executionReceiptId === null) return null;
  if (state === 'executed' && action && action.outcome.state !== 'pending') return null;
  if (state === 'outcome_verified' && (!action || action.outcome.state !== 'verified' || !outcome || outcome.state !== 'verified' || !outcome.sourceFactId || !sourceFactIds.includes(outcome.sourceFactId) || outcomeEvidenceId === null)) return null;
  if ((state === 'not_observable' || state === 'unverifiable') && (!action || action.outcome.state !== state || !outcome || outcome.state !== state || outcome.sourceFactId !== null || outcomeEvidenceId === null)) return null;
  if (state === 'executed' && (!outcome || outcome.state !== 'pending')) return null;
  if (action && outcome && action.outcome.state !== outcome.state) return null;
  if (outcome && outcome.observedAt && Date.parse(outcome.observedAt) > Date.parse(recordedAt)) return null;

  return {
    contractVersion: LIFECYCLE_CONTRACT_VERSION,
    id,
    propertyId,
    entity: { kind: entityKind, id: entityId, label: entityLabel },
    title,
    summary,
    state,
    priorStates,
    findingId,
    proposalId,
    approvalId,
    executionReceiptId,
    sourceFactIds,
    sources,
    effectiveAt,
    asOf,
    observedAt,
    recordedAt,
    freshness: { status: freshnessStatus, maxAgeSeconds: freshnessMaxAgeSeconds },
    completeness: { status: completenessStatus, reason: completenessReason },
    authority: { owner: authorityOwner, level: authorityLevel, precedence: authorityPrecedence, scopes: authorityScopes },
    action,
    domainWorkItem,
    outcome,
    outcomeEvidenceId,
    reason,
  };
}
