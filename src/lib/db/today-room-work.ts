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

import { logErr, supabase } from './_common';
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

interface TodayReadOptions {
  /**
   * Schedule subscriptions need to distinguish a real empty result from a
   * failed/expired read so they can render a retryable terminal state. Legacy
   * aggregate callers keep their existing safe fallback unless they opt in.
   */
  throwOnError?: boolean;
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
  options: TodayReadOptions = {},
): Promise<TodayRoomWorkRow[]> {
  const { data, error } = await supabase.rpc('today_room_work_v1', {
    p_property_id: propertyId,
    p_date: date,
  });
  if (error) {
    console.warn('fetchTodayRoomWork rpc error:', error.message);
    if (options.throwOnError) throw error;
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
  options: TodayReadOptions = {},
): Promise<TodayPropertyCounts> {
  const { data, error } = await supabase.rpc('today_property_counts_v1', {
    p_property_id: propertyId,
    p_date: date,
  });
  if (error) {
    console.warn('fetchTodayPropertyCounts rpc error:', error.message);
    if (options.throwOnError) throw error;
    return {
      checkouts: 0, stayovers: 0, vacant_clean: 0, vacant_dirty: 0,
      ooo: 0, total_rooms: 0, total_checkouts_today: 0, in_house: 0,
    };
  }
  const row = ((data ?? []) as TodayPropertyCounts[])[0];
  if (!row) {
    // today_property_counts_v1 fails closed: an authorized caller ALWAYS gets a
    // row (its aggregates yield one even for a hotel with no data), so zero
    // rows means the RPC did not recognize this caller's access — a missing or
    // stale token, or a fail-closed standing lookup. Fabricating zeros here
    // painted an authorization failure as "waiting for PMS data" forever, with
    // no error surfaced and no retry offered. Callers that opted into
    // throwOnError get the truth; the rest keep the old zeros fallback.
    const denied = new Error('today_property_counts_v1 returned no row: caller not authorized for this property');
    console.warn('fetchTodayPropertyCounts:', denied.message);
    if (options.throwOnError) throw denied;
    return {
      checkouts: 0, stayovers: 0, vacant_clean: 0, vacant_dirty: 0,
      ooo: 0, total_rooms: 0, total_checkouts_today: 0, in_house: 0,
    };
  }
  return row;
}

// ─── Realtime ─────────────────────────────────────────────────────────────

const TODAY_ROOM_WORK_REALTIME_TABLES = [
  'pms_room_status_log',           // a row per room on every report
  'pms_housekeeping_assignments',  // the PMS-reported plan
  'room_work',                     // our own assignment + lifecycle (0355)
  'pms_reservations',              // same-day check-in flips stay_type
] as const;

/** Consecutive reconnect failures stop after this bounded schedule. A later
 * foreground/online event gives the channel one fresh bounded recovery run. */
export const TODAY_ROOM_WORK_REALTIME_RETRY_DELAYS_MS = [500, 2_000, 5_000, 15_000] as const;
const TODAY_ROOM_WORK_HEALTHY_RESET_MS = 60_000;

type TodayRoomWorkRealtimeTable = typeof TODAY_ROOM_WORK_REALTIME_TABLES[number];

interface TodayRoomWorkChannelSlot {
  table: TodayRoomWorkRealtimeTable;
  channel: RealtimeChannel | null;
  generation: number;
  lastStatus: string | null;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  healthyTimer: ReturnType<typeof setTimeout> | null;
  recovering: boolean;
}

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
  let active = true;
  let recoveryCatchUpQueued = false;

  // Per-subscriber channel suffix. Supabase Realtime dedupes channels
  // by name globally — if two callers (subscribeToPlanSnapshot +
  // subscribeToDashboardByDate, both used by ScheduleTab) created
  // identically-named channels for the same property, the second
  // `.on()` call would throw "cannot add postgres_changes callbacks
  // after subscribe()". Random suffix guarantees uniqueness per call.
  const subscriberId = Math.random().toString(36).slice(2, 10);
  const slots: TodayRoomWorkChannelSlot[] = TODAY_ROOM_WORK_REALTIME_TABLES.map((table) => ({
    table,
    channel: null,
    generation: 0,
    lastStatus: null,
    retryAttempt: 0,
    retryTimer: null,
    healthyTimer: null,
    recovering: false,
  }));

  const clearRetryTimer = (slot: TodayRoomWorkChannelSlot) => {
    if (slot.retryTimer !== null) {
      clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
    }
  };

  const clearHealthyTimer = (slot: TodayRoomWorkChannelSlot) => {
    if (slot.healthyTimer !== null) {
      clearTimeout(slot.healthyTimer);
      slot.healthyTimer = null;
    }
  };

  // Several of the four channels can report the same socket outage in one
  // turn. Coalesce the recovery read so a single disconnect does not fan out
  // four identical RPC requests.
  const catchUpAfterRecovery = () => {
    if (!active || recoveryCatchUpQueued) return;
    recoveryCatchUpQueued = true;
    void Promise.resolve().then(() => {
      recoveryCatchUpQueued = false;
      if (active) onChange();
    });
  };

  const removeChannelSafely = (channel: RealtimeChannel | null) => {
    if (!channel) return;
    try {
      void supabase.removeChannel(channel).catch(() => undefined);
    } catch {
      // Best effort. The generation guard below already makes callbacks from
      // an old channel inert if the client throws while removing it.
    }
  };

  const retireChannel = (slot: TodayRoomWorkChannelSlot) => {
    slot.generation += 1;
    const channel = slot.channel;
    slot.channel = null;
    removeChannelSafely(channel);
  };

  const scheduleRetry = (
    slot: TodayRoomWorkChannelSlot,
    failedGeneration: number,
  ) => {
    if (!active || slot.generation !== failedGeneration || slot.retryTimer !== null) return;
    if (slot.retryAttempt >= TODAY_ROOM_WORK_REALTIME_RETRY_DELAYS_MS.length) return;

    const delay = TODAY_ROOM_WORK_REALTIME_RETRY_DELAYS_MS[slot.retryAttempt];
    slot.retryAttempt += 1;
    slot.retryTimer = setTimeout(() => {
      slot.retryTimer = null;
      if (!active || slot.generation !== failedGeneration) return;
      replaceChannel(slot, false);
    }, delay);
  };

  const openChannel = (slot: TodayRoomWorkChannelSlot, recovering: boolean) => {
    if (!active) return;
    const generation = ++slot.generation;
    slot.lastStatus = null;
    slot.recovering = recovering;

    // A generation suffix matters because removeChannel is asynchronous. A
    // replacement must never receive the still-registered old channel and
    // then throw while adding postgres callbacks to an already-subscribed one.
    const channelName = `today-room-work:${slot.table}:${propertyId}:${subscriberId}:${generation}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: slot.table,
          filter: `property_id=eq.${propertyId}`,
        },
        () => {
          if (active && slot.generation === generation) onChange();
        },
      )
      .subscribe((status, error) => {
        if (!active || slot.generation !== generation) return;
        slot.lastStatus = status;

        if (status === 'SUBSCRIBED') {
          const recovered = slot.recovering;
          slot.recovering = false;
          clearRetryTimer(slot);
          clearHealthyTimer(slot);
          // Reset only after a genuinely stable connection. Resetting on an
          // immediate SUBSCRIBED→CHANNEL_ERROR oscillation would turn the
          // first 500ms delay into an unbounded hammer loop.
          slot.healthyTimer = setTimeout(() => {
            slot.healthyTimer = null;
            if (active && slot.generation === generation && slot.lastStatus === 'SUBSCRIBED') {
              slot.retryAttempt = 0;
            }
          }, TODAY_ROOM_WORK_HEALTHY_RESET_MS);
          if (recovered) catchUpAfterRecovery();
          return;
        }

        if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') return;
        clearHealthyTimer(slot);
        if (status !== 'CLOSED') {
          logErr(
            `today-room-work realtime ${slot.table} ${status}`,
            error ?? new Error(`Realtime channel ${status}`),
          );
        }
        catchUpAfterRecovery();
        scheduleRetry(slot, generation);
      });
    slot.channel = channel;
  };

  function replaceChannel(slot: TodayRoomWorkChannelSlot, resetBudget: boolean): void {
    if (!active) return;
    clearRetryTimer(slot);
    clearHealthyTimer(slot);
    if (resetBudget) slot.retryAttempt = 0;
    retireChannel(slot);
    openChannel(slot, true);
  }

  const channelNeedsRecovery = (slot: TodayRoomWorkChannelSlot): boolean => {
    if (!slot.channel) return true;
    if (
      slot.lastStatus === 'CHANNEL_ERROR'
      || slot.lastStatus === 'TIMED_OUT'
      || slot.lastStatus === 'CLOSED'
    ) return true;
    const state = (slot.channel as unknown as { state?: string }).state;
    return state === 'closed' || state === 'errored';
  };

  const catchUpAndRecover = () => {
    if (!active) return;
    // The snapshot read is the correctness path: even while the WebSocket is
    // reconnecting, foregrounding or regaining network reflects any events
    // that were missed in the background.
    onChange();
    for (const slot of slots) {
      if (channelNeedsRecovery(slot)) replaceChannel(slot, true);
    }
  };

  const onVisibility = () => {
    if (!active || typeof document === 'undefined' || document.hidden) return;
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    if (online) catchUpAndRecover();
  };
  const onOnline = () => {
    if (typeof document === 'undefined' || !document.hidden) catchUpAndRecover();
  };

  for (const slot of slots) openChannel(slot, false);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
  }

  return () => {
    if (!active) return;
    active = false;
    recoveryCatchUpQueued = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline);
    }
    for (const slot of slots) {
      clearRetryTimer(slot);
      clearHealthyTimer(slot);
      retireChannel(slot);
    }
  };
}
