/**
 * GET /api/admin/organizations
 *
 * Read-only directory for the dark Staxis Admin Studio. It deliberately
 * returns an admin-specific DTO instead of exposing the authorization tables
 * directly to the client. Legacy `single_hotel` organizations are migration
 * anchors, not management companies, so their properties remain in the
 * Independent Hotels collection.
 *
 * The organizations migration is additive and may be deployed after this
 * route. When PostgREST reports that one of the new relations does not exist,
 * return every property as independent with `schemaReady: false`. That keeps
 * the Hotels console usable throughout a rolling deploy without masking any
 * hotel from the Staxis owner.
 */

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isOrganizationType } from '@/lib/organization-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const READ_PAGE_SIZE = 1_000;

interface DbError {
  code?: string;
  message: string;
}

interface PropertyLite {
  id: string;
  name: string | null;
  subscription_status: string | null;
}

interface OrganizationRow {
  id: string;
  name: string;
  organization_type: string;
  status: string;
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

interface MembershipRow {
  id: string;
  organization_id: string;
  account_id: string;
  status: string;
  starts_at: string | null;
  ended_at: string | null;
}

interface ActiveAccountRow {
  id: string;
}

interface PageResult<T> {
  data: T[] | null;
  error: DbError | null;
}

async function readAll<T>(
  readPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<PageResult<T>> {
  const rows: T[] = [];
  for (let from = 0; ; from += READ_PAGE_SIZE) {
    const result = await readPage(from, from + READ_PAGE_SIZE - 1);
    if (result.error) return { data: null, error: result.error };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < READ_PAGE_SIZE) break;
  }
  return { data: rows, error: null };
}

function isMissingOrganizationSchema(error: DbError | null): boolean {
  if (!error) return false;
  return error.code === '42P01'
    || error.code === 'PGRST202'
    || error.code === 'PGRST205'
    || /relation .* does not exist|schema cache/i.test(error.message);
}

function hotelDto(property: PropertyLite) {
  return {
    id: property.id,
    name: property.name,
    status: property.subscription_status ?? 'unknown',
  };
}

function startsNowOrEarlier(value: string | null, nowMs: number): boolean {
  if (!value) return true;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function activeWindowAt(
  startsAt: string | null,
  endsAt: string | null,
  nowMs: number,
): boolean {
  if (!startsNowOrEarlier(startsAt, nowMs)) return false;
  if (!endsAt) return true;
  const parsedEnd = Date.parse(endsAt);
  return Number.isFinite(parsedEnd) && parsedEnd > nowMs;
}

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  const propertiesResult = await readAll<PropertyLite>((from, to) => (
    supabaseAdmin
      .from('properties')
      .select('id, name, subscription_status')
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<PropertyLite>>
  ));

  if (propertiesResult.error) {
    return err(`Could not load organization properties: ${propertiesResult.error.message}`, {
      requestId,
      status: 500,
    });
  }
  const properties = propertiesResult.data ?? [];

  const organizationsResult = await readAll<OrganizationRow>((from, to) => (
    supabaseAdmin
      .from('organizations')
      .select('id, name, organization_type, status, legacy_property_id')
      .order('name', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<OrganizationRow>>
  ));

  if (isMissingOrganizationSchema(organizationsResult.error)) {
    return ok({
      organizations: [],
      independentHotels: properties.map(hotelDto),
      schemaReady: false,
    }, { requestId });
  }
  if (organizationsResult.error) {
    return err(`Could not load organizations: ${organizationsResult.error.message}`, {
      requestId,
      status: 500,
    });
  }

  const allOrganizations = organizationsResult.data ?? [];
  if (allOrganizations.length === 0) {
    return ok({
      organizations: [],
      independentHotels: properties.map(hotelDto),
      schemaReady: true,
    }, { requestId });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  const relationshipsResult = await readAll<RelationshipRow>((from, to) => (
    supabaseAdmin
      .from('organization_property_relationships')
      .select('id, organization_id, property_id, relationship_type, is_primary_grouping, starts_at, ends_at')
      .eq('is_primary_grouping', true)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<RelationshipRow>>
  ));
  if (isMissingOrganizationSchema(relationshipsResult.error)) {
    return ok({
      organizations: [],
      independentHotels: properties.map(hotelDto),
      schemaReady: false,
    }, { requestId });
  }
  if (relationshipsResult.error) {
    return err(`Could not load organization relationships: ${relationshipsResult.error.message}`, {
      requestId,
      status: 500,
    });
  }

  const membershipsResult = await readAll<MembershipRow>((from, to) => (
    supabaseAdmin
      .from('organization_memberships')
      .select('id, organization_id, account_id, status, starts_at, ended_at')
      .eq('status', 'active')
      .or(`ended_at.is.null,ended_at.gt.${nowIso}`)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<MembershipRow>>
  ));
  if (isMissingOrganizationSchema(membershipsResult.error)) {
    return ok({
      organizations: [],
      independentHotels: properties.map(hotelDto),
      schemaReady: false,
    }, { requestId });
  }
  if (membershipsResult.error) {
    return err(`Could not load organization memberships: ${membershipsResult.error.message}`, {
      requestId,
      status: 500,
    });
  }

  // Account deactivation intentionally preserves normalized membership
  // history, so membership.status alone is not an active-user count.
  const activeAccountsResult = await readAll<ActiveAccountRow>((from, to) => (
    supabaseAdmin
      .from('accounts')
      .select('id')
      .eq('active', true)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<PageResult<ActiveAccountRow>>
  ));
  if (activeAccountsResult.error) {
    return err(`Could not load active organization accounts: ${activeAccountsResult.error.message}`, {
      requestId,
      status: 500,
    });
  }
  const activeAccountIds = new Set((activeAccountsResult.data ?? []).map((account) => account.id));

  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const organizationsById = new Map(allOrganizations.map((organization) => [organization.id, organization]));
  const managementOrganizations = allOrganizations.filter((organization) => (
    organization.organization_type !== 'single_hotel' && organization.legacy_property_id === null
  ));
  const managementOrganizationIds = new Set(managementOrganizations.map((organization) => organization.id));

  const activePrimaryRelationships = (relationshipsResult.data ?? []).filter((relationship) => (
    relationship.is_primary_grouping
      && activeWindowAt(relationship.starts_at, relationship.ends_at, nowMs)
      && organizationsById.has(relationship.organization_id)
      && propertyById.has(relationship.property_id)
  ));

  const relationshipsByOrganization = new Map<string, RelationshipRow[]>();
  for (const relationship of activePrimaryRelationships) {
    const current = relationshipsByOrganization.get(relationship.organization_id) ?? [];
    current.push(relationship);
    relationshipsByOrganization.set(relationship.organization_id, current);
  }

  const memberAccountsByOrganization = new Map<string, Set<string>>();
  for (const membership of membershipsResult.data ?? []) {
    if (!activeWindowAt(membership.starts_at, membership.ended_at, nowMs)) continue;
    if (!activeAccountIds.has(membership.account_id)) continue;
    const accounts = memberAccountsByOrganization.get(membership.organization_id) ?? new Set<string>();
    accounts.add(membership.account_id);
    memberAccountsByOrganization.set(membership.organization_id, accounts);
  }

  const groupedManagementPropertyIds = new Set(
    activePrimaryRelationships
      .filter((relationship) => managementOrganizationIds.has(relationship.organization_id))
      .map((relationship) => relationship.property_id),
  );

  const organizations = managementOrganizations.map((organization) => {
    const relationships = relationshipsByOrganization.get(organization.id) ?? [];
    const hotels = relationships
      .map((relationship) => {
        const property = propertyById.get(relationship.property_id);
        if (!property) return null;
        return {
          ...hotelDto(property),
          relationshipType: relationship.relationship_type,
          isPrimary: true,
        };
      })
      .filter((hotel): hotel is NonNullable<typeof hotel> => hotel !== null)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    const userCount = memberAccountsByOrganization.get(organization.id)?.size ?? 0;
    const warnings: string[] = [];
    if (organization.status !== 'active') warnings.push(`Organization is ${organization.status.replaceAll('_', ' ')}`);
    if (hotels.length === 0) warnings.push('No hotels assigned');
    if (userCount === 0) warnings.push('No active members');

    return {
      id: organization.id,
      name: organization.name,
      type: organization.organization_type,
      status: organization.status,
      hotelCount: hotels.length,
      userCount,
      warnings,
      hotels,
    };
  });

  const independentHotels = properties
    .filter((property) => !groupedManagementPropertyIds.has(property.id))
    .map(hotelDto)
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  return ok({ organizations, independentHotels, schemaReady: true }, { requestId });
}

/** Create a real customer organization. `single_hotel` is reserved for the
 * compatibility backfill and can never be created from the Admin Studio. */
export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const auth = await requireAdmin(req);
  if (!auth.ok) return auth.response;

  let body: { name?: unknown; type?: unknown };
  try {
    body = await req.json() as { name?: unknown; type?: unknown };
  } catch {
    return err('A valid JSON body is required', { requestId, status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const organizationType = body.type ?? 'management_company';
  if (name.length < 1 || name.length > 160) {
    return err('Organization name must be between 1 and 160 characters', {
      requestId,
      status: 400,
    });
  }
  if (!isOrganizationType(organizationType) || organizationType === 'single_hotel') {
    return err('Invalid organization type', { requestId, status: 400 });
  }

  const { data: organizationId, error: createError } = await supabaseAdmin.rpc(
    'staxis_create_organization',
    {
      p_actor_account_id: auth.accountId,
      p_name: name,
      p_organization_type: organizationType,
    },
  );

  if (createError || typeof organizationId !== 'string') {
    const schemaUnavailable = isMissingOrganizationSchema(createError);
    return err(
      schemaUnavailable
        ? 'Organization access is still being prepared. Try again after the database migration finishes.'
        : `Could not create organization: ${createError?.message ?? 'unknown error'}`,
      { requestId, status: schemaUnavailable ? 503 : 500 },
    );
  }

  return ok({
    organization: {
      id: organizationId,
      name,
      type: organizationType,
      status: 'active',
      hotelCount: 0,
      userCount: 0,
      warnings: ['No hotels assigned', 'No active members'],
      hotels: [],
    },
  }, { requestId, status: 201 });
}
