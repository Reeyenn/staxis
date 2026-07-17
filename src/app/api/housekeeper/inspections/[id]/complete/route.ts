/**
 * POST /api/housekeeper/inspections/[id]/complete
 *
 * Public mirror of /api/housekeeping/inspections/[id]/complete for the
 * mobile InspectorView. Body adds pid + staffId for capability check.
 */

import { NextRequest } from 'next/server';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { verifyStaffLinkToken } from '@/lib/staff-link-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { getInspectionById, staffCanInspect } from '@/lib/db/inspections';
import { parseCompleteInspectionBody, validateAndFinalizeInspection } from '@/lib/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface CompleteBody {
  pid?: unknown;
  staffId?: unknown;
  result?: unknown;
  failedItems?: unknown;
  passedItems?: unknown;
  notes?: unknown;
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const requestId = getOrMintRequestId(req);
  const { id } = await ctx.params;

  const idV = validateUuid(id, 'id');
  if (idV.error) {
    return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  let body: CompleteBody;
  try {
    body = (await req.json()) as CompleteBody;
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) {
    return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const staffId = staffV.value!;

  const resultV = validateEnum(body.result, ['pass', 'fail'] as const, 'result');
  if (resultV.error) {
    return err(resultV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  let notes: string | null = null;
  if (body.notes !== undefined && body.notes !== null && body.notes !== '') {
    const v = validateString(body.notes, { max: 1000, label: 'notes' });
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    notes = v.value!;
  }

  const parsed = parseCompleteInspectionBody({
    result: resultV.value!,
    failedItemsRaw: body.failedItems,
    passedItemsRaw: body.passedItems,
    notes,
  });
  if (parsed.error) {
    return err(parsed.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  // Security audit 2026-06-26 #1: verify the per-staff link token (body.tok).
  const gate = await verifyStaffLinkToken(req, { pid, staffId, requestId, bodyToken: (body as { tok?: unknown }).tok });
  if (!gate.ok) return gate.response;

  const canInspect = await staffCanInspect(pid, staffId);
  if (!canInspect) {
    return err('forbidden — not an inspector', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const before = await getInspectionById(id);
    if (!before) {
      return err('Inspection not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    }
    if (before.propertyId !== pid) {
      return err('Inspection does not belong to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    const finalized = await validateAndFinalizeInspection({ before, parsed: parsed.value! });
    if (finalized.error) {
      return err(finalized.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    return ok(finalized.value!, { requestId });
  } catch (e: unknown) {
    log.error('[housekeeper/inspections/[id]/complete] failed', {
      requestId, id, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
