/** Pure, transport-independent vocabulary for authoritative request scopes. */

import {
  isAccessProfile,
  isAccessScopeType,
  type AccessProfile,
  type AccessScopeType,
} from '@/lib/organization-access/domain';
import {
  isHatRole,
  scopeAllowsRole,
  type HatRole,
} from '@/lib/company/roles';
import type { AppRole } from '@/lib/roles';

export const AUTHORITY_MODES = ['legacy', 'shadow', 'normalized'] as const;
export type AuthorityMode = (typeof AUTHORITY_MODES)[number];

// ─── Platform-admin standing: ONE principle, stated once ────────────────────
//
// A platform administrator (accounts.role = 'admin') holds a FULL-POWER
// standing at EVERY hotel, always. There is no "look but don't touch" admin
// mode: the product is built and operated by the same person, and an admin who
// opens a hotel gets the same actions its own owner would get.
//
// This is deliberately ONE function rather than a special case sprinkled across
// screens and routes. Both sides of the wire resolve a viewer's standing at a
// hotel through it:
//   • server — `authoritativeStandingForProperty` in ./server.ts, where the
//     admin signal is `access.all` from the authorization resolver.
//   • client — `useActiveHotelStanding` in @/lib/capabilities/useCan, where the
//     admin signal is the verified `platformAdmin` bit from
//     GET /api/auth/session-authorization.
//
// Non-admins are untouched by this file: with `platformAdmin` false the
// resolver is a plain lookup in the standings the server issued, so every
// tenant wall, read-only company grant and per-hotel restriction still decides
// exactly what it decided before.

/** The per-hotel capacity fields every viewer-standing shape shares. */
export interface ViewerHotelStanding {
  propertyId: string;
  operationalRole: AppRole;
  seesFinancials: boolean;
  hotelMutationAllowed: boolean;
  portfolioIntelligenceRead: boolean;
}

/** The standing a platform administrator holds at any hotel. */
export function platformAdminHotelStanding(propertyId: string): ViewerHotelStanding {
  return {
    propertyId,
    operationalRole: 'admin',
    seesFinancials: true,
    hotelMutationAllowed: true,
    portfolioIntelligenceRead: true,
  };
}

/**
 * The viewer's standing at one hotel. Platform admins get the full-power
 * standing above; everyone else gets exactly the standing the server issued for
 * that hotel, or null when they hold none there.
 */
export function resolveViewerHotelStanding<T extends ViewerHotelStanding>(input: {
  platformAdmin: boolean;
  standings: readonly T[] | null | undefined;
  propertyId: string | null | undefined;
}): T | ViewerHotelStanding | null {
  if (!input.propertyId) return null;
  if (input.platformAdmin) return platformAdminHotelStanding(input.propertyId);
  return (input.standings ?? []).find(
    (standing) => standing.propertyId === input.propertyId,
  ) ?? null;
}

// ─── Company-scope standing ─────────────────────────────────────────────────
//
// Company view shows every hotel in the scope at once, so the standing it may
// grant is the standing the viewer holds at EVERY hotel in the scope, never the
// best one they hold at any. A GM who runs one building therefore gains nothing
// by arriving at a company URL: the other buildings answer null and so does
// this.
//
// The ROLE comes from the company hat (owner / vp / finance, degraded through
// `legacyRoleForHat` by the caller), not from the per-hotel projection, because
// at company scope the person is wearing the company job. The per-hotel
// standings are the WALL: they decide whether the scope resolves at all, and
// they decide the money.
//
// `hotelMutationAllowed` is permanently false here. Company scope has no target
// hotel to write to; a later crew adds an explicit, guarded hand-work-in seam
// that resolves one hotel and re-gates there.

/** The viewer's standing across one company scope. */
export interface ViewerCompanyStanding {
  organizationId: string;
  operationalRole: AppRole;
  seesFinancials: boolean;
  /** Always false. Hotel work happens at a hotel. */
  hotelMutationAllowed: false;
  portfolioIntelligenceRead: boolean;
  /** The exact hotels this standing was resolved over. */
  propertyIds: string[];
}

export function resolveViewerCompanyStanding(input: {
  platformAdmin: boolean;
  standings: readonly ViewerHotelStanding[] | null | undefined;
  organizationId: string | null | undefined;
  propertyIds: readonly string[] | null | undefined;
  /** The company hat, already degraded to legacy role vocabulary. */
  companyRole: AppRole | null | undefined;
}): ViewerCompanyStanding | null {
  const organizationId = typeof input.organizationId === 'string'
    ? input.organizationId.toLowerCase()
    : '';
  if (organizationId === '') return null;

  const propertyIds = [...new Set(
    (input.propertyIds ?? [])
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .map((id) => id.toLowerCase()),
  )].sort();
  if (propertyIds.length === 0) return null;

  // Same shared rule as every hotel screen, asked once per hotel in scope.
  const normalized = (input.standings ?? []).map((standing) => ({
    ...standing,
    propertyId: standing.propertyId.toLowerCase(),
  }));
  const held: ViewerHotelStanding[] = [];
  for (const propertyId of propertyIds) {
    const standing = resolveViewerHotelStanding({
      platformAdmin: input.platformAdmin,
      standings: normalized,
      propertyId,
    });
    if (!standing) return null;
    held.push(standing);
  }

  const operationalRole: AppRole | null = input.platformAdmin
    ? 'admin'
    : input.companyRole ?? null;
  if (!operationalRole) return null;

  return {
    organizationId,
    operationalRole,
    seesFinancials: held.every((standing) => standing.seesFinancials === true),
    hotelMutationAllowed: false,
    portfolioIntelligenceRead: held.every(
      (standing) => standing.portfolioIntelligenceRead === true,
    ),
    propertyIds,
  };
}

export type AuthorizationScopeSelector =
  | { type: 'all_authorized' }
  | { type: 'portfolio'; portfolioId: string }
  | { type: 'property_subset'; propertyIds: string[] };

export interface AuthorizedPortfolioCatalogEntry {
  portfolioId: string;
  name: string;
  portfolioType: 'portfolio' | 'region' | 'division' | 'other';
  parentId: string | null;
  /** Hotels assigned directly to this node, intersected with authorization. */
  directPropertyIds: string[];
  /** Direct plus every cycle-safe active descendant, intersected with authorization. */
  propertyIds: string[];
}

export type AuthorizationScopeEntitlementKind = 'membership_hat' | 'access_grant';

/**
 * Provenance emitted by the resolver for each selected hotel. Downstream
 * consumers may impose a narrower product gate (for example, an org-wide
 * queue may require company/organization scope), but must never reinterpret
 * an unvalidated RPC object.
 */
export interface AuthorizationScopeEntitlement {
  propertyId: string;
  entitlementKind: AuthorizationScopeEntitlementKind;
  entitlementId: string;
  membershipId: string;
  accessProfile: AccessProfile | null;
  staxisRole: HatRole | null;
  scopeType: AccessScopeType | 'company';
  portfolioId: string | null;
}

export interface AuthorizationScopeProvenance {
  entitlements: AuthorizationScopeEntitlement[];
  governingRelationshipTypes: readonly ['operator', 'owner'];
  /** The authoritative resolver never emits a silently shortened selection. */
  selectionWasTruncated: false;
}

export interface AuthorizationScopeReceipt {
  id: string;
  accountId: string;
  organizationId: string;
  organizationName: string;
  authorityMode: 'normalized';
  selectorType: AuthorizationScopeSelector['type'];
  requestedPortfolioId: string | null;
  requestedPropertyIds: string[];
  /** Complete, exact portfolio-readable universe for this account + organization. */
  authorizedPropertyIds: string[];
  /** Exact subset selected for this question. Never use as the authorization universe. */
  propertyIds: string[];
  authorizedPropertyCount: number;
  selectedPropertyCount: number;
  portfolioCatalog: AuthorizedPortfolioCatalogEntry[];
  accountAuthorizationVersion: number;
  organizationAccessEpoch: number;
  resolverVersion: string;
  /** Selector-independent conversation identity; changes on auth/topology change. */
  authorizationHash: string;
  /** Exact turn scope identity, including selector and selected properties. */
  scopeHash: string;
  provenance: AuthorizationScopeProvenance;
  resolvedAt: string;
  expiresAt: string;
}

export const AUTHORIZATION_SCOPE_REFUSALS = [
  'invalid_request',
  'no_company_job',
  'ambiguous_company',
  'unauthorized_scope',
  'no_hotels',
  'scope_too_large',
  'scope_changed',
  'revoked_or_changed',
  'expired',
  'not_found',
  'store_unavailable',
] as const;
export type AuthorizationScopeRefusal = (typeof AUTHORIZATION_SCOPE_REFUSALS)[number];

export type AuthorizationScopeResult =
  | { ok: true; receipt: AuthorizationScopeReceipt }
  | { ok: false; reason: AuthorizationScopeRefusal };

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RX = /^[0-9a-f]{64}$/;
const PORTFOLIO_TYPES = new Set(['portfolio', 'region', 'division', 'other']);
const REFUSALS = new Set<string>(AUTHORIZATION_SCOPE_REFUSALS);
const MAX_SCOPE_PROPERTIES = 5000;
const MAX_PORTFOLIO_CATALOG = 2000;
const MAX_PROVENANCE_ENTITLEMENTS = 20_000;
const PORTFOLIO_READ_ACCESS_PROFILES = new Set<AccessProfile>([
  'organization_owner',
  'organization_admin',
  'portfolio_manager',
  'property_manager',
]);

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RX.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseSortedUuidArray(value: unknown, maxLength = MAX_SCOPE_PROPERTIES): string[] | null {
  if (!Array.isArray(value) || value.length > maxLength || !value.every(isUuid)) return null;
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) return null;
  const sorted = [...ids].sort();
  if (!ids.every((id, index) => id === sorted[index])) return null;
  return [...ids];
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function parseCatalog(
  value: unknown,
  authorizedPropertyIds: ReadonlySet<string>,
): AuthorizedPortfolioCatalogEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_PORTFOLIO_CATALOG) return null;
  const entries: AuthorizedPortfolioCatalogEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw)
      || !isUuid(raw.portfolioId)
      || typeof raw.name !== 'string'
      || raw.name.trim().length === 0
      || raw.name.trim().length > 160
      || !PORTFOLIO_TYPES.has(String(raw.portfolioType))
      || !(raw.parentId === null || isUuid(raw.parentId))) return null;
    const directPropertyIds = parseSortedUuidArray(raw.directPropertyIds);
    const propertyIds = parseSortedUuidArray(raw.propertyIds);
    if (!directPropertyIds || !propertyIds || propertyIds.length === 0) return null;
    const propertySet = new Set(propertyIds);
    if (propertyIds.some((id) => !authorizedPropertyIds.has(id))
      || directPropertyIds.some((id) => !propertySet.has(id))) return null;
    entries.push({
      portfolioId: raw.portfolioId,
      name: raw.name,
      portfolioType: raw.portfolioType as AuthorizedPortfolioCatalogEntry['portfolioType'],
      parentId: raw.parentId as string | null,
      directPropertyIds,
      propertyIds,
    });
  }
  if (new Set(entries.map((entry) => entry.portfolioId)).size !== entries.length) return null;
  const portfolioIds = new Set(entries.map((entry) => entry.portfolioId));
  if (entries.some((entry) => entry.parentId !== null && !portfolioIds.has(entry.parentId))) {
    return null;
  }
  const parentById = new Map(entries.map((entry) => [entry.portfolioId, entry.parentId]));
  for (const entry of entries) {
    const path = new Set<string>();
    let cursor: string | null = entry.portfolioId;
    while (cursor !== null) {
      if (path.has(cursor)) return null;
      path.add(cursor);
      cursor = parentById.get(cursor) ?? null;
    }
  }
  const sorted = [...entries].sort((left, right) => left.portfolioId.localeCompare(right.portfolioId));
  if (!entries.every((entry, index) => entry.portfolioId === sorted[index]?.portfolioId)) return null;
  return entries;
}

function parseProvenance(
  value: unknown,
  selectedPropertyIds: ReadonlySet<string>,
): AuthorizationScopeProvenance | null {
  if (!isRecord(value)
    || value.selectionWasTruncated !== false
    || !Array.isArray(value.governingRelationshipTypes)
    || value.governingRelationshipTypes.length !== 2
    || value.governingRelationshipTypes[0] !== 'operator'
    || value.governingRelationshipTypes[1] !== 'owner'
    || !Array.isArray(value.entitlements)
    || value.entitlements.length === 0
    || value.entitlements.length > MAX_PROVENANCE_ENTITLEMENTS) return null;

  const entitlements: AuthorizationScopeEntitlement[] = [];
  const representedProperties = new Set<string>();
  let previousKey = '';
  for (const candidate of value.entitlements) {
    if (!isRecord(candidate)
      || !isUuid(candidate.propertyId)
      || !selectedPropertyIds.has(candidate.propertyId)
      || (candidate.entitlementKind !== 'membership_hat'
        && candidate.entitlementKind !== 'access_grant')
      || !isUuid(candidate.entitlementId)
      || !isUuid(candidate.membershipId)
      || !(candidate.portfolioId === null || isUuid(candidate.portfolioId))) return null;

    if (candidate.entitlementKind === 'membership_hat') {
      if (candidate.membershipId !== candidate.entitlementId
        || candidate.accessProfile !== null
        || !isHatRole(candidate.staxisRole)
        || (candidate.scopeType !== 'company' && candidate.scopeType !== 'property')
        || !scopeAllowsRole(candidate.scopeType, candidate.staxisRole)
        || (candidate.scopeType === 'property' && candidate.staxisRole !== 'general_manager')
        || candidate.portfolioId !== null) return null;
    } else if (!isAccessProfile(candidate.accessProfile)
      || !PORTFOLIO_READ_ACCESS_PROFILES.has(candidate.accessProfile)
      || candidate.staxisRole !== null
      || !isAccessScopeType(candidate.scopeType)
      || (candidate.scopeType === 'portfolio') !== (candidate.portfolioId !== null)) {
      return null;
    }

    // SQL emits a stable property/kind/id order. Reject duplicates or a
    // reordered payload rather than silently canonicalizing audit evidence.
    const key = `${candidate.propertyId}\0${candidate.entitlementKind}\0${candidate.entitlementId}`;
    if (key <= previousKey) return null;
    previousKey = key;
    representedProperties.add(candidate.propertyId);
    entitlements.push({
      propertyId: candidate.propertyId,
      entitlementKind: candidate.entitlementKind,
      entitlementId: candidate.entitlementId,
      membershipId: candidate.membershipId,
      accessProfile: candidate.accessProfile as AccessProfile | null,
      staxisRole: candidate.staxisRole as HatRole | null,
      scopeType: candidate.scopeType as AccessScopeType | 'company',
      portfolioId: candidate.portfolioId as string | null,
    });
  }
  if ([...selectedPropertyIds].some((propertyId) => !representedProperties.has(propertyId))) {
    return null;
  }
  return {
    entitlements,
    governingRelationshipTypes: ['operator', 'owner'],
    selectionWasTruncated: false,
  };
}

/** Parse an untrusted RPC payload without repairing it. Any inconsistency closes the door. */
export function parseAuthorizationScopeResult(value: unknown): AuthorizationScopeResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return { ok: false, reason: 'store_unavailable' };
  }
  if (value.ok === false) {
    return typeof value.reason === 'string' && REFUSALS.has(value.reason)
      ? { ok: false, reason: value.reason as AuthorizationScopeRefusal }
      : { ok: false, reason: 'store_unavailable' };
  }
  const raw = value.receipt;
  if (!isRecord(raw)) return { ok: false, reason: 'store_unavailable' };

  const authorizedPropertyIds = parseSortedUuidArray(raw.authorizedPropertyIds);
  const propertyIds = parseSortedUuidArray(raw.propertyIds);
  const requestedPropertyIds = parseSortedUuidArray(raw.requestedPropertyIds);
  if (!authorizedPropertyIds || !propertyIds || !requestedPropertyIds
    || authorizedPropertyIds.length === 0 || propertyIds.length === 0) {
    return { ok: false, reason: 'store_unavailable' };
  }
  const authorized = new Set(authorizedPropertyIds);
  if (propertyIds.some((id) => !authorized.has(id))) {
    return { ok: false, reason: 'store_unavailable' };
  }
  const portfolioCatalog = parseCatalog(raw.portfolioCatalog, authorized);
  if (!portfolioCatalog) return { ok: false, reason: 'store_unavailable' };
  const provenance = parseProvenance(raw.provenance, new Set(propertyIds));
  if (!provenance) return { ok: false, reason: 'store_unavailable' };

  const selectorType = raw.selectorType;
  const selectorShapeValid = selectorType === 'all_authorized'
    ? raw.requestedPortfolioId === null && requestedPropertyIds.length === 0
    : selectorType === 'portfolio'
      ? isUuid(raw.requestedPortfolioId) && requestedPropertyIds.length === 0
      : selectorType === 'property_subset'
        ? raw.requestedPortfolioId === null && requestedPropertyIds.length > 0
        : false;
  if (!selectorShapeValid
    || !isUuid(raw.id)
    || !isUuid(raw.accountId)
    || !isUuid(raw.organizationId)
    || typeof raw.organizationName !== 'string'
    || raw.organizationName.trim().length === 0
    || raw.authorityMode !== 'normalized'
    || raw.authorizedPropertyCount !== authorizedPropertyIds.length
    || raw.selectedPropertyCount !== propertyIds.length
    || !positiveSafeInteger(raw.accountAuthorizationVersion)
    || !positiveSafeInteger(raw.organizationAccessEpoch)
    || typeof raw.resolverVersion !== 'string'
    || raw.resolverVersion.length === 0
    || typeof raw.authorizationHash !== 'string'
    || !HASH_RX.test(raw.authorizationHash)
    || typeof raw.scopeHash !== 'string'
    || !HASH_RX.test(raw.scopeHash)
    || typeof raw.resolvedAt !== 'string'
    || typeof raw.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(raw.resolvedAt))
    || !Number.isFinite(Date.parse(raw.expiresAt))
    || Date.parse(raw.expiresAt) <= Date.parse(raw.resolvedAt)) {
    return { ok: false, reason: 'store_unavailable' };
  }
  const parsedSelectorType = selectorType as AuthorizationScopeSelector['type'];

  if (parsedSelectorType === 'all_authorized'
    && (propertyIds.length !== authorizedPropertyIds.length
      || propertyIds.some((id, index) => id !== authorizedPropertyIds[index]))) {
    return { ok: false, reason: 'store_unavailable' };
  }
  if (parsedSelectorType === 'property_subset'
    && (propertyIds.length !== requestedPropertyIds.length
      || propertyIds.some((id, index) => id !== requestedPropertyIds[index]))) {
    return { ok: false, reason: 'store_unavailable' };
  }
  if (parsedSelectorType === 'portfolio') {
    const selectedPortfolio = portfolioCatalog.find(
      (entry) => entry.portfolioId === raw.requestedPortfolioId,
    );
    if (!selectedPortfolio
      || selectedPortfolio.propertyIds.length !== propertyIds.length
      || selectedPortfolio.propertyIds.some((id, index) => id !== propertyIds[index])) {
      return { ok: false, reason: 'store_unavailable' };
    }
  }

  const resolvedAtMs = Date.parse(raw.resolvedAt as string);
  const expiresAtMs = Date.parse(raw.expiresAt as string);
  if (expiresAtMs - resolvedAtMs > 300_000) {
    return { ok: false, reason: 'store_unavailable' };
  }

  return {
    ok: true,
    receipt: {
      id: raw.id,
      accountId: raw.accountId,
      organizationId: raw.organizationId,
      organizationName: raw.organizationName,
      authorityMode: 'normalized',
      selectorType: parsedSelectorType,
      requestedPortfolioId: raw.requestedPortfolioId as string | null,
      requestedPropertyIds,
      authorizedPropertyIds,
      propertyIds,
      authorizedPropertyCount: raw.authorizedPropertyCount as number,
      selectedPropertyCount: raw.selectedPropertyCount as number,
      portfolioCatalog,
      accountAuthorizationVersion: raw.accountAuthorizationVersion,
      organizationAccessEpoch: raw.organizationAccessEpoch,
      resolverVersion: raw.resolverVersion,
      authorizationHash: raw.authorizationHash,
      scopeHash: raw.scopeHash,
      provenance,
      resolvedAt: raw.resolvedAt,
      expiresAt: raw.expiresAt,
    },
  };
}
