// ═══════════════════════════════════════════════════════════════════════════
// Equipment — physical asset registry. The foundation for the maintenance
// ML pipeline (failure prediction, repair-vs-replace, cost-per-asset).
//
// Same shape as work-orders.ts: subscribe + add + update + delete.
// ═══════════════════════════════════════════════════════════════════════════

import type { Equipment } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toEquipmentRow, fromEquipmentRow } from '../db-mappers';

export function subscribeToEquipment(
  _uid: string, pid: string,
  callback: (rows: Equipment[]) => void,
): () => void {
  return subscribeTable<Equipment>(
    `equipment:${pid}`, 'equipment', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('equipment').select('*')
        .eq('property_id', pid)
        .order('name', { ascending: true });
      if (error) throw error;
      return (data ?? []).map(fromEquipmentRow);
    },
    callback,
  );
}

export async function listEquipment(_uid: string, pid: string): Promise<Equipment[]> {
  const { data, error } = await supabase
    .from('equipment').select('*').eq('property_id', pid).order('name');
  if (error) { logErr('listEquipment', error); throw error; }
  return (data ?? []).map(fromEquipmentRow);
}

export async function addEquipment(
  _uid: string, pid: string,
  e: Omit<Equipment, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<string> {
  const row = { ...toEquipmentRow({ ...e, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('equipment').insert(row).select('id').single();
  if (error) { logErr('addEquipment', error); throw error; }
  return String(inserted.id);
}

export async function updateEquipment(
  _uid: string, _pid: string, eid: string, patch: Partial<Equipment>,
): Promise<void> {
  const { error } = await supabase.from('equipment').update(toEquipmentRow(patch)).eq('id', eid);
  if (error) { logErr('updateEquipment', error); throw error; }
}

export async function deleteEquipment(_uid: string, _pid: string, eid: string): Promise<void> {
  const { error } = await supabase.from('equipment').delete().eq('id', eid);
  if (error) { logErr('deleteEquipment', error); throw error; }
}
