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
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  createInspection,
  getActiveChecklists,
  getInspectionById,
  inspectionBelongsToProperty,
  roomBelongsToProperty,
  staffCanInspect,
} from '@/lib/db/inspections';
import { selectChecklist } from '@/lib/inspections';
import { supabaseAdmin } from '@/lib/supabase-admin';

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

  let roomId: string | null = null;
  if (body.roomId !== undefined && body.roomId !== null && body.roomId !== '') {
    const v = validateUuid(body.roomId, 'roomId');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    roomId = v.value!;
  }

  let parentInspectionId: string | null = null;
  if (body.parentInspectionId) {
    const v = validateUuid(body.parentInspectionId, 'parentInspectionId');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    parentInspectionId = v.value!;
  }

  const canInspect = await staffCanInspect(pid, staffId);
  if (!canInspect) {
    return err('forbidden — not an inspector', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
  }

  // Cross-property guard (Codex C2): roomId must belong to pid.
  if (roomId) {
    const roomOk = await roomBelongsToProperty(pid, roomId);
    if (!roomOk) {
      return err('roomId does not belong to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }
  }

  // Cross-property guard (Codex C3): parentInspectionId must belong to pid.
  if (parentInspectionId) {
    const parentOk = await inspectionBelongsToProperty(pid, parentInspectionId);
    if (!parentOk) {
      return err('parentInspectionId does not belong to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }
  }

  try {
    const cleaningType = typeof body.cleaningType === 'string' && body.cleaningType ? body.cleaningType : null;
    const roomType = typeof body.roomType === 'string' && body.roomType ? body.roomType : null;

    const linked = await lookupLinkedTaskAndHousekeeper(pid, roomNumber, roomId);

    const candidates = await getActiveChecklists(pid);
    const checklist = selectChecklist({
      candidates,
      cleaningType: cleaningType ?? linked.cleaningType,
      roomType,
      propertyId: pid,
    });
    if (!checklist) {
      return err('No active checklist available for this room', {
        requestId, status: 409, code: 'no_checklist',
      });
    }

    const existing = await findInProgress(pid, roomNumber);
    if (existing) {
      const full = await getInspectionById(existing.id);
      return ok({ inspection: full, checklist }, { requestId });
    }

    const inspection = await createInspection({
      propertyId: pid,
      roomNumber,
      roomId,
      cleaningTaskId: linked.cleaningTaskId,
      checklistId: checklist.id,
      inspectorStaffId: staffId,
      housekeeperStaffId: linked.housekeeperStaffId,
      parentInspectionId,
    });

    return ok({ inspection, checklist }, { requestId, status: 201 });
  } catch (e: unknown) {
    log.error('[housekeeper/inspections/start] failed', {
      requestId, pid, staffId, roomNumber, msg: errToString(e),
    });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

async function findInProgress(pid: string, roomNumber: string) {
  const { data } = await supabaseAdmin
    .from('inspections')
    .select('id')
    .eq('property_id', pid)
    .eq('room_number', roomNumber)
    .eq('result', 'in_progress')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { id: string } | null;
}

async function lookupLinkedTaskAndHousekeeper(
  pid: string,
  roomNumber: string,
  roomId: string | null,
): Promise<{
  cleaningTaskId: string | null;
  housekeeperStaffId: string | null;
  cleaningType: string | null;
}> {
  let cleaningTaskId: string | null = null;
  let cleaningType: string | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('cleaning_tasks')
      .select('id, cleaning_type, assignee_id')
      .eq('property_id', pid)
      .eq('room_number', roomNumber)
      .order('business_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      const row = data as { id: string; cleaning_type: string | null; assignee_id: string | null };
      cleaningTaskId = row.id;
      cleaningType = row.cleaning_type;
    }
  } catch {
    // non-fatal
  }

  let housekeeperStaffId: string | null = null;
  if (roomId) {
    try {
      const { data } = await supabaseAdmin
        .from('rooms')
        .select('assigned_to')
        .eq('id', roomId)
        .maybeSingle();
      if (data) {
        housekeeperStaffId = (data as { assigned_to: string | null }).assigned_to;
      }
    } catch {
      // non-fatal
    }
  }

  return { cleaningTaskId, housekeeperStaffId, cleaningType };
}
