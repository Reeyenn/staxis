// ═══════════════════════════════════════════════════════════════════════════
// Plan Snapshots — one row per (property, date, pull_type) capturing the
// full housekeeping plan output of the Choice Advantage scraper. Powers
// Maria's Schedule tab and the morning planner.
//
// Also exposes the CSV pipeline meta-status (was the last morning/evening
// pull successful? when?) — Schedule tab needs this to distinguish "today's
// pulledAt is old because it's 9pm and the scraper has correctly switched
// to evening (tomorrow) pulls" from "the CSV pipeline has actually broken."
// Without it, every night 9–11pm produced a false-alarm "CSV pull failing"
// banner. See csvFreshness() below.
//
// fromPlanSnapshotRow is local to this file because no other domain reads
// the same row shape.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, subscribeTable } from './_common';
import { toDate } from '../db-mappers';

// ─── Scraper window constants (must match scraper/scraper.js exactly) ───────
//
// scraper.js uses these gates:
//   • Active scraper window:   `hour < 5 || hour >= 23`        (5am–11pm CT)
//   • Morning vs evening cut:  `pullType = hour < 19 ? 'morning' : 'evening'`
//
// The CRITICAL invariant: morning pulls write to TODAY's plan_snapshots row,
// evening pulls write to TOMORROW's. So today's row only gets refreshed
// during 5am–7pm — after 7pm it correctly freezes for the day.
const SCRAPER_TIMEZONE = 'America/Chicago';
const SCRAPER_WINDOW_START_HOUR = 5;   // inclusive
const SCRAPER_WINDOW_END_HOUR = 23;    // exclusive
const MORNING_PULL_END_HOUR = 19;      // exclusive — this is the 7pm cutoff in scraper.js

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
// scraper_status[key='morning' | 'evening'] is written by the Railway scraper
// each time it attempts a CSV pull (csv-scraper.js → scraper.js writeScrapeStatus).
//
// Distinct from PlanSnapshot:
//   • PlanSnapshot is the OUTPUT of a successful pull (rows, totals, etc.)
//     — keyed by (property_id, date), only refreshed when a pull succeeds.
//   • CsvPullStatus is the META about each pull attempt (when it ran,
//     succeeded or errored, error code if any) — keyed by 'morning' or
//     'evening', refreshed on every attempt.
//
// Why this matters for the UI: today's PlanSnapshot only gets refreshed
// during the morning-pull window (5am–7pm CT). After 7pm the scraper
// switches to evening pulls that write to TOMORROW's row — today's
// pulledAt freezes intentionally. If the freshness check uses today's
// pulledAt naively it shows a false-alarm "CSV pull failing" banner every
// night 9–11pm. The proper signal for "is the pipeline alive" is the most
// recent of morning/evening status rows.
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
//   1. error      — pipeline is actively failing (consecutiveFailures ≥ 2 on
//                   either morning or evening side).
//   2. error      — today's snapshot is >180 min stale during morning-pull
//                   window AND no pipeline error reported (catches the case
//                   where the scraper crashed before writing status).
//   3. stale      — today's snapshot is 75–180 min stale during morning-pull
//                   window.
//   4. fresh      — everything else, including the intentionally-frozen
//                   evening window (7–11pm) and overnight off-hours.
//
// Why morning-pull window (5–19) instead of full scraper window (5–23):
// evening pulls write to TOMORROW's row, not today's. Applying freshness
// against today's pulledAt during 19–23 produces a daily false alarm.
export type CsvFreshness = 'fresh' | 'stale' | 'error';

export interface CsvFreshnessResult {
  state: CsvFreshness;
  reason:
    | 'pipeline_error'      // scraper_status reports active failure
    | 'snapshot_stale'      // morning-pull window, today's pulledAt too old, no pipeline error
    | 'fresh'               // morning-pull window, recent pull
    | 'frozen_evening'      // 7–11pm: today's snapshot is intentionally frozen
    | 'off_hours'           // 11pm–5am: scraper isn't running
    | 'no_snapshot';        // morning window, but no plan_snapshot exists yet
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

  // ── 2. Pipeline is healthy. Check time-of-day windows. ───────────────────
  const localHourCT = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: SCRAPER_TIMEZONE }).format(new Date(nowMs)),
    10,
  );
  const inMorningPullWindow = localHourCT >= SCRAPER_WINDOW_START_HOUR && localHourCT < MORNING_PULL_END_HOUR;
  const isOffHours = localHourCT < SCRAPER_WINDOW_START_HOUR || localHourCT >= SCRAPER_WINDOW_END_HOUR;

  if (!snapshot?.pulledAt) {
    return {
      state: inMorningPullWindow ? 'stale' : 'fresh',
      reason: 'no_snapshot',
      referenceAt: null,
      minutesAgo: null,
      errorCode: null,
      errorMessage: null,
    };
  }

  const minutesAgo = Math.max(0, Math.round((nowMs - snapshot.pulledAt.getTime()) / 60_000));

  if (!inMorningPullWindow) {
    // 7–11pm: today's snapshot is intentionally frozen because the scraper
    // is now writing to tomorrow's row. 11pm–5am: off-hours. Either way,
    // "stale" is expected and not alarming.
    return {
      state: 'fresh',
      reason: isOffHours ? 'off_hours' : 'frozen_evening',
      referenceAt: snapshot.pulledAt,
      minutesAgo,
      errorCode: null,
      errorMessage: null,
    };
  }

  // ── 3. Morning-pull window with healthy pipeline — apply staleness. ──────
  if (minutesAgo > CSV_ERROR_MINUTES) {
    return { state: 'error', reason: 'snapshot_stale', referenceAt: snapshot.pulledAt, minutesAgo, errorCode: null, errorMessage: null };
  }
  if (minutesAgo > CSV_STALE_MINUTES) {
    return { state: 'stale', reason: 'snapshot_stale', referenceAt: snapshot.pulledAt, minutesAgo, errorCode: null, errorMessage: null };
  }
  return { state: 'fresh', reason: 'fresh', referenceAt: snapshot.pulledAt, minutesAgo, errorCode: null, errorMessage: null };
}
