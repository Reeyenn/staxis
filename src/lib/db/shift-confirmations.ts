// ═══════════════════════════════════════════════════════════════════════════
// Shift Confirmations — one row per (property, shift_date, staff_id) when
// Maria sends the SMS confirmations and a housekeeper replies. Powers the
// "who confirmed for tomorrow" UI.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShiftConfirmation } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { fromShiftConfirmationRow } from '../db-mappers';

// Matches fromShiftConfirmationRow in db-mappers.ts. Audit follow-up 2026-05-17.
const SHIFT_CONFIRMATION_FIELDS =
  'token, property_id, staff_id, staff_name, staff_phone, shift_date, status, ' +
  'language, sent_at, responded_at, sms_sent, sms_error';
type ShiftConfirmationRow = Record<string, unknown>;

export function subscribeToShiftConfirmations(
  _uid: string, pid: string, shiftDate: string,
  callback: (confirmations: ShiftConfirmation[]) => void,
): () => void {
  return subscribeTable<ShiftConfirmation>(
    // Single-filter only on realtime — see subscribeToRooms note.
    `shift_confirmations:${pid}:${shiftDate}`, 'shift_confirmations', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('shift_confirmations').select(SHIFT_CONFIRMATION_FIELDS)
        .eq('property_id', pid).eq('shift_date', shiftDate)
        .returns<ShiftConfirmationRow[]>();
      if (error) throw error;
      return (data ?? []).map(fromShiftConfirmationRow);
    },
    callback,
  );
}

export async function getShiftConfirmationsForDate(
  _uid: string, pid: string, shiftDate: string,
): Promise<ShiftConfirmation[]> {
  const { data, error } = await supabase
    .from('shift_confirmations').select(SHIFT_CONFIRMATION_FIELDS)
    .eq('property_id', pid).eq('shift_date', shiftDate)
    .returns<ShiftConfirmationRow[]>();
  if (error) { logErr('getShiftConfirmationsForDate', error); throw error; }
  return (data ?? []).map(fromShiftConfirmationRow);
}
