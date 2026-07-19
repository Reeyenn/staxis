// GET /api/company-access
//
// Customer-safe projection of organizations, portfolios, people, and effective
// access. The caller supplies no account or organization selector: identity is
// resolved from the verified session, then every returned row is derived from
// that account's memberships and contained grants.
//
// @tenant-scope authenticated account -> organization_memberships.account_id;
// no query/body tenant identifiers are accepted by this read route.

import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import {
  ACCESS_PROFILES,
  ACCESS_PROFILE_CAPABILITIES,
  canDelegateAccess,
  type AccessFacts,
  type AccessGrantFact,
  type AccessProfile,
  type OrganizationCapability,
} from '@/lib/organization-access';
import {
  activeGrantsForActor,
  activeMembershipsForActor,
  isOrganizationSchemaMissing,
  loadOrganizationActor,
} from '@/lib/organization-access/server';
import {
  type CompanyProjectionPage,
  IncompleteCompanyProjectionError,
  readCompleteCompanyIdChunks,
  readCompleteCompanyPages,
} from '@/lib/company-access/projection-query';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  legacyAccessProfile,
  type CompanyAccessData,
  type CompanyAccessPermissions,
  type CompanyActivityEvent,
  type CompanyDelegationPolicy,
  type CompanyInvitation,
  type CompanyManagedGrant,
  type CompanyMembership,
  type CompanyOrganization,
  type CompanyPortfolio,
  type CompanyProperty,
  type EffectiveAccessReceipt,
} from '@/lib/company-access/dto';
import type { AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COMPANY_PROJECTION_PAGE_SIZE = 100;

interface AccountRow {
  id: string;
  display_name: string | null;
  role: AppRole;
  property_access: string[] | null;
  active: boolean;
}

interface OrganizationRow {
  id: string;
  name: string;
  organization_type: CompanyOrganization['type'];
  status: CompanyOrganization['status'];
  legacy_property_id: string | null;
}

interface RelationshipRow {
  id: string;
  organization_id: string;
  property_id: string;
  relationship_type: string;
  is_primary_grouping: boolean;
  starts_at: string;
  ends_at: string | null;
}

interface PortfolioRow {
  id: string;
  organization_id: string;
  parent_id: string | null;
  name: string;
  status: string;
}

interface PortfolioPropertyRow {
  id: string;
  organization_id: string;
  portfolio_id: string;
  property_id: string;
  property_relationship_id: string;
  assigned_at: string;
  removed_at: string | null;
}

interface PropertyRow {
  id: string;
  name: string | null;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  account_id: string;
  job_category: string | null;
  job_title: string | null;
  status: string;
  starts_at: string;
  ended_at: string | null;
}

interface GrantRow {
  id: string;
  organization_id: string;
  membership_id: string;
  access_profile: AccessProfile;
  scope_type: EffectiveAccessReceipt['scopeType'];
  portfolio_id: string | null;
  property_relationship_id: string | null;
  property_id: string | null;
  source: string;
  status: string;
  starts_at: string;
  expires_at: string | null;
  granted_by_account_id: string | null;
}

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  access_profile: AccessProfile;
  scope_type: EffectiveAccessReceipt['scopeType'];
  portfolio_id: string | null;
  property_id: string | null;
  status: string;
  expires_at: string;
  invited_by_account_id: string | null;
  created_at: string;
}

interface RequestRow {
  id: string;
  organization_id: string;
  membership_id: string;
  requested_access_profile: AccessProfile;
  scope_type: EffectiveAccessReceipt['scopeType'];
  portfolio_id: string | null;
  property_id: string | null;
  reason: string;
  status: string;
  requested_at: string;
  reviewed_by_account_id: string | null;
}

interface EventRow {
  id: string;
  organization_id: string | null;
  actor_account_id: string | null;
  actor_kind: 'account' | 'staxis_admin' | 'support_session' | 'system' | string;
  event_type: string;
  target_type: string;
  target_id: string | null;
  occurred_at: string;
  actor_display_name: string | null;
  actor_role: string | null;
  full_organization_scope?: boolean;
  authorized_property_ids?: string[];
}

interface CompanyAccessFeed {
  invitations: InvitationRow[];
  requests: RequestRow[];
  activity: EventRow[];
}

interface NormalizedOrganizationData {
  facts: AccessFacts;
  organization: OrganizationRow;
  memberships: MembershipRow[];
  grants: GrantRow[];
  relationships: RelationshipRow[];
  portfolios: PortfolioRow[];
  portfolioProperties: PortfolioPropertyRow[];
  actorGrants: AccessGrantFact[];
  actorPropertyIds: Set<string>;
  actorCapabilities: Set<OrganizationCapability>;
}

function activeWindow(startsAt: string, endsAt: string | null | undefined, nowMs: number): boolean {
  const startMs = new Date(startsAt).getTime();
  const endMs = endsAt ? new Date(endsAt).getTime() : null;
  return Number.isFinite(startMs) && startMs <= nowMs && (endMs === null || (Number.isFinite(endMs) && endMs > nowMs));
}

function missingSchemaError(error: unknown): boolean {
  if (isOrganizationSchemaMissing(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: string; message?: string };
  return record.code === '42P01'
    || record.code === '42883'
    || record.code === 'PGRST202'
    || record.code === 'PGRST205'
    || /relation .* does not exist|function .* does not exist|schema cache/i.test(record.message ?? '');
}

class StaleCompanyProjectionError extends Error {
  constructor() {
    super('Organization access changed while the Company Hub projection was loading');
    this.name = 'StaleCompanyProjectionError';
  }
}

function parseCompanyAccessFeed(value: unknown): CompanyAccessFeed {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    invitations: Array.isArray(record.invitations) ? record.invitations as InvitationRow[] : [],
    requests: Array.isArray(record.requests) ? record.requests as RequestRow[] : [],
    activity: Array.isArray(record.activity) ? record.activity as EventRow[] : [],
  };
}

async function loadAccessEpochs(organizationIds: string[]): Promise<Map<string, number>> {
  const rows = await readCompleteCompanyIdChunks<{ organization_id: string; version: number }>(
    organizationIds,
    (chunk, from, to) => supabaseAdmin.from('organization_access_epochs')
      .select('organization_id, version', { count: 'exact' })
      .in('organization_id', [...chunk])
      .order('organization_id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<{ organization_id: string; version: number }>>,
  );
  return new Map(rows.map((row) => [
    row.organization_id,
    Number(row.version),
  ]));
}

function rowsByOrganization<T extends { organization_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const existing = result.get(row.organization_id);
    if (existing) existing.push(row);
    else result.set(row.organization_id, [row]);
  }
  return result;
}

function epochsMatch(
  organizationIds: string[],
  before: Map<string, number>,
  after: Map<string, number>,
): boolean {
  return organizationIds.every((organizationId) => (
    before.has(organizationId)
    && after.has(organizationId)
    && before.get(organizationId) === after.get(organizationId)
  ));
}

function profileRank(profile: AccessProfile): number {
  return [
    'organization_owner',
    'organization_admin',
    'portfolio_manager',
    'property_manager',
    'department_lead',
    'contributor',
    'viewer',
    'external_collaborator',
  ].indexOf(profile);
}

function grantPropertyIds(grant: AccessGrantFact, facts: AccessFacts, nowMs: number): string[] {
  const activeRelationships = facts.propertyRelationships.filter((relationship) => (
    relationship.organizationId === grant.organizationId
    && activeWindow(String(relationship.startsAt), relationship.endsAt ? String(relationship.endsAt) : null, nowMs)
  ));
  if (grant.scopeType === 'organization') return activeRelationships.map((relationship) => relationship.propertyId);
  if (grant.scopeType === 'property') {
    return activeRelationships.some((relationship) => relationship.id === grant.propertyRelationshipId && relationship.propertyId === grant.propertyId)
      && grant.propertyId ? [grant.propertyId] : [];
  }
  if (!grant.portfolioId) return [];
  const activePortfolio = facts.portfolios.some((portfolio) => (
    portfolio.id === grant.portfolioId
    && portfolio.organizationId === grant.organizationId
    && portfolio.status === 'active'
  ));
  if (!activePortfolio) return [];
  const activeRelationshipIds = new Set(activeRelationships.map((relationship) => relationship.id));
  return facts.portfolioProperties.filter((assignment) => (
    assignment.organizationId === grant.organizationId
    && assignment.portfolioId === grant.portfolioId
    && activeRelationshipIds.has(assignment.propertyRelationshipId)
    && activeWindow(String(assignment.assignedAt), assignment.removedAt ? String(assignment.removedAt) : null, nowMs)
  )).map((assignment) => assignment.propertyId);
}

/** True only when grants carrying one capability contain the complete target
 * grant. A partial property overlap must not reveal a portfolio/org profile. */
function capabilityScopeContainsGrant(
  capabilityGrants: AccessGrantFact[],
  targetGrant: AccessGrantFact,
  facts: AccessFacts,
  nowMs: number,
): boolean {
  if (capabilityGrants.some((grant) => grant.scopeType === 'organization')) return true;
  if (targetGrant.scopeType === 'organization') return false;
  const visiblePropertyIds = new Set(capabilityGrants.flatMap((grant) => (
    grantPropertyIds(grant, facts, nowMs)
  )));
  const targetPropertyIds = grantPropertyIds(targetGrant, facts, nowMs);
  return targetPropertyIds.length > 0
    && targetPropertyIds.every((propertyId) => visiblePropertyIds.has(propertyId));
}

function scopeLabel(
  grant: Pick<GrantRow, 'scope_type' | 'portfolio_id' | 'property_id' | 'organization_id'>,
  organizationNames: Map<string, string>,
  portfolioNames: Map<string, string>,
  propertyNames: Map<string, string>,
): string {
  if (grant.scope_type === 'organization') return organizationNames.get(grant.organization_id) ?? 'Organization';
  if (grant.scope_type === 'portfolio') return portfolioNames.get(grant.portfolio_id ?? '') ?? 'Portfolio';
  return propertyNames.get(grant.property_id ?? '') ?? 'Hotel';
}

function eventSummary(eventType: string): string {
  const labels: Record<string, string> = {
    'organization_memberships.insert': 'A company membership was added',
    'organization_memberships.update': 'A company membership was updated',
    'organization_membership.suspended': 'A company member was suspended',
    'organization_membership.resumed': 'A company member was resumed',
    'organization_membership.removed': 'A company member was removed',
    'organization_access_grants.insert': 'Access was granted',
    'organization_access_grants.update': 'An access grant was updated',
    'organization_invitations.insert': 'An invitation was created',
    'organization_invitations.update': 'An invitation was updated',
    'organization_invitation.cancelled': 'An invitation was cancelled',
    'organization_access_requests.insert': 'Access was requested',
    'organization_access_requests.update': 'An access request was reviewed',
    'organization_property_relationships.insert': 'A hotel was connected to the organization',
    'organization_property_relationships.update': 'A hotel relationship was updated',
    'portfolio_properties.insert': 'A hotel was added to a portfolio',
    'portfolio_properties.update': 'A portfolio assignment was updated',
  };
  return labels[eventType] ?? 'Company access was updated';
}

async function legacyProjection(account: AccountRow): Promise<CompanyAccessData> {
  const access = account.property_access ?? [];
  if (account.role !== 'admin' && !access.includes('*')) {
    if (access.length === 0) {
      return {
        organizations: [], portfolios: [], properties: [], invitations: [], requests: [], activity: [],
        memberships: [], effectiveAccess: [], legacyFallback: true,
        permissions: legacyPermissions(account.role),
      };
    }
  }
  const properties = account.role !== 'admin' && !access.includes('*')
    ? await readCompleteCompanyIdChunks<PropertyRow>(access, (chunk, from, to) => (
        supabaseAdmin.from('properties')
          .select('id, name', { count: 'exact' })
          .in('id', [...chunk])
          .order('id')
          .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PropertyRow>>
      ))
    : await readCompleteCompanyPages<PropertyRow>((from, to) => (
        supabaseAdmin.from('properties')
          .select('id, name', { count: 'exact' })
          .order('id')
          .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PropertyRow>>
      ));
  const organizations: CompanyOrganization[] = properties.map((property) => ({
    id: `legacy-${property.id}`,
    name: property.name ?? 'Hotel',
    type: 'single_hotel',
    status: 'active',
    relationshipType: 'independent hotel',
    legacyPropertyId: property.id,
  }));
  const companyProperties: CompanyProperty[] = properties.map((property) => ({
    nodeId: `legacy-${property.id}:${property.id}`,
    id: property.id,
    name: property.name ?? 'Hotel',
    organizationId: `legacy-${property.id}`,
    portfolioIds: [],
    relationshipType: 'property access',
    status: 'active',
  }));
  const profile = legacyAccessProfile(account.role);
  return {
    organizations,
    portfolios: [],
    properties: companyProperties,
    memberships: properties.map((property) => ({
      id: `legacy-membership-${property.id}`,
      organizationId: `legacy-${property.id}`,
      accountId: account.id,
      displayName: account.display_name ?? 'User',
      accessProfile: profile,
      status: 'active',
      propertyIds: [property.id],
      isCurrentUser: true,
      grants: [],
      canSuspend: false,
      canResume: false,
      canRemove: false,
    })),
    effectiveAccess: properties.length > 0 ? [{
      id: 'legacy-effective-access',
      organizationId: properties.length === 1 ? `legacy-${properties[0].id}` : null,
      accessProfile: profile,
      scopeType: 'property',
      scopeLabel: properties.length === 1 ? (properties[0].name ?? 'Hotel') : `${properties.length} assigned hotels`,
      propertyIds: properties.map((property) => property.id),
      source: 'legacy_backfill',
      status: 'active',
    }] : [],
    invitations: [],
    requests: [],
    activity: [],
    permissions: legacyPermissions(account.role),
    legacyFallback: true,
  };
}

function legacyPermissions(role: AppRole): CompanyAccessPermissions {
  const manager = role === 'owner' || role === 'general_manager' || role === 'admin';
  return {
    viewHotels: true,
    viewPeople: manager,
    managePeople: manager,
    manageInvitations: manager,
    viewAccess: true,
    manageAccess: role === 'owner' || role === 'admin',
    viewActivity: manager,
    requestAccess: false,
    availableProfiles: role === 'admin'
      ? ['organization_owner', 'organization_admin', 'portfolio_manager', 'property_manager', 'department_lead', 'contributor', 'viewer', 'external_collaborator']
      : role === 'owner'
        ? ['property_manager', 'department_lead', 'contributor', 'viewer', 'external_collaborator']
        : role === 'general_manager'
          ? ['department_lead', 'contributor', 'viewer', 'external_collaborator']
          : [],
    delegationPolicies: [],
  };
}

async function normalizedProjection(actorAccountId: string): Promise<CompanyAccessData | null> {
  const ownMembershipRows = await readCompleteCompanyPages<MembershipRow>((from, to) => (
    supabaseAdmin.from('organization_memberships')
      .select('id, organization_id, account_id, job_category, job_title, status, starts_at, ended_at', { count: 'exact' })
      .eq('account_id', actorAccountId)
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<MembershipRow>>
  ));
  if (ownMembershipRows.length === 0) return null;

  const organizationIds = [...new Set(ownMembershipRows.map((membership) => membership.organization_id))];
  const startingEpochs = await loadAccessEpochs(organizationIds);
  const [organizationRows, membershipRows, grantRows, relationshipRows, portfolioRows, assignmentRows] = await Promise.all([
    readCompleteCompanyIdChunks<OrganizationRow>(organizationIds, (chunk, from, to) => (
      supabaseAdmin.from('organizations')
        .select('id, name, organization_type, status, legacy_property_id', { count: 'exact' })
        .in('id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationRow>>
    )),
    readCompleteCompanyIdChunks<MembershipRow>(organizationIds, (chunk, from, to) => (
      supabaseAdmin.from('organization_memberships')
        .select('id, organization_id, account_id, job_category, job_title, status, starts_at, ended_at', { count: 'exact' })
        .in('organization_id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<MembershipRow>>
    )),
    readCompleteCompanyIdChunks<GrantRow>(organizationIds, (chunk, from, to) => (
      supabaseAdmin.from('organization_access_grants')
        .select('id, organization_id, membership_id, access_profile, scope_type, portfolio_id, property_relationship_id, property_id, source, status, starts_at, expires_at, granted_by_account_id', { count: 'exact' })
        .in('organization_id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<GrantRow>>
    )),
    readCompleteCompanyIdChunks<RelationshipRow>(organizationIds, (chunk, from, to) => (
      supabaseAdmin.from('organization_property_relationships')
        .select('id, organization_id, property_id, relationship_type, is_primary_grouping, starts_at, ends_at', { count: 'exact' })
        .in('organization_id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<RelationshipRow>>
    )),
    readCompleteCompanyIdChunks<PortfolioRow>(organizationIds, (chunk, from, to) => (
      supabaseAdmin.from('portfolios')
        .select('id, organization_id, parent_id, name, status', { count: 'exact' })
        .in('organization_id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PortfolioRow>>
    )),
    readCompleteCompanyIdChunks<PortfolioPropertyRow>(organizationIds, (chunk, from, to) => (
      supabaseAdmin.from('portfolio_properties')
        .select('id, organization_id, portfolio_id, property_id, property_relationship_id, assigned_at, removed_at', { count: 'exact' })
        .in('organization_id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PortfolioPropertyRow>>
    )),
  ]);
  const membershipAccountIds = [...new Set(membershipRows.map((membership) => membership.account_id))];
  const membershipAccountRows = await readCompleteCompanyIdChunks<{ id: string; active: boolean }>(
    membershipAccountIds,
    (chunk, from, to) => supabaseAdmin.from('accounts')
      .select('id, active', { count: 'exact' })
      .in('id', [...chunk])
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<{ id: string; active: boolean }>>,
  );
  const membershipAccountActive = new Map(membershipAccountRows.map((account) => [
    account.id,
    account.active === true,
  ]));
  const organizationById = new Map(organizationRows.map((organization) => [organization.id, organization]));
  const membershipsByOrganization = rowsByOrganization(membershipRows);
  const grantsByOrganization = rowsByOrganization(grantRows);
  const relationshipsByOrganization = rowsByOrganization(relationshipRows);
  const portfoliosByOrganization = rowsByOrganization(portfolioRows);
  const assignmentsByOrganization = rowsByOrganization(assignmentRows);
  const projectionAt = new Date();
  const projectionAtMs = projectionAt.getTime();

  const normalized = organizationIds.map((organizationId): NormalizedOrganizationData | null => {
    const organization = organizationById.get(organizationId);
    if (!organization) return null;
    const memberships = membershipsByOrganization.get(organizationId) ?? [];
    const grants = grantsByOrganization.get(organizationId) ?? [];
    const relationships = relationshipsByOrganization.get(organizationId) ?? [];
    const portfolios = portfoliosByOrganization.get(organizationId) ?? [];
    const portfolioProperties = assignmentsByOrganization.get(organizationId) ?? [];
    const facts: AccessFacts = {
      organizations: [{ id: organization.id, status: organization.status }],
      memberships: memberships.map((membership) => ({
        id: membership.id,
        organizationId: membership.organization_id,
        accountId: membership.account_id,
        status: membership.status,
        startsAt: membership.starts_at,
        endedAt: membership.ended_at,
        accountActive: membershipAccountActive.get(membership.account_id) === true,
      })),
      grants: grants.map((grant) => ({
        id: grant.id,
        organizationId: grant.organization_id,
        membershipId: grant.membership_id,
        accessProfile: grant.access_profile,
        scopeType: grant.scope_type,
        portfolioId: grant.portfolio_id,
        propertyRelationshipId: grant.property_relationship_id,
        propertyId: grant.property_id,
        status: grant.status,
        source: grant.source,
        startsAt: grant.starts_at,
        expiresAt: grant.expires_at,
      })),
      propertyRelationships: relationships.map((relationship) => ({
        id: relationship.id,
        organizationId: relationship.organization_id,
        propertyId: relationship.property_id,
        startsAt: relationship.starts_at,
        endsAt: relationship.ends_at,
      })),
      portfolios: portfolios.map((portfolio) => ({
        id: portfolio.id,
        organizationId: portfolio.organization_id,
        status: portfolio.status,
      })),
      portfolioProperties: portfolioProperties.map((assignment) => ({
        organizationId: assignment.organization_id,
        portfolioId: assignment.portfolio_id,
        propertyRelationshipId: assignment.property_relationship_id,
        propertyId: assignment.property_id,
        assignedAt: assignment.assigned_at,
        removedAt: assignment.removed_at,
      })),
    };
    const actorMemberships = activeMembershipsForActor(facts, actorAccountId, organizationId, projectionAt);
    if (actorMemberships.length === 0) return null;
    const actorGrants = activeGrantsForActor(facts, actorAccountId, organizationId, projectionAt);
    const actorPropertyIds = new Set(actorGrants.flatMap((grant) => grantPropertyIds(grant, facts, projectionAtMs)));
    const actorCapabilities = new Set<OrganizationCapability>(
      actorGrants.flatMap((grant) => ACCESS_PROFILE_CAPABILITIES[grant.accessProfile]),
    );
    return {
      facts,
      organization,
      memberships,
      grants,
      relationships,
      portfolios,
      portfolioProperties,
      actorGrants,
      actorPropertyIds,
      actorCapabilities,
    };
  });
  const membershipOrganizationsData = normalized.filter((item): item is NormalizedOrganizationData => item !== null);
  if (membershipOrganizationsData.length === 0) return null;
  // Membership alone is enough to submit an access request, but never enough
  // to enumerate company structure. Full projection requires an active grant
  // that actually carries view_company.
  const organizationsData = membershipOrganizationsData.filter((item) => (
    item.actorCapabilities.has('view_company')
  ));

  const nowMs = Date.now();
  const organizationNames = new Map(membershipOrganizationsData.map((item) => [item.organization.id, item.organization.name]));
  const activeRelationshipRows = organizationsData.flatMap((item) => item.relationships.filter((relationship) => (
    activeWindow(relationship.starts_at, relationship.ends_at, nowMs)
    && item.actorPropertyIds.has(relationship.property_id)
  )));
  const chosenRelationshipByOrganizationProperty = new Map<string, RelationshipRow>();
  for (const relationship of activeRelationshipRows) {
    const key = `${relationship.organization_id}:${relationship.property_id}`;
    const existing = chosenRelationshipByOrganizationProperty.get(key);
    if (!existing || relationship.is_primary_grouping) {
      chosenRelationshipByOrganizationProperty.set(key, relationship);
    }
  }
  // The hidden single-hotel anchor is a compatibility detail. Once the caller
  // can see the same hotel through a real company relationship, do not render
  // a second misleading "Independent" copy. Real owner/operator/brand
  // relationships remain separate nodes keyed by organization + hotel.
  const displayRelationshipRows = [...chosenRelationshipByOrganizationProperty.values()].filter((relationship) => {
    const item = organizationsData.find((candidate) => candidate.organization.id === relationship.organization_id);
    if (item?.organization.organization_type !== 'single_hotel') return true;
    return ![...chosenRelationshipByOrganizationProperty.values()].some((candidate) => {
      if (candidate.property_id !== relationship.property_id || candidate.organization_id === relationship.organization_id) return false;
      return organizationsData.find((entry) => entry.organization.id === candidate.organization_id)
        ?.organization.organization_type !== 'single_hotel';
    });
  });
  const effectivePropertyIds = [...new Set(displayRelationshipRows.map((relationship) => relationship.property_id))];

  const propertyRows = await readCompleteCompanyIdChunks<PropertyRow>(
    effectivePropertyIds,
    (chunk, from, to) => supabaseAdmin.from('properties')
      .select('id, name', { count: 'exact' })
      .in('id', [...chunk])
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PropertyRow>>,
  );
  const propertyNames = new Map(propertyRows.map((property) => [property.id, property.name ?? 'Hotel']));

  const activePortfolioRows = organizationsData.flatMap((item) => {
    const companyGrants = item.actorGrants.filter((grant) => (
      ACCESS_PROFILE_CAPABILITIES[grant.accessProfile].includes('view_company')
    ));
    const canViewAllPortfolios = companyGrants.some((grant) => grant.scopeType === 'organization');
    const visiblePortfolioIds = new Set(companyGrants
      .filter((grant) => grant.scopeType === 'portfolio' && grant.portfolioId)
      .map((grant) => grant.portfolioId as string));
    return item.portfolios.filter((portfolio) => (
      portfolio.status === 'active'
      && (canViewAllPortfolios || visiblePortfolioIds.has(portfolio.id))
    ));
  });
  const portfolioNames = new Map(activePortfolioRows.map((portfolio) => [portfolio.id, portfolio.name]));
  const visiblePortfolioIds = new Set(activePortfolioRows.map((portfolio) => portfolio.id));
  const activeAssignmentRows = organizationsData.flatMap((item) => item.portfolioProperties.filter((assignment) => (
    activeWindow(assignment.assigned_at, assignment.removed_at, nowMs)
    && visiblePortfolioIds.has(assignment.portfolio_id)
    && item.actorPropertyIds.has(assignment.property_id)
  )));

  // A grant-less active member receives only this minimal organization target
  // so they can request access; portfolios, hotels, people, and activity below
  // are all derived solely from view_company-capable items.
  const companyOrganizations: CompanyOrganization[] = membershipOrganizationsData.map((item) => {
    const relationshipType = activeRelationshipRows.find((relationship) => relationship.organization_id === item.organization.id)?.relationship_type ?? null;
    return {
      id: item.organization.id,
      name: item.organization.name,
      type: item.organization.organization_type,
      status: item.organization.status,
      relationshipType,
      legacyPropertyId: item.organization.legacy_property_id,
    };
  });

  const companyProperties: CompanyProperty[] = displayRelationshipRows.map((relationship) => {
    const property = propertyRows.find((candidate) => candidate.id === relationship.property_id);
    const organizationId = relationship.organization_id;
    return {
      nodeId: `${organizationId}:${relationship.property_id}`,
      id: relationship.property_id,
      name: property?.name ?? 'Hotel',
      organizationId,
      portfolioIds: activeAssignmentRows.filter((assignment) => (
        assignment.property_id === relationship.property_id && assignment.organization_id === organizationId
      )).map((assignment) => assignment.portfolio_id),
      relationshipType: relationship.relationship_type,
      relationshipId: relationship.id,
      status: 'active',
    };
  });

  const companyPortfolios: CompanyPortfolio[] = activePortfolioRows.map((portfolio) => ({
    id: portfolio.id,
    organizationId: portfolio.organization_id,
    name: portfolio.name,
    parentId: portfolio.parent_id,
    propertyIds: [...new Set(activeAssignmentRows.filter((assignment) => (
      assignment.portfolio_id === portfolio.id
      && displayRelationshipRows.some((relationship) => (
        relationship.organization_id === portfolio.organization_id
        && relationship.property_id === assignment.property_id
      ))
    )).map((assignment) => assignment.property_id))],
  }));

  const visibleMembershipRows: MembershipRow[] = [];
  const visiblePropertyIdsByMembership = new Map<string, string[]>();
  for (const item of organizationsData) {
    const viewPeopleGrants = item.actorGrants.filter((grant) => (
      ACCESS_PROFILE_CAPABILITIES[grant.accessProfile].includes('view_people')
    ));
    const viewPeoplePropertyIds = new Set(viewPeopleGrants.flatMap((grant) => (
      grantPropertyIds(grant, item.facts, nowMs)
    )));
    const actorHasOrganizationPeopleScope = viewPeopleGrants.some((grant) => grant.scopeType === 'organization');
    for (const membership of item.memberships) {
      const isSelf = membership.account_id === actorAccountId;
      const membershipGrantFacts = item.facts.grants.filter((grant) => (
        grant.membershipId === membership.id
        && grant.status === 'active'
        && activeWindow(String(grant.startsAt), grant.expiresAt ? String(grant.expiresAt) : null, nowMs)
      ));
      const targetPropertyIds = [...new Set(membershipGrantFacts.flatMap((grant) => grantPropertyIds(grant, item.facts, nowMs)))];
      const overlapsScope = targetPropertyIds.some((propertyId) => viewPeoplePropertyIds.has(propertyId));
      if (isSelf || actorHasOrganizationPeopleScope || overlapsScope) {
        visibleMembershipRows.push(membership);
        visiblePropertyIdsByMembership.set(
          membership.id,
          isSelf
            ? targetPropertyIds.filter((propertyId) => item.actorPropertyIds.has(propertyId))
            : targetPropertyIds.filter((propertyId) => viewPeoplePropertyIds.has(propertyId)),
        );
      }
    }
  }

  const accountIds = new Set<string>(visibleMembershipRows.map((membership) => membership.account_id));
  organizationsData.forEach((item) => item.grants.forEach((grant) => {
    if (grant.granted_by_account_id) accountIds.add(grant.granted_by_account_id);
  }));
  const accountRows = await readCompleteCompanyIdChunks<{
    id: string;
    display_name: string | null;
    role: string;
    active: boolean;
  }>([...accountIds], (chunk, from, to) => (
    supabaseAdmin.from('accounts')
      .select('id, display_name, role, active', { count: 'exact' })
      .in('id', [...chunk])
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<{
        id: string;
        display_name: string | null;
        role: string;
        active: boolean;
      }>>
  ));
  const accountNames = new Map(accountRows.map((account) => [
    account.id,
    account.role === 'admin' ? 'Staxis' : account.display_name ?? 'User',
  ]));
  const accountStates = new Map(accountRows.map((account) => [account.id, account.active !== false]));

  const companyMemberships: CompanyMembership[] = visibleMembershipRows.map((membership) => {
    const item = organizationsData.find((candidate) => candidate.organization.id === membership.organization_id)!;
    const isSelf = membership.account_id === actorAccountId;
    const memberAccountActive = accountStates.get(membership.account_id) === true;
    const viewAccessGrants = item.actorGrants.filter((grant) => (
      ACCESS_PROFILE_CAPABILITIES[grant.accessProfile].includes('view_access')
    ));
    const visibleGrantFacts = item.facts.grants.filter((grant) => (
      grant.membershipId === membership.id
      && grant.status === 'active'
      && activeWindow(String(grant.startsAt), grant.expiresAt ? String(grant.expiresAt) : null, nowMs)
      && memberAccountActive
      && (isSelf || capabilityScopeContainsGrant(viewAccessGrants, grant, item.facts, nowMs))
    ));
    const profiles = visibleGrantFacts
      .map((grant) => grant.accessProfile)
      .sort((a, b) => profileRank(a) - profileRank(b));
    const actorIsOwner = item.actorGrants.some((grant) => (
      grant.accessProfile === 'organization_owner' && grant.scopeType === 'organization'
    ));
    const actorIsOrganizationAdmin = item.actorGrants.some((grant) => (
      grant.accessProfile === 'organization_admin' && grant.scopeType === 'organization'
    ));
    const targetHasOrganizationLeadership = item.facts.grants.some((grant) => (
      grant.membershipId === membership.id
      && grant.status === 'active'
      && activeWindow(String(grant.startsAt), grant.expiresAt ? String(grant.expiresAt) : null, nowMs)
      && grant.scopeType === 'organization'
      && (grant.accessProfile === 'organization_owner' || grant.accessProfile === 'organization_admin')
    ));
    const canManageMembership = !isSelf
      && item.organization.organization_type !== 'single_hotel'
      && membership.ended_at === null
      && (actorIsOwner || (actorIsOrganizationAdmin && !targetHasOrganizationLeadership));
    const grants: CompanyManagedGrant[] = visibleGrantFacts.map((grant) => {
      const raw = item.grants.find((row) => row.id === grant.id)!;
      return {
        id: raw.id,
        accessProfile: raw.access_profile,
        scopeType: raw.scope_type,
        scopeLabel: scopeLabel(raw, organizationNames, portfolioNames, propertyNames),
        propertyIds: grantPropertyIds(grant, item.facts, nowMs),
        expiresAt: raw.expires_at,
        canRevoke: raw.source !== 'legacy_backfill' && !isSelf && canDelegateAccess({
          actorAccountId,
          organizationId: raw.organization_id,
          requestedProfile: raw.access_profile,
          requestedScopeType: raw.scope_type,
          requestedPortfolioId: raw.portfolio_id,
          requestedPropertyId: raw.property_id,
        }, item.facts).allowed,
      };
    });
    return {
      id: membership.id,
      organizationId: membership.organization_id,
      accountId: membership.account_id,
      displayName: accountNames.get(membership.account_id) ?? 'User',
      jobCategory: membership.job_category,
      jobTitle: membership.job_title,
      accessProfile: profiles[0] ?? null,
      status: membership.status === 'revoked'
        ? 'revoked'
        : !memberAccountActive || membership.status === 'suspended' ? 'suspended' : 'active',
      propertyIds: visiblePropertyIdsByMembership.get(membership.id) ?? [],
      isCurrentUser: isSelf,
      grants,
      canSuspend: canManageMembership && memberAccountActive && membership.status === 'active',
      canResume: canManageMembership && memberAccountActive && membership.status === 'suspended',
      canRemove: canManageMembership && (membership.status === 'active' || membership.status === 'suspended'),
    };
  });

  const receipts: EffectiveAccessReceipt[] = organizationsData.flatMap((item) => item.actorGrants.map((grant) => {
    const raw = item.grants.find((row) => row.id === grant.id)!;
    const expiresAt = raw.expires_at;
    const expiresSoon = expiresAt ? new Date(expiresAt).getTime() - nowMs < 14 * 86_400_000 : false;
    return {
      id: raw.id,
      organizationId: raw.organization_id,
      accessProfile: raw.access_profile,
      scopeType: raw.scope_type,
      scopeId: raw.scope_type === 'portfolio' ? raw.portfolio_id : raw.scope_type === 'property' ? raw.property_id : raw.organization_id,
      scopeLabel: scopeLabel(raw, organizationNames, portfolioNames, propertyNames),
      propertyIds: grantPropertyIds(grant, item.facts, nowMs),
      source: raw.source,
      grantedBy: raw.granted_by_account_id ? accountNames.get(raw.granted_by_account_id) ?? null : null,
      expiresAt,
      reason: raw.scope_type === 'organization'
        ? 'Inherited from organization access'
        : raw.scope_type === 'portfolio'
          ? 'Inherited from portfolio access'
          : 'Granted directly for this hotel',
      jobTitle: ownMembershipRows.find((membership) => membership.organization_id === raw.organization_id)?.job_title ?? null,
      status: expiresSoon ? 'expiring' : 'active',
    };
  }));

  // Delegation authority is deliberately projected per organization. A
  // global union alone would let an owner grant from Org A while viewing
  // viewer-only Org B; each candidate is checked by the same pure resolver
  // used by mutation routes before it reaches the browser.
  const delegationPolicies: CompanyDelegationPolicy[] = organizationsData
    .filter((item) => item.organization.organization_type !== 'single_hotel')
    .map((item) => {
      const organizationId = item.organization.id;
      const activePortfolioIds = item.portfolios
        .filter((portfolio) => portfolio.status === 'active')
        .map((portfolio) => portfolio.id);
      const activePropertyIds = [...new Set(item.relationships.filter((relationship) => (
        activeWindow(relationship.starts_at, relationship.ends_at, nowMs)
      )).map((relationship) => relationship.property_id))];
      const profiles = ACCESS_PROFILES.map((accessProfile) => {
        const organizationScope = canDelegateAccess({
          actorAccountId,
          organizationId,
          requestedProfile: accessProfile,
          requestedScopeType: 'organization',
        }, item.facts).allowed;
        const portfolioIds = activePortfolioIds.filter((portfolioId) => canDelegateAccess({
          actorAccountId,
          organizationId,
          requestedProfile: accessProfile,
          requestedScopeType: 'portfolio',
          requestedPortfolioId: portfolioId,
        }, item.facts).allowed);
        const propertyIds = activePropertyIds.filter((propertyId) => canDelegateAccess({
          actorAccountId,
          organizationId,
          requestedProfile: accessProfile,
          requestedScopeType: 'property',
          requestedPropertyId: propertyId,
        }, item.facts).allowed);
        return { accessProfile, organizationScope, portfolioIds, propertyIds };
      }).filter((profile) => profile.organizationScope || profile.portfolioIds.length > 0 || profile.propertyIds.length > 0);
      return { organizationId, profiles };
    }).filter((policy) => policy.profiles.length > 0);
  const grantableProfiles = [...new Set(delegationPolicies.flatMap((policy) => (
    policy.profiles.map((profile) => profile.accessProfile)
  )))];
  const allCapabilities = new Set(organizationsData.flatMap((item) => [...item.actorCapabilities]));
  const permissions: CompanyAccessPermissions = {
    viewHotels: allCapabilities.has('view_properties'),
    viewPeople: allCapabilities.has('view_people'),
    managePeople: allCapabilities.has('manage_people'),
    manageInvitations: delegationPolicies.length > 0,
    viewAccess: allCapabilities.has('view_access') || receipts.length > 0,
    manageAccess: allCapabilities.has('manage_access'),
    viewActivity: allCapabilities.has('view_activity'),
    requestAccess: membershipOrganizationsData.some((item) => (
      item.organization.organization_type !== 'single_hotel' &&
      activeMembershipsForActor(item.facts, actorAccountId, item.organization.id).length > 0
    )),
    availableProfiles: grantableProfiles,
    delegationPolicies,
  };

  // A single service-role RPC performs tenant/scope filtering and global
  // ordering in PostgreSQL. This keeps Company Hub bounded even for operators
  // with thousands of hotels; the pure resolver post-checks every row below.
  const { data: feedData, error: feedError } = await supabaseAdmin.rpc(
    'staxis_company_access_feed',
    {
      p_actor_account_id: actorAccountId,
      p_limit: COMPANY_PROJECTION_PAGE_SIZE,
    },
  );
  if (feedError) throw feedError;
  const feed = parseCompanyAccessFeed(feedData);
  const visibleInvitations = feed.invitations.filter((invitation) => {
    const item = organizationsData.find((candidate) => candidate.organization.id === invitation.organization_id);
    return !!item && canDelegateAccess({
      actorAccountId,
      organizationId: invitation.organization_id,
      requestedProfile: invitation.access_profile,
      requestedScopeType: invitation.scope_type,
      requestedPortfolioId: invitation.portfolio_id,
      requestedPropertyId: invitation.property_id,
    }, item.facts).allowed;
  }).slice(0, COMPANY_PROJECTION_PAGE_SIZE);
  const invitations: CompanyInvitation[] = visibleInvitations.map((invitation) => ({
    id: invitation.id,
    organizationId: invitation.organization_id,
    email: invitation.email,
    accessProfile: invitation.access_profile,
    scopeLabel: scopeLabel(invitation, organizationNames, portfolioNames, propertyNames),
    propertyIds: invitation.scope_type === 'organization'
      ? organizationsData.find((item) => item.organization.id === invitation.organization_id)?.actorPropertyIds.size
        ? [...organizationsData.find((item) => item.organization.id === invitation.organization_id)!.actorPropertyIds]
        : []
      : invitation.scope_type === 'portfolio'
        ? companyPortfolios.find((portfolio) => portfolio.id === invitation.portfolio_id)?.propertyIds ?? []
        : invitation.property_id ? [invitation.property_id] : [],
    status: new Date(invitation.expires_at).getTime() <= nowMs ? 'expired' : 'pending',
    expiresAt: invitation.expires_at,
    invitedBy: invitation.invited_by_account_id
      ? accountNames.get(invitation.invited_by_account_id) ?? null
      : null,
    canCancel: true,
  }));

  const membershipById = new Map(membershipOrganizationsData.flatMap((item) => item.memberships)
    .map((membership) => [membership.id, membership]));
  const requestCanBeManaged = (request: RequestRow): boolean => {
    const membership = membershipById.get(request.membership_id);
    if (!membership || membership.account_id === actorAccountId) return false;
    const item = organizationsData.find((candidate) => candidate.organization.id === request.organization_id);
    return !!item && item.actorCapabilities.has('manage_access') && canDelegateAccess({
      actorAccountId,
      organizationId: request.organization_id,
      requestedProfile: request.requested_access_profile,
      requestedScopeType: request.scope_type,
      requestedPortfolioId: request.portfolio_id,
      requestedPropertyId: request.property_id,
    }, item.facts).allowed;
  };
  const requestIsOwn = (request: RequestRow): boolean => (
    membershipById.get(request.membership_id)?.account_id === actorAccountId
  );
  const requestRows = feed.requests.filter((request) => (
    requestCanBeManaged(request) || requestIsOwn(request)
  )).slice(0, COMPANY_PROJECTION_PAGE_SIZE);
  const requests = requestRows.map((request) => {
    const membership = membershipById.get(request.membership_id);
    const item = organizationsData.find((candidate) => candidate.organization.id === request.organization_id);
    const requesterIsActor = membership?.account_id === actorAccountId;
    const canReview = request.status === 'pending'
      && !requesterIsActor
      && Boolean(item?.actorCapabilities.has('manage_access'))
      && Boolean(item && canDelegateAccess({
        actorAccountId,
        organizationId: request.organization_id,
        requestedProfile: request.requested_access_profile,
        requestedScopeType: request.scope_type,
        requestedPortfolioId: request.portfolio_id,
        requestedPropertyId: request.property_id,
      }, item.facts).allowed);
    return {
      id: request.id,
      organizationId: request.organization_id,
      requesterName: membership ? accountNames.get(membership.account_id) ?? 'User' : 'User',
      requestedProfile: request.requested_access_profile,
      scopeLabel: scopeLabel({
        organization_id: request.organization_id,
        scope_type: request.scope_type,
        portfolio_id: request.portfolio_id,
        property_id: request.property_id,
      }, organizationNames, portfolioNames, propertyNames),
      propertyIds: request.scope_type === 'organization'
        ? companyProperties.filter((property) => property.organizationId === request.organization_id).map((property) => property.id)
        : request.scope_type === 'portfolio'
          ? companyPortfolios.find((portfolio) => portfolio.id === request.portfolio_id)?.propertyIds ?? []
          : request.property_id ? [request.property_id] : [],
      reason: request.reason,
      status: request.status as 'pending' | 'approved' | 'denied' | 'cancelled',
      createdAt: request.requested_at,
      canReview,
    };
  });

  let activity: CompanyActivityEvent[] = [];
  if (permissions.viewActivity) {
    const allowedTargetIds = new Map<string, Set<string>>();
    const activityPropertyIdsByOrganization = new Map<string, Set<string>>();
    for (const item of organizationsData) {
      const activityGrants = item.actorGrants.filter((grant) => (
        ACCESS_PROFILE_CAPABILITIES[grant.accessProfile].includes('view_activity')
      ));
      const activityPropertyIds = new Set(activityGrants.flatMap((grant) => (
        grantPropertyIds(grant, item.facts, nowMs)
      )));
      activityPropertyIdsByOrganization.set(item.organization.id, activityPropertyIds);
      const allowAll = activityGrants.some((grant) => grant.scopeType === 'organization');
      if (allowAll) {
        allowedTargetIds.set(item.organization.id, new Set(['*']));
        continue;
      }
      const activityPortfolioIds = new Set(activityGrants
        .filter((grant) => grant.scopeType === 'portfolio' && grant.portfolioId)
        .map((grant) => grant.portfolioId as string));
      const ids = new Set<string>();
      item.facts.grants.filter((grant) => (
        grant.status === 'active'
        && activeWindow(String(grant.startsAt), grant.expiresAt ? String(grant.expiresAt) : null, nowMs)
        && grantPropertyIds(grant, item.facts, nowMs).some((propertyId) => activityPropertyIds.has(propertyId))
      )).forEach((grant) => ids.add(grant.id));
      item.relationships.filter((relationship) => activityPropertyIds.has(relationship.property_id)).forEach((relationship) => ids.add(relationship.id));
      item.portfolios.filter((portfolio) => activityPortfolioIds.has(portfolio.id)).forEach((portfolio) => ids.add(portfolio.id));
      item.memberships.filter((membership) => item.facts.grants.some((grant) => (
        grant.membershipId === membership.id
        && grant.status === 'active'
        && activeWindow(String(grant.startsAt), grant.expiresAt ? String(grant.expiresAt) : null, nowMs)
        && grantPropertyIds(grant, item.facts, nowMs).some((propertyId) => activityPropertyIds.has(propertyId))
      ))).forEach((membership) => ids.add(membership.id));
      invitations.filter((invitation) => (
        invitation.organizationId === item.organization.id
        && invitation.propertyIds.some((propertyId) => activityPropertyIds.has(propertyId))
      )).forEach((invitation) => ids.add(invitation.id));
      requests.filter((request) => (
        request.organizationId === item.organization.id
        && request.propertyIds.some((propertyId) => activityPropertyIds.has(propertyId))
      )).forEach((request) => ids.add(request.id));
      allowedTargetIds.set(item.organization.id, ids);
    }
    const eventRows = feed.activity.filter((event) => {
      if (!event.organization_id) return false;
      const allowed = allowedTargetIds.get(event.organization_id);
      if (event.full_organization_scope === true) return allowed?.has('*') === true;
      if (Array.isArray(event.authorized_property_ids)) {
        const actorPropertyIds = activityPropertyIdsByOrganization.get(event.organization_id);
        return event.authorized_property_ids.some((propertyId) => actorPropertyIds?.has(propertyId));
      }
      // Rollout fallback for a server still on the first feed draft.
      return allowed?.has('*') || (!!event.target_id && allowed?.has(event.target_id));
    }).slice(0, COMPANY_PROJECTION_PAGE_SIZE);
    activity = eventRows.map((event) => ({
      id: event.id,
      organizationId: event.organization_id,
      actorName: event.actor_kind === 'staxis_admin'
        ? 'Staxis'
        : event.actor_kind === 'support_session'
          ? 'Staxis support'
          : event.actor_kind === 'account' && event.actor_account_id
            ? event.actor_role === 'admin' ? 'Staxis' : event.actor_display_name ?? 'User'
            : 'Staxis system',
      action: event.event_type,
      summary: eventSummary(event.event_type),
      createdAt: event.occurred_at,
      propertyId: event.target_type === 'properties' ? event.target_id : null,
    }));
  }

  const projection: CompanyAccessData = {
    organizations: companyOrganizations,
    portfolios: companyPortfolios,
    properties: companyProperties,
    memberships: companyMemberships,
    effectiveAccess: receipts,
    invitations,
    requests,
    activity,
    permissions,
    legacyFallback: false,
  };
  const endingEpochs = await loadAccessEpochs(organizationIds);
  if (!epochsMatch(organizationIds, startingEpochs, endingEpochs)) {
    throw new StaleCompanyProjectionError();
  }
  return projection;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  try {
    const actor = await loadOrganizationActor(session.userId, session.email);
    if (!actor) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const { data: accountData, error: accountError } = await supabaseAdmin.from('accounts')
      .select('id, display_name, role, property_access, active')
      .eq('id', actor.accountId)
      .maybeSingle();
    if (accountError) throw accountError;
    if (!accountData) return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    const account = accountData as AccountRow;
    if (account.active !== true) {
      return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    if (account.role === 'admin') {
      return err('Staxis administrators use the Admin Hotels workspace', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const normalized = await normalizedProjection(actor.accountId);
          if (normalized) return ok(normalized, { requestId });
          break;
        } catch (normalizedError) {
          if ((normalizedError instanceof StaleCompanyProjectionError
            || normalizedError instanceof IncompleteCompanyProjectionError) && attempt === 0) continue;
          throw normalizedError;
        }
      }
    } catch (normalizedError) {
      if (!missingSchemaError(normalizedError)) throw normalizedError;
    }

    // The normalized projection deliberately ignores inactive memberships.
    // Re-check the account after the multi-query projection before falling
    // back to legacy property_access so a concurrent deactivation cannot turn
    // an authorization failure into a legacy read.
    const { data: fallbackAccount, error: fallbackAccountError } = await supabaseAdmin
      .from('accounts')
      .select('active')
      .eq('id', account.id)
      .maybeSingle();
    if (fallbackAccountError) throw fallbackAccountError;
    if (fallbackAccount?.active !== true) {
      return err('Account not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    return ok(await legacyProjection(account), { requestId });
  } catch (caught) {
    log.error('[company-access:GET] projection failed', { requestId, error: errToString(caught) });
    return err('Could not load company access', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
