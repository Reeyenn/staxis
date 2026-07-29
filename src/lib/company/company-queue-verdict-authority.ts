import 'server-only';

import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
  type AuthoritativePropertyStanding,
} from '@/lib/authorization/server';
import {
  readCompleteCompanyIdChunks,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';
import type { CapabilityKey } from '@/lib/capabilities/registry';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { PortfolioCard } from './vp-queue';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const COMPANY_QUEUE_VERDICTS = [
  'known_problem',
  'muted',
  'resolved',
] as const;
export type CompanyQueueVerdict = (typeof COMPANY_QUEUE_VERDICTS)[number];

export interface CompanyQueueVerdictAllowanceResult {
  cards: PortfolioCard[];
  /** Cards withheld because their typed target lineage was unsafe for egress. */
  excludedFindingCount: number;
}

const COMPANY_QUEUE_CAPABILITIES = [
  'manage_checklists',
  'manage_inventory_orders',
  'manage_notifications',
  'run_reports',
  'view_financials',
] as const satisfies readonly CapabilityKey[];

interface PropertySectionRow {
  id: string;
  enabled_sections: unknown;
}

interface CapabilityOverrideRow {
  property_id: string;
  capability: string;
  role: string;
  allowed: boolean;
}

/** Match 0405's strict JSONB rule exactly. */
export function staxisSectionAllowsCompanyVerdict(raw: unknown): boolean {
  if (raw === null) return true;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  const map = raw as Record<string, unknown>;
  return !Object.prototype.hasOwnProperty.call(map, 'staxis') || map.staxis === true;
}

/** Empty, duplicate, uppercase, or out-of-order target lineage fails closed. */
export function canonicalCompanyVerdictTargets(
  value: readonly string[] | undefined,
): string[] | null {
  if (!Array.isArray(value)
    || value.length === 0
    || value.length > 250
    || !value.every((id) => typeof id === 'string' && UUID_RX.test(id))) return null;
  const canonical = [...new Set(value)].sort();
  return canonical.length === value.length
    && canonical.every((id, index) => id === value[index])
    ? canonical
    : null;
}

/**
 * The database owns the same deliberately closed mapping. A new detector or a
 * contradictory detector/family pair gets no mutation affordance until both
 * boundaries are intentionally extended together.
 */
export function companyFindingVerdictCapabilities(input: {
  detectorId: string;
  semanticFamily?: string | null;
  action: CompanyQueueVerdict;
}): CapabilityKey[] | null {
  const family = input.semanticFamily ?? null;
  let base: CapabilityKey[] | null = null;
  if (input.detectorId === 'portfolio_supply_spend_gap'
    && (family === null || family === 'supply_spend_control')) {
    base = ['manage_inventory_orders', 'view_financials'];
  } else if (input.detectorId === 'portfolio_activity_stopped'
    && (family === null || family === 'portfolio_activity_stopped')) {
    base = ['run_reports'];
  }
  if (!base) return null;
  base.push(input.action === 'resolved' ? 'manage_checklists' : 'manage_notifications');
  return [...new Set(base)].sort() as CapabilityKey[];
}

function overrideAllows(
  rows: ReadonlyMap<string, boolean>,
  standing: AuthoritativePropertyStanding,
  propertyId: string,
  capability: CapabilityKey,
): boolean {
  if (standing.operationalRole === 'admin') return true;
  const key = `${propertyId}\u0000${capability}\u0000${standing.operationalRole}`;
  return rows.get(key) !== false;
}

/**
 * Add non-authoritative per-card affordances from one fresh hotel-standing
 * snapshot and complete bounded property/override reads. Any missing page,
 * count drift, malformed row, section denial, or unknown company family leaves
 * the affected card readable with its mutation controls hidden. The RPC repeats
 * the exact action decision under transaction locks.
 *
 * Climbed hotel cards deliberately do not use the company-family map: they post
 * through /api/findings and retain that hotel's existing action/signoff policy.
 */
export async function attachCompanyQueueVerdictAllowances(input: {
  accountId: string;
  selectedPropertyIds: readonly string[];
  cards: readonly PortfolioCard[];
}): Promise<CompanyQueueVerdictAllowanceResult> {
  if (input.cards.length === 0) return { cards: [], excludedFindingCount: 0 };

  // Target lineage is also an egress boundary. A malformed row, a company row
  // naming a hotel outside the selected receipt, or a climbed row whose lineage
  // does not exactly match its hotel is omitted—not merely made read-only—so a
  // poisoned service-role row cannot disclose another scope's property id.
  const selected = new Set(input.selectedPropertyIds);
  const safeCards: Array<{ card: PortfolioCard; targets: string[] }> = [];
  for (const card of input.cards) {
    const targets = canonicalCompanyVerdictTargets(card.affectedPropertyIds);
    if (!targets || !targets.every((propertyId) => selected.has(propertyId))) continue;
    if (card.hotel !== null
      && (targets.length !== 1 || targets[0] !== card.hotel.propertyId)) continue;
    safeCards.push({ card, targets });
  }
  const excludedFindingCount = input.cards.length - safeCards.length;

  const denied = safeCards.map(({ card }) => ({
    ...card,
    allowedVerdicts: [] as CompanyQueueVerdict[],
    verdictAllowed: false,
  }));
  if (safeCards.length === 0) return { cards: denied, excludedFindingCount };

  try {
    const access = await listAuthoritativePropertyAccess(input.accountId);
    if (!access) return { cards: denied, excludedFindingCount };
    const targetsByCard = new Map<number, string[]>();
    const targetIds = new Set<string>();
    const companyTargetIds = new Set<string>();
    for (const [index, { card, targets }] of safeCards.entries()) {
      targetsByCard.set(index, targets);
      for (const propertyId of targets) {
        targetIds.add(propertyId);
        if (card.hotel === null) companyTargetIds.add(propertyId);
      }
    }
    if (targetIds.size === 0) return { cards: denied, excludedFindingCount };

    const orderedTargetIds = [...targetIds].sort();
    const propertyRows = await readCompleteCompanyIdChunks<PropertySectionRow>(
      orderedTargetIds,
      (chunk, from, to) => supabaseAdmin
        .from('properties')
        .select('id, enabled_sections', { count: 'exact' })
        .in('id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PropertySectionRow>>,
    );
    const sectionAllowed = new Map<string, boolean>();
    for (const row of propertyRows) {
      if (!UUID_RX.test(row.id) || !targetIds.has(row.id) || sectionAllowed.has(row.id)) {
        return { cards: denied, excludedFindingCount };
      }
      sectionAllowed.set(row.id, staxisSectionAllowsCompanyVerdict(row.enabled_sections));
    }
    if (sectionAllowed.size !== targetIds.size) {
      return { cards: denied, excludedFindingCount };
    }

    const overrideDecisions = new Map<string, boolean>();
    if (companyTargetIds.size > 0) {
      const overrideRows = await readCompleteCompanyIdChunks<CapabilityOverrideRow>(
        [...companyTargetIds].sort(),
        (chunk, from, to) => supabaseAdmin
          .from('capability_overrides')
          .select('property_id, capability, role, allowed', { count: 'exact' })
          .in('property_id', [...chunk])
          .in('capability', [...COMPANY_QUEUE_CAPABILITIES])
          .order('property_id')
          .order('capability')
          .order('role')
          .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<CapabilityOverrideRow>>,
      );
      for (const row of overrideRows) {
        if (!UUID_RX.test(row.property_id)
          || !companyTargetIds.has(row.property_id)
          || !(COMPANY_QUEUE_CAPABILITIES as readonly string[]).includes(row.capability)
          || typeof row.role !== 'string'
          || typeof row.allowed !== 'boolean') {
          return { cards: denied, excludedFindingCount };
        }
        const key = `${row.property_id}\u0000${row.capability}\u0000${row.role}`;
        if (overrideDecisions.has(key)) return { cards: denied, excludedFindingCount };
        overrideDecisions.set(key, row.allowed);
      }
    }

    return {
      cards: denied.map((card, index) => {
        const targets = targetsByCard.get(index);
        if (!targets) return card;
        const standings = targets.map((propertyId) => ({
          propertyId,
          standing: authoritativeStandingForProperty(access, propertyId),
        }));
        const targetAuthorityAllowed = standings.every(({ propertyId, standing }) => (
          sectionAllowed.get(propertyId) === true
          && standing?.hotelMutationAllowed === true
          && (standing.operationalRole === 'admin'
            || standing.operationalRole === 'owner'
            || standing.operationalRole === 'general_manager')
        ));
        if (!targetAuthorityAllowed) return card;

        // Climbed rows live in the hotel's ledger and use that endpoint's action
        // policy. Exact standing + strict section is the company-screen hint.
        if (card.hotel !== null) {
          return {
            ...card,
            allowedVerdicts: undefined,
            verdictAllowed: true,
          };
        }

        const allowedVerdicts = COMPANY_QUEUE_VERDICTS.filter((action) => {
          const capabilities = companyFindingVerdictCapabilities({
            detectorId: card.detectorId,
            semanticFamily: card.semanticFamily,
            action,
          });
          if (!capabilities) return false;
          return standings.every(({ propertyId, standing }) => (
            standing !== null && capabilities.every((capability) => (
              overrideAllows(overrideDecisions, standing, propertyId, capability)
            ))
          ));
        });
        return allowedVerdicts.length > 0
          ? { ...card, allowedVerdicts, verdictAllowed: true }
          : card;
      }),
      excludedFindingCount,
    };
  } catch {
    return { cards: denied, excludedFindingCount };
  }
}
