// ═══════════════════════════════════════════════════════════════════════════
// Rooms — the central housekeeping table. One row per (property, date,
// room number). Real-time subscriptions drive Maria's Rooms tab and the
// HK-facing pages (see also housekeeper-helpers.ts).
// ═══════════════════════════════════════════════════════════════════════════

import type { Room } from '@/types';
import { supabase, logErr, subscribeTable } from './_common';
import { toRoomRow, fromRoomRow } from '../db-mappers';

export function subscribeToRooms(
  _uid: string, pid: string, date: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeTable<Room>(
    // Realtime postgres_changes only supports a single binary filter, so we
    // narrow on property_id at the Postgres level and use the shouldRefetch
    // predicate to gate on date — that keeps stray events for other dates
    // (yesterday's row getting an inspection update, tomorrow's plan being
    // scraped, …) from triggering a wasteful full-table re-fetch.
    `rooms:${pid}:${date}`, 'rooms', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('rooms').select('*')
        .eq('property_id', pid).eq('date', date);
      if (error) throw error;
      return (data ?? []).map(fromRoomRow);
    },
    callback,
    (payload) => {
      // Only re-fetch when the changed row is on this slice's date. Both
      // `new` and `old` are checked so we still react to deletes (where
      // `new` is null) and inserts (where `old` is null).
      const newDate = (payload.new as { date?: string } | null)?.date;
      const oldDate = (payload.old as { date?: string } | null)?.date;
      return newDate === date || oldDate === date;
    },
  );
}

export function subscribeToAllRooms(
  _uid: string, pid: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeTable<Room>(
    `rooms-all:${pid}`, 'rooms', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase.from('rooms').select('*').eq('property_id', pid);
      if (error) throw error;
      return (data ?? []).map(fromRoomRow);
    },
    callback,
  );
}

export async function addRoom(_uid: string, pid: string, room: Omit<Room, 'id'>): Promise<string> {
  try {
    const row = { ...toRoomRow({ ...room, propertyId: pid }), property_id: pid };
    const { data: inserted, error } = await supabase
      .from('rooms').insert(row).select('id').single();
    if (error) throw error;
    return String(inserted.id);
  } catch (err) { logErr('addRoom', err); throw err; }
}

export async function updateRoom(_uid: string, _pid: string, rid: string, data: Partial<Room>): Promise<void> {
  const { error } = await supabase.from('rooms').update(toRoomRow(data)).eq('id', rid);
  if (error) { logErr('updateRoom', error); throw error; }
}

export async function deleteRoom(_uid: string, _pid: string, rid: string): Promise<void> {
  const { error } = await supabase.from('rooms').delete().eq('id', rid);
  if (error) { logErr('deleteRoom', error); throw error; }
}

export async function bulkAddRooms(_uid: string, pid: string, rooms: Omit<Room, 'id'>[]): Promise<void> {
  try {
    if (rooms.length === 0) return;
    const rows = rooms.map(r => ({ ...toRoomRow({ ...r, propertyId: pid }), property_id: pid }));
    const { error } = await supabase.from('rooms').insert(rows);
    if (error) throw error;
  } catch (err) { logErr('bulkAddRooms', err); throw err; }
}

export async function getRoomsForDate(_uid: string, pid: string, date: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from('rooms').select('*').eq('property_id', pid).eq('date', date);
  if (error) { logErr('getRoomsForDate', error); throw error; }
  return (data ?? []).map(fromRoomRow);
}

// 2026-05-07: Currently unused (no callers in src/), but if it's ever wired up
// it MUST preserve `assigned_to` / `assigned_name` / `assigned_at` so Maria's
// manual board doesn't get silently nuked when rolling rooms forward to a
// new date. The previous version of this function omitted those fields,
// which would have set them to NULL on the new date. Don't reintroduce that.
export async function carryOverRooms(_uid: string, pid: string, fromDate: string, toDate: string): Promise<number> {
  const yesterday = await getRoomsForDate(_uid, pid, fromDate);
  if (yesterday.length === 0) return 0;
  const rows = yesterday.map(r => ({
    property_id: pid,
    number: r.number,
    type: r.type,
    priority: r.priority,
    status: 'dirty',
    date: toDate,
    // Preserve assignment so a forward-roll doesn't wipe Maria's board.
    assigned_to: r.assignedTo ?? null,
    assigned_name: r.assignedName ?? null,
  }));
  const { error } = await supabase.from('rooms').insert(rows);
  if (error) { logErr('carryOverRooms', error); throw error; }
  return yesterday.length;
}
