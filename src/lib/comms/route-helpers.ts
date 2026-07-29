// ═══════════════════════════════════════════════════════════════════════════
// Communications — shared helpers for the AUTHENTICATED /api/comms/* routes.
//
// One call resolves: a valid Supabase session (2FA-enforced), property access,
// the caller's staff identity in that property, and their role/department.
// Floor-staff (housekeeper) routes use gateHousekeeperRequest instead.
// ═══════════════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { resolveAccount, resolveStaffIdForAccount, getStaffRow, isManagerRole } from './core';
import type { CommsLang } from './types';
import {
  authoritativeStandingForProperty,
  listAuthoritativePropertyAccess,
  type AuthoritativePropertyAccess,
  type AuthoritativePropertyStanding,
} from '@/lib/authorization/server';

export interface CommsCtx {
  ok: true;
  pid: string;
  userId: string;
  accountId: string;
  role: string;
  staffId: string;
  displayName: string;
  isManager: boolean;
  dept: string | null;
  lang: CommsLang;
  /** The caller's property scope (UUIDs, or '*' wildcard). Drives org-wide reach. */
  propertyAccess: string[];
  hotelMutationAllowed: boolean;
  requestId: string;
  headers: Record<string, string>;
}

/**
 * The full set of property ids a manager may broadcast an org-wide campaign to.
 * The account id is resolved again on every call. `null` means authorization
 * could not be proven and callers must fail closed; it never means an empty
 * portfolio. This is retained for read-only historical campaign status only —
 * new cross-hotel writes require a separate preview/confirmation contract.
 */
interface AccessiblePropertyDependencies {
  loadAuthority: (accountId: string) => Promise<AuthoritativePropertyAccess | null>;
  loadAllPropertyIds: () => Promise<string[] | null>;
}

const ACCESSIBLE_PROPERTY_DEPENDENCIES: AccessiblePropertyDependencies = {
  loadAuthority: listAuthoritativePropertyAccess,
  loadAllPropertyIds: async () => {
    const { data, error } = await supabaseAdmin
      .from('properties')
      .select('id')
      .order('id', { ascending: true })
      .limit(5_001);
    if (error || !Array.isArray(data) || data.length > 5_000) return null;
    return (data as { id: string }[]).map((row) => row.id);
  },
};

export async function listAccessiblePropertyIds(
  accountId: string,
  overrides: Partial<AccessiblePropertyDependencies> = {},
): Promise<string[] | null> {
  const dependencies = { ...ACCESSIBLE_PROPERTY_DEPENDENCIES, ...overrides };
  const authority = await dependencies.loadAuthority(accountId);
  if (!authority) return null;
  if (authority.all) {
    return dependencies.loadAllPropertyIds();
  }
  return authority.propertyIds;
}

/**
 * Keep the private-local communications boundary independently testable. The
 * callback can create a staff identity, so it is never invoked until current
 * authoritative local operational standing has been proven.
 */
export async function resolvePrivateHotelCommsStaffId(
  standing: Pick<AuthoritativePropertyStanding, 'hotelMutationAllowed'> | null,
  resolve: () => Promise<string>,
): Promise<string | null> {
  if (!standing || standing.hotelMutationAllowed !== true) return null;
  return resolve();
}

/**
 * Authenticate + resolve the caller's messaging context for a property.
 * `pid` is read from the query string (GET) or must be passed explicitly.
 */
export async function commsContext(
  req: NextRequest,
  pidRaw: string | null,
): Promise<CommsCtx | { ok: false; response: NextResponse }> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const pidV = validateUuid(pidRaw, 'pid');
  if (pidV.error) {
    return { ok: false, response: err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers }) };
  }
  const pid = pidV.value!;

  const session = await requireSession(req, { requestId });
  if (!session.ok) return { ok: false, response: session.response };

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) {
    return { ok: false, response: err('property access denied', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers }) };
  }

  // Central policy boundary for every authenticated /api/comms route. Keep it
  // before account/staff resolution because that resolution can create a
  // caller-bound staff identity on first use.
  const sectionGate = await requireSectionEnabled(req, pid, 'communications');
  if (!sectionGate.ok) return { ok: false, response: sectionGate.response };

  const account = await resolveAccount(session.userId);
  if (!account) {
    return { ok: false, response: err('no account', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers }) };
  }

  const standing = authoritativeStandingForProperty(account.authority, pid);
  // Private hotel communications are an operational-local surface: channel
  // rosters, DMs, presence and first-use staff identity creation must not be
  // exposed merely because a company actor can read portfolio/hotel facts.
  // The authoritative projection marks company-only owner/VP/finance and
  // read-only grants as non-mutating; require the explicit local operational
  // standing before resolving (and potentially creating) a staff identity.
  const hotelAccount = standing ? { ...account, role: standing.operationalRole } : null;
  const staffId = await resolvePrivateHotelCommsStaffId(
    standing,
    async () => resolveStaffIdForAccount(pid, hotelAccount!),
  );
  if (!standing || !hotelAccount || !staffId) {
    return { ok: false, response: err('property access denied', { requestId, status: 403, code: ApiErrorCode.Forbidden, headers }) };
  }

  const staffRow = await getStaffRow(pid, staffId);

  return {
    ok: true,
    pid,
    userId: session.userId,
    accountId: account.accountId,
    role: standing.operationalRole,
    staffId,
    displayName: account.displayName,
    isManager: isManagerRole(standing.operationalRole),
    dept: staffRow?.department ?? null,
    lang: account.preferredLanguage,
    propertyAccess: account.propertyAccess,
    hotelMutationAllowed: standing.hotelMutationAllowed,
    requestId,
    headers,
  };
}
