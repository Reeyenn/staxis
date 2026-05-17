// ═══════════════════════════════════════════════════════════════════════════
// Shift Confirmations — one row per (property, shift_date, staff_id) when
// Maria sends the SMS confirmations and a housekeeper replies. Powers the
// "who confirmed for tomorrow" UI.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShiftConfirmation } from '@/types';
import { supabase, logErr, subscribeTable, makeUpsertByIdReducer } from './_common';
import { fromShiftConfirmationRow } from '../db-mappers';

export function subscribeToShiftConfirmations(
  _uid: string, pid: string, shiftDate: string,
  callback: (confirmations: ShiftConfirmation[]) => void,
): () => void {
  return subscribeTable<ShiftConfirmation>(
    // Single-filter only on realtime — see subscribeToRooms note.
    `shift_confirmations:${pid}:${shiftDate}`, 'shift_confirmations', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('shift_confirmations').select('*')
        .eq('property_id', pid).eq('shift_date', shiftDate);
      if (error) throw error;
      return (data ?? []).map(fromShiftConfirmationRow);
    },
    callback,
    // Scope by shift_date (the realtime filter only covers property_id).
    (payload) => {
      const newDate = (payload.new as { shift_date?: string } | null)?.shift_date;
      const oldDate = (payload.old as { shift_date?: string } | null)?.shift_date;
      return newDate === shiftDate || oldDate === shiftDate;
    },
    // REPLICA IDENTITY FULL on shift_confirmations (migration 0133) lets
    // us apply the change locally — confirmations roll in one SMS reply at
    // a time, so amplification isn't the big issue here, but the reducer
    // path also cuts the per-event roundtrip from a refetch to a no-op.
    makeUpsertByIdReducer<ShiftConfirmation>({
      mapRow: fromShiftConfirmationRow,
      isInSlice: (raw) => (raw as { shift_date?: string }).shift_date === shiftDate,
    }),
  );
}

export async function getShiftConfirmationsForDate(
  _uid: string, pid: string, shiftDate: string,
): Promise<ShiftConfirmation[]> {
  const { data, error } = await supabase
    .from('shift_confirmations').select('*')
    .eq('property_id', pid).eq('shift_date', shiftDate);
  if (error) { logErr('getShiftConfirmationsForDate', error); throw error; }
  return (data ?? []).map(fromShiftConfirmationRow);
}
