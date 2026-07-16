// Transactional inventory writes. Each helper is one Postgres transaction and
// carries a caller-generated request UUID, making a retry safe after a timeout
// or dropped response.

import type { Json } from '@/types/database.types';
import {
  toInventoryCountRpcRows,
  toInventoryDeliveryRpcLines,
  type AtomicInventoryCountRow,
  type InventoryDeliveryLine,
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
