/**
 * GET /api/staff-schedule/alerts?hotelId=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Manager-facing read. Returns open schedule alerts (dismissed_at = NULL,
 * applied_at = NULL) for the given property + date window, newest first.
 * The window defaults to today + next 13 days.
 *
 * Auth: manager session (verifyTeamManager — same gate the rest of
 * /api/staff-schedule/* uses).
 *
 * Rate-limited under the new `schedule-alerts-read` bucket.
 */

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { verifyTeamManager, canManageHotel } from '@/lib/team-auth';
import { validateUuid, validateDateStr } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit, rateLimitedResponse,
} from '@/lib/api-ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req);
  if (!caller) {
    return err('Unauthorized', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }

  const { searchParams } = new URL(req.url);
  const hotelIdCheck = validateUuid(searchParams.get('hotelId'), 'hotelId');
  if (hotelIdCheck.error) {
    return err(hotelIdCheck.error, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }
  const hotelId = hotelIdCheck.value!;
  if (!canManageHotel(caller, hotelId)) {
    return err('Forbidden', {
      requestId, status: 403, code: ApiErrorCode.Unauthorized,
    });
  }

  const rl = await checkAndIncrementRateLimit('schedule-alerts-read', hotelId);
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  // Default window: today → today+13d. Range allowed up to 60 days.
  const fromRaw = searchParams.get('from');
  const toRaw = searchParams.get('to');
  const today = new Date().toISOString().slice(0, 10);
  const dayMs = 24 * 60 * 60 * 1000;
  const fallbackTo = new Date(Date.parse(today) + 13 * dayMs).toISOString().slice(0, 10);

  let fromDate = today;
  let toDate = fallbackTo;
  if (fromRaw) {
    const v = validateDateStr(fromRaw, { label: 'from', allowFutureDays: 90, allowPastDays: 60 });
    if (v.error) {
      return err(v.error, {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    fromDate = v.value!;
  }
  if (toRaw) {
    const v = validateDateStr(toRaw, { label: 'to', allowFutureDays: 120, allowPastDays: 60 });
    if (v.error) {
      return err(v.error, {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    toDate = v.value!;
  }
  if (toDate < fromDate) {
    return err('to must be >= from', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const { data, error } = await supabaseAdmin
    .from('schedule_alerts')
    .select(
      'id, property_id, alert_date, department, severity, gap_minutes, ' +
        'demand_minutes, scheduled_minutes, suggested_action, ' +
        'suggested_savings_cents, trigger_kind, context, created_at',
    )
    .eq('property_id', hotelId)
    .gte('alert_date', fromDate)
    .lte('alert_date', toDate)
    .is('dismissed_at', null)
    .is('applied_at', null)
    .order('alert_date', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) {
    log.error('[alerts:GET] failed', { requestId, msg: errToString(error) });
    return err('Failed to load alerts', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  return ok({
    alerts: rows.map((r) => ({
      id: String(r.id),
      propertyId: String(r.property_id),
      alertDate: String(r.alert_date),
      department: String(r.department),
      severity: String(r.severity),
      gapMinutes: Number(r.gap_minutes),
      demandMinutes: Number(r.demand_minutes),
      scheduledMinutes: Number(r.scheduled_minutes),
      suggestedAction: String(r.suggested_action),
      suggestedSavingsCents: r.suggested_savings_cents == null
        ? null : Number(r.suggested_savings_cents),
      triggerKind: String(r.trigger_kind),
      context: (r.context ?? {}) as Record<string, unknown>,
      createdAt: String(r.created_at),
    })),
    window: { from: fromDate, to: toDate },
  }, { requestId });
}
