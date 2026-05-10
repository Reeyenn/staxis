// ═══════════════════════════════════════════════════════════════════════════
// Vendors — per-property vendor/contractor list (HVAC techs, pool service,
// pest control, fire-suppression, etc.). Linked to Equipment (who installs/
// services), Work Orders (who fixed), and Service Contracts (recurring
// outsourced services).
//
// Mirrors src/lib/db/equipment.ts: subscribe + add + update + delete.
// ═══════════════════════════════════════════════════════════════════════════

import type { Vendor } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toVendorRow, fromVendorRow } from '../db-mappers';

export function subscribeToVendors(
  _uid: string, pid: string,
  callback: (rows: Vendor[]) => void,
): () => void {
  return subscribeTable<Vendor>(
    `vendors:${pid}`, 'vendors', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('vendors').select('*')
        .eq('property_id', pid)
        .order('name', { ascending: true });
      if (error) throw error;
      return (data ?? []).map(fromVendorRow);
    },
    callback,
  );
}

export async function listVendors(_uid: string, pid: string): Promise<Vendor[]> {
  const { data, error } = await supabase
    .from('vendors').select('*').eq('property_id', pid).order('name');
  if (error) { logErr('listVendors', error); throw error; }
  return (data ?? []).map(fromVendorRow);
}

export async function addVendor(
  _uid: string, pid: string,
  v: Omit<Vendor, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<string> {
  const row = { ...toVendorRow({ ...v, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('vendors').insert(row).select('id').single();
  if (error) { logErr('addVendor', error); throw error; }
  return String(inserted.id);
}

export async function updateVendor(
  _uid: string, _pid: string, vid: string, patch: Partial<Vendor>,
): Promise<void> {
  const { error } = await supabase.from('vendors').update(toVendorRow(patch)).eq('id', vid);
  if (error) { logErr('updateVendor', error); throw error; }
}

export async function deleteVendor(_uid: string, _pid: string, vid: string): Promise<void> {
  const { error } = await supabase.from('vendors').delete().eq('id', vid);
  if (error) { logErr('deleteVendor', error); throw error; }
}
