import 'server-only';

import { scopedDb } from '@/lib/agent/scoped-db';
import {
  admitFinding,
  admitSourceFact,
  actionScopeDefinitionFor,
  actionContractIsAdmissible,
  sourceScopeDefinitionFor,
  SOURCE_FACT_CONTRACT_VERSION,
  validateActionScopeDefinition,
  type ActionAdmissionContract,
  type ApprovalProofContract,
  type ActionScopeDefinition,
  type ExecutionReceiptEnvelope,
  type FindingAdmissionInput,
  type OwnerSnapshotContract,
  type SourceCompleteness,
  type SourceFactContract,
  type SourceScopeDefinition,
} from './foundation';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LifecycleActionAdmission {
  /** Optional existing finding_actions row; generic proposals do not require it. */
  id: string | null;
  actionDefinitionId: string;
  propertyId: string;
  findingId: string;
  proposalId: string;
  kind: string;
  contract: ActionAdmissionContract;
  params: Record<string, unknown>;
  verify: Record<string, unknown>;
  idempotencyKey: string;
}

/**
 * Category-neutral correlation seed for the projection row.  This is not a
 * universal work item: it is the immutable title/entity/owner snapshot that
 * lets an admitted finding be observed before a domain adapter supplies a
 * real work-item custody update.
 */
export interface LifecycleSeed {
  entityKind: string;
  entityId: string | null;
  entityLabel: string | null;
  title: string;
  summary: string | null;
  owner: OwnerSnapshotContract;
  ownerId: string | null;
  actionFindingId: string | null;
  pendingActionId: string | null;
  idempotencyKey: string;
  approvalRequired: boolean;
  conversationId: string | null;
  accountId: string | null;
  conversationSnapshot: Record<string, unknown>;
  accountSnapshot: Record<string, unknown>;
  reason: string | null;
}

export interface LifecycleAdmissionBundle {
  propertyId: string;
  findingId: string;
  sourceDefinitions: readonly SourceScopeDefinition[];
  actionDefinitions: readonly ActionScopeDefinition[];
  sourceFacts: readonly SourceFactContract[];
  finding: FindingAdmissionInput;
  lifecycle: LifecycleSeed;
  action: LifecycleActionAdmission | null;
}

export interface LifecycleRpcBundle {
  propertyId: string;
  findingId: string;
  contractVersion: string;
  detectorId: string;
  receiptQueryId: string;
  evidence: unknown;
  minimumData: unknown;
  minimumDataMet: boolean;
  asOf: string | null;
  observedAt: string | null;
  expiresAt: string | null;
  completeness: string;
  completenessReason?: string | null;
  freshness: string;
  freshnessMaxAgeSeconds: number | null;
  sourceFactIds: readonly string[];
  lifecycle: Record<string, unknown>;
}

export interface LifecycleAdmissionResult {
  admissible: boolean;
  reasons: readonly string[];
}

/** Raw, write-side source envelope. IDs/hashes on SourceFactContract are
 * intentionally absent here: the database creates the durable receipt/fact
 * IDs, receipt hash, and canonical fingerprint. */
export interface SourceFactWriteInput {
  propertyId: string;
  sourceDefinitionId: string;
  sourceReference: string;
  externalReceiptId: string | null;
  sourceHash: string;
  asOf: string;
  observedAt: string;
  receivedAt: string;
  completeness: SourceCompleteness;
  completenessReason: string | null;
  entityKind: string;
  entityId: string;
  entityLabel: string | null;
  effectiveAt: string;
  expiresAt: string | null;
  value: Record<string, unknown>;
  supersedesId: string | null;
}

export interface SourceFactWriteReceipt {
  recorded: true;
  admitted: true;
  replayed: boolean;
  receiptId: string;
  factId: string;
  receiptHash: string;
  fingerprint: string;
}

export type LifecycleAppendState =
  | 'observed'
  | 'proposed'
  | 'approved'
  | 'executed'
  | 'outcome_verified'
  | 'not_observable'
  | 'unverifiable';

export interface LifecycleDomainReference {
  /** Category-neutral domain record identity. Raw/private storage paths are not admitted. */
  kind: string;
  id: string;
  label: string | null;
  href: null;
}

export interface LifecycleAppendEvent {
  lifecycleId: string;
  eventKind: 'state_transition' | 'custody_updated';
  fromState: LifecycleAppendState;
  toState: LifecycleAppendState;
  actorAccountId: string | null;
  actorSnapshot: Record<string, unknown>;
  ownerSnapshot: OwnerSnapshotContract;
  domainReference: LifecycleDomainReference | null;
  executionReceipt?: ExecutionReceiptEnvelope | null;
  approvalProof?: ApprovalProofContract | null;
  outcomeBasis?: string | null;
  outcomeSourceFactId?: string | null;
  idempotencyKey: string;
  reason?: string | null;
}

/** An owner/domain custody observation never advances the lifecycle state. */
export type LifecycleCustodyUpdateEvent = LifecycleAppendEvent & {
  eventKind: 'custody_updated';
  fromState: LifecycleAppendState;
  toState: LifecycleAppendState;
};

const LIFECYCLE_APPEND_STATES: readonly LifecycleAppendState[] = [
  'observed',
  'proposed',
  'approved',
  'executed',
  'outcome_verified',
  'not_observable',
  'unverifiable',
];

function lifecycleAppendState(value: unknown): value is LifecycleAppendState {
  return typeof value === 'string' && (LIFECYCLE_APPEND_STATES as readonly string[]).includes(value);
}

function ownerSnapshotIsAdmissible(value: unknown): value is OwnerSnapshotContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  const kind = owner.kind;
  const allowed = kind === 'app' || kind === 'pms' || kind === 'hotel' || kind === 'company' || kind === 'staxis' || kind === 'human' || kind === 'system' || kind === 'unknown' || kind === 'unassigned';
  if (!allowed || !Object.prototype.hasOwnProperty.call(owner, 'label') || !Object.prototype.hasOwnProperty.call(owner, 'role')) return false;
  const label = owner.label;
  const role = owner.role;
  if (label !== null && (typeof label !== 'string' || label.trim().length === 0 || label.length > 200)) return false;
  if (role !== null && (typeof role !== 'string' || role.trim().length === 0 || role.length > 120)) return false;
  return kind === 'unknown' || kind === 'unassigned' || label !== null || role !== null;
}

function domainReferenceIsAdmissible(value: unknown): value is LifecycleDomainReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const domain = value as Record<string, unknown>;
  return typeof domain.kind === 'string' && domain.kind.trim().length > 0 && domain.kind.length <= 120
    && UUID_RE.test(typeof domain.id === 'string' ? domain.id : '')
    && (domain.label === null || (typeof domain.label === 'string' && domain.label.trim().length > 0 && domain.label.length <= 300))
    && domain.href === null;
}

function approvalProofIsAdmissible(value: unknown): value is ApprovalProofContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return proof.decision === 'approved'
    && nonEmpty(proof.policyId, 120)
    && (proof.mode === 'explicit_card' || proof.mode === 'conversation_confirmation')
    && (proof.tier === 'quick' || proof.tier === 'card' || proof.tier === 'conversation')
    && ((proof.mode === 'explicit_card' && proof.tier === 'card') || (proof.mode === 'conversation_confirmation' && proof.tier === 'conversation'));
}

function executionReceiptIsAdmissible(value: unknown): value is ExecutionReceiptEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const effect = objectValue(receipt.effect);
  const nestedReceipt = objectValue(receipt.receipt);
  const inputVerification = objectValue(receipt.inputVerification);
  const targetKind = receipt.targetKind;
  const targetId = receipt.targetId;
  return id(receipt.propertyId)
    && id(receipt.proposalId)
    && (receipt.actionId === null || id(receipt.actionId))
    && id(receipt.approvalId)
    && receipt.contractVersion === 'staxis-action.v1'
    && receipt.effectBoundary === 'in_app_only'
    && effect !== null
    && nonEmpty(effect.domain, 80)
    && nonEmpty(effect.operation, 120)
    && nonEmpty(effect.targetKind, 80)
    && effect.boundary === 'in_app_only'
    && nonEmpty(effect.statement, 1_000)
    && nonEmpty(effect.limit, 1_000)
    && nestedReceipt !== null
    && Object.keys(nestedReceipt).length > 0
    && receipt.internalOnly === true
    && receipt.physicalCompletionClaim === 'never'
    && nonEmpty(receipt.idempotencyKey, 300)
    && nonEmpty(targetKind, 120)
    && id(targetId)
    && isoInstant(receipt.executedAt)
    && id(receipt.executedBy)
    && typeof receipt.frozenInputHash === 'string' && /^[a-f0-9]{64}$/.test(receipt.frozenInputHash)
    && inputVerification !== null
    && inputVerification.state === 'matched'
    && isoInstant(inputVerification.verifiedAt);
}

/**
 * Validate append-only lifecycle custody envelopes before the service RPC.
 * `custody_updated` is intentionally same-state only: it records the latest
 * immutable owner/domain snapshot and cannot imply proposal, approval,
 * execution, or outcome completion.
 */
export function validateLifecycleAppendEvent(event: LifecycleAppendEvent, expectedPropertyId?: string): string[] {
  const now = new Date();
  const reasons: string[] = [];
  if (!event || typeof event !== 'object') return ['lifecycle event envelope is missing'];
  if (!id(event.lifecycleId)) reasons.push('lifecycle event identity is invalid');
  if (event.eventKind !== 'state_transition' && event.eventKind !== 'custody_updated') reasons.push('lifecycle event kind is unsupported');
  if (!lifecycleAppendState(event.fromState) || !lifecycleAppendState(event.toState)) reasons.push('lifecycle event state is unsupported');
  if (event.eventKind === 'custody_updated' && event.fromState !== event.toState) reasons.push('custody update cannot advance lifecycle state');
  if (event.eventKind === 'custody_updated' && event.fromState !== 'executed' && event.fromState !== 'outcome_verified' && event.fromState !== 'not_observable' && event.fromState !== 'unverifiable') reasons.push('custody update requires an executed or terminal lifecycle state');
  if (event.eventKind === 'state_transition' && event.fromState === event.toState) reasons.push('state transition must advance lifecycle state');
  if (event.actorAccountId !== null && !id(event.actorAccountId)) reasons.push('lifecycle actor account is invalid');
  if (!event.actorSnapshot || typeof event.actorSnapshot !== 'object' || Array.isArray(event.actorSnapshot)) reasons.push('lifecycle actor snapshot is invalid');
  if ((event.eventKind === 'state_transition' && (event.toState === 'approved' || event.toState === 'executed')) || event.eventKind === 'custody_updated') {
    if (!event.actorAccountId) reasons.push('approval/execution transition requires an authenticated actor account');
    const actor = event.actorSnapshot && typeof event.actorSnapshot === 'object' && !Array.isArray(event.actorSnapshot)
      ? event.actorSnapshot
      : {};
    const hasAuthority = typeof actor.authority === 'string' && actor.authority.trim().length > 0;
    const hasRole = typeof actor.role === 'string' && actor.role.trim().length > 0;
    if (Object.keys(actor).length === 0 || (!hasAuthority && !hasRole)) reasons.push('approval/execution transition requires a nonempty authority actor snapshot');
  }
  if (!ownerSnapshotIsAdmissible(event.ownerSnapshot)) reasons.push('lifecycle owner snapshot is invalid');
  const domainRequired = event.eventKind === 'custody_updated' || event.toState === 'executed' || event.toState === 'outcome_verified' || event.toState === 'not_observable' || event.toState === 'unverifiable';
  if (domainRequired && !domainReferenceIsAdmissible(event.domainReference)) reasons.push('executed/terminal custody requires a valid domain reference');
  if (!domainRequired && event.domainReference !== null) reasons.push('pre-execution lifecycle events cannot claim a domain work item');
  if (event.executionReceipt !== undefined && event.executionReceipt !== null && !executionReceiptIsAdmissible(event.executionReceipt)) reasons.push('lifecycle execution receipt is invalid');
  if (expectedPropertyId !== undefined && event.executionReceipt !== undefined && event.executionReceipt !== null
    && objectValue(event.executionReceipt)?.propertyId !== expectedPropertyId) reasons.push('execution receipt property does not match its scoped writer');
  if (event.approvalProof !== undefined && event.approvalProof !== null && !approvalProofIsAdmissible(event.approvalProof)) reasons.push('lifecycle approval proof is invalid');
  if (event.outcomeBasis !== undefined && event.outcomeBasis !== null && (typeof event.outcomeBasis !== 'string' || event.outcomeBasis.trim().length === 0 || event.outcomeBasis.length > 1_000)) reasons.push('lifecycle outcome basis is invalid');
  if (event.outcomeSourceFactId !== undefined && event.outcomeSourceFactId !== null && !id(event.outcomeSourceFactId)) reasons.push('lifecycle outcome source fact is invalid');
  if (typeof event.idempotencyKey !== 'string' || event.idempotencyKey.trim().length === 0 || event.idempotencyKey.length > 300) reasons.push('lifecycle event idempotency key is missing');
  if (event.reason !== undefined && event.reason !== null && (typeof event.reason !== 'string' || event.reason.trim().length === 0 || event.reason.length > 1_000)) reasons.push('lifecycle event reason is invalid');
  if (event.eventKind === 'state_transition' && event.fromState === 'proposed' && event.toState === 'approved') {
    if (!approvalProofIsAdmissible(event.approvalProof)) reasons.push('proposal approval requires an explicit approval proof');
  } else if (event.approvalProof !== undefined && event.approvalProof !== null) {
    reasons.push('approval proof is only valid on proposed-to-approved transitions');
  }
  if (event.eventKind === 'state_transition' && event.toState === 'executed' && !executionReceiptIsAdmissible(event.executionReceipt)) reasons.push('execution transition requires a typed receipt');
  if (event.eventKind === 'state_transition' && event.toState !== 'executed' && event.executionReceipt != null) reasons.push('execution receipt is only valid on the executed transition');
  if (event.eventKind === 'state_transition' && event.toState === 'executed' && executionReceiptIsAdmissible(event.executionReceipt)) {
    const receipt = event.executionReceipt;
    if (!id(receipt.propertyId)) reasons.push('execution receipt property is invalid');
    if (receipt.executedBy !== event.actorAccountId) reasons.push('execution receipt actor does not match the lifecycle event actor');
    if (!event.domainReference || receipt.targetKind !== event.domainReference.kind || receipt.targetId !== event.domainReference.id || receipt.effect.targetKind !== receipt.targetKind) reasons.push('execution receipt target does not match its domain reference/effect');
    if (dateMs(receipt.inputVerification.verifiedAt) === null || dateMs(receipt.executedAt) === null || dateMs(receipt.inputVerification.verifiedAt)! > dateMs(receipt.executedAt)!) reasons.push('execution input verification must precede execution');
    if (dateMs(receipt.executedAt)! > now.getTime() + 5 * 60_000 || dateMs(receipt.inputVerification.verifiedAt)! > now.getTime() + 5 * 60_000) reasons.push('execution receipt time is in the future');
  }
  const legalTransition = (event.fromState === 'observed' && (event.toState === 'observed' || event.toState === 'proposed'))
    || (event.fromState === 'proposed' && event.toState === 'approved')
    || (event.fromState === 'approved' && event.toState === 'executed')
    || (event.fromState === 'executed' && (event.toState === 'outcome_verified' || event.toState === 'not_observable' || event.toState === 'unverifiable'));
  if (event.eventKind === 'state_transition' && !legalTransition) reasons.push('lifecycle event transition is not legal');
  const terminal = event.toState === 'outcome_verified' || event.toState === 'not_observable' || event.toState === 'unverifiable';
  if (event.eventKind === 'state_transition' && terminal && !event.outcomeBasis) reasons.push('terminal lifecycle event requires an outcome basis');
  if (event.eventKind === 'state_transition' && event.toState === 'outcome_verified' && !id(event.outcomeSourceFactId)) reasons.push('verified outcome requires a source fact proof');
  if (event.eventKind === 'state_transition' && (event.toState === 'not_observable' || event.toState === 'unverifiable') && event.outcomeSourceFactId != null) reasons.push('unobservable outcome cannot claim a source fact proof');
  if (event.eventKind === 'state_transition' && !terminal && event.outcomeSourceFactId != null) reasons.push('outcome source fact is only valid on a terminal transition');
  if (event.eventKind === 'custody_updated' && (event.executionReceipt != null || event.approvalProof != null || event.outcomeBasis != null || event.outcomeSourceFactId != null)) reasons.push('custody update cannot carry execution, approval, or outcome proof');
  return reasons;
}

export type LifecycleBundleWriter = (bundle: LifecycleAdmissionBundle) => Promise<void>;

function id(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function nonEmpty(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function dateMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoInstant(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && dateMs(value) !== null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || id(value);
}

function safeSourceReference(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 300
    && !/[\\/]/.test(value)
    && !/(^|:)https?:\/\//i.test(value)
    && !/(attachment|storage|bucket|raw[_-]?path)/i.test(value);
}

export function validateSourceFactWriteInput(input: SourceFactWriteInput, now = new Date()): string[] {
  const reasons: string[] = [];
  if (!input || typeof input !== 'object') return ['source fact write envelope is missing'];
  if (!id(input.propertyId) || !id(input.sourceDefinitionId)) reasons.push('source fact write property or definition identity is invalid');
  if (!safeSourceReference(input.sourceReference)) reasons.push('source reference is missing or exposes a private path');
  if (input.externalReceiptId !== null && (!nonEmpty(input.externalReceiptId, 200) || /[\\/]/.test(input.externalReceiptId) || /(^|:)https?:\/\//i.test(input.externalReceiptId))) reasons.push('external receipt identity is invalid');
  if (!/^[a-f0-9]{64}$/.test(input.sourceHash ?? '')) reasons.push('source content hash is missing or invalid');
  const asOf = dateMs(input.asOf);
  const observedAt = dateMs(input.observedAt);
  const receivedAt = dateMs(input.receivedAt);
  const effectiveAt = dateMs(input.effectiveAt);
  const expiresAt = input.expiresAt === null ? null : dateMs(input.expiresAt);
  if (asOf === null || observedAt === null || receivedAt === null || effectiveAt === null) reasons.push('source fact write clocks are invalid');
  const tolerance = 5 * 60_000;
  if (asOf !== null && observedAt !== null && asOf > observedAt) reasons.push('source write as-of is after observed time');
  if (observedAt !== null && receivedAt !== null && observedAt > receivedAt) reasons.push('source write observed time is after receipt time');
  if (observedAt !== null && observedAt > now.getTime() + tolerance) reasons.push('source write observed time is in the future');
  if (receivedAt !== null && receivedAt > now.getTime() + tolerance) reasons.push('source write receipt time is in the future');
  if (expiresAt !== null && observedAt !== null && expiresAt <= observedAt) reasons.push('source write expiry must be after observed time');
  if (!nonEmpty(input.entityKind, 120) || !nonEmpty(input.entityId, 240)) reasons.push('source fact write entity identity is missing');
  if (input.entityLabel !== null && !nonEmpty(input.entityLabel, 200)) reasons.push('source fact write entity label is invalid');
  if (input.completeness !== 'complete' && input.completeness !== 'partial' && input.completeness !== 'unknown') reasons.push('source fact write completeness is unsupported');
  if (input.completeness !== 'complete' && !nonEmpty(input.completenessReason, 500)) reasons.push('source fact write incomplete data needs a reason');
  if (input.completeness === 'complete' && input.completenessReason !== null) reasons.push('complete source write cannot carry a completeness reason');
  if (!objectValue(input.value)) reasons.push('source fact write value must be an object');
  if (input.supersedesId !== null && !id(input.supersedesId)) reasons.push('source fact write superseded identity is invalid');
  return reasons;
}

/** Exact write envelope for `staxis_record_source_fact`; the database derives
 * receipt/fact IDs, receipt hash, freshness, authority, and fingerprint. */
export function toSourceFactRpcBundle(input: SourceFactWriteInput): Record<string, unknown> {
  return {
    propertyId: input.propertyId,
    sourceDefinitionId: input.sourceDefinitionId,
    receipt: {
      receiptId: input.externalReceiptId,
      sourceReference: input.sourceReference,
      sourceHash: input.sourceHash,
      asOf: input.asOf,
      observedAt: input.observedAt,
      receivedAt: input.receivedAt,
      completeness: input.completeness,
      completenessReason: input.completenessReason,
    },
    fact: {
      entityKind: input.entityKind,
      entityId: input.entityId,
      entityLabel: input.entityLabel,
      effectiveAt: input.effectiveAt,
      expiresAt: input.expiresAt,
      completeness: input.completeness,
      completenessReason: input.completenessReason,
      value: input.value,
      supersedesId: input.supersedesId,
    },
  };
}

function seedShape(seed: LifecycleSeed | null | undefined, bundle: LifecycleAdmissionBundle): string[] {
  const reasons: string[] = [];
  if (!seed || typeof seed !== 'object') return ['lifecycle seed is missing'];
  if (!nonEmpty(seed.entityKind, 120)) reasons.push('lifecycle entity kind is missing');
  if (seed.entityId !== null && !nonEmpty(seed.entityId, 240)) reasons.push('lifecycle entity identity is invalid');
  if (seed.entityLabel !== null && !nonEmpty(seed.entityLabel, 200)) reasons.push('lifecycle entity label is invalid');
  if (!nonEmpty(seed.title, 500)) reasons.push('lifecycle title is missing');
  if (seed.summary !== null && !nonEmpty(seed.summary, 2_000)) reasons.push('lifecycle summary is invalid');
  if (!ownerSnapshotIsAdmissible(seed.owner)) reasons.push('lifecycle seed owner snapshot is invalid');
  if (seed.ownerId !== null && !nonEmpty(seed.ownerId, 200)) reasons.push('lifecycle owner identity is invalid');
  if (seed.actionFindingId !== null && (!bundle.action || !bundle.action.id || seed.actionFindingId !== bundle.action.id)) reasons.push('lifecycle seed action reference is invalid');
  if (seed.actionFindingId === null && bundle.action !== null && bundle.action.id !== null) reasons.push('lifecycle seed action reference is missing or not optional');
  if (seed.pendingActionId !== null && !id(seed.pendingActionId)) reasons.push('lifecycle pending action reference is invalid');
  if (!nonEmpty(seed.idempotencyKey, 300)) reasons.push('lifecycle seed idempotency key is missing');
  if (typeof seed.approvalRequired !== 'boolean') reasons.push('lifecycle approval requirement is invalid');
  if (!nullableUuid(seed.conversationId) || !nullableUuid(seed.accountId)) reasons.push('lifecycle account/conversation identity is invalid');
  if (!objectValue(seed.conversationSnapshot) || !objectValue(seed.accountSnapshot)) reasons.push('lifecycle account snapshots are invalid');
  if (seed.reason !== null && !nonEmpty(seed.reason, 1_000)) reasons.push('lifecycle seed reason is invalid');
  return reasons;
}

/**
 * Convert the typed admission bundle into the exact JSON envelope consumed by
 * `staxis_admit_lifecycle_bundle`. Keeping this mapper explicit prevents
 * nested domain objects or private evidence fields from being passed through
 * to the service RPC by accident.
 */
export function toLifecycleRpcBundle(bundle: LifecycleAdmissionBundle): LifecycleRpcBundle {
  const minimumData = objectValue(bundle.finding.minimumData);
  const lifecycle = bundle.lifecycle;
  return {
    propertyId: bundle.propertyId,
    findingId: bundle.findingId,
    contractVersion: SOURCE_FACT_CONTRACT_VERSION,
    detectorId: bundle.finding.detectorId,
    receiptQueryId: bundle.finding.receiptQueryId,
    evidence: bundle.finding.evidence,
    minimumData: bundle.finding.minimumData,
    minimumDataMet: minimumData?.met === true,
    asOf: bundle.finding.asOf,
    observedAt: bundle.finding.observedAt,
    expiresAt: bundle.finding.expiresAt,
    completeness: bundle.finding.completeness,
    completenessReason: typeof minimumData?.reason === 'string' ? minimumData.reason : null,
    freshness: bundle.finding.freshness,
    freshnessMaxAgeSeconds: bundle.finding.freshnessMaxAgeSeconds,
    sourceFactIds: bundle.finding.sourceFactIds,
    lifecycle: {
      pendingActionId: lifecycle.pendingActionId,
      entityKind: lifecycle.entityKind,
      entityId: lifecycle.entityId,
      entityLabel: lifecycle.entityLabel,
      title: lifecycle.title,
      summary: lifecycle.summary,
      proposalId: bundle.action?.proposalId ?? null,
      actionDefinitionId: bundle.action?.actionDefinitionId ?? null,
      actionKind: bundle.action?.kind ?? null,
      findingActionId: lifecycle.actionFindingId,
      actionContract: bundle.action?.contract ?? null,
      approvalRequired: lifecycle.approvalRequired,
      frozenInput: bundle.action ? {
        propertyId: bundle.propertyId,
        findingId: bundle.findingId,
        params: bundle.action.params,
        verify: bundle.action.verify,
      } : null,
      actionIdempotencyKey: bundle.action?.idempotencyKey ?? null,
      lifecycleIdempotencyKey: lifecycle.idempotencyKey,
      ownerKind: lifecycle.owner.kind,
      ownerId: lifecycle.ownerId,
      ownerLabel: lifecycle.owner.label,
      ownerRole: lifecycle.owner.role,
      conversationId: lifecycle.conversationId,
      accountId: lifecycle.accountId,
      conversationSnapshot: lifecycle.conversationSnapshot,
      accountSnapshot: lifecycle.accountSnapshot,
      reason: lifecycle.reason,
    },
  };
}

/**
 * Validate a complete opt-in bundle before any persistence call. Legacy
 * finding/tool paths never call this function and therefore keep their
 * existing behavior; future producers must provide the source/finding/action
 * envelope here or it is rejected without a partial write. Chain links are
 * derived by the database from scoped foreign keys and append-only events;
 * callers cannot self-declare a successful custody chain.
 */
export function validateLifecycleAdmission(
  bundle: LifecycleAdmissionBundle,
  now = new Date(),
): LifecycleAdmissionResult {
  const reasons: string[] = [];
  if (!bundle || typeof bundle !== 'object' || !id(bundle.propertyId)) return { admissible: false, reasons: ['lifecycle bundle property is invalid'] };
  reasons.push(...seedShape(bundle.lifecycle, bundle));
  const sourceDefinitionsRaw = Array.isArray(bundle.sourceDefinitions) ? bundle.sourceDefinitions : null;
  const actionDefinitionsRaw = Array.isArray(bundle.actionDefinitions) ? bundle.actionDefinitions : null;
  if (!sourceDefinitionsRaw) reasons.push('source definition catalog is missing');
  if (!actionDefinitionsRaw) reasons.push('action definition catalog is missing');
  const sourceCatalogMalformed = sourceDefinitionsRaw?.some((definition) => !definition || typeof definition !== 'object' || Array.isArray(definition)) ?? true;
  const actionCatalogMalformed = actionDefinitionsRaw?.some((definition) => !definition || typeof definition !== 'object' || Array.isArray(definition)) ?? true;
  if (sourceCatalogMalformed) reasons.push('source definition catalog contains malformed entries');
  if (actionCatalogMalformed) reasons.push('action definition catalog contains malformed entries');
  const definitions = sourceCatalogMalformed ? [] : (sourceDefinitionsRaw ?? []);
  const actionDefinitions = actionCatalogMalformed ? [] : (actionDefinitionsRaw ?? []);
  if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length) reasons.push('source definition catalog contains duplicate IDs');
  if (new Set(actionDefinitions.map((definition) => definition.id)).size !== actionDefinitions.length) reasons.push('action definition catalog contains duplicate IDs');
  const facts = Array.isArray(bundle.sourceFacts) ? bundle.sourceFacts : [];
  if (facts.length === 0) reasons.push('lifecycle bundle has no source facts');
  const malformedFacts = facts.some((fact) => !fact || typeof fact !== 'object' || Array.isArray(fact));
  if (malformedFacts) reasons.push('lifecycle bundle source facts contain malformed entries');
  if (new Set(facts.map((fact) => fact && typeof fact === 'object' && !Array.isArray(fact) ? fact.id : null)).size !== facts.length) reasons.push('lifecycle bundle source facts contain duplicate identities');

  for (const fact of facts) {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) continue;
    const definition = sourceScopeDefinitionFor(definitions, fact.sourceDefinitionId);
    const result = admitSourceFact(fact, now, definition);
    if (!result.admissible) reasons.push(...result.reasons.map((reason) => `source fact ${fact.id}: ${reason}`));
    if (fact.propertyId !== bundle.propertyId) reasons.push(`source fact ${fact.id}: property boundary is invalid`);
  }

  const finding = bundle.finding;
  if (!id(bundle.findingId)) reasons.push('lifecycle bundle finding identity is invalid');
  if (!finding || finding.propertyId !== bundle.propertyId) reasons.push('finding property does not match lifecycle bundle');
  if (finding && typeof finding === 'object' && !Array.isArray(finding)) {
    const findingResult = admitFinding({
      ...finding,
      propertyId: bundle.propertyId,
      sourceFacts: facts.filter((fact): fact is SourceFactContract => Boolean(fact && typeof fact === 'object' && !Array.isArray(fact))),
      sourceDefinitions: definitions,
    }, now);
    if (!findingResult.admissible) reasons.push(...findingResult.reasons.map((reason) => `finding: ${reason}`));
  } else {
    reasons.push('finding admission envelope is malformed');
  }

  if (bundle.action) {
    const action = bundle.action;
    if (typeof action !== 'object' || Array.isArray(action)) {
      reasons.push('action admission envelope is malformed');
    } else {
      if ((action.id !== null && !id(action.id)) || !id(action.findingId) || !id(action.proposalId) || action.propertyId !== bundle.propertyId || action.findingId !== bundle.findingId) reasons.push('action identity/property is invalid');
      const actionDefinition = actionScopeDefinitionFor(actionDefinitions, action.actionDefinitionId);
      if (!actionDefinition || validateActionScopeDefinition(actionDefinition, now).length > 0 || actionDefinition.propertyId !== bundle.propertyId || actionDefinition.actionKind !== action.kind || canonicalJson(actionDefinition.contract) !== canonicalJson(action.contract)) reasons.push('action definition is missing, cross-property, changed, or does not match the proposal');
      if (!nonEmpty(action.kind) || !nonEmpty(action.idempotencyKey, 300)) reasons.push('action identity or idempotency key is missing');
      if (!actionContractIsAdmissible(action.contract)) reasons.push('action contract is incomplete or outside the in-app boundary');
      if (!objectValue(action.params) || !objectValue(action.verify)) reasons.push('action frozen params and verification must be plain objects');
      const expectedFrozenFields = ['propertyId', 'findingId', 'params', 'verify'];
      const actualFrozenFields = action.contract?.frozenInput?.fields;
      if (!Array.isArray(actualFrozenFields) || actualFrozenFields.length !== expectedFrozenFields.length || expectedFrozenFields.some((field) => !actualFrozenFields.includes(field))) reasons.push('action frozen-input fields do not match the server wrapper');
      const lifecycle = bundle.lifecycle && typeof bundle.lifecycle === 'object' && !Array.isArray(bundle.lifecycle) ? bundle.lifecycle : null;
      if (!lifecycle || lifecycle.approvalRequired !== true) reasons.push('action lifecycle seed must require explicit approval');
      if (!finding || finding.completeness !== 'complete' || finding.freshness !== 'fresh') reasons.push('lifecycle action requires complete and fresh source proof');
    }
  } else if (bundle.lifecycle && typeof bundle.lifecycle === 'object' && !Array.isArray(bundle.lifecycle) && bundle.lifecycle.approvalRequired !== false) {
    reasons.push('observed no-action lifecycle seed must not require approval');
  }

  return { admissible: reasons.length === 0, reasons };
}

/**
 * Atomically hand an admitted bundle to the database adapter. The adapter is
 * expected to call one transaction/RPC; a thrown or rejected write is always
 * reported as failure and never converted into an execution success claim.
 */
export async function persistLifecycleBundle(
  bundle: LifecycleAdmissionBundle,
  writer: LifecycleBundleWriter,
  now = new Date(),
): Promise<LifecycleAdmissionResult> {
  const admission = validateLifecycleAdmission(bundle, now);
  if (!admission.admissible) return admission;
  try {
    const writeResult = await (writer as (value: LifecycleAdmissionBundle) => Promise<unknown>)(bundle);
    if (writeResult !== undefined) {
      return { admissible: false, reasons: ['lifecycle bundle writer returned an ambiguous receipt'] };
    }
    return { admissible: true, reasons: [] };
  } catch (error) {
    return { admissible: false, reasons: [`lifecycle bundle write failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/** Production adapter hook once the additive migration's transaction RPC is available. */
export function rpcLifecycleBundleWriter(propertyId: string): LifecycleBundleWriter {
  return async (bundle) => {
    if (bundle.propertyId !== propertyId) throw new Error('lifecycle bundle property does not match its scoped writer');
    const admission = validateLifecycleAdmission(bundle);
    if (!admission.admissible) throw new Error(`lifecycle bundle rejected: ${admission.reasons.join('; ')}`);
    const envelope = toLifecycleRpcBundle(bundle);
    const { data, error } = await scopedDb(propertyId).rpc('staxis_admit_lifecycle_bundle', {
      p_property_id: propertyId,
      p_bundle: envelope,
    });
    if (error) throw new Error(error.message);
    const receiptErrors = validateLifecycleBundleRpcReceipt(data, bundle);
    if (receiptErrors.length > 0) throw new Error(`lifecycle custody RPC returned an invalid receipt: ${receiptErrors.join('; ')}`);
  };
}

/**
 * Validate the complete response from `staxis_admit_lifecycle_bundle` before
 * treating an RPC call as durable success. The source-fact set is repeated in
 * the response so a malformed/partial service result cannot look like a
 * successful tenant-scoped admission.
 */
export function validateLifecycleBundleRpcReceipt(
  value: unknown,
  bundle: LifecycleAdmissionBundle,
): string[] {
  const reasons: string[] = [];
  const result = objectValue(value);
  if (!result) return ['lifecycle custody RPC did not return an object receipt'];
  if (result.admitted !== true) reasons.push('lifecycle custody RPC did not admit the bundle');
  if (typeof result.replayed !== 'boolean') reasons.push('lifecycle custody RPC replay flag is missing');
  if (!id(result.admissionId) || !id(result.lifecycleId)) reasons.push('lifecycle custody RPC returned incomplete lifecycle IDs');

  const expectedFindingIds = Array.isArray(bundle.finding?.sourceFactIds) ? bundle.finding.sourceFactIds : [];
  const expectedFactIds = Array.isArray(bundle.sourceFacts) ? bundle.sourceFacts.map((fact) => fact?.id) : [];
  const returnedFactIds = result.sourceFactIds;
  const normalizeUuidSet = (values: unknown): { ids: Set<string>; valid: boolean; duplicate: boolean } => {
    if (!Array.isArray(values)) return { ids: new Set(), valid: false, duplicate: false };
    const ids = new Set<string>();
    let duplicate = false;
    for (const value of values) {
      if (!id(value)) return { ids, valid: false, duplicate };
      const normalized = value.toLowerCase();
      if (ids.has(normalized)) duplicate = true;
      ids.add(normalized);
    }
    return { ids, valid: true, duplicate };
  };
  const expectedFinding = normalizeUuidSet(expectedFindingIds);
  const expectedFacts = normalizeUuidSet(expectedFactIds);
  const returned = normalizeUuidSet(returnedFactIds);
  if (!expectedFinding.valid || !expectedFacts.valid || !returned.valid) reasons.push('lifecycle custody RPC source fact IDs are malformed');
  if (expectedFinding.duplicate || expectedFacts.duplicate || returned.duplicate) reasons.push('lifecycle custody RPC source fact IDs are duplicated');
  if (expectedFinding.ids.size !== expectedFacts.ids.size || [...expectedFinding.ids].some((id) => !expectedFacts.ids.has(id))) reasons.push('finding and loaded source fact IDs do not match');
  if (returned.ids.size !== expectedFinding.ids.size || [...expectedFinding.ids].some((id) => !returned.ids.has(id))) reasons.push('lifecycle custody RPC source fact IDs do not match the admitted set');

  if (bundle.action) {
    if (result.proposalId !== bundle.action.proposalId || typeof result.frozenInputHash !== 'string' || !/^[a-f0-9]{64}$/.test(result.frozenInputHash)) {
      reasons.push('lifecycle custody RPC did not return the DB-derived proposal hash');
    }
  } else if (result.proposalId !== null || result.frozenInputHash !== null) {
    reasons.push('observation-only lifecycle receipt must not contain proposal identity or frozen input hash');
  }
  return reasons;
}

/** Append one raw source fact through the DB's atomic receipt/fact RPC. */
export function rpcSourceFactWriter(propertyId: string): (input: SourceFactWriteInput) => Promise<SourceFactWriteReceipt> {
  return async (input) => {
    if (input.propertyId !== propertyId) throw new Error('source fact property does not match its scoped writer');
    const reasons = validateSourceFactWriteInput(input);
    if (reasons.length > 0) throw new Error(`source fact write rejected: ${reasons.join('; ')}`);
    const { data, error } = await scopedDb(propertyId).rpc('staxis_record_source_fact', {
      p_property_id: propertyId,
      p_bundle: toSourceFactRpcBundle(input),
    });
    if (error) throw new Error(error.message);
    if (!data || typeof data !== 'object' || Array.isArray(data) || (data as Record<string, unknown>).recorded !== true) throw new Error('source fact RPC did not return a recorded receipt');
    const result = data as Record<string, unknown>;
    const receiptId = result.receiptId;
    const factId = result.factId;
    const receiptHash = result.receiptHash;
    const fingerprint = result.fingerprint;
    if (result.admitted !== true || typeof result.replayed !== 'boolean' || !id(receiptId) || !id(factId) || typeof receiptHash !== 'string' || !/^[a-f0-9]{64}$/.test(receiptHash) || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error('source fact RPC returned an incomplete durable receipt');
    }
    return {
      recorded: true,
      admitted: true,
      replayed: result.replayed,
      receiptId,
      factId,
      receiptHash,
      fingerprint,
    };
  };
}

/** Append a lifecycle transition or same-state custody update only through the custody RPC. */
export function rpcLifecycleEventWriter(propertyId: string): (event: LifecycleAppendEvent) => Promise<Record<string, unknown>> {
  return async (event) => {
    const reasons = validateLifecycleAppendEvent(event, propertyId);
    if (reasons.length > 0) throw new Error(`lifecycle event rejected: ${reasons.join('; ')}`);
    const { data, error } = await scopedDb(propertyId).rpc('staxis_append_lifecycle_event', {
      p_property_id: propertyId,
      p_bundle: event,
    });
    if (error) throw new Error(error.message);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('lifecycle event RPC did not return an append receipt');
    const result = data as Record<string, unknown>;
    if (result.recorded !== true || typeof result.replayed !== 'boolean' || !id(result.eventId) || result.state !== event.toState) {
      throw new Error('lifecycle event RPC returned an incomplete or mismatched append receipt');
    }
    return result;
  };
}

/** Explicit category-neutral owner/domain custody update helper. */
export function rpcLifecycleCustodyUpdateWriter(propertyId: string): (event: LifecycleCustodyUpdateEvent) => Promise<Record<string, unknown>> {
  const append = rpcLifecycleEventWriter(propertyId);
  return (event) => append(event);
}
