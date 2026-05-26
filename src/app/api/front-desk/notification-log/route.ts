/**
 * GET /api/front-desk/notification-log?pid=<uuid>&limit=10
 *
 * Latest N rows from notification_events for the property, most
 * recent first. Used by NotificationLogPanel on /front-desk.
 *
 * Manager-tier only — the body of a dispatch contains room numbers
 * and (sometimes) guest names; this is PII that front-desk staff
 * shouldn't broadly see.
 *
 * Rate-limited via 'front-desk-notification-log' bucket. Polled by
 * the panel every 10s — cap is sized for that polling cadence with
 * multi-tab headroom.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  resolveCallerRole,
  passesFrontDeskGate,
  resolveSmsNotificationMode,
  ROLES_ALLOWED_MANAGER_TIER,
} from '@/lib/front-desk-coordination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const limitRaw = searchParams.get('limit') ?? `${DEFAULT_LIMIT}`;
  const limit = Math.max(1, Math.min(MAX_LIMIT, parseInt(limitRaw, 10) || DEFAULT_LIMIT));

  const callerInfo = await resolveCallerRole(auth.userId);
  if (!passesFrontDeskGate(callerInfo, pid, ROLES_ALLOWED_MANAGER_TIER)) {
    return err('forbidden — manager-tier required', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  const rl = await checkAndIncrementRateLimit(
    'front-desk-notification-log',
    hashToRateLimitKey(`${auth.userId}:${pid}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('notification_events')
      .select(
        'id, event_type, recipient_staff_id, recipient_name, recipient_phone, body, payload, mode, would_have_sent_at, provider_status, error_text',
      )
      .eq('property_id', pid)
      .order('would_have_sent_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);

    const mode = await resolveSmsNotificationMode(pid);

    return ok({
      mode,
      events: (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        return {
          id: r.id as string,
          eventType: r.event_type as string,
          recipientStaffId: (r.recipient_staff_id as string | null) ?? null,
          recipientName: (r.recipient_name as string | null) ?? null,
          recipientPhone: (r.recipient_phone as string | null) ?? null,
          body: r.body as string,
          payload: (r.payload as Record<string, unknown>) ?? {},
          mode: r.mode as 'dry_run' | 'live',
          wouldHaveSentAt: r.would_have_sent_at as string,
          providerStatus: (r.provider_status as string | null) ?? null,
          errorText: (r.error_text as string | null) ?? null,
        };
      }),
    }, { requestId });
  } catch (e) {
    log.error('[front-desk/notification-log] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
