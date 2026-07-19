import {
  ACCESS_PROFILE_CAPABILITIES,
  DELEGATABLE_PROFILES,
  type AccessProfile,
  type AccessScopeType,
  type OrganizationCapability,
} from './domain';

export interface OrganizationFact {
  id: string;
  status: 'active' | 'suspended' | 'inactive' | string;
}

export interface MembershipFact {
  id: string;
  organizationId: string;
  accountId: string;
  status: 'active' | 'suspended' | 'revoked' | string;
  startsAt: string | Date;
  endedAt?: string | Date | null;
  /** False when the underlying Staxis account is deactivated. */
  accountActive?: boolean;
}

export interface PropertyRelationshipFact {
  id: string;
  organizationId: string;
  propertyId: string;
  startsAt: string | Date;
  endsAt?: string | Date | null;
}

export interface PortfolioFact {
  id: string;
  organizationId: string;
  status: 'active' | 'archived' | string;
}

export interface PortfolioPropertyFact {
  organizationId: string;
  portfolioId: string;
  propertyRelationshipId: string;
  propertyId: string;
  assignedAt: string | Date;
  removedAt?: string | Date | null;
}

export interface AccessGrantFact {
  id: string;
  organizationId: string;
  membershipId: string;
  accessProfile: AccessProfile;
  scopeType: AccessScopeType;
  portfolioId?: string | null;
  propertyRelationshipId?: string | null;
  propertyId?: string | null;
  status: 'active' | 'revoked' | string;
  source: 'manual' | 'invitation' | 'access_request' | 'legacy_backfill' | 'system' | string;
  startsAt: string | Date;
  expiresAt?: string | Date | null;
}

export interface AccessFacts {
  organizations: readonly OrganizationFact[];
  memberships: readonly MembershipFact[];
  grants: readonly AccessGrantFact[];
  propertyRelationships: readonly PropertyRelationshipFact[];
  portfolios: readonly PortfolioFact[];
  portfolioProperties: readonly PortfolioPropertyFact[];
}

export interface AccessReceipt {
  grantId: string;
  membershipId: string;
  organizationId: string;
  propertyId: string;
  accessProfile: AccessProfile;
  scopeType: AccessScopeType;
  source: AccessGrantFact['source'];
  expiresAt: string | Date | null;
  reason: string;
}

export interface ResolvedPropertyAccess {
  allowed: boolean;
  propertyId: string;
  profiles: AccessProfile[];
  capabilities: OrganizationCapability[];
  receipts: AccessReceipt[];
  denialReason?:
    | 'no_active_membership'
    | 'no_active_relationship'
    | 'no_matching_active_grant';
}

export interface DelegationRequest {
  actorAccountId: string;
  organizationId: string;
  requestedProfile: AccessProfile;
  requestedScopeType: AccessScopeType;
  requestedPortfolioId?: string | null;
  requestedPropertyId?: string | null;
  at?: string | Date;
}

export interface DelegationDecision {
  allowed: boolean;
  authorizingGrantId?: string;
  reason:
    | 'allowed'
    | 'invalid_requested_scope'
    | 'no_active_membership'
    | 'profile_not_delegatable'
    | 'scope_not_contained';
}

const asMillis = (value: string | Date): number => new Date(value).getTime();

function activeWindow(
  startsAt: string | Date,
  endsAt: string | Date | null | undefined,
  at: number,
): boolean {
  const start = asMillis(startsAt);
  const end = endsAt == null ? null : asMillis(endsAt);
  return Number.isFinite(start)
    && start <= at
    && (end == null || (Number.isFinite(end) && end > at));
}

function isActiveOrganization(fact: OrganizationFact | undefined): boolean {
  return fact?.status === 'active';
}

function isActiveMembership(fact: MembershipFact, at: number): boolean {
  return fact.accountActive !== false
    && fact.status === 'active'
    && activeWindow(fact.startsAt, fact.endedAt, at);
}

function isActiveGrant(fact: AccessGrantFact, at: number): boolean {
  return fact.status === 'active' && activeWindow(fact.startsAt, fact.expiresAt, at);
}

function isActiveRelationship(fact: PropertyRelationshipFact, at: number): boolean {
  return activeWindow(fact.startsAt, fact.endsAt, at);
}

function isActivePortfolioProperty(fact: PortfolioPropertyFact, at: number): boolean {
  return activeWindow(fact.assignedAt, fact.removedAt, at);
}

function relationshipForProperty(
  facts: AccessFacts,
  organizationId: string,
  propertyId: string,
  at: number,
): PropertyRelationshipFact[] {
  return facts.propertyRelationships.filter(
    (relationship) => relationship.organizationId === organizationId
      && relationship.propertyId === propertyId
      && isActiveRelationship(relationship, at),
  );
}

function grantReachesProperty(
  grant: AccessGrantFact,
  propertyId: string,
  facts: AccessFacts,
  at: number,
): boolean {
  const relationships = relationshipForProperty(facts, grant.organizationId, propertyId, at);
  if (relationships.length === 0) return false;

  if (grant.scopeType === 'organization') return true;

  if (grant.scopeType === 'property') {
    return grant.propertyId === propertyId
      && relationships.some((relationship) => relationship.id === grant.propertyRelationshipId);
  }

  if (!grant.portfolioId) return false;
  const portfolio = facts.portfolios.find(
    (candidate) => candidate.id === grant.portfolioId
      && candidate.organizationId === grant.organizationId
      && candidate.status === 'active',
  );
  if (!portfolio) return false;

  return facts.portfolioProperties.some(
    (assignment) => assignment.organizationId === grant.organizationId
      && assignment.portfolioId === grant.portfolioId
      && assignment.propertyId === propertyId
      && isActivePortfolioProperty(assignment, at)
      && relationships.some(
        (relationship) => relationship.id === assignment.propertyRelationshipId,
      ),
  );
}

function receiptReason(grant: AccessGrantFact): string {
  if (grant.scopeType === 'organization') return 'Inherited from organization access';
  if (grant.scopeType === 'portfolio') return 'Inherited from portfolio access';
  return 'Granted directly for this hotel';
}

/**
 * Resolve customer access to one property. This never treats a Staxis admin as
 * an organization member; internal support/admin authorization is a separate
 * gate. Hotel capability overrides are intentionally applied by the existing
 * capability resolver after this organization/scope decision.
 */
export function resolvePropertyAccess(
  accountId: string,
  propertyId: string,
  facts: AccessFacts,
  atValue: string | Date = new Date(),
): ResolvedPropertyAccess {
  const at = asMillis(atValue);
  const organizationById = new Map(facts.organizations.map((org) => [org.id, org]));
  const memberships = facts.memberships.filter(
    (membership) => membership.accountId === accountId
      && isActiveMembership(membership, at)
      && isActiveOrganization(organizationById.get(membership.organizationId)),
  );
  if (memberships.length === 0) {
    return {
      allowed: false,
      propertyId,
      profiles: [],
      capabilities: [],
      receipts: [],
      denialReason: 'no_active_membership',
    };
  }

  const membershipById = new Map(memberships.map((membership) => [membership.id, membership]));
  const activeRelationshipExists = memberships.some((membership) =>
    relationshipForProperty(facts, membership.organizationId, propertyId, at).length > 0,
  );
  if (!activeRelationshipExists) {
    return {
      allowed: false,
      propertyId,
      profiles: [],
      capabilities: [],
      receipts: [],
      denialReason: 'no_active_relationship',
    };
  }

  const matchingGrants = facts.grants.filter((grant) => {
    const membership = membershipById.get(grant.membershipId);
    return !!membership
      && membership.organizationId === grant.organizationId
      && isActiveGrant(grant, at)
      && grantReachesProperty(grant, propertyId, facts, at);
  });
  if (matchingGrants.length === 0) {
    return {
      allowed: false,
      propertyId,
      profiles: [],
      capabilities: [],
      receipts: [],
      denialReason: 'no_matching_active_grant',
    };
  }

  const profiles = [...new Set(matchingGrants.map((grant) => grant.accessProfile))];
  const capabilities = [...new Set(
    profiles.flatMap((profile) => ACCESS_PROFILE_CAPABILITIES[profile]),
  )];
  const receipts = matchingGrants.map<AccessReceipt>((grant) => ({
    grantId: grant.id,
    membershipId: grant.membershipId,
    organizationId: grant.organizationId,
    propertyId,
    accessProfile: grant.accessProfile,
    scopeType: grant.scopeType,
    source: grant.source,
    expiresAt: grant.expiresAt ?? null,
    reason: receiptReason(grant),
  }));

  return { allowed: true, propertyId, profiles, capabilities, receipts };
}

function validRequestedScope(request: DelegationRequest, facts: AccessFacts, at: number): boolean {
  if (
    ((request.requestedProfile === 'organization_owner'
      || request.requestedProfile === 'organization_admin')
      && request.requestedScopeType !== 'organization')
    || (request.requestedProfile === 'portfolio_manager'
      && request.requestedScopeType !== 'portfolio')
    || (request.requestedProfile === 'property_manager'
      && request.requestedScopeType !== 'property')
  ) {
    return false;
  }

  if (request.requestedScopeType === 'organization') {
    return !request.requestedPortfolioId && !request.requestedPropertyId;
  }
  if (request.requestedScopeType === 'portfolio') {
    return !!request.requestedPortfolioId
      && !request.requestedPropertyId
      && facts.portfolios.some(
        (portfolio) => portfolio.id === request.requestedPortfolioId
          && portfolio.organizationId === request.organizationId
          && portfolio.status === 'active',
      );
  }
  return !!request.requestedPropertyId
    && !request.requestedPortfolioId
    && relationshipForProperty(
      facts,
      request.organizationId,
      request.requestedPropertyId,
      at,
    ).length > 0;
}

function scopeContains(
  grant: AccessGrantFact,
  request: DelegationRequest,
  facts: AccessFacts,
  at: number,
): boolean {
  if (grant.scopeType === 'organization') return true;
  if (request.requestedScopeType === 'organization') return false;

  if (grant.scopeType === 'property') {
    return request.requestedScopeType === 'property'
      && grant.propertyId === request.requestedPropertyId
      && !!request.requestedPropertyId
      && grantReachesProperty(grant, request.requestedPropertyId, facts, at);
  }

  if (request.requestedScopeType === 'portfolio') {
    return grant.portfolioId === request.requestedPortfolioId;
  }
  if (!request.requestedPropertyId || !grant.portfolioId) return false;
  return facts.portfolioProperties.some(
    (assignment) => assignment.organizationId === grant.organizationId
      && assignment.portfolioId === grant.portfolioId
      && assignment.propertyId === request.requestedPropertyId
      && isActivePortfolioProperty(assignment, at),
  ) && grantReachesProperty(grant, request.requestedPropertyId, facts, at);
}

/** A grantor can only delegate a lower/equal permitted profile inside a scope
 * already contained by one of their own currently effective grants. */
export function canDelegateAccess(
  request: DelegationRequest,
  facts: AccessFacts,
): DelegationDecision {
  const at = asMillis(request.at ?? new Date());
  if (!validRequestedScope(request, facts, at)) {
    return { allowed: false, reason: 'invalid_requested_scope' };
  }

  const organization = facts.organizations.find((org) => org.id === request.organizationId);
  const memberships = facts.memberships.filter(
    (membership) => membership.accountId === request.actorAccountId
      && membership.organizationId === request.organizationId
      && isActiveMembership(membership, at)
      && isActiveOrganization(organization),
  );
  if (memberships.length === 0) {
    return { allowed: false, reason: 'no_active_membership' };
  }

  const membershipIds = new Set(memberships.map((membership) => membership.id));
  const activeGrants = facts.grants.filter(
    (grant) => membershipIds.has(grant.membershipId)
      && grant.organizationId === request.organizationId
      && isActiveGrant(grant, at),
  );
  const profileGrants = activeGrants.filter((grant) =>
    DELEGATABLE_PROFILES[grant.accessProfile].includes(request.requestedProfile),
  );
  if (profileGrants.length === 0) {
    return { allowed: false, reason: 'profile_not_delegatable' };
  }

  const authorizingGrant = profileGrants.find((grant) =>
    scopeContains(grant, request, facts, at),
  );
  if (!authorizingGrant) {
    return { allowed: false, reason: 'scope_not_contained' };
  }

  return {
    allowed: true,
    reason: 'allowed',
    authorizingGrantId: authorizingGrant.id,
  };
}
