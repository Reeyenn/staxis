/**
 * Plan-snapshot shape — Plan v4 bridge.
 *
 * The original `plan_snapshots` Postgres table was dropped in Plan v4
 * along with the Railway scraper that filled it. The housekeeping
 * Schedule tab (and every downstream consumer) was wired around this
 * shape, so we preserve the type + function signatures and re-derive
 * the data live from the new pms_* tables that the vision CUA writes.
 *
 * Data source chain:
 *   today_room_work_v1(property, date)        → per-room work list
 *   today_property_counts_v1(property, date)  → day-level aggregates
 *   pms_rooms_inventory                       → total inventory
 *
 * The constructed PlanSnapshot is read-only — no one writes back to
 * `plan_snapshots` anymore. The CUA owns room state via
 * pms_room_status_log + pms_reservations.
 */

import { supabase } from './_common';
import {
  fetchTodayRoomWork,
  fetchTodayPropertyCounts,
  subscribeTodayRoomWork,
  type TodayRoomWorkRow,
  type TodayPropertyCounts,
} from './today-room-work';

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
  /** Cleaning minutes per category — read from properties.config when needed. NULL-safe defaults here. */
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

// ─── PlanSnapshot construction from the new bridge ────────────────────────

/**
 * Build a PlanSnapshot from today_*_v1 RPCs. Live derivation — no caching;
 * called on every subscription tick.
 *
 * Most aggregate counts come from today_property_counts_v1.
 * The rooms[] array + the per-category roomNumbers arrays come from
 * today_room_work_v1 grouped by stay_type.
 *
 * Cleaning-minute fields (checkoutMinutes, stayover_day1_minutes, etc.)
 * come from `properties.config.cleaningMinutes` — the same source the
 * old plan_snapshots cron used. NULL-safe defaults (30/15/20/5) when
 * the config is absent.
 */
async function buildSnapshot(pid: string, date: string): Promise<PlanSnapshot> {
  const [workRows, counts, propRow, latestEventRow] = await Promise.all([
    fetchTodayRoomWork(pid, date),
    fetchTodayPropertyCounts(pid, date),
    supabase.from('properties').select('config').eq('id', pid).maybeSingle(),
    supabase.from('pms_room_status_log')
      .select('changed_at')
      .eq('property_id', pid)
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const config = (propRow.data?.config ?? {}) as Record<string, unknown>;
  const cm = (config.cleaningMinutes ?? {}) as Record<string, unknown>;
  const checkoutMinutes = numOr(cm.checkout, 30);
  const stayoverDay1Minutes = numOr(cm.stayoverDay1, 15);
  const stayoverDay2Minutes = numOr(cm.stayoverDay2, 20);
  const vacantDirtyMinutes = numOr(cm.vacantDirty, 30);
  const shiftMinutes = numOr(cm.shift, 420);

  const checkoutRooms: string[] = [];
  const stayoverDay1Rooms: string[] = [];
  const stayoverDay2Rooms: string[] = [];
  const stayoverOtherRooms: string[] = [];
  const stayoverArrivalRooms: string[] = [];
  const rooms: PlanSnapshot['rooms'] = [];

  for (const r of workRows) {
    const stayoverDay = r.stayover_day ?? null;
    if (r.stay_type === 'C/O') checkoutRooms.push(r.room_number);
    else if (r.stay_type === 'Stay') {
      if (stayoverDay === 1) stayoverDay1Rooms.push(r.room_number);
      else if (stayoverDay === 2) stayoverDay2Rooms.push(r.room_number);
      else stayoverOtherRooms.push(r.room_number);
    }
    rooms.push({
      number: r.room_number,
      roomType: '',
      status: '',
      condition: '',
      stayType: r.stay_type,
      service: '',
      adults: 0,
      children: 0,
      housekeeper: r.housekeeper,
      arrival: null,
      departure: null,
      lastClean: null,
      stayoverDay,
    });
  }

  const totalCleaningMinutes =
    checkoutRooms.length * checkoutMinutes +
    stayoverDay1Rooms.length * stayoverDay1Minutes +
    stayoverDay2Rooms.length * stayoverDay2Minutes +
    counts.vacant_dirty * vacantDirtyMinutes;
  const recommendedHKs = shiftMinutes > 0
    ? Math.max(0, Math.ceil(totalCleaningMinutes / shiftMinutes))
    : 0;

  const latestEventAt = latestEventRow.data?.changed_at
    ? new Date(latestEventRow.data.changed_at as string)
    : null;

  return {
    date,
    pulledAt: latestEventAt,
    pullType: 'evening',
    totalRooms: counts.total_rooms,
    checkouts: counts.checkouts,
    stayovers: counts.stayovers,
    stayoverDay1: stayoverDay1Rooms.length,
    stayoverDay2: stayoverDay2Rooms.length,
    stayoverArrivalDay: stayoverArrivalRooms.length,
    stayoverUnknown: stayoverOtherRooms.length,
    arrivals: 0,
    vacantClean: counts.vacant_clean,
    vacantDirty: counts.vacant_dirty,
    ooo: counts.ooo,
    checkoutMinutes,
    stayoverDay1Minutes,
    stayoverDay2Minutes,
    vacantDirtyMinutes,
    totalCleaningMinutes,
    recommendedHKs,
    checkoutRoomNumbers: checkoutRooms,
    stayoverDay1RoomNumbers: stayoverDay1Rooms,
    stayoverDay2RoomNumbers: stayoverDay2Rooms,
    stayoverArrivalRoomNumbers: stayoverArrivalRooms,
    arrivalRoomNumbers: [],
    vacantCleanRoomNumbers: [],
    vacantDirtyRoomNumbers: [],
    oooRoomNumbers: [],
    rooms,
  };
}

function numOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/**
 * Subscribe to changes in today's plan snapshot for (uid, pid, date).
 *
 * Replaces the original pg-realtime subscription to plan_snapshots. Now
 * watches the 3 source tables (pms_room_status_log, pms_reservations,
 * pms_housekeeping_assignments) and re-runs the build on any change.
 *
 * The `uid` argument is kept for call-site compatibility (the Schedule
 * tab passes it) and is ignored — the bridge is property-scoped, not
 * user-scoped.
 */
export function subscribeToPlanSnapshot(
  _uid: string,
  pid: string,
  date: string,
  callback: (snapshot: PlanSnapshot | null) => void,
): () => void {
  let active = true;
  const refresh = async () => {
    try {
      const snap = await buildSnapshot(pid, date);
      if (active) callback(snap);
    } catch {
      if (active) callback(null);
    }
  };
  void refresh();
  const unsub = subscribeTodayRoomWork(pid, () => { void refresh(); });
  return () => { active = false; unsub(); };
}

// Tiny re-export shim — TodayRoomWorkRow + the wrappers stay accessible
// to anything that's already using them.
export type { TodayRoomWorkRow, TodayPropertyCounts };
export { fetchTodayRoomWork, fetchTodayPropertyCounts };
