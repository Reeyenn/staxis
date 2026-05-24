/**
 * POST /api/housekeeping/inspections/[id]/cancel
 *
 * Abandons an in-progress inspection. Used when an inspector starts an
 * inspection then backs out without completing it (e.g., wrong room).
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { cancelInspection, getInspectionById } from '@/lib/db/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const requestId = getOrMintRequestId(req);
  const { id } = await ctx.params;

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  const idV = validateUuid(id, 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  try {
    const before = await getInspectionById(id);
    if (!before) {
      return err('Inspection not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    const hasAccess = await userHasPropertyAccess(auth.userId, before.propertyId);
    if (!hasAccess) {
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    if (before.result !== 'in_progress') {
      return err(`Inspection is already ${before.result} — cannot cancel`, {
        requestId, status: 409, code: 'already_completed',
      });
    }

    const cancelled = await cancelInspection(id);
    return ok({ inspection: cancelled }, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/[id]/cancel] failed', { requestId, id, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
