import 'server-only';

import type { ManagerCaller } from '@/lib/team-auth';

import {
  resolvePortfolioQueuePolicy,
  type PortfolioQueuePolicy,
} from './portfolio-data-policy';
import {
  companyQueueScopeFromAuthorization,
  type CompanyRole,
} from './vp-queue-server';
import { resolveManagementCompanyScopeUncached } from './authoritative-scope';

export interface PortfolioHotelAuthority {
  organizationId: string;
  companyRole: CompanyRole;
  policy: PortfolioQueuePolicy;
}

/**
 * Resolve a company reader's authority over one hotel without confusing
 * portfolio reach with hotel-management standing.
 *
 * The optional organization id is a selector, never authority: it must match a
 * current COMPANY-scope hat whose freshly resolved coverage contains the
 * hotel. Without a selector there must be exactly one matching company. The
 * strict company resolver then re-reads today's governing relationships before
 * a policy snapshot is built, so a moved hotel or ended relationship cannot be
 * acted on from a stale tab.
 *
 * Throws when the governing/access store is unreadable; route boundaries turn
 * that into a retryable 503. Null is reserved for a real lack of authority.
 */
export async function resolvePortfolioHotelAuthority(
  caller: ManagerCaller,
  propertyId: string,
  requestedOrganizationId?: string | null,
): Promise<PortfolioHotelAuthority | null> {
  const resolved = await resolveManagementCompanyScopeUncached(
    caller.accountId,
    requestedOrganizationId,
  );
  if (!resolved.ok || !resolved.access.propertyIds.includes(propertyId)) return null;
  const scope = await companyQueueScopeFromAuthorization(caller, resolved.access);

  return {
    organizationId: scope.organizationId,
    companyRole: scope.companyRole,
    policy: await resolvePortfolioQueuePolicy(
      caller,
      scope.organizationId,
      scope.propertyIds,
    ),
  };
}
