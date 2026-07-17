/**
 * POST /api/housekeeping/inspections/[id]/complete
 *
 * Body: { result: 'pass' | 'fail', failedItems: [...], passedItems: [...], notes?: string }
 *
 * Finalizes an in-progress inspection. On fail, writes a correction
 * notice to the linked room so the housekeeper sees it in her queue.
 * Tracks consecutive fails to trigger manager escalation.
 *
 * Manager-facing route — requireSession + property access. The mobile
 * public mirror is /api/housekeeper/inspections/[id]/complete.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { getInspectionById } from '@/lib/db/inspections';
import { parseCompleteInspectionBody, validateAndFinalizeInspection } from '@/lib/inspections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface CompleteBody {
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

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

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

    const finalized = await validateAndFinalizeInspection({ before, parsed: parsed.value! });
    if (finalized.error) {
      return err(finalized.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    return ok(finalized.value!, { requestId });
  } catch (e: unknown) {
    log.error('[inspections/[id]/complete] failed', { requestId, id, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
