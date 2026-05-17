// ═══════════════════════════════════════════════════════════════════════════
// Schedule Assignments — Maria's HK→room assignments for a given day.
// Distinct from rooms.assigned_to: the schedule_assignments table is the
// single source of truth for "who's working today and who's getting which
// rooms". Rooms.assigned_to is a per-room cache populated when the
// schedule is published.
//
// fromScheduleAssignmentsRow is local — no other domain reads this shape.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, logErr, subscribeTable } from './_common';
import { toDate } from '../db-mappers';

export interface CsvRoomSnapshot {
  number: string;
  type: 'checkout' | 'stayover';
}

export interface ScheduleAssignments {
  date: string;
  roomAssignments: Record<string, string>;
  crew: string[];
  staffNames?: Record<string, string>;
  csvRoomSnapshot?: CsvRoomSnapshot[];
  csvPulledAt?: string | null;
  updatedAt: Date | null;
}

function fromScheduleAssignmentsRow(r: Record<string, unknown>): ScheduleAssignments {
  return {
    date: String(r.date ?? ''),
    roomAssignments: (r.room_assignments as Record<string, string>) ?? {},
    crew: (r.crew as string[]) ?? [],
    staffNames: (r.staff_names as Record<string, string>) ?? {},
    csvRoomSnapshot: (r.csv_room_snapshot as CsvRoomSnapshot[]) ?? [],
    csvPulledAt: (r.csv_pulled_at as string | null) ?? null,
    updatedAt: toDate(r.updated_at),
  };
}

export function subscribeToScheduleAssignments(
  _uid: string, pid: string, date: string,
  callback: (sa: ScheduleAssignments | null) => void,
): () => void {
  return subscribeTable<ScheduleAssignments>(
    // Single-filter only on realtime — see subscribeToRooms note.
    `schedule_assignments:${pid}:${date}`, 'schedule_assignments', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('schedule_assignments').select('*')
        .eq('property_id', pid).eq('date', date).maybeSingle();
      if (error) throw error;
      return data ? [fromScheduleAssignmentsRow(data)] : [];
    },
    (rows) => callback(rows[0] ?? null),
    // Scope on date (the realtime filter only covers property_id).
    (payload) => {
      const newDate = (payload.new as { date?: string } | null)?.date;
      const oldDate = (payload.old as { date?: string } | null)?.date;
      return newDate === date || oldDate === date;
    },
    // schedule_assignments is keyed (property, date) → at most one row per
    // slice. With REPLICA IDENTITY FULL (migration 0133), payload.new is
    // the full row on UPDATE, so we can publish without round-tripping the DB.
    (payload) => {
      if (payload.eventType === 'DELETE') return [];
      if (!payload.new) return null;
      const incomingDate = (payload.new as { date?: string }).date;
      if (incomingDate !== date) return [];
      return [fromScheduleAssignmentsRow(payload.new)];
    },
  );
}

export async function saveScheduleAssignments(
  _uid: string, pid: string, date: string,
  payload: {
    roomAssignments: Record<string, string>;
    crew: string[];
    staffNames?: Record<string, string>;
    csvRoomSnapshot?: CsvRoomSnapshot[];
    csvPulledAt?: string | null;
  },
): Promise<void> {
  const row: Record<string, unknown> = {
    property_id: pid,
    date,
    room_assignments: payload.roomAssignments,
    crew: payload.crew,
    staff_names: payload.staffNames ?? {},
    updated_at: new Date().toISOString(),
  };
  if (payload.csvRoomSnapshot !== undefined) row.csv_room_snapshot = payload.csvRoomSnapshot;
  if (payload.csvPulledAt !== undefined) row.csv_pulled_at = payload.csvPulledAt;
  const { error } = await supabase
    .from('schedule_assignments').upsert(row, { onConflict: 'property_id,date' });
  if (error) { logErr('saveScheduleAssignments', error); throw error; }
}

export async function getScheduleAssignments(
  _uid: string, pid: string, date: string,
): Promise<ScheduleAssignments | null> {
  const { data, error } = await supabase
    .from('schedule_assignments').select('*')
    .eq('property_id', pid).eq('date', date).maybeSingle();
  if (error) { logErr('getScheduleAssignments', error); throw error; }
  return data ? fromScheduleAssignmentsRow(data) : null;
}
