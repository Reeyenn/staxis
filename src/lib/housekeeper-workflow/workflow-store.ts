/**
 * Workflow write helper — persists housekeeper start/pause/resume/complete/
 * reset/exception + checklist state to the pms_* schema.
 *
 * Plan-v4 moved rooms out of the legacy `rooms` table (stubbed empty by
 * 0204/0205) into pms_housekeeping_assignments. The workflow endpoints used
 * to write `rooms` directly; they now go through here so writes land on the
 * same row the page reads. Workflow-state columns added in migration 0269.
 *
 * The room is keyed by the synthetic composite id "${date}:${roomNumber}"
 * (parseRoomId). The matching assignment row always exists when this is
 * called — the endpoints first resolve the room via loadRoomForStaff, which
 * only returns rooms that have an assignment for this staff.
 *
 * Write-back budget (intentional): this helper upserts pms_housekeeping_assignments
 * ONLY. Unlike applyRoomUpdate it deliberately does NOT append a
 * pms_room_status_log row or enqueue a staxis_enqueue_pms_write job on a
 * status flip. That is by design — the migration brief called out that routing
 * every housekeeper tap through the write-back enqueue would burn the
 * `pms-writeback-enqueue` limiter; the assignment row is the authoritative
 * source the board/AI/dashboard read, and PMS push-back (gated on
 * properties.pms_writeback_enabled, OFF by default) is driven by the
 * manager/AI applyRoomUpdate path + CUA reconciliation, not per-tap.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { parseRoomId } from '@/lib/pms-rooms-server';

/** Workflow status (page/state-machine) → pms_housekeeping_assignments.status. */
const STATUS_MAP: Record<string, string> = {
  dirty: 'not_started',
  in_progress: 'in_progress',
  clean: 'completed',
  inspected: 'completed',
};

export interface WorkflowPatch {
  status?: string; // workflow status: dirty | in_progress | clean | inspected
  started_at?: string | null;
  completed_at?: string | null;
  is_paused?: boolean;
  paused_at?: string | null;
  total_paused_seconds?: number;
  checklist_template_id?: string | null;
  checklist_progress?: string[];
  exception_type?: string | null;
  exception_note?: string | null;
  exception_at?: string | null;
  is_dnd?: boolean; // mirrors exception_type==='dnd' for legacy dnd_active readers
  // Workflow-state remainder (migration 0270). Snake-case so routes with
  // metadata the Room type doesn't carry (manager_notes_by_account_id,
  // rush_set_by, *_at) can set them exactly.
  manager_notes?: string | null;
  manager_notes_at?: string | null;
  manager_notes_by_account_id?: string | null;
  housekeeper_note?: string | null;
  housekeeper_note_at?: string | null;
  is_rush?: boolean;
  rush_due_by?: string | null;
  rush_set_at?: string | null;
  rush_set_by?: string | null;
  marked_for_inspection_at?: string | null;
  inspected_by?: string | null;
  inspected_at?: string | null;
  issue_note?: string | null;
  help_requested?: boolean;
  dnd_note?: string | null;
}

/**
 * Upsert the given workflow fields onto the room's assignment row. Returns
 * { ok } — ok=false only on a real DB error (the caller surfaces a 500).
 */
export async function writeWorkflowFields(
  pid: string,
  roomId: string,
  patch: WorkflowPatch,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = parseRoomId(roomId);
  if (!parsed) return { ok: false, error: `unparseable roomId: ${roomId}` };
  const { date, roomNumber } = parsed;

  const row: Record<string, unknown> = {
    property_id: pid,
    date,
    room_number: roomNumber,
  };
  if (patch.status !== undefined) row.status = STATUS_MAP[patch.status] ?? patch.status;
  if (patch.started_at !== undefined) row.started_at = patch.started_at;
  if (patch.completed_at !== undefined) row.completed_at = patch.completed_at;
  if (patch.is_paused !== undefined) row.is_paused = patch.is_paused;
  if (patch.paused_at !== undefined) row.paused_at = patch.paused_at;
  if (patch.total_paused_seconds !== undefined) row.total_paused_seconds = patch.total_paused_seconds;
  if (patch.checklist_template_id !== undefined) row.checklist_template_id = patch.checklist_template_id;
  if (patch.checklist_progress !== undefined) row.checklist_progress = patch.checklist_progress;
  if (patch.exception_type !== undefined) row.exception_type = patch.exception_type;
  if (patch.exception_note !== undefined) row.exception_note = patch.exception_note;
  if (patch.exception_at !== undefined) row.exception_at = patch.exception_at;
  if (patch.is_dnd !== undefined) row.dnd_active = patch.is_dnd;
  // Workflow-state remainder (migration 0270).
  if (patch.manager_notes !== undefined) row.manager_notes = patch.manager_notes;
  if (patch.manager_notes_at !== undefined) row.manager_notes_at = patch.manager_notes_at;
  if (patch.manager_notes_by_account_id !== undefined) {
    row.manager_notes_by_account_id = patch.manager_notes_by_account_id;
  }
  if (patch.housekeeper_note !== undefined) row.housekeeper_note = patch.housekeeper_note;
  if (patch.housekeeper_note_at !== undefined) row.housekeeper_note_at = patch.housekeeper_note_at;
  if (patch.is_rush !== undefined) row.is_rush = patch.is_rush;
  if (patch.rush_due_by !== undefined) row.rush_due_by = patch.rush_due_by;
  if (patch.rush_set_at !== undefined) row.rush_set_at = patch.rush_set_at;
  if (patch.rush_set_by !== undefined) row.rush_set_by = patch.rush_set_by;
  if (patch.marked_for_inspection_at !== undefined) {
    row.marked_for_inspection_at = patch.marked_for_inspection_at;
  }
  if (patch.inspected_by !== undefined) row.inspected_by = patch.inspected_by;
  if (patch.inspected_at !== undefined) row.inspected_at = patch.inspected_at;
  if (patch.issue_note !== undefined) row.issue_note = patch.issue_note;
  if (patch.help_requested !== undefined) row.help_requested = patch.help_requested;
  if (patch.dnd_note !== undefined) row.dnd_note = patch.dnd_note;

  const { error } = await supabaseAdmin
    .from('pms_housekeeping_assignments')
    .upsert(row, { onConflict: 'property_id,date,room_number' });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
