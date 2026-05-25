/**
 * Manager-initiated sick callout — authenticated route.
 *
 * The manager clicked "Mark sick" on a housekeeper card. We require a
 * valid Supabase session and that the caller has access to the property.
 *
 * Same service-layer call as the public housekeeper route — the only
 * differences are auth and the reported_by tag. The redistribute fires
 * inline so the manager sees the team re-spread before the modal closes.
 *
 * POST body: { pid, staffId, businessDate, reason?, note?, leaveTiming? }
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import {
  validateUuid,
  validateString,
  validateEnum,
  validateDateStr,
} from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import {
  createCallout,
  runRedistributionForCallout,
  sendCalloutNotifications,
} from '@/lib/sick-callout';
import type {
  CalloutReason,
  CalloutLeaveTiming,
} from '@/lib/sick-callout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  pid?: unknown;
  staffId?: unknown;
  businessDate?: unknown;
  reason?: unknown;
  note?: unknown;
  leaveTiming?: unknown;
}

const REASON_VALUES = ['sick', 'family', 'personal', 'other'] as const;
const TIMING_VALUES = ['now', 'in_15_min', 'after_current_room'] as const;

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

  let reason: CalloutReason | null = null;
  if (body.reason !== undefined && body.reason !== null && body.reason !== '') {
    const rV = validateEnum(body.reason, REASON_VALUES as unknown as string[], 'reason');
    if (rV.error) {
      return err(rV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    reason = (rV.value ?? null) as CalloutReason | null;
  }
  let leaveTiming: CalloutLeaveTiming | null = null;
  if (body.leaveTiming !== undefined && body.leaveTiming !== null && body.leaveTiming !== '') {
    const tV = validateEnum(body.leaveTiming, TIMING_VALUES as unknown as string[], 'leaveTiming');
    if (tV.error) {
      return err(tV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    leaveTiming = tV.value as CalloutLeaveTiming;
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null && body.note !== '') {
    const nV = validateString(body.note, { label: 'note', max: 500 });
    if (nV.error) {
      return err(nV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    note = nV.value ?? null;
  }

  const pid = pidV.value!;
  const staffId = staffV.value!;
  const businessDate = dateV.value!;

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit(
    'callout-manager',
    hashToRateLimitKey(`${pid}:${auth.userId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Confirm the target staff actually belongs to this property — a manager
  // with property access could otherwise call out a staff in another
  // property by passing the wrong staffId.
  const staffLookup = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffLookup.error) {
    log.error('[housekeeping/callout] staff lookup failed', {
      requestId, msg: errToString(staffLookup.error),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!staffLookup.data) {
    return err('Staff not found at this property', {
      requestId, status: 404, code: ApiErrorCode.NotFound,
    });
  }

  try {
    const result = await createCallout(supabaseAdmin, {
      propertyId: pid,
      staffId,
      businessDate,
      reportedBy: 'manager',
      reportedByUserId: auth.userId,
      reason,
      note,
      leaveTiming,
    });

    let redistributedNow = false;
    if (!leaveTiming || leaveTiming === 'now') {
      try {
        await runRedistributionForCallout(supabaseAdmin, result.calloutId);
        redistributedNow = true;
        try {
          const fresh = await supabaseAdmin
            .from('callout_events')
            .select('*')
            .eq('id', result.calloutId)
            .maybeSingle();
          if (fresh.data) {
            await sendCalloutNotifications(supabaseAdmin, fresh.data);
          }
        } catch (notifyErr) {
          log.warn('[housekeeping/callout] notification fanout failed', {
            requestId, calloutId: result.calloutId,
            err: errToString(notifyErr),
          });
        }
      } catch (redistErr) {
        log.warn('[housekeeping/callout] inline redistribute failed; cron will retry', {
          requestId, calloutId: result.calloutId,
          err: errToString(redistErr),
        });
      }
    }

    return ok(
      {
        calloutId: result.calloutId,
        created: result.created,
        redistributeAt: result.redistributeAt,
        redistributedNow,
      },
      { requestId },
    );
  } catch (caughtErr) {
    log.error('[housekeeping/callout] unexpected error', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
