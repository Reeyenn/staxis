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
  //
  // 2026-05-12 (Codex audit): round to cents on write so float artefacts
  // (0.1 * 3 = 0.30000000000000004) don't accumulate in the ledger and
  // make downstream "spend this month" summaries drift between runs.
  const totalCost =
    order.totalCost ??
    (order.unitCost != null
      ? Math.round(Number(order.unitCost) * Number(order.quantity ?? 0) * 100) / 100
      : undefined);

  const row = {
    ...toInventoryOrderRow({ ...order, propertyId: pid, totalCost }),
    property_id: pid,
  };
  const { data: inserted, error } = await supabase
    .from('inventory_orders').insert(row).select('id').single();
  if (error) { logErr('addInventoryOrder', error); throw error; }

  // Stamp the item with last_ordered_at so the UI can show "ordered 3 days ago".
  //
  // 2026-05-12 (Codex audit): previously this update's result was thrown
  // away. If the stamp failed, the order ledger entry was fine but the
  // reorder UI kept showing the item as "never ordered" with the old
  // unit cost — silent inconsistency. Now we capture and log; we don't
  // throw, because the order itself is durably saved and a stale stamp
  // is a recoverable UI issue (not a blocking failure for the caller).
  if (order.itemId) {
    const stampRow: Record<string, unknown> = { last_ordered_at: new Date().toISOString() };
    if (order.vendorName) stampRow.vendor_name = order.vendorName;
    if (order.unitCost != null) stampRow.unit_cost = order.unitCost;
    const { error: stampErr } = await supabase
      .from('inventory').update(stampRow).eq('id', order.itemId);
    if (stampErr) {
      logErr('addInventoryOrder: stamp update failed (non-fatal)', stampErr);
    }
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
