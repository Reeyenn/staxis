import { NextRequest } from 'next/server';

import { requireSession } from '@/lib/api-auth';
import { err, ok, ApiErrorCode } from '@/lib/api-response';
import { validateUuid } from '@/lib/api-validate';
import { getOrMintRequestId, log } from '@/lib/log';
import { requireSectionEnabled } from '@/lib/sections/server';
import { activeStaffIdForAccountAtProperty } from '@/lib/schedule/staff-identity';
import { callerReachesHotel, loadSessionAccount } from '@/lib/team-auth';
import { errToString } from '@/lib/utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Current account's canonical staff identity at one hotel. */
export async function GET(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req, { requestId });
  if (!session.ok) return session.response;

  const hotelIdCheck = validateUuid(
    new URL(req.url).searchParams.get('hotelId'),
    'hotelId',
  );
  if (hotelIdCheck.error) {
    return err(hotelIdCheck.error, {
      requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
    });
  }
  const hotelId = hotelIdCheck.value!;
  const account = await loadSessionAccount(session.userId);
  if (!account || !callerReachesHotel(account, hotelId)) {
    return err('Forbidden', {
      requestId,
      status: 403,
      code: ApiErrorCode.Forbidden,
    });
  }

  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  try {
    const staffId = await activeStaffIdForAccountAtProperty(account.accountId, hotelId);
    return ok({ staffId }, { requestId });
  } catch (error) {
    log.error('[staff-schedule/me:GET] identity lookup failed', {
      requestId,
      hotelId,
      msg: errToString(error),
    });
    return err('Failed to load your staff profile', {
      requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
    });
  }
}
