/**
 * GET /api/housekeeping/inspections/history?pid=&since=YYYY-MM-DD&room=&inspector=&limit=
 *
 * Returns past completed inspections for the History panel.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { getInspectionHistory } from '@/lib/db/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  const since = searchParams.get('since');
  let sinceIso: string | null = null;
  if (since) {
    if (!DATE_RE.test(since)) {
      return err('since must be YYYY-MM-DD', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    sinceIso = `${since}T00:00:00`;
  }

  const room = searchParams.get('room');
  const inspector = searchParams.get('inspector');
  if (inspector) {
    const v = validateUuid(inspector, 'inspector');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
  }
  const limit = Math.max(1, Math.min(200, parseInt(searchParams.get('limit') ?? '50', 10) || 50));

  try {
    const history = await getInspectionHistory({
      propertyId: pid,
      sinceIso,
      inspectorStaffId: inspector ?? null,
      roomNumber: room ?? null,
      limit,
    });
    return ok(history, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/history] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
