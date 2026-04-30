// ═══════════════════════════════════════════════════════════════════════════
// Plan Snapshots — one row per (property, date, pull_type) capturing the
// full housekeeping plan output of the Choice Advantage scraper. Powers
// Maria's Schedule tab and the morning planner.
//
// Also exposes the CSV pipeline meta-status (was the last pull successful?
// when?) so the Schedule tab can surface real failures via csvFreshness().
//
// fromPlanSnapshotRow is local to this file because no other domain reads
// the same row shape.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, subscribeTable } from './_common';
import { toDate } from '../db-mappers';

// ─── Scraper window constants (must match scraper/scraper.js exactly) ──────
//
// The scraper pulls hourly during the active window and writes every pull
// to TODAY's plan_snapshots row (keyed by current local date). At midnight
// the next pull lands on the new day's row.
const SCRAPER_TIMEZONE = 'America/Chicago';
const SCRAPER_WINDOW_START_HOUR = 5;   // inclusive
const SCRAPER_WINDOW_END_HOUR = 23;    // exclusive

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

// ─── CSV pull pipeline status ──────────────────────────────────────────────
//
// scraper_status[key='morning'] is written by the Railway scraper each time
// it attempts a CSV pull (csv-scraper.js → scraper.js writeScrapeStatus).
//
// Distinct from PlanSnapshot:
//   • PlanSnapshot is the OUTPUT of a successful pull (rows, totals, etc.)
//     — keyed by (property_id, date), only refreshed when a pull succeeds.
//   • CsvPullStatus is the META about each pull attempt (when it ran,
//     succeeded or errored, error code if any) — refreshed on every attempt.
//
// Why we still need this on top of PlanSnapshot.pulledAt: a pull can FAIL
// (selector miss, login rejected, etc.) and never get to write a snapshot.
// Without reading scraper_status the UI would just see "snapshot is stale"
// and have no way to surface the actual error code, and a sudden CA layout
// change could go unnoticed for hours.
//
// 'evening' is left in the interface for backward compat — the field is
// always null in practice now that the scraper writes a single CSV pull
// type. See scraper.js header comment for the morning/evening history.
export interface CsvPullStatus {
  pullType: 'morning' | 'evening';
  at: Date | null;
  status: 'success' | 'error' | null;
  errorCode: string | null;
  error: string | null;
  /** Bumped on each consecutive 'error' write, reset to 0 on 'success'. */
  consecutiveFailures: number;
}

export interface CsvPipelineStatus {
  morning: CsvPullStatus | null;
  evening: CsvPullStatus | null;
}

function csvPullStatusFromJson(
  pullType: 'morning' | 'evening',
  d: Record<string, unknown> | null,
): CsvPullStatus | null {
  if (!d) return null;
  const status = d.status === 'success' || d.status === 'error' ? d.status : null;
  return {
    pullType,
    at: toDate(d.at),
    status,
    errorCode: typeof d.errorCode === 'string' ? d.errorCode : null,
    error: typeof d.error === 'string' ? d.error : null,
    consecutiveFailures: typeof d.consecutiveFailures === 'number' ? d.consecutiveFailures : 0,
  };
}

/**
 * Subscribe to scraper_status[morning] + [evening] as a single object.
 *
 * Realtime supports a single-column filter only. We can't filter `key IN
 * ('morning', 'evening')` at the Postgres level, so we subscribe to the
 * whole table and gate re-fetches via shouldRefetch — that way changes to
 * scraper_status[dashboard] / [heartbeat] / [alertState] don't trigger
 * unnecessary re-loads here.
 */
export function subscribeToCsvPipelineStatus(
  callback: (status: CsvPipelineStatus) => void,
): () => void {
  return subscribeTable<{ key: 'morning' | 'evening'; data: Record<string, unknown> | null }>(
    'scraper_status:csv-pipeline',
    'scraper_status',
    null,
    async () => {
      const { data, error } = await supabase
        .from('scraper_status')
        .select('key, data')
        .in('key', ['morning', 'evening']);
      if (error) throw error;
      return (data ?? [])
        .filter(r => r.key === 'morning' || r.key === 'evening')
        .map(r => ({
          key: r.key as 'morning' | 'evening',
          data: r.data as Record<string, unknown> | null,
        }));
    },
    (rows) => {
      const status: CsvPipelineStatus = { morning: null, evening: null };
      for (const r of rows) {
        const parsed = csvPullStatusFromJson(r.key, r.data);
        if (parsed) status[r.key] = parsed;
      }
      callback(status);
    },
    (payload) => {
      const newKey = (payload.new as Record<string, unknown> | null)?.key;
      const oldKey = (payload.old as Record<string, unknown> | null)?.key;
      return newKey === 'morning' || newKey === 'evening'
        || oldKey === 'morning' || oldKey === 'evening';
    },
  );
}

// ─── Freshness logic ───────────────────────────────────────────────────────
//
// Combines today's plan_snapshot age with the CSV pipeline's live status to
// answer the only question the UI cares about: "is the CSV pull pipeline OK?"
//
// State priority (highest to lowest):
//   1. error      — pipeline is actively failing (consecutiveFailures ≥ 2).
//   2. error      — today's snapshot is >180 min stale during scraper window
//                   AND no pipeline error reported (catches the case where
//                   the scraper crashed before it could write a status row).
//   3. stale      — today's snapshot is 75–180 min stale during scraper
//                   window.
//   4. fresh      — everything else, including overnight off-hours when the
//                   scraper is correctly idle.
//
// Single-window logic: every CSV pull writes to TODAY's row, so today's
// pulledAt should be ≤ ~60 min old anywhere in 5am–11pm CT. (Old code split
// 5–7pm vs 7–11pm because evening pulls used to write to tomorrow's row.
// That split was removed 2026-04-30 — see scraper.js header.)
export type CsvFreshness = 'fresh' | 'stale' | 'error';

export interface CsvFreshnessResult {
  state: CsvFreshness;
  reason:
    | 'pipeline_error'      // scraper_status reports active failure
    | 'snapshot_stale'      // scraper window, today's pulledAt too old, no pipeline error
    | 'fresh'               // scraper window, recent pull
    | 'off_hours'           // 11pm–5am: scraper isn't running
    | 'no_snapshot';        // scraper window, but no plan_snapshot exists yet
  /** Most relevant timestamp for the UI to display. */
  referenceAt: Date | null;
  minutesAgo: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export const CSV_STALE_MINUTES = 75;
export const CSV_ERROR_MINUTES = 180;
const CSV_PIPELINE_FAILURE_THRESHOLD = 2;

export function csvFreshness(
  snapshot: PlanSnapshot | null,
  pipeline: CsvPipelineStatus,
  nowMs: number = Date.now(),
): CsvFreshnessResult {
  // ── 1. Active pipeline failure overrides everything ──────────────────────
  // If morning OR evening has hit the consecutive-failure threshold, that's a
  // real outage we should surface no matter what the snapshot age looks like.
  // The threshold matches scraper-health/route.ts (CSV_FAILURE_THRESHOLD = 2).
  // We still check both keys: 'evening' is an orphan today but a future
  // refactor that brings it back shouldn't regress this alert path.
  const failingSide =
    pipeline.morning && pipeline.morning.status === 'error'
      && pipeline.morning.consecutiveFailures >= CSV_PIPELINE_FAILURE_THRESHOLD
      ? pipeline.morning
      : pipeline.evening && pipeline.evening.status === 'error'
        && pipeline.evening.consecutiveFailures >= CSV_PIPELINE_FAILURE_THRESHOLD
      ? pipeline.evening
      : null;
  if (failingSide) {
    const refAt = failingSide.at ?? snapshot?.pulledAt ?? null;
    return {
      state: 'error',
      reason: 'pipeline_error',
      referenceAt: refAt,
      minutesAgo: refAt ? Math.max(0, Math.round((nowMs - refAt.getTime()) / 60_000)) : null,
      errorCode: failingSide.errorCode,
      errorMessage: failingSide.error,
    };
  }

  // ── 2. Pipeline is healthy. Check time-of-day window. ────────────────────
  const localHourCT = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: SCRAPER_TIMEZONE }).format(new Date(nowMs)),
    10,
  );
  const inScraperWindow = localHourCT >= SCRAPER_WINDOW_START_HOUR && localHourCT < SCRAPER_WINDOW_END_HOUR;

  if (!snapshot?.pulledAt) {
    // No plan_snapshot for today yet. Inside the scraper window we consider
    // this stale (worth surfacing — first morning pull hasn't landed). Off
    // hours it's normal (we don't expect data overnight).
    return {
      state: inScraperWindow ? 'stale' : 'fresh',
      reason: 'no_snapshot',
      referenceAt: null,
      minutesAgo: null,
      errorCode: null,
      errorMessage: null,
    };
  }

  const minutesAgo = Math.max(0, Math.round((nowMs - snapshot.pulledAt.getTime()) / 60_000));

  if (!inScraperWindow) {
    // 11pm–5am: scraper is correctly idle. Today's snapshot is naturally
    // aging out and we don't yell about it.
    return {
      state: 'fresh',
      reason: 'off_hours',
      referenceAt: snapshot.pulledAt,
      minutesAgo,
      errorCode: null,
      errorMessage: null,
    };
  }

  // ── 3. Scraper window with healthy pipeline — apply staleness. ───────────
  if (minutesAgo > CSV_ERROR_MINUTES) {
    return { state: 'error', reason: 'snapshot_stale', referenceAt: snapshot.pulledAt, minutesAgo, errorCode: null, errorMessage: null };
  }
  if (minutesAgo > CSV_STALE_MINUTES) {
    return { state: 'stale', reason: 'snapshot_stale', referenceAt: snapshot.pulledAt, minutesAgo, errorCode: null, errorMessage: null };
  }
  return { state: 'fresh', reason: 'fresh', referenceAt: snapshot.pulledAt, minutesAgo, errorCode: null, errorMessage: null };
}
