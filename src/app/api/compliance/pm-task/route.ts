// POST /api/compliance/pm-task
// Body: { pid, action: 'create'|'update'|'deactivate', id?, category?, name?,
//         equipmentType?, unitCount?, cadence?, assignedDepartment? }
//
// Manager config for recurring preventive-maintenance checks. Manager-gated.

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateString, validateEnum, validateInt } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { canForUserId } from '@/lib/capabilities/server';
import { createPmTask, updatePmTask } from '@/lib/compliance/store';
import { PM_CATEGORIES, PM_CADENCES } from '@/lib/compliance/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  pid?: unknown; action?: unknown; id?: unknown;
  category?: unknown; name?: unknown; equipmentType?: unknown;
  unitCount?: unknown; cadence?: unknown; assignedDepartment?: unknown;
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
      const catV = validateEnum(body.category, PM_CATEGORIES, 'category');
      if (catV.error) return err(catV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const nameV = validateString(body.name, { max: 120, label: 'name' });
      if (nameV.error) return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const cadV = validateEnum(body.cadence, PM_CADENCES, 'cadence');
      if (cadV.error) return err(cadV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const cntV = validateInt(body.unitCount, { min: 0, max: 100000, label: 'unitCount' });
      if (cntV.error) return err(cntV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const created = await createPmTask(pid, {
        category: catV.value!, name: nameV.value!, cadence: cadV.value!, unitCount: cntV.value!,
        equipmentType: typeof body.equipmentType === 'string' ? body.equipmentType.slice(0, 60) : null,
        assignedDepartment: typeof body.assignedDepartment === 'string' ? body.assignedDepartment : 'maintenance',
      });
      return ok({ id: created.id }, { requestId });
    }

    const idV = validateUuid(body.id, 'id');
    if (idV.error) return err(idV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

    if (action === 'deactivate') {
      await updatePmTask(pid, idV.value!, { active: false });
      return ok({ id: idV.value }, { requestId });
    }

    const patch: Parameters<typeof updatePmTask>[2] = {};
    if (body.category !== undefined) {
      const catV = validateEnum(body.category, PM_CATEGORIES, 'category');
      if (catV.error) return err(catV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.category = catV.value!;
    }
    if (body.name !== undefined) {
      const nameV = validateString(body.name, { max: 120, label: 'name' });
      if (nameV.error) return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.name = nameV.value!;
    }
    if (body.cadence !== undefined) {
      const cadV = validateEnum(body.cadence, PM_CADENCES, 'cadence');
      if (cadV.error) return err(cadV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.cadence = cadV.value!;
    }
    if (body.unitCount !== undefined) {
      const cntV = validateInt(body.unitCount, { min: 0, max: 100000, label: 'unitCount' });
      if (cntV.error) return err(cntV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      patch.unitCount = cntV.value!;
    }
    if (body.equipmentType !== undefined) {
      patch.equipmentType = typeof body.equipmentType === 'string' ? body.equipmentType.slice(0, 60) : null;
    }
    await updatePmTask(pid, idV.value!, patch);
    return ok({ id: idV.value }, { requestId });
  } catch (e) {
    log.error('[compliance/pm-task] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
