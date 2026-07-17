// ═══════════════════════════════════════════════════════════════════════════
// Inventory Counts — append-only audit log of count events.
//
// Each Count Mode save writes one row per item, snapshotting the value the
// user typed, the system-estimated value at that moment, and the variance.
// Read endpoints power the reconciliation modal (most-recent saves) and
// future shrinkage trend dashboards.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryCount } from '@/types';
import { supabase, logErr, asRecordRows } from './_common';
import { fromInventoryCountRow } from '../db-mappers';

export async function listInventoryCounts(
  _uid: string,
  pid: string,
  limit = 200,
  includeFinancials = true,
): Promise<InventoryCount[]> {
  const columns = includeFinancials
    ? '*'
    : 'id,property_id,count_session_id,item_id,item_name,counted_stock,estimated_stock,variance,counted_at,counted_by,notes';
  const { data, error } = await supabase
    .from('inventory_counts')
    .select(columns)
    .eq('property_id', pid)
    .order('counted_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('listInventoryCounts', error); throw error; }
  return asRecordRows(data).map(fromInventoryCountRow);
}
