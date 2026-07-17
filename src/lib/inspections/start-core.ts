/**
 * Shared core for starting an inspection.
 *
 * The two start routes — /api/housekeeper/inspections/start (public,
 * staff-link-token gated) and /api/housekeeping/inspections/start
 * (manager, session gated) — share everything downstream of auth:
 * the linked-task/housekeeper lookup, checklist selection, idempotent
 * reuse of an in-progress row, inspection creation, and the 23505 race
 * fallback. Only the auth gate and the source of `inspectorStaffId`
 * differ, so those stay in the route files and the resolved values are
 * passed in here.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import {
  createInspection,
  getActiveChecklists,
  getInspectionById,
} from '@/lib/db/inspections';
import { selectChecklist } from './checklist-selector';
import { parseRoomId, mergePmsRoomsForDate } from '@/lib/pms-rooms-server';
import type { Inspection, InspectionChecklist } from '@/types/inspections';

export interface StartInspectionInput {
  propertyId: string;
  roomNumber: string;
  roomId: string | null;
  cleaningType: string | null;
  roomType: string | null;
  inspectorStaffId: string | null;
  parentInspectionId: string | null;
}

export type StartInspectionResult =
  | { kind: 'no_checklist' }
  | { kind: 'ok'; inspection: Inspection | null; checklist: InspectionChecklist; created: boolean };

export async function startInspectionCore(
  input: StartInspectionInput,
): Promise<StartInspectionResult> {
  const { propertyId, roomNumber, roomId } = input;

  // 1. Look up the linked cleaning task and housekeeper (best-effort).
  const linked = await lookupLinkedTaskAndHousekeeper(propertyId, roomNumber, roomId);

  // 2. Pick a checklist.
  const candidates = await getActiveChecklists(propertyId);
  const checklist = selectChecklist({
    candidates,
    cleaningType: input.cleaningType ?? linked.cleaningType,
    roomType: input.roomType,
    propertyId,
  });
  if (!checklist) {
    return { kind: 'no_checklist' };
  }

  // 3. Reuse any in-progress inspection on this room (idempotent start).
  const existing = await findInProgress(propertyId, roomNumber);
  if (existing) {
    const full = await getInspectionById(existing.id);
    return { kind: 'ok', inspection: full, checklist, created: false };
  }

  try {
    const inspection = await createInspection({
      propertyId,
      roomNumber,
      roomId,
      cleaningTaskId: linked.cleaningTaskId,
      checklistId: checklist.id,
      inspectorStaffId: input.inspectorStaffId,
      housekeeperStaffId: linked.housekeeperStaffId,
      parentInspectionId: input.parentInspectionId,
    });
    return { kind: 'ok', inspection, checklist, created: true };
  } catch (e: unknown) {
    // Codex M1 + migration 0221: partial unique index catches a race
    // between two inspectors opening the same room. Return the racing
    // row instead of 500ing.
    const msg = errToString(e);
    if (msg.includes('inspections_one_in_progress_per_room') || msg.includes('23505')) {
      const racing = await findInProgress(propertyId, roomNumber);
      if (racing) {
        const full = await getInspectionById(racing.id);
        return { kind: 'ok', inspection: full, checklist, created: false };
      }
    }
    throw e;
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
    const parsed = parseRoomId(roomId);
    if (parsed) {
      try {
        const merged = await mergePmsRoomsForDate(pid, parsed.date);
        const room = merged.find((r) => r.number === parsed.roomNumber);
        housekeeperStaffId = room?.assignedTo ?? null;
      } catch {
        // Non-fatal — fall back to null.
      }
    }
  }

  return { cleaningTaskId, housekeeperStaffId, cleaningType };
}
