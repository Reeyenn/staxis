/**
 * Housekeeper self-revert of their own sick callout — public route.
 *
 * Same capability + RLS-bypass model as /api/housekeeper/callout. The HK
 * tapped "I CAN come in after all" on their mobile page; we look up
 * their most recent active callout for today and revert it.
 *
 * POST body: { pid, staffId, businessDate, revertReason? }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import {
  validateUuid,
  validateString,
  validateDateStr,
} from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { revertCallout, sendRevertNotifications } from '@/lib/sick-callout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  pid?: unknown;
  staffId?: unknown;
  businessDate?: unknown;
  revertReason?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const dateV = validateDateStr(body.businessDate, {
    label: 'businessDate',
    allowFutureDays: 1,
    allowPastDays: 1,
  });
  if (dateV.error) {
    return err(dateV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  let revertReason: string | null = null;
  if (body.revertReason !== undefined && body.revertReason !== null && body.revertReason !== '') {
    const rV = validateString(body.revertReason, { label: 'revertReason', max: 500 });
    if (rV.error) {
      return err(rV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    revertReason = rV.value ?? null;
  }

  const pid = pidV.value!;
  const staffId = staffV.value!;
  const businessDate = dateV.value!;

  const rl = await checkAndIncrementRateLimit(
    'callout-revert',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  const staffLookup = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffLookup.error) {
    log.error('[housekeeper/callout/revert] staff lookup failed', {
      requestId, msg: errToString(staffLookup.error),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!staffLookup.data) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  const calloutLookup = await supabaseAdmin
    .from('callout_events')
    .select('id')
    .eq('property_id', pid)
    .eq('staff_id', staffId)
    .eq('business_date', businessDate)
    .eq('status', 'active')
    .order('reported_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (calloutLookup.error) {
    log.error('[housekeeper/callout/revert] callout lookup failed', {
      requestId, msg: errToString(calloutLookup.error),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!calloutLookup.data) {
    return err('No active callout to revert', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }

  try {
    const result = await revertCallout(supabaseAdmin, {
      calloutId: calloutLookup.data.id as string,
      revertedByStaffId: staffId,
      revertReason,
    });
    // Notify the receivers their queues are back to normal.
    try {
      await sendRevertNotifications(supabaseAdmin, result.callout);
    } catch (notifyErr) {
      log.warn('[housekeeper/callout/revert] notification fanout failed', {
        requestId, calloutId: result.callout.id,
        err: errToString(notifyErr),
      });
    }
    return ok(
      {
        calloutId: result.callout.id,
        returnedCount: result.returnedCount,
        retainedCount: result.retainedCount,
        outcome: result.outcome,
      },
      { requestId },
    );
  } catch (caughtErr) {
    log.error('[housekeeper/callout/revert] unexpected error', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
