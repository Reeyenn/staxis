// ═══════════════════════════════════════════════════════════════════════════
// Service contracts — recurring outsourced services (pool service every
// Monday, fire-suppression inspection annually, pest control monthly,
// etc.). Distinct from preventive_tasks (internal recurring work) because
// there's a vendor + a monthly cost attached.
//
// Alerts piggyback on the same generateColdStartAlerts pre-due logic from
// maintenance-ml.ts: 30/14/7 days before next_due_at, then overdue.
//
// Mirrors src/lib/db/equipment.ts: subscribe + add + update + delete.
// ═══════════════════════════════════════════════════════════════════════════

import type { ServiceContract } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toServiceContractRow, fromServiceContractRow } from '../db-mappers';

export function subscribeToServiceContracts(
  _uid: string, pid: string,
  callback: (rows: ServiceContract[]) => void,
): () => void {
  return subscribeTable<ServiceContract>(
    `service_contracts:${pid}`, 'service_contracts', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('service_contracts').select('*')
        .eq('property_id', pid)
        .order('next_due_at', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []).map(fromServiceContractRow);
    },
    callback,
  );
}

export async function listServiceContracts(_uid: string, pid: string): Promise<ServiceContract[]> {
  const { data, error } = await supabase
    .from('service_contracts').select('*').eq('property_id', pid).order('next_due_at');
  if (error) { logErr('listServiceContracts', error); throw error; }
  return (data ?? []).map(fromServiceContractRow);
}

export async function addServiceContract(
  _uid: string, pid: string,
  c: Omit<ServiceContract, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<string> {
  const row = { ...toServiceContractRow({ ...c, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('service_contracts').insert(row).select('id').single();
  if (error) { logErr('addServiceContract', error); throw error; }
  return String(inserted.id);
}

export async function updateServiceContract(
  _uid: string, _pid: string, cid: string, patch: Partial<ServiceContract>,
): Promise<void> {
  const { error } = await supabase.from('service_contracts').update(toServiceContractRow(patch)).eq('id', cid);
  if (error) { logErr('updateServiceContract', error); throw error; }
}

export async function deleteServiceContract(_uid: string, _pid: string, cid: string): Promise<void> {
  const { error } = await supabase.from('service_contracts').delete().eq('id', cid);
  if (error) { logErr('deleteServiceContract', error); throw error; }
}
