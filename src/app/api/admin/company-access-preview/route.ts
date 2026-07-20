/**
 * GET /api/admin/company-access-preview?pid=<propertyId>
 *
 * Read-only customer-realm preview for an authenticated Staxis administrator.
 * The selected hotel is only a target selector: the server resolves its current
 * primary real organization (Company Hub) or exact single-hotel context (My
 * Hotel). The administrator never becomes an organization member and this
 * route never returns an effective customer grant or a writable action.
 */

import { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/admin-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import {
  AmbiguousAdminCompanyPreviewTargetError,
  StaleAdminCompanyPreviewError,
  UnavailableAdminCompanyPreviewTargetError,
  adminPreviewWindowIsActive,
  assertExactSingleHotelRelationshipScope,
  makeAdminCompanyAccessReadOnly,
  resolveAdminCompanyPreviewTarget,
  runAdminPreviewReadWithRetry,
  type AdminCompanyAccessPreviewData,
  type AdminCompanyPreviewTarget,
  type AdminPreviewOrganizationTarget,
  type AdminPreviewPrimaryRelationship,
} from '@/lib/company-access/admin-preview';
import { isCompanyAccessUnavailable } from '@/lib/company-access/database-errors';
import {
  IncompleteCompanyProjectionError,
  chunkCompanyProjectionIds,
  readCompleteCompanyPages,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';
import type {
  AccessScopeType,
  CompanyAccessData,
  CompanyAccessRequest,
  CompanyActivityEvent,
  CompanyInvitation,
  CompanyManagedGrant,
  CompanyMembership,
  CompanyOrganization,
  CompanyPortfolio,
  CompanyProperty,
  OrganizationKind,
  OrganizationStatus,
} from '@/lib/company-access/dto';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const FEED_LIMIT = 100;
const ID_CHUNK_CONCURRENCY = 4;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' } as const;

interface PropertyRow {
  id: string;
  name: string | null;
}

interface OrganizationRow {
  id: string;
  name: string;
  organization_type: OrganizationKind;
  status: OrganizationStatus;
  legacy_property_id: string | null;
}

interface RelationshipRow {
  id: string;
  organization_id: string;
  property_id: string;
  relationship_type: string;
  is_primary_grouping: boolean;
  starts_at: string | null;
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
  property_relationship_id: string;
  property_id: string;
  assigned_at: string | null;
  removed_at: string | null;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  account_id: string;
  job_category: string | null;
  job_title: string | null;
  status: string;
  starts_at: string | null;
  ended_at: string | null;
}

interface GrantRow {
  id: string;
  organization_id: string;
  membership_id: string;
  access_profile: string;
  scope_type: AccessScopeType;
  portfolio_id: string | null;
  property_relationship_id: string | null;
  property_id: string | null;
  status: string;
  source: string;
  starts_at: string | null;
  expires_at: string | null;
  granted_by_account_id: string | null;
}

interface AccountRow {
  id: string;
  display_name: string | null;
  role: string;
  active: boolean;
}

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  access_profile: string;
  scope_type: AccessScopeType;
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
  requested_access_profile: string;
  scope_type: AccessScopeType;
  portfolio_id: string | null;
  property_id: string | null;
  reason: string;
  status: string;
  requested_at: string;
}

interface EventRow {
  id: string;
  organization_id: string | null;
  actor_account_id: string | null;
  actor_kind: string;
  event_type: string;
  target_type: string;
  target_id: string | null;
  occurred_at: string;
}

interface EpochRow {
  organization_id: string;
  version: number;
}

class AdminCompanyPreviewPropertyNotFoundError extends Error {
  constructor() {
    super('Hotel not found');
    this.name = 'AdminCompanyPreviewPropertyNotFoundError';
  }
}

/** Preview-only bounded parallelism keeps large company reads within the
 * route budget without sending an unbounded burst to PostgREST. Results stay
 * in deterministic chunk order. */
async function readCompletePreviewIdChunks<T>(
  ids: readonly string[],
  readChunkPage: (
    chunk: readonly string[],
    from: number,
    to: number,
  ) => PromiseLike<CompanyProjectionPage<T>>,
): Promise<T[]> {
  const chunks = chunkCompanyProjectionIds(ids);
  if (chunks.length === 0) return [];

  const results = new Array<T[]>(chunks.length);
  let nextChunkIndex = 0;
  const workerCount = Math.min(ID_CHUNK_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const chunkIndex = nextChunkIndex;
      nextChunkIndex += 1;
      if (chunkIndex >= chunks.length) return;
      const chunk = chunks[chunkIndex];
      results[chunkIndex] = await readCompleteCompanyPages((from, to) => (
        readChunkPage(chunk, from, to)
      ));
    }
  }));
  return results.flat();
}

function organizationTarget(row: OrganizationRow): AdminPreviewOrganizationTarget {
  return {
    id: row.id,
    name: row.name,
    organizationType: row.organization_type,
    status: row.status,
    legacyPropertyId: row.legacy_property_id,
  };
}

function relationshipTarget(row: RelationshipRow): AdminPreviewPrimaryRelationship {
  return {
    id: row.id,
    organizationId: row.organization_id,
    propertyId: row.property_id,
    isPrimaryGrouping: row.is_primary_grouping,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

function targetKey(target: AdminCompanyPreviewTarget): string {
  return target.scope === 'organization'
    ? `organization:${target.organization.id}`
    : `property:${target.property.id}:${target.organization?.id ?? 'none'}`;
}

async function loadPreviewTarget(pid: string): Promise<AdminCompanyPreviewTarget> {
  const { data: propertyData, error: propertyError } = await supabaseAdmin
    .from('properties')
    .select('id, name')
    .eq('id', pid)
    .maybeSingle();
  if (propertyError) throw propertyError;
  if (!propertyData) throw new AdminCompanyPreviewPropertyNotFoundError();
  const property = propertyData as PropertyRow;

  const relationships = await readCompleteCompanyPages<RelationshipRow>((from, to) => (
    supabaseAdmin.from('organization_property_relationships')
      .select('id, organization_id, property_id, relationship_type, is_primary_grouping, starts_at, ends_at', { count: 'exact' })
      .eq('property_id', pid)
      .eq('is_primary_grouping', true)
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<RelationshipRow>>
  ));
  const relationshipOrganizationIds = [...new Set(relationships.map((row) => row.organization_id))];
  const relationshipOrganizations = await readCompletePreviewIdChunks<OrganizationRow>(
    relationshipOrganizationIds,
    (chunk, from, to) => supabaseAdmin.from('organizations')
      .select('id, name, organization_type, status, legacy_property_id', { count: 'exact' })
      .in('id', [...chunk])
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationRow>>,
  );
  const anchors = await readCompleteCompanyPages<OrganizationRow>((from, to) => (
    supabaseAdmin.from('organizations')
      .select('id, name, organization_type, status, legacy_property_id', { count: 'exact' })
      .eq('legacy_property_id', pid)
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationRow>>
  ));
  const organizations = new Map<string, OrganizationRow>();
  for (const row of [...relationshipOrganizations, ...anchors]) organizations.set(row.id, row);

  return resolveAdminCompanyPreviewTarget({
    property: { id: property.id, name: property.name ?? 'Hotel' },
    relationships: relationships.map(relationshipTarget),
    organizations: [...organizations.values()].map(organizationTarget),
  });
}

async function loadEpoch(organizationId: string): Promise<number> {
  const { data, error } = await supabaseAdmin.from('organization_access_epochs')
    .select('organization_id, version')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !Number.isSafeInteger(Number((data as EpochRow).version))) {
    throw new StaleAdminCompanyPreviewError();
  }
  return Number((data as EpochRow).version);
}

function profileRank(profile: string): number {
  const index = [
    'organization_owner',
    'organization_admin',
    'portfolio_manager',
    'property_manager',
    'department_lead',
    'contributor',
    'viewer',
    'external_collaborator',
  ].indexOf(profile);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function scopeLabel(
  row: Pick<GrantRow, 'scope_type' | 'portfolio_id' | 'property_id'>,
  organizationName: string,
  portfolioNames: Map<string, string>,
  propertyNames: Map<string, string>,
): string {
  if (row.scope_type === 'organization') return organizationName;
  if (row.scope_type === 'portfolio') return portfolioNames.get(row.portfolio_id ?? '') ?? 'Portfolio';
  return propertyNames.get(row.property_id ?? '') ?? 'Hotel';
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

async function buildScopedProjection(
  target: AdminCompanyPreviewTarget,
): Promise<CompanyAccessData> {
  const organization = target.organization;
  if (!organization) {
    return {
      organizations: [],
      portfolios: [],
      properties: [{
        nodeId: `independent:${target.property.id}`,
        id: target.property.id,
        name: target.property.name,
        organizationId: null,
        portfolioIds: [],
        relationshipType: 'independent hotel',
        status: 'active',
      }],
      memberships: [],
      effectiveAccess: [],
      invitations: [],
      requests: [],
      activity: [],
      permissions: {
        viewHotels: true,
        viewPeople: true,
        managePeople: false,
        manageInvitations: false,
        viewAccess: true,
        manageAccess: false,
        viewActivity: true,
        requestAccess: false,
        availableProfiles: [],
        delegationPolicies: [],
      },
      legacyFallback: false,
    };
  }

  const organizationId = organization.id;
  const startingEpoch = await loadEpoch(organizationId);
  const [relationshipRows, portfolioRows, assignmentRows, membershipRows, grantRows] = await Promise.all([
    readCompleteCompanyPages<RelationshipRow>((from, to) => (
      supabaseAdmin.from('organization_property_relationships')
        .select('id, organization_id, property_id, relationship_type, is_primary_grouping, starts_at, ends_at', { count: 'exact' })
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<RelationshipRow>>
    )),
    target.scope === 'organization'
      ? readCompleteCompanyPages<PortfolioRow>((from, to) => (
          supabaseAdmin.from('portfolios')
            .select('id, organization_id, parent_id, name, status', { count: 'exact' })
            .eq('organization_id', organizationId)
            .order('id')
            .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PortfolioRow>>
        ))
      : Promise.resolve([] as PortfolioRow[]),
    target.scope === 'organization'
      ? readCompleteCompanyPages<PortfolioPropertyRow>((from, to) => (
          supabaseAdmin.from('portfolio_properties')
            .select('id, organization_id, portfolio_id, property_relationship_id, property_id, assigned_at, removed_at', { count: 'exact' })
            .eq('organization_id', organizationId)
            .order('id')
            .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PortfolioPropertyRow>>
        ))
      : Promise.resolve([] as PortfolioPropertyRow[]),
    readCompleteCompanyPages<MembershipRow>((from, to) => (
      supabaseAdmin.from('organization_memberships')
        .select('id, organization_id, account_id, job_category, job_title, status, starts_at, ended_at', { count: 'exact' })
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<MembershipRow>>
    )),
    readCompleteCompanyPages<GrantRow>((from, to) => (
      supabaseAdmin.from('organization_access_grants')
        .select('id, organization_id, membership_id, access_profile, scope_type, portfolio_id, property_relationship_id, property_id, status, source, starts_at, expires_at, granted_by_account_id', { count: 'exact' })
        .eq('organization_id', organizationId)
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<GrantRow>>
    )),
  ]);

  const now = new Date();
  const nowMs = now.getTime();
  if (target.scope === 'property') {
    assertExactSingleHotelRelationshipScope({
      selectedPropertyId: target.property.id,
      relationships: relationshipRows.map(relationshipTarget),
      now,
    });
  }
  const activeRelationships = relationshipRows.filter((row) => (
    adminPreviewWindowIsActive(row.starts_at, row.ends_at, now)
  ));
  const chosenRelationshipByProperty = new Map<string, RelationshipRow>();
  for (const relationship of activeRelationships) {
    const existing = chosenRelationshipByProperty.get(relationship.property_id);
    if (!existing || relationship.is_primary_grouping) {
      chosenRelationshipByProperty.set(relationship.property_id, relationship);
    }
  }
  const chosenRelationships = [...chosenRelationshipByProperty.values()];
  const activeRelationshipIds = new Set(activeRelationships.map((row) => row.id));
  const propertyIds = [...new Set(chosenRelationships.map((row) => row.property_id))];
  if (target.scope === 'organization' && !propertyIds.includes(target.property.id)) {
    throw new StaleAdminCompanyPreviewError();
  }
  if (target.scope === 'property' && (
    propertyIds.length !== 1 || propertyIds[0] !== target.property.id
  )) {
    // The hidden anchor should contain the selected hotel. Treat a missing
    // relationship as a transient/incomplete rollout instead of widening scope.
    throw new UnavailableAdminCompanyPreviewTargetError(
      'The independent hotel access anchor is missing its hotel relationship',
    );
  }

  const properties = await readCompletePreviewIdChunks<PropertyRow>(
    propertyIds,
    (chunk, from, to) => supabaseAdmin.from('properties')
      .select('id, name', { count: 'exact' })
      .in('id', [...chunk])
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PropertyRow>>,
  );
  if (properties.length !== propertyIds.length) throw new StaleAdminCompanyPreviewError();
  const propertyNames = new Map(properties.map((row) => [row.id, row.name ?? 'Hotel']));
  const activePortfolios = portfolioRows.filter((row) => row.status === 'active');
  const activePortfolioIds = new Set(activePortfolios.map((row) => row.id));
  const activeAssignments = assignmentRows.filter((row) => (
    activePortfolioIds.has(row.portfolio_id)
    && activeRelationshipIds.has(row.property_relationship_id)
    && propertyNames.has(row.property_id)
    && adminPreviewWindowIsActive(row.assigned_at, row.removed_at, now)
  ));
  const portfolioNames = new Map(activePortfolios.map((row) => [row.id, row.name]));
  const portfolioIdsByProperty = new Map<string, Set<string>>();
  const propertyIdsByPortfolio = new Map<string, Set<string>>();
  for (const assignment of activeAssignments) {
    const propertyPortfolios = portfolioIdsByProperty.get(assignment.property_id) ?? new Set<string>();
    propertyPortfolios.add(assignment.portfolio_id);
    portfolioIdsByProperty.set(assignment.property_id, propertyPortfolios);

    const portfolioProperties = propertyIdsByPortfolio.get(assignment.portfolio_id) ?? new Set<string>();
    portfolioProperties.add(assignment.property_id);
    propertyIdsByPortfolio.set(assignment.portfolio_id, portfolioProperties);
  }

  const companyProperties: CompanyProperty[] = chosenRelationships.map((relationship) => ({
    nodeId: `${organizationId}:${relationship.property_id}`,
    id: relationship.property_id,
    name: propertyNames.get(relationship.property_id) ?? 'Hotel',
    organizationId,
    portfolioIds: [...(portfolioIdsByProperty.get(relationship.property_id) ?? [])],
    relationshipType: relationship.relationship_type,
    relationshipId: relationship.id,
    status: 'active',
  }));
  const companyPortfolios: CompanyPortfolio[] = activePortfolios.map((portfolio) => ({
    id: portfolio.id,
    organizationId,
    name: portfolio.name,
    parentId: portfolio.parent_id,
    propertyIds: [...(propertyIdsByPortfolio.get(portfolio.id) ?? [])],
  }));

  const activeGrantRows = grantRows.filter((row) => (
    row.status === 'active'
    && adminPreviewWindowIsActive(row.starts_at, row.expires_at, now)
  ));
  const grantsByMembership = new Map<string, GrantRow[]>();
  for (const grant of activeGrantRows) {
    const memberGrants = grantsByMembership.get(grant.membership_id) ?? [];
    memberGrants.push(grant);
    grantsByMembership.set(grant.membership_id, memberGrants);
  }
  const grantPropertyIds = (grant: GrantRow): string[] => {
    if (grant.scope_type === 'organization') return propertyIds;
    if (grant.scope_type === 'property') {
      return grant.property_id
        && grant.property_relationship_id
        && activeRelationshipIds.has(grant.property_relationship_id)
        && propertyNames.has(grant.property_id)
        ? [grant.property_id]
        : [];
    }
    if (!grant.portfolio_id || !activePortfolioIds.has(grant.portfolio_id)) return [];
    return [...(propertyIdsByPortfolio.get(grant.portfolio_id) ?? [])];
  };

  const [invitationResult, requestResult, eventResult] = await Promise.all([
    supabaseAdmin.from('organization_invitations')
      .select('id, organization_id, email, access_profile, scope_type, portfolio_id, property_id, status, expires_at, invited_by_account_id, created_at')
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(FEED_LIMIT),
    supabaseAdmin.from('organization_access_requests')
      .select('id, organization_id, membership_id, requested_access_profile, scope_type, portfolio_id, property_id, reason, status, requested_at')
      .eq('organization_id', organizationId)
      .eq('status', 'pending')
      .order('requested_at', { ascending: false })
      .limit(FEED_LIMIT),
    supabaseAdmin.from('organization_access_events')
      .select('id, organization_id, actor_account_id, actor_kind, event_type, target_type, target_id, occurred_at')
      .eq('organization_id', organizationId)
      .order('occurred_at', { ascending: false })
      .limit(FEED_LIMIT),
  ]);
  if (invitationResult.error) throw invitationResult.error;
  if (requestResult.error) throw requestResult.error;
  if (eventResult.error) throw eventResult.error;
  const invitationRows = (invitationResult.data ?? []) as InvitationRow[];
  const requestRows = (requestResult.data ?? []) as RequestRow[];
  const eventRows = (eventResult.data ?? []) as EventRow[];

  const accountIds = [...new Set([
    ...membershipRows.map((row) => row.account_id),
    ...activeGrantRows.map((row) => row.granted_by_account_id).filter((id): id is string => Boolean(id)),
    ...invitationRows.map((row) => row.invited_by_account_id).filter((id): id is string => Boolean(id)),
    ...eventRows.map((row) => row.actor_account_id).filter((id): id is string => Boolean(id)),
  ])];
  const accountRows = await readCompletePreviewIdChunks<AccountRow>(
    accountIds,
    (chunk, from, to) => supabaseAdmin.from('accounts')
      .select('id, display_name, role, active', { count: 'exact' })
      .in('id', [...chunk])
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<AccountRow>>,
  );
  const accountById = new Map(accountRows.map((row) => [row.id, row]));
  const accountName = (accountId: string | null): string | null => {
    if (!accountId) return null;
    const account = accountById.get(accountId);
    if (!account) return null;
    return account.role === 'admin' ? 'Staxis' : account.display_name ?? 'User';
  };

  const visibleMembershipRows = membershipRows.filter((membership) => {
    const account = accountById.get(membership.account_id);
    return Boolean(account && account.role !== 'admin');
  });
  const companyMemberships: CompanyMembership[] = visibleMembershipRows.map((membership) => {
    const account = accountById.get(membership.account_id);
    const grants: CompanyManagedGrant[] = (grantsByMembership.get(membership.id) ?? [])
      .flatMap((grant) => {
        const scopedPropertyIds = grantPropertyIds(grant);
        return scopedPropertyIds.length > 0 ? [{
          id: grant.id,
          accessProfile: grant.access_profile,
          scopeType: grant.scope_type,
          scopeLabel: scopeLabel(grant, organization.name, portfolioNames, propertyNames),
          propertyIds: scopedPropertyIds,
          expiresAt: grant.expires_at,
          canRevoke: false,
        }] : [];
      });
    const profiles = grants.map((grant) => grant.accessProfile)
      .sort((a, b) => profileRank(a) - profileRank(b));
    const startsInFuture = membership.starts_at
      ? Date.parse(membership.starts_at) > nowMs
      : false;
    const ended = membership.ended_at
      ? Date.parse(membership.ended_at) <= nowMs
      : false;
    const status = membership.status === 'revoked' || ended
      ? 'revoked' as const
      : startsInFuture
        ? 'pending' as const
        : membership.status === 'suspended' || account?.active !== true
          ? 'suspended' as const
          : 'active' as const;
    return {
      id: membership.id,
      organizationId,
      accountId: membership.account_id,
      displayName: accountName(membership.account_id) ?? 'User',
      jobCategory: membership.job_category,
      jobTitle: membership.job_title,
      accessProfile: profiles[0] ?? null,
      status,
      propertyIds: [...new Set(grants.flatMap((grant) => grant.propertyIds))],
      isCurrentUser: false,
      grants,
      canSuspend: false,
      canResume: false,
      canRemove: false,
    };
  });
  const membershipById = new Map(visibleMembershipRows.map((row) => [row.id, row]));
  const portfolioById = new Map(companyPortfolios.map((portfolio) => [portfolio.id, portfolio]));

  const invitationPropertyIds = (row: InvitationRow): string[] => {
    if (row.scope_type === 'organization') return propertyIds;
    if (row.scope_type === 'portfolio') {
      return portfolioById.get(row.portfolio_id ?? '')?.propertyIds ?? [];
    }
    return row.property_id && propertyNames.has(row.property_id) ? [row.property_id] : [];
  };
  const invitations: CompanyInvitation[] = invitationRows.flatMap((row) => {
    const scopedPropertyIds = invitationPropertyIds(row);
    return scopedPropertyIds.length > 0 ? [{
      id: row.id,
      organizationId,
      email: row.email,
      accessProfile: row.access_profile,
      scopeLabel: scopeLabel({
        scope_type: row.scope_type,
        portfolio_id: row.portfolio_id,
        property_id: row.property_id,
      }, organization.name, portfolioNames, propertyNames),
      propertyIds: scopedPropertyIds,
      status: Date.parse(row.expires_at) <= nowMs ? 'expired' as const : 'pending' as const,
      expiresAt: row.expires_at,
      invitedBy: accountName(row.invited_by_account_id),
      canCancel: false,
    }] : [];
  });
  const requests: CompanyAccessRequest[] = requestRows.flatMap((row) => {
    const membership = membershipById.get(row.membership_id);
    if (!membership) return [];
    const scopedPropertyIds = row.scope_type === 'organization'
      ? propertyIds
      : row.scope_type === 'portfolio'
        ? portfolioById.get(row.portfolio_id ?? '')?.propertyIds ?? []
        : row.property_id && propertyNames.has(row.property_id) ? [row.property_id] : [];
    if (scopedPropertyIds.length === 0) return [];
    return [{
      id: row.id,
      organizationId,
      requesterName: accountName(membership.account_id) ?? 'User',
      requestedProfile: row.requested_access_profile,
      scopeLabel: scopeLabel({
        scope_type: row.scope_type,
        portfolio_id: row.portfolio_id,
        property_id: row.property_id,
      }, organization.name, portfolioNames, propertyNames),
      propertyIds: scopedPropertyIds,
      reason: row.reason,
      status: row.status as 'pending' | 'approved' | 'denied' | 'cancelled',
      createdAt: row.requested_at,
      canReview: false,
    }];
  });
  const activity: CompanyActivityEvent[] = eventRows.filter((row) => (
    target.scope !== 'property'
    || row.target_type !== 'properties'
    || row.target_id === target.property.id
  )).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    actorName: row.actor_kind === 'staxis_admin'
      ? 'Staxis'
      : row.actor_kind === 'support_session'
        ? 'Staxis support'
        : row.actor_kind === 'account'
          ? accountName(row.actor_account_id) ?? 'User'
          : 'Staxis system',
    action: row.event_type,
    summary: eventSummary(row.event_type),
    createdAt: row.occurred_at,
    propertyId: row.target_type === 'properties' && row.target_id && propertyNames.has(row.target_id)
      ? row.target_id
      : null,
  }));

  const companyOrganization: CompanyOrganization = {
    id: organizationId,
    name: organization.name,
    type: organization.organizationType,
    status: organization.status,
    relationshipType: chosenRelationships.find((row) => row.property_id === target.property.id)
      ?.relationship_type ?? null,
    legacyPropertyId: organization.legacyPropertyId,
  };
  const projection: CompanyAccessData = {
    organizations: [companyOrganization],
    portfolios: companyPortfolios,
    properties: companyProperties,
    memberships: companyMemberships,
    effectiveAccess: [],
    invitations,
    requests,
    activity,
    permissions: {
      viewHotels: true,
      viewPeople: true,
      managePeople: false,
      manageInvitations: false,
      viewAccess: true,
      manageAccess: false,
      viewActivity: true,
      requestAccess: false,
      availableProfiles: [],
      delegationPolicies: [],
    },
    legacyFallback: false,
  };

  const endingEpoch = await loadEpoch(organizationId);
  if (endingEpoch !== startingEpoch) throw new StaleAdminCompanyPreviewError();
  return projection;
}

function viewerContext(target: AdminCompanyPreviewTarget) {
  const company = target.scope === 'organization';
  return {
    kind: 'staxis_admin_preview' as const,
    readOnly: true as const,
    hub: company ? 'company' as const : 'hotel' as const,
    requestedPropertyId: target.property.id,
    scope: target.scope,
    targetId: company ? target.organization.id : target.property.id,
    targetName: company ? target.organization.name : target.property.name,
    organizationId: target.organization?.id ?? null,
  };
}

async function loadStablePreview(
  pid: string,
  adminAccountId: string,
): Promise<AdminCompanyAccessPreviewData> {
  return runAdminPreviewReadWithRetry(async () => {
    const target = await loadPreviewTarget(pid);
    const projection = await buildScopedProjection(target);
    const confirmedTarget = await loadPreviewTarget(pid);
    if (targetKey(target) !== targetKey(confirmedTarget)) {
      throw new StaleAdminCompanyPreviewError();
    }
    return makeAdminCompanyAccessReadOnly({
      projection,
      viewerContext: viewerContext(confirmedTarget),
      adminAccountId,
    });
  });
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const pidCheck = validateUuid(new URL(req.url).searchParams.get('pid'), 'pid');
  if (pidCheck.error) {
    return err(pidCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: NO_STORE_HEADERS,
    });
  }
  const pid = pidCheck.value!;

  try {
    const preview = await loadStablePreview(pid, auth.accountId);
    log.info('[admin/company-access-preview:GET] read-only preview served', {
      requestId,
      actorAccountId: auth.accountId,
      pid,
      targetScope: preview.viewerContext.scope,
      targetId: preview.viewerContext.targetId,
    });
    return ok(preview, { requestId, headers: NO_STORE_HEADERS });
  } catch (caught) {
    if (caught instanceof AdminCompanyPreviewPropertyNotFoundError) {
      return err('Hotel not found', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
        headers: NO_STORE_HEADERS,
      });
    }
    if (caught instanceof AmbiguousAdminCompanyPreviewTargetError) {
      log.warn('[admin/company-access-preview:GET] ambiguous hotel scope', {
        requestId, actorAccountId: auth.accountId, pid,
      });
      return err(caught.message, {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
        headers: NO_STORE_HEADERS,
      });
    }
    if (caught instanceof UnavailableAdminCompanyPreviewTargetError) {
      return err(caught.message, {
        requestId,
        status: 409,
        code: ApiErrorCode.IdempotencyConflict,
        headers: NO_STORE_HEADERS,
      });
    }
    if (caught instanceof StaleAdminCompanyPreviewError
      || caught instanceof IncompleteCompanyProjectionError) {
      return err('The hotel management context changed. Try the preview again.', {
        requestId,
        status: 503,
        code: ApiErrorCode.UpstreamFailure,
        headers: NO_STORE_HEADERS,
      });
    }
    if (isCompanyAccessUnavailable(caught)) {
      return err('Company access preview is temporarily unavailable', {
        requestId,
        status: 503,
        code: ApiErrorCode.UpstreamFailure,
        headers: NO_STORE_HEADERS,
      });
    }
    log.error('[admin/company-access-preview:GET] failed', {
      requestId,
      actorAccountId: auth.accountId,
      pid,
      error: errToString(caught),
    });
    return err('Could not load the company access preview', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: NO_STORE_HEADERS,
    });
  }
}
