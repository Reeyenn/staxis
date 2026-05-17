// ═══════════════════════════════════════════════════════════════════════════
// Work Orders — anyone-can-submit, head-housekeeper-marks-done.
//
// Two TS statuses only — 'open' and 'done'. The DB still uses the legacy
// CHECK enum (submitted/assigned/in_progress/resolved); the mapper coerces.
// ═══════════════════════════════════════════════════════════════════════════

import type { WorkOrder } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toWorkOrderRow, fromWorkOrderRow } from '../db-mappers';

// Matches fromWorkOrderRow in db-mappers.ts. Includes legacy fallback
// columns (photo_url, assigned_name) so pre-0131 rows still resolve.
// Audit follow-up 2026-05-17.
const WORK_ORDER_FIELDS =
  'id, property_id, room_number, description, severity, status, ' +
  'submitted_by_name, submitter_role, submitter_photo_path, ' +
  'completed_by_name, completion_note, completion_photo_path, ' +
  'resolved_at, photo_url, assigned_name, created_at, updated_at';
type WorkOrderRow = Record<string, unknown>;

export function subscribeToWorkOrders(
  _uid: string, pid: string,
  callback: (orders: WorkOrder[]) => void,
): () => void {
  return subscribeTable<WorkOrder>(
    `work_orders:${pid}`, 'work_orders', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('work_orders').select(WORK_ORDER_FIELDS)
        .eq('property_id', pid)
        .order('created_at', { ascending: false })
        .returns<WorkOrderRow[]>();
      if (error) throw error;
      return (data ?? []).map(fromWorkOrderRow);
    },
    callback,
  );
}

export async function addWorkOrder(
  _uid: string, pid: string,
  order: Omit<WorkOrder, 'id' | 'createdAt' | 'updatedAt' | 'completedAt'>,
): Promise<string> {
  try {
    const row = { ...toWorkOrderRow({ ...order, propertyId: pid }), property_id: pid };
    const { data: inserted, error } = await supabase
      .from('work_orders').insert(row).select('id').single();
    if (error) throw error;
    return String(inserted.id);
  } catch (err) { logErr('addWorkOrder', err); throw err; }
}

export async function updateWorkOrder(
  _uid: string, _pid: string, wid: string, data: Partial<WorkOrder>,
): Promise<void> {
  try {
    const { error } = await supabase.from('work_orders').update(toWorkOrderRow(data)).eq('id', wid);
    if (error) throw error;
  } catch (err) { logErr('updateWorkOrder', err); throw err; }
}

export async function deleteWorkOrder(_uid: string, _pid: string, wid: string): Promise<void> {
  const { error } = await supabase.from('work_orders').delete().eq('id', wid);
  if (error) { logErr('deleteWorkOrder', error); throw error; }
}

// Mark a work order done in one call. Sets status, completed-by name, the
// completion note + photo path, and resolved_at = now (we read this back as
// the new design's completedAt timestamp).
export async function markWorkOrderDone(
  wid: string,
  args: { completedByName: string; completionNote?: string; completionPhotoPath?: string },
): Promise<void> {
  try {
    const { error } = await supabase
      .from('work_orders')
      .update({
        status: 'resolved',
        completed_by_name: args.completedByName,
        completion_note: args.completionNote ?? null,
        completion_photo_path: args.completionPhotoPath ?? null,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', wid);
    if (error) throw error;
  } catch (err) { logErr('markWorkOrderDone', err); throw err; }
}
