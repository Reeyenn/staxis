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
import { resolveAccount, resolveStaffIdForAccount, getStaffRow, isManagerRole } from './core';
import type { CommsLang } from './types';

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
  requestId: string;
  headers: Record<string, string>;
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
    requestId,
    headers,
  };
}
