import type { InventoryDiscard, InventoryDiscardReason } from '@/types';
import { supabase, logErr, asRecordRows } from './_common';
import { parseStringField, toDate } from '../db-mappers';

const LOSS_REASONS: readonly InventoryDiscardReason[] = [
  'missing', 'stained', 'damaged', 'lost', 'theft', 'other',
];

function fromInventoryDiscardRow(row: Record<string, unknown>): InventoryDiscard {
  const rawReason = String(row.reason ?? 'other');
  const reason = LOSS_REASONS.includes(rawReason as InventoryDiscardReason)
    ? rawReason as InventoryDiscardReason
    : 'other';
  return {
    id: String(row.id),
    propertyId: String(row.property_id ?? ''),
    activitySequence: row.activity_sequence == null ? undefined : Number(row.activity_sequence),
    itemId: String(row.item_id ?? ''),
    itemName: String(row.item_name ?? ''),
    quantity: Number(row.quantity ?? 0),
    reason,
    costValue: row.cost_value == null ? undefined : Number(row.cost_value),
    unitCost: row.unit_cost == null ? undefined : Number(row.unit_cost),
    discardedAt: toDate(row.discarded_at),
    discardedBy: parseStringField(row.discarded_by),
    notes: parseStringField(row.notes),
    requestId: parseStringField(row.request_id) ?? null,
    expectedStock: row.expected_stock == null ? null : Number(row.expected_stock),
    stockBefore: row.stock_before == null ? null : Number(row.stock_before),
    stockAfter: row.stock_after == null ? null : Number(row.stock_after),
    recordedByUserId: parseStringField(row.recorded_by_user_id) ?? null,
  };
}

/** Loss history for Inventory History. Cost columns are omitted at the query
 * boundary for viewers without the financial capability. */
export async function listInventoryDiscards(
  _uid: string,
  pid: string,
  limit = 200,
  includeFinancials = true,
): Promise<InventoryDiscard[]> {
  const boundedLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)));
  const columns = includeFinancials
    ? '*'
    : 'id,property_id,activity_sequence,item_id,item_name,quantity,reason,discarded_at,discarded_by,notes,request_id,expected_stock,stock_before,stock_after,recorded_by_user_id,created_at';
  const { data, error } = await supabase
    .from('inventory_discards')
    .select(columns)
    .eq('property_id', pid)
    .order('discarded_at', { ascending: false })
    .limit(boundedLimit);
  if (error) { logErr('listInventoryDiscards', error); throw error; }
  return asRecordRows(data).map(fromInventoryDiscardRow);
}
