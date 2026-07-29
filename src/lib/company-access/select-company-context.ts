import {
  EMPTY_COMPANY_ACCESS,
  type CompanyAccessData,
  type CompanyAccessPermissions,
} from '@/lib/company-access/dto';

/**
 * Project the already-authorized Company Hub DTO to one deliberately selected
 * organization. This is presentation isolation, not authorization: routes
 * still re-resolve every mutation. Keeping it pure makes stale/multi-company
 * transitions independently testable and prevents one company's rows or
 * delegation policy from surviving a context switch.
 */
export function selectCompanyAccessContext(
  data: CompanyAccessData,
  organizationId: string,
): CompanyAccessData | null {
  const organizations = data.organizations.filter((item) => item.id === organizationId);
  if (organizations.length !== 1) return null;

  const properties = data.properties.filter(
    (property) => property.organizationId === organizationId,
  );
  const propertyIds = new Set(properties.map((property) => property.id));
  const delegationPolicies = data.permissions.delegationPolicies.filter(
    (policy) => policy.organizationId === organizationId,
  );
  const availableProfiles = [...new Set(
    delegationPolicies.flatMap((policy) => (
      policy.profiles.map((profile) => profile.accessProfile)
    )),
  )].sort();
  const permissions: CompanyAccessPermissions = {
    ...data.permissions,
    accountInvitePropertyIds: (data.permissions.accountInvitePropertyIds ?? [])
      .filter((propertyId) => propertyIds.has(propertyId)),
    availableProfiles,
    delegationPolicies,
    // A broad permission from another company must never light up this one.
    manageAccess: data.permissions.manageAccess && delegationPolicies.length > 0,
    managePeople: data.permissions.managePeople && (
      delegationPolicies.length > 0
      || data.memberships.some((membership) => (
        membership.organizationId === organizationId
        && (membership.canSuspend || membership.canResume || membership.canRemove)
      ))
    ),
    manageInvitations: data.permissions.manageInvitations && (
      delegationPolicies.length > 0
      || data.invitations.some((invitation) => (
        invitation.organizationId === organizationId && invitation.canCancel
      ))
    ),
  };

  return {
    ...EMPTY_COMPANY_ACCESS,
    organizations,
    portfolios: data.portfolios.filter(
      (portfolio) => portfolio.organizationId === organizationId,
    ),
    properties,
    memberships: data.memberships.filter(
      (membership) => membership.organizationId === organizationId,
    ),
    effectiveAccess: data.effectiveAccess.filter(
      (receipt) => receipt.organizationId === organizationId,
    ),
    invitations: data.invitations.filter(
      (invitation) => invitation.organizationId === organizationId,
    ),
    requests: data.requests.filter(
      (request) => request.organizationId === organizationId,
    ),
    activity: data.activity.filter(
      (event) => event.organizationId === organizationId,
    ),
    permissions,
    legacyFallback: data.legacyFallback,
  };
}
