/**
 * POST /api/housekeeping/inspections/start
 *
 * Body: { pid, roomId, roomNumber, cleaningType?, roomType?, parentInspectionId?, inspectorStaffId? }
 *
 * Creates an in-progress inspection row, selects the best-matching
 * checklist, and returns both. Manager-facing route — requireSession +
 * property access gate. The mobile InspectorView calls the public
 * mirror at /api/housekeeper/inspections/start.
 */

import { NextRequest } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { startInspectionCore } from '@/lib/inspections';
import { parseRoomId } from '@/lib/pms-rooms-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface StartBody {
  pid?: unknown;
  roomId?: unknown;
  roomNumber?: unknown;
  cleaningType?: unknown;
  roomType?: unknown;
  parentInspectionId?: unknown;
  inspectorStaffId?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return err('Invalid JSON body', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const roomNumberV = validateString(body.roomNumber, { max: 16, label: 'roomNumber' });
  if (roomNumberV.error) {
    return err(roomNumberV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const roomNumber = roomNumberV.value!;

  // roomId is optional. It is the pms_* merge's composite "${date}:${number}"
  // id (parseRoomId-able) or a legacy uuid; accept either since the
  // linked-housekeeper lookup parses it. The required roomNumber is the real key.
  let roomId: string | null = null;
  if (typeof body.roomId === 'string' && body.roomId !== '') {
    if (parseRoomId(body.roomId) || /^[0-9a-f-]{36}$/i.test(body.roomId)) {
      roomId = body.roomId;
    } else {
      return err('invalid roomId', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
  }

  // parentInspectionId optional — UUID if provided.
  let parentInspectionId: string | null = null;
  if (body.parentInspectionId) {
    const v = validateUuid(body.parentInspectionId, 'parentInspectionId');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    parentInspectionId = v.value!;
  }

  // inspectorStaffId optional — UUID if provided. Otherwise we leave it
  // null; the UI can fill it in via the manager's identity.
  let inspectorStaffId: string | null = null;
  if (body.inspectorStaffId) {
    const v = validateUuid(body.inspectorStaffId, 'inspectorStaffId');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    inspectorStaffId = v.value!;
  }

  const hasAccess = await userHasPropertyAccess(auth.userId, pid);
  if (!hasAccess) {
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  try {
    const cleaningType =
      typeof body.cleaningType === 'string' && body.cleaningType ? body.cleaningType : null;
    const roomType =
      typeof body.roomType === 'string' && body.roomType ? body.roomType : null;

    const result = await startInspectionCore({
      propertyId: pid,
      roomNumber,
      roomId,
      cleaningType,
      roomType,
      inspectorStaffId,
      parentInspectionId,
    });

    if (result.kind === 'no_checklist') {
      return err('No active checklist available for this room', {
        requestId, status: 409, code: 'no_checklist',
      });
    }

    return ok(
      { inspection: result.inspection, checklist: result.checklist },
      { requestId, status: result.created ? 201 : 200 },
    );
  } catch (e: unknown) {
    log.error('[inspections/start] failed', {
      requestId, pid, roomNumber, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
