/**
 * GET /api/front-desk/currently-working?pid=<uuid>
 *
 * Returns the front-desk staff currently on a shift right now (in the
 * property's IANA timezone). Used by CurrentlyWorkingStrip on
 * /front-desk to render avatars + names + (manager-only) phone numbers.
 *
 *   - requireSession + role gate: front_desk / GM / owner / admin only.
 *   - Phone number is redacted when the caller is NOT manager-tier
 *     (front_desk can see colleagues' presence without their numbers).
 *   - Rate-limit: 'front-desk-currently-working' bucket per (user, pid).
 *
 * Response shape:
 *   {
 *     ok: true,
 *     data: {
 *       staff: Array<{ staffId, name, phone | null, shiftStartTime,
 *                      shiftEndTime, shiftId, secondsUntilShiftEnd }>,
 *       viewerCanSeePhones: boolean,
 *       generatedAt: ISO timestamp (server time)
 *     }
 *   }
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
import {
  findCurrentlyWorkingFrontDesk,
  resolveCallerRole,
  passesFrontDeskGate,
  ROLES_ALLOWED_FRONT_DESK_READ,
  ROLES_ALLOWED_MANAGER_TIER,
} from '@/lib/front-desk-coordination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

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

  const callerInfo = await resolveCallerRole(auth.userId);
  if (!passesFrontDeskGate(callerInfo, pid, ROLES_ALLOWED_FRONT_DESK_READ)) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit(
    'front-desk-currently-working',
    hashToRateLimitKey(`${auth.userId}:${pid}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    const staff = await findCurrentlyWorkingFrontDesk(pid);
    const now = Date.now();
    const viewerCanSeePhones = !!callerInfo.role && ROLES_ALLOWED_MANAGER_TIER.has(callerInfo.role);

    const shaped = staff.map((s) => {
      // secondsUntilShiftEnd: best-effort estimate using the time
      // component only. If shift_end_time is < shift_start_time the
      // shift wraps midnight; we still emit a sensible non-negative
      // value by adding 24h.
      const [eh, em, es] = s.shiftEndTime.split(':').map((n) => parseInt(n, 10));
      const [sh, sm, ss] = s.shiftStartTime.split(':').map((n) => parseInt(n, 10));
      const endSec = eh * 3600 + em * 60 + es;
      const startSec = sh * 3600 + sm * 60 + ss;
      const nowDate = new Date(now);
      const nowSec = nowDate.getUTCHours() * 3600 + nowDate.getUTCMinutes() * 60 + nowDate.getUTCSeconds();
      // Rough — the UI just shows "ends in ~2h"; intentional that we
      // don't pretend to do timezone arithmetic on the wire. The strip
      // also receives shiftEndTime so it can render a precise label.
      let secondsUntilShiftEnd = endSec - nowSec;
      if (endSec < startSec) secondsUntilShiftEnd += 24 * 3600;
      if (secondsUntilShiftEnd < 0) secondsUntilShiftEnd = 0;

      return {
        staffId: s.staffId,
        name: s.name,
        phone: viewerCanSeePhones ? s.phone : null,
        shiftStartTime: s.shiftStartTime,
        shiftEndTime: s.shiftEndTime,
        shiftId: s.shiftId,
        secondsUntilShiftEnd,
      };
    });

    return ok({
      staff: shaped,
      viewerCanSeePhones,
      generatedAt: new Date().toISOString(),
    }, { requestId });
  } catch (e) {
    log.error('[front-desk/currently-working] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
