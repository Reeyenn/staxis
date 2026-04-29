// ═══════════════════════════════════════════════════════════════════════════
// Landscaping Tasks — outdoor / curb-appeal work (lawn, parking lot,
// flower beds). Planned and tracked separately from rooms.
// ═══════════════════════════════════════════════════════════════════════════

import type { LandscapingTask } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toLandscapingRow, fromLandscapingRow } from '../db-mappers';

export function subscribeToLandscapingTasks(
  _uid: string, pid: string,
  callback: (tasks: LandscapingTask[]) => void,
): () => void {
  return subscribeTable<LandscapingTask>(
    `landscaping_tasks:${pid}`, 'landscaping_tasks', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('landscaping_tasks').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromLandscapingRow);
    },
    callback,
  );
}

export async function addLandscapingTask(
  _uid: string, pid: string,
  task: Omit<LandscapingTask, 'id' | 'createdAt'>,
): Promise<string> {
  const row = { ...toLandscapingRow({ ...task, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('landscaping_tasks').insert(row).select('id').single();
  if (error) { logErr('addLandscapingTask', error); throw error; }
  return String(inserted.id);
}

export async function updateLandscapingTask(
  _uid: string, _pid: string, tid: string, data: Partial<LandscapingTask>,
): Promise<void> {
  const { error } = await supabase.from('landscaping_tasks').update(toLandscapingRow(data)).eq('id', tid);
  if (error) { logErr('updateLandscapingTask', error); throw error; }
}

export async function deleteLandscapingTask(_uid: string, _pid: string, tid: string): Promise<void> {
  const { error } = await supabase.from('landscaping_tasks').delete().eq('id', tid);
  if (error) { logErr('deleteLandscapingTask', error); throw error; }
}
