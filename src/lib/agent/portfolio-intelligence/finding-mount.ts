import 'server-only';

import type { AuthorizationScopeReceipt } from '@/lib/authorization';
import { loadManagementPatternPortfolioFindings } from '@/lib/company/management-patterns/portfolio-findings';

import { createPortfolioQueryAbortContext } from './cancellation';
import {
  PORTFOLIO_FINDING_MAX_SELECTED_PROPERTIES,
  PORTFOLIO_FINDING_MAX_PROMPT_ITEMS,
  adaptManagementPatternPortfolioLoadArtifact,
  type ManagementPatternPortfolioLoadAdapterResult,
} from './pattern-contract';

export const portfolioFindingLoader = loadManagementPatternPortfolioFindings;

export interface PortfolioFindingMountDependencies {
  loadFindings: typeof portfolioFindingLoader;
}

const PORTFOLIO_FINDING_MOUNT_DEPENDENCIES: PortfolioFindingMountDependencies = Object.freeze({
  loadFindings: portfolioFindingLoader,
});

export class PortfolioFindingScopeTooLargeError extends Error {
  readonly selectedPropertyCount: number;

  constructor(selectedPropertyCount: number) {
    super(`portfolio finding scope exceeds ${PORTFOLIO_FINDING_MAX_SELECTED_PROPERTIES} hotels`);
    this.name = 'PortfolioFindingScopeTooLargeError';
    this.selectedPropertyCount = selectedPropertyCount;
  }
}

/**
 * The only route-facing bridge from the independently owned Finding Patterns
 * producer into Portfolio Intelligence. The raw loader artifact is kept local
 * to this function and crosses the trust boundary only through the structural
 * adapter, which in turn supplies only its `findings` page to the consumer.
 *
 * Keep the two property sets deliberately separate: `authorizedPropertyIds`
 * is the complete prepared authorization universe, while `propertyIds` is the
 * exact selector-scoped subset for this turn.
 */
export async function loadAndConsumePortfolioFindings(
  input: {
    receipt: AuthorizationScopeReceipt;
    now: Date;
    deadlineAt: number;
    signal?: AbortSignal;
  },
  dependencies: PortfolioFindingMountDependencies = PORTFOLIO_FINDING_MOUNT_DEPENDENCIES,
): Promise<ManagementPatternPortfolioLoadAdapterResult> {
  if (input.receipt.propertyIds.length > PORTFOLIO_FINDING_MAX_SELECTED_PROPERTIES) {
    throw new PortfolioFindingScopeTooLargeError(input.receipt.propertyIds.length);
  }
  const abortContext = createPortfolioQueryAbortContext({
    deadlineAt: input.deadlineAt,
    parentSignal: input.signal,
  });
  let artifact;
  try {
    artifact = await dependencies.loadFindings({
      accountId: input.receipt.accountId,
      scopeReceiptId: input.receipt.id,
      selectedPropertyIds: [...input.receipt.propertyIds],
      asOf: input.now,
      maxFindings: PORTFOLIO_FINDING_MAX_PROMPT_ITEMS,
      signal: abortContext.signal,
    });
  } finally {
    abortContext.cleanup();
  }
  return adaptManagementPatternPortfolioLoadArtifact({
    artifact,
    accountId: input.receipt.accountId,
    organizationId: input.receipt.organizationId,
    scopeReceiptId: input.receipt.id,
    authorizationHash: input.receipt.authorizationHash,
    scopeHash: input.receipt.scopeHash,
    authorizedPropertyIds: [...input.receipt.authorizedPropertyIds],
    selectedPropertyIds: [...input.receipt.propertyIds],
    now: input.now.toISOString(),
  });
}
