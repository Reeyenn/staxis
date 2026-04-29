// ═══════════════════════════════════════════════════════════════════════════
// Inventory — supply tracking (towels, linens, toiletries, cleaning
// chemicals). Quantities updated by the back-office team.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryItem } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toInventoryRow, fromInventoryRow } from '../db-mappers';

export function subscribeToInventory(
  _uid: string, pid: string,
  callback: (items: InventoryItem[]) => void,
): () => void {
  return subscribeTable<InventoryItem>(
    `inventory:${pid}`, 'inventory', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('inventory').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromInventoryRow);
    },
    callback,
  );
}

export async function addInventoryItem(
  _uid: string, pid: string,
  item: Omit<InventoryItem, 'id' | 'updatedAt'>,
): Promise<string> {
  const row = { ...toInventoryRow({ ...item, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('inventory').insert(row).select('id').single();
  if (error) { logErr('addInventoryItem', error); throw error; }
  return String(inserted.id);
}

export async function updateInventoryItem(
  _uid: string, _pid: string, iid: string, data: Partial<InventoryItem>,
): Promise<void> {
  const { error } = await supabase.from('inventory').update(toInventoryRow(data)).eq('id', iid);
  if (error) { logErr('updateInventoryItem', error); throw error; }
}

export async function deleteInventoryItem(_uid: string, _pid: string, iid: string): Promise<void> {
  const { error } = await supabase.from('inventory').delete().eq('id', iid);
  if (error) { logErr('deleteInventoryItem', error); throw error; }
}
