import 'server-only';

import { readBookedRoomsWithSnapshots } from './snapshots';
import type {
  PortfolioEvidencePackageV1,
  PortfolioMetricCoverageV1,
  PropertyMetricEvidenceV1,
} from './evidence';
import { metricDefinition } from './metrics';
import { readOperationalMetrics } from './operational-metrics';
import type {
  PlannerScopeCatalog,
  PortfolioMetricId,
  PortfolioQueryPlan,
  ScopeHotelCandidate,
} from './schemas';
import {
  MAX_EXACT_PORTFOLIO_PROPERTIES,
  PORTFOLIO_EVIDENCE_VERSION,
  PORTFOLIO_QUERY_TIMEOUT_MS,
} from './versions';
import {
  createPortfolioQueryAbortContext,
  PortfolioQueryInterruptedError,
} from './cancellation';

export { PortfolioQueryInterruptedError } from './cancellation';

export interface PortfolioScopeReceiptView {
  id: string;
  accountId: string;
  organizationId: string;
  organizationName: string | null;
  authorizationHash: string;
  scopeHash: string;
  resolvedAt: string;
  expiresAt: string;
  authorizedPropertyIds: string[];
  propertyIds: string[];
}

export type ScopeReceiptAssertion =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'revoked_or_changed' | 'not_found' | string };

export class PortfolioScopeChangedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super('Portfolio authorization changed while the question was running. No answer was released.');
    this.name = 'PortfolioScopeChangedError';
    this.reason = reason;
  }
}

export class PortfolioQueryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortfolioQueryContractError';
  }
}

interface PortfolioMetricReaders {
  bookedRooms: typeof readBookedRoomsWithSnapshots;
  operational: typeof readOperationalMetrics;
}

const DEFAULT_READERS: PortfolioMetricReaders = {
  bookedRooms: readBookedRoomsWithSnapshots,
  operational: readOperationalMetrics,
};

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function expectedIds(
  plan: PortfolioQueryPlan,
  catalog: PlannerScopeCatalog,
  authorizedPropertyIds: readonly string[],
): string[] {
  switch (plan.selector.kind) {
    case 'all_authorized':
      return sortedUnique(authorizedPropertyIds);
    case 'hotel':
      return [plan.selector.propertyId];
    case 'explicit_subset':
      return sortedUnique(plan.selector.propertyIds);
    case 'portfolio': {
      const portfolioId = plan.selector.portfolioId;
      const portfolio = catalog.portfolios.find((candidate) => candidate.portfolioId === portfolioId);
      if (!portfolio) throw new PortfolioQueryContractError('The requested portfolio is not in the freshly authorized catalog.');
      return sortedUnique(portfolio.propertyIds);
    }
  }
}

function placeholderHotel(propertyId: string): ScopeHotelCandidate {
  return {
    propertyId,
    name: `Hotel ${propertyId.slice(0, 8)}`,
    city: null,
    region: null,
    propertyCode: null,
    timezone: null,
    businessDateCutoffHour: null,
    totalRooms: null,
    portfolioIds: [],
  };
}

function hotelsForReceipt(
  receipt: PortfolioScopeReceiptView,
  catalog: PlannerScopeCatalog,
): ScopeHotelCandidate[] {
  if (catalog.organizationId !== receipt.organizationId) {
    throw new PortfolioQueryContractError('The hotel catalog belongs to a different organization than the scope receipt.');
  }
  const authorized = new Set(receipt.authorizedPropertyIds);
  const byId = new Map<string, ScopeHotelCandidate>();
  for (const hotel of catalog.hotels) {
    if (!authorized.has(hotel.propertyId)) {
      throw new PortfolioQueryContractError('The hotel catalog contains a property outside the receipt authorization set.');
    }
    if (byId.has(hotel.propertyId)) {
      throw new PortfolioQueryContractError('The hotel catalog contains a duplicate property id.');
    }
    byId.set(hotel.propertyId, hotel);
  }
  return receipt.propertyIds.map((id) => byId.get(id) ?? placeholderHotel(id));
}

function aggregateMetric(
  metricId: PortfolioMetricId,
  facts: readonly PropertyMetricEvidenceV1[],
): PortfolioEvidencePackageV1['aggregates'][number] | null {
  const metricFacts = facts.filter((fact) => fact.metricId === metricId);
  const definition = metricDefinition(metricId);
  const included = metricFacts.filter((fact) => fact.quality !== 'excluded' && fact.numerator !== null);
  if (included.length === 0) return null;
  const numerator = included.reduce((sum, fact) => sum + (fact.numerator ?? 0), 0);
  const denominatorFacts = included.filter((fact) => fact.denominator !== null);
  const denominatorComplete = denominatorFacts.length === included.length && included.length > 0;
  const denominator = denominatorComplete
    ? denominatorFacts.reduce((sum, fact) => sum + (fact.denominator ?? 0), 0)
    : null;

  return {
    claimKind: 'aggregate',
    metricId,
    numerator: Math.round(numerator * 10) / 10,
    denominator: denominator === null ? null : Math.round(denominator * 10) / 10,
    normalizedValue: denominator !== null && denominator > 0
      ? definition.normalizedUnit === 'percent'
        ? Math.round((numerator / denominator) * 1_000) / 10
        : definition.normalizedUnit === 'minutes_per_room'
          ? Math.round((numerator / denominator) * 10) / 10
          : null
      : null,
    normalizedUnit: definition.normalizedUnit,
    includedPropertyIds: included.map((fact) => fact.propertyId),
    denominatorPropertyIds: denominatorFacts.map((fact) => fact.propertyId),
  };
}

function coverageForMetric(
  selectedHotels: readonly ScopeHotelCandidate[],
  facts: readonly PropertyMetricEvidenceV1[],
  metricId: PortfolioMetricId,
): PortfolioMetricCoverageV1 {
  const byProperty = new Map(
    facts
      .filter((fact) => fact.metricId === metricId)
      .map((fact) => [fact.propertyId, fact]),
  );
  const excludedHotels: PortfolioMetricCoverageV1['excludedHotels'] = [];
  let reported = 0;
  for (const hotel of selectedHotels) {
    const fact = byProperty.get(hotel.propertyId);
    if (fact && fact.quality !== 'excluded' && fact.numerator !== null) {
      reported += 1;
      continue;
    }
    excludedHotels.push({
      propertyId: hotel.propertyId,
      propertyName: hotel.name,
      code: fact?.exclusionCode ?? 'source_unavailable',
      reason: fact?.exclusionReason ?? 'No metric fact was produced for this hotel.',
    });
  }
  return {
    metricId,
    reported,
    excluded: excludedHotels.length,
    excludedHotels,
  };
}

function conservativeCoverage(
  selectedHotels: readonly ScopeHotelCandidate[],
  metricCoverage: readonly PortfolioMetricCoverageV1[],
  authorizedCount: number,
): PortfolioEvidencePackageV1['coverage'] {
  const exclusionsByMetric = new Map(
    metricCoverage.map((coverage) => [
      coverage.metricId,
      new Map(coverage.excludedHotels.map((hotel) => [hotel.propertyId, hotel])),
    ]),
  );
  const excludedHotels: PortfolioEvidencePackageV1['coverage']['excludedHotels'] = [];
  for (const hotel of selectedHotels) {
    const missing = metricCoverage.flatMap((coverage) => {
      const excluded = exclusionsByMetric.get(coverage.metricId)?.get(hotel.propertyId);
      return excluded ? [{ metricId: coverage.metricId, ...excluded }] : [];
    });
    if (missing.length === 0) continue;
    excludedHotels.push({
      propertyId: hotel.propertyId,
      propertyName: hotel.name,
      code: missing[0].code,
      reason: (metricCoverage.length === 1
        ? missing[0].reason
        : missing.map((item) => `${item.metricId}: ${item.reason}`).join('; '))
        .slice(0, 1_000),
    });
  }
  return {
    authorized: authorizedCount,
    selected: selectedHotels.length,
    reported: selectedHotels.length - excludedHotels.length,
    excluded: excludedHotels.length,
    excludedHotels,
  };
}

/**
 * Executes a validated plan over one immutable, exact authorization receipt.
 * The model never receives raw hotel rows; it receives only this bounded
 * evidence package. Authorization is checked both immediately before the first
 * property read and immediately before evidence is released.
 */
export async function runPortfolioIntelligence(input: {
  receipt: PortfolioScopeReceiptView;
  catalog: PlannerScopeCatalog;
  plan: PortfolioQueryPlan;
  assertReceipt: (receiptId: string, accountId: string) => Promise<ScopeReceiptAssertion>;
  now?: Date;
  timeoutMs?: number;
  /** Browser/request cancellation propagated into every PostgREST read. */
  signal?: AbortSignal;
  /** Absolute route deadline. The engine also applies its tighter query cap. */
  deadlineAt?: number;
  /** Hermetic test seam. Production callers must use the default typed hotel
   * adapters; this does not accept arbitrary SQL or tenant ids. */
  readers?: Partial<PortfolioMetricReaders>;
}): Promise<PortfolioEvidencePackageV1> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const deadlineAt = Math.min(
    input.deadlineAt ?? Number.MAX_SAFE_INTEGER,
    Date.now() + Math.min(input.timeoutMs ?? PORTFOLIO_QUERY_TIMEOUT_MS, PORTFOLIO_QUERY_TIMEOUT_MS),
  );
  const abortContext = createPortfolioQueryAbortContext({
    deadlineAt,
    parentSignal: input.signal,
  });
  // The deterministic read deadline is a data-quality boundary, not a reason
  // to erase completed hotel evidence. Adapters translate it into explicit
  // timeout facts. Only a real caller disconnect cancels the whole response.
  const assertClientConnected = () => {
    if (input.signal?.aborted) throw new PortfolioQueryInterruptedError('cancelled');
  };
  const assertReceiptCurrent = async (): Promise<void> => {
    // Authorization is a per-reader boundary. A broad portfolio summary can
    // invoke more than one deterministic reader, and service-role scopedDb is
    // hotel-filtered but is not itself user authorization. Reassert immediately
    // before and after every mounted reader so a revocation after one result
    // prevents the next reader from ever being scheduled.
    assertClientConnected();
    const assertion = await input.assertReceipt(input.receipt.id, input.receipt.accountId);
    if (!assertion.ok) throw new PortfolioScopeChangedError(assertion.reason);
    assertClientConnected();
  };
  try {
    assertClientConnected();
  const authorizedIds = sortedUnique(input.receipt.authorizedPropertyIds);
  const selectedIds = sortedUnique(input.receipt.propertyIds);
  if (selectedIds.length > MAX_EXACT_PORTFOLIO_PROPERTIES) {
    throw new PortfolioQueryContractError(
      `The selected scope has ${selectedIds.length} hotels, above the ${MAX_EXACT_PORTFOLIO_PROPERTIES}-hotel exact-query budget.`,
    );
  }
  if (selectedIds.length === 0) throw new PortfolioQueryContractError('The exact selected scope is empty.');
  if (selectedIds.some((id) => !authorizedIds.includes(id))) {
    throw new PortfolioQueryContractError('The selected scope is not a subset of the authorized scope.');
  }
  if (!equalIds(expectedIds(input.plan, input.catalog, authorizedIds), selectedIds)) {
    throw new PortfolioQueryContractError('The query plan selector and exact scope receipt disagree.');
  }
  if (Date.parse(input.receipt.expiresAt) <= Date.now()) {
    throw new PortfolioScopeChangedError('expired');
  }

  const selectedHotels = hotelsForReceipt(input.receipt, input.catalog);
  const readers = { ...DEFAULT_READERS, ...input.readers };
  const facts: PropertyMetricEvidenceV1[] = [];
  if (input.plan.metricIds.includes('rooms_booked_otb')) {
    await assertReceiptCurrent();
    facts.push(...await readers.bookedRooms(selectedHotels, {
      now,
      deadlineAt,
      signal: abortContext.signal,
      includeComparison: input.plan.comparison === 'own_same_weekday_normal',
    }));
    await assertReceiptCurrent();
  }
  const operationalIds = input.plan.metricIds.filter((id) =>
    id === 'housekeeping_rooms_cleaned'
    || id === 'housekeeping_active_minutes'
    || id === 'work_orders_open');
  if (operationalIds.length > 0) {
    await assertReceiptCurrent();
    facts.push(...await readers.operational(selectedHotels, operationalIds, {
      now,
      deadlineAt,
      signal: abortContext.signal,
    }));
    await assertReceiptCurrent();
  }
  const unsupported = input.plan.metricIds.filter((id) =>
    id === 'live_in_house_rooms' || id === 'final_rooms_sold');
  if (unsupported.length > 0) {
    throw new PortfolioQueryContractError(
      `The requested metric adapter is not available: ${unsupported.join(', ')}. No substitute metric was used.`,
    );
  }

  const metrics = input.plan.metricIds.map(metricDefinition);
  const aggregates = input.plan.metricIds
    .map((metricId) => aggregateMetric(metricId, facts))
    .filter((aggregate): aggregate is NonNullable<typeof aggregate> => aggregate !== null);
  const metricCoverage = input.plan.metricIds.map(
    (metricId) => coverageForMetric(selectedHotels, facts, metricId),
  );
  const coverage = conservativeCoverage(selectedHotels, metricCoverage, authorizedIds.length);

    return {
    version: PORTFOLIO_EVIDENCE_VERSION,
    scopeReceiptId: input.receipt.id,
    scopeHash: input.receipt.scopeHash,
    organizationId: input.receipt.organizationId,
    organizationName: input.receipt.organizationName,
    resolvedAt: input.receipt.resolvedAt,
    authorizedPropertyIds: authorizedIds,
    selectedPropertyIds: selectedIds,
    plan: input.plan,
    metrics,
    facts,
    aggregates,
    metricCoverage,
    coverage,
    generatedAt: now.toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
    partial: coverage.excluded > 0,
    };
  } finally {
    abortContext.cleanup();
  }
}
