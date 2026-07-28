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
  DEFAULT_CHECKOUT_MINUTES,
  DEFAULT_SHIFT_MINUTES,
  DEFAULT_STAYOVER_DAY1_MINUTES,
  DEFAULT_STAYOVER_DAY2_MINUTES,
} from '@/lib/forecast';
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
  /** Cleaning minutes per category — the hotel's own `properties` columns, with the shared `src/lib/forecast` fallbacks. */
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
 * Cleaning-minute fields come from the hotel's OWN columns on `properties`
 * — the same four `/api/housekeeping/forecast` reads, so the Schedule tab
 * and the Forecast screen answer with one set of numbers. Shared fallbacks
 * from `src/lib/forecast` apply when a column is null.
 *
 * They used to be read from `properties.config.cleaningMinutes`. THAT COLUMN
 * HAS NEVER EXISTED — not in any migration, not in production. PostgREST
 * answered `42703 column properties.config does not exist`, the error landed
 * in `propRow.error` where nothing looked at it, `propRow.data` stayed null,
 * and every hotel silently got the hard-coded fallbacks no matter what its
 * manager had set in Settings → Clean Times. The screen was never wrong-
 * looking, just quietly wrong, which is why it survived this long.
 *
 * One visible consequence of reading the real columns: `shift_minutes` is a
 * NOT NULL column defaulting to 480, so `recommendedHKs` now divides by the
 * hotel's actual shift length instead of the 420 fallback — the same divisor
 * the Forecast screen and the crew board have always used. The two screens
 * agreed on paper (see the comment on DEFAULT_SHIFT_MINUTES) and disagreed in
 * fact until now.
 */
async function buildSnapshot(pid: string, date: string): Promise<PlanSnapshot> {
  const [workRows, counts, propRow] = await Promise.all([
    fetchTodayRoomWork(pid, date, { throwOnError: true }),
    fetchTodayPropertyCounts(pid, date, { throwOnError: true }),
    supabase
      .from('properties')
      .select('checkout_minutes, stayover_day1_minutes, stayover_day2_minutes, shift_minutes')
      .eq('id', pid)
      .maybeSingle(),
  ]);

  if (propRow.error) throw propRow.error;
  if (!propRow.data) throw new Error('Property cleaning settings are unavailable.');
  const prop = (propRow.data ?? {}) as Record<string, unknown>;
  const checkoutMinutes = numOr(prop.checkout_minutes, DEFAULT_CHECKOUT_MINUTES);
  const stayoverDay1Minutes = numOr(prop.stayover_day1_minutes, DEFAULT_STAYOVER_DAY1_MINUTES);
  const stayoverDay2Minutes = numOr(prop.stayover_day2_minutes, DEFAULT_STAYOVER_DAY2_MINUTES);
  // A vacant-dirty room is a full clean, so it costs what a checkout costs.
  // There is no separate column for it, and inventing one to hold the same
  // number the hotel already gave us would be a second place to keep right.
  const vacantDirtyMinutes = checkoutMinutes;
  const shiftMinutes = numOr(prop.shift_minutes, DEFAULT_SHIFT_MINUTES);

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

  // `pulledAt` (the "last pulled at" freshness on the Schedule tab) used to
  // come from a direct read of pms_room_status_log via the anon browser
  // client. pms_* tables are RLS deny-all for anon AND authenticated, so
  // that read silently returned nothing (the #1 recurring Staxis bug). The
  // bridge RPCs (today_room_work_v1 / today_property_counts_v1) don't expose
  // a max(changed_at), so we degrade: leave pulledAt null and let the
  // indicator simply not render, rather than depend on a read RLS blocks.
  // See concerns — a follow-up SECURITY DEFINER freshness RPC could restore it.
  const latestEventAt = null;

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
  let refreshSequence = 0;
  const refresh = async () => {
    const requestSequence = ++refreshSequence;
    try {
      const snap = await buildSnapshot(pid, date);
      if (active && requestSequence === refreshSequence) callback(snap);
    } catch {
      if (active && requestSequence === refreshSequence) callback(null);
    }
  };
  void refresh();
  const unsub = subscribeTodayRoomWork(pid, () => { void refresh(); });
  return () => {
    active = false;
    refreshSequence += 1;
    unsub();
  };
}

// Tiny re-export shim — TodayRoomWorkRow + the wrappers stay accessible
// to anything that's already using them.
export type { TodayRoomWorkRow, TodayPropertyCounts };
export { fetchTodayRoomWork, fetchTodayPropertyCounts };
