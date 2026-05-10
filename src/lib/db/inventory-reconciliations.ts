// ═══════════════════════════════════════════════════════════════════════════
// Inventory Reconciliations — physical-recount events with $-variance.
//
// The trust layer the regional director asked for. After a few months of AI
// consumption tracking, the user does a physical count. The system snapshots
// its estimate at that moment and we compute:
//
//   unaccounted_variance = physical - (system_estimate - discards_since_last)
//
// Negative = stock vanished without being logged as discard or consumption.
// The dollar impact is what GMs and regional directors care about.
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryReconciliation } from '@/types';
import { supabase, logErr } from './_common';
import { toInventoryReconciliationRow, fromInventoryReconciliationRow } from '../db-mappers';

export async function addInventoryReconciliation(
  _uid: string,
  pid: string,
  rec: Omit<InventoryReconciliation, 'id'>,
): Promise<string> {
  // Snapshot variance and $-impact server-side from the inputs the caller
  // gave us, so we don't trust the client to do the math.
  const variance = rec.physicalCount - (rec.systemEstimate - rec.discardsSinceLast);
  const varianceValue = rec.unitCost != null ? variance * Number(rec.unitCost) : undefined;

  const row = {
    ...toInventoryReconciliationRow({
      ...rec,
      propertyId: pid,
      unaccountedVariance: variance,
      unaccountedVarianceValue: varianceValue,
    }),
    property_id: pid,
  };
  const { data: inserted, error } = await supabase
    .from('inventory_reconciliations').insert(row).select('id').single();
  if (error) { logErr('addInventoryReconciliation', error); throw error; }
  return String(inserted.id);
}

export async function listInventoryReconciliations(
  _uid: string,
  pid: string,
  limit = 200,
): Promise<InventoryReconciliation[]> {
  const { data, error } = await supabase
    .from('inventory_reconciliations')
    .select('*')
    .eq('property_id', pid)
    .order('reconciled_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('listInventoryReconciliations', error); throw error; }
  return (data ?? []).map(fromInventoryReconciliationRow);
}

/**
 * Get the most recent reconciliation per item. Used by the Reconcile mode UI
 * to show "last reconciled X days ago" and to compute the discards-since-last
 * window. Returns a Map keyed by item_id.
 */
export async function lastReconciliationByItem(
  _uid: string,
  pid: string,
): Promise<Map<string, InventoryReconciliation>> {
  const all = await listInventoryReconciliations(_uid, pid, 1000);
  const byItem = new Map<string, InventoryReconciliation>();
  for (const r of all) {
    if (!byItem.has(r.itemId)) byItem.set(r.itemId, r); // first seen = most recent (sorted desc)
  }
  return byItem;
}
