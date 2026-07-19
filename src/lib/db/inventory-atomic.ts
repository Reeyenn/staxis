// Transactional inventory writes. Each helper is one Postgres transaction and
// carries a caller-generated request UUID, making a retry safe after a timeout
// or dropped response.

import type { Json } from '@/types/database.types';
import {
  toInventoryCountRpcRows,
  toInventoryDeliveryRpcLines,
  toInventoryDeliveryCorrectionRpcLines,
  validateInventoryStockLoss,
  type AtomicInventoryCountRow,
  type InventoryDeliveryCorrectionLine,
  type InventoryDeliveryLine,
  type InventoryStockLossInput,
} from '../inventory-atomic';
import { supabase, logErr } from './_common';

function requireIdentity(propertyId: string, requestId: string): void {
  if (!propertyId.trim()) throw new Error('Property id is required.');
  if (!requestId.trim()) throw new Error('Inventory request id is required.');
}

export async function saveInventoryCountAtomic(
  _uid: string,
  propertyId: string,
  requestId: string,
  countedAt: Date,
  countedBy: string,
  rows: readonly AtomicInventoryCountRow[],
): Promise<Json> {
  requireIdentity(propertyId, requestId);
  if (Number.isNaN(countedAt.getTime())) throw new Error('Counted-at time is invalid.');
  const { data, error } = await supabase.rpc('staxis_save_inventory_count', {
    p_property_id: propertyId,
    p_request_id: requestId,
    p_counted_at: countedAt.toISOString(),
    p_counted_by: countedBy.trim() || 'team',
    p_rows: toInventoryCountRpcRows(rows),
  });
  if (error) {
    logErr('saveInventoryCountAtomic', error);
    throw error;
  }
  return data as Json;
}

export async function receiveInventoryDeliveryAtomic(
  _uid: string,
  propertyId: string,
  requestId: string,
  receivedAt: Date,
  vendorName: string | null | undefined,
  notes: string | null | undefined,
  lines: readonly InventoryDeliveryLine[],
): Promise<Json> {
  requireIdentity(propertyId, requestId);
  if (Number.isNaN(receivedAt.getTime())) throw new Error('Received-at time is invalid.');
  const { data, error } = await supabase.rpc('staxis_receive_inventory_delivery', {
    p_property_id: propertyId,
    p_request_id: requestId,
    p_received_at: receivedAt.toISOString(),
    p_vendor_name: vendorName?.trim() || null,
    p_notes: notes?.trim() || null,
    p_lines: toInventoryDeliveryRpcLines(lines),
  });
  if (error) {
    logErr('receiveInventoryDeliveryAtomic', error);
    throw error;
  }
  return data as Json;
}

export async function recordInventoryStockLossAtomic(
  _uid: string,
  propertyId: string,
  requestId: string,
  recordedAt: Date,
  recordedBy: string,
  input: InventoryStockLossInput,
): Promise<Json> {
  requireIdentity(propertyId, requestId);
  if (Number.isNaN(recordedAt.getTime())) throw new Error('Recorded-at time is invalid.');
  const loss = validateInventoryStockLoss(input);
  const { data, error } = await supabase.rpc('staxis_record_inventory_loss', {
    p_property_id: propertyId,
    p_request_id: requestId,
    p_recorded_at: recordedAt.toISOString(),
    p_recorded_by: recordedBy.trim() || 'team',
    p_item_id: loss.itemId,
    p_expected_stock: loss.expectedStock,
    p_quantity: loss.quantity,
    p_reason: loss.reason,
    p_notes: loss.notes ?? null,
  });
  if (error) {
    logErr('recordInventoryStockLossAtomic', error);
    throw error;
  }
  return data as Json;
}

export async function correctInventoryDeliveryAtomic(
  _uid: string,
  propertyId: string,
  requestId: string,
  correctedAt: Date,
  correctedBy: string,
  reason: string,
  lines: readonly InventoryDeliveryCorrectionLine[],
): Promise<Json> {
  requireIdentity(propertyId, requestId);
  if (Number.isNaN(correctedAt.getTime())) throw new Error('Corrected-at time is invalid.');
  if (!reason.trim()) throw new Error('A delivery correction reason is required.');
  const { data, error } = await supabase.rpc('staxis_correct_inventory_delivery', {
    p_property_id: propertyId,
    p_request_id: requestId,
    p_corrected_at: correctedAt.toISOString(),
    p_corrected_by: correctedBy.trim() || 'team',
    p_reason: reason.trim(),
    p_lines: toInventoryDeliveryCorrectionRpcLines(lines),
  });
  if (error) {
    logErr('correctInventoryDeliveryAtomic', error);
    throw error;
  }
  return data as Json;
}
