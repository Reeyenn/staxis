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
  // Anchor the estimate window via last_counted_at. Honor an explicit
  // lastCountedAt when the caller provides one (e.g. an invoice scan seeding a
  // new item at its DELIVERY date, not "now"). Otherwise stamp now iff a
  // positive currentStock was given — recording an actual count at creation.
  // Defaults (currentStock=0, no lastCountedAt) leave it null so the UI shows
  // "Never" instead of "Just now" right after seeding.
  const row: Record<string, unknown> = { ...toInventoryRow({ ...item, propertyId: pid }), property_id: pid };
  if (item.lastCountedAt instanceof Date) {
    row.last_counted_at = item.lastCountedAt.toISOString();
  } else if (typeof item.currentStock === 'number' && item.currentStock > 0) {
    row.last_counted_at = new Date().toISOString();
  }
  const { data: inserted, error } = await supabase
    .from('inventory').insert(row).select('id').single();
  if (error) { logErr('addInventoryItem', error); throw error; }
  return String(inserted.id);
}

export async function updateInventoryItem(
  _uid: string, pid: string, iid: string, data: Partial<InventoryItem>,
): Promise<void> {
  // Server-side guarantee: if the caller is changing current_stock, they're
  // recording a count, so stamp last_counted_at. Metadata edits (vendor, lead
  // days, usage rates, unit cost, etc.) leave last_counted_at alone — that
  // way the estimate window stays anchored to the real last count and doesn't
  // collapse to "now" every time someone tweaks a number.
  //
  // Caller can still override by explicitly passing lastCountedAt in the patch
  // (used by Count Mode bulk save which already wrote a count and may want
  // to set a uniform timestamp across items).
  const patch: Partial<InventoryItem> = { ...data };
  if ('currentStock' in data && data.currentStock !== undefined && !('lastCountedAt' in data)) {
    patch.lastCountedAt = new Date();
  }
  // Scope writes by property_id too (defense-in-depth alongside RLS): a stale
  // item id can't update a row from another property.
  const { error } = await supabase.from('inventory').update(toInventoryRow(patch)).eq('id', iid).eq('property_id', pid);
  if (error) { logErr('updateInventoryItem', error); throw error; }
}

export async function deleteInventoryItem(_uid: string, pid: string, iid: string): Promise<void> {
  const { error } = await supabase.from('inventory').delete().eq('id', iid).eq('property_id', pid);
  if (error) { logErr('deleteInventoryItem', error); throw error; }
}

/**
 * Fetch the CURRENT stored current_stock for a set of items, keyed by item id.
 *
 * Used at count-save time to compute the auto-"stock-up" delta against the
 * FRESH stored stock rather than the value read at page load. Without this, a
 * delivery received in-app after the page loaded would be double-logged: the
 * count exceeds the stale page-load stock, the sheet fabricates a duplicate
 * order for goods already recorded, and that phantom order inflates consumption
 * in neighbouring learning windows. Scoped by property_id (defense-in-depth
 * alongside RLS). Items missing from the result (deleted between load and save)
 * are simply absent from the map — the caller falls back safely.
 */
export async function fetchInventoryStockByIds(
  _uid: string, pid: string, itemIds: string[],
): Promise<Record<string, number>> {
  if (itemIds.length === 0) return {};
  const { data, error } = await supabase
    .from('inventory')
    .select('id, current_stock')
    .eq('property_id', pid)
    .in('id', itemIds);
  if (error) { logErr('fetchInventoryStockByIds', error); throw error; }
  const out: Record<string, number> = {};
  for (const r of data ?? []) {
    out[String(r.id)] = Number((r as { current_stock?: unknown }).current_stock ?? 0);
  }
  return out;
}
