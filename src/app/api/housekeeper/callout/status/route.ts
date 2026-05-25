/**
 * Housekeeper-facing callout status read — public route.
 *
 * Codex review 2026-05-24, Probe 7: the housekeeper mobile page used to
 * have no way to know whether the visitor had an active callout for the
 * day; the button only flipped to the "active" state if THIS browser
 * tab had submitted the callout. Closing the tab and reopening it lost
 * the active state entirely, so the housekeeper would see the normal
 * "I can't work today" button as if nothing had happened.
 *
 * This route returns the housekeeper's active callout (if any) for a
 * date so the page can seed initial state on mount.
 *
 * Capability: pid + staffId pair (same as the rest of the
 * /api/housekeeper/* surface). No leak across staff or properties.
 *
 * GET ?pid=...&staffId=...&businessDate=YYYY-MM-DD
 * Returns: { ok, requestId, data: { active: { calloutId, reason, leaveTiming } | null } }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { validateUuid, validateDateStr } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);

  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const dateV = validateDateStr(searchParams.get('businessDate'), {
    label: 'businessDate',
    allowFutureDays: 1,
    allowPastDays: 1,
  });
  if (dateV.error) {
    return err(dateV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;
  const staffId = staffV.value!;
  const businessDate = dateV.value!;

  // Rate-limit per (pid, staffId). Same bucket as the other housekeeper
  // public reads — this is a once-per-mount probe, not a tight poll.
  const rl = await checkAndIncrementRateLimit(
    'housekeeper-rooms',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Capability check — staff must belong to the property.
  const staffLookup = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffLookup.error) {
    log.error('[housekeeper/callout/status] staff lookup failed', {
      requestId, msg: errToString(staffLookup.error),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!staffLookup.data) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  // Single active callout for today, if any. The partial unique index
  // on callout_events guarantees at most one row matches.
  const lookup = await supabaseAdmin
    .from('callout_events')
    .select('id, reason, leave_timing, reported_at, reported_by')
    .eq('property_id', pid)
    .eq('staff_id', staffId)
    .eq('business_date', businessDate)
    .eq('status', 'active')
    .maybeSingle();
  if (lookup.error) {
    log.error('[housekeeper/callout/status] callout lookup failed', {
      requestId, msg: errToString(lookup.error),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  if (!lookup.data) {
    return ok({ active: null }, { requestId });
  }
  return ok(
    {
      active: {
        calloutId: lookup.data.id as string,
        reason: lookup.data.reason as string | null,
        leaveTiming: lookup.data.leave_timing as string | null,
        reportedAt: lookup.data.reported_at as string,
        reportedBy: lookup.data.reported_by as string,
      },
    },
    { requestId },
  );
}
