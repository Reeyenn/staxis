// ═══════════════════════════════════════════════════════════════════════════
// Staff — housekeeping crew + front desk. One row per staff member, scoped
// by property_id.
// ═══════════════════════════════════════════════════════════════════════════

import type { StaffMember } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toStaffRow, fromStaffRow } from '../db-mappers';

export async function getStaff(_uid: string, pid: string): Promise<StaffMember[]> {
  const { data, error } = await supabase.from('staff').select('*').eq('property_id', pid);
  if (error) { logErr('getStaff', error); throw error; }
  return (data ?? []).map(fromStaffRow);
}

export function subscribeToStaff(
  _uid: string, pid: string,
  callback: (staff: StaffMember[]) => void,
): () => void {
  return subscribeTable<StaffMember>(
    `staff:${pid}`, 'staff', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase.from('staff').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromStaffRow);
    },
    callback,
  );
}

export async function addStaffMember(_uid: string, pid: string, data: Omit<StaffMember, 'id'>): Promise<string> {
  try {
    const row = { ...toStaffRow(data), property_id: pid };
    const { data: inserted, error } = await supabase
      .from('staff').insert(row).select('id').single();
    if (error) throw error;
    return String(inserted.id);
  } catch (err) { logErr('addStaffMember', err); throw err; }
}

export async function updateStaffMember(_uid: string, _pid: string, sid: string, data: Partial<StaffMember>): Promise<void> {
  try {
    const { error } = await supabase.from('staff').update(toStaffRow(data)).eq('id', sid);
    if (error) throw error;
  } catch (err) { logErr('updateStaffMember', err); throw err; }
}

export async function deleteStaffMember(_uid: string, _pid: string, sid: string): Promise<void> {
  try {
    const { error } = await supabase.from('staff').delete().eq('id', sid);
    if (error) throw error;
  } catch (err) { logErr('deleteStaffMember', err); throw err; }
}
