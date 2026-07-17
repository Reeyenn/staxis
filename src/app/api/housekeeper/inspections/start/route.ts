/**
 * POST /api/housekeeper/inspections/start
 *
 * Public mirror of /api/housekeeping/inspections/start for the mobile
 * InspectorView. Authenticated via pid + staffId + can_inspect check
 * instead of session.
 */

import { NextRequest } from 'next/server';
import { validateUuid, validateString } from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { verifyStaffLinkToken } from '@/lib/staff-link-auth';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { staffCanInspect } from '@/lib/db/inspections';
import { startInspectionCore } from '@/lib/inspections';
import { parseRoomId } from '@/lib/pms-rooms-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface StartBody {
  pid?: unknown;
  staffId?: unknown;
  roomId?: unknown;
  roomNumber?: unknown;
  cleaningType?: unknown;
  roomType?: unknown;
  parentInspectionId?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
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

  let parentInspectionId: string | null = null;
  if (body.parentInspectionId) {
    const v = validateUuid(body.parentInspectionId, 'parentInspectionId');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    parentInspectionId = v.value!;
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
    const cleaningType = typeof body.cleaningType === 'string' && body.cleaningType ? body.cleaningType : null;
    const roomType = typeof body.roomType === 'string' && body.roomType ? body.roomType : null;

    const result = await startInspectionCore({
      propertyId: pid,
      roomNumber,
      roomId,
      cleaningType,
      roomType,
      inspectorStaffId: staffId,
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
    log.error('[housekeeper/inspections/start] failed', {
      requestId, pid, staffId, roomNumber, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}
