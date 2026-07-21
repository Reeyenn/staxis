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
import { fetchAllRows } from '../supabase-paginate';
import { fromInventoryCountRow } from '../db-mappers';

export async function listInventoryCounts(
  _uid: string,
  pid: string,
  limit = 200,
): Promise<InventoryCount[]> {
  // Cost evidence is hydrated separately through the finance-gated server
  // route. Never let a caller opt a browser PostgREST query into cost columns.
  const columns = 'id,property_id,activity_sequence,count_session_id,item_id,item_name,counted_stock,estimated_stock,variance,counted_at,counted_by,notes,created_at';
  // Paged: PostgREST caps every response at 1000 rows, so a bare
  // .limit(2000) would silently return half the requested history
  // (see supabase-paginate.ts).
  try {
    const rows = await fetchAllRows<Record<string, unknown>>(
      // Cast: the dynamic column list defeats supabase-js's select-string
      // type parser (it infers ParserError instead of rows) — runtime shape
      // is unaffected.
      (from, to) => supabase
        .from('inventory_counts')
        .select(columns)
        .eq('property_id', pid)
        .order('counted_at', { ascending: false })
        .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>,
      { maxRows: limit },
    );
    return asRecordRows(rows).map(fromInventoryCountRow);
  } catch (error) {
    logErr('listInventoryCounts', error);
    throw error;
  }
}
