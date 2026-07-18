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

export async function createVendor(pid: string, input: VendorInput): Promise<Vendor> {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      property_id: pid,
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      account_number: input.accountNumber ?? null,
      notes: input.notes ?? null,
      is_active: input.isActive ?? true,
    })
    .select('*')
    .single();
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
): Promise<Vendor | null> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.phone !== undefined) row.phone = patch.phone;
  if (patch.accountNumber !== undefined) row.account_number = patch.accountNumber;
  if (patch.notes !== undefined) row.notes = patch.notes;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;

  const { data, error } = await supabaseAdmin
    .from('vendors')
    .update(row)
    .eq('id', vendorId)
    .eq('property_id', pid) // tenant scope — never touch another property's vendor
    .select('*')
    .maybeSingle();
  if (error) {
    log.error('[ordering] updateVendor failed', { pid, vendorId, err: error.message });
    throw error;
  }
  return data ? fromVendorRow(data as Record<string, unknown>) : null;
}
