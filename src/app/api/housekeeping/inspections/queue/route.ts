/**
 * GET /api/housekeeping/inspections/queue?pid=...&date=YYYY-MM-DD
 *
 * Returns rooms ready for inspection plus rooms ready for re-check.
 *
 *   pending_inspection — room status='clean' AND no completed inspection
 *                        exists for that room on the same business date.
 *
 *   pending_recheck    — there's a prior failed inspection (today) AND the
 *                        room has since been re-cleaned (room.completedAt
 *                        > inspection.completedAt).
 *
 * Used by the manager Quality tab (QualityTab). requireSession + property access
 * gate. Standard envelope response.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { buildInspectionQueue } from '@/lib/housekeeping/inspection-queue';

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

  const date = searchParams.get('date') ?? '';
  if (!DATE_RE.test(date)) {
    return err('date must be YYYY-MM-DD', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const queue = await buildInspectionQueue(pid, date);
    return ok(queue, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/queue] failed', { requestId, pid, date, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
