/**
 * Manager-initiated callout revert — authenticated.
 *
 * POST body: { pid, calloutId, revertReason? }
 *
 * Looks up the callout, confirms it belongs to a property the caller has
 * access to, and runs the revert service. Rooms that the new assignee
 * already started stay with them (the policy lives in
 * @/lib/sick-callout/redistribute-policy.planRevert).
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
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
  calloutId?: unknown;
  revertReason?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const calloutV = validateUuid(body.calloutId, 'calloutId');
  if (calloutV.error) {
    return err(calloutV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
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
  const calloutId = calloutV.value!;

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit(
    'callout-revert',
    hashToRateLimitKey(`${pid}:${auth.userId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Confirm callout belongs to the claimed property.
  const calloutLookup = await supabaseAdmin
    .from('callout_events')
    .select('id, property_id, status')
    .eq('id', calloutId)
    .maybeSingle();
  if (calloutLookup.error) {
    log.error('[housekeeping/callout/revert] lookup failed', {
      requestId, msg: errToString(calloutLookup.error),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!calloutLookup.data) {
    return err('Callout not found', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }
  if (calloutLookup.data.property_id !== pid) {
    return err('Callout/property mismatch', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const result = await revertCallout(supabaseAdmin, {
      calloutId,
      revertedByUserId: auth.userId,
      revertReason,
    });
    try {
      await sendRevertNotifications(supabaseAdmin, result.callout);
    } catch (notifyErr) {
      log.warn('[housekeeping/callout/revert] notification fanout failed', {
        requestId, calloutId,
        err: errToString(notifyErr),
      });
    }
    return ok(
      {
        calloutId,
        returnedCount: result.returnedCount,
        retainedCount: result.retainedCount,
        outcome: result.outcome,
      },
      { requestId },
    );
  } catch (caughtErr) {
    log.error('[housekeeping/callout/revert] unexpected error', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
