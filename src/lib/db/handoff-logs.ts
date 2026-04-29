// ═══════════════════════════════════════════════════════════════════════════
// Handoff Logs — shift-change notes from one team to the next
// (housekeeping AM → PM, front-desk AM → PM, etc.). Acknowledged by the
// receiving team so nothing falls through the cracks.
// ═══════════════════════════════════════════════════════════════════════════

import type { HandoffEntry } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toISO, dropUndefined, fromHandoffRow } from '../db-mappers';

export function subscribeToHandoffLogs(
  _uid: string, pid: string,
  callback: (entries: HandoffEntry[]) => void,
): () => void {
  return subscribeTable<HandoffEntry>(
    `handoff_logs:${pid}`, 'handoff_logs', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('handoff_logs').select('*')
        .eq('property_id', pid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromHandoffRow);
    },
    callback,
  );
}

export async function addHandoffEntry(
  _uid: string, pid: string,
  entry: Omit<HandoffEntry, 'id' | 'createdAt'>,
): Promise<string> {
  const row = dropUndefined({
    property_id: pid,
    shift_type: entry.shiftType,
    author: entry.author,
    notes: entry.notes,
    acknowledged: entry.acknowledged,
    acknowledged_by: entry.acknowledgedBy,
    acknowledged_at: toISO(entry.acknowledgedAt),
  });
  const { data: inserted, error } = await supabase
    .from('handoff_logs').insert(row).select('id').single();
  if (error) { logErr('addHandoffEntry', error); throw error; }
  return String(inserted.id);
}

export async function acknowledgeHandoffEntry(
  _uid: string, _pid: string, hid: string, by: string,
): Promise<void> {
  const { error } = await supabase
    .from('handoff_logs')
    .update({ acknowledged: true, acknowledged_by: by, acknowledged_at: new Date().toISOString() })
    .eq('id', hid);
  if (error) { logErr('acknowledgeHandoffEntry', error); throw error; }
}
