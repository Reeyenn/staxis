// ═══════════════════════════════════════════════════════════════════════════
// Work Orders — maintenance / repair tickets created by housekeeping or
// front desk. Tracked separately from preventive_tasks (planned recurring
// work).
// ═══════════════════════════════════════════════════════════════════════════

import type { WorkOrder } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toWorkOrderRow, fromWorkOrderRow } from '../db-mappers';

export function subscribeToWorkOrders(
  _uid: string, pid: string,
  callback: (orders: WorkOrder[]) => void,
): () => void {
  return subscribeTable<WorkOrder>(
    `work_orders:${pid}`, 'work_orders', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('work_orders').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromWorkOrderRow);
    },
    callback,
  );
}

export async function addWorkOrder(
  _uid: string, pid: string,
  order: Omit<WorkOrder, 'id' | 'createdAt' | 'updatedAt'>,
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
