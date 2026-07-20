// ═══════════════════════════════════════════════════════════════════════════
// Inventory Orders — restock log.
//
// One row per delivery received. Powers the live purchase ledger and reorder
// cadence per item. It remains separate from closed monthly usage. Written by:
//   1. Count Mode reconciliation if any item's counted stock > previous
//      stored stock and the user confirms "Yes, I received an order".
//   2. Manual "Log Order" entry from the item edit modal.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  EffectiveInventoryDelivery,
  InventoryDeliveryCorrection,
  InventoryOrder,
} from '@/types';
import { supabase, logErr, asRecordRow, asRecordRows } from './_common';
import { fromInventoryOrderRow, parseStringField, toDate } from '../db-mappers';
import {
  inventoryDeliveryCorrectionRootChunks,
  mergeInventoryDeliveryCorrections,
} from '../inventory-delivery-corrections';

export async function listInventoryOrders(
  _uid: string,
  pid: string,
  limit = 200,
  includeFinancials = true,
): Promise<InventoryOrder[]> {
  const columns = includeFinancials
    ? '*'
    : 'id,property_id,activity_sequence,item_id,item_name,quantity,quantity_cases,vendor_name,ordered_at,received_at,notes';
  const { data, error } = await supabase
    .from('inventory_orders')
    .select(columns)
    .eq('property_id', pid)
    .eq('entry_kind', 'receipt')
    .order('received_at', { ascending: false })
    .limit(limit);
  if (error) { logErr('listInventoryOrders', error); throw error; }
  return asRecordRows(data).map(fromInventoryOrderRow);
}

function fromCorrectionRow(row: Record<string, unknown>): InventoryDeliveryCorrection {
  return {
    id: String(row.id),
    propertyId: String(row.property_id ?? ''),
    activitySequence: row.activity_sequence == null ? undefined : Number(row.activity_sequence),
    requestId: String(row.request_id ?? ''),
    lineKey: String(row.line_key ?? ''),
    originalOrderId: String(row.original_order_id ?? ''),
    priorCorrectionId: parseStringField(row.prior_correction_id) ?? null,
    kind: row.correction_kind === 'void' ? 'void' : 'correction',
    reason: String(row.reason ?? ''),
    correctedAt: toDate(row.corrected_at),
    correctedBy: parseStringField(row.corrected_by),
    correctedByUserId: parseStringField(row.corrected_by_user_id) ?? null,
    previousItemId: String(row.previous_item_id ?? ''),
    previousItemName: String(row.previous_item_name ?? ''),
    previousQuantity: Number(row.previous_quantity ?? 0),
    previousUnitCost: row.previous_unit_cost == null ? null : Number(row.previous_unit_cost),
    previousTotalCost: row.previous_total_cost == null ? null : Number(row.previous_total_cost),
    correctedItemId: parseStringField(row.corrected_item_id) ?? null,
    correctedItemName: parseStringField(row.corrected_item_name) ?? null,
    correctedQuantity: Number(row.corrected_quantity ?? 0),
    correctedUnitCost: row.corrected_unit_cost == null ? null : Number(row.corrected_unit_cost),
    correctedTotalCost: row.corrected_total_cost == null ? null : Number(row.corrected_total_cost),
    stockEffect: Array.isArray(row.stock_effect) ? row.stock_effect : [],
    createdAt: toDate(row.created_at),
  };
}

export async function listInventoryDeliveryCorrections(
  _uid: string,
  pid: string,
  rootOrderIds: readonly string[],
  includeFinancials = true,
): Promise<InventoryDeliveryCorrection[]> {
  if (rootOrderIds.length === 0) return [];
  const chunks = inventoryDeliveryCorrectionRootChunks(rootOrderIds);
  const responses = await Promise.all(chunks.map((ids) => supabase.rpc(
    'staxis_list_inventory_delivery_corrections',
    {
      p_property_id: pid,
      p_root_order_ids: ids,
      p_include_financials: includeFinancials,
    },
  )));
  const rows: InventoryDeliveryCorrection[] = [];
  for (const { data, error } of responses) {
    if (error) { logErr('listInventoryDeliveryCorrections', error); throw error; }
    rows.push(...asRecordRows(data).map(fromCorrectionRow));
  }
  return rows;
}

export async function listEffectiveInventoryDeliveries(
  uid: string,
  pid: string,
  limit = 200,
  includeFinancials = true,
): Promise<EffectiveInventoryDelivery[]> {
  const orders = await listInventoryOrders(uid, pid, limit, includeFinancials);
  const corrections = await listInventoryDeliveryCorrections(
    uid,
    pid,
    orders.map((order) => order.id),
    includeFinancials,
  );
  return mergeInventoryDeliveryCorrections(orders, corrections);
}

/** Resolve one effective delivery by its stable receipt/root id. This is used
 * by cursor-paged History, whose older rows can outlive the deliberately small
 * recent-delivery list. Corrections are requested first so the database's
 * property, MFA, and financial gates fail closed before the receipt read. */
export async function getEffectiveInventoryDelivery(
  uid: string,
  pid: string,
  rootOrderId: string,
  includeFinancials = true,
): Promise<EffectiveInventoryDelivery | null> {
  const corrections = await listInventoryDeliveryCorrections(
    uid,
    pid,
    [rootOrderId],
    includeFinancials,
  );
  const columns = includeFinancials
    ? '*'
    : 'id,property_id,activity_sequence,item_id,item_name,quantity,quantity_cases,vendor_name,ordered_at,received_at,notes';
  const { data, error } = await supabase
    .from('inventory_orders')
    .select(columns)
    .eq('property_id', pid)
    .eq('id', rootOrderId)
    .eq('entry_kind', 'receipt')
    .maybeSingle();
  if (error) { logErr('getEffectiveInventoryDelivery', error); throw error; }
  const row = asRecordRow(data);
  if (!row) return null;
  return mergeInventoryDeliveryCorrections(
    [fromInventoryOrderRow(row)],
    corrections,
  )[0] ?? null;
}
