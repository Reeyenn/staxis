// POST /api/compliance/reading-type
// Body: { pid, action: 'create'|'update'|'deactivate', id?, category?, name?,
//         unit?, cadence?, minValue?, maxValue?, assignedDepartment? }
//
// Manager config for recurring readings. Manager-role gated.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateString, validateEnum } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { canForUserId } from '@/lib/capabilities/server';
import { createReadingType, updateReadingType } from '@/lib/compliance/store';
import { READING_CATEGORIES, READING_CADENCES } from '@/lib/compliance/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  pid?: unknown; action?: unknown; id?: unknown;
  category?: unknown; name?: unknown; unit?: unknown; cadence?: unknown;
  minValue?: unknown; maxValue?: unknown; assignedDepartment?: unknown;
}

function numOrNull(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const session = await requireSession(req);
  if (!session.ok) return session.response;

  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!;
  const actionV = validateEnum(body.action, ['create', 'update', 'deactivate'] as const, 'action');
  if (actionV.error) return err(actionV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const action = actionV.value!;

  if (!(await userHasPropertyAccess(session.userId, pid))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  if (!(await canForUserId(session.userId, 'manage_equipment', pid))) {
    return err('Manager role required', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }
  const rl = await checkAndIncrementRateLimit('compliance-config', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  try {
    if (action === 'create') {
      const catV = validateEnum(body.category, READING_CATEGORIES, 'category');
      if (catV.error) return err(catV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const nameV = validateString(body.name, { max: 120, label: 'name' });
      if (nameV.error) return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const cadV = validateEnum(body.cadence, READING_CADENCES, 'cadence');
      if (cadV.error) return err(cadV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const unitV = validateString(body.unit, { max: 16, label: 'unit', allowEmpty: true });
      if (unitV.error) return err(unitV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const minV = numOrNull(body.minValue);
      const maxV = numOrNull(body.maxValue);
      if (minV !== undefined && minV !== null && maxV !== undefined && maxV !== null && minV > maxV) {
        return err('minValue cannot exceed maxValue', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      const created = await createReadingType(pid, {
        category: catV.value!, name: nameV.value!, unit: unitV.value || '',
        cadence: cadV.value!, minValue: minV ?? null, maxValue: maxV ?? null,
        assignedDepartment: typeof body.assignedDepartment === 'string' ? body.assignedDepartment : 'maintenance',
      });
      return ok({ id: created.id }, { requestId });
    }

    const idV = validateUuid(body.id, 'id');
    if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

    if (action === 'deactivate') {
      await updateReadingType(pid, idV.value!, { active: false });
      return ok({ id: idV.value }, { requestId });
    }

    // update
    const patch: Parameters<typeof updateReadingType>[2] = {};
    if (body.category !== undefined) {
      const catV = validateEnum(body.category, READING_CATEGORIES, 'category');
      if (catV.error) return err(catV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.category = catV.value!;
    }
    if (body.name !== undefined) {
      const nameV = validateString(body.name, { max: 120, label: 'name' });
      if (nameV.error) return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.name = nameV.value!;
    }
    if (body.unit !== undefined) {
      const unitV = validateString(body.unit, { max: 16, label: 'unit', allowEmpty: true });
      if (unitV.error) return err(unitV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.unit = unitV.value || '';
    }
    if (body.cadence !== undefined) {
      const cadV = validateEnum(body.cadence, READING_CADENCES, 'cadence');
      if (cadV.error) return err(cadV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.cadence = cadV.value!;
    }
    const minV = numOrNull(body.minValue);
    const maxV = numOrNull(body.maxValue);
    if (typeof minV === 'number' && typeof maxV === 'number' && minV > maxV) {
      return err('minValue cannot exceed maxValue', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    if (minV !== undefined) patch.minValue = minV;
    if (maxV !== undefined) patch.maxValue = maxV;
    await updateReadingType(pid, idV.value!, patch);
    return ok({ id: idV.value }, { requestId });
  } catch (e) {
    log.error('[compliance/reading-type] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
