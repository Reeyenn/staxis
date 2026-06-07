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
  staffCanInspect,
} from '@/lib/db/inspections';
import { selectChecklist } from '@/lib/inspections';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { parseRoomId, mergePmsRoomsForDate } from '@/lib/pms-rooms-server';

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

  const canInspect = await staffCanInspect(pid, staffId);
  if (!canInspect) {
    return err('forbidden — not an inspector', {
      requestId, status: 403, code: ApiErrorCode.Forbidden,
    });
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

    try {
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
      // Codex M1 + migration 0221: partial unique index catches a race
      // between two inspectors opening the same room. Return the
      // racing row instead of 500ing.
      const msg = errToString(e);
      if (msg.includes('inspections_one_in_progress_per_room') || msg.includes('23505')) {
        const racing = await findInProgress(pid, roomNumber);
        if (racing) {
          const full = await getInspectionById(racing.id);
          return ok({ inspection: full, checklist }, { requestId });
        }
      }
      throw e;
    }
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
    const parsed = parseRoomId(roomId);
    if (parsed) {
      try {
        const merged = await mergePmsRoomsForDate(pid, parsed.date);
        const room = merged.find((r) => r.number === parsed.roomNumber);
        housekeeperStaffId = room?.assignedTo ?? null;
      } catch {
        // non-fatal
      }
    }
  }

  return { cleaningTaskId, housekeeperStaffId, cleaningType };
}
