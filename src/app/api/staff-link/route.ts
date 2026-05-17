/**
 * Staff link minter — admin-only endpoint that returns a magic-link URL
 * for a staff member's housekeeper page.
 *
 * Used by:
 *   • The "Link" / "Copy" buttons on the schedule tab — Maria taps to
 *     get a fresh URL she can paste into a chat or email.
 *   • /api/send-shift-confirmations (server-to-server, no HTTP) — same
 *     module, different caller.
 *
 * Both code paths go through src/lib/staff-auth.ts so the URL Maria
 * sees in the schedule tab is BYTE-IDENTICAL (modulo the one-time
 * token hash) to what gets sent in the SMS. No drift.
 *
 * Auth: Bearer-token Supabase session. Caller must be the property
 * owner; we verify by checking the staff row's property_id matches
 * one the caller owns (via the shared `user_owns_property` SQL helper
 * — same gate every admin write goes through).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { requireSession } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { buildHousekeeperLink } from '@/lib/staff-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  staffId?: unknown;
  pid?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  // 1) Caller must be a logged-in user (Maria / property owner).
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffId = staffV.value!;
  const pid = pidV.value!;

  // 2) Capability check: the staff row must exist on the named property,
  // AND the caller must own that property. The first half is a join
  // through staff; the second is the user_owns_property SQL helper used
  // by every other admin gate.
  const { data: staff, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, property_id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffErr) {
    log.error('[staff-link] staff lookup failed', { err: staffErr, requestId });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  if (!staff) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Ownership check via accounts table. Schema: accounts.data_user_id
  // is the FK to auth.users; accounts.property_access is the uuid[] of
  // properties the account can manage. The shared user_owns_property
  // SQL function used by RLS does the equivalent lookup; we replicate
  // it here in TypeScript so we can return a 403 with a clear message
  // rather than letting RLS silently empty the result.
  const { data: account, error: ownsErr } = await supabaseAdmin
    .from('accounts')
    .select('id, property_access')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  if (ownsErr) {
    log.error('[staff-link] ownership check failed', { err: ownsErr, requestId });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  const propertyAccess = (account?.property_access ?? []) as string[];
  if (!propertyAccess.includes(pid)) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // 3) Mint the link. Use the request's own origin so preview deploys
  // generate preview-scoped URLs; if the production origin should be
  // forced, override here. NextRequest.nextUrl.origin handles both.
  const origin = req.nextUrl.origin || 'https://hotelops-ai.vercel.app';

  try {
    const url = await buildHousekeeperLink(staffId, pid, origin);
    return ok({ url }, { requestId });
  } catch (caughtErr) {
    log.error('[staff-link] mint failed', { err: caughtErr, requestId });
    return err('Failed to mint link', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
