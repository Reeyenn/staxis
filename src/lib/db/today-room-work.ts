/**
 * Today's per-room work for the housekeeping Schedule tab — Plan v4 bridge.
 *
 * Replaces the deleted `db/plan-snapshots.ts` helper. Where that used to
 * pull `plan_snapshots.rooms[]` (a jsonb array written by the Railway
 * scraper), this calls a SECURITY DEFINER SQL function that derives the
 * same shape live from the new pms_* tables that the vision CUA writes
 * to.
 *
 *   today_room_work_v1(property_id uuid, date date)
 *     → rows of { room_number, stay_type, housekeeper, stayover_day }
 *
 *   today_property_counts_v1(property_id uuid, date date)
 *     → one row of day aggregates (checkouts, stayovers, vacant_clean…)
 *
 * Same shape the deleted helper exposed, so consumers (ScheduleTab,
 * feature-derivation, the ML occupancy feature) can be restored verbatim.
 *
 * Source of truth, in order:
 *   pms_room_status_log       — latest event per room (set by CUA every 30s)
 *   pms_reservations          — today's arrivals + stayovers + departures
 *   pms_housekeeping_assignments — today's per-room assignment
 *   pms_in_house_snapshot     — point-in-time property aggregates
 *   pms_rooms_inventory       — total room inventory (denominator)
 *
 * Auto-populates: as soon as the CUA writes a fresh row to any of those
 * tables, the next call to this helper sees the new data. No batching.
 */

import { supabase } from './_common';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ─── Public shapes ────────────────────────────────────────────────────────

/** One row from today_room_work_v1 RPC. Mirrors what plan_snapshots.rooms[] used to deliver. */
export interface TodayRoomWorkRow {
  /** Room number string (matches the housekeeper-facing label). */
  room_number: string;
  /** 'C/O' = checkout today; 'Stay' = stayover (multi-night, still occupied tomorrow); null = vacant/OOO (no work). */
  stay_type: 'C/O' | 'Stay' | null;
  /** Assigned housekeeper name if one is set in pms_housekeeping_assignments, else null. */
  housekeeper: string | null;
  /** 1-indexed day-of-stay (1 = first night). Null when stay_type is null. */
  stayover_day: number | null;
}

/** One row from today_property_counts_v1 RPC. Property-level aggregates for today. */
export interface TodayPropertyCounts {
  checkouts: number;
  stayovers: number;
  vacant_clean: number;
  vacant_dirty: number;
  ooo: number;
  total_rooms: number;
  total_checkouts_today: number;
  in_house: number;
}

// ─── RPC fetchers ─────────────────────────────────────────────────────────

/**
 * Per-room work for the property on the given date. Returns [] (not null)
 * when the CUA hasn't written anything yet for this property — the tab
 * renders empty rather than crashing.
 */
export async function fetchTodayRoomWork(
  propertyId: string,
  date: string,
): Promise<TodayRoomWorkRow[]> {
  const { data, error } = await supabase.rpc('today_room_work_v1', {
    p_property_id: propertyId,
    p_date: date,
  });
  if (error) {
    // RPC errors surface as user-visible blanks rather than red banners —
    // the most common cause is "CUA hasn't reached this property yet."
    console.warn('fetchTodayRoomWork rpc error:', error.message);
    return [];
  }
  return (data ?? []) as TodayRoomWorkRow[];
}

/**
 * Property-level aggregates. Returns zeros when there's no in-house
 * snapshot yet — keeps the dashboard non-crashing in the bootstrap
 * window.
 */
export async function fetchTodayPropertyCounts(
  propertyId: string,
  date: string,
): Promise<TodayPropertyCounts> {
  const { data, error } = await supabase.rpc('today_property_counts_v1', {
    p_property_id: propertyId,
    p_date: date,
  });
  if (error) {
    console.warn('fetchTodayPropertyCounts rpc error:', error.message);
    return {
      checkouts: 0, stayovers: 0, vacant_clean: 0, vacant_dirty: 0,
      ooo: 0, total_rooms: 0, total_checkouts_today: 0, in_house: 0,
    };
  }
  const row = ((data ?? []) as TodayPropertyCounts[])[0];
  return row ?? {
    checkouts: 0, stayovers: 0, vacant_clean: 0, vacant_dirty: 0,
    ooo: 0, total_rooms: 0, total_checkouts_today: 0, in_house: 0,
  };
}

// ─── Realtime ─────────────────────────────────────────────────────────────

/**
 * Subscribe to changes that affect what fetchTodayRoomWork returns.
 * Calls `onChange()` whenever the CUA writes a new pms_room_status_log
 * row OR a new pms_housekeeping_assignment, OR a today-affecting row
 * lands in pms_reservations. The callback should re-fetch via
 * fetchTodayRoomWork.
 *
 * We subscribe to all three tables filtered by property_id so a remote
 * CUA update lands in the UI within seconds.
 *
 * Returns an unsubscribe function. Safe to call on unmount.
 */
export function subscribeTodayRoomWork(
  propertyId: string,
  onChange: () => void,
): () => void {
  const channels: RealtimeChannel[] = [];

  const tables = [
    'pms_room_status_log',           // CUA writes a row per room every poll
    'pms_housekeeping_assignments',  // manager / CUA assignment swaps
    'pms_reservations',              // same-day check-in flips stay_type
  ] as const;

  for (const table of tables) {
    const ch = supabase
      .channel(`today-room-work:${table}:${propertyId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table,
          filter: `property_id=eq.${propertyId}`,
        },
        () => onChange(),
      )
      .subscribe();
    channels.push(ch);
  }

  return () => {
    for (const ch of channels) {
      void ch.unsubscribe();
    }
  };
}
