/**
 * Shared truth, action, and lifecycle contracts.
 *
 * This module is deliberately pure.  It is used by the source/finding
 * admission tests, the agent tool registry, the proactive finding catalog,
 * and the lifecycle API.  Database rows are allowed to be older than these
 * contracts, but a new producer cannot enter the shared projection without
 * satisfying every field below.
 */

export const SOURCE_FACT_CONTRACT_VERSION = 'staxis-source-fact.v1' as const;
export const ACTION_CONTRACT_VERSION = 'staxis-action.v1' as const;
export const LIFECYCLE_CONTRACT_VERSION = 'staxis-lifecycle.v1' as const;

/** External/PMS effects are intentionally not admitted by this slice. */
export type EffectBoundary = 'in_app_only';
export type SourceCompleteness = 'complete' | 'partial' | 'unknown';
export type SourceFreshness = 'fresh' | 'stale' | 'unknown';
/** The source owner is descriptive only.  Authority and precedence are
 * declared by a registered claim scope below, never inferred from this label. */
export type AuthorityKind = 'app' | 'pms' | 'hotel' | 'company' | 'staxis' | 'human' | 'system' | 'unknown';
export type OutcomeObservability = 'observable' | 'conditional' | 'not_observable';
export type OutcomeVerificationState = 'pending' | 'verified' | 'not_observable' | 'unverifiable' | 'reverted';

/**
 * Closed source classes.  A class says who owns the transport, not who wins a
 * claim.  A producer must also name one of the DB-loaded definition's exact
 * claim scopes, where authority/precedence and the freshness clock are
 * defined for that entity/category.  This prevents a caller from submitting
 * `sourceKind: "anything"` or choosing a convenient global hierarchy.
 */
export const SOURCE_CLASS_REGISTRY = Object.freeze({
  app_owned: { owner: 'app' as const, freshnessRequired: true },
  pms_report: { owner: 'pms' as const, freshnessRequired: true },
} as const);
export type SourceKind = keyof typeof SOURCE_CLASS_REGISTRY;

export interface SourceScopeDefinition {
  /** Durable `staxis_source_definitions.id`, not a caller-chosen label. */
  readonly id: string;
  /** Tenant boundary of this immutable definition row. */
  readonly propertyId: string;
  readonly sourceKind: SourceKind;
  readonly producerKey: string;
  readonly category: string;
  readonly entityKind: string;
  readonly claimScope: string;
  readonly owner: AuthorityKind;
  readonly authority: number;
  readonly precedence: number;
  readonly freshnessMaxAgeSeconds: number;
  /** Minimum reviewed completeness admitted for an observation. */
  readonly completenessRequired: SourceCompleteness;
  /** Immutable review timestamp from the tenant-scoped definition registry. */
  readonly reviewedAt: string;
}

/** Look up a definition in a request-scoped immutable catalog. */
export function sourceScopeDefinitionFor(
  definitions: readonly SourceScopeDefinition[],
  id: string | null | undefined,
): SourceScopeDefinition | null {
  if (!id) return null;
  return definitions.find((definition) => definition.id === id) ?? null;
}

export interface SourceReceiptContract {
  contractVersion: typeof SOURCE_FACT_CONTRACT_VERSION;
  sourceKind: SourceKind;
  sourceDefinitionId: string;
  /** Exact registered producer/category ownership scope. */
  claimScope: string;
  sourceReference: string;
  receiptId: string;
  receiptHash: string;
  receivedAt: string;
  asOf: string;
  observedAt: string;
  completeness: SourceCompleteness;
  completenessReason: string | null;
  freshness: SourceFreshness;
  freshnessMaxAgeSeconds: number;
  owner: AuthorityKind;
  authority: number;
  precedence: number;
}

export interface SourceFactContract extends SourceReceiptContract {
  id: string;
  propertyId: string;
  entityKind: string;
  entityId: string;
  entityLabel: string | null;
  effectiveAt: string;
  expiresAt: string | null;
  value: Record<string, unknown>;
  fingerprint: string;
  supersedesId: string | null;
}

export interface SourceReceiptRecord extends SourceReceiptContract {
  id: string;
  propertyId: string;
}

export interface OwnerSnapshotContract {
  kind: AuthorityKind | 'unassigned';
  label: string | null;
  role: string | null;
}

export interface ApprovalProofContract {
  decision: 'approved';
  policyId: string;
  mode: ActionApprovalContract['mode'];
  tier: ActionApprovalContract['tier'];
}

export interface InputVerificationContract {
  state: 'matched';
  verifiedAt: string;
}

/** Canonical DB-backed receipt envelope for one in-app execution event. */
export interface ExecutionReceiptEnvelope {
  propertyId: string;
  proposalId: string;
  actionId: string | null;
  /** Immutable ID of the preceding approved event; the append RPC binds it to the approval proof. */
  approvalId: string;
  contractVersion: typeof ACTION_CONTRACT_VERSION;
  effectBoundary: EffectBoundary;
  effect: ActionEffectContract;
  receipt: Record<string, unknown>;
  internalOnly: true;
  physicalCompletionClaim: 'never';
  idempotencyKey: string;
  targetKind: string;
  targetId: string;
  executedAt: string;
  executedBy: string;
  frozenInputHash: string;
  inputVerification: InputVerificationContract;
}

export interface OutcomeEvidenceContract {
  id: string;
  propertyId: string;
  executionReceiptId: string;
  state: OutcomeVerificationState;
  basis: string | null;
  observedAt: string | null;
  sourceFactId: string | null;
}

export interface ActionEffectContract {
  domain: string;
  operation: string;
  targetKind: string;
  boundary: 'in_app_only';
  /** Exact resource/operation statement, not a marketing summary. */
  statement: string;
  /** Explicit limit, including what the operation does not do. */
  limit: string;
}

export interface ActionAuthorityContract {
  propertyScoped: true;
  roles: readonly string[];
  capability: string | null;
  surfaces: readonly string[];
}

export interface ActionApprovalContract {
  mode: 'explicit_card' | 'conversation_confirmation';
  tier: 'quick' | 'card' | 'conversation';
  policyId: string;
}

export interface FrozenInputContract {
  immutable: true;
  fields: readonly string[];
  fingerprint: 'server_sha256';
  staleInput: 'decline';
}

export interface IdempotencyContract {
  scope: 'property_action' | 'property_action_and_input';
  keyFields: readonly string[];
  retry: 'first_receipt' | 'same_proposal';
}

export interface ExecutionReceiptContract {
  contractVersion: typeof ACTION_CONTRACT_VERSION;
  requiredFields: readonly string[];
  internalOnly: true;
  physicalCompletionClaim: 'never';
}

export interface OutcomeContract {
  observability: OutcomeObservability;
  verificationState: OutcomeVerificationState;
  verificationWindowDays: number;
  basisRequired: true;
}

export interface ActionAdmissionContract {
  contractVersion: typeof ACTION_CONTRACT_VERSION;
  effect: ActionEffectContract;
  authority: ActionAuthorityContract;
  approval: ActionApprovalContract;
  frozenInput: FrozenInputContract;
  idempotency: IdempotencyContract;
  receipt: ExecutionReceiptContract;
  outcome: OutcomeContract;
}

export interface ActionScopeDefinition {
  readonly id: string;
  readonly propertyId: string;
  readonly category: string;
  readonly actionKind: string;
  readonly contract: ActionAdmissionContract;
  readonly reviewedAt: string;
}

export function validateActionScopeDefinition(definition: ActionScopeDefinition | null | undefined, now = new Date()): string[] {
  const reasons: string[] = [];
  if (!definition || !UUID_RE.test(definition.id)) reasons.push('action definition id is missing or invalid');
  if (!definition || !UUID_RE.test(definition.propertyId)) reasons.push('action definition property is missing or invalid');
  if (!definition || !nonEmpty(definition.category, 120)) reasons.push('action definition category is missing');
  if (!definition || !nonEmpty(definition.actionKind, 120)) reasons.push('action definition kind is missing');
  if (!definition || validateActionContract(definition.contract).length > 0) reasons.push('action definition contract is incomplete');
  if (!definition || definition.contract?.outcome?.verificationState !== 'pending') reasons.push('action definition outcome must start pending');
  const frozenFields = definition?.contract?.frozenInput?.fields;
  const expectedFrozenFields = ['propertyId', 'findingId', 'params', 'verify'];
  if (!Array.isArray(frozenFields) || frozenFields.length !== expectedFrozenFields.length || expectedFrozenFields.some((field) => !frozenFields.includes(field))) reasons.push('action definition frozen-input fields are incomplete');
  const reviewedAt = definition ? dateMs(definition.reviewedAt) : null;
  if (!definition || reviewedAt == null) reasons.push('action definition review is missing or invalid');
  else if (reviewedAt > now.getTime() + 5 * 60_000) reasons.push('action definition review is in the future');
  return reasons;
}

export function actionScopeDefinitionFor(
  definitions: readonly ActionScopeDefinition[],
  id: string | null | undefined,
): ActionScopeDefinition | null {
  if (!id) return null;
  return definitions.find((definition) => definition.id === id) ?? null;
}

export interface FindingAdmissionInput {
  propertyId: string;
  detectorId: string;
  receiptQueryId: string;
  evidence: unknown;
  minimumData: unknown;
  asOf: string | null;
  observedAt: string | null;
  expiresAt: string | null;
  completeness: SourceCompleteness;
  freshness: SourceFreshness;
  freshnessMaxAgeSeconds: number | null;
  sourceFactIds: readonly string[];
  /** Admission is performed against already loaded, tenant-paired facts. */
  sourceFacts?: readonly Pick<SourceFactContract, 'id' | 'propertyId' | 'entityKind' | 'entityId' | 'effectiveAt' | 'fingerprint' | 'contractVersion' | 'sourceKind' | 'sourceDefinitionId' | 'claimScope' | 'receiptId' | 'receiptHash' | 'receivedAt' | 'asOf' | 'observedAt' | 'expiresAt' | 'completeness' | 'completenessReason' | 'freshness' | 'freshnessMaxAgeSeconds' | 'owner' | 'authority' | 'precedence'>[];
  /** DB-loaded, request-scoped definitions. There is no process-global catalog. */
  sourceDefinitions?: readonly SourceScopeDefinition[];
}

export interface AdmissionResult {
  admissible: boolean;
  reasons: readonly string[];
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}

function safeSourceReference(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 300
    && !/[\\/]/.test(value)
    && !/(^|:)https?:\/\//i.test(value)
    && !/(attachment|storage|bucket|raw[_-]?path)/i.test(value);
}

function dateMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const COMPLETENESS_RANK: Record<SourceCompleteness, number> = {
  unknown: 0,
  partial: 1,
  complete: 2,
};

function completenessMeets(actual: SourceCompleteness, required: SourceCompleteness): boolean {
  return COMPLETENESS_RANK[actual] >= COMPLETENESS_RANK[required];
}

function weakestCompleteness(current: SourceCompleteness, next: SourceCompleteness): SourceCompleteness {
  return COMPLETENESS_RANK[next] < COMPLETENESS_RANK[current] ? next : current;
}

export function validateSourceScopeDefinition(definition: SourceScopeDefinition | null | undefined, now = new Date()): string[] {
  const reasons: string[] = [];
  if (!definition || !UUID_RE.test(definition.id)) reasons.push('source definition id is missing or invalid');
  if (!definition || !UUID_RE.test(definition.propertyId)) reasons.push('source definition property is missing or invalid');
  if (!definition || !SOURCE_CLASS_REGISTRY[definition.sourceKind]) reasons.push('source definition class is not registered');
  if (!definition || !nonEmpty(definition.claimScope, 200)) reasons.push('source definition claim scope is missing');
  if (!definition || !nonEmpty(definition.producerKey, 120)) reasons.push('source definition producer key is missing');
  if (!definition || !nonEmpty(definition.category, 120)) reasons.push('source definition category is missing');
  if (!definition || !nonEmpty(definition.entityKind, 120)) reasons.push('source definition entity kind is missing');
  const ownerAllowed = definition && definition.sourceKind === 'pms_report'
    ? definition.owner === 'pms'
    : definition && ['app', 'hotel', 'company', 'staxis', 'human', 'system'].includes(definition.owner);
  if (!definition || !ownerAllowed) reasons.push('source definition owner is invalid');
  if (!definition || !Number.isInteger(definition.authority) || definition.authority < 0 || definition.authority > 100) reasons.push('source definition authority is invalid');
  if (!definition || !Number.isInteger(definition.precedence) || definition.precedence < 0 || definition.precedence > 100) reasons.push('source definition precedence is invalid');
  if (!definition || !Number.isInteger(definition.freshnessMaxAgeSeconds) || definition.freshnessMaxAgeSeconds < 1) reasons.push('source definition freshness limit is invalid');
  if (!definition || !['complete', 'partial', 'unknown'].includes(definition.completenessRequired)) reasons.push('source definition completeness requirement is invalid');
  const reviewedAt = definition ? dateMs(definition.reviewedAt) : null;
  if (!definition || reviewedAt == null) reasons.push('source definition review is missing or invalid');
  else if (reviewedAt > now.getTime() + 5 * 60_000) reasons.push('source definition review is in the future');
  return reasons;
}

/** Validate a durable receipt/fact envelope.  `now` is only a comparison
 * clock; it can never substitute for the source's observed/as-of timestamps. */
export function admitSourceFact(
  input: Partial<SourceFactContract>,
  now = new Date(),
  definition?: SourceScopeDefinition | null,
): AdmissionResult {
  if (!input || typeof input !== 'object') return { admissible: false, reasons: ['source fact envelope is missing'] };
  const reasons: string[] = [];
  const asOf = dateMs(input.asOf);
  const observedAt = dateMs(input.observedAt);
  const effectiveAt = dateMs(input.effectiveAt);
  const receivedAt = dateMs(input.receivedAt);
  const expiresAt = input.expiresAt == null ? null : dateMs(input.expiresAt);

  if (!UUID_RE.test(input.id ?? '')) reasons.push('source fact identity is missing or invalid');
  if (!UUID_RE.test(input.propertyId ?? '')) reasons.push('property identity is missing or invalid');
  if (!nonEmpty(input.entityKind, 120)) reasons.push('entity kind is missing');
  if (!nonEmpty(input.entityId, 240)) reasons.push('entity identity is missing');
  if (input.contractVersion !== SOURCE_FACT_CONTRACT_VERSION) reasons.push('source contract version is unsupported');
  const sourceClass = input.sourceKind ? SOURCE_CLASS_REGISTRY[input.sourceKind as SourceKind] : undefined;
  if (!sourceClass) reasons.push('source kind is not registered');
  const scope = definition && definition.id === input.sourceDefinitionId ? definition : null;
  if (!scope) reasons.push('source claim scope is not registered');
  reasons.push(...validateSourceScopeDefinition(scope, now).filter((reason) => !reasons.includes(reason)));
  if (scope && scope.sourceKind !== input.sourceKind) reasons.push('source claim scope does not match source kind');
  if (scope && scope.claimScope !== input.claimScope) reasons.push('source claim scope does not match its definition');
  if (scope && scope.propertyId !== input.propertyId) reasons.push('source definition crosses the property boundary');
  if (scope && scope.entityKind !== input.entityKind) reasons.push('source entity kind does not match its definition');
  if (!safeSourceReference(input.sourceReference)) reasons.push('source reference is missing or exposes a private path');
  if (!SHA256_RE.test(input.receiptHash ?? '')) reasons.push('source receipt hash is missing or invalid');
  if (asOf == null) reasons.push('source as-of time is required');
  if (observedAt == null) reasons.push('source observed time is required');
  if (effectiveAt == null) reasons.push('effective time is required');
  if (receivedAt == null) reasons.push('source receipt received time is required');
  if (asOf != null && observedAt != null && asOf > observedAt) reasons.push('as-of time cannot be after observed time');
  if (observedAt != null && receivedAt != null && observedAt > receivedAt) reasons.push('observed time cannot be after receipt time');
  if (observedAt != null && observedAt > now.getTime() + 5 * 60_000) reasons.push('observed time is in the future');
  if (receivedAt != null && receivedAt > now.getTime() + 5 * 60_000) reasons.push('receipt time is in the future');
  if (expiresAt != null && (observedAt == null || expiresAt <= observedAt)) reasons.push('expiry must be after observed time');
  if (!objectRecord(input.value)) reasons.push('fact value must be an object');
  if (!SHA256_RE.test(input.fingerprint ?? '')) reasons.push('fact fingerprint is missing or invalid');
  const sourceCompletenessValue = input.completeness === 'complete' || input.completeness === 'partial' || input.completeness === 'unknown'
    ? input.completeness
    : null;
  if (!sourceCompletenessValue) {
    reasons.push('completeness is missing or unsupported');
  }
  if (sourceCompletenessValue !== 'complete' && !nonEmpty(input.completenessReason, 500)) {
    reasons.push('partial or unknown completeness requires a reason');
  }
  if (sourceCompletenessValue === 'complete' && input.completenessReason !== null) reasons.push('complete source data cannot carry a completeness reason');
  if (input.freshness !== 'fresh' && input.freshness !== 'stale' && input.freshness !== 'unknown') {
    reasons.push('freshness is missing or unsupported');
  }
  if (!UUID_RE.test(input.receiptId ?? '')) reasons.push('durable source receipt id is required');
  if (input.expiresAt !== null && input.expiresAt !== undefined && expiresAt === null) reasons.push('source expiry is invalid');
  if (!scope || !Number.isInteger(scope.authority) || scope.authority < 0 || scope.authority > 100 || !Number.isInteger(scope.precedence) || scope.precedence < 0 || scope.precedence > 100 || scope.owner === 'unknown') reasons.push('source definition authority/precedence is invalid');
  if (!scope || input.owner !== scope.owner) reasons.push('owner does not match the registered claim scope');
  if (!scope || input.authority !== scope.authority) reasons.push('authority does not match the registered claim scope');
  if (!scope || input.precedence !== scope.precedence) reasons.push('precedence does not match the registered claim scope');
  if (scope && sourceCompletenessValue && !completenessMeets(sourceCompletenessValue, scope.completenessRequired)) reasons.push('source completeness is below the registered minimum');
  if (!scope || !Number.isInteger(input.freshnessMaxAgeSeconds) || input.freshnessMaxAgeSeconds !== scope.freshnessMaxAgeSeconds) {
    reasons.push('freshness limit does not match the registered claim scope');
  }
  if (scope && asOf != null && observedAt != null && Number.isInteger(scope.freshnessMaxAgeSeconds)) {
    const ageSeconds = Math.max(0, (now.getTime() - asOf) / 1_000);
    const derived: SourceFreshness = ageSeconds <= scope.freshnessMaxAgeSeconds ? 'fresh' : 'stale';
    if (input.freshness !== derived) reasons.push('freshness does not match as-of age and registered limit');
  }
  if (input.supersedesId != null && !UUID_RE.test(input.supersedesId)) reasons.push('superseded fact identity is invalid');
  return { admissible: reasons.length === 0, reasons };
}

/** A finding cannot enter the new lifecycle projection unless its evidence is
 * reproducible and its data-quality clocks are explicit. */
export function admitFinding(input: FindingAdmissionInput, now = new Date()): AdmissionResult {
  if (!input || typeof input !== 'object') return { admissible: false, reasons: ['finding admission envelope is missing'] };
  const reasons: string[] = [];
  const evidence = objectRecord(input.evidence);
  const minimumData = objectRecord(input.minimumData);
  const asOf = dateMs(input.asOf);
  const observedAt = dateMs(input.observedAt);
  const expiresAt = dateMs(input.expiresAt);
  if (!UUID_RE.test(input.propertyId)) reasons.push('property identity is invalid');
  if (!nonEmpty(input.detectorId, 64)) reasons.push('detector identity is missing');
  if (!nonEmpty(input.receiptQueryId, 120)) reasons.push('reproducible receipt query is missing');
  if (!evidence) reasons.push('evidence must be an object');
  else {
    if (!nonEmpty(evidence.queryId, 120)) reasons.push('evidence query id is missing');
    if (evidence.queryId !== input.receiptQueryId) reasons.push('evidence query id does not match the reproducible receipt query');
    if (!objectRecord(evidence.params)) reasons.push('evidence params are missing');
    if (!objectRecord(evidence.values)) reasons.push('evidence values are missing');
    if (!nonEmpty(evidence.basis, 1_000)) reasons.push('evidence basis is missing');
  }
  const requiredFields = minimumData?.required;
  const providedFields = minimumData?.provided;
  const missingFields = minimumData?.missing;
  const required = Array.isArray(requiredFields) ? requiredFields.filter((field): field is string => typeof field === 'string' && field.trim().length > 0) : [];
  const provided = Array.isArray(providedFields) ? providedFields.filter((field): field is string => typeof field === 'string' && field.trim().length > 0) : [];
  const requiredSet = new Set(required);
  const providedSet = new Set(provided);
  if (!minimumData || minimumData.met !== true || !Array.isArray(requiredFields) || requiredFields.length === 0 ||
      !Array.isArray(providedFields) || required.length !== requiredFields.length || provided.length !== providedFields.length ||
      requiredSet.size !== required.length || providedSet.size !== provided.length ||
      !required.every((field) => providedSet.has(field)) ||
      !Array.isArray(missingFields) || missingFields.length > 0) {
    reasons.push('minimum-data proof is missing or not met');
  }
  if (asOf == null) reasons.push('finding as-of time is required');
  if (observedAt == null) reasons.push('finding observed time is required');
  if (expiresAt == null || expiresAt <= now.getTime() || (observedAt != null && expiresAt <= observedAt)) reasons.push('finding evidence is expired or has no expiry');
  if (asOf != null && observedAt != null && asOf > observedAt) reasons.push('finding as-of is after observed time');
  if (observedAt != null && observedAt > now.getTime() + 5 * 60_000) reasons.push('finding observed time is in the future');
  if (!['complete', 'partial', 'unknown'].includes(input.completeness)) reasons.push('finding completeness is unsupported');
  if (input.completeness !== 'complete' && !nonEmpty(minimumData?.reason, 500)) reasons.push('incomplete finding needs a reason');
  if (input.completeness === 'complete' && minimumData?.reason !== undefined && minimumData.reason !== null) reasons.push('complete finding cannot carry a completeness reason');
  if (!['fresh', 'stale', 'unknown'].includes(input.freshness)) reasons.push('finding freshness is unsupported');
  if (input.freshness === 'fresh' && (!Number.isInteger(input.freshnessMaxAgeSeconds) || (input.freshnessMaxAgeSeconds ?? 0) < 1)) reasons.push('fresh finding needs a freshness limit');
  const requestedFactIds = Array.isArray(input.sourceFactIds) ? input.sourceFactIds : [];
  const loadedFacts = Array.isArray(input.sourceFacts) ? input.sourceFacts : [];
  if (requestedFactIds.length === 0 || requestedFactIds.some((id) => !UUID_RE.test(id))) reasons.push('finding must name source facts');
  if (loadedFacts.length === 0) reasons.push('finding source facts were not loaded for tenant admission');
  else {
    const sourceIds = new Set(requestedFactIds);
    const loadedIds = new Set(loadedFacts.map((fact) => fact.id));
    if (loadedFacts.some((fact) => !sourceIds.has(fact.id) || fact.propertyId !== input.propertyId || fact.contractVersion !== SOURCE_FACT_CONTRACT_VERSION || !UUID_RE.test(fact.id) || !UUID_RE.test(fact.receiptId) || !SHA256_RE.test(fact.receiptHash) || !SHA256_RE.test(fact.fingerprint))) reasons.push('finding source facts cross the hotel boundary or are not admitted');
    if (loadedIds.size !== loadedFacts.length || sourceIds.size !== requestedFactIds.length || [...sourceIds].some((id) => !loadedIds.has(id))) reasons.push('finding source fact identity set does not match loaded facts');
    if (loadedFacts.length !== requestedFactIds.length) reasons.push('finding source fact set is incomplete');
    const definitions = Array.isArray(input.sourceDefinitions) ? input.sourceDefinitions : [];
    if (new Set(definitions.map((definition) => definition?.id)).size !== definitions.length) reasons.push('finding source definition catalog contains duplicate identities');
    let allFactsFresh = true;
    let derivedCompleteness: SourceCompleteness = 'complete';
    let weakestFactMaxAge: number | null = null;
    let weakestFactAsOf: number | null = null;
    let latestFactObserved: number | null = null;
    let earliestEvidenceExpiry: number | null = null;
    let sourceFactsInvalid = false;
    const claimEvidenceKeys = new Set<string>();
    const wallClockToleranceMs = 5 * 60_000;
    for (const fact of loadedFacts) {
      const scope = sourceScopeDefinitionFor(definitions, fact.sourceDefinitionId);
      const factExpiresAt = dateMs(fact.expiresAt);
      const factAsOf = dateMs(fact.asOf);
      const factObserved = dateMs(fact.observedAt);
      const factReceived = dateMs(fact.receivedAt);
      const factEffective = dateMs(fact.effectiveAt);
      if (scope) weakestFactMaxAge = weakestFactMaxAge === null ? scope.freshnessMaxAgeSeconds : Math.min(weakestFactMaxAge, scope.freshnessMaxAgeSeconds);
      if (fact.completeness === 'complete' || fact.completeness === 'partial' || fact.completeness === 'unknown') {
        derivedCompleteness = weakestCompleteness(derivedCompleteness, fact.completeness);
      } else {
        sourceFactsInvalid = true;
      }
      if (factAsOf !== null) weakestFactAsOf = weakestFactAsOf === null ? factAsOf : Math.min(weakestFactAsOf, factAsOf);
      if (factObserved !== null) latestFactObserved = latestFactObserved === null ? factObserved : Math.max(latestFactObserved, factObserved);
      if (factExpiresAt !== null) earliestEvidenceExpiry = earliestEvidenceExpiry === null ? factExpiresAt : Math.min(earliestEvidenceExpiry, factExpiresAt);
      if (scope && factAsOf !== null && Number.isInteger(scope.freshnessMaxAgeSeconds)) {
        const maxAgeExpiry = factAsOf + scope.freshnessMaxAgeSeconds * 1_000;
        earliestEvidenceExpiry = earliestEvidenceExpiry === null ? maxAgeExpiry : Math.min(earliestEvidenceExpiry, maxAgeExpiry);
      }
      const claimEvidenceKey = `${fact.entityKind}\u0000${fact.entityId}\u0000${fact.claimScope}\u0000${factEffective ?? ''}`;
      if (claimEvidenceKeys.has(claimEvidenceKey)) sourceFactsInvalid = true;
      claimEvidenceKeys.add(claimEvidenceKey);
      const invalid = fact.freshness === 'stale' || fact.freshness === 'unknown' ||
        !scope || scope.sourceKind !== fact.sourceKind || scope.claimScope !== fact.claimScope ||
        !nonEmpty(fact.entityKind, 120) || !nonEmpty(fact.entityId, 240) || factEffective === null ||
        (fact.expiresAt !== null && factExpiresAt === null) ||
        factAsOf === null || factObserved === null || factReceived === null || factEffective === null ||
        validateSourceScopeDefinition(scope, now).length > 0 ||
        (scope && !completenessMeets(fact.completeness, scope.completenessRequired)) ||
        (factExpiresAt !== null && factExpiresAt <= now.getTime()) || factReceived == null ||
        factObserved == null || factObserved > factReceived ||
        factReceived > now.getTime() + wallClockToleranceMs ||
        fact.owner !== scope?.owner ||
        (fact.completeness === 'complete' ? fact.completenessReason !== null : !nonEmpty(fact.completenessReason, 500)) ||
        fact.authority !== scope.authority || fact.precedence !== scope.precedence ||
        fact.freshnessMaxAgeSeconds !== scope.freshnessMaxAgeSeconds ||
        (() => {
          if (factAsOf == null || factObserved == null || factAsOf > factObserved) return true;
          const ageSeconds = Math.max(0, (now.getTime() - factAsOf) / 1_000);
          const derived: SourceFreshness = ageSeconds <= scope.freshnessMaxAgeSeconds ? 'fresh' : 'stale';
          return fact.freshness !== derived;
        })();
      allFactsFresh = allFactsFresh && !invalid;
      sourceFactsInvalid = sourceFactsInvalid || invalid;
    }
    if (sourceFactsInvalid) reasons.push('finding source facts are stale, below the registered completeness minimum, or outside a registered source scope');
    if (input.freshness !== (allFactsFresh ? 'fresh' : 'stale')) reasons.push('finding freshness does not match recomputed source fact freshness');
    if (input.completeness !== derivedCompleteness) reasons.push('finding completeness does not match linked source facts');
    if (weakestFactMaxAge === null || input.freshnessMaxAgeSeconds !== weakestFactMaxAge) reasons.push('finding freshness limit does not match linked source facts');
    if (weakestFactAsOf === null || asOf === null || asOf !== weakestFactAsOf) reasons.push('finding as-of does not match the weakest linked source facts');
    if (latestFactObserved === null || observedAt === null || observedAt !== latestFactObserved) reasons.push('finding observed time does not match linked source facts');
    if (earliestEvidenceExpiry === null || expiresAt === null || expiresAt > earliestEvidenceExpiry) reasons.push('finding expiry exceeds the earliest linked evidence horizon');
  }
  return { admissible: reasons.length === 0, reasons };
}

export function validateActionContract(contract: ActionAdmissionContract | null | undefined): string[] {
  const reasons: string[] = [];
  if (!contract || contract.contractVersion !== ACTION_CONTRACT_VERSION) return ['action contract version is missing or unsupported'];
  const effect = contract.effect;
  if (!effect || !nonEmpty(effect.domain, 80) || !nonEmpty(effect.operation, 120) || !nonEmpty(effect.targetKind, 80)) reasons.push('action effect target/operation is incomplete');
  if (!effect || effect.boundary !== 'in_app_only') reasons.push('action effect boundary is missing or not admitted');
  if (!effect || !nonEmpty(effect.statement, 1_000)) reasons.push('action effect statement is missing');
  if (!effect || !nonEmpty(effect.limit, 1_000)) reasons.push('action effect limit is missing');
  const authority = contract.authority;
  if (!authority || authority.propertyScoped !== true || !Array.isArray(authority.roles) || authority.roles.length === 0 || authority.roles.some((role) => !nonEmpty(role, 80)) || !Array.isArray(authority.surfaces) || authority.surfaces.length === 0 || authority.surfaces.some((surface) => !nonEmpty(surface, 80)) || authority.capability !== null) reasons.push('action authority scope/roles/surfaces are missing or capability is unenforced');
  const approval = contract.approval;
  if (!approval || !['explicit_card', 'conversation_confirmation'].includes(approval.mode) || !['quick', 'card', 'conversation'].includes(approval.tier) || (approval.mode === 'explicit_card' && approval.tier !== 'card') || (approval.mode === 'conversation_confirmation' && approval.tier !== 'conversation') || !nonEmpty(approval.policyId, 120)) reasons.push('action approval policy is missing');
  const frozen = contract.frozenInput;
  if (!frozen || frozen.immutable !== true || frozen.fingerprint !== 'server_sha256' || frozen.staleInput !== 'decline' || !Array.isArray(frozen.fields) || frozen.fields.length === 0 || frozen.fields.some((field) => !nonEmpty(field, 120)) || new Set(frozen.fields).size !== frozen.fields.length) reasons.push('frozen-input contract is incomplete');
  const idempotency = contract.idempotency;
  if (!idempotency || !['property_action', 'property_action_and_input'].includes(idempotency.scope) || !Array.isArray(idempotency.keyFields) || idempotency.keyFields.length === 0 || idempotency.keyFields.some((field) => !nonEmpty(field, 120)) || new Set(idempotency.keyFields).size !== idempotency.keyFields.length || !['first_receipt', 'same_proposal'].includes(idempotency.retry)) reasons.push('idempotency contract is incomplete');
  const receipt = contract.receipt;
  if (!receipt || receipt.contractVersion !== ACTION_CONTRACT_VERSION || receipt.internalOnly !== true || receipt.physicalCompletionClaim !== 'never' || !Array.isArray(receipt.requiredFields) || receipt.requiredFields.length === 0 || receipt.requiredFields.some((field) => !nonEmpty(field, 120)) || new Set(receipt.requiredFields).size !== receipt.requiredFields.length) reasons.push('execution receipt contract is incomplete');
  const outcome = contract.outcome;
  if (!outcome || !['observable', 'conditional', 'not_observable'].includes(outcome.observability) || !['pending', 'verified', 'not_observable', 'unverifiable', 'reverted'].includes(outcome.verificationState) || !Number.isInteger(outcome.verificationWindowDays) || outcome.verificationWindowDays < 1 || outcome.basisRequired !== true) reasons.push('outcome observability contract is incomplete');
  return reasons;
}

export function actionContractIsAdmissible(contract: ActionAdmissionContract | null | undefined): boolean {
  return validateActionContract(contract).length === 0;
}
