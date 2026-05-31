// GET /api/compliance/report?pid&from&to
// AI feature #6 (inspector-ready report): the full audit trail of readings +
// PM checks over a date range, grouped for a printable pack. Defaults to the
// last 31 days when from/to omitted.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateDateStr } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString, todayStr, APP_TIMEZONE } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { getReport } from '@/lib/compliance/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const { searchParams } = new URL(req.url);
  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const toDefault = todayStr(APP_TIMEZONE);
  const fromDefault = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let from = fromDefault, to = toDefault;
  if (searchParams.get('from')) {
    const v = validateDateStr(searchParams.get('from'), { label: 'from', allowPastDays: 1825, allowFutureDays: 2 });
    if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    from = v.value!;
  }
  if (searchParams.get('to')) {
    const v = validateDateStr(searchParams.get('to'), { label: 'to', allowPastDays: 1825, allowFutureDays: 2 });
    if (v.error) return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    to = v.value!;
  }
  if (from > to) return err('from must be on or before to', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  // Bound the span so the report stays within the single-query row cap.
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > 400) return err('date range too large (max 400 days)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const rl = await checkAndIncrementRateLimit('compliance-read', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    const report = await getReport(pid, from, to);
    return ok(report, { requestId });
  } catch (e) {
    log.error('[compliance/report] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
