import 'server-only';

import {
  readCompleteCompanyIdChunks,
  type CompanyProjectionPage,
} from '@/lib/company-access/projection-query';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { isHatRole, type HatRole } from '@/lib/company/roles';
import {
  isAccessProfile,
  isAccessScopeType,
  type AccessProfile,
  type AccessScopeType,
} from '@/lib/organization-access/domain';
import { isValidRole, type AppRole } from '@/lib/roles';
import {
  isUuid,
  parseAuthorizationScopeResult,
  type AuthorityMode,
  type AuthorizationScopeRefusal,
  type AuthorizationScopeReceipt,
  type AuthorizationScopeResult,
  type AuthorizationScopeSelector,
} from './domain';

const MAX_SCOPE_PROPERTIES = 5000;

export interface ResolveAuthorizationScopeInput {
  accountId: string;
  organizationId?: string | null;
  selector: AuthorizationScopeSelector;
  /** Clamped by PostgreSQL to 5–300 seconds. */
  ttlSeconds?: number;
}

function canonicalSelector(selector: AuthorizationScopeSelector): AuthorizationScopeSelector | null {
  if (selector.type === 'all_authorized') return { type: 'all_authorized' };
  if (selector.type === 'portfolio') {
    return isUuid(selector.portfolioId)
      ? { type: 'portfolio', portfolioId: selector.portfolioId }
      : null;
  }
  if (!Array.isArray(selector.propertyIds)
    || selector.propertyIds.length === 0
    || selector.propertyIds.length > MAX_SCOPE_PROPERTIES
    || !selector.propertyIds.every(isUuid)
    || new Set(selector.propertyIds).size !== selector.propertyIds.length) return null;
  return { type: 'property_subset', propertyIds: [...selector.propertyIds].sort() };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function resolveAuthorizationScope(
  input: ResolveAuthorizationScopeInput,
): Promise<AuthorizationScopeResult> {
  if (!isUuid(input.accountId)
    || (input.organizationId != null && !isUuid(input.organizationId))) {
    return { ok: false, reason: 'invalid_request' };
  }
  const selector = canonicalSelector(input.selector);
  if (!selector) return { ok: false, reason: 'invalid_request' };
  if (input.ttlSeconds != null
    && (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0)) {
    return { ok: false, reason: 'invalid_request' };
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('staxis_resolve_authorization_scope', {
      p_account_id: input.accountId,
      p_organization_id: input.organizationId ?? null,
      p_selector_type: selector.type,
      p_portfolio_id: selector.type === 'portfolio' ? selector.portfolioId : null,
      p_property_ids: selector.type === 'property_subset' ? selector.propertyIds : null,
      p_ttl_seconds: input.ttlSeconds ?? 120,
    });
    if (error) return { ok: false, reason: 'store_unavailable' };
    const parsed = parseAuthorizationScopeResult(data);
    if (!parsed.ok) return parsed;
    const receipt = parsed.receipt;
    const selectorMatches = receipt.selectorType === selector.type
      && (selector.type !== 'portfolio'
        || receipt.requestedPortfolioId === selector.portfolioId)
      && (selector.type !== 'property_subset'
        || sameStringArray(receipt.requestedPropertyIds, selector.propertyIds));
    if (receipt.accountId !== input.accountId
      || (input.organizationId != null && receipt.organizationId !== input.organizationId)
      || !selectorMatches) {
      return { ok: false, reason: 'store_unavailable' };
    }
    return parsed;
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }
}

export interface AssertAuthorizationScopeReceiptInput {
  receiptId: string;
  accountId: string;
}

export async function assertAuthorizationScopeReceipt(
  input: AssertAuthorizationScopeReceiptInput,
): Promise<AuthorizationScopeResult> {
  if (!isUuid(input.receiptId) || !isUuid(input.accountId)) {
    return { ok: false, reason: 'invalid_request' };
  }
  try {
    const { data, error } = await supabaseAdmin.rpc(
      'staxis_assert_authorization_scope_receipt',
      { p_receipt_id: input.receiptId, p_account_id: input.accountId },
    );
    if (error) return { ok: false, reason: 'store_unavailable' };
    const parsed = parseAuthorizationScopeResult(data);
    if (!parsed.ok) return parsed;
    return parsed.receipt.id === input.receiptId
      && parsed.receipt.accountId === input.accountId
      ? parsed
      : { ok: false, reason: 'store_unavailable' };
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }
}

export interface AuthoritativePropertyAccess {
  all: boolean;
  authorityMode: AuthorityMode;
  authorityVersion: number;
  /** Hash of the complete reach + standing projection returned by this call. */
  effectiveAccessHash: string;
  propertyIds: string[];
  legacyPropertyIds: string[];
  membershipPropertyIds: string[];
  propertyStandings: AuthoritativePropertyStanding[];
}

export type AuthoritativeEntitlementKind =
  | 'legacy'
  | 'legacy_bridge'
  | 'membership_hat'
  | 'access_grant';

/**
 * One source contributing to a per-hotel standing. This is intentionally
 * provenance, not a bag of independently additive permissions: the database
 * has already applied the precedence rule (hat > grant > cutover bridge).
 */
export interface AuthoritativePropertyEntitlement {
  kind: AuthoritativeEntitlementKind;
  entitlementId: string;
  organizationId: string | null;
  membershipId: string | null;
  accessProfile: AccessProfile | null;
  staxisRole: HatRole | null;
  scopeType: AccessScopeType | 'company' | null;
  portfolioId: string | null;
}

export interface AuthoritativePropertyStanding {
  propertyId: string;
  /** Closed legacy-compatible role used by hotel capability checks. */
  operationalRole: AppRole;
  /** Separate from operational role so a finance hat never becomes a GM. */
  seesFinancials: boolean;
  /** False for read-only normalized profiles even when their role has tools. */
  hotelMutationAllowed: boolean;
  /** Organization capability, kept separate from hotel operational capacity. */
  portfolioIntelligenceRead: boolean;
  /** Only entitlements from the winning authority class are included. */
  entitlements: AuthoritativePropertyEntitlement[];
}

const DIRECT_PROPERTY_HAT_ROLES = new Set<HatRole>([
  'general_manager',
  'front_desk',
  'housekeeping',
  'maintenance',
]);

export type AuthoritativeHotelLeadershipRole = 'owner' | 'general_manager';

/**
 * Mirrors the direct-account contract in 0411 from the already-normalized
 * standing DTO. This deliberately does not inspect managementSurface: 0424
 * projects normalized property hats, grants, and valid bridges as
 * company_access for the access-management routes.
 */
export function authoritativeStandingHasDirectHotelAccount(
  standing: AuthoritativePropertyStanding | null,
): boolean {
  return Boolean(standing?.entitlements.some((entitlement) => {
    if (entitlement.kind === 'legacy' || entitlement.kind === 'legacy_bridge') return true;
    if (entitlement.kind === 'membership_hat') {
      return entitlement.scopeType === 'property'
        && entitlement.staxisRole !== null
        && DIRECT_PROPERTY_HAT_ROLES.has(entitlement.staxisRole);
    }
    return entitlement.kind === 'access_grant' && entitlement.scopeType === 'property';
  }));
}

/** Resolve only an active, hotel-specific Owner/GM standing for UI copy. */
export function authoritativeHotelLeadershipRole(
  standing: AuthoritativePropertyStanding | null,
  accountRole: AppRole,
): AuthoritativeHotelLeadershipRole | null {
  if (!authoritativeStandingHasDirectHotelAccount(standing)) return null;
  if (standing?.entitlements.some((entitlement) => (
    entitlement.kind === 'membership_hat'
    && entitlement.scopeType === 'property'
    && entitlement.staxisRole === 'general_manager'
  ))) return 'general_manager';
  if (standing?.entitlements.some((entitlement) => (
    entitlement.kind === 'access_grant'
    && entitlement.scopeType === 'property'
    && entitlement.accessProfile === 'property_manager'
  ))) return 'general_manager';
  if (standing?.entitlements.some((entitlement) => (
    entitlement.kind === 'access_grant'
    && entitlement.scopeType === 'property'
    && entitlement.accessProfile === 'organization_owner'
  ))) return 'owner';
  if (standing?.entitlements.some((entitlement) => (
    entitlement.kind === 'legacy' || entitlement.kind === 'legacy_bridge'
  ))) {
    return accountRole === 'owner' || accountRole === 'general_manager'
      ? accountRole
      : null;
  }
  return null;
}

function sortedUniqueUuidArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(isUuid)) return null;
  if (new Set(value).size !== value.length) return null;
  const sorted = [...value].sort();
  return value.every((id, index) => id === sorted[index]) ? sorted : null;
}

const ENTITLEMENT_KINDS = new Set<AuthoritativeEntitlementKind>([
  'legacy',
  'legacy_bridge',
  'membership_hat',
  'access_grant',
]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function nullableUuid(value: unknown): string | null | undefined {
  if (value === null) return null;
  return isUuid(value) ? value : undefined;
}

function parseEntitlement(value: unknown): AuthoritativePropertyEntitlement | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind as AuthoritativeEntitlementKind;
  const organizationId = nullableUuid(raw.organizationId);
  const membershipId = nullableUuid(raw.membershipId);
  const portfolioId = nullableUuid(raw.portfolioId);
  if (!ENTITLEMENT_KINDS.has(kind)
    || !isUuid(raw.entitlementId)
    || organizationId === undefined
    || membershipId === undefined
    || portfolioId === undefined
    || !(raw.accessProfile === null || isAccessProfile(raw.accessProfile))
    || !(raw.staxisRole === null || isHatRole(raw.staxisRole))
    || !(raw.scopeType === null
      || raw.scopeType === 'company'
      || isAccessScopeType(raw.scopeType))) return null;

  // Each source has a closed shape. Reject a DTO that combines fields from
  // different authority classes; accepting it would make downstream auditing
  // ambiguous even if the property id itself were valid.
  if (kind === 'membership_hat'
    && (raw.staxisRole === null
      || raw.accessProfile !== null
      || (raw.scopeType !== 'company' && raw.scopeType !== 'property')
      || membershipId === null)) return null;
  if (kind === 'access_grant'
    && (raw.accessProfile === null
      || raw.staxisRole !== null
      || raw.scopeType === null
      || raw.scopeType === 'company'
      || membershipId === null)) return null;
  if ((kind === 'legacy' || kind === 'legacy_bridge')
    && (raw.accessProfile !== null || raw.staxisRole !== null)) return null;

  return {
    kind,
    entitlementId: raw.entitlementId,
    organizationId,
    membershipId,
    accessProfile: raw.accessProfile as AccessProfile | null,
    staxisRole: raw.staxisRole as HatRole | null,
    scopeType: raw.scopeType as AccessScopeType | 'company' | null,
    portfolioId,
  };
}

function parsePropertyStandings(value: unknown): AuthoritativePropertyStanding[] | null {
  if (!Array.isArray(value)) return null;
  const out: AuthoritativePropertyStanding[] = [];
  let previousPropertyId = '';
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const raw = entry as Record<string, unknown>;
    if (!isUuid(raw.propertyId)
      || raw.propertyId <= previousPropertyId
      || !isValidRole(raw.operationalRole)
      || raw.operationalRole === 'admin'
      || typeof raw.seesFinancials !== 'boolean'
      || typeof raw.hotelMutationAllowed !== 'boolean'
      || typeof raw.portfolioIntelligenceRead !== 'boolean'
      || !Array.isArray(raw.entitlements)
      || raw.entitlements.length === 0) return null;
    const entitlements = raw.entitlements.map(parseEntitlement);
    if (entitlements.some((item) => item === null)) return null;
    out.push({
      propertyId: raw.propertyId,
      operationalRole: raw.operationalRole,
      seesFinancials: raw.seesFinancials,
      hotelMutationAllowed: raw.hotelMutationAllowed,
      portfolioIntelligenceRead: raw.portfolioIntelligenceRead,
      entitlements: entitlements as AuthoritativePropertyEntitlement[],
    });
    previousPropertyId = raw.propertyId;
  }
  return out;
}

/** Return the atomic capacity attached to a hotel in an authoritative DTO. */
export function authoritativeStandingForProperty(
  access: AuthoritativePropertyAccess,
  propertyId: string,
): AuthoritativePropertyStanding | null {
  if (!isUuid(propertyId)) return null;
  if (access.all) {
    return {
      propertyId,
      operationalRole: 'admin',
      seesFinancials: true,
      hotelMutationAllowed: true,
      portfolioIntelligenceRead: true,
      entitlements: [],
    };
  }
  return access.propertyStandings.find((standing) => standing.propertyId === propertyId) ?? null;
}

/** Server compatibility DTO used by hotel-mode routes and mirrored by RLS. */
export async function listAuthoritativePropertyAccess(
  accountId: string,
): Promise<AuthoritativePropertyAccess | null> {
  if (!isUuid(accountId)) return null;
  try {
    const { data, error } = await supabaseAdmin.rpc(
      'staxis_list_account_authorized_properties',
      { p_account_id: accountId },
    );
    if (error || data === null || typeof data !== 'object' || Array.isArray(data)) return null;
    const raw = data as Record<string, unknown>;
    const authorityMode = String(raw.authorityMode) as AuthorityMode;
    if (raw.ok !== true
      || typeof raw.all !== 'boolean'
      || !AUTHORITY_MODES_SET.has(authorityMode)
      || typeof raw.authorityVersion !== 'number'
      || !Number.isSafeInteger(raw.authorityVersion)
      || raw.authorityVersion <= 0
      || typeof raw.effectiveAccessHash !== 'string'
      || !SHA256_HEX.test(raw.effectiveAccessHash)) return null;
    const propertyIds = sortedUniqueUuidArray(raw.propertyIds);
    const legacyPropertyIds = sortedUniqueUuidArray(raw.legacyPropertyIds);
    const membershipPropertyIds = sortedUniqueUuidArray(raw.membershipPropertyIds);
    const propertyStandings = parsePropertyStandings(raw.propertyStandings);
    if (!propertyIds || !legacyPropertyIds || !membershipPropertyIds || !propertyStandings) return null;
    const propertySet = new Set(propertyIds);
    if (!raw.all && [...legacyPropertyIds, ...membershipPropertyIds]
      .some((id) => !propertySet.has(id))) return null;
    if (raw.all) {
      if (propertyIds.length > 0
        || legacyPropertyIds.length > 0
        || membershipPropertyIds.length > 0
        || propertyStandings.length > 0) return null;
    } else if (!sameStringArray(
      propertyStandings.map((standing) => standing.propertyId),
      propertyIds,
    )) return null;
    return {
      all: raw.all,
      authorityMode,
      authorityVersion: raw.authorityVersion,
      effectiveAccessHash: raw.effectiveAccessHash,
      propertyIds,
      legacyPropertyIds,
      membershipPropertyIds,
      propertyStandings,
    };
  } catch {
    return null;
  }
}

interface StructuralMembershipRow {
  id: string;
  organization_id: string;
  account_id: string;
  membership_scope: string | null;
  staxis_role: string | null;
  covered_property_ids: string[] | null;
  status: string;
  starts_at: string;
  ended_at: string | null;
}

interface StructuralAuthorizationStateRow {
  account_id: string;
  authority_mode: string;
}

interface StructuralGrantRow {
  organization_id: string;
  membership_id: string;
  scope_type: string;
  property_id: string | null;
  property_relationship_id: string | null;
  source: string;
  status: string;
  starts_at: string;
  expires_at: string | null;
}

interface StructuralBridgeRow {
  account_id: string;
  property_id: string;
  cutover_organization_id: string | null;
  cutover_relationship_id: string | null;
  status: string;
}

interface StructuralOrganizationRow {
  id: string;
  status: string;
  organization_type: string;
}

interface StructuralRelationshipRow {
  id: string;
  organization_id: string;
  property_id: string;
  relationship_type: string;
  is_primary_grouping: boolean;
  starts_at: string;
  ends_at: string | null;
}

function currentStructuralWindow(startsAt: string, endsAt: string | null, nowMs: number): boolean {
  const startsMs = Date.parse(startsAt);
  const endsMs = endsAt === null ? null : Date.parse(endsAt);
  return Number.isFinite(startsMs)
    && startsMs <= nowMs
    && (endsMs === null || (Number.isFinite(endsMs) && endsMs > nowMs));
}

/**
 * The operational access RPC intentionally resolves one winning authority
 * class and excludes inactive accounts. The first-person guard in 0411 is a
 * different OR contract: any normalized property-scope hat or grant, or a
 * valid bridge claims the hotel, even when a separate company-scope
 * entitlement wins the effective standing and even when the account itself is
 * inactive. Reuse those canonical tables for this bounded admin People
 * projection so the UI can fail closed without changing access authority or
 * managementSurface.
 */
export async function listAuthoritativeStructuralHotelDirectness(
  accountIds: readonly string[],
  propertyId: string,
): Promise<Map<string, boolean | null>> {
  const ids = [...new Set(accountIds)];
  const unresolved = (): Map<string, boolean | null> => new Map(ids.map((accountId) => [accountId, null]));
  if (!isUuid(propertyId)) return unresolved();
  if (ids.some((accountId) => !isUuid(accountId))) return unresolved();
  if (ids.length === 0) return new Map();

  try {
    const [
      authorizationStateResult,
      membershipResult,
      bridgeResult,
      relationshipResult,
    ] = await Promise.all([
      supabaseAdmin
        .from('account_authorization_state')
        .select('account_id, authority_mode')
        .in('account_id', ids),
      supabaseAdmin
        .from('organization_memberships')
        .select('id, organization_id, account_id, membership_scope, staxis_role, covered_property_ids, status, starts_at, ended_at')
        .in('account_id', ids),
      supabaseAdmin
        .from('account_property_authorization_bridges')
        .select('account_id, property_id, cutover_organization_id, cutover_relationship_id, status')
        .in('account_id', ids)
        .eq('property_id', propertyId)
        .eq('status', 'active'),
      supabaseAdmin
        .from('organization_property_relationships')
        .select('id, organization_id, property_id, relationship_type, is_primary_grouping, starts_at, ends_at')
        .eq('property_id', propertyId),
    ]);
    if (authorizationStateResult.error
      || membershipResult.error
      || bridgeResult.error
      || relationshipResult.error) return unresolved();

    const authorizationStates = (authorizationStateResult.data ?? []) as StructuralAuthorizationStateRow[];
    const authorizationStateByAccountId = new Map(
      authorizationStates.map((state) => [state.account_id, state]),
    );

    const memberships = (membershipResult.data ?? []) as StructuralMembershipRow[];
    const bridges = (bridgeResult.data ?? []) as StructuralBridgeRow[];
    const relationships = (relationshipResult.data ?? []) as StructuralRelationshipRow[];
    const membershipIds = [...new Set(memberships.map((membership) => membership.id))];
    const organizationIds = [...new Set(memberships.map((membership) => membership.organization_id))];

    const [grantResult, organizationResult] = await Promise.all([
      membershipIds.length > 0
        ? supabaseAdmin
          .from('organization_access_grants')
          .select('organization_id, membership_id, scope_type, property_id, property_relationship_id, source, status, starts_at, expires_at')
          .in('membership_id', membershipIds)
          .eq('scope_type', 'property')
          .eq('property_id', propertyId)
        : Promise.resolve({ data: [], error: null }),
      organizationIds.length > 0
        ? supabaseAdmin
          .from('organizations')
          .select('id, status, organization_type')
          .in('id', organizationIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (grantResult.error || organizationResult.error) return unresolved();

    const nowMs = Date.now();
    const liveOrganizations = new Set(
      ((organizationResult.data ?? []) as StructuralOrganizationRow[])
        .filter((organization) => (
          organization.status === 'active'
          && organization.organization_type !== 'single_hotel'
        ))
        .map((organization) => organization.id),
    );
    const activeMemberships = memberships.filter((membership) => (
      membership.status === 'active'
      && membership.ended_at === null
      && currentStructuralWindow(membership.starts_at, membership.ended_at, nowMs)
      && liveOrganizations.has(membership.organization_id)
    ));
    const membershipById = new Map(activeMemberships.map((membership) => [membership.id, membership]));
    const currentPrimaryRelationships = relationships.filter((relationship) => (
      relationship.is_primary_grouping
      && (relationship.relationship_type === 'operator' || relationship.relationship_type === 'owner')
      && currentStructuralWindow(relationship.starts_at, relationship.ends_at, nowMs)
    ));
    const primaryRelationship = currentPrimaryRelationships.length === 1
      ? currentPrimaryRelationships[0]
      : null;
    const grants = (grantResult.data ?? []) as StructuralGrantRow[];

    const direct = unresolved();
    for (const accountId of ids) {
      const authorityMode = authorizationStateByAccountId.get(accountId)?.authority_mode;
      if (!['legacy', 'shadow', 'normalized'].includes(authorityMode ?? '')) continue;
      direct.set(accountId, false);
    }
    const normalizedAccountIds = new Set(
      ids.filter((accountId) => (
        authorizationStateByAccountId.get(accountId)?.authority_mode === 'normalized'
      )),
    );
    for (const membership of activeMemberships) {
      if (!normalizedAccountIds.has(membership.account_id)) continue;
      if (membership.membership_scope !== 'property'
        || !['general_manager', 'front_desk', 'housekeeping', 'maintenance'].includes(
          membership.staxis_role ?? '',
        )
        || !membership.covered_property_ids?.includes(propertyId)
        || !primaryRelationship
        || primaryRelationship.organization_id !== membership.organization_id) continue;
      const current = direct.get(membership.account_id);
      if (current !== false && current !== true) continue;
      direct.set(membership.account_id, true);
    }
    for (const grant of grants) {
      const membership = membershipById.get(grant.membership_id);
      if (!membership
        || !normalizedAccountIds.has(membership.account_id)
        || grant.organization_id !== membership.organization_id
        || grant.scope_type !== 'property'
        || grant.property_id !== propertyId
        || grant.property_relationship_id !== primaryRelationship?.id
        || grant.status !== 'active'
        || grant.source === 'legacy_backfill'
        || !currentStructuralWindow(grant.starts_at, grant.expires_at, nowMs)) continue;
      const current = direct.get(membership.account_id);
      if (current !== false && current !== true) continue;
      direct.set(membership.account_id, true);
    }
    for (const bridge of bridges) {
      if (!normalizedAccountIds.has(bridge.account_id)) continue;
      const valid = bridge.cutover_relationship_id === null
        ? currentPrimaryRelationships.length === 0
        : currentPrimaryRelationships.length === 1
          && currentPrimaryRelationships[0]?.id === bridge.cutover_relationship_id
          && currentPrimaryRelationships[0]?.organization_id === bridge.cutover_organization_id;
      const current = direct.get(bridge.account_id);
      if (valid && (current === false || current === true)) direct.set(bridge.account_id, true);
    }
    return direct;
  } catch {
    return unresolved();
  }
}

async function findCanonicalPropertyAccount(
  propertyId: string,
  candidates: Array<{ id: string }>,
): Promise<string | null> {
  for (const account of candidates) {
    const access = await listAuthoritativePropertyAccess(account.id);
    if (access && (access.all || access.propertyIds.includes(propertyId))) {
      return account.id;
    }
  }
  return null;
}

async function loadActiveManagers(): Promise<Array<{ id: string }> | null> {
  const { data: managers, error } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('active', true)
    .in('role', ['owner', 'general_manager', 'admin'])
    .order('id')
    .limit(5000);
  return error || !managers ? null : managers;
}

/** Findings attribution retains its historical manager/admin-only contract. */
export async function findAuthoritativeManagerAccount(
  propertyId: string,
): Promise<string | null> {
  if (!isUuid(propertyId)) return null;
  const managers = await loadActiveManagers();
  return managers ? findCanonicalPropertyAccount(propertyId, managers) : null;
}

/**
 * Find one active representative for memory consolidation. Its any-active
 * fallback is intentionally broader than findings attribution and preserves
 * the pre-Stage-B memory ledger behavior.
 */
export async function findAuthoritativeRepresentativeAccount(
  propertyId: string,
): Promise<string | null> {
  if (!isUuid(propertyId)) return null;
  const managers = await loadActiveManagers();
  if (!managers) return null;
  const managerMatch = await findCanonicalPropertyAccount(propertyId, managers);
  if (managerMatch) return managerMatch;

  const { data: anyActive, error: anyActiveError } = await supabaseAdmin
    .from('accounts')
    .select('id')
    .eq('active', true)
    .order('id')
    .limit(5000);
  if (anyActiveError || !anyActive) return null;
  return findCanonicalPropertyAccount(propertyId, anyActive);
}

const AUTHORITY_MODES_SET = new Set<AuthorityMode>(['legacy', 'shadow', 'normalized']);

interface PropertyMetadataRow {
  id: string;
  name: string | null;
  region: string | null;
  total_rooms: number | null;
  timezone: string | null;
  business_date_cutoff_hour: number | null;
}

export interface AuthorizedPropertyMetadata {
  propertyId: string;
  name: string | null;
  region: string | null;
  totalRooms: number | null;
  timezone: string | null;
  businessDateCutoffHour: number;
  portfolioIds: string[];
  regionIds: string[];
}

export type AuthorizedPropertyMetadataResult =
  | {
    ok: true;
    receipt: AuthorizationScopeReceipt;
    properties: AuthorizedPropertyMetadata[];
    /** Deleted/unreadable rows are explicit; callers must disclose partial coverage. */
    missingPropertyIds: string[];
  }
  | { ok: false; reason: AuthorizationScopeRefusal };

/**
 * Load names and business-calendar metadata for a freshly asserted receipt.
 * The database predicate is built exclusively from the canonical receipt, not
 * route/client input, and complete paginated reads prevent silent truncation.
 */
export async function loadAuthorizedPropertyMetadata(input: {
  receipt: AuthorizationScopeReceipt;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<AuthorizedPropertyMetadataResult> {
  if (input.signal?.aborted || (input.deadlineAt !== undefined && input.deadlineAt <= Date.now())) {
    return { ok: false, reason: 'store_unavailable' };
  }
  const asserted = await assertAuthorizationScopeReceipt({
    receiptId: input.receipt.id,
    accountId: input.receipt.accountId,
  });
  if (!asserted.ok) return asserted;
  if (asserted.receipt.scopeHash !== input.receipt.scopeHash
    || asserted.receipt.authorizationHash !== input.receipt.authorizationHash) {
    return { ok: false, reason: 'scope_changed' };
  }

  try {
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    const remainingMs = input.deadlineAt === undefined
      ? null
      : Math.max(0, input.deadlineAt - Date.now());
    const timer = remainingMs === null
      ? null
      : setTimeout(() => controller.abort(new Error('authorized metadata deadline exceeded')), remainingMs);
    if (remainingMs === 0) controller.abort(new Error('authorized metadata deadline exceeded'));
    let rows: PropertyMetadataRow[];
    try {
      rows = await readCompleteCompanyIdChunks<PropertyMetadataRow>(
        asserted.receipt.authorizedPropertyIds,
        (chunk, from, to) => {
          if (controller.signal.aborted) {
            return Promise.reject(new Error('authorized metadata request interrupted'));
          }
          return supabaseAdmin
            .from('properties')
            .select('id, name, region, total_rooms, timezone, business_date_cutoff_hour', { count: 'exact' })
            .in('id', [...chunk])
            .order('id')
            .range(from, to)
            .abortSignal(controller.signal) as unknown as PromiseLike<CompanyProjectionPage<PropertyMetadataRow>>;
        },
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
    // Close the read/assert TOCTOU window before any metadata is returned. A
    // revocation during pagination may have caused service-side reads, but no
    // stale hotel name/topology crosses the response boundary.
    const reasserted = await assertAuthorizationScopeReceipt({
      receiptId: asserted.receipt.id,
      accountId: asserted.receipt.accountId,
    });
    if (!reasserted.ok) return reasserted;
    if (reasserted.receipt.scopeHash !== asserted.receipt.scopeHash
      || reasserted.receipt.authorizationHash !== asserted.receipt.authorizationHash) {
      return { ok: false, reason: 'scope_changed' };
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const portfolioIdsByProperty = new Map<string, string[]>();
    const regionIdsByProperty = new Map<string, string[]>();
    for (const portfolio of reasserted.receipt.portfolioCatalog) {
      for (const propertyId of portfolio.propertyIds) {
        const ids = portfolioIdsByProperty.get(propertyId) ?? [];
        ids.push(portfolio.portfolioId);
        portfolioIdsByProperty.set(propertyId, ids);
        if (portfolio.portfolioType === 'region') {
          const regionIds = regionIdsByProperty.get(propertyId) ?? [];
          regionIds.push(portfolio.portfolioId);
          regionIdsByProperty.set(propertyId, regionIds);
        }
      }
    }

    const properties: AuthorizedPropertyMetadata[] = [];
    const missingPropertyIds: string[] = [];
    for (const propertyId of reasserted.receipt.authorizedPropertyIds) {
      const row = byId.get(propertyId);
      if (!row) {
        missingPropertyIds.push(propertyId);
        continue;
      }
      const cutoff = Number.isInteger(row.business_date_cutoff_hour)
        && Number(row.business_date_cutoff_hour) >= 0
        && Number(row.business_date_cutoff_hour) <= 6
        ? Number(row.business_date_cutoff_hour)
        : 0;
      properties.push({
        propertyId,
        name: row.name,
        region: row.region,
        totalRooms: Number.isInteger(row.total_rooms) && Number(row.total_rooms) >= 0
          ? Number(row.total_rooms)
          : null,
        timezone: row.timezone,
        businessDateCutoffHour: cutoff,
        portfolioIds: [...new Set(portfolioIdsByProperty.get(propertyId) ?? [])].sort(),
        regionIds: [...new Set(regionIdsByProperty.get(propertyId) ?? [])].sort(),
      });
    }
    return { ok: true, receipt: reasserted.receipt, properties, missingPropertyIds };
  } catch {
    return { ok: false, reason: 'store_unavailable' };
  }
}
