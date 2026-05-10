// ═══════════════════════════════════════════════════════════════════════════
// Inventory Discards — append-only ledger of stained / damaged / lost / theft.
//
// Tracked separately from normal consumption so shrinkage shows up in dollar
// terms. Tara at Home2 tracks stained linen on a separate spreadsheet today;
// this is the digital equivalent. The regional director uses anomaly detection
// over this ledger to flag hotels that "claim no losses, then suddenly need a
// big order."
// ═══════════════════════════════════════════════════════════════════════════

import type { InventoryDiscard, InventoryDiscardReason } from '@/types';
import { supabase, logErr } from './_common';
import { toInventoryDiscardRow, fromInventoryDiscardRow } from '../db-mappers';

export async function addInventoryDiscard(
  _uid: string,
  pid: string,
  discard: Omit<InventoryDiscard, 'id'>,
): Promise<string> {
  // Auto-compute cost_value from snapshotted unit_cost when caller didn't.
  const costValue =
    discard.costValue ??
    (discard.unitCost != null ? Number(discard.unitCost) * Number(discard.quantity ?? 0) : undefined);

  const row = {
    ...toInventoryDiscardRow({ ...discard, propertyId: pid, costValue }),
    property_id: pid,
  };
  const { data: inserted, error } = await supabase
    .from('inventory_discards').insert(row).select('id').single();
  if (error) { logErr('addInventoryDiscard', error); throw error; }
  return String(inserted.id);
}

export async function listInventoryDiscards(
  _uid: string,
  pid: string,
  limit = 500,
): Promise<InventoryDiscard[]> {
  const { data, error } = await supabase
    .from('inventory_discards')
    .select('*')
    .eq('property_id', pid)
    .order('discarded_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('listInventoryDiscards', error); throw error; }
  return (data ?? []).map(fromInventoryDiscardRow);
}

/**
 * Sum discard quantity for a given item since a cutoff date. Used by the
 * reconciliation flow to subtract known losses from the unaccounted-variance
 * calculation. Inclusive of `since`, exclusive of now.
 */
export async function sumDiscardsSince(
  _uid: string,
  pid: string,
  itemId: string,
  since: Date,
): Promise<number> {
  const { data, error } = await supabase
    .from('inventory_discards')
    .select('quantity')
    .eq('property_id', pid)
    .eq('item_id', itemId)
    .gte('discarded_at', since.toISOString());
  if (error) { logErr('sumDiscardsSince', error); throw error; }
  return (data ?? []).reduce((s, r) => s + Number(r.quantity ?? 0), 0);
}

/**
 * Aggregate discards by month and reason for the analytics shrinkage chart.
 * Returns up to `monthsBack` months of rolling history. Reasons map straight
 * to the InventoryDiscardReason union.
 */
export async function listDiscardMonthlyTotals(
  _uid: string,
  pid: string,
  monthsBack = 12,
): Promise<Array<{ monthStart: string; reason: InventoryDiscardReason; quantity: number; costValue: number }>> {
  const cutoff = new Date();
  cutoff.setUTCDate(1);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - (monthsBack - 1));

  const { data, error } = await supabase
    .from('inventory_discards')
    .select('discarded_at, reason, quantity, cost_value')
    .eq('property_id', pid)
    .gte('discarded_at', cutoff.toISOString());
  if (error) { logErr('listDiscardMonthlyTotals', error); throw error; }

  const buckets = new Map<string, { monthStart: string; reason: InventoryDiscardReason; quantity: number; costValue: number }>();
  for (const r of data ?? []) {
    const d = new Date(String(r.discarded_at));
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const reason = (r.reason as InventoryDiscardReason) ?? 'other';
    const k = `${monthKey}|${reason}`;
    const prev = buckets.get(k) ?? { monthStart: monthKey, reason, quantity: 0, costValue: 0 };
    prev.quantity += Number(r.quantity ?? 0);
    prev.costValue += Number(r.cost_value ?? 0);
    buckets.set(k, prev);
  }
  return Array.from(buckets.values()).sort((a, b) => a.monthStart.localeCompare(b.monthStart));
}
