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
import {
  createInspection,
  getActiveChecklists,
  getInspectionById,
  inspectionBelongsToProperty,
  roomBelongsToProperty,
} from '@/lib/db/inspections';
import { selectChecklist } from '@/lib/inspections';
import { supabaseAdmin } from '@/lib/supabase-admin';

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

  // roomId is optional but recommended — UUID if present.
  let roomId: string | null = null;
  if (body.roomId !== undefined && body.roomId !== null && body.roomId !== '') {
    const v = validateUuid(body.roomId, 'roomId');
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    roomId = v.value!;
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
    const cleaningType =
      typeof body.cleaningType === 'string' && body.cleaningType ? body.cleaningType : null;
    const roomType =
      typeof body.roomType === 'string' && body.roomType ? body.roomType : null;

    // 1. Look up the linked cleaning task and housekeeper (best-effort).
    const linked = await lookupLinkedTaskAndHousekeeper(pid, roomNumber, roomId);

    // 2. Pick a checklist.
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

    // 3. Reuse any in-progress inspection on this room (idempotent start).
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
      inspectorStaffId,
      housekeeperStaffId: linked.housekeeperStaffId,
      parentInspectionId,
    });

    return ok({ inspection, checklist }, { requestId, status: 201 });
  } catch (e: unknown) {
    log.error('[inspections/start] failed', {
      requestId, pid, roomNumber, msg: errToString(e),
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
    // Non-fatal — cleaning_tasks may not yet exist for this room.
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
        const row = data as { assigned_to: string | null };
        housekeeperStaffId = row.assigned_to;
      }
    } catch {
      // No rooms row — fall back to null.
    }
  }

  return { cleaningTaskId, housekeeperStaffId, cleaningType };
}
