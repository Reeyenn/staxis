import 'server-only';

import { createHash } from 'node:crypto';

import type { ManagerCaller } from '@/lib/team-auth';
import type { AppSection } from '@/lib/sections/registry';
import type { Finding } from '@/lib/findings/types';

import type { CompanyFinding } from './company-findings';
import {
  resolvePortfolioFinancialAccess,
  type PortfolioFinancialDecision,
} from './portfolio-financial-access';
import {
  resolvePortfolioSectionAccess,
  resolvePortfolioSectionsAccess,
  type PortfolioSectionDecision,
} from './portfolio-section-access';

/** The source modules read by today's company-scope detectors. */
export const PORTFOLIO_DATA_SECTIONS = [
  'staxis',
  'dashboard',
  'housekeeping',
  'communications',
  'inventory',
  'maintenance',
  'staff',
  'financials',
] as const satisfies readonly AppSection[];

export type PortfolioDataSection = (typeof PORTFOLIO_DATA_SECTIONS)[number];

export interface PortfolioDataPolicy {
  /** Company-derived, bounded hotel set. No caller-supplied ids belong here. */
  propertyIds: readonly string[];
  sections: Readonly<Record<
    PortfolioDataSection,
    ReadonlyMap<string, PortfolioSectionDecision>
  >>;
}

export interface PortfolioQueuePolicy extends PortfolioDataPolicy {
  financials: ReadonlyMap<string, PortfolioFinancialDecision>;
  /** Stable cache partition for every policy fact that can remove a card. */
  fingerprint: string;
}

function unavailableSections(
  propertyIds: readonly string[],
): Map<string, PortfolioSectionDecision> {
  return new Map(propertyIds.map((propertyId) => [propertyId, 'unavailable']));
}

function unavailableFinancials(
  propertyIds: readonly string[],
): Map<string, PortfolioFinancialDecision> {
  return new Map(propertyIds.map((propertyId) => [propertyId, 'unavailable']));
}

/**
 * Resolve all detector-origin section policies in one bulk read, regardless of
 * hotel count. A thrown client error is the same answer as a returned store
 * error: unavailable for every hotel, never legacy/default-on.
 */
export async function resolvePortfolioDataPolicy(
  propertyIds: readonly string[],
): Promise<PortfolioDataPolicy> {
  const ids = [...new Set(propertyIds)];
  let resolved;
  try {
    resolved = await resolvePortfolioSectionsAccess(ids, PORTFOLIO_DATA_SECTIONS);
  } catch {
    resolved = new Map();
  }
  const entries = PORTFOLIO_DATA_SECTIONS.map((section) => [
    section,
    resolved.get(section) ?? unavailableSections(ids),
  ] as const);
  return {
    propertyIds: ids,
    sections: Object.fromEntries(entries) as Record<
      PortfolioDataSection,
      Map<string, PortfolioSectionDecision>
    >,
  };
}

export function portfolioSectionDecision(
  policy: PortfolioDataPolicy,
  section: PortfolioDataSection,
  propertyId: string,
): PortfolioSectionDecision {
  return policy.sections[section].get(propertyId) ?? 'unavailable';
}

export interface PortfolioSectionPartition {
  enabledHotelIds: string[];
  disabledHotelIds: string[];
  unavailableHotelIds: string[];
}

export function partitionPortfolioSection(
  policy: PortfolioDataPolicy,
  section: PortfolioDataSection,
): PortfolioSectionPartition {
  const result: PortfolioSectionPartition = {
    enabledHotelIds: [],
    disabledHotelIds: [],
    unavailableHotelIds: [],
  };
  for (const propertyId of policy.propertyIds) {
    const decision = portfolioSectionDecision(policy, section, propertyId);
    if (decision === 'enabled') result.enabledHotelIds.push(propertyId);
    else if (decision === 'disabled') result.disabledHotelIds.push(propertyId);
    else result.unavailableHotelIds.push(propertyId);
  }
  return result;
}

/** One-section fast path for chips/liveness, still one bulk read and fail closed. */
export async function resolvePortfolioSectionPartition(
  propertyIds: readonly string[],
  section: PortfolioDataSection,
): Promise<PortfolioSectionPartition> {
  const ids = [...new Set(propertyIds)];
  let decisions: ReadonlyMap<string, PortfolioSectionDecision>;
  try {
    decisions = await resolvePortfolioSectionAccess(ids, section);
  } catch {
    decisions = unavailableSections(ids);
  }
  const sections = Object.fromEntries(PORTFOLIO_DATA_SECTIONS.map((key) => [
    key,
    key === section ? decisions : unavailableSections(ids),
  ])) as unknown as PortfolioDataPolicy['sections'];
  return partitionPortfolioSection({ propertyIds: ids, sections }, section);
}

export const PORTFOLIO_STREAM_SECTION = Object.freeze({
  inventory_counts: 'inventory',
  work_order_flow: 'maintenance',
  daily_log_closings: 'financials',
} as const satisfies Readonly<Record<string, PortfolioDataSection>>);

export function portfolioStreamSection(streamId: string): PortfolioDataSection | null {
  return (PORTFOLIO_STREAM_SECTION as Readonly<Record<string, PortfolioDataSection>>)[streamId]
    ?? null;
}

function fingerprintFor(
  data: PortfolioDataPolicy,
  financials: ReadonlyMap<string, PortfolioFinancialDecision>,
): string {
  const facts = [...data.propertyIds].sort().map((propertyId) => ({
    propertyId,
    sections: PORTFOLIO_DATA_SECTIONS.map(
      (section) => `${section}:${portfolioSectionDecision(data, section, propertyId)}`,
    ),
    financials: financials.get(propertyId) ?? 'unavailable',
  }));
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 24);
}

/**
 * Resolve projection policy for one current reader. Section and financial
 * decisions are both tri-state and both fail closed. The fingerprint is safe to
 * place in an idempotency key; it contains no raw hotel/account identifiers.
 */
export async function resolvePortfolioQueuePolicy(
  caller: Pick<ManagerCaller, 'accountId' | 'role' | 'propertyAccess'>,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<PortfolioQueuePolicy> {
  const data = await resolvePortfolioDataPolicy(propertyIds);
  let financials: ReadonlyMap<string, PortfolioFinancialDecision>;
  try {
    financials = await resolvePortfolioFinancialAccess({
      accountId: caller.accountId,
      legacyRole: caller.role,
      legacyPropertyAccess: caller.propertyAccess,
      organizationId,
      propertyIds: data.propertyIds,
    });
  } catch {
    financials = unavailableFinancials(data.propertyIds);
  }
  return {
    ...data,
    financials,
    fingerprint: fingerprintFor(data, financials),
  };
}

export type PortfolioFindingPolicyDecision = 'allowed' | 'denied' | 'unavailable';

function evidencePropertyIds(finding: CompanyFinding): string[] | null {
  const value = finding.evidence?.params?.hotel_ids;
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return ids.length === value.length ? [...new Set(ids)] : null;
}

function combineSectionDecision(
  policy: PortfolioDataPolicy,
  propertyIds: readonly string[],
  sections: readonly PortfolioDataSection[],
): PortfolioFindingPolicyDecision {
  const scope = new Set(policy.propertyIds);
  let unavailable = false;
  for (const propertyId of propertyIds) {
    if (!scope.has(propertyId)) return 'denied';
    for (const section of sections) {
      const decision = portfolioSectionDecision(policy, section, propertyId);
      if (decision === 'disabled') return 'denied';
      if (decision === 'unavailable') unavailable = true;
    }
  }
  return unavailable ? 'unavailable' : 'allowed';
}

/**
 * Re-authorize a persisted company card against today's module and caller
 * policy. Evidence ids are mandatory for the two detector families because
 * names cannot safely be mapped back to hotels. Older activity rows without ids
 * disappear until the next detector refresh writes verifiable evidence.
 */
export function portfolioFindingPolicyDecision(
  finding: CompanyFinding,
  policy: PortfolioQueuePolicy,
): PortfolioFindingPolicyDecision {
  if (finding.detectorId === 'portfolio_supply_spend_gap') {
    const propertyIds = evidencePropertyIds(finding);
    if (!propertyIds) return 'unavailable';
    const sections = combineSectionDecision(
      policy,
      propertyIds,
      ['staxis', 'inventory', 'financials'],
    );
    if (sections !== 'allowed') return sections;

    let unavailable = false;
    for (const propertyId of propertyIds) {
      const decision = policy.financials.get(propertyId) ?? 'unavailable';
      if (decision === 'denied') return 'denied';
      if (decision === 'unavailable') unavailable = true;
    }
    return unavailable ? 'unavailable' : 'allowed';
  }

  if (finding.detectorId === 'portfolio_activity_stopped') {
    // Current producers write hotel_ids. The canonical affected-property
    // column safely recovers legacy rows that wrote only affected_hotel_ids;
    // for this detector the stopped hotels are the entire evaluated set.
    const propertyIds = evidencePropertyIds(finding)
      ?? (finding.affectedPropertyIds.length > 0 ? finding.affectedPropertyIds : null);
    const stream = finding.evidence?.params?.stream;
    const sourceSection = typeof stream === 'string' ? portfolioStreamSection(stream) : null;
    if (!propertyIds || !sourceSection) return 'unavailable';
    return combineSectionDecision(policy, propertyIds, ['staxis', sourceSection]);
  }

  // A new/historical detector has no reviewed source or money classification.
  // It stays off every projection until it receives an explicit case above.
  return 'unavailable';
}

const ALL_HOTEL_ORIGIN_SECTIONS = PORTFOLIO_DATA_SECTIONS.filter(
  (section): section is Exclude<PortfolioDataSection, 'staxis'> => section !== 'staxis',
);

const FINANCIAL_HOTEL_DETECTORS = new Set([
  'supply_spend_baseline',
  'inventory_usage_baseline',
  'work_order_rate_baseline',
  'repeat_room_work_orders',
  'repeat_equipment_work_orders',
]);

function hotelFindingSections(finding: Finding): readonly PortfolioDataSection[] {
  switch (finding.detectorId) {
    case 'supply_spend_baseline':
    case 'inventory_usage_baseline':
      return ['staxis', 'inventory', 'financials'];
    case 'work_order_rate_baseline':
    case 'repeat_room_work_orders':
    case 'repeat_equipment_work_orders':
      return ['staxis', 'maintenance', 'financials'];
    case 'preventive_due':
      return ['staxis', 'maintenance'];
    case 'cleaning_plan_health':
      return ['staxis', 'housekeeping'];
    case 'expected_activity_stopped': {
      const stream = finding.evidence?.params?.stream;
      const source = typeof stream === 'string' ? portfolioStreamSection(stream) : null;
      return source ? ['staxis', source] : ['staxis', ...ALL_HOTEL_ORIGIN_SECTIONS];
    }
    // These detector families aggregate more than one subsystem, and historical
    // AI sweep rows do not carry a normalized source-module field. Requiring all
    // origins is conservative: any module revocation removes the ambiguous row.
    case 'operational_pattern':
    case 'room_needs_attention':
    case 'ai_sweep':
    default:
      return ['staxis', ...ALL_HOTEL_ORIGIN_SECTIONS];
  }
}

function hotelFindingCarriesMoney(finding: Finding): boolean {
  if (FINANCIAL_HOTEL_DETECTORS.has(finding.detectorId) || finding.price !== null) return true;
  try {
    const material = JSON.stringify({
      summary: finding.summary,
      judgedSummaryEn: finding.judgedSummaryEn,
      judgedSummaryEs: finding.judgedSummaryEs,
      evidence: finding.evidence,
    });
    // Historical/AI rows have no trustworthy detector provenance. Currency
    // symbols and explicit money-key names are enough to close rather than risk
    // projecting a dollar sentence through an operational-only card.
    return /\$\s*\d|"(?:cost|spend|revenue|wage|budget)(?:_cents|_amount|_total)?"\s*:\s*-?\d/i
      .test(material);
  } catch {
    return true;
  }
}

/**
 * Source-section-only decision for a persisted hotel finding. Useful for chips
 * and other count-only projections that have no current reader identity.
 */
export function portfolioHotelFindingSectionDecision(
  finding: Finding,
  policy: PortfolioDataPolicy,
): PortfolioFindingPolicyDecision {
  if (typeof finding.propertyId !== 'string' || finding.propertyId.length === 0) return 'denied';
  return combineSectionDecision(policy, [finding.propertyId], hotelFindingSections(finding));
}

/**
 * Current-reader decision for a persisted hotel finding.
 *
 * Signature shared by the VP queue and portfolio tools: pass the projected
 * `Finding` row plus one `resolvePortfolioQueuePolicy` snapshot. Unknown or
 * malformed provenance is conservative, and any money-bearing row additionally
 * requires strict per-hotel `view_financials` access.
 */
export function portfolioHotelFindingPolicyDecision(
  finding: Finding,
  policy: PortfolioQueuePolicy,
): PortfolioFindingPolicyDecision {
  const sections = portfolioHotelFindingSectionDecision(finding, policy);
  if (sections !== 'allowed') return sections;
  if (!hotelFindingCarriesMoney(finding)) return 'allowed';

  const propertyId = finding.propertyId;
  if (typeof propertyId !== 'string') return 'denied';
  return policy.financials.get(propertyId) ?? 'unavailable';
}
