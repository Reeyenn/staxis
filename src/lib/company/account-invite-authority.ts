import 'server-only';

import { resolveAuthorizationScope } from '@/lib/authorization/server';
import type {
  AuthorizationScopeEntitlement,
  AuthorizationScopeReceipt,
} from '@/lib/authorization';
import {
  capabilityDecisionForProperty,
  capabilityDecisionForPropertyFresh,
} from '@/lib/capabilities/server';
import {
  accessProfileForHat,
  isHatRole,
  isMembershipScope,
  legacyRoleForHat,
  scopeAllowsRole,
  type HatRole,
  type MembershipScope,
} from '@/lib/company/roles';
import {
  resolveCompanyForProperty,
  resolveOrganizationPropertyTopology,
} from '@/lib/company/access';
import {
  ACCESS_PROFILE_CAPABILITIES,
  type AccessProfile,
} from '@/lib/organization-access/domain';
import { canManageTeam, isValidRole, type AppRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
} from '@/lib/authorization/server';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccountInviteAuthorityResult<T> =
  | { kind: 'allowed'; value: T }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

export interface ActiveAccountInviteActor {
  accountId: string;
  role: AppRole;
  isPlatformAdmin: boolean;
}

export interface CompanyInviteAuthorityContext {
  accountId: string;
  isPlatformAdmin: boolean;
  organizationId: string;
  anchorPropertyId: string;
  operatedPropertyIds: string[];
  authorizedPropertyIds: string[];
  authorizationEntitlements: AuthorizationScopeEntitlement[];
  authorizationReceipt: AuthorizationScopeReceipt | null;
}

export interface ResolvedAuthoritativeInviteScope {
  organizationId: string;
  scope: MembershipScope;
  role: HatRole;
  propertyIds: string[];
  legacyRole: AppRole;
}

export interface StoredNormalizedInviteScope {
  hotelId: string;
  organizationId: string | null;
  membershipScope: string | null;
  role: string;
  coveredPropertyIds: unknown;
}

export interface ProjectedStoredInviteScope {
  scope: MembershipScope;
  role: HatRole;
  /** Only properties the current caller may manage people at are disclosed. */
  propertyIds: string[];
  /** Mutation requires authority over the complete persisted promise. */
  canRevoke: boolean;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Compare two independently loaded authority projections at a response or
 * mutation boundary. This is intentionally stricter than "still reaches the
 * anchor hotel": a regional/portfolio reduction must not let a payload built
 * from the earlier, wider scope leave the process.
 */
export function companyInviteAuthorityUnchanged(
  first: CompanyInviteAuthorityContext,
  current: CompanyInviteAuthorityContext,
): boolean {
  if (first.accountId !== current.accountId
      || first.isPlatformAdmin !== current.isPlatformAdmin
      || first.organizationId !== current.organizationId
      || first.anchorPropertyId !== current.anchorPropertyId
      || !sameStrings(first.operatedPropertyIds, current.operatedPropertyIds)
      || !sameStrings(first.authorizedPropertyIds, current.authorizedPropertyIds)) {
    return false;
  }
  const firstReceipt = first.authorizationReceipt;
  const currentReceipt = current.authorizationReceipt;
  if (!!firstReceipt !== !!currentReceipt) return false;
  if (firstReceipt && currentReceipt) {
    return firstReceipt.authorizationHash === currentReceipt.authorizationHash
      && firstReceipt.accountAuthorizationVersion
        === currentReceipt.accountAuthorizationVersion
      && firstReceipt.organizationAccessEpoch
        === currentReceipt.organizationAccessEpoch;
  }
  const entitlementKeys = (context: CompanyInviteAuthorityContext) => (
    context.authorizationEntitlements.map((entitlement) => [
      entitlement.propertyId,
      entitlement.entitlementKind,
      entitlement.entitlementId,
      entitlement.membershipId,
      entitlement.accessProfile ?? '',
      entitlement.staxisRole ?? '',
      entitlement.scopeType ?? '',
      entitlement.portfolioId ?? '',
    ].join(':')).sort()
  );
  return sameStrings(entitlementKeys(first), entitlementKeys(current));
}

function refusalIsUnavailable(reason: string): boolean {
  return reason === 'store_unavailable'
    || reason === 'scope_too_large'
    || reason === 'scope_changed'
    || reason === 'revoked_or_changed'
    || reason === 'expired';
}

async function loadOperatedPropertyIds(
  organizationId: string,
): Promise<AccountInviteAuthorityResult<string[]>> {
  const resolved = await resolveOrganizationPropertyTopology(organizationId);
  if (!resolved.ok) return { kind: 'unavailable' };
  const propertyIds = [...resolved.topology.propertyIds];
  return propertyIds.length > 0
    ? { kind: 'allowed', value: propertyIds }
    : { kind: 'denied' };
}

export async function loadActiveAccountInviteActor(
  accountId: string,
): Promise<AccountInviteAuthorityResult<ActiveAccountInviteActor>> {
  if (!UUID_RX.test(accountId)) return { kind: 'denied' };
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, role, active')
    .eq('id', accountId)
    .maybeSingle();
  if (error) return { kind: 'unavailable' };
  if (!data || data.active !== true) return { kind: 'denied' };
  if (!isValidRole(data.role)) return { kind: 'denied' };
  const role = data.role;
  return {
    kind: 'allowed',
    value: { accountId: data.id as string, role, isPlatformAdmin: role === 'admin' },
  };
}

/** Fresh exact company context. The explicit organization comes only from the
 * anchor hotel's current governing topology; multi-company accounts never use
 * an implicit or previously selected company. */
export async function loadCompanyInviteAuthorityContext(input: {
  accountId: string;
  isPlatformAdmin: boolean;
  anchorPropertyId: string;
  expectedOrganizationId?: string | null;
}): Promise<AccountInviteAuthorityResult<CompanyInviteAuthorityContext>> {
  if (!UUID_RX.test(input.accountId) || !UUID_RX.test(input.anchorPropertyId)) {
    return { kind: 'denied' };
  }
  const topology = await resolveCompanyForProperty(input.anchorPropertyId);
  if (topology.status === 'unavailable' || topology.status === 'ambiguous') {
    return { kind: 'unavailable' };
  }
  if (topology.status !== 'company'
      || (input.expectedOrganizationId
        && topology.organizationId !== input.expectedOrganizationId)) {
    return { kind: 'denied' };
  }
  const operated = await loadOperatedPropertyIds(topology.organizationId);
  if (operated.kind !== 'allowed') return operated;
  if (!operated.value.includes(input.anchorPropertyId)) return { kind: 'denied' };

  if (input.isPlatformAdmin) {
    return {
      kind: 'allowed',
      value: {
        accountId: input.accountId,
        isPlatformAdmin: true,
        organizationId: topology.organizationId,
        anchorPropertyId: input.anchorPropertyId,
        operatedPropertyIds: operated.value,
        authorizedPropertyIds: operated.value,
        authorizationEntitlements: [],
        authorizationReceipt: null,
      },
    };
  }

  const resolved = await resolveAuthorizationScope({
    accountId: input.accountId,
    organizationId: topology.organizationId,
    selector: { type: 'all_authorized' },
  });
  if (resolved.ok) {
    if (resolved.receipt.accountId !== input.accountId
        || resolved.receipt.organizationId !== topology.organizationId
        || !resolved.receipt.propertyIds.includes(input.anchorPropertyId)) {
      return { kind: 'denied' };
    }
    return {
      kind: 'allowed',
      value: {
        accountId: input.accountId,
        isPlatformAdmin: false,
        organizationId: topology.organizationId,
        anchorPropertyId: input.anchorPropertyId,
        operatedPropertyIds: operated.value,
        authorizedPropertyIds: resolved.receipt.authorizedPropertyIds,
        authorizationEntitlements: resolved.receipt.provenance.entitlements,
        authorizationReceipt: resolved.receipt,
      },
    };
  }
  if (refusalIsUnavailable(resolved.reason)) return { kind: 'unavailable' };
  if (resolved.reason !== 'no_company_job') return { kind: 'denied' };

  // One-hotel normalized GMs/property managers are intentionally excluded from
  // portfolio mode by staxis_resolve_authorization_scope. People management at
  // that exact hotel must still remain normalized, so consume the same atomic
  // per-hotel authority projection without opening portfolio chat for them.
  const access = await listAuthoritativePropertyAccess(input.accountId);
  if (!access) return { kind: 'unavailable' };
  if (access.all || access.authorityMode !== 'normalized') return { kind: 'denied' };
  const operatedSet = new Set(operated.value);
  const authorizationEntitlements = access.propertyStandings.flatMap((standing) => (
    !operatedSet.has(standing.propertyId)
      ? []
      : standing.entitlements.flatMap((entitlement): AuthorizationScopeEntitlement[] => {
        if ((entitlement.kind !== 'membership_hat' && entitlement.kind !== 'access_grant')
            || entitlement.organizationId !== topology.organizationId
            || !entitlement.membershipId
            || !entitlement.scopeType) return [];
        return [{
          propertyId: standing.propertyId,
          entitlementKind: entitlement.kind,
          entitlementId: entitlement.entitlementId,
          membershipId: entitlement.membershipId,
          accessProfile: entitlement.accessProfile,
          staxisRole: entitlement.staxisRole,
          scopeType: entitlement.scopeType,
          portfolioId: entitlement.portfolioId,
        }];
      })
  ));
  const authorizedPropertyIds = [...new Set(
    authorizationEntitlements.map((entitlement) => entitlement.propertyId),
  )].sort();
  if (!authorizedPropertyIds.includes(input.anchorPropertyId)) return { kind: 'denied' };
  return {
    kind: 'allowed',
    value: {
      accountId: input.accountId,
      isPlatformAdmin: false,
      organizationId: topology.organizationId,
      anchorPropertyId: input.anchorPropertyId,
      operatedPropertyIds: operated.value,
      authorizedPropertyIds,
      authorizationEntitlements,
      authorizationReceipt: null,
    },
  };
}

/** Resolve the actor row and company scope in one fresh operation. Callers
 * must not carry `isPlatformAdmin` from a session or an earlier request: an
 * admin-role removal has to invalidate an open tab immediately. */
export async function loadFreshCompanyInviteAuthorityContext(input: {
  accountId: string;
  anchorPropertyId: string;
  expectedOrganizationId?: string | null;
}): Promise<AccountInviteAuthorityResult<CompanyInviteAuthorityContext>> {
  const actor = await loadActiveAccountInviteActor(input.accountId);
  if (actor.kind !== 'allowed') return actor;
  return loadCompanyInviteAuthorityContext({
    accountId: actor.value.accountId,
    isPlatformAdmin: actor.value.isPlatformAdmin,
    anchorPropertyId: input.anchorPropertyId,
    expectedOrganizationId: input.expectedOrganizationId,
  });
}

function entitlementProfile(entitlement: AuthorizationScopeEntitlement): AccessProfile {
  return entitlement.entitlementKind === 'access_grant'
    ? entitlement.accessProfile!
    : accessProfileForHat(
        entitlement.scopeType as MembershipScope,
        entitlement.staxisRole!,
      );
}

function entitlementCanManagePeople(entitlement: AuthorizationScopeEntitlement): boolean {
  return ACCESS_PROFILE_CAPABILITIES[entitlementProfile(entitlement)].includes('manage_people');
}

function broadEntitlement(entitlement: AuthorizationScopeEntitlement): boolean {
  return entitlement.scopeType === 'company' || entitlement.scopeType === 'organization';
}

function entitlementCanGrantPropertyRole(
  entitlement: AuthorizationScopeEntitlement,
  role: HatRole,
): boolean {
  if (entitlement.entitlementKind === 'membership_hat') {
    if (entitlement.scopeType === 'company') {
      return entitlement.staxisRole === 'owner' || entitlement.staxisRole === 'vp';
    }
    return entitlement.scopeType === 'property'
      && entitlement.staxisRole === 'general_manager'
      && role !== 'general_manager';
  }
  if (entitlement.accessProfile === 'organization_owner') return true;
  if (entitlement.accessProfile === 'organization_admin'
      || entitlement.accessProfile === 'portfolio_manager') return true;
  return entitlement.accessProfile === 'property_manager' && role !== 'general_manager';
}

function entitlementCanGrantCompanyRole(
  entitlement: AuthorizationScopeEntitlement,
  role: HatRole,
): boolean {
  if (!broadEntitlement(entitlement)) return false;
  if (entitlement.entitlementKind === 'membership_hat') {
    if (entitlement.staxisRole === 'owner') return true;
    return entitlement.staxisRole === 'vp' && role === 'finance';
  }
  if (entitlement.accessProfile === 'organization_owner') return true;
  return (entitlement.accessProfile === 'organization_admin'
      || entitlement.accessProfile === 'portfolio_manager')
    && role === 'finance';
}

function entitlementsAt(
  context: CompanyInviteAuthorityContext,
  propertyId: string,
): AuthorizationScopeEntitlement[] {
  return context.authorizationEntitlements.filter(
    (entitlement) => entitlement.propertyId === propertyId,
  ) ?? [];
}

function readPropertyIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 5_000) return null;
  if (value.some((item) => typeof item !== 'string' || !UUID_RX.test(item))) return null;
  if (new Set(value as string[]).size !== value.length) return null;
  return [...(value as string[])].sort();
}

export function resolveAuthoritativeInviteScope(
  context: CompanyInviteAuthorityContext,
  requestedRole: string,
  requestedScope: unknown,
  requestedPropertyIds: unknown,
): AccountInviteAuthorityResult<ResolvedAuthoritativeInviteScope> {
  if (!isMembershipScope(requestedScope)
      || !isHatRole(requestedRole)
      || !scopeAllowsRole(requestedScope, requestedRole)) {
    return { kind: 'denied' };
  }
  const operated = new Set(context.operatedPropertyIds);
  if (requestedScope === 'company') {
    if (!context.isPlatformAdmin) {
      if (context.authorizedPropertyIds.length !== context.operatedPropertyIds.length
          || context.operatedPropertyIds.some(
            (propertyId) => !context.authorizedPropertyIds.includes(propertyId),
          )
          || context.operatedPropertyIds.some((propertyId) => !entitlementsAt(
            context,
            propertyId,
          ).some((entitlement) => broadEntitlement(entitlement)
            && entitlementCanGrantCompanyRole(entitlement, requestedRole)))) {
        return { kind: 'denied' };
      }
    }
    return {
      kind: 'allowed',
      value: {
        organizationId: context.organizationId,
        scope: requestedScope,
        role: requestedRole,
        propertyIds: context.operatedPropertyIds,
        legacyRole: legacyRoleForHat(requestedRole),
      },
    };
  }

  const propertyIds = readPropertyIds(requestedPropertyIds);
  if (!propertyIds || propertyIds.some((propertyId) => !operated.has(propertyId))) {
    return { kind: 'denied' };
  }
  if (!context.isPlatformAdmin && propertyIds.some((propertyId) => (
    !entitlementsAt(context, propertyId).some(
      (entitlement) => entitlementCanGrantPropertyRole(entitlement, requestedRole),
    )
  ))) {
    return { kind: 'denied' };
  }
  return {
    kind: 'allowed',
    value: {
      organizationId: context.organizationId,
      scope: requestedScope,
      role: requestedRole,
      propertyIds,
      legacyRole: legacyRoleForHat(requestedRole),
    },
  };
}

/**
 * Project one normalized invitation onto the selected hotel's People surface.
 *
 * Visibility and mutation are deliberately separate. A property manager may
 * need to see that an invitation affects their hotel even when the same
 * invitation also covers properties outside their reach. The projection never
 * returns those sister-property ids (or a hidden count), while `canRevoke`
 * remains false unless the caller can control the complete persisted promise.
 */
export function projectStoredInviteForCompanyContext(
  context: CompanyInviteAuthorityContext,
  invite: StoredNormalizedInviteScope,
  selectedPropertyId: string,
): ProjectedStoredInviteScope | null {
  if (invite.organizationId !== context.organizationId
      || !UUID_RX.test(invite.hotelId)
      || !UUID_RX.test(selectedPropertyId)
      || !isMembershipScope(invite.membershipScope)
      || !isHatRole(invite.role)
      || !scopeAllowsRole(invite.membershipScope, invite.role)) return null;

  const operated = new Set(context.operatedPropertyIds);
  if (!operated.has(invite.hotelId) || !operated.has(selectedPropertyId)) return null;
  const targetPropertyIds = invite.membershipScope === 'company'
    ? invite.coveredPropertyIds === null
      ? context.operatedPropertyIds
      : null
    : readPropertyIds(invite.coveredPropertyIds);
  if (!targetPropertyIds
      || targetPropertyIds.some((propertyId) => !operated.has(propertyId))
      || (invite.membershipScope === 'property'
        && !targetPropertyIds.includes(invite.hotelId))
      || !targetPropertyIds.includes(selectedPropertyId)) return null;

  const canViewAt = (propertyId: string) => context.isPlatformAdmin
    || (context.authorizedPropertyIds.includes(propertyId)
      && entitlementsAt(context, propertyId).some(entitlementCanManagePeople));
  if (!canViewAt(selectedPropertyId)) return null;

  const propertyIds = targetPropertyIds.filter(canViewAt).sort();
  const fullAuthority = resolveAuthoritativeInviteScope(
    context,
    invite.role,
    invite.membershipScope,
    invite.membershipScope === 'property' ? targetPropertyIds : [],
  );
  return {
    scope: invite.membershipScope,
    role: invite.role,
    propertyIds,
    canRevoke: fullAuthority.kind === 'allowed',
  };
}

/** Re-run the exact delegation hierarchy for a persisted normalized invite.
 * This is deliberately stronger than the People-list visibility predicate:
 * being allowed to see a peer/owner invitation is not authority to create,
 * accept, or revoke it. */
export async function resolveStoredNormalizedInviteAuthority(input: {
  accountId: string;
  invite: StoredNormalizedInviteScope;
}): Promise<AccountInviteAuthorityResult<ResolvedAuthoritativeInviteScope>> {
  const { invite } = input;
  const coveredPropertyIds = invite.membershipScope === 'property'
    ? readPropertyIds(invite.coveredPropertyIds)
    : null;
  if (!UUID_RX.test(invite.hotelId)
      || !invite.organizationId
      || !UUID_RX.test(invite.organizationId)
      || !isMembershipScope(invite.membershipScope)
      || !isHatRole(invite.role)
      || !scopeAllowsRole(invite.membershipScope, invite.role)
      || (invite.membershipScope === 'company' && invite.coveredPropertyIds !== null)
      || (invite.membershipScope === 'property'
        && (!coveredPropertyIds || !coveredPropertyIds.includes(invite.hotelId)))) {
    return { kind: 'denied' };
  }
  const context = await loadFreshCompanyInviteAuthorityContext({
    accountId: input.accountId,
    anchorPropertyId: invite.hotelId,
    expectedOrganizationId: invite.organizationId,
  });
  if (context.kind !== 'allowed') return context;
  return resolveAuthoritativeInviteScope(
    context.value,
    invite.role,
    invite.membershipScope,
    coveredPropertyIds ?? [],
  );
}

export async function resolveLocalHotelInviteAuthority(
  accountId: string,
  hotelId: string,
  options: {
    freshCapability?: boolean;
    requireIndependentTopology?: boolean;
  } = {},
): Promise<AccountInviteAuthorityResult<{ roleAtHotel: AppRole }>> {
  if (options.requireIndependentTopology) {
    const topology = await resolveCompanyForProperty(hotelId);
    if (topology.status === 'unavailable' || topology.status === 'ambiguous') {
      return { kind: 'unavailable' };
    }
    if (topology.status !== 'independent') return { kind: 'denied' };
  }
  const actor = await loadActiveAccountInviteActor(accountId);
  if (actor.kind !== 'allowed') return actor;
  if (actor.value.isPlatformAdmin) {
    return { kind: 'allowed', value: { roleAtHotel: 'admin' } };
  }
  const authority = await listAuthoritativePropertyAccess(accountId);
  if (!authority) return { kind: 'unavailable' };
  const standing = authoritativeStandingForProperty(authority, hotelId);
  if (!standing
      || !standing.hotelMutationAllowed
      || !canManageTeam(standing.operationalRole)) return { kind: 'denied' };
  const capability = await (options.freshCapability
    ? capabilityDecisionForPropertyFresh
    : capabilityDecisionForProperty)(
    { role: standing.operationalRole },
    'manage_team',
    hotelId,
  );
  if (capability === 'unavailable') return { kind: 'unavailable' };
  return capability === 'allowed'
    ? { kind: 'allowed', value: { roleAtHotel: standing.operationalRole } }
    : { kind: 'denied' };
}
