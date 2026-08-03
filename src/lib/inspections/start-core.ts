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

  // 1. Look up the canonical plan and housekeeper (best-effort only for the
  // existing PMS staff enrichment; canonical plan lookup is fail-closed).
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
  const plan = await lookupCanonicalPlan(pid, roomNumber, roomId);
  const cleaningTaskId = plan?.id ?? null;
  const cleaningType = plan?.cleaning_type ?? null;

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

interface CanonicalPlanRow {
  id: string;
  property_id: string;
  room_number: string;
  business_date: string;
  cleaning_type: string | null;
}

/**
 * Resolve the inspection's plan identity from the canonical read model.
 *
 * Housekeeper links carry an exact YYYY-MM-DD:room composite identifier. A
 * manager start has no date in its input, so it preserves the former
 * cleaning-task rule of choosing the latest applicable plan, while rejecting
 * an ambiguous latest date instead of guessing. The property and room are
 * always part of the lookup, so a different property's plan cannot link.
 */
async function lookupCanonicalPlan(
  pid: string,
  roomNumber: string,
  roomId: string | null,
): Promise<CanonicalPlanRow | null> {
  const parsed = roomId ? parseRoomId(roomId) : null;
  const uuidRoomId = roomId ? /^[0-9a-f-]{36}$/i.test(roomId) : false;
  if (roomId && !parsed && !uuidRoomId) {
    throw new Error('invalid composite room identifier');
  }
  if (parsed && parsed.roomNumber !== roomNumber) {
    throw new Error('room identifier does not match room number');
  }

  let query = supabaseAdmin
    .from('room_work_plan_v1')
    .select('id, property_id, room_number, business_date, cleaning_type')
    .eq('property_id', pid)
    .eq('room_number', roomNumber);

  if (parsed) {
    query = query
      .eq('business_date', parsed.date)
      .order('id', { ascending: true })
      .limit(2);
  } else {
    query = query
      .order('business_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(2);
  }

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as CanonicalPlanRow[];
  if (rows.length === 0) return null;

  if (parsed) {
    if (rows.length > 1) {
      throw new Error(`ambiguous canonical cleaning plan for ${pid}/${parsed.date}/${roomNumber}`);
    }
    return rows[0];
  }

  const latestDate = rows[0].business_date;
  const latestRows = rows.filter((row) => row.business_date === latestDate);
  if (latestRows.length > 1) {
    throw new Error(`ambiguous canonical cleaning plan for ${pid}/${latestDate}/${roomNumber}`);
  }
  return latestRows[0];
}
