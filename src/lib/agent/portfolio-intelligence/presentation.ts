import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  comparisonUnavailabilitySummaries,
  type PortfolioEvidencePackageV1,
  type PropertyMetricEvidenceV1,
} from './evidence';
import type { PortfolioMetricDefinition } from './metrics';
import {
  PORTFOLIO_FINDING_MAX_PROMPT_ITEMS,
  PORTFOLIO_FINDING_MAX_PROMPT_CHARS,
  buildPortfolioFindingProjection,
  validatePortfolioFindingProjection,
  type PortfolioFindingConsumerPackageV1,
  type PortfolioFindingEnvelopeV1,
  type PortfolioFindingProducerMetadataV1,
  type PortfolioFindingProjectionStatus,
  type PortfolioFindingProjectionV1,
} from './pattern-contract';

export const PORTFOLIO_PRESENTATION_PLAN_VERSION = 'portfolio-presentation-plan.v1' as const;
export const PORTFOLIO_DETERMINISTIC_RENDERER_VERSION = 'portfolio-renderer.v1' as const;

const CLAIM_ID_RX = /^pc_[0-9a-f]{24}$/;
export const MAX_PORTFOLIO_PRESENTATION_CLAIMS = 64;

export type PortfolioPresentationClaimKind =
  | 'coverage'
  | 'aggregate'
  | 'comparison_summary'
  | 'fact'
  | 'finding';

export interface PortfolioPresentationClaim {
  id: string;
  kind: PortfolioPresentationClaimKind;
  metricId: string | null;
  propertyId: string | null;
  fact: PropertyMetricEvidenceV1 | null;
  finding: PortfolioFindingEnvelopeV1 | null;
}

export interface PortfolioPresentationClaimCatalog {
  claims: PortfolioPresentationClaim[];
  requiredClaimIds: string[];
  optionalClaimIds: string[];
}

const portfolioPresentationPlanSchema = z.object({
  version: z.literal(PORTFOLIO_PRESENTATION_PLAN_VERSION),
  lead: z.enum(['scope_first', 'exceptions_first', 'coverage_first']),
  orderedClaimIds: z.array(
    z.string().regex(CLAIM_ID_RX),
  ).max(MAX_PORTFOLIO_PRESENTATION_CLAIMS),
}).strict();

export type PortfolioPresentationPlan = z.infer<typeof portfolioPresentationPlanSchema>;

export type PortfolioPresentationPlanVerdict =
  | { ok: true; plan: PortfolioPresentationPlan }
  | {
      ok: false;
      reason:
        | 'invalid_json'
        | 'invalid_shape'
        | 'duplicate_claim'
        | 'unknown_claim'
        | 'missing_required_claim';
      detail: string;
    };

function claimId(scopeHash: string, kind: PortfolioPresentationClaimKind, key: string): string {
  return `pc_${createHash('sha256')
    .update(`${scopeHash}\u0000${kind}\u0000${key}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function factKey(fact: PropertyMetricEvidenceV1): string {
  return JSON.stringify({
    propertyId: fact.propertyId,
    metricId: fact.metricId,
    businessDate: fact.businessDate,
    numerator: fact.numerator,
    denominator: fact.denominator,
    normalizedValue: fact.normalizedValue,
    quality: fact.quality,
    freshness: fact.freshness,
    classification: fact.baseline?.classification ?? null,
    sourceRecordId: fact.source?.sourceRecordId ?? null,
    sourceObservedAt: fact.source?.sourceObservedAt ?? null,
  });
}

function factPriority(fact: PropertyMetricEvidenceV1): number {
  const classification = fact.baseline?.classification;
  if (classification === 'above' || classification === 'below') return 1_000_000;
  if (fact.quality === 'excluded') return 900_000;
  if (fact.quality === 'partial') return 800_000;
  if (fact.freshness === 'stale') return 700_000;
  if (fact.freshness === 'unknown') return 600_000;
  if (fact.metricId === 'work_orders_open') return 500_000 + Math.max(0, fact.numerator ?? 0);
  return Math.max(0, fact.normalizedValue ?? fact.numerator ?? 0);
}

function factClaims(evidence: PortfolioEvidencePackageV1): PortfolioPresentationClaim[] {
  const factLimit = evidence.plan.intent === 'property_drilldown'
    ? Math.max(1, evidence.plan.metricIds.length)
    : Math.min(25, Math.max(1, evidence.plan.detailLimit));
  return [...evidence.facts]
    .sort((left, right) => {
      const priority = factPriority(right) - factPriority(left);
      if (priority !== 0) return priority;
      return left.propertyName.localeCompare(right.propertyName)
        || left.metricId.localeCompare(right.metricId)
        || left.propertyId.localeCompare(right.propertyId);
    })
    // The model never receives an unbounded hotel dump. Aggregates,
    // comparison summaries, coverage and all exclusions remain deterministic;
    // this list only lets it choose the ordering of bounded detail rows.
    .slice(0, factLimit)
    .map((fact) => ({
      id: claimId(evidence.scopeHash, 'fact', factKey(fact)),
      kind: 'fact' as const,
      metricId: fact.metricId,
      propertyId: fact.propertyId,
      fact,
      finding: null,
    }));
}

function findingClaims(
  evidence: PortfolioEvidencePackageV1,
  projectionValue?: PortfolioFindingProjectionV1 | null,
): PortfolioPresentationClaim[] {
  if (!projectionValue) return [];
  const projection = validatePortfolioFindingProjection(projectionValue);
  if (projection.organizationId !== evidence.organizationId
      || projection.scopeReceiptId !== evidence.scopeReceiptId
      || projection.scopeHash !== evidence.scopeHash
      || projection.coverage.authorizedPropertyCount !== evidence.authorizedPropertyIds.length
      || projection.coverage.selectedPropertyCount !== evidence.selectedPropertyIds.length) {
    throw new TypeError('accepted finding projection does not match the exact evidence scope');
  }
  const selected = new Set(evidence.selectedPropertyIds);
  for (const finding of projection.findings) {
    if (finding.organizationId !== evidence.organizationId
        || finding.scope.evaluatedPropertyIds.some((id) => !selected.has(id))
        || finding.scope.affectedPropertyIds.some((id) => !selected.has(id))) {
      throw new TypeError('accepted finding projection contains out-of-scope evidence');
    }
  }
  const claims = projection.findings
    .map((finding, index): PortfolioPresentationClaim => ({
      id: projection.projectedClaimIds[index],
      kind: 'finding',
      metricId: null,
      propertyId: null,
      fact: null,
      finding,
    }));
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) {
    throw new TypeError('accepted finding presentation claim ids collided');
  }
  return claims;
}

export function maxPortfolioFindingProjectionItems(
  evidence: PortfolioEvidencePackageV1,
): number {
  const baseCount = 1
    + evidence.aggregates.length
    + (evidence.plan.comparison === 'none' ? 0 : evidence.plan.metricIds.length)
    + factClaims(evidence).length;
  if (baseCount > MAX_PORTFOLIO_PRESENTATION_CLAIMS) {
    throw new TypeError('non-finding presentation claims exceed the bounded catalog');
  }
  return Math.min(
    PORTFOLIO_FINDING_MAX_PROMPT_ITEMS,
    MAX_PORTFOLIO_PRESENTATION_CLAIMS - baseCount,
  );
}

/** The only supported package-to-presentation transition. The returned
 * projection is reused unchanged by prompt, catalog, validator, renderer,
 * numeric allowlist and durable receipt construction. */
export function buildPortfolioFindingPresentationProjection(input: {
  evidence: PortfolioEvidencePackageV1;
  packageValue: PortfolioFindingConsumerPackageV1;
  accountId: string;
  authorizationHash: string;
  status?: PortfolioFindingProjectionStatus;
  producer: PortfolioFindingProducerMetadataV1;
}): PortfolioFindingProjectionV1 {
  let itemBudget = maxPortfolioFindingProjectionItems(input.evidence);
  while (itemBudget >= 0) {
    const projection = buildPortfolioFindingProjection({
      packageValue: input.packageValue,
      accountId: input.accountId,
      authorizationHash: input.authorizationHash,
      scopeHash: input.evidence.scopeHash,
      maxProjectedItems: itemBudget,
      status: input.status,
      producer: input.producer,
    });
    const contract = portfolioPresentationPlanContractText(input.evidence, projection);
    if (Buffer.byteLength(contract, 'utf8') <= PORTFOLIO_FINDING_MAX_PROMPT_CHARS) {
      return projection;
    }
    itemBudget -= 1;
  }
  throw new TypeError('non-finding presentation contract exceeds its 12k byte budget');
}

export function buildPortfolioPresentationClaimCatalog(
  evidence: PortfolioEvidencePackageV1,
  findingsProjection?: PortfolioFindingProjectionV1 | null,
): PortfolioPresentationClaimCatalog {
  const coverage: PortfolioPresentationClaim = {
    id: claimId(evidence.scopeHash, 'coverage', JSON.stringify(evidence.coverage)),
    kind: 'coverage',
    metricId: null,
    propertyId: null,
    fact: null,
    finding: null,
  };
  const aggregates: PortfolioPresentationClaim[] = evidence.aggregates.map((aggregate) => ({
    id: claimId(
      evidence.scopeHash,
      'aggregate',
      JSON.stringify({
        metricId: aggregate.metricId,
        numerator: aggregate.numerator,
        denominator: aggregate.denominator,
        normalizedValue: aggregate.normalizedValue,
        includedPropertyIds: aggregate.includedPropertyIds,
      }),
    ),
    kind: 'aggregate',
    metricId: aggregate.metricId,
    propertyId: null,
    fact: null,
    finding: null,
  }));
  const comparisons: PortfolioPresentationClaim[] = evidence.plan.comparison === 'none'
    ? []
    : evidence.plan.metricIds.map((metricId) => {
        const classifications = evidence.facts
          .filter((fact) => fact.metricId === metricId)
          .map((fact) => ({
            propertyId: fact.propertyId,
            classification: fact.baseline?.classification ?? 'unavailable',
          }))
          .sort((left, right) => left.propertyId.localeCompare(right.propertyId));
        return {
          id: claimId(
            evidence.scopeHash,
            'comparison_summary',
            JSON.stringify({ metricId, classifications }),
          ),
          kind: 'comparison_summary' as const,
          metricId,
          propertyId: null,
          fact: null,
          finding: null,
        };
      });
  const details = factClaims(evidence);
  const findings = findingClaims(evidence, findingsProjection);
  const required = [coverage, ...aggregates, ...comparisons];
  if (evidence.plan.intent === 'property_drilldown') {
    required.push(...details);
  }
  const requiredIds = new Set(required.map((claim) => claim.id));
  const allClaims = [coverage, ...aggregates, ...comparisons, ...details, ...findings];
  if (new Set(allClaims.map((claim) => claim.id)).size !== allClaims.length) {
    throw new TypeError('portfolio presentation claim ids collided');
  }
  if (allClaims.length > MAX_PORTFOLIO_PRESENTATION_CLAIMS) {
    throw new TypeError('portfolio presentation catalog exceeds its hard claim budget');
  }
  return {
    claims: allClaims,
    requiredClaimIds: [...requiredIds],
    optionalClaimIds: [...details, ...findings]
      .map((claim) => claim.id)
      .filter((id) => !requiredIds.has(id)),
  };
}

export function displayedPortfolioFindingClaimIds(
  catalog: PortfolioPresentationClaimCatalog,
  plan: PortfolioPresentationPlan,
): string[] {
  const findingIds = new Set(catalog.claims
    .filter((claim) => claim.kind === 'finding')
    .map((claim) => claim.id));
  return catalog.claims
    .filter((claim) => findingIds.has(claim.id) && plan.orderedClaimIds.includes(claim.id))
    .map((claim) => claim.id)
    .sort();
}

function safeLabel(value: string, max = 140): string {
  return value
    .replace(/[<>\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeFindingText(value: string, max = 500): string {
  return safeLabel(value, max).replace(/([\\`*_{}\[\]()#+>|])/g, '\\$1');
}

/**
 * The provider may choose presentation order, never factual content. Claim IDs
 * are scoped content digests; no number, name, date, source or classification
 * supplied by the provider is accepted by the renderer.
 */
function portfolioPresentationPlanContractText(
  evidence: PortfolioEvidencePackageV1,
  findingsProjection?: PortfolioFindingProjectionV1 | null,
): string {
  const catalog = buildPortfolioPresentationClaimCatalog(evidence, findingsProjection);
  const claimRows = catalog.claims.map((claim) => {
    if (claim.kind === 'fact' && claim.fact) {
      return `${claim.id} kind=fact hotel=${safeLabel(claim.fact.propertyName)} metric=${safeLabel(claim.fact.metricId)} quality=${claim.fact.quality} comparison=${claim.fact.baseline?.classification ?? 'unavailable'}`;
    }
    if (claim.kind === 'finding' && claim.finding) {
      const finding = claim.finding;
      return `${claim.id} kind=finding claim_kind=${finding.claim.kind} scope=${finding.scope.kind} `
        + `evaluated=${finding.scope.evaluatedPropertyIds.length} `
        + `affected=${finding.scope.affectedPropertyIds.length} `
        + `as_of=${finding.evidence.asOf}`;
    }
    return `${claim.id} kind=${claim.kind} metric=${claim.metricId ?? 'all'}`;
  });
  const hasFindingClaims = catalog.claims.some((claim) => claim.kind === 'finding');
  const contract = [
    '─── Machine-validated presentation contract ───',
    'Return exactly one JSON object and no Markdown or prose.',
    `Schema: {"version":"${PORTFOLIO_PRESENTATION_PLAN_VERSION}","lead":"scope_first|exceptions_first|coverage_first","orderedClaimIds":["pc_..."]}`,
    'The array may contain only IDs listed below, with no duplicates. It must contain every REQUIRED ID. Optional IDs only choose which deterministic detail rows appear and their order.',
    'Do not emit names, numbers, dates, sources, metric labels, classifications, explanations, or any other free text. The server renders every factual token from evidence after validation.',
    ...(hasFindingClaims ? [
      'Rows with kind=finding are already accepted by the scoped Finding consumer. Their text exists only in the matching bounded structured-findings block. Select/order only the pc_ claim IDs; never repeat, edit, or author finding text.',
    ] : []),
    `REQUIRED_CLAIM_IDS: ${catalog.requiredClaimIds.join(',')}`,
    `OPTIONAL_CLAIM_IDS: ${catalog.optionalClaimIds.join(',') || 'none'}`,
    ...claimRows,
  ].join('\n');
  return contract;
}

export function formatPortfolioPresentationPlanContract(
  evidence: PortfolioEvidencePackageV1,
  findingsProjection?: PortfolioFindingProjectionV1 | null,
): string {
  const contract = portfolioPresentationPlanContractText(evidence, findingsProjection);
  if (Buffer.byteLength(contract, 'utf8') > PORTFOLIO_FINDING_MAX_PROMPT_CHARS) {
    throw new TypeError('portfolio presentation contract exceeds its 12k byte budget');
  }
  return contract;
}

function extractJsonObject(raw: string): unknown {
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) throw new Error('not a bare JSON object');
  return JSON.parse(text) as unknown;
}

export function validatePortfolioPresentationPlan(input: {
  candidate: string;
  evidence: PortfolioEvidencePackageV1;
  findingsProjection?: PortfolioFindingProjectionV1 | null;
}): PortfolioPresentationPlanVerdict {
  let decoded: unknown;
  try {
    decoded = extractJsonObject(input.candidate);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_json',
      detail: error instanceof Error ? error.message : 'invalid JSON',
    };
  }
  const parsed = portfolioPresentationPlanSchema.safeParse(decoded);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid_shape', detail: parsed.error.message };
  }
  const ids = parsed.data.orderedClaimIds;
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'duplicate_claim', detail: 'claim IDs must be unique' };
  }
  const catalog = buildPortfolioPresentationClaimCatalog(
    input.evidence,
    input.findingsProjection,
  );
  const allowed = new Set(catalog.claims.map((claim) => claim.id));
  const unknown = ids.find((id) => !allowed.has(id));
  if (unknown) {
    return { ok: false, reason: 'unknown_claim', detail: `unknown claim ${unknown}` };
  }
  const selected = new Set(ids);
  const missing = catalog.requiredClaimIds.find((id) => !selected.has(id));
  if (missing) {
    return {
      ok: false,
      reason: 'missing_required_claim',
      detail: `missing required claim ${missing}`,
    };
  }
  return { ok: true, plan: parsed.data };
}

const METRIC_LABELS: Record<string, string> = {
  rooms_booked_otb: 'Rooms booked on the books',
  live_in_house_rooms: 'Rooms currently in house',
  final_rooms_sold: 'Final rooms sold',
  housekeeping_rooms_cleaned: 'Housekeeping rooms cleaned',
  housekeeping_active_minutes: 'Housekeeping active minutes',
  work_orders_open: 'Open work orders',
};

function metricLabel(metricId: string): string {
  return METRIC_LABELS[metricId] ?? safeLabel(metricId.replaceAll('_', ' '));
}

function renderedNumber(value: number | null): string {
  if (value === null) return 'unavailable';
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function renderedSource(fact: PropertyMetricEvidenceV1): string {
  if (!fact.source) return 'source unavailable';
  const source = fact.source;
  const timing = source.sourceObservedAt
    ? `observed ${safeLabel(source.sourceObservedAt)}`
    : `captured ${safeLabel(source.sourceCapturedAt)}`;
  const parser = source.parserName || source.parserVersion
    ? `; parser ${safeLabel(source.parserName ?? 'unknown')}@${safeLabel(source.parserVersion ?? 'unknown')}`
    : '';
  const query = source.queryVersion ? `; query ${safeLabel(source.queryVersion)}` : '';
  return `${safeLabel(source.sourceTable)}/${safeLabel(source.sourceRecordId)}; ${timing}${parser}${query}`;
}

function renderFact(
  fact: PropertyMetricEvidenceV1,
  metric: PortfolioMetricDefinition | undefined,
  includeComparison = true,
): string {
  const normalized = fact.normalizedValue === null
    ? ''
    : `; normalized ${renderedNumber(fact.normalizedValue)} ${safeLabel(metric?.normalizedUnit ?? 'normalized units')}`;
  const comparison = includeComparison && fact.baseline
    ? `; recent same-weekday on-the-books: ${fact.baseline.classification} (median ${renderedNumber(fact.baseline.median)}, band ${renderedNumber(fact.baseline.lower)}–${renderedNumber(fact.baseline.upper)}, n=${fact.baseline.n})`
    : '';
  const definition = metric
    ? `; definition: ${safeLabel(metric.definition)}; window: ${safeLabel(metric.window)}`
    : '';
  const exclusion = fact.exclusionReason ? `; unavailable because ${safeLabel(fact.exclusionReason)}` : '';
  return `${safeLabel(fact.propertyName)} — ${metricLabel(fact.metricId)}: ${renderedNumber(fact.numerator)} ${safeLabel(fact.unit)}${normalized}${definition}; business date ${safeLabel(fact.businessDate)} (${safeLabel(fact.timezone)}); ${fact.freshness} freshness; ${renderedSource(fact)}${comparison}${exclusion}.`;
}

function comparisonLines(evidence: PortfolioEvidencePackageV1): string[] {
  if (evidence.plan.comparison === 'none') return [];
  const lines: string[] = ['**Recent same-weekday comparison**'];
  const metrics = new Map<string, PortfolioMetricDefinition>(
    evidence.metrics.map((metric) => [metric.id, metric]),
  );
  for (const metricId of evidence.plan.metricIds) {
    const facts = evidence.facts.filter((fact) => fact.metricId === metricId);
    const above = facts.filter((fact) => fact.baseline?.classification === 'above');
    const below = facts.filter((fact) => fact.baseline?.classification === 'below');
    const typical = facts.filter((fact) => fact.baseline?.classification === 'typical').length;
    const unavailable = evidence.selectedPropertyIds.length - above.length - below.length - typical;
    lines.push(`- ${metricLabel(metricId)}: ${above.length} above, ${below.length} below, ${typical} typical, ${unavailable} unavailable.`);
    for (const group of comparisonUnavailabilitySummaries(evidence)
      .filter((summary) => summary.metricId === metricId)) {
      const shown = group.hotels.slice(0, 25);
      const names = shown.map((hotel) => safeLabel(hotel.propertyName)).join(', ');
      const omitted = group.hotels.length - shown.length;
      lines.push(
        `  - Unavailable — ${safeLabel(group.code.replaceAll('_', ' '))}: ${group.hotels.length} hotels${names ? ` (${names}${omitted > 0 ? '; additional hotels omitted from this bounded list' : ''})` : ''}; ${safeLabel(group.reason)}.`,
      );
    }
    const abnormal = [...above, ...below].slice(0, Math.min(25, evidence.plan.detailLimit));
    for (const fact of abnormal) lines.push(`  - ${renderFact(fact, metrics.get(fact.metricId))}`);
    const omitted = above.length + below.length - abnormal.length;
    if (omitted > 0) lines.push(`  - ${omitted} additional above/below-normal hotels are retained in the audit evidence but omitted from this bounded answer.`);
  }
  return lines;
}

function aggregateLines(evidence: PortfolioEvidencePackageV1): string[] {
  return evidence.aggregates.flatMap((aggregate) => {
    const normalized = aggregate.normalizedValue === null
      ? ''
      : `; normalized ${renderedNumber(aggregate.normalizedValue)} ${aggregate.normalizedUnit ?? ''}`;
    const metric = evidence.metrics.find((item) => item.id === aggregate.metricId);
    const facts = evidence.facts.filter((fact) => fact.metricId === aggregate.metricId);
    const freshness = new Map<string, number>();
    const dateZones = new Set<string>();
    const sources = new Set<string>();
    for (const fact of facts) {
      freshness.set(fact.freshness, (freshness.get(fact.freshness) ?? 0) + 1);
      dateZones.add(`${safeLabel(fact.businessDate)} (${safeLabel(fact.timezone)})`);
      if (fact.source) {
        sources.add([
          safeLabel(fact.source.sourceTable),
          fact.source.parserName ? `${safeLabel(fact.source.parserName)}@${safeLabel(fact.source.parserVersion ?? 'unknown')}` : null,
          fact.source.queryVersion ? safeLabel(fact.source.queryVersion) : null,
        ].filter(Boolean).join('/'));
      }
    }
    const dateZoneList = [...dateZones].sort();
    const sourceList = [...sources].sort();
    return [
      `- ${metricLabel(aggregate.metricId)}: ${renderedNumber(aggregate.numerator)} across ${aggregate.includedPropertyIds.length} reporting hotels${aggregate.denominator === null ? '' : `; denominator ${renderedNumber(aggregate.denominator)}`}${normalized}.`,
      `  Definition: ${safeLabel(metric?.definition ?? 'definition unavailable')}; window: ${safeLabel(metric?.window ?? 'window unavailable')}.`,
      `  Provenance: business date/timezone ${dateZoneList.slice(0, 8).join(', ') || 'unavailable'}${dateZoneList.length > 8 ? ` (+${dateZoneList.length - 8} more)` : ''}; freshness ${[...freshness.entries()].sort().map(([key, count]) => `${key}=${count}`).join(', ') || 'unavailable'}; source versions ${sourceList.slice(0, 8).join(', ') || 'unavailable'}${sourceList.length > 8 ? ` (+${sourceList.length - 8} more)` : ''}.`,
    ];
  });
}

function orderedDetailFacts(input: {
  evidence: PortfolioEvidencePackageV1;
  plan: PortfolioPresentationPlan;
  findingsProjection?: PortfolioFindingProjectionV1 | null;
}): PropertyMetricEvidenceV1[] {
  const catalog = buildPortfolioPresentationClaimCatalog(
    input.evidence,
    input.findingsProjection,
  );
  const byId = new Map(catalog.claims.map((claim) => [claim.id, claim]));
  const selected = input.plan.orderedClaimIds
    .map((id) => byId.get(id))
    .filter((claim): claim is PortfolioPresentationClaim => claim?.kind === 'fact' && Boolean(claim.fact))
    .map((claim) => claim.fact as PropertyMetricEvidenceV1);
  if (selected.length > 0) return selected;
  return catalog.claims
    .filter((claim) => claim.kind === 'fact' && Boolean(claim.fact))
    .slice(0, Math.min(5, input.evidence.plan.detailLimit))
    .map((claim) => claim.fact as PropertyMetricEvidenceV1);
}

function orderedFindings(input: {
  evidence: PortfolioEvidencePackageV1;
  plan: PortfolioPresentationPlan;
  findingsProjection?: PortfolioFindingProjectionV1 | null;
}): PortfolioFindingEnvelopeV1[] {
  if (!input.findingsProjection) return [];
  const catalog = buildPortfolioPresentationClaimCatalog(
    input.evidence,
    input.findingsProjection,
  );
  const byId = new Map(catalog.claims.map((claim) => [claim.id, claim]));
  return input.plan.orderedClaimIds
    .map((id) => byId.get(id))
    .filter((claim): claim is PortfolioPresentationClaim => (
      claim?.kind === 'finding' && claim.finding !== null
    ))
    .map((claim) => claim.finding as PortfolioFindingEnvelopeV1);
}

function findingProvenance(finding: PortfolioFindingEnvelopeV1): string {
  const sources = finding.evidence.sourceVersions
    .map((source) => `${safeLabel(source.component)}@${safeLabel(source.version)}`)
    .join(', ');
  return [
    `accepted ${safeLabel(finding.scope.kind.replaceAll('_', ' '))} finding`,
    `producer ${safeLabel(finding.producer.engineId)}@${safeLabel(finding.producer.engineVersion)}`,
    `produced ${safeLabel(finding.producer.producedAt)}`,
    `evidence ${safeLabel(finding.evidence.queryId)}@${safeLabel(finding.evidence.queryVersion)}`,
    `as of ${safeLabel(finding.evidence.asOf)}`,
    `window ${safeLabel(finding.evidence.analysisWindowKey)}`,
    `coverage ${finding.evidence.coverage.evaluated} evaluated, ${finding.evidence.coverage.affected} affected of ${finding.evidence.coverage.eligible} eligible`,
    `sources ${sources || 'unavailable'}`,
    `privacy ${safeLabel(finding.privacy.mode.replaceAll('_', ' '))}`,
    finding.lifecycle.validThrough
      ? `valid through ${safeLabel(finding.lifecycle.validThrough)}`
      : null,
  ].filter((value): value is string => value !== null).join('; ');
}

function renderFinding(finding: PortfolioFindingEnvelopeV1): string[] {
  const sentence = (value: string) => {
    const text = safeFindingText(value);
    return /[.!?]$/.test(text) ? text : `${text}.`;
  };
  const statement = sentence(finding.claim.statement);
  switch (finding.claim.kind) {
    case 'fact':
      return [
        `- **Accepted finding — ${safeLabel(finding.claim.factType)} fact**: ${statement}`,
        `  Provenance: ${findingProvenance(finding)}.`,
      ];
    case 'pattern':
      return [
        `- **Accepted finding — supported pattern** (${safeLabel(finding.claim.assertion.replaceAll('_', ' '))}; ${safeLabel(finding.claim.direction)}): ${statement}`,
        `  Provenance: ${findingProvenance(finding)}.`,
      ];
    case 'hypothesis':
      return [
        `- **UNVERIFIED HYPOTHESIS**: ${statement}`,
        `  Basis: ${sentence(finding.claim.basis)} Verification needed: ${sentence(finding.claim.verificationNeeded)}`,
        `  Provenance: ${findingProvenance(finding)}.`,
      ];
    default: {
      const neverClaim: never = finding.claim;
      throw new TypeError(`unsupported finding claim kind: ${String(neverClaim)}`);
    }
  }
}

/** Exact non-provider number receipt for Finding prose that the validated plan
 * selected for deterministic display. Rejected, omitted and merely projected
 * claims contribute no numeric authorization. */
export function portfolioFindingNumberReceiptPayloads(input: {
  evidence: PortfolioEvidencePackageV1;
  plan: PortfolioPresentationPlan;
  findingsProjection?: PortfolioFindingProjectionV1 | null;
}): string[] {
  return orderedFindings(input).map((finding) => renderFinding(finding).join('\n'));
}

/**
 * Deterministic rendering boundary. The model contributes only enum/claim-ID
 * ordering. Every visible fact is copied from the evidence package here.
 */
export function renderPortfolioAnswer(input: {
  evidence: PortfolioEvidencePackageV1;
  plan: PortfolioPresentationPlan;
  selectorLabel: string;
  findingsProjection?: PortfolioFindingProjectionV1 | null;
}): string {
  const { evidence } = input;
  const organization = safeLabel(evidence.organizationName ?? 'Management company');
  const scopeLine = `**Active scope** — ${organization}; ${safeLabel(input.selectorLabel)}; ${evidence.coverage.selected} selected of ${evidence.coverage.authorized} currently authorized hotels.`;
  const coverageLine = `**Coverage** — ${evidence.coverage.reported} of ${evidence.coverage.selected} hotels reported; ${evidence.coverage.excluded} omitted.`;
  const summary = ['**Deterministic results**', ...aggregateLines(evidence)];
  const comparisons = comparisonLines(evidence);
  const metrics = new Map<string, PortfolioMetricDefinition>(
    evidence.metrics.map((metric) => [metric.id, metric]),
  );
  const detailFacts = orderedDetailFacts(input);
  const details = detailFacts.length > 0
    ? ['**Hotel-level evidence**', ...detailFacts.map((fact) => `- ${renderFact(fact, metrics.get(fact.metricId), evidence.plan.comparison === 'none')}`)]
    : [];
  const selectedFindings = orderedFindings(input);
  const findingLines = selectedFindings.length > 0
    ? [
        '**Accepted structured findings**',
        'Canonical metric evidence above remains authoritative; hypotheses below are not facts.',
        ...selectedFindings.flatMap(renderFinding),
      ]
    : [];
  const exclusions = evidence.coverage.excludedHotels.length > 0
    ? [
        '**Omissions**',
        ...evidence.coverage.excludedHotels.slice(0, 25).map((item) =>
          `- ${safeLabel(item.propertyName)} — ${safeLabel(item.code)}: ${safeLabel(item.reason)}.`),
        ...(evidence.coverage.excludedHotels.length > 25
          ? [`- ${evidence.coverage.excludedHotels.length - 25} additional omissions are retained in the audit receipt.`]
          : []),
      ]
    : [];
  const orderedLead = input.plan.lead === 'coverage_first'
    ? [coverageLine, scopeLine]
    : input.plan.lead === 'exceptions_first' && exclusions.length > 0
      ? [scopeLine, coverageLine, ...exclusions]
      : [scopeLine, coverageLine];
  const remainingExclusions = input.plan.lead === 'exceptions_first' ? [] : exclusions;
  return [
    ...orderedLead,
    '',
    ...summary,
    ...(comparisons.length > 0 ? ['', ...comparisons] : []),
    ...(findingLines.length > 0 ? ['', ...findingLines] : []),
    ...(details.length > 0 ? ['', ...details] : []),
    ...(remainingExclusions.length > 0 ? ['', ...remainingExclusions] : []),
    '',
    `Metric registry and query versions: ${evidence.metrics.map((metric) => `${safeLabel(metric.id)}@${safeLabel(metric.version)}`).join(', ')}; plan ${safeLabel(evidence.plan.version)}; evidence ${safeLabel(evidence.version)}.`,
  ].join('\n');
}
