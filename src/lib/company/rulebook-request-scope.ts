import 'server-only';

import {
  assertAuthorizationScopeReceipt,
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
} from '@/lib/authorization/server';
import { companyForProperty } from '@/lib/company/access';
import {
  resolveManagementCompanyScopeUncached,
  type ManagementCompanyScopeAccess,
} from '@/lib/company/authoritative-scope';
import {
  rulebookStandingFor,
  type RulebookStanding,
} from '@/lib/company/rulebook-access';
import { canManageTeam } from '@/lib/roles';
import type { ManagerCaller } from '@/lib/team-auth';

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RulebookRequestScopeRefusal =
  | 'invalid_request'
  | 'not_found'
  | 'forbidden'
  | 'unavailable';

interface RulebookRequestScopeBase {
  caller: ManagerCaller;
  organizationId: string;
  billingPropertyId: string;
  standing: RulebookStanding;
}

export interface CompanyRulebookRequestScope extends RulebookRequestScopeBase {
  audience: 'company';
  access: ManagementCompanyScopeAccess;
}

export interface HotelRulebookRequestScope extends RulebookRequestScopeBase {
  audience: 'hotel';
  propertyId: string;
}

export type RulebookRequestScope =
  | CompanyRulebookRequestScope
  | HotelRulebookRequestScope;

export type RulebookRequestScopeResult =
  | { ok: true; scope: RulebookRequestScope }
  | { ok: false; reason: RulebookRequestScopeRefusal };

function validId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RX.test(value);
}

/**
 * Select one rulebook audience from an already-authenticated account.
 *
 * Portfolio mode is bound to the explicitly selected organization and its
 * current all-authorized receipt. Hotel mode is intentionally narrower: only
 * a current, mutating hotel-manager standing may use the legacy property
 * selector, and that mode is always read-only at company altitude.
 */
export async function resolveRulebookRequestScope(
  caller: ManagerCaller,
  selector: { organizationId?: unknown; propertyId?: unknown },
): Promise<RulebookRequestScopeResult> {
  const hasOrganization = selector.organizationId !== undefined
    && selector.organizationId !== null;
  const hasProperty = selector.propertyId !== undefined
    && selector.propertyId !== null;
  if (hasOrganization === hasProperty) return { ok: false, reason: 'invalid_request' };

  if (hasOrganization) {
    if (!validId(selector.organizationId)) {
      return { ok: false, reason: 'invalid_request' };
    }
    const resolved = await resolveManagementCompanyScopeUncached(
      caller.accountId,
      selector.organizationId,
    );
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason === 'authorization_unavailable'
          ? 'unavailable'
          : 'not_found',
      };
    }
    const standing = await rulebookStandingFor(
      caller.accountId,
      resolved.access.organizationId,
    );
    if (!standing.canView) return { ok: false, reason: 'not_found' };
    const billingPropertyId = resolved.access.propertyIds[0];
    if (!billingPropertyId) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      scope: {
        audience: 'company',
        caller,
        organizationId: resolved.access.organizationId,
        billingPropertyId,
        standing,
        access: resolved.access,
      },
    };
  }

  if (!validId(selector.propertyId)) {
    return { ok: false, reason: 'invalid_request' };
  }
  const propertyId = selector.propertyId;
  const currentStanding = caller.propertyStandings
    ?.filter((standing) => standing.propertyId === propertyId) ?? [];
  if (currentStanding.length !== 1
    || currentStanding[0].hotelMutationAllowed !== true
    || !canManageTeam(currentStanding[0].operationalRole)) {
    return { ok: false, reason: 'forbidden' };
  }
  const organizationId = await companyForProperty(propertyId);
  if (!organizationId) return { ok: false, reason: 'not_found' };
  const standing = await rulebookStandingFor(caller.accountId, organizationId);
  if (!standing.canView) return { ok: false, reason: 'forbidden' };
  return {
    ok: true,
    scope: {
      audience: 'hotel',
      caller,
      propertyId,
      organizationId,
      billingPropertyId: propertyId,
      standing: {
        organizationId,
        canView: true,
        canEdit: false,
        companyRole: null,
        viewOnlyBecauseHotelJob: true,
      },
    },
  };
}

/**
 * Reassert immediately before response egress, provider spend, or a mutation.
 * No receipt identifier or authority provenance leaves this module.
 */
export async function rulebookRequestScopeStillCurrent(
  scope: RulebookRequestScope,
): Promise<boolean> {
  if (scope.audience === 'company') {
    const asserted = await assertAuthorizationScopeReceipt({
      receiptId: scope.access.authorizationReceipt.id,
      accountId: scope.caller.accountId,
    });
    if (!asserted.ok
      || asserted.receipt.organizationId !== scope.organizationId
      || asserted.receipt.scopeHash !== scope.access.authorizationReceipt.scopeHash
      || asserted.receipt.authorizationHash
        !== scope.access.authorizationReceipt.authorizationHash) return false;
    const standing = await rulebookStandingFor(scope.caller.accountId, scope.organizationId);
    return standing.canView;
  }

  const authority = await listAuthoritativePropertyAccess(scope.caller.accountId);
  if (!authority || authority.all) return false;
  const standing = authoritativeStandingForProperty(authority, scope.propertyId);
  if (!standing
    || standing.hotelMutationAllowed !== true
    || !canManageTeam(standing.operationalRole)) return false;
  const organizationId = await companyForProperty(scope.propertyId);
  if (organizationId !== scope.organizationId) return false;
  const rulebook = await rulebookStandingFor(scope.caller.accountId, scope.organizationId);
  return rulebook.canView;
}
