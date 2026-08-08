import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  assertAuthorizationScopeReceipt,
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
  type AuthoritativePropertyAccess,
  type AuthoritativePropertyStanding,
} from '@/lib/authorization/server';
import type { AuthorizationScopeReceipt } from '@/lib/authorization/domain';
import {
  resolveManagementCompanyScopeUncached,
  type ManagementCompanyScopeResult,
} from '@/lib/company/authoritative-scope';
import { commsStaffIdentityId } from '@/lib/comms/identity';
import { validPropertyTimezone } from '@/lib/property-timezone';
import type { MultiHotelLabel } from './multi-hotel-types';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_HOTELS = 500;

export type MultiHotelScopeFailure =
  | 'invalid_request'
  | 'forbidden'
  | 'unavailable'
  | 'scope_changed'
  | 'too_large';

export interface MultiHotelScopeHotel extends MultiHotelLabel {
  standing: AuthoritativePropertyStanding | null;
  /** Existing local identity only. This resolver never inserts or updates. */
  staffId: string | null;
  department: string | null;
  /** More than one exact auth-bound identity was found; this hotel's read is unavailable. */
  identityAmbiguous: boolean;
}

export interface MultiHotelScope {
  accountId: string;
  organizationId: string | null;
  hotels: MultiHotelScopeHotel[];
  authorizedPropertyIds: string[];
  authorityHash: string | null;
  authorityAll: boolean;
  authorizationReceipt: AuthorizationScopeReceipt | null;
}

export type MultiHotelScopeResult =
  | { ok: true; scope: MultiHotelScope }
  | { ok: false; reason: MultiHotelScopeFailure };

interface PropertyRow {
  id: string;
  name: string | null;
  timezone: string | null;
}

interface ExistingStaffRow {
  id: string;
  property_id: string;
  auth_user_id: string | null;
  department: string | null;
  is_active: boolean | null;
}

interface ExistingStaffResolution {
  identities: Map<string, { staffId: string; department: string | null }>;
  ambiguousPropertyIds: Set<string>;
}

export interface ExistingStaffCandidate {
  id: string;
  property_id: string;
  auth_user_id: string | null;
  department: string | null;
  is_active: boolean | null;
}

export type ExistingStaffDecision =
  | { kind: 'identity'; staffId: string; department: string | null }
  | { kind: 'ambiguous' }
  | { kind: 'absent' };

/**
 * Select only an exact existing local identity. This is pure so the aggregate
 * cannot quietly regress to display-name matching or identity creation.
 */
export function chooseExistingStaffIdentity(input: {
  propertyId: string;
  authUserId: string;
  linkedCandidates: readonly ExistingStaffCandidate[];
  authCandidates: readonly ExistingStaffCandidate[];
  legacyCandidate: ExistingStaffCandidate | null;
  deterministicCandidate: ExistingStaffCandidate | null;
}): ExistingStaffDecision {
  const linked = [...new Map(
    input.linkedCandidates
      .filter((row) => row.property_id === input.propertyId && row.is_active !== false)
      .map((row) => [row.id, row]),
  ).values()];
  // A stale property link pointing at another auth user is not a valid
  // identity for this account. Treat it as ambiguous rather than falling
  // through to a different row and silently attributing authored work.
  if (linked.some((row) => row.auth_user_id !== null && row.auth_user_id !== input.authUserId)) {
    return { kind: 'ambiguous' };
  }
  if (linked.length > 1) return { kind: 'ambiguous' };
  if (linked.length === 1) {
    return { kind: 'identity', staffId: linked[0]!.id, department: linked[0]!.department ?? null };
  }

  const auth = [...new Map(
    input.authCandidates
      .filter((row) => row.property_id === input.propertyId
        && row.is_active !== false
        && row.auth_user_id === input.authUserId)
      .map((row) => [row.id, row]),
  ).values()];
  if (auth.length > 1) return { kind: 'ambiguous' };
  if (auth.length === 1) {
    return { kind: 'identity', staffId: auth[0]!.id, department: auth[0]!.department ?? null };
  }

  const legacy = input.legacyCandidate;
  if (legacy
    && legacy.property_id === input.propertyId
    && legacy.is_active !== false
    && (!legacy.auth_user_id || legacy.auth_user_id === input.authUserId)) {
    return { kind: 'identity', staffId: legacy.id, department: legacy.department ?? null };
  }

  const deterministic = input.deterministicCandidate;
  if (deterministic
    && deterministic.property_id === input.propertyId
    && deterministic.is_active !== false
    && deterministic.auth_user_id === input.authUserId) {
    return { kind: 'identity', staffId: deterministic.id, department: deterministic.department ?? null };
  }
  return { kind: 'absent' };
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RX.test(value);
}

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function mapCompanyFailure(result: ManagementCompanyScopeResult): MultiHotelScopeFailure {
  if (result.ok) return 'unavailable';
  if (result.reason === 'scope_too_large') return 'too_large';
  if (result.reason === 'authorization_unavailable') return 'unavailable';
  return 'forbidden';
}

/**
 * Resolve the exact hotel set and labels used by every aggregate read.
 *
 * The browser may provide an organization selection, but it never provides a
 * hotel array. The organization selection is intersected with a fresh signed
 * company receipt; without it we use the current authoritative account
 * projection. Property names/timezones are loaded only after that set exists,
 * and a missing label is an authority failure rather than an empty hotel.
 */
export async function resolveMultiHotelScope(input: {
  accountId: string;
  authUserId: string;
  organizationId?: string | null;
}): Promise<MultiHotelScopeResult> {
  if (!validId(input.accountId) || !validId(input.authUserId)
    || (input.organizationId != null && !validId(input.organizationId))) {
    return { ok: false, reason: 'invalid_request' };
  }

  let propertyIds: string[];
  let authority: AuthoritativePropertyAccess | null = null;
  let receipt: AuthorizationScopeReceipt | null = null;
  let organizationId: string | null = input.organizationId ?? null;

  if (input.organizationId) {
    const company = await resolveManagementCompanyScopeUncached(
      input.accountId,
      input.organizationId,
    );
    if (!company.ok) return { ok: false, reason: mapCompanyFailure(company) };
    propertyIds = sortedUnique(company.access.propertyIds);
    receipt = company.access.authorizationReceipt;
    organizationId = company.access.organizationId;
    if (propertyIds.length === 0) return { ok: false, reason: 'forbidden' };
  } else {
    authority = await listAuthoritativePropertyAccess(input.accountId);
    if (!authority) return { ok: false, reason: 'unavailable' };
    if (authority.all) {
      // Platform-admin reach is authoritative but intentionally carries no
      // property ids. Resolve the complete canonical catalog, bounded.
      const { data, error } = await supabaseAdmin
        .from('properties')
        .select('id')
        .order('id', { ascending: true })
        .limit(MAX_HOTELS + 1);
      if (error || !Array.isArray(data) || data.length > MAX_HOTELS) {
        return { ok: false, reason: error ? 'unavailable' : 'too_large' };
      }
      propertyIds = sortedUnique((data as Array<{ id: string }>).map((row) => row.id));
    } else {
      propertyIds = sortedUnique(authority.propertyIds);
    }
  }

  if (propertyIds.length === 0) return { ok: false, reason: 'forbidden' };
  if (propertyIds.length > MAX_HOTELS) return { ok: false, reason: 'too_large' };

  // The same exact id set drives this query. Do not accept a partially
  // labelled response: hotel identity is part of the trust boundary.
  const { data: propertyRows, error: propertyError } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone')
    .in('id', propertyIds)
    .limit(MAX_HOTELS + 1);
  if (propertyError || !Array.isArray(propertyRows)) return { ok: false, reason: 'unavailable' };
  const propertyMap = new Map(
    (propertyRows as PropertyRow[]).map((row) => [row.id, row]),
  );
  if (propertyMap.size !== propertyIds.length
    || propertyIds.some((id) => {
      const row = propertyMap.get(id);
      return !row || typeof row.name !== 'string' || !row.name.trim();
    })) {
    return { ok: false, reason: 'unavailable' };
  }

  if (!authority) {
    authority = await listAuthoritativePropertyAccess(input.accountId);
    if (!authority) return { ok: false, reason: 'unavailable' };
  }

  const staffByProperty = await resolveExistingStaffByProperty({
    accountId: input.accountId,
    authUserId: input.authUserId,
    propertyIds,
  });
  if (!staffByProperty) return { ok: false, reason: 'unavailable' };

  const hotels = propertyIds.map((propertyId) => {
    const row = propertyMap.get(propertyId)!;
    const identity = staffByProperty.identities.get(propertyId) ?? null;
    return {
      propertyId,
      hotelName: row.name!.trim(),
      timezone: validPropertyTimezone(row.timezone) ?? null,
      standing: authoritativeStandingForProperty(authority!, propertyId),
      staffId: identity?.staffId ?? null,
      department: identity?.department ?? null,
      identityAmbiguous: staffByProperty.ambiguousPropertyIds.has(propertyId),
    } satisfies MultiHotelScopeHotel;
  });

  // An organization receipt proves the requested portfolio, while the
  // account-authority projection provides hotel roles for role/dept filtering.
  // A missing standing is not converted into a permissive role.
  if (input.organizationId && hotels.some((hotel) => !hotel.standing)) {
    return { ok: false, reason: 'scope_changed' };
  }

  return {
    ok: true,
    scope: {
      accountId: input.accountId,
      organizationId,
      hotels,
      authorizedPropertyIds: propertyIds,
      authorityHash: authority.effectiveAccessHash,
      authorityAll: authority.all,
      authorizationReceipt: receipt,
    },
  };
}

/**
 * Read-only local identity resolution. The order mirrors the existing
 * communications resolver but intentionally stops before any claim or insert:
 * explicit account/property link, exact auth-user link, explicit legacy
 * account.staff_id pointer, then an already-existing deterministic id.
 */
export async function resolveExistingStaffByProperty(input: {
  accountId: string;
  authUserId: string;
  propertyIds: readonly string[];
}): Promise<ExistingStaffResolution | null> {
  const ids = sortedUnique(input.propertyIds);
  if (!validId(input.accountId) || !validId(input.authUserId)
    || ids.some((id) => !validId(id))) return null;
  if (ids.length === 0) return { identities: new Map(), ambiguousPropertyIds: new Set() };

  const [links, byAuth, accountRow] = await Promise.all([
    supabaseAdmin
      .from('account_property_staff_links')
      .select('property_id, staff_id')
      .eq('account_id', input.accountId)
      .eq('is_active', true)
      .in('property_id', ids),
    supabaseAdmin
      .from('staff')
      .select('id, property_id, auth_user_id, department, is_active')
      .in('property_id', ids)
      .eq('auth_user_id', input.authUserId)
      .or('is_active.eq.true,is_active.is.null'),
    supabaseAdmin
      .from('accounts')
      .select('staff_id')
      .eq('id', input.accountId)
      .maybeSingle(),
  ]);
  if (links.error || byAuth.error || accountRow.error) return null;

  const candidateIds = new Set<string>();
  for (const row of (links.data ?? []) as Array<{ staff_id?: string | null }>) {
    if (row.staff_id && validId(row.staff_id)) candidateIds.add(row.staff_id);
  }
  for (const row of (byAuth.data ?? []) as ExistingStaffRow[]) candidateIds.add(row.id);
  const legacyStaffId = (accountRow.data as { staff_id?: string | null } | null)?.staff_id ?? null;
  if (legacyStaffId && validId(legacyStaffId)) candidateIds.add(legacyStaffId);
  for (const propertyId of ids) candidateIds.add(commsStaffIdentityId(propertyId, input.accountId));

  const candidateRows = candidateIds.size === 0
    ? { data: [], error: null }
    : await supabaseAdmin
      .from('staff')
      .select('id, property_id, auth_user_id, department, is_active')
      .in('id', [...candidateIds])
      .in('property_id', ids)
      .or('is_active.eq.true,is_active.is.null');
  if (candidateRows.error) return null;

  const rows = (candidateRows.data ?? []) as ExistingStaffRow[];
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const linkedByProperty = new Map<string, ExistingStaffRow[]>();
  for (const row of (links.data ?? []) as Array<{ property_id: string; staff_id: string | null }>) {
    const linked = row.staff_id ? rowById.get(row.staff_id) : null;
    if (validId(row.property_id) && linked?.property_id === row.property_id) {
      const list = linkedByProperty.get(row.property_id) ?? [];
      list.push(linked);
      linkedByProperty.set(row.property_id, list);
    }
  }
  const authByProperty = new Map<string, ExistingStaffRow[]>();
  for (const row of (byAuth.data ?? []) as ExistingStaffRow[]) {
    const list = authByProperty.get(row.property_id) ?? [];
    list.push(row);
    authByProperty.set(row.property_id, list);
  }

  const result = new Map<string, { staffId: string; department: string | null }>();
  const ambiguousPropertyIds = new Set<string>();
  for (const propertyId of ids) {
    const decision = chooseExistingStaffIdentity({
      propertyId,
      authUserId: input.authUserId,
      linkedCandidates: linkedByProperty.get(propertyId) ?? [],
      authCandidates: authByProperty.get(propertyId) ?? [],
      legacyCandidate: legacyStaffId ? rowById.get(legacyStaffId) ?? null : null,
      deterministicCandidate: rowById.get(commsStaffIdentityId(propertyId, input.accountId)) ?? null,
    });
    if (decision.kind === 'ambiguous') {
      ambiguousPropertyIds.add(propertyId);
      continue;
    }
    if (decision.kind === 'identity') result.set(propertyId, decision);
  }
  return { identities: result, ambiguousPropertyIds };
}

export async function multiHotelScopeStillCurrent(scope: MultiHotelScope): Promise<
  { ok: true } | { ok: false; reason: 'unavailable' | 'scope_changed' }
> {
  if (scope.authorizationReceipt) {
    const asserted = await assertAuthorizationScopeReceipt({
      receiptId: scope.authorizationReceipt.id,
      accountId: scope.accountId,
    });
    if (!asserted.ok) {
      return { ok: false, reason: asserted.reason === 'store_unavailable' ? 'unavailable' : 'scope_changed' };
    }
    const receipt = asserted.receipt;
    if (!authorizationReceiptMatches(scope, receipt)) {
      return { ok: false, reason: 'scope_changed' };
    }
    return { ok: true };
  }

  const current = await listAuthoritativePropertyAccess(scope.accountId);
  if (!current) return { ok: false, reason: 'unavailable' };
  if (current.effectiveAccessHash !== scope.authorityHash || current.all !== scope.authorityAll) {
    return { ok: false, reason: 'scope_changed' };
  }
  if (!current.all && JSON.stringify(sortedUnique(current.propertyIds))
      !== JSON.stringify(sortedUnique(scope.authorizedPropertyIds))) {
    return { ok: false, reason: 'scope_changed' };
  }
  if (current.all) {
    const { data, error } = await supabaseAdmin
      .from('properties')
      .select('id')
      .order('id', { ascending: true })
      .limit(MAX_HOTELS + 1);
    if (error || !Array.isArray(data) || data.length > MAX_HOTELS) {
      return { ok: false, reason: 'unavailable' };
    }
    const currentIds = sortedUnique((data as Array<{ id: string }>).map((row) => row.id));
    if (JSON.stringify(currentIds) !== JSON.stringify(sortedUnique(scope.authorizedPropertyIds))) {
      return { ok: false, reason: 'scope_changed' };
    }
  }
  return { ok: true };
}

/** Exact receipt comparison used immediately before aggregate egress. */
export function authorizationReceiptMatches(
  scope: {
    organizationId: string | null;
    authorizedPropertyIds: readonly string[];
    authorizationReceipt: {
      organizationId: string;
      scopeHash: string;
      authorizationHash: string;
      propertyIds: readonly string[];
    } | null;
  },
  receipt: {
    organizationId: string;
    scopeHash: string;
    authorizationHash: string;
    propertyIds: readonly string[];
  },
): boolean {
  const expected = scope.authorizationReceipt;
  if (!expected) return false;
  return receipt.organizationId === scope.organizationId
    && receipt.scopeHash === expected.scopeHash
    && receipt.authorizationHash === expected.authorizationHash
    && JSON.stringify(sortedUnique(receipt.propertyIds))
      === JSON.stringify(sortedUnique(scope.authorizedPropertyIds));
}

export { MAX_HOTELS };
