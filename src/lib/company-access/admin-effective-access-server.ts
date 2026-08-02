import 'server-only';

import type { CapabilityOverrideMap } from '@/lib/capabilities/can';
import { loadOverridesForPropertyFresh } from '@/lib/capabilities/server';
import {
  readCompleteCompanyIdChunks,
  readCompleteCompanyPages,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';
import { accessProfileForHat, type HatRole } from '@/lib/company/roles';
import { companyAccessSetting } from '@/lib/company/rulebook-access';
import {
  resolveCompanyForProperty,
  resolveOrganizationPropertyTopology,
} from '@/lib/company/access';
import { resolveAiFeatureConfig } from '@/lib/ai/model-config-store';
import {
  listAuthoritativePropertyAccess,
  type AuthoritativePropertyAccess,
  type AuthoritativePropertyEntitlement,
  type AuthoritativePropertyStanding,
} from '@/lib/authorization/server';
import { loadAuthoritativeHotelRoster } from '@/lib/authorization/hotel-account-roster';
import { legacyAccessProfile, titleCaseAccessValue } from '@/lib/company-access/dto';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { AppRole } from '@/lib/roles';
import type {
  AdminEffectiveAccessAiControl,
  AdminEffectiveAccessData,
  AdminEffectiveAccessRow,
  AdminEffectiveAccessTarget,
} from './admin-effective-access-dto';

const MAX_ACCOUNTS = 5_000;
const RESOLVER_CONCURRENCY = 8;

interface AccountRow {
  id: string;
  display_name: string | null;
  role: AppRole;
  active: boolean;
}

interface OrganizationRow {
  id: string;
  name: string;
  organization_type: string;
  status: string;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  account_id: string;
  membership_scope: string | null;
  staxis_role: string | null;
  job_title: string | null;
  status: string;
  starts_at: string | null;
  ended_at: string | null;
}

interface GrantRow {
  id: string;
  organization_id: string;
  source: string;
  status: string;
  starts_at: string | null;
  expires_at: string | null;
}

interface PropertyRow {
  id: string;
  name: string | null;
}

interface PortfolioRow {
  id: string;
  name: string;
}

interface ResolvedAccount {
  account: AccountRow;
  access: AuthoritativePropertyAccess;
}

interface EntitlementGroup {
  entitlement: AuthoritativePropertyEntitlement;
  standings: AuthoritativePropertyStanding[];
}

function activeWindow(startsAt: string | null, endsAt: string | null, nowMs: number): boolean {
  const starts = startsAt ? Date.parse(startsAt) : null;
  const ends = endsAt ? Date.parse(endsAt) : null;
  return (starts === null || (Number.isFinite(starts) && starts <= nowMs))
    && (ends === null || (Number.isFinite(ends) && ends > nowMs));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      out[index] = await map(values[index]);
    }
  }));
  return out;
}

async function loadAccounts(ids?: readonly string[]): Promise<AccountRow[]> {
  if (ids && ids.length === 0) return [];
  if (ids) {
    return readCompleteCompanyIdChunks<AccountRow>(ids, (chunk, from, to) => (
      supabaseAdmin.from('accounts')
        .select('id, display_name, role, active', { count: 'exact' })
        .in('id', [...chunk])
        .order('id')
        .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<AccountRow>>
    ));
  }
  return readCompleteCompanyPages<AccountRow>((from, to) => (
    supabaseAdmin.from('accounts')
      .select('id, display_name, role, active', { count: 'exact' })
      .order('id')
      .range(from, to) as unknown as PromiseLike<CompanyProjectionPage<AccountRow>>
  ), { maxRows: MAX_ACCOUNTS });
}

async function resolveAccounts(accounts: readonly AccountRow[]): Promise<ResolvedAccount[]> {
  const resolved = await mapWithConcurrency(accounts, RESOLVER_CONCURRENCY, async (account) => ({
    account,
    access: await listAuthoritativePropertyAccess(account.id),
  }));
  return resolved.flatMap(({ account, access }) => (
    access && !access.all ? [{ account, access }] : []
  ));
}

function entitlementKey(entitlement: AuthoritativePropertyEntitlement): string {
  return `${entitlement.kind}:${entitlement.entitlementId}`;
}

function entitlementGroups(
  resolved: ResolvedAccount,
  target: AdminEffectiveAccessTarget,
  organizationPropertyIds: ReadonlySet<string>,
): EntitlementGroup[] {
  const selected = new Set<string>();
  for (const standing of resolved.access.propertyStandings) {
    if (target.kind === 'hotel' && standing.propertyId !== target.id) continue;
    if (target.kind === 'organization' && !organizationPropertyIds.has(standing.propertyId)) continue;
    for (const entitlement of standing.entitlements) {
      if (target.kind === 'organization'
          && entitlement.organizationId !== target.organizationId
          && entitlement.kind !== 'legacy'
          && entitlement.kind !== 'legacy_bridge') continue;
      selected.add(entitlementKey(entitlement));
    }
  }

  const grouped = new Map<string, EntitlementGroup>();
  for (const standing of resolved.access.propertyStandings) {
    if (target.kind === 'organization' && !organizationPropertyIds.has(standing.propertyId)) continue;
    for (const entitlement of standing.entitlements) {
      const key = entitlementKey(entitlement);
      if (!selected.has(key)) continue;
      const current = grouped.get(key) ?? { entitlement, standings: [] };
      if (!current.standings.some((candidate) => candidate.propertyId === standing.propertyId)) {
        current.standings.push(standing);
      }
      grouped.set(key, current);
    }
  }
  return [...grouped.values()];
}

function explicitFinancialDeny(
  standing: AuthoritativePropertyStanding,
  overrides: CapabilityOverrideMap,
): boolean {
  const restrictingRoles = new Set<string>([standing.operationalRole]);
  if (standing.entitlements.some((entitlement) => (
    entitlement.staxisRole === 'owner' || entitlement.accessProfile === 'organization_owner'
  ))) restrictingRoles.add('owner');
  return [...restrictingRoles].some(
    (role) => overrides.view_financials?.[role as keyof NonNullable<typeof overrides.view_financials>] === false,
  );
}

function profileFor(entitlement: AuthoritativePropertyEntitlement, accountRole: AppRole): string {
  if (entitlement.kind === 'membership_hat') {
    return accessProfileForHat(
      entitlement.scopeType as 'company' | 'property',
      entitlement.staxisRole as HatRole,
    );
  }
  if (entitlement.kind === 'access_grant') return entitlement.accessProfile!;
  return legacyAccessProfile(accountRole);
}

function roleFor(entitlement: AuthoritativePropertyEntitlement, accountRole: AppRole): string {
  if (entitlement.staxisRole) return entitlement.staxisRole;
  if (entitlement.accessProfile) return entitlement.accessProfile;
  return accountRole;
}

function sourceFor(
  entitlement: AuthoritativePropertyEntitlement,
  grant: GrantRow | undefined,
): string {
  if (entitlement.kind === 'membership_hat') {
    return entitlement.scopeType === 'company' ? 'Organization membership' : 'Hotel-scoped membership';
  }
  if (entitlement.kind === 'access_grant') {
    const prefix = entitlement.scopeType === 'property' ? 'Direct hotel grant' : 'Inherited company access';
    return grant?.source ? `${prefix} · ${titleCaseAccessValue(grant.source)}` : prefix;
  }
  if (entitlement.kind === 'legacy_bridge') return 'Legacy access bridge';
  return 'Direct hotel access · legacy';
}

function scopeLabelFor(
  entitlement: AuthoritativePropertyEntitlement,
  target: AdminEffectiveAccessTarget,
  propertyNames: Map<string, string>,
  organizationNames: Map<string, string>,
  portfolioNames: Map<string, string>,
  coverageIds: readonly string[],
): string {
  if (entitlement.scopeType === 'company' || entitlement.scopeType === 'organization') {
    return organizationNames.get(entitlement.organizationId ?? '') ?? target.name;
  }
  if (entitlement.scopeType === 'portfolio') {
    return portfolioNames.get(entitlement.portfolioId ?? '') ?? 'Portfolio / region';
  }
  if (coverageIds.length === 1) return propertyNames.get(coverageIds[0]) ?? 'Hotel';
  return `${coverageIds.length} selected hotels`;
}

function mutationFor(
  entitlement: AuthoritativePropertyEntitlement,
  profile: string,
  target: AdminEffectiveAccessTarget,
  coverageIds: readonly string[],
): AdminEffectiveAccessRow['mutation'] {
  if (entitlement.kind === 'membership_hat') {
    if (profile === 'organization_owner') {
      return {
        kind: 'read_only', allowed: false, label: 'Protected organization owner',
        hotelId: null, membershipId: null,
      };
    }
    return {
      kind: 'membership_hat',
      allowed: true,
      label: 'Guarded organization job',
      hotelId: target.kind === 'hotel' ? target.id : coverageIds[0] ?? null,
      membershipId: entitlement.entitlementId,
    };
  }
  if (entitlement.kind === 'legacy' && target.kind === 'hotel') {
    return {
      kind: 'legacy_hotel', allowed: true, label: 'Guarded direct hotel access',
      hotelId: target.id, membershipId: null,
    };
  }
  return {
    kind: 'read_only',
    allowed: false,
    label: entitlement.kind === 'access_grant'
      ? 'Customer-managed grant'
      : 'Read-only compatibility access',
    hotelId: null,
    membershipId: null,
  };
}

async function aiControl(organizationId: string | null): Promise<AdminEffectiveAccessAiControl> {
  const [hotelFeature, portfolioFeature, companySetting] = await Promise.all([
    resolveAiFeatureConfig('agent.ask_staxis'),
    resolveAiFeatureConfig('agent.portfolio_chat'),
    organizationId ? companyAccessSetting(organizationId, 'cross_hotel_ai_chat') : Promise.resolve(null),
  ]);
  return {
    hotelFeature: { key: 'agent.ask_staxis', enabled: hotelFeature.enabled },
    portfolioFeature: { key: 'agent.portfolio_chat', enabled: portfolioFeature.enabled },
    companySetting: organizationId ? {
      key: 'cross_hotel_ai_chat',
      organizationId,
      enabled: companySetting === 'true',
      mutable: true,
    } : null,
  };
}

async function loadMetadata(groups: EntitlementGroup[]) {
  const membershipIds = [...new Set(groups
    .filter(({ entitlement }) => entitlement.kind === 'membership_hat')
    .map(({ entitlement }) => entitlement.entitlementId))];
  const grantIds = [...new Set(groups
    .filter(({ entitlement }) => entitlement.kind === 'access_grant')
    .map(({ entitlement }) => entitlement.entitlementId))];
  const organizationIds = [...new Set(groups
    .map(({ entitlement }) => entitlement.organizationId)
    .filter((id): id is string => Boolean(id)))];
  const portfolioIds = [...new Set(groups
    .map(({ entitlement }) => entitlement.portfolioId)
    .filter((id): id is string => Boolean(id)))];

  const [memberships, grants, organizations, portfolios] = await Promise.all([
    membershipIds.length === 0 ? Promise.resolve([] as MembershipRow[]) : readCompleteCompanyIdChunks<MembershipRow>(
      membershipIds,
      (chunk, from, to) => supabaseAdmin.from('organization_memberships')
        .select('id, organization_id, account_id, membership_scope, staxis_role, job_title, status, starts_at, ended_at', { count: 'exact' })
        .in('id', [...chunk]).order('id').range(from, to) as unknown as PromiseLike<CompanyProjectionPage<MembershipRow>>,
    ),
    grantIds.length === 0 ? Promise.resolve([] as GrantRow[]) : readCompleteCompanyIdChunks<GrantRow>(
      grantIds,
      (chunk, from, to) => supabaseAdmin.from('organization_access_grants')
        .select('id, organization_id, source, status, starts_at, expires_at', { count: 'exact' })
        .in('id', [...chunk]).order('id').range(from, to) as unknown as PromiseLike<CompanyProjectionPage<GrantRow>>,
    ),
    organizationIds.length === 0 ? Promise.resolve([] as OrganizationRow[]) : readCompleteCompanyIdChunks<OrganizationRow>(
      organizationIds,
      (chunk, from, to) => supabaseAdmin.from('organizations')
        .select('id, name, organization_type, status', { count: 'exact' })
        .in('id', [...chunk]).order('id').range(from, to) as unknown as PromiseLike<CompanyProjectionPage<OrganizationRow>>,
    ),
    portfolioIds.length === 0 ? Promise.resolve([] as PortfolioRow[]) : readCompleteCompanyIdChunks<PortfolioRow>(
      portfolioIds,
      (chunk, from, to) => supabaseAdmin.from('portfolios')
        .select('id, name', { count: 'exact' })
        .in('id', [...chunk]).order('id').range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PortfolioRow>>,
    ),
  ]);
  return {
    membershipById: new Map(memberships.map((row) => [row.id, row])),
    grantById: new Map(grants.map((row) => [row.id, row])),
    organizationNames: new Map(organizations.map((row) => [row.id, row.name])),
    portfolioNames: new Map(portfolios.map((row) => [row.id, row.name])),
  };
}

async function buildRows(
  target: AdminEffectiveAccessTarget,
  resolvedAccounts: readonly ResolvedAccount[],
  organizationPropertyIds: ReadonlySet<string>,
): Promise<AdminEffectiveAccessRow[]> {
  const grouped = resolvedAccounts.flatMap((resolved) => (
    entitlementGroups(resolved, target, organizationPropertyIds).map((group) => ({ resolved, group }))
  ));
  const allGroups = grouped.map(({ group }) => group);
  const metadata = await loadMetadata(allGroups);
  const propertyIds = [...new Set(allGroups.flatMap(({ standings }) => (
    standings.map((standing) => standing.propertyId)
  )))].sort();
  const [propertyRows, overrideEntries] = await Promise.all([
    propertyIds.length === 0 ? Promise.resolve([] as PropertyRow[]) : readCompleteCompanyIdChunks<PropertyRow>(
      propertyIds,
      (chunk, from, to) => supabaseAdmin.from('properties')
        .select('id, name', { count: 'exact' })
        .in('id', [...chunk]).order('id').range(from, to) as unknown as PromiseLike<CompanyProjectionPage<PropertyRow>>,
    ),
    mapWithConcurrency(propertyIds, RESOLVER_CONCURRENCY, async (propertyId) => (
      [propertyId, await loadOverridesForPropertyFresh(propertyId)] as const
    )),
  ]);
  const propertyNames = new Map(propertyRows.map((row) => [row.id, row.name ?? 'Unnamed hotel']));
  const overridesByProperty = new Map(overrideEntries);

  return grouped.map(({ resolved, group }) => {
    const { entitlement } = group;
    const standings = [...group.standings].sort((left, right) => left.propertyId.localeCompare(right.propertyId));
    const coverageIds = standings.map((standing) => standing.propertyId);
    const hotels = coverageIds.map((id) => ({ id, name: propertyNames.get(id) ?? 'Hotel' }));
    const grant = metadata.grantById.get(entitlement.entitlementId);
    const membership = metadata.membershipById.get(entitlement.entitlementId);
    const profile = profileFor(entitlement, resolved.account.role);
    const financialHotels = standings.filter((standing) => (
      standing.seesFinancials
      && !explicitFinancialDeny(standing, overridesByProperty.get(standing.propertyId) ?? {})
    )).map((standing) => ({
      id: standing.propertyId,
      name: propertyNames.get(standing.propertyId) ?? 'Hotel',
    }));
    const status = grant?.status ?? membership?.status ?? (resolved.account.active ? 'active' : 'inactive');
    return {
      id: `${resolved.account.id}:${entitlementKey(entitlement)}`,
      accountId: resolved.account.id,
      displayName: resolved.account.display_name?.trim() || 'Unnamed person',
      accountRole: resolved.account.role,
      profile,
      role: roleFor(entitlement, resolved.account.role),
      scopeType: entitlement.scopeType ?? 'property',
      scopeLabel: scopeLabelFor(
        entitlement,
        target,
        propertyNames,
        metadata.organizationNames,
        metadata.portfolioNames,
        coverageIds,
      ),
      hotels,
      hotelAiEntitled: coverageIds.length > 0,
      portfolioAiEntitled: standings.some((standing) => standing.portfolioIntelligenceRead),
      financialHotels,
      source: sourceFor(entitlement, grant),
      status,
      startsAt: grant?.starts_at ?? membership?.starts_at ?? null,
      expiresAt: grant?.expires_at ?? membership?.ended_at ?? null,
      mutation: mutationFor(entitlement, profile, target, coverageIds),
    } satisfies AdminEffectiveAccessRow;
  }).sort((left, right) => (
    left.displayName.localeCompare(right.displayName)
      || left.scopeType.localeCompare(right.scopeType)
      || left.id.localeCompare(right.id)
  ));
}

async function hotelProjection(propertyId: string): Promise<AdminEffectiveAccessData> {
  const { data: property, error: propertyError } = await supabaseAdmin.from('properties')
    .select('id, name').eq('id', propertyId).maybeSingle();
  if (propertyError) throw propertyError;
  if (!property) throw new Error('hotel_not_found');

  const [firstRoster, companyResolution] = await Promise.all([
    loadAuthoritativeHotelRoster(propertyId, false),
    resolveCompanyForProperty(propertyId),
  ]);
  if (companyResolution.status === 'unavailable' || companyResolution.status === 'ambiguous') {
    throw new Error('company_topology_unavailable');
  }
  const accounts = await loadAccounts(firstRoster.accounts.map((account) => account.accountId));
  const resolved = await resolveAccounts(accounts.filter((account) => account.role !== 'admin'));
  // The governing company belongs to hotel topology, not to whoever happens
  // to appear in today's roster. A newly assigned hotel with no accepted
  // member still has a real company AI permission that Admin must display.
  const organizationId = companyResolution.status === 'company'
    ? companyResolution.organizationId
    : null;
  const target: AdminEffectiveAccessTarget = {
    kind: 'hotel', id: propertyId, name: property.name ?? 'Unnamed hotel', organizationId,
  };
  const rows = await buildRows(target, resolved, new Set([propertyId]));

  const finalRoster = await loadAuthoritativeHotelRoster(propertyId, false);
  const firstSignature = firstRoster.accounts.map((account) => `${account.accountId}:${account.authorityVersion}`).sort();
  const finalSignature = finalRoster.accounts.map((account) => `${account.accountId}:${account.authorityVersion}`).sort();
  if (!sameStrings(firstSignature, finalSignature)) throw new Error('access_changed');
  return { target, generatedAt: new Date().toISOString(), rows, aiControl: await aiControl(organizationId) };
}

async function organizationProjection(organizationId: string): Promise<AdminEffectiveAccessData> {
  const { data: organization, error: organizationError } = await supabaseAdmin.from('organizations')
    .select('id, name, organization_type, status').eq('id', organizationId).maybeSingle();
  if (organizationError) throw organizationError;
  if (!organization || organization.organization_type === 'single_hotel') throw new Error('organization_not_found');

  const { data: startingEpochRow, error: startingEpochError } = await supabaseAdmin
    .from('organization_access_epochs')
    .select('version')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (startingEpochError || !Number.isSafeInteger(Number(startingEpochRow?.version))) {
    throw startingEpochError ?? new Error('access_changed');
  }
  const startingEpoch = Number(startingEpochRow!.version);
  const now = new Date();
  const topology = await resolveOrganizationPropertyTopology(organizationId, now);
  if (!topology.ok) throw new Error('company_topology_unavailable');
  const propertyIds = [...topology.topology.propertyIds].sort();
  const organizationPropertyIds = new Set(propertyIds);
  const accounts = (await loadAccounts()).filter((account) => account.role !== 'admin');
  const resolved = await resolveAccounts(accounts);
  const target: AdminEffectiveAccessTarget = {
    kind: 'organization', id: organizationId, name: organization.name,
    organizationId,
  };
  const rows = await buildRows(target, resolved, organizationPropertyIds);
  const { data: endingEpochRow, error: endingEpochError } = await supabaseAdmin
    .from('organization_access_epochs')
    .select('version')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (endingEpochError
      || !Number.isSafeInteger(Number(endingEpochRow?.version))
      || Number(endingEpochRow!.version) !== startingEpoch) {
    throw endingEpochError ?? new Error('access_changed');
  }
  return { target, generatedAt: new Date().toISOString(), rows, aiControl: await aiControl(organizationId) };
}

export async function loadAdminEffectiveAccess(input: {
  propertyId?: string;
  organizationId?: string;
}): Promise<AdminEffectiveAccessData> {
  if (input.propertyId) return hotelProjection(input.propertyId);
  if (input.organizationId) return organizationProjection(input.organizationId);
  throw new Error('target_required');
}
