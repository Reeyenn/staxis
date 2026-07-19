// ═══════════════════════════════════════════════════════════════════════════
// Inventory Orders — restock log.
//
// One row per delivery received. Powers the live purchase ledger and reorder
// cadence per item. It remains separate from closed monthly usage. Written by:
//   1. Count Mode reconciliation if any item's counted stock > previous
//      stored stock and the user confirms "Yes, I received an order".
//   2. Manual "Log Order" entry from the item edit modal.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryOrder } from '@/types';
import { supabase, logErr, asRecordRows } from './_common';
import { fromInventoryOrderRow } from '../db-mappers';

export async function listInventoryOrders(
  _uid: string,
  pid: string,
  limit = 200,
  includeFinancials = true,
): Promise<InventoryOrder[]> {
  const columns = includeFinancials
    ? '*'
    : 'id,property_id,item_id,item_name,quantity,quantity_cases,vendor_name,ordered_at,received_at,notes';
  const { data, error } = await supabase
    .from('inventory_orders')
    .select(columns)
    .eq('property_id', pid)
    .order('received_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('listInventoryOrders', error); throw error; }
  return asRecordRows(data).map(fromInventoryOrderRow);
}
