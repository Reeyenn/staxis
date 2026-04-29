// ═══════════════════════════════════════════════════════════════════════════
// Guest Requests — extra towels, late checkout, room change, etc. Logged
// by front desk and dispatched to housekeeping.
// ═══════════════════════════════════════════════════════════════════════════

import type { GuestRequest } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toGuestRequestRow, fromGuestRequestRow } from '../db-mappers';

export function subscribeToGuestRequests(
  _uid: string, pid: string,
  callback: (requests: GuestRequest[]) => void,
): () => void {
  return subscribeTable<GuestRequest>(
    `guest_requests:${pid}`, 'guest_requests', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('guest_requests').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromGuestRequestRow);
    },
    callback,
  );
}

export async function addGuestRequest(
  _uid: string, pid: string,
  req: Omit<GuestRequest, 'id' | 'createdAt'>,
): Promise<string> {
  const row = { ...toGuestRequestRow({ ...req, propertyId: pid }), property_id: pid };
  const { data: inserted, error } = await supabase
    .from('guest_requests').insert(row).select('id').single();
  if (error) { logErr('addGuestRequest', error); throw error; }
  return String(inserted.id);
}

export async function updateGuestRequest(
  _uid: string, _pid: string, gid: string, data: Partial<GuestRequest>,
): Promise<void> {
  const { error } = await supabase.from('guest_requests').update(toGuestRequestRow(data)).eq('id', gid);
  if (error) { logErr('updateGuestRequest', error); throw error; }
}

export async function deleteGuestRequest(_uid: string, _pid: string, gid: string): Promise<void> {
  const { error } = await supabase.from('guest_requests').delete().eq('id', gid);
  if (error) { logErr('deleteGuestRequest', error); throw error; }
}
