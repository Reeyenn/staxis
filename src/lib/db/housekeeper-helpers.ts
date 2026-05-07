// ═══════════════════════════════════════════════════════════════════════════
// Housekeeper / Laundry staff-facing helpers
//
// These power /housekeeper/[id] and /laundry/[id] — the HK-facing pages
// where one staff member sees only their own assigned rooms (across any
// date, not just today). Previously the pages ran a Firestore
// collectionGroup('rooms') query with where('assignedTo','==',staffId).
// Here we expose the equivalent on top of the `rooms` Postgres table.
// ═══════════════════════════════════════════════════════════════════════════

import type { Room, StaffMember } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { fromRoomRow, fromStaffRow } from '../db-mappers';

/**
 * Subscribe to every room (across all dates) assigned to a given staff
 * member at a given property. Callback is invoked with the initial
 * snapshot and again on every INSERT/UPDATE/DELETE to `rooms`.
 */
export function subscribeToRoomsForStaff(
  pid: string,
  staffId: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeTable<Room>(
    `rooms-hk:${pid}:${staffId}`,
    'rooms',
    // Single-filter only on realtime — see subscribeToRooms note.
    `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('rooms').select('*')
        .eq('property_id', pid)
        .eq('assigned_to', staffId);
      if (error) throw error;
      return (data ?? []).map(fromRoomRow);
    },
    callback,
  );
}

/**
 * Fetch a single staff member by id, scoped to a property.
 * Returns null if not found. Used by the HK-facing pages to read the
 * staff member's saved `language` preference on first render.
 */
export async function getStaffMember(pid: string, sid: string): Promise<StaffMember | null> {
  const { data, error } = await supabase
    .from('staff').select('*')
    .eq('property_id', pid).eq('id', sid).maybeSingle();
  if (error) { logErr('getStaffMember', error); throw error; }
  return data ? fromStaffRow(data) : null;
}

/**
 * Persist a staff member's language choice. Small convenience wrapper
 * over updateStaffMember — lets the HK-facing language toggle stay
 * one line.
 */
export async function saveStaffLanguage(sid: string, language: 'en' | 'es'): Promise<void> {
  const { error } = await supabase.from('staff').update({ language }).eq('id', sid);
  if (error) { logErr('saveStaffLanguage', error); throw error; }
}
