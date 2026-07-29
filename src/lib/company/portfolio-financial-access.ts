import 'server-only';

import { resolveManagementCompanyScopeUncached } from '@/lib/company/authoritative-scope';
import type { AppRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';

export type PortfolioFinancialDecision = 'allowed' | 'denied' | 'unavailable';

export interface PortfolioFinancialAccessInput {
  accountId: string;
  legacyRole: AppRole;
  legacyPropertyAccess: readonly string[];
  organizationId: string;
  /** Already intersected with the caller's fresh company coverage. */
  propertyIds: readonly string[];
}

/**
 * Resolve the money boundary independently for every covered hotel.
 *
 * Company finance is a real company hat but deliberately degrades to the
 * operational `front_desk` role, so `canForProperty` alone would deny it. The
 * company spine's `seesFinancials` bit restores that one dimension while an
 * explicit hotel override can still restrict the effective role. The override
 * rows are one bounded read narrowed to the already-authorized hotel ids; an
 * override or hat-store outage is `unavailable`, never an implicit grant.
 */
export async function resolvePortfolioFinancialAccess(
  input: PortfolioFinancialAccessInput,
): Promise<Map<string, PortfolioFinancialDecision>> {
  const propertyIds = [...new Set(input.propertyIds)];
  const unavailable = (): Map<string, PortfolioFinancialDecision> => new Map(
    propertyIds.map((propertyId) => [propertyId, 'unavailable' as const]),
  );

  const resolved = await resolveManagementCompanyScopeUncached(
    input.accountId,
    input.organizationId,
  );
  if (!resolved.ok) {
    if (resolved.reason === 'authorization_unavailable') return unavailable();
    return new Map(propertyIds.map((propertyId) => [propertyId, 'denied' as const]));
  }
  if (propertyIds.some((propertyId) => !resolved.access.propertyIds.includes(propertyId))) {
    return new Map(propertyIds.map((propertyId) => [propertyId, 'denied' as const]));
  }

  if (propertyIds.length === 0) return new Map();
  const { data, error } = await supabaseAdmin
    .from('capability_overrides')
    .select('property_id, role, allowed')
    .in('property_id', propertyIds)
    .eq('capability', 'view_financials');
  if (error || !Array.isArray(data)) return unavailable();

  const explicitByHotelAndRole = new Map<string, boolean>();
  for (const row of data as Array<{ property_id: string; role: string; allowed: boolean }>) {
    if (!propertyIds.includes(row.property_id) || typeof row.allowed !== 'boolean') continue;
    explicitByHotelAndRole.set(`${row.property_id}:${row.role}`, row.allowed);
  }

  const decisions: Array<[string, PortfolioFinancialDecision]> = propertyIds.map((propertyId) => {
    const standing = resolved.access.propertyStandings
      .find((candidate) => candidate.propertyId === propertyId);
    if (!standing) return [propertyId, 'denied'];
    const restrictingRoles = new Set<string>([standing.operationalRole]);
    if (resolved.access.companyRole === 'owner') restrictingRoles.add('owner');
    const explicitDeny = [...restrictingRoles].some(
      (role) => explicitByHotelAndRole.get(`${propertyId}:${role}`) === false,
    );
    // `allowed:true` never elevates a role. It only avoids restricting a role
    // whose effective job already carries financial access.
    return [propertyId, standing.seesFinancials && !explicitDeny ? 'allowed' : 'denied'];
  });

  return new Map(decisions);
}
