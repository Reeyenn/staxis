// GET /api/engineer/bootstrap?pid&staffId
//
// Public engineer mobile page bootstrap. RLS bug class: reads ONLY via
// supabaseAdmin after a pid+staffId capability check — never the browser
// client. Returns the engineer's name/language + today's due readings + PM
// checks (the same overview the manager tab uses).

import { NextRequest } from 'next/server';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { checkStaffCapability } from '@/lib/compliance/api-helpers';
import { getOverview } from '@/lib/compliance/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const { searchParams } = new URL(req.url);

  const pidV = validateUuid(searchParams.get('pid'), 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffV = validateUuid(searchParams.get('staffId'), 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;
  const staffId = staffV.value!;

  const rl = await checkAndIncrementRateLimit('engineer-bootstrap', hashToRateLimitKey(`${pid}:${staffId}`));
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const staff = await checkStaffCapability(pid, staffId);
  if (!staff) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

  try {
    const overview = await getOverview(pid);
    return ok({ staff: { id: staff.id, name: staff.name, language: staff.language }, overview }, { requestId });
  } catch (e) {
    log.error('[engineer/bootstrap] failed', { requestId, pid, staffId, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
