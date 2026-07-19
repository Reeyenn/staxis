import 'server-only';

import {
  type CompanyProjectionPage,
  IncompleteCompanyProjectionError,
  readCompleteCompanyIdChunks,
  readCompleteCompanyPages,
} from '@/lib/company-access/projection-query';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  ACCESS_PROFILE_CAPABILITIES,
  type AccessFacts,
  type AccessGrantFact,
  type AccessProfile,
  type AccessScopeType,
  type MembershipFact,
  type OrganizationCapability,
  type OrganizationFact,
  type PortfolioFact,
  type PortfolioPropertyFact,
  type PropertyRelationshipFact,
} from '@/lib/organization-access';

export interface OrganizationActor {
  accountId: string;
  authUserId: string;
  email: string | null;
  legacyRole: string;
}

export interface OrganizationScopeTarget {
  scopeType: AccessScopeType;
  portfolioId?: string | null;
  propertyId?: string | null;
}

interface QueryError {
  code?: string;
  message: string;
}

interface OrganizationAccessOrganizationRow {
  id: string;
  status: string;
}

interface OrganizationAccessMembershipRow {
  id: string;
  organization_id: string;
  account_id: string;
  status: string;
  starts_at: string;
  ended_at: string | null;
}

interface OrganizationAccessGrantRow {
  id: string;
  organization_id: string;
  membership_id: string;
  access_profile: AccessProfile;
  scope_type: AccessScopeType;
  portfolio_id: string | null;
  property_relationship_id: string | null;
  property_id: string | null;
  status: string;
  source: string;
  starts_at: string;
  expires_at: string | null;
}

interface OrganizationAccessRelationshipRow {
  id: string;
  organization_id: string;
  property_id: string;
  starts_at: string;
  ends_at: string | null;
}

interface OrganizationAccessPortfolioRow {
  id: string;
  organization_id: string;
  status: string;
}

interface OrganizationAccessAssignmentRow {
  id: string;
  organization_id: string;
  portfolio_id: string;
  property_relationship_id: string;
  property_id: string;
  assigned_at: string;
  removed_at: string | null;
}

export class OrganizationAccessStoreError extends Error {
  readonly code?: string;

  constructor(operation: string, error: QueryError) {
    super(`${operation}: ${error.message}`);
    this.name = 'OrganizationAccessStoreError';
    this.code = error.code;
  }
}

async function completeStoreRead<T>(
  operation: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (caught) {
    if (caught instanceof IncompleteCompanyProjectionError) throw caught;
    const error = caught && typeof caught === 'object'
      ? caught as QueryError
      : { message: String(caught) };
    throw new OrganizationAccessStoreError(operation, error);
  }
}

export function isOrganizationSchemaMissing(error: unknown): boolean {
  if (!(error instanceof OrganizationAccessStoreError)) return false;
  return error.code === '42P01'
    || error.code === 'PGRST205'
    || /relation .* does not exist|schema cache/i.test(error.message);
}

function activeWindow(
  startsAt: string | Date,
  endsAt: string | Date | null | undefined,
  atMs: number,
): boolean {
  const startMs = new Date(startsAt).getTime();
  const endMs = endsAt == null ? null : new Date(endsAt).getTime();
  return Number.isFinite(startMs)
    && startMs <= atMs
    && (endMs === null || (Number.isFinite(endMs) && endMs > atMs));
}

export async function loadOrganizationActor(
  authUserId: string,
  email: string | null,
): Promise<OrganizationActor | null> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, data_user_id, role, active')
    .eq('data_user_id', authUserId)
    .maybeSingle();

  if (error) throw new OrganizationAccessStoreError('load organization actor', error);
  if (!data || data.active === false) return null;
  return {
    accountId: data.id as string,
    authUserId: data.data_user_id as string,
    email,
    legacyRole: data.role as string,
  };
}

/** Load one organization's complete authorization fact set. The tables are
 * service-role-only, and callers must authenticate before invoking this. */
export async function loadOrganizationAccessFacts(
  organizationId: string,
): Promise<AccessFacts> {
  const [organizations, memberships, grants, relationships, portfolios, assignments] = await Promise.all([
    completeStoreRead('load organization', () => readCompleteCompanyPages<OrganizationAccessOrganizationRow>((from, to) => (
      supabaseAdmin.from('organizations')
        .select('id, status', { count: 'exact' })
        .eq('id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationAccessOrganizationRow>>
    ))),
    completeStoreRead('load organization memberships', () => readCompleteCompanyPages<OrganizationAccessMembershipRow>((from, to) => (
      supabaseAdmin.from('organization_memberships')
        .select('id, organization_id, account_id, status, starts_at, ended_at', { count: 'exact' })
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationAccessMembershipRow>>
    ))),
    completeStoreRead('load organization grants', () => readCompleteCompanyPages<OrganizationAccessGrantRow>((from, to) => (
      supabaseAdmin.from('organization_access_grants')
        .select('id, organization_id, membership_id, access_profile, scope_type, portfolio_id, property_relationship_id, property_id, status, source, starts_at, expires_at', { count: 'exact' })
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationAccessGrantRow>>
    ))),
    completeStoreRead('load organization hotel relationships', () => readCompleteCompanyPages<OrganizationAccessRelationshipRow>((from, to) => (
      supabaseAdmin.from('organization_property_relationships')
        .select('id, organization_id, property_id, starts_at, ends_at', { count: 'exact' })
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationAccessRelationshipRow>>
    ))),
    completeStoreRead('load organization portfolios', () => readCompleteCompanyPages<OrganizationAccessPortfolioRow>((from, to) => (
      supabaseAdmin.from('portfolios')
        .select('id, organization_id, status', { count: 'exact' })
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationAccessPortfolioRow>>
    ))),
    completeStoreRead('load portfolio hotels', () => readCompleteCompanyPages<OrganizationAccessAssignmentRow>((from, to) => (
      supabaseAdmin.from('portfolio_properties')
        .select('id, organization_id, portfolio_id, property_relationship_id, property_id, assigned_at, removed_at', { count: 'exact' })
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationAccessAssignmentRow>>
    ))),
  ]);

  const membershipAccountIds = [...new Set(memberships.map((row) => row.account_id))];
  const membershipAccounts = await completeStoreRead('load membership account states', () => (
    readCompleteCompanyIdChunks<{ id: string; active: boolean }>(
      membershipAccountIds,
      (chunk, from, to) => supabaseAdmin.from('accounts')
        .select('id, active', { count: 'exact' })
        .in('id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<{ id: string; active: boolean }>>,
    )
  ));
  const accountActive = new Map(membershipAccounts.map((row) => [row.id, row.active === true]));

  const organizationFacts: OrganizationFact[] = organizations[0]
    ? [{ id: organizations[0].id, status: organizations[0].status }]
    : [];
  const membershipFacts: MembershipFact[] = memberships.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    accountId: row.account_id,
    status: row.status,
    startsAt: row.starts_at,
    endedAt: row.ended_at,
    accountActive: accountActive.get(row.account_id) === true,
  }));
  const grantFacts: AccessGrantFact[] = grants.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    membershipId: row.membership_id,
    accessProfile: row.access_profile,
    scopeType: row.scope_type,
    portfolioId: row.portfolio_id,
    propertyRelationshipId: row.property_relationship_id,
    propertyId: row.property_id,
    status: row.status,
    source: row.source,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
  }));
  const relationshipFacts: PropertyRelationshipFact[] = relationships.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  }));
  const portfolioFacts: PortfolioFact[] = portfolios.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    status: row.status,
  }));
  const portfolioPropertyFacts: PortfolioPropertyFact[] = assignments.map((row) => ({
    organizationId: row.organization_id,
    portfolioId: row.portfolio_id,
    propertyRelationshipId: row.property_relationship_id,
    propertyId: row.property_id,
    assignedAt: row.assigned_at,
    removedAt: row.removed_at,
  }));

  return {
    organizations: organizationFacts,
    memberships: membershipFacts,
    grants: grantFacts,
    propertyRelationships: relationshipFacts,
    portfolios: portfolioFacts,
    portfolioProperties: portfolioPropertyFacts,
  };
}

export function activeMembershipsForActor(
  facts: AccessFacts,
  accountId: string,
  organizationId: string,
  at: Date = new Date(),
): MembershipFact[] {
  const atMs = at.getTime();
  const organizationActive = facts.organizations.some(
    (organization) => organization.id === organizationId && organization.status === 'active',
  );
  if (!organizationActive) return [];
  return facts.memberships.filter((membership) => (
    membership.accountId === accountId
      && membership.organizationId === organizationId
      && membership.accountActive !== false
      && membership.status === 'active'
      && activeWindow(membership.startsAt, membership.endedAt, atMs)
  ));
}

export function activeGrantsForActor(
  facts: AccessFacts,
  accountId: string,
  organizationId: string,
  at: Date = new Date(),
): AccessGrantFact[] {
  const atMs = at.getTime();
  const membershipIds = new Set(
    activeMembershipsForActor(facts, accountId, organizationId, at).map((membership) => membership.id),
  );
  return facts.grants.filter((grant) => (
    grant.organizationId === organizationId
      && membershipIds.has(grant.membershipId)
      && grant.status === 'active'
      && activeWindow(grant.startsAt, grant.expiresAt, atMs)
  ));
}

export function actorHasOrganizationCapability(
  facts: AccessFacts,
  accountId: string,
  organizationId: string,
  capability: OrganizationCapability,
  at: Date = new Date(),
): boolean {
  return activeGrantsForActor(facts, accountId, organizationId, at).some((grant) => (
    ACCESS_PROFILE_CAPABILITIES[grant.accessProfile].includes(capability)
  ));
}

export function findActiveMembershipId(
  facts: AccessFacts,
  accountId: string,
  organizationId: string,
  at: Date = new Date(),
): string | null {
  return activeMembershipsForActor(facts, accountId, organizationId, at)[0]?.id ?? null;
}

export function relationshipIdForProperty(
  facts: AccessFacts,
  organizationId: string,
  propertyId: string,
  at: Date = new Date(),
): string | null {
  const atMs = at.getTime();
  return facts.propertyRelationships.find((relationship) => (
    relationship.organizationId === organizationId
      && relationship.propertyId === propertyId
      && activeWindow(relationship.startsAt, relationship.endsAt, atMs)
  ))?.id ?? null;
}
