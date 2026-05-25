/**
 * GET /api/housekeeping/notices/manager-list?pid=...
 *
 * Manager-side read of active notices. The housekeeper-facing GET on the
 * sibling route requires a (pid, staffId) capability tuple; managers
 * don't have a staffId (their identity is the auth session), so this
 * endpoint exists with `requireSession + userHasPropertyAccess` instead.
 *
 * Returns the same notice rows, minus the per-user dismissal set
 * (managers don't have personal dismissals — the picker UI just lists
 * the active notices so they can delete or unpin).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateUuid } from '@/lib/api-validate';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers,
    });
  }
  const pid = pidV.value!;

  const hasAccess = await userHasPropertyAccess(session.userId, pid);
  if (!hasAccess) {
    return err('property access denied', {
      requestId, status: 403, code: ApiErrorCode.Forbidden, headers,
    });
  }

  const rl = await checkAndIncrementRateLimit(
    'housekeeping-notices-read',
    hashToRateLimitKey(`${pid}:${session.userId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    const nowIso = new Date().toISOString();
    const { data, error: q } = await supabaseAdmin
      .from('housekeeping_notices')
      .select('id, body_en, body_es, body_ht, body_tl, body_vi, pinned, expires_at, posted_at')
      .eq('property_id', pid)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order('pinned', { ascending: false })
      .order('posted_at', { ascending: false })
      .limit(50);
    if (q) throw q;
    return ok({ notices: data ?? [] }, { requestId, headers });
  } catch (caughtErr) {
    log.error('housekeeping/notices/manager-list: GET failed', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError, headers,
    });
  }
}
