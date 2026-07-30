import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { AuthorizationScopeReceipt } from '@/lib/authorization';

import type {
  CompanyKnowledgeOverlayV1,
  KnowledgeClaimV1,
  KnowledgeProvenanceV1,
  PropertyKnowledgeResolutionState,
  PropertyKnowledgeResolutionV1,
} from './knowledge';
import type {
  PlannerScopeCatalog,
  PortfolioKnowledgeQuery,
} from './schemas';

export const PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION =
  'portfolio-knowledge-presentation.v1' as const;
const CLAIM_ID_RX = /^pk_[0-9a-f]{24}$/;
const MAX_VISIBLE_KNOWLEDGE_CLAIMS = 40;
const HASH_RX = /^[0-9a-f]{64}$/;

export type PortfolioKnowledgeClaimKind =
  | 'company_default'
  | 'property_override'
  | 'property_only'
  | 'consistent_with_company'
  | 'unresolved_conflict'
  | 'orphaned_override';

/** Service-only claim. Free-form content never crosses the selection boundary;
 * the only selectable value is its scope-bound opaque id. */
export interface PortfolioKnowledgePresentationClaim {
  id: string;
  kind: PortfolioKnowledgeClaimKind;
  knowledgeKey: string;
  propertyId: string | null;
  companyClaim: KnowledgeClaimV1 | null;
  propertyClaims: KnowledgeClaimV1[];
  effectiveClaim: KnowledgeClaimV1 | null;
  resolutionState: PropertyKnowledgeResolutionState | null;
}

export interface PortfolioKnowledgeClaimCatalog {
  version: typeof PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION;
  scopeHash: string;
  receipt: AuthorizationScopeReceipt;
  overlay: CompanyKnowledgeOverlayV1;
  hotelNames: ReadonlyMap<string, string>;
  claims: PortfolioKnowledgePresentationClaim[];
}

const selectionSchema = z.object({
  version: z.literal(PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION),
  orderedClaimIds: z.array(z.string().regex(CLAIM_ID_RX))
    .max(MAX_VISIBLE_KNOWLEDGE_CLAIMS),
}).strict();

export type PortfolioKnowledgePresentationSelection = z.infer<typeof selectionSchema>;

export type PortfolioKnowledgeSelectionVerdict =
  | {
      ok: true;
      selection: PortfolioKnowledgePresentationSelection;
      claims: PortfolioKnowledgePresentationClaim[];
    }
  | {
      ok: false;
      reason: 'invalid_shape' | 'duplicate_claim' | 'unknown_claim';
    };

export class PortfolioKnowledgePresentationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortfolioKnowledgePresentationScopeError';
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/** JSONB does not preserve object-key insertion order. Claim ids must survive
 * a durable JSONB round trip, so hash a recursive canonical form rather than
 * JavaScript's insertion-order JSON.stringify output. Array order remains
 * semantic; object keys are sorted at every depth. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PortfolioKnowledgePresentationScopeError(
        'knowledge claim identity contains a non-finite number',
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        if (item === undefined) {
          throw new PortfolioKnowledgePresentationScopeError(
            'knowledge claim identity contains an undefined value',
          );
        }
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',')}}`;
  }
  throw new PortfolioKnowledgePresentationScopeError(
    'knowledge claim identity is not JSON-compatible',
  );
}

function claimId(scopeHash: string, kind: PortfolioKnowledgeClaimKind, value: unknown): string {
  return `pk_${createHash('sha256')
    .update(`${PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION}\u0000${scopeHash}\u0000${kind}\u0000${canonicalJson(value)}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function knowledgeClaimIdentity(claim: KnowledgeClaimV1 | null): unknown {
  if (!claim) return null;
  return {
    key: claim.knowledgeKey,
    topic: claim.topic,
    content: claim.content,
    category: claim.category,
    policyKey: claim.policyKey,
    policyValue: claim.policyValue,
    provenance: claim.provenance,
  };
}

function resolutionKind(
  state: PropertyKnowledgeResolutionState,
): Exclude<PortfolioKnowledgeClaimKind, 'company_default'> {
  return state;
}

/** Build a claim catalog only when overlay tenant and exact selected-property
 * set equal the freshly issued receipt. A mismatch is corruption, never a row
 * to filter quietly. */
export function buildPortfolioKnowledgeClaimCatalog(input: {
  receipt: AuthorizationScopeReceipt;
  catalog: PlannerScopeCatalog;
  overlay: CompanyKnowledgeOverlayV1;
}): PortfolioKnowledgeClaimCatalog {
  const { receipt, catalog, overlay } = input;
  if (!HASH_RX.test(receipt.scopeHash)
      || overlay.organizationId !== receipt.organizationId
      || catalog.organizationId !== receipt.organizationId
      || !sameIds(overlay.selectedPropertyIds, receipt.propertyIds)) {
    throw new PortfolioKnowledgePresentationScopeError(
      'knowledge overlay does not match the exact authorization receipt',
    );
  }

  const hotelNames = new Map(
    catalog.hotels
      .filter((hotel) => receipt.propertyIds.includes(hotel.propertyId))
      .map((hotel) => [hotel.propertyId, hotel.name]),
  );
  if (hotelNames.size !== receipt.propertyIds.length) {
    throw new PortfolioKnowledgePresentationScopeError(
      'knowledge catalog is missing a selected authorized hotel',
    );
  }
  const claims: PortfolioKnowledgePresentationClaim[] = [];
  for (const companyClaim of overlay.companyDefaults) {
    claims.push({
      id: claimId(receipt.scopeHash, 'company_default', knowledgeClaimIdentity(companyClaim)),
      kind: 'company_default',
      knowledgeKey: companyClaim.knowledgeKey,
      propertyId: null,
      companyClaim,
      propertyClaims: [],
      effectiveClaim: companyClaim,
      resolutionState: null,
    });
  }
  for (const resolution of overlay.propertyResolutions) {
    const kind = resolutionKind(resolution.state);
    claims.push({
      id: claimId(receipt.scopeHash, kind, {
        propertyId: resolution.propertyId,
        knowledgeKey: resolution.knowledgeKey,
        state: resolution.state,
        companyClaim: knowledgeClaimIdentity(resolution.companyClaim),
        propertyClaims: resolution.propertyClaims.map(knowledgeClaimIdentity),
        effectiveClaim: knowledgeClaimIdentity(resolution.effectiveClaim),
        conflict: resolution.conflict,
      }),
      kind,
      knowledgeKey: resolution.knowledgeKey,
      propertyId: resolution.propertyId,
      companyClaim: resolution.companyClaim,
      propertyClaims: resolution.propertyClaims,
      effectiveClaim: resolution.effectiveClaim,
      resolutionState: resolution.state,
    });
  }
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) {
    throw new PortfolioKnowledgePresentationScopeError('knowledge claim ids collided');
  }

  return {
    version: PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
    scopeHash: receipt.scopeHash,
    receipt,
    overlay,
    hotelNames,
    claims: claims.sort((left, right) => (
      left.knowledgeKey.localeCompare(right.knowledgeKey)
        || (left.propertyId ?? '').localeCompare(right.propertyId ?? '')
        || left.id.localeCompare(right.id)
    )),
  };
}

function normalizedSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function claimsForSearch(claim: PortfolioKnowledgePresentationClaim): KnowledgeClaimV1[] {
  const values = [claim.companyClaim, claim.effectiveClaim, ...claim.propertyClaims]
    .filter((value): value is KnowledgeClaimV1 => value !== null);
  return [...new Map(values.map((value) => [value.provenance.recordId, value])).values()];
}

function queryMatches(
  claim: PortfolioKnowledgePresentationClaim,
  query: PortfolioKnowledgeQuery,
  ignoreTerms = false,
): boolean {
  const values = claimsForSearch(claim);
  const categories = new Set(values.map((value) => value.category));
  if (query.categories.length > 0
      && !query.categories.some((category) => categories.has(category))) return false;
  if (ignoreTerms || query.terms.length === 0) return true;
  const searchable = normalizedSearchText(values.map((value) => [
    value.knowledgeKey,
    value.topic,
    value.policyKey ?? '',
    value.category,
  ].join(' ')).join(' '));
  return query.terms.some((term) => searchable.includes(normalizedSearchText(term)));
}

function claimPriority(claim: PortfolioKnowledgePresentationClaim): number {
  switch (claim.kind) {
    case 'company_default': return 0;
    case 'unresolved_conflict': return 1;
    case 'orphaned_override': return 2;
    case 'property_override': return 3;
    case 'property_only': return 4;
    case 'consistent_with_company': return 5;
  }
}

/** Select claims deterministically. Terms narrow a category when they match;
 * otherwise the category itself is the safe fallback (for example “preferred
 * vendor at Beaumont” where Beaumont is scope, not a knowledge key). */
export function selectPortfolioKnowledgeClaims(input: {
  catalog: PortfolioKnowledgeClaimCatalog;
  query: PortfolioKnowledgeQuery;
}): {
  selection: PortfolioKnowledgePresentationSelection;
  totalMatched: number;
} {
  const categoryCandidates = input.catalog.claims.filter((claim) => (
    queryMatches(claim, input.query, true)
  ));
  const termMatches = categoryCandidates.filter((claim) => queryMatches(claim, input.query));
  const matched = input.query.terms.length > 0 && termMatches.length > 0
    ? termMatches
    : categoryCandidates;
  matched.sort((left, right) => (
    claimPriority(left) - claimPriority(right)
      || left.knowledgeKey.localeCompare(right.knowledgeKey)
      || (left.propertyId ?? '').localeCompare(right.propertyId ?? '')
      || left.id.localeCompare(right.id)
  ));
  return {
    selection: {
      version: PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION,
      orderedClaimIds: matched
        .slice(0, MAX_VISIBLE_KNOWLEDGE_CLAIMS)
        .map((claim) => claim.id),
    },
    totalMatched: matched.length,
  };
}

/** Strict ID-only boundary. Supplying names, contents, provenance, or any other
 * factual field fails schema validation. */
export function validatePortfolioKnowledgeSelection(input: {
  catalog: PortfolioKnowledgeClaimCatalog;
  candidate: unknown;
}): PortfolioKnowledgeSelectionVerdict {
  const parsed = selectionSchema.safeParse(input.candidate);
  if (!parsed.success) return { ok: false, reason: 'invalid_shape' };
  if (new Set(parsed.data.orderedClaimIds).size !== parsed.data.orderedClaimIds.length) {
    return { ok: false, reason: 'duplicate_claim' };
  }
  const byId = new Map(input.catalog.claims.map((claim) => [claim.id, claim]));
  const claims: PortfolioKnowledgePresentationClaim[] = [];
  for (const id of parsed.data.orderedClaimIds) {
    const claim = byId.get(id);
    if (!claim) return { ok: false, reason: 'unknown_claim' };
    claims.push(claim);
  }
  return { ok: true, selection: parsed.data, claims };
}

function safeMarkdown(value: string, max = 500): string {
  return value
    .replace(/[<>\r\n]/g, ' ')
    .replace(/([\\`*_{}\[\]()#+>|])/g, '\\$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function quoted(value: string): string {
  return `“${safeMarkdown(value).replace(/[“”]/g, '"')}”`;
}

function provenance(value: KnowledgeProvenanceV1): string {
  return [
    value.sourceKind === 'company_knowledge' ? 'company rulebook' : 'hotel knowledge',
    `source ${safeMarkdown(value.source, 80)}`,
    `review ${value.reviewState}`,
    `updated ${safeMarkdown(value.updatedAt, 40)}`,
    value.effectiveFrom ? `effective ${safeMarkdown(value.effectiveFrom, 40)}` : null,
    value.expiresAt ? `expires ${safeMarkdown(value.expiresAt, 40)}` : null,
  ].filter(Boolean).join('; ');
}

function propertyName(catalog: PortfolioKnowledgeClaimCatalog, propertyId: string): string {
  const name = catalog.hotelNames.get(propertyId);
  if (!name) {
    throw new PortfolioKnowledgePresentationScopeError(
      'selected knowledge claim has no authorized hotel name',
    );
  }
  return safeMarkdown(name, 140);
}

function renderClaim(
  catalog: PortfolioKnowledgeClaimCatalog,
  claim: PortfolioKnowledgePresentationClaim,
): string[] {
  const key = safeMarkdown(claim.knowledgeKey.replaceAll('_', ' '), 120);
  if (claim.kind === 'company_default' && claim.companyClaim) {
    const exceptions = catalog.claims.filter((candidate) => (
      candidate.propertyId !== null
      && candidate.knowledgeKey === claim.knowledgeKey
      && candidate.kind !== 'consistent_with_company'
    )).length;
    const inherited = Math.max(0, catalog.receipt.selectedPropertyCount - exceptions);
    return [
      `- **${key}**: company default effective at ${inherited} of ${catalog.receipt.selectedPropertyCount} selected hotels: ${quoted(claim.companyClaim.content)}.`,
      `  Provenance: ${provenance(claim.companyClaim.provenance)}.`,
    ];
  }
  if (!claim.propertyId) return [];
  const hotel = propertyName(catalog, claim.propertyId);
  const propertyFacts = claim.propertyClaims;
  const propertySources = propertyFacts
    .map((value) => provenance(value.provenance))
    .join(' | ');

  if (claim.kind === 'property_override' && claim.effectiveClaim && claim.companyClaim) {
    return [
      `- **${hotel}**: explicit property override for ${key}: ${quoted(claim.effectiveClaim.content)}.`,
      `  Override status: resolved by an explicit link to the confirmed company reference; company default was ${quoted(claim.companyClaim.content)}.`,
      `  Provenance: property ${propertySources}; company ${provenance(claim.companyClaim.provenance)}.`,
    ];
  }
  if (claim.kind === 'unresolved_conflict') {
    const companyText = claim.companyClaim ? quoted(claim.companyClaim.content) : 'unavailable';
    const propertyText = propertyFacts.map((value) => quoted(value.content)).join(' | ') || 'unavailable';
    return [
      `- **${hotel}**: unresolved conflict for ${key}; no value was selected.`,
      `  Company reference: ${companyText}. Property reference: ${propertyText}.`,
      `  Provenance: company ${claim.companyClaim ? provenance(claim.companyClaim.provenance) : 'unavailable'}; property ${propertySources || 'unavailable'}.`,
    ];
  }
  if (claim.kind === 'orphaned_override' && claim.effectiveClaim) {
    return [
      `- **${hotel}**: property fact for ${key}: ${quoted(claim.effectiveClaim.content)}.`,
      '  Override status: the referenced company fact is unavailable; this is shown as a property fact with unresolved override provenance, not as a company-wide rule.',
      `  Provenance: ${propertySources}.`,
    ];
  }
  if (claim.kind === 'consistent_with_company' && claim.companyClaim) {
    return [
      `- **${hotel}**: property source confirms the company default for ${key}: ${quoted(claim.companyClaim.content)}.`,
      `  Provenance: company ${provenance(claim.companyClaim.provenance)}; property ${propertySources}.`,
    ];
  }
  if (claim.kind === 'property_only' && claim.effectiveClaim) {
    return [
      `- **${hotel}**: property-only fact for ${key}: ${quoted(claim.effectiveClaim.content)}.`,
      `  Provenance: ${propertySources}.`,
    ];
  }
  return [];
}

/** Deterministic visible-answer boundary. The caller supplies only validated
 * opaque IDs; every displayed fact and provenance token comes from the
 * tenant-checked overlay held in the catalog. */
export function renderPortfolioKnowledgeAnswer(input: {
  catalog: PortfolioKnowledgeClaimCatalog;
  selection: PortfolioKnowledgePresentationSelection;
  totalMatched: number;
  selectorLabel: string;
}): string {
  const verdict = validatePortfolioKnowledgeSelection({
    catalog: input.catalog,
    candidate: input.selection,
  });
  if (!verdict.ok) {
    throw new PortfolioKnowledgePresentationScopeError(
      `knowledge selection rejected: ${verdict.reason}`,
    );
  }
  if (!Number.isSafeInteger(input.totalMatched)
      || input.totalMatched < verdict.claims.length) {
    throw new PortfolioKnowledgePresentationScopeError('invalid knowledge match count');
  }

  const { receipt, overlay } = input.catalog;
  const organization = safeMarkdown(receipt.organizationName || 'Management company', 160);
  const lines = [
    `**Active scope**: ${organization}; ${safeMarkdown(input.selectorLabel, 140)}; ${receipt.selectedPropertyCount} selected of ${receipt.authorizedPropertyCount} currently authorized hotels.`,
    `**Knowledge status**: active, confirmed references as of ${safeMarkdown(overlay.asOf, 40)}; ${input.totalMatched} matching claims.`,
  ];

  if (verdict.claims.length === 0) {
    lines.push('', 'No active, confirmed company or selected-hotel knowledge matched that question. I did not infer a policy or use unconfirmed notes.');
  } else {
    lines.push('', '**Confirmed company and hotel knowledge**');
    for (const claim of verdict.claims) lines.push(...renderClaim(input.catalog, claim));
  }

  const omitted = Math.max(0, input.totalMatched - verdict.claims.length);
  if (omitted > 0) {
    lines.push(`- ${omitted} additional matching claims were omitted from this bounded answer.`);
  }
  if (overlay.exclusions.length > 0) {
    const counts = new Map<string, number>();
    for (const exclusion of overlay.exclusions) {
      counts.set(exclusion.reason, (counts.get(exclusion.reason) ?? 0) + 1);
    }
    lines.push('', `Excluded reference records: ${[...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${safeMarkdown(reason, 80)}=${count}`)
      .join(', ')}. Their content was not used.`);
  }
  lines.push('', `Knowledge contract: ${PORTFOLIO_KNOWLEDGE_PRESENTATION_VERSION}; overlay ${overlay.version}.`);
  return lines.join('\n');
}
