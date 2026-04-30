// ═══════════════════════════════════════════════════════════════════════════
// Cleaning Events (Migration 0012)
// ═══════════════════════════════════════════════════════════════════════════
//
// Permanent audit log — one row per Done tap. Powers the Housekeeping
// Performance tab. See supabase/migrations/0012_cleaning_events.sql for the
// schema and lifecycle rules.
//
// IMPORTANT: This table is independent of the rooms table. The
// populate-rooms-from-plan route wipes started_at/completed_at on every
// re-pull, but this audit log persists forever. That's the whole point.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, logErr, subscribeTable } from './_common';

export type CleaningEventStatus = 'recorded' | 'discarded' | 'flagged' | 'approved' | 'rejected';

export interface CleaningEvent {
  id: string;
  propertyId: string;
  date: string;             // 'YYYY-MM-DD' operational date
  roomNumber: string;
  roomType: 'checkout' | 'stayover';
  stayoverDay: 1 | 2 | null; // bucketed: 1=S1 (light), 2=S2 (full), null=checkout
  staffId: string | null;
  staffName: string;
  startedAt: Date;
  completedAt: Date;
  durationMinutes: number;
  status: CleaningEventStatus;
  flagReason: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

// Business-rule thresholds. Mirror the migration's CASE expressions so we
// produce identical status values in TS-side inserts. If you change these,
// re-run the migration to keep historical data consistent.
export const CLEANING_DISCARD_UNDER_MIN = 3;
export const CLEANING_FLAG_OVER_MIN = 60;

// Computes the bucketed S1/S2 cycle from the raw scraper-set stayover_day
// (1, 2, 3, 4, …). Odd → 1 (S1 light), Even → 2 (S2 full). Returns null for
// stayover_day = 0 (arrival day) or non-stayover types.
export function bucketStayoverDay(stayoverDay: number | null | undefined, roomType: string): 1 | 2 | null {
  if (roomType !== 'stayover') return null;
  if (typeof stayoverDay !== 'number' || stayoverDay <= 0) return null;
  return ((stayoverDay - 1) % 2) + 1 as 1 | 2;
}

// Pure function for status classification — easy to unit test.
export function classifyCleaningEvent(durationMinutes: number): { status: CleaningEventStatus; flagReason: string | null } {
  if (durationMinutes < CLEANING_DISCARD_UNDER_MIN) return { status: 'discarded', flagReason: 'under_3min' };
  if (durationMinutes > CLEANING_FLAG_OVER_MIN) return { status: 'flagged', flagReason: 'over_60min' };
  return { status: 'recorded', flagReason: null };
}

function fromCleaningEventRow(r: Record<string, unknown>): CleaningEvent {
  return {
    id: String(r.id),
    propertyId: String(r.property_id),
    date: String(r.date),
    roomNumber: String(r.room_number),
    roomType: r.room_type as 'checkout' | 'stayover',
    stayoverDay: r.stayover_day === 1 ? 1 : r.stayover_day === 2 ? 2 : null,
    staffId: r.staff_id ? String(r.staff_id) : null,
    staffName: String(r.staff_name ?? 'Unknown'),
    startedAt: new Date(String(r.started_at)),
    completedAt: new Date(String(r.completed_at)),
    durationMinutes: Number(r.duration_minutes ?? 0),
    status: r.status as CleaningEventStatus,
    flagReason: r.flag_reason ? String(r.flag_reason) : null,
    reviewedBy: r.reviewed_by ? String(r.reviewed_by) : null,
    reviewedAt: r.reviewed_at ? new Date(String(r.reviewed_at)) : null,
    createdAt: new Date(String(r.created_at)),
  };
}

/**
 * Insert one cleaning event. Called by the housekeeper page when "Done" is
 * tapped. Computes duration, status, and flag_reason from the inputs.
 *
 * Optional ML features: when populating features (on Done tap), pass them
 * via the features parameter. All features are nullable — if absent, columns
 * stay NULL. See migration 0021 for the spec of each feature.
 *
 * Idempotent: re-clicking "Done" with the same started_at/completed_at hits
 * the unique constraint and is silently ignored. Returns null on any error
 * — the caller should NOT block the room update on this insert.
 */
export async function insertCleaningEvent(input: {
  propertyId: string;
  date: string;
  roomNumber: string;
  roomType: 'checkout' | 'stayover';
  stayoverDay: 1 | 2 | null;
  staffId: string | null;
  staffName: string;
  startedAt: Date;
  completedAt: Date;
  // ML feature snapshot (all optional, all nullable)
  features?: {
    dayOfWeek?: number | null;
    dayOfStayRaw?: number | null;
    roomFloor?: number | null;
    occupancyAtStart?: number | null;
    totalCheckoutsToday?: number | null;
    totalRoomsAssignedToHk?: number | null;
    routePosition?: number | null;
    minutesSinceShiftStart?: number | null;
    wasDndDuringClean?: boolean | null;
    weatherClass?: string | null;
  };
}): Promise<CleaningEvent | null> {
  const durationMs = input.completedAt.getTime() - input.startedAt.getTime();
  const durationMinutes = Math.max(0, durationMs / 60_000);
  const { status, flagReason } = classifyCleaningEvent(durationMinutes);

  const row: Record<string, unknown> = {
    property_id: input.propertyId,
    date: input.date,
    room_number: input.roomNumber,
    room_type: input.roomType,
    stayover_day: input.stayoverDay,
    staff_id: input.staffId,
    staff_name: input.staffName || 'Unknown',
    started_at: input.startedAt.toISOString(),
    completed_at: input.completedAt.toISOString(),
    duration_minutes: Number(durationMinutes.toFixed(2)),
    status,
    flag_reason: flagReason,
  };

  // Populate ML features if provided. All are optional and nullable.
  if (input.features) {
    if (input.features.dayOfWeek !== undefined) row.day_of_week = input.features.dayOfWeek;
    if (input.features.dayOfStayRaw !== undefined) row.day_of_stay_raw = input.features.dayOfStayRaw;
    if (input.features.roomFloor !== undefined) row.room_floor = input.features.roomFloor;
    if (input.features.occupancyAtStart !== undefined) row.occupancy_at_start = input.features.occupancyAtStart;
    if (input.features.totalCheckoutsToday !== undefined) row.total_checkouts_today = input.features.totalCheckoutsToday;
    if (input.features.totalRoomsAssignedToHk !== undefined) row.total_rooms_assigned_to_hk = input.features.totalRoomsAssignedToHk;
    if (input.features.routePosition !== undefined) row.route_position = input.features.routePosition;
    if (input.features.minutesSinceShiftStart !== undefined) row.minutes_since_shift_start = input.features.minutesSinceShiftStart;
    if (input.features.wasDndDuringClean !== undefined) row.was_dnd_during_clean = input.features.wasDndDuringClean;
    if (input.features.weatherClass !== undefined) row.weather_class = input.features.weatherClass;
  }

  const { data, error } = await supabase
    .from('cleaning_events')
    .upsert(row, {
      onConflict: 'property_id,date,room_number,started_at,completed_at',
      ignoreDuplicates: true,
    })
    .select()
    .maybeSingle();

  if (error) {
    logErr('insertCleaningEvent', error);
    return null;
  }
  return data ? fromCleaningEventRow(data) : null;
}

/**
 * Fetch cleaning events for a property in a date range. Used by the
 * Performance API endpoints. Discarded entries are excluded by default
 * (they're not useful for analytics) — pass includeDiscarded=true for the
 * raw audit dump (e.g., CSV export).
 *
 * Result cap: defaults to 5_000 rows. At ~50 rooms × ~30 days × 1.2 events
 * per room-day that's ~1_800 typical events for a month view, so 5k is a
 * 2-3x headroom buffer that prevents a runaway "select * over 6 months"
 * call from returning 30k rows and OOM'ing the browser. Caller can pass
 * a higher limit explicitly if they really need it (CSV export of an
 * entire year, etc.).
 */
export async function getCleaningEventsForRange(
  pid: string,
  fromDate: string,
  toDate: string,
  options: { includeDiscarded?: boolean; limit?: number } = {},
): Promise<CleaningEvent[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 5_000, 50_000));
  let q = supabase
    .from('cleaning_events')
    .select('*')
    .eq('property_id', pid)
    .gte('date', fromDate)
    .lte('date', toDate)
    .order('completed_at', { ascending: false })
    .limit(limit);

  if (!options.includeDiscarded) {
    q = q.neq('status', 'discarded');
  }

  const { data, error } = await q;
  if (error) { logErr('getCleaningEventsForRange', error); throw error; }
  return (data ?? []).map(fromCleaningEventRow);
}

/**
 * Get all entries currently waiting on Mario's flag review. Sorted oldest
 * first so the queue feels like a FIFO inbox.
 */
export async function getFlaggedCleaningEvents(pid: string): Promise<CleaningEvent[]> {
  const { data, error } = await supabase
    .from('cleaning_events')
    .select('*')
    .eq('property_id', pid)
    .eq('status', 'flagged')
    .order('created_at', { ascending: true });
  if (error) { logErr('getFlaggedCleaningEvents', error); throw error; }
  return (data ?? []).map(fromCleaningEventRow);
}

/**
 * Mark recent cleaning_events for a (property, date, room, staff) tuple as
 * 'discarded' if they were created within the last N seconds. This is the
 * "oops, wrong room — Done then Reset" undo path.
 *
 * Reeyen's spec: when a housekeeper accidentally hits Done and immediately
 * hits Reset, throw out the audit entry. We use a 60-second window — wide
 * enough to absorb a "walk away, realize mistake, walk back, reset" but
 * narrow enough that a 5-minute-later legit reset (e.g., guest came back
 * mid-clean) doesn't retroactively erase real work.
 *
 * Multiple matches are all marked discarded — covers Done/Reset/Done/Reset
 * thrash. Already-decided entries (approved/rejected) are NOT touched —
 * Mario's call is permanent.
 */
export async function discardRecentCleaningEvent(input: {
  propertyId: string;
  date: string;
  roomNumber: string;
  staffId: string | null;
  withinSeconds?: number;
}): Promise<void> {
  const cutoff = new Date(Date.now() - (input.withinSeconds ?? 60) * 1000).toISOString();
  let q = supabase
    .from('cleaning_events')
    .update({
      status: 'discarded' as CleaningEventStatus,
      flag_reason: 'reset_within_window',
    })
    .eq('property_id', input.propertyId)
    .eq('date', input.date)
    .eq('room_number', input.roomNumber)
    .gte('created_at', cutoff)
    .in('status', ['recorded', 'flagged']);
  if (input.staffId) {
    q = q.eq('staff_id', input.staffId);
  } else {
    q = q.is('staff_id', null);
  }
  const { error } = await q;
  if (error) logErr('discardRecentCleaningEvent', error);
}

/**
 * Mario decides yes/no on a flagged entry. Permanent — once decided, the
 * entry can't be re-reviewed. The .eq('status', 'flagged') guard prevents
 * race conditions where two reviewers click at once.
 */
export async function decideOnFlaggedEvent(
  eventId: string,
  decision: 'approved' | 'rejected',
  reviewerId: string,
): Promise<void> {
  const { error } = await supabase
    .from('cleaning_events')
    .update({
      status: decision,
      reviewed_by: reviewerId,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', eventId)
    .eq('status', 'flagged');
  if (error) { logErr('decideOnFlaggedEvent', error); throw error; }
}

/**
 * Subscribe to cleaning_events for the Live tab. Reuses subscribeTable's
 * visibility-recovery + iOS Safari WebSocket-resurrect logic so the
 * leaderboard stays accurate after Mario backgrounds the tab.
 *
 * Today-only: the live view is "what's happened so far today," so we only
 * fetch rows where date = today. The page caller is responsible for
 * keeping `today` reactive across midnight (already done elsewhere via
 * useTodayStr).
 */
export function subscribeToTodayCleaningEvents(
  pid: string,
  date: string,
  callback: (events: CleaningEvent[]) => void,
): () => void {
  return subscribeTable<CleaningEvent>(
    `cleaning_events:${pid}:${date}`,
    'cleaning_events',
    `property_id=eq.${pid}`,
    async () => {
      const { data, error } = await supabase
        .from('cleaning_events')
        .select('*')
        .eq('property_id', pid)
        .eq('date', date)
        .order('completed_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map(fromCleaningEventRow);
    },
    callback,
  );
}
