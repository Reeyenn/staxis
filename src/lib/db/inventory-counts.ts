// ═══════════════════════════════════════════════════════════════════════════
// Inventory Counts — append-only audit log of count events.
//
// Each Count Mode save writes one row per item, snapshotting the value the
// user typed, the system-estimated value at that moment, and the variance.
// Read endpoints power the reconciliation modal (most-recent saves) and
// future shrinkage trend dashboards.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryCount } from '@/types';
import { supabase, logErr } from './_common';
import { toInventoryCountRow, fromInventoryCountRow } from '../db-mappers';

export async function addInventoryCount(
  _uid: string,
  pid: string,
  count: Omit<InventoryCount, 'id'>,
): Promise<string> {
  const row = { ...toInventoryCountRow({ ...count, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('inventory_counts').insert(row).select('id').single();
  if (error) { logErr('addInventoryCount', error); throw error; }
  return String(inserted.id);
}

/**
 * Bulk-insert a batch of count rows from a single Count Mode save.
 * Single round-trip is faster than N inserts and keeps the rows visually
 * grouped by their identical counted_at timestamp on later reports.
 */
export async function addInventoryCountBatch(
  _uid: string,
  pid: string,
  counts: Array<Omit<InventoryCount, 'id'>>,
): Promise<void> {
  if (counts.length === 0) return;
  const rows = counts.map(c => ({
    ...toInventoryCountRow({ ...c, propertyId: pid }),
    property_id: pid,
  }));
  const { error } = await supabase.from('inventory_counts').insert(rows);
  if (error) { logErr('addInventoryCountBatch', error); throw error; }
}

export async function listInventoryCounts(
  _uid: string,
  pid: string,
  limit = 200,
): Promise<InventoryCount[]> {
  const { data, error } = await supabase
    .from('inventory_counts')
    .select('*')
    .eq('property_id', pid)
    .order('counted_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('listInventoryCounts', error); throw error; }
  return (data ?? []).map(fromInventoryCountRow);
}
