// ═══════════════════════════════════════════════════════════════════════════
// Preventive Maintenance Tasks — planned recurring work (HVAC filter
// changes, deep mattress flip, etc.). Distinct from work_orders (reactive).
// ═══════════════════════════════════════════════════════════════════════════

import type { PreventiveTask } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toPreventiveRow, fromPreventiveRow } from '../db-mappers';

export function subscribeToPreventiveTasks(
  _uid: string, pid: string,
  callback: (tasks: PreventiveTask[]) => void,
): () => void {
  return subscribeTable<PreventiveTask>(
    `preventive_tasks:${pid}`, 'preventive_tasks', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('preventive_tasks').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromPreventiveRow);
    },
    callback,
  );
}

export async function addPreventiveTask(
  _uid: string, pid: string,
  task: Omit<PreventiveTask, 'id' | 'createdAt'>,
): Promise<string> {
  const row = { ...toPreventiveRow({ ...task, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('preventive_tasks').insert(row).select('id').single();
  if (error) { logErr('addPreventiveTask', error); throw error; }
  return String(inserted.id);
}

export async function updatePreventiveTask(
  _uid: string, _pid: string, tid: string, data: Partial<PreventiveTask>,
): Promise<void> {
  const { error } = await supabase.from('preventive_tasks').update(toPreventiveRow(data)).eq('id', tid);
  if (error) { logErr('updatePreventiveTask', error); throw error; }
}

export async function deletePreventiveTask(_uid: string, _pid: string, tid: string): Promise<void> {
  const { error } = await supabase.from('preventive_tasks').delete().eq('id', tid);
  if (error) { logErr('deletePreventiveTask', error); throw error; }
}
