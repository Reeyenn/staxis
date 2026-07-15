// ═══════════════════════════════════════════════════════════════════════════
// Inventory custom categories (migration 0307) — per-property named tabs shown
// alongside the built-in General / Breakfast filters (e.g. Liquor, Petty cash).
//
// Additive: an item points at one via inventory.custom_category_id (nullable).
// Deleting a category is ON DELETE SET NULL at the DB — items aren't lost, they
// fall back to their built-in category's bucket.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryCustomCategory } from '@/types';
import { supabase, logErr, asRecordRows } from './_common';
import { fromInventoryCustomCategoryRow, toInventoryCustomCategoryRow } from '../db-mappers';

export async function listInventoryCustomCategories(
  _uid: string,
  pid: string,
): Promise<InventoryCustomCategory[]> {
  const { data, error } = await supabase
    .from('inventory_custom_categories')
    .select('*')
    .eq('property_id', pid)
    .order('sort', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) { logErr('listInventoryCustomCategories', error); throw error; }
  return asRecordRows(data ?? []).map(fromInventoryCustomCategoryRow);
}

/** Insert (no id) or rename (id set) a custom category. Returns its id. */
export async function upsertInventoryCustomCategory(
  _uid: string,
  pid: string,
  cat: { id?: string; name: string; sort?: number },
): Promise<string> {
  const row = {
    ...toInventoryCustomCategoryRow({ ...cat, propertyId: pid }),
    property_id: pid,
  };
  const { data, error } = await supabase
    .from('inventory_custom_categories')
    .upsert(row, { onConflict: 'id' })
    .select('id')
    .single();
  if (error) { logErr('upsertInventoryCustomCategory', error); throw error; }
  return String((data as { id: string }).id);
}

/**
 * Delete a custom category. The DB FK (ON DELETE SET NULL) detaches any items,
 * so they simply return to their built-in category's bucket — nothing is lost.
 */
export async function deleteInventoryCustomCategory(
  _uid: string,
  pid: string,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from('inventory_custom_categories')
    .delete()
    .eq('property_id', pid)
    .eq('id', id);
  if (error) { logErr('deleteInventoryCustomCategory', error); throw error; }
}
