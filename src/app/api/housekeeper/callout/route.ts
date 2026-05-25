/**
 * Housekeeper self-report sick callout — public route, service-role bypass.
 *
 * Same capability model as the other /api/housekeeper/* routes: the SMS
 * link URL contains (pid, staffId) and that pair IS the auth token. We
 * verify staff belongs to property before doing anything, then create the
 * callout via the shared service (which handles idempotency, redistribution
 * scheduling, and the audit log).
 *
 * Redistribution itself runs INLINE for "now" / no leave_timing callouts
 * (so a HK reporting at 7am sees the team re-spread before they log off
 * their phone), and is deferred to the cron processor for in_15_min and
 * after_current_room. Notifications fan out asynchronously after the
 * response is returned — they don't block the housekeeper's tap.
 *
 * POST body:
 *   { pid, staffId, businessDate, reason?, note?, leaveTiming? }
 *
 * Returns: { ok, requestId, data: { calloutId, created, redistributedNow } }
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

  // Rate-limit per (pid, staffId). A real HK reports sick once a day at
  // most; 10/hr accommodates retries on flaky cellular and prevents
  // a leaked SMS link from spamming callouts.
  const rl = await checkAndIncrementRateLimit(
    'callout-housekeeper',
    hashToRateLimitKey(`${pid}:${staffId}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Capability check — staff must belong to property.
  const staffLookup = await supabaseAdmin
    .from('staff')
    .select('id')
    .eq('id', staffId)
    .eq('property_id', pid)
    .maybeSingle();
  if (staffLookup.error) {
    log.error('[housekeeper/callout] staff lookup failed', {
      requestId, msg: errToString(staffLookup.error),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
  if (!staffLookup.data) {
    return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
  }

  try {
    const result = await createCallout(supabaseAdmin, {
      propertyId: pid,
      staffId,
      businessDate,
      reportedBy: 'self',
      reason,
      note,
      leaveTiming,
    });

    // Fire the redistribute INLINE only for the "now" case so the HK sees
    // the team re-spread before walking away. Delayed variants
    // ('in_15_min' / 'after_current_room') wait for the cron tick.
    let redistributedNow = false;
    if (!leaveTiming || leaveTiming === 'now') {
      try {
        await runRedistributionForCallout(supabaseAdmin, result.calloutId);
        redistributedNow = true;
        // Fire notifications best-effort — never block the response on SMS.
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
          log.warn('[housekeeper/callout] notification fanout failed', {
            requestId, calloutId: result.calloutId,
            err: errToString(notifyErr),
          });
        }
      } catch (redistErr) {
        // Don't fail the request — the callout itself is recorded and the
        // cron will retry redistribution.
        log.warn('[housekeeper/callout] inline redistribute failed; cron will retry', {
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
    log.error('[housekeeper/callout] unexpected error', {
      requestId, err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
