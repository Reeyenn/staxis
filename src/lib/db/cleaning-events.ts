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

import { supabase, logErr, subscribeTable, makeUpsertByIdReducer, asRecordRows } from './_common';

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
//
// Three-tier classification (Reeyen, 2026-05-01):
//   < 3 min      → discarded (accidental tap, never a real clean)
//   3–60 min     → recorded  (counts toward averages)
//   60–90 min    → flagged   (Maria reviews — could be a tough clean)
//   > 90 min     → discarded (forgot to tap Done — auto-remove rather than
//                  bury Maria in pointless review work)
export const CLEANING_DISCARD_UNDER_MIN = 3;
export const CLEANING_FLAG_OVER_MIN = 60;
export const CLEANING_DISCARD_OVER_MIN = 90;

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
  if (durationMinutes > CLEANING_DISCARD_OVER_MIN) return { status: 'discarded', flagReason: 'over_90min' };
  if (durationMinutes > CLEANING_FLAG_OVER_MIN) return { status: 'flagged', flagReason: 'over_60min' };
  return { status: 'recorded', flagReason: null };
}

// Explicit column list, in lock-step with fromCleaningEventRow() below.
// Replaces `.select('*')` per cost-hotpaths audit recommendation #5/#13 —
// cleaning_events has ~25 columns (UI fields + ML features added in 0021)
// and the live tab / performance tab / leaderboard only read the first 16.
// The ML features are populated on insert but never read on the user path;
// only the training scripts (Python ml-service) read them. Update both
// this constant and fromCleaningEventRow when adding a column the UI needs.
const CLEANING_EVENT_COLS =
  'id, property_id, date, room_number, room_type, stayover_day, staff_id, ' +
  'staff_name, started_at, completed_at, duration_minutes, status, ' +
  'flag_reason, reviewed_by, reviewed_at, created_at';

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
    .select(CLEANING_EVENT_COLS)
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
  return asRecordRows(data).map(fromCleaningEventRow);
}

/**
 * Get all entries currently waiting on Mario's flag review. Sorted oldest
 * first so the queue feels like a FIFO inbox.
 */
export async function getFlaggedCleaningEvents(pid: string): Promise<CleaningEvent[]> {
  const { data, error } = await supabase
    .from('cleaning_events')
    .select(CLEANING_EVENT_COLS)
    .eq('property_id', pid)
    .eq('status', 'flagged')
    .order('created_at', { ascending: true });
  if (error) { logErr('getFlaggedCleaningEvents', error); throw error; }
  return asRecordRows(data).map(fromCleaningEventRow);
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
        .select(CLEANING_EVENT_COLS)
        .eq('property_id', pid)
        .eq('date', date)
        .order('completed_at', { ascending: false });
      if (error) throw error;
      return asRecordRows(data).map(fromCleaningEventRow);
    },
    callback,
    // Single-filter realtime only scopes to property_id; filter by date here.
    (payload) => {
      const newDate = (payload.new as { date?: string } | null)?.date;
      const oldDate = (payload.old as { date?: string } | null)?.date;
      return newDate === date || oldDate === date;
    },
    // REPLICA IDENTITY FULL is set on cleaning_events by migration 0133 so
    // payload.new is the complete row on UPDATE. Avoids the N events → N
    // refetch amplification when a manager bulk-resolves flagged events.
    makeUpsertByIdReducer<CleaningEvent>({
      mapRow: fromCleaningEventRow,
      isInSlice: (raw) => (raw as { date?: string }).date === date,
    }),
  );
}
