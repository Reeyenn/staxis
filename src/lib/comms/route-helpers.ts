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

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  requestId: string;
  headers: Record<string, string>;
}

/**
 * The full set of property ids a manager may broadcast an org-wide campaign to.
 * Admins / '*' wildcard → every property; otherwise the explicit property_access
 * list (UUIDs only). Deriving the target set FROM property_access is itself the
 * access check — a caller can never target a hotel they aren't scoped to.
 */
export async function listAccessiblePropertyIds(role: string, propertyAccess: string[]): Promise<string[]> {
  if (role === 'admin' || propertyAccess.includes('*')) {
    const { data } = await supabaseAdmin.from('properties').select('id').limit(1000);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }
  return propertyAccess.filter((p) => UUID_RX.test(p));
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

  const staffId = await resolveStaffIdForAccount(pid, account);
  const staffRow = await getStaffRow(pid, staffId);

  return {
    ok: true,
    pid,
    userId: session.userId,
    accountId: account.accountId,
    role: account.role,
    staffId,
    displayName: account.displayName,
    isManager: isManagerRole(account.role),
    dept: staffRow?.department ?? null,
    lang: account.preferredLanguage,
    propertyAccess: account.propertyAccess,
    requestId,
    headers,
  };
}
