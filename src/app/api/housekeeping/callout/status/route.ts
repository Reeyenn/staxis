/**
 * Active-callouts read for the manager banner — authenticated.
 *
 * GET ?pid=...&date=YYYY-MM-DD
 *
 * Returns the banner-ready summary (one entry per active callout with
 * pickups grouped by receiver name). The CalloutBanner component polls
 * this every ~30 seconds so a manager who leaves the tab open sees fresh
 * callouts as they happen.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid, validateDateStr } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { listActiveCalloutsForBanner } from '@/lib/sick-callout';

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
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const dateV = validateDateStr(searchParams.get('date'), {
    label: 'date',
    allowFutureDays: 7,
    allowPastDays: 30,
  });
  if (dateV.error) {
    return err(dateV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;
  const date = dateV.value!;

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit(
    'callout-status',
    hashToRateLimitKey(pid),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    const entries = await listActiveCalloutsForBanner(supabaseAdmin, pid, date);
    return ok({ date, entries }, { requestId });
  } catch (caughtErr) {
    log.error('[housekeeping/callout/status] read failed', {
      requestId, err: errToString(caughtErr),
    });
    // The cleaning_tasks table may not yet exist (feature/cleaning-rules
    // hasn't merged). Treat as empty so the manager UI still loads.
    if (
      caughtErr instanceof Error &&
      /relation .*cleaning_tasks.* does not exist/i.test(caughtErr.message)
    ) {
      return ok({ date, entries: [] }, { requestId });
    }
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
