// ═══════════════════════════════════════════════════════════════════════════
// Preventive Maintenance Tasks — recurring inspections / filter swaps / etc.
// Distinct from work_orders (which are reactive). Next-due is computed
// client-side from last_completed_at + frequency_days.
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

// Complete a preventive task. Caller picks the completed date (today or
// a backfill); next-due is reconstructed client-side from
// last_completed_at + frequencyDays whenever the row is read back. The
// task's permanent `notes` are NOT overwritten — per-completion notes are
// transient (the design also discards them) and a future audit-log table
// would be the right place to store them long-term.
export async function completePreventiveTask(
  tid: string,
  args: { completedISO: string; completedByName: string; photoPath?: string },
): Promise<void> {
  try {
    const { error } = await supabase
      .from('preventive_tasks')
      .update({
        last_completed_at: new Date(args.completedISO).toISOString(),
        last_completed_by: args.completedByName,
        completion_photo_path: args.photoPath ?? null,
      })
      .eq('id', tid);
    if (error) throw error;
  } catch (err) { logErr('completePreventiveTask', err); throw err; }
}
