// ═══════════════════════════════════════════════════════════════════════════
// Plan Snapshots — one row per (property, date, pull_type) capturing the
// full housekeeping plan output of the Choice Advantage scraper. Powers
// Maria's Schedule tab and the morning planner.
//
// fromPlanSnapshotRow is local to this file because no other domain reads
// the same row shape.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, subscribeTable } from './_common';
import { toDate } from '../db-mappers';

export interface PlanSnapshot {
  date: string;
  pulledAt: Date | null;
  pullType: 'evening' | 'morning';
  totalRooms: number;
  checkouts: number;
  stayovers: number;
  stayoverDay1: number;
  stayoverDay2: number;
  stayoverArrivalDay: number;
  stayoverUnknown: number;
  arrivals: number;
  vacantClean: number;
  vacantDirty: number;
  ooo: number;
  checkoutMinutes: number;
  stayoverDay1Minutes: number;
  stayoverDay2Minutes: number;
  vacantDirtyMinutes: number;
  totalCleaningMinutes: number;
  recommendedHKs: number;
  checkoutRoomNumbers: string[];
  stayoverDay1RoomNumbers: string[];
  stayoverDay2RoomNumbers: string[];
  stayoverArrivalRoomNumbers: string[];
  arrivalRoomNumbers: string[];
  vacantCleanRoomNumbers: string[];
  vacantDirtyRoomNumbers: string[];
  oooRoomNumbers: string[];
  rooms: Array<{
    number: string;
    roomType: string;
    status: string;
    condition: string;
    stayType: string | null;
    service: string;
    adults: number;
    children: number;
    housekeeper: string | null;
    arrival: string | null;
    departure: string | null;
    lastClean: string | null;
    stayoverDay?: number | null;
    stayoverMinutes?: number;
  }>;
}

function fromPlanSnapshotRow(r: Record<string, unknown>): PlanSnapshot {
  return {
    date: String(r.date ?? ''),
    pulledAt: toDate(r.pulled_at),
    pullType: (r.pull_type as PlanSnapshot['pullType']) ?? 'evening',
    totalRooms: Number(r.total_rooms ?? 0),
    checkouts: Number(r.checkouts ?? 0),
    stayovers: Number(r.stayovers ?? 0),
    stayoverDay1: Number(r.stayover_day1 ?? 0),
    stayoverDay2: Number(r.stayover_day2 ?? 0),
    stayoverArrivalDay: Number(r.stayover_arrival_day ?? 0),
    stayoverUnknown: Number(r.stayover_unknown ?? 0),
    arrivals: Number(r.arrivals ?? 0),
    vacantClean: Number(r.vacant_clean ?? 0),
    vacantDirty: Number(r.vacant_dirty ?? 0),
    ooo: Number(r.ooo ?? 0),
    checkoutMinutes: Number(r.checkout_minutes ?? 0),
    stayoverDay1Minutes: Number(r.stayover_day1_minutes ?? 0),
    stayoverDay2Minutes: Number(r.stayover_day2_minutes ?? 0),
    vacantDirtyMinutes: Number(r.vacant_dirty_minutes ?? 0),
    totalCleaningMinutes: Number(r.total_cleaning_minutes ?? 0),
    recommendedHKs: Number(r.recommended_hks ?? 0),
    checkoutRoomNumbers: (r.checkout_room_numbers as string[]) ?? [],
    stayoverDay1RoomNumbers: (r.stayover_day1_room_numbers as string[]) ?? [],
    stayoverDay2RoomNumbers: (r.stayover_day2_room_numbers as string[]) ?? [],
    stayoverArrivalRoomNumbers: (r.stayover_arrival_room_numbers as string[]) ?? [],
    arrivalRoomNumbers: (r.arrival_room_numbers as string[]) ?? [],
    vacantCleanRoomNumbers: (r.vacant_clean_room_numbers as string[]) ?? [],
    vacantDirtyRoomNumbers: (r.vacant_dirty_room_numbers as string[]) ?? [],
    oooRoomNumbers: (r.ooo_room_numbers as string[]) ?? [],
    rooms: (r.rooms as PlanSnapshot['rooms']) ?? [],
  };
}

export function subscribeToPlanSnapshot(
  _uid: string, pid: string, date: string,
  callback: (snapshot: PlanSnapshot | null) => void,
): () => void {
  return subscribeTable<PlanSnapshot>(
    // Single-filter only on realtime — see subscribeToRooms note.
    `plan_snapshots:${pid}:${date}`, 'plan_snapshots', `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('plan_snapshots').select('*')
        .eq('property_id', pid).eq('date', date).maybeSingle();
      if (error) throw error;
      return data ? [fromPlanSnapshotRow(data)] : [];
    },
    (rows) => callback(rows[0] ?? null),
  );
}
