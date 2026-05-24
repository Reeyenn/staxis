/**
 * GET /api/housekeeping/inspections/[id]
 *
 * Returns inspection detail + linked checklist. Manager-facing.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { getChecklistById, getInspectionById, lookupStaffNames } from '@/lib/db/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

export async function GET(
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
    const inspection = await getInspectionById(id);
    if (!inspection) {
      return err('Inspection not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }

    const hasAccess = await userHasPropertyAccess(auth.userId, inspection.propertyId);
    if (!hasAccess) {
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const checklist = inspection.checklistId
      ? await getChecklistById(inspection.checklistId)
      : null;

    const staffIds = [inspection.inspectorStaffId, inspection.housekeeperStaffId].filter(
      (v): v is string => Boolean(v),
    );
    const staffNames = await lookupStaffNames(staffIds);

    return ok({
      inspection,
      checklist,
      inspectorName: inspection.inspectorStaffId
        ? staffNames.get(inspection.inspectorStaffId) ?? null
        : null,
      housekeeperName: inspection.housekeeperStaffId
        ? staffNames.get(inspection.housekeeperStaffId) ?? null
        : null,
    }, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/[id]] failed', { requestId, id, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
