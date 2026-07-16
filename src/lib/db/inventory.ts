// ═══════════════════════════════════════════════════════════════════════════
// Inventory — supply tracking (towels, linens, toiletries, cleaning
// chemicals). Quantities updated by the back-office team.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryItem } from '@/types';
import { supabase, logErr, subscribeTable, asRecordRows } from './_common';
import { toInventoryRow, fromInventoryRow } from '../db-mappers';

export function subscribeToInventory(
  _uid: string, pid: string,
  callback: (items: InventoryItem[]) => void,
  onError?: (error: unknown) => void,
  includeFinancials = true,
): () => void {
  return subscribeTable<InventoryItem>(
    `inventory:${pid}`, 'inventory', `property_id=eq.${pid}`,
    async () => {
      const columns = includeFinancials
        ? '*'
        : 'id,property_id,created_at,created_by,archived_at,archived_by,name,category,custom_category_id,current_stock,par_level,reorder_at,unit,notes,updated_at,usage_per_checkout,usage_per_stayover,reorder_lead_days,vendor_name,vendor_id,last_ordered_at,last_alerted_at,last_counted_at,pack_size,case_unit';
      const { data, error } = await supabase
        .from('inventory')
        .select(columns)
        .eq('property_id', pid)
        .is('archived_at', null);
      if (error) throw error;
      return asRecordRows(data).map(fromInventoryRow);
    },
    callback,
    undefined,
    undefined,
    onError,
  );
}

type InventoryItemPatch = Omit<
  Partial<InventoryItem>,
  'unitCost' | 'vendorName' | 'currentStock' | 'lastCountedAt' | 'lastOrderedAt'
> & {
  unitCost?: number | null;
  vendorName?: string | null;
};

export async function addInventoryItem(
  _uid: string, pid: string,
  item: Omit<InventoryItem, 'id' | 'updatedAt'>,
  requestedId?: string,
): Promise<string> {
  // Anchor the estimate window via last_counted_at. Honor an explicit
  // lastCountedAt when the caller provides one (e.g. an invoice scan seeding a
  // new item at its DELIVERY date, not "now"). Otherwise stamp now iff a
  // positive currentStock was given — recording an actual count at creation.
  // Defaults (currentStock=0, no lastCountedAt) leave it null so the UI shows
  // "Never" instead of "Just now" right after seeding.
  const row: Record<string, unknown> = { ...toInventoryRow({ ...item, propertyId: pid }), property_id: pid };
  if (requestedId) row.id = requestedId;
  if (item.lastCountedAt instanceof Date) {
    row.last_counted_at = item.lastCountedAt.toISOString();
  } else if (typeof item.currentStock === 'number' && item.currentStock > 0) {
    row.last_counted_at = new Date().toISOString();
  }
  const { data: inserted, error } = await supabase
    .from('inventory').insert(row).select('id').single();
  if (error) {
    // The Add Item sheet supplies a client UUID and an unguessable marker. A
    // duplicate-key response on retry means the first insert may have committed
    // while its response was lost. Treat it as success only when that exact
    // marked row exists in the same property; every other conflict still fails.
    if (requestedId && error.code === '23505' && typeof item.notes === 'string') {
      const { data: existing, error: existingErr } = await supabase
        .from('inventory')
        .select('id, notes')
        .eq('id', requestedId)
        .eq('property_id', pid)
        .is('archived_at', null)
        .maybeSingle();
      if (existingErr) {
        // Verification failed after a duplicate response. Its outcome is
        // ambiguous: keep the durable UUID/payload locked so a later retry can
        // prove whether this exact row exists instead of clearing the envelope.
        throw new Error('Could not verify the existing inventory item after retry.');
      }
      if (existing?.id === requestedId && (
        existing.notes === item.notes || existing.notes == null || existing.notes === ''
      )) {
        return requestedId;
      }
    }
    logErr('addInventoryItem', error);
    throw error;
  }
  return String(inserted.id);
}

export async function updateInventoryItem(
  _uid: string, pid: string, iid: string, data: InventoryItemPatch,
): Promise<void> {
  // Stock and its timestamps are ledger-owned. Keeping this helper metadata-
  // only prevents a future stale caller from accidentally recreating the old
  // split stock/history write path; Postgres enforces the same boundary.
  if ('currentStock' in data || 'lastCountedAt' in data || 'lastOrderedAt' in data) {
    throw new Error('Use an atomic inventory count or delivery operation to change stock.');
  }
  // Scope writes by property_id too (defense-in-depth alongside RLS): a stale
  // item id can't update a row from another property.
  const { data: updated, error } = await supabase
    .from('inventory')
    .update(toInventoryRow(data))
    .eq('id', iid)
    .eq('property_id', pid)
    .is('archived_at', null)
    .select('id')
    .maybeSingle();
  if (error) { logErr('updateInventoryItem', error); throw error; }
  if (!updated) {
    const missing = new Error('Inventory item was not found for the active property. Refresh and try again.');
    logErr('updateInventoryItem', missing);
    throw missing;
  }
}

/**
 * Hide an item from active inventory without destroying the item row or any
 * count/delivery/discard/PO history that points at it.
 *
 * Both id and property are matched (tenant defense-in-depth), and the active
 * guard makes retries explicit instead of silently claiming an already
 * archived or foreign item was changed. The selected row is our affected-row
 * verification; Supabase updates that match zero rows are otherwise reported
 * as successful.
 */
export async function archiveInventoryItem(uid: string, pid: string, iid: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: archived, error } = await supabase
    .from('inventory')
    .update({ archived_at: now, archived_by: uid, updated_at: now })
    .eq('id', iid)
    .eq('property_id', pid)
    .is('archived_at', null)
    .select('id')
    .maybeSingle();
  if (error) { logErr('archiveInventoryItem', error); throw error; }
  if (!archived) {
    const missing = new Error('Inventory item was not found in active inventory for this property. Refresh and try again.');
    logErr('archiveInventoryItem', missing);
    throw missing;
  }
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
    .is('archived_at', null)
    .in('id', itemIds);
  if (error) { logErr('fetchInventoryStockByIds', error); throw error; }
  const out: Record<string, number> = {};
  for (const r of data ?? []) {
    out[String(r.id)] = Number((r as { current_stock?: unknown }).current_stock ?? 0);
  }
  return out;
}
