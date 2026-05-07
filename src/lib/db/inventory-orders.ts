// ═══════════════════════════════════════════════════════════════════════════
// Inventory Orders — restock log.
//
// One row per delivery received. Powers spend-this-month metrics and
// reorder cadence per item. Write triggered by:
//   1. Count Mode reconciliation if any item's counted stock > previous
//      stored stock and the user confirms "Yes, I received an order".
//   2. Manual "Log Order" entry from the item edit modal.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryOrder } from '@/types';
import { supabase, logErr } from './_common';
import { toInventoryOrderRow, fromInventoryOrderRow } from '../db-mappers';

export async function addInventoryOrder(
  _uid: string,
  pid: string,
  order: Omit<InventoryOrder, 'id'>,
): Promise<string> {
  // Auto-compute total_cost when both pieces are present so callers don't
  // have to do it themselves.
  const totalCost =
    order.totalCost ??
    (order.unitCost != null ? Number(order.unitCost) * Number(order.quantity ?? 0) : undefined);

  const row = {
    ...toInventoryOrderRow({ ...order, propertyId: pid, totalCost }),
    property_id: pid,
  };
  const { data: inserted, error } = await supabase
    .from('inventory_orders').insert(row).select('id').single();
  if (error) { logErr('addInventoryOrder', error); throw error; }

  // Stamp the item with last_ordered_at so the UI can show "ordered 3 days ago".
  if (order.itemId) {
    const stampRow: Record<string, unknown> = { last_ordered_at: new Date().toISOString() };
    if (order.vendorName) stampRow.vendor_name = order.vendorName;
    if (order.unitCost != null) stampRow.unit_cost = order.unitCost;
    await supabase.from('inventory').update(stampRow).eq('id', order.itemId);
  }

  return String(inserted.id);
}

export async function listInventoryOrders(
  _uid: string,
  pid: string,
  limit = 200,
): Promise<InventoryOrder[]> {
  const { data, error } = await supabase
    .from('inventory_orders')
    .select('*')
    .eq('property_id', pid)
    .order('received_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('listInventoryOrders', error); throw error; }
  return (data ?? []).map(fromInventoryOrderRow);
}
