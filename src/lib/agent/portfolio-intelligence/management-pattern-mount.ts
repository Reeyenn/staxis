import 'server-only';

import type { AuthorizationScopeReceipt } from '@/lib/authorization';

import type { PortfolioEvidencePackageV1 } from './evidence';
import {
  PORTFOLIO_FINDING_MAX_PROMPT_ITEMS,
  adaptManagementPatternPortfolioLoadArtifact,
  buildPortfolioFindingProjection,
  buildPortfolioFindingProjectionReceipt,
  type ManagementPatternPortfolioLoadAdapterResult,
  type PortfolioFindingMountedReceiptV1,
  type PortfolioFindingProjectionV1,
} from './pattern-contract';
import { buildPortfolioFindingPresentationProjection } from './presentation';

export const PORTFOLIO_FINDING_LOAD_BUDGET_MS = 2_000;
const PORTFOLIO_FINDING_ABORT_SETTLE_GRACE_MS = 250;

export interface ManagementPatternPortfolioArtifactLoader {
  (input: {
    readonly accountId: string;
    readonly scopeReceiptId: string;
    readonly selectedPropertyIds: readonly string[];
    readonly asOf?: Date;
    readonly maxFindings?: number;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

class PortfolioFindingDeadlineError extends Error {
  constructor() {
    super('management pattern portfolio load exceeded its wall-clock budget');
    this.name = 'PortfolioFindingDeadlineError';
  }
}

/** Abort the underlying RPC at the narrow finding deadline. A short bounded
 * settle window lets the producer turn that abort into its signed unavailable
 * artifact; a loader that ignores AbortSignal fails the whole request instead
 * of silently becoming an unrecorded or supposedly complete finding load. */
async function loadArtifactWithinDeadline(input: {
  receipt: AuthorizationScopeReceipt;
  now: Date;
  signal?: AbortSignal;
  deadlineAt: number;
  loadArtifact: ManagementPatternPortfolioArtifactLoader;
}): Promise<{ artifact: unknown; deadlineExpired: boolean }> {
  if (!Number.isFinite(input.deadlineAt)) {
    throw new TypeError('management pattern mount requires a finite deadline');
  }
  const remainingMs = Math.floor(input.deadlineAt - Date.now());
  if (remainingMs <= 0) throw new PortfolioFindingDeadlineError();

  const deadlineSignal = AbortSignal.timeout(remainingMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadlineSignal])
    : deadlineSignal;
  const loadPromise = input.loadArtifact({
    accountId: input.receipt.accountId,
    scopeReceiptId: input.receipt.id,
    selectedPropertyIds: input.receipt.propertyIds,
    asOf: input.now,
    maxFindings: PORTFOLIO_FINDING_MAX_PROMPT_ITEMS,
    signal,
  });
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  const hardDeadline = new Promise<never>((_resolve, reject) => {
    hardTimer = setTimeout(
      () => reject(new PortfolioFindingDeadlineError()),
      remainingMs + PORTFOLIO_FINDING_ABORT_SETTLE_GRACE_MS,
    );
  });
  try {
    const artifact = await Promise.race([loadPromise, hardDeadline]);
    return { artifact, deadlineExpired: deadlineSignal.aborted };
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
}

/** Load, fingerprint-verify, and consume one exact producer page without yet
 * choosing whether its accepted claims belong in a presentation surface. */
export async function loadManagementPatternFindingPackage(input: {
  receipt: AuthorizationScopeReceipt;
  now: Date;
  signal?: AbortSignal;
  deadlineAt: number;
  loadArtifact: ManagementPatternPortfolioArtifactLoader;
}): Promise<ManagementPatternPortfolioLoadAdapterResult> {
  if (Number.isNaN(input.now.getTime())) {
    throw new TypeError('management pattern mount requires a valid current instant');
  }
  const loaded = await loadArtifactWithinDeadline(input);
  // This adapter verifies the producer fingerprint and invokes
  // consumePortfolioFindings over the raw claim page. No producer DTO crosses
  // into presentation merely because TypeScript assigned it a trusted type.
  const consumed = adaptManagementPatternPortfolioLoadArtifact({
    artifact: loaded.artifact,
    accountId: input.receipt.accountId,
    organizationId: input.receipt.organizationId,
    scopeReceiptId: input.receipt.id,
    authorizationHash: input.receipt.authorizationHash,
    scopeHash: input.receipt.scopeHash,
    authorizedPropertyIds: input.receipt.authorizedPropertyIds,
    selectedPropertyIds: input.receipt.propertyIds,
    now: input.now.toISOString(),
  });
  if (loaded.deadlineExpired
      && (consumed.producer.status !== 'unavailable'
        || consumed.producer.outage.reason !== 'deadline_exceeded')) {
    throw new PortfolioFindingDeadlineError();
  }
  return consumed;
}

/** Knowledge lookup has its own deterministic claim catalog. Findings are
 * still loaded and receipted, but a zero projection budget makes every
 * consumer-accepted claim an explicit item omission rather than allowing it
 * into either the knowledge answer or a model prompt. */
export async function loadManagementPatternKnowledgeFindingReceipt(input: {
  receipt: AuthorizationScopeReceipt;
  now: Date;
  signal?: AbortSignal;
  deadlineAt: number;
  loadArtifact: ManagementPatternPortfolioArtifactLoader;
}): Promise<PortfolioFindingMountedReceiptV1> {
  const consumed = await loadManagementPatternFindingPackage(input);
  const projection = buildPortfolioFindingProjection({
    packageValue: consumed.packageValue,
    accountId: input.receipt.accountId,
    authorizationHash: input.receipt.authorizationHash,
    scopeHash: input.receipt.scopeHash,
    maxProjectedItems: 0,
    producer: consumed.producer,
  });
  return buildPortfolioFindingProjectionReceipt({
    projection,
    displayedClaimIds: [],
  });
}

/**
 * Production mount for the independently validated management-pattern
 * artifact. The producer receives only the finalized receipt identity and its
 * exact selected property set. The consumer wall separately receives the
 * receipt's full authorization universe so a narrowed selection can never be
 * mistaken for the caller's complete reach.
 *
 * Every producer status becomes a mounted projection receipt. Only `loaded`
 * (which the producer contract restricts to a fresh active run) may project
 * claims; shadow, stale, incomplete, unavailable, and other zero-claim states
 * remain observable without entering the model-facing catalog.
 */
export async function loadManagementPatternFindingProjection(input: {
  receipt: AuthorizationScopeReceipt;
  evidence: PortfolioEvidencePackageV1;
  now: Date;
  signal?: AbortSignal;
  deadlineAt: number;
  loadArtifact: ManagementPatternPortfolioArtifactLoader;
}): Promise<PortfolioFindingProjectionV1> {
  if (Number.isNaN(input.now.getTime())) {
    throw new TypeError('management pattern mount requires a valid current instant');
  }
  if (input.evidence.organizationId !== input.receipt.organizationId
      || input.evidence.scopeReceiptId !== input.receipt.id
      || input.evidence.scopeHash !== input.receipt.scopeHash
      || !sameIds(input.evidence.authorizedPropertyIds, input.receipt.authorizedPropertyIds)
      || !sameIds(input.evidence.selectedPropertyIds, input.receipt.propertyIds)) {
    throw new TypeError('management pattern mount requires the finalized evidence receipt');
  }

  const consumed = await loadManagementPatternFindingPackage(input);
  const projection = buildPortfolioFindingPresentationProjection({
    evidence: input.evidence,
    packageValue: consumed.packageValue,
    accountId: input.receipt.accountId,
    authorizationHash: input.receipt.authorizationHash,
    producer: consumed.producer,
  });
  if (projection.producer.projectionMode !== 'active'
      && projection.projectedClaimIds.length > 0) {
    throw new TypeError('non-active management pattern projection exposed a claim');
  }
  return projection;
}
