/**
 * GET /api/pms/feed-status?pid=<uuid> (feat/cua-partial-promotion)
 *
 * Per-property, per-feed PMS trust for SESSION surfaces (dashboard tiles,
 * housekeeping Schedule tab) via the useFeedStatus hook. The robot may have
 * gone live with only some feeds learned (promote_partial); consumers use
 * this to render "still learning" instead of confident zeros.
 *
 * PUBLIC pages (housekeeper / laundry SMS links) deliberately do NOT call
 * this route — they have no Staxis session. Their feed status rides their
 * existing capability-checked responses as a `feedStatus` sibling key
 * (/api/housekeeper/rooms, /api/laundry/bootstrap).
 *
 * Read-only, cheap (30s server cache in pms-feed-status-server), fails safe
 * to "render as today".
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { getPropertyFeedStatus } from '@/lib/pms-feed-status-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const pid = pidV.value!;

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    log.warn('[pms/feed-status] forbidden — user lacks property access', {
      requestId, userId: auth.userId, pid,
    });
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  const feedStatus = await getPropertyFeedStatus(pid);
  return ok(feedStatus, { requestId });
}
