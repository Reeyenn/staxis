/**
 * GET /api/housekeeping/labor-cost-range
 *   ?propertyId=&fromDate=&toDate=
 *
 * Per-day labor cost over a date range, capped at 31 days. Used by the
 * Performance tab's "this week vs last week" cards + per-housekeeper
 * trendline.
 *
 * Auth: requireSession + property access. Same rate limit bucket as
 * /api/housekeeping/labor-cost (it's the same hot path data-wise).
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { validateUuid } from '@/lib/api-validate';
import { checkAndIncrementRateLimit, hashToRateLimitKey } from '@/lib/api-ratelimit';
import { calculatePropertyRangeCost, MAX_RANGE_DAYS } from '@/lib/cost-tracking';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { canManageTeam, type AppRole } from '@/lib/roles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const url = new URL(req.url);
  const pidV = validateUuid(url.searchParams.get('propertyId'), 'propertyId');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const propertyId = pidV.value!;
  if (!(await userHasPropertyAccess(session.userId, propertyId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  // Manager+ gate (adversarial review M2). Per-staff cost data lets
  // a peer reverse-engineer hourly wages.
  const { data: callerAccount } = await supabaseAdmin
    .from('accounts')
    .select('role')
    .eq('data_user_id', session.userId)
    .maybeSingle();
  const callerRole = callerAccount?.role as AppRole | undefined;
  if (!callerRole || !canManageTeam(callerRole)) {
    log.warn('[labor-cost-range:GET] role gate rejected non-manager', { requestId, role: callerRole });
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const fromDate = url.searchParams.get('fromDate') ?? '';
  const toDate = url.searchParams.get('toDate') ?? '';
  if (!DATE_RX.test(fromDate) || !DATE_RX.test(toDate)) {
    return err('fromDate and toDate must be YYYY-MM-DD', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  if (fromDate > toDate) {
    return err('fromDate must be ≤ toDate', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const days = Math.floor((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) {
    return err(`Range too long — max ${MAX_RANGE_DAYS} days`, {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const rlKey = hashToRateLimitKey(`${session.userId}:${propertyId}`);
  const rl = await checkAndIncrementRateLimit('housekeeping-labor-cost', rlKey);
  if (!rl.allowed) {
    return err('Too many cost refreshes — slow down', {
      requestId, status: 429, code: ApiErrorCode.RateLimited,
      headers: { 'Retry-After': String(rl.retryAfterSec) },
    });
  }

  const result = await calculatePropertyRangeCost({ propertyId, fromDate, toDate });
  if (!result) {
    return err('Failed to load labor cost', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  return ok(result, { requestId });
}
