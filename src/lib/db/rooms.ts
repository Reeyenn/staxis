// ═══════════════════════════════════════════════════════════════════════════
// Rooms — the central housekeeping table. One row per (property, date,
// room number). Real-time subscriptions drive Maria's Rooms tab and the
// HK-facing pages (see also housekeeper-helpers.ts).
// ═══════════════════════════════════════════════════════════════════════════

import type { Room } from '@/types';
import { supabase, logErr, subscribeTable, makeUpsertByIdReducer, asRecordRows } from './_common';
import { toRoomRow, fromRoomRow } from '../db-mappers';

// Explicit column list, in lock-step with fromRoomRow() in db-mappers.ts.
// Replaces the old `.select('*')` queries — the old shape returned every
// row column on every fetch, including ML feature columns (cleaning_events
// joins, score blobs) that the housekeeping UI never reads. Audit
// recommendation #5 / #13 in .claude/reports/cost-hotpaths-audit.md.
const ROOM_COLS =
  'id, property_id, number, type, priority, status, assigned_to, assigned_name, ' +
  'started_at, completed_at, date, issue_note, inspected_by, inspected_at, ' +
  'is_dnd, dnd_note, arrival, stayover_day, stayover_minutes, help_requested, ' +
  'checklist, photo_url';

export function subscribeToRooms(
  _uid: string, pid: string, date: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeTable<Room>(
    // Realtime postgres_changes only supports a single binary filter, so we
    // narrow on property_id at the Postgres level and use the shouldRefetch
    // predicate to gate on date — that keeps stray events for other dates
    // (yesterday's row getting an inspection update, tomorrow's plan being
    // scraped, …) from triggering a wasteful re-fetch.
    `rooms:${pid}:${date}`, 'rooms', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('rooms').select(ROOM_COLS)
        .eq('property_id', pid).eq('date', date);
      if (error) throw error;
      return asRecordRows(data).map(fromRoomRow);
    },
    callback,
    (payload) => {
      // Only react when the changed row is on this slice's date. Both
      // `new` and `old` are checked so we still react to deletes (where
      // `new` is null) and inserts (where `old` is null).
      const newDate = (payload.new as { date?: string } | null)?.date;
      const oldDate = (payload.old as { date?: string } | null)?.date;
      return newDate === date || oldDate === date;
    },
    // applyPayload reducer: avoids amplification of bulk updates. Migration
    // 0133 sets REPLICA IDENTITY FULL on rooms so payload.new is complete
    // on UPDATE. The helper returns null when payload.new lacks an id,
    // and the caller falls back to a refetch.
    makeUpsertByIdReducer<Room>({
      mapRow: fromRoomRow,
      isInSlice: (raw) => (raw as { date?: string }).date === date,
    }),
  );
}

export function subscribeToAllRooms(
  _uid: string, pid: string,
  callback: (rooms: Room[]) => void,
): () => void {
  return subscribeTable<Room>(
    `rooms-all:${pid}`, 'rooms', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase.from('rooms').select(ROOM_COLS).eq('property_id', pid);
      if (error) throw error;
      return asRecordRows(data).map(fromRoomRow);
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
    .from('rooms').select(ROOM_COLS).eq('property_id', pid).eq('date', date);
  if (error) { logErr('getRoomsForDate', error); throw error; }
  return asRecordRows(data).map(fromRoomRow);
}

// 2026-05-07: carryOverRooms() was deleted. It had no callers and copying
// rooms forward without re-deriving `type` from the new date's plan_snapshot
// would produce stale labels (yesterday's checkout becomes today's
// stayover/vacant in CA, but the carried-over row would still say
// 'checkout'). Don't re-introduce it without rebuilding the type-rederive
// path AND re-checking the assignment-preservation logic.
