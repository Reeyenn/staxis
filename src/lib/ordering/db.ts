// ═══════════════════════════════════════════════════════════════════════════
// Inventory vendors — server data layer (service-role).
//
// Every function here runs with supabaseAdmin (bypasses RLS) and is reached
// ONLY from /api/inventory/* routes behind requireOrderingAccess. The vendors
// table (migration 0246) is service-role-only.
//
// 2026-07-18: the purchase-order data layer (catalog, create/send/receive
// orders, spend rollup) was removed with the ordering flow — every hotel
// orders differently and the flow is being redesigned as a per-hotel
// workflow. Vendors survive because inventory items link to a vendor record.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import type { Vendor } from './types';

function fromVendorRow(r: Record<string, unknown>): Vendor {
  return {
    id: String(r.id),
    propertyId: String(r.property_id ?? ''),
    name: String(r.name ?? ''),
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    accountNumber: (r.account_number as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    isActive: r.is_active !== false,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  };
}

export async function listVendors(pid: string, includeInactive = false): Promise<Vendor[]> {
  let q = supabaseAdmin.from('vendors').select('*').eq('property_id', pid);
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q.order('name', { ascending: true });
  if (error) {
    log.error('[ordering] listVendors failed', { pid, err: error.message });
    throw error;
  }
  return (data ?? []).map((r) => fromVendorRow(r as Record<string, unknown>));
}

export interface VendorInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  accountNumber?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export interface InventoryAuditActor {
  userId: string;
  name: string | null;
}

export async function createVendor(
  pid: string,
  input: VendorInput,
  actor: InventoryAuditActor,
): Promise<Vendor> {
  // The RPC writes the vendor and its immutable inventory audit event in one
  // transaction. A direct service-role insert would lose the end-user actor.
  const { data, error } = await supabaseAdmin.rpc('staxis_create_inventory_vendor', {
    p_property_id: pid,
    p_name: input.name,
    p_email: input.email ?? null,
    p_phone: input.phone ?? null,
    p_account_number: input.accountNumber ?? null,
    p_notes: input.notes ?? null,
    p_is_active: input.isActive ?? true,
    p_actor_id: actor.userId,
    p_actor_name: actor.name,
  });
  if (error) {
    log.error('[ordering] createVendor failed', { pid, err: error.message });
    throw error;
  }
  return fromVendorRow(data as Record<string, unknown>);
}

export async function updateVendor(
  pid: string,
  vendorId: string,
  patch: Partial<VendorInput>,
  actor: InventoryAuditActor,
): Promise<Vendor | null> {
  const rpcPatch: Record<string, unknown> = {};
  if (patch.name !== undefined) rpcPatch.name = patch.name;
  if (patch.email !== undefined) rpcPatch.email = patch.email;
  if (patch.phone !== undefined) rpcPatch.phone = patch.phone;
  if (patch.accountNumber !== undefined) rpcPatch.accountNumber = patch.accountNumber;
  if (patch.notes !== undefined) rpcPatch.notes = patch.notes;
  if (patch.isActive !== undefined) rpcPatch.isActive = patch.isActive;

  const { data, error } = await supabaseAdmin.rpc('staxis_update_inventory_vendor', {
    p_property_id: pid,
    p_vendor_id: vendorId,
    p_patch: rpcPatch,
    p_actor_id: actor.userId,
    p_actor_name: actor.name,
  });
  if (error) {
    log.error('[ordering] updateVendor failed', { pid, vendorId, err: error.message });
    throw error;
  }
  return data ? fromVendorRow(data as Record<string, unknown>) : null;
}
