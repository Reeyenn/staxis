// POST /api/engineer/log-pm-check
// Body: { pid, staffId, pmTaskId, status, unitsChecked?, note?, photoBase64?, mediaType? }
//
// Public engineer PM check-off. Capability gate, then logPmCheck() (upserts
// the current-period row, auto-acts on a FAIL).

import { NextRequest } from 'next/server';
import { validateUuid, validateString, validateEnum, validateInt } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
} from '@/lib/api-ratelimit';
import { checkStaffCapability } from '@/lib/compliance/api-helpers';
import { logPmCheck, uploadCompliancePhoto } from '@/lib/compliance/store';
import { PM_STATUSES } from '@/lib/compliance/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

interface Body {
  pid?: unknown; staffId?: unknown; pmTaskId?: unknown;
  status?: unknown; unitsChecked?: unknown; note?: unknown;
  photoBase64?: unknown; mediaType?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const staffV = validateUuid(body.staffId, 'staffId');
  if (staffV.error) return err(staffV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const taskV = validateUuid(body.pmTaskId, 'pmTaskId');
  if (taskV.error) return err(taskV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const statusV = validateEnum(body.status, PM_STATUSES, 'status');
  if (statusV.error) return err(statusV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const pid = pidV.value!, staffId = staffV.value!, pmTaskId = taskV.value!, status = statusV.value!;

  let unitsChecked: number | null = null;
  if (body.unitsChecked !== undefined && body.unitsChecked !== null && body.unitsChecked !== '') {
    const uv = validateInt(body.unitsChecked, { min: 0, max: 100000, label: 'unitsChecked' });
    if (uv.error) return err(uv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    unitsChecked = uv.value!;
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    const nv = validateString(body.note, { max: 500, label: 'note', allowEmpty: true });
    if (nv.error) return err(nv.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    note = nv.value || null;
  }

  const rl = await checkAndIncrementRateLimit('engineer-log', pid);
  if (!rl.allowed) return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);

  const staff = await checkStaffCapability(pid, staffId);
  if (!staff) return err('Not found', { requestId, status: 404, code: ApiErrorCode.NotFound });

  try {
    let photoPath: string | null = null;
    if (typeof body.photoBase64 === 'string' && body.photoBase64.length > 100 && body.photoBase64.length < 8_000_000 &&
        typeof body.mediaType === 'string' && (MEDIA_TYPES as readonly string[]).includes(body.mediaType)) {
      photoPath = await uploadCompliancePhoto(pid, body.photoBase64, body.mediaType);
    }
    const result = await logPmCheck({
      pid, pmTaskId, status, unitsChecked, note, photoPath,
      staffId: staff.id, staffName: staff.name,
    });
    return ok({
      checkId: result.check.id,
      periodKey: result.check.periodKey,
      workOrderCreated: !!result.workOrderId,
    }, { requestId });
  } catch (e) {
    log.error('[engineer/log-pm-check] failed', { requestId, pid, staffId, msg: errToString(e) });
    const msg = errToString(e);
    if (/not found/i.test(msg)) return err('PM task not found', { requestId, status: 404, code: ApiErrorCode.NotFound });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
