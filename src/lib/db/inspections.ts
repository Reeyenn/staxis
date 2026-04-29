// ═══════════════════════════════════════════════════════════════════════════
// Inspections — supervisor walk-throughs. Tracks pass/fail per room with
// notes. Independent of cleaning_events — an inspection is the manager's
// QA pass after the housekeeper marks Done.
// ═══════════════════════════════════════════════════════════════════════════

import type { Inspection } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toInspectionRow, fromInspectionRow } from '../db-mappers';

export function subscribeToInspections(
  _uid: string, pid: string,
  callback: (items: Inspection[]) => void,
): () => void {
  return subscribeTable<Inspection>(
    `inspections:${pid}`, 'inspections', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('inspections').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromInspectionRow);
    },
    callback,
  );
}

export async function addInspection(
  _uid: string, pid: string,
  item: Omit<Inspection, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<string> {
  const row = { ...toInspectionRow({ ...item, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('inspections').insert(row).select('id').single();
  if (error) { logErr('addInspection', error); throw error; }
  return String(inserted.id);
}

export async function updateInspection(
  _uid: string, _pid: string, iid: string, data: Partial<Inspection>,
): Promise<void> {
  const { error } = await supabase.from('inspections').update(toInspectionRow(data)).eq('id', iid);
  if (error) { logErr('updateInspection', error); throw error; }
}

export async function deleteInspection(_uid: string, _pid: string, iid: string): Promise<void> {
  const { error } = await supabase.from('inspections').delete().eq('id', iid);
  if (error) { logErr('deleteInspection', error); throw error; }
}
