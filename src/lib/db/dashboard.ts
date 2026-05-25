// ═══════════════════════════════════════════════════════════════════════════
// Dashboard Numbers — Plan v4 bridge.
//
// Same `DashboardNumbers` shape the Schedule tab + System tab consume,
// but the source is now the new pms_in_house_snapshot table (written by
// the vision CUA every 30 sec). The original scraper_status /
// dashboard_by_date tables are dropped.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, logErr } from './_common';
import { fetchTodayPropertyCounts, subscribeTodayRoomWork } from './today-room-work';
import { toDate } from '../db-mappers';

export type DashboardErrorCode =
  | 'login_failed'
  | 'session_expired'
  | 'selector_miss'
  | 'timeout'
  | 'parse_error'
  | 'validation_failed'
  | 'ca_unreachable'
  | 'unknown';

export interface DashboardNumbers {
  inHouse:    number | null;
  arrivals:   number | null;
  departures: number | null;
  inHouseGuests?:    number | null;
  arrivalsGuests?:   number | null;
  departuresGuests?: number | null;
  pulledAt: Date | null;
  errorCode:    DashboardErrorCode | null;
  errorMessage: string | null;
  errorPage:    string | null;
  erroredAt:    Date | null;
  error: string | null;
}

export const DASHBOARD_STALE_MINUTES = 25;

export type DashboardFreshness = 'fresh' | 'stale' | 'error' | 'unknown';

/**
 * Per-property scraper window options. Defaults match Comfort Suites
 * (Central Time, 5am–11pm). Callers with a property in scope should
 * fetch these from `properties` (via `getPropertyOpsConfig(pid)`) so a
 * Florida hotel's "fresh"/"stale" decision uses Eastern hours.
 */
export interface DashboardFreshnessOptions {
  nowMs?: number;
  timezone?: string;
  windowStartHour?: number;
  windowEndHour?: number;
  staleMinutes?: number;
}

export function dashboardFreshness(
  d: DashboardNumbers | null,
  optsOrNowMs: number | DashboardFreshnessOptions = Date.now(),
): DashboardFreshness {
  // Back-compat: old signature was (d, nowMs). New signature is (d, options).
  const opts: DashboardFreshnessOptions =
    typeof optsOrNowMs === 'number' ? { nowMs: optsOrNowMs } : optsOrNowMs;
  const nowMs = opts.nowMs ?? Date.now();
  const timezone = opts.timezone ?? 'America/Chicago';
  const startHour = opts.windowStartHour ?? 5;
  const endHour = opts.windowEndHour ?? 23;
  const staleMinutes = opts.staleMinutes ?? DASHBOARD_STALE_MINUTES;

  if (!d) return 'unknown';
  if (d.errorCode) return 'error';
  if (!d.pulledAt) return 'unknown';
  // Off-hours suppression: scraper only pulls dashboard numbers between
  // `windowStartHour` and `windowEndHour` in the property's local timezone.
  // Outside that window the data is naturally stale, but Maria shouldn't
  // see a red "PMS stale" banner at midnight when nothing's broken.
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(new Date(nowMs)),
    10,
  );
  const inScraperWindow = localHour >= startHour && localHour < endHour;
  if (!inScraperWindow) return 'fresh';
  const ageMs = nowMs - d.pulledAt.getTime();
  return ageMs > staleMinutes * 60_000 ? 'stale' : 'fresh';
}

function dashboardFromJson(d: Record<string, unknown> | null): DashboardNumbers | null {
  if (!d) return null;
  return {
    inHouse:    typeof d.inHouse    === 'number' ? d.inHouse    : null,
    arrivals:   typeof d.arrivals   === 'number' ? d.arrivals   : null,
    departures: typeof d.departures === 'number' ? d.departures : null,
    inHouseGuests:    typeof d.inHouseGuests    === 'number' ? d.inHouseGuests    : null,
    arrivalsGuests:   typeof d.arrivalsGuests   === 'number' ? d.arrivalsGuests   : null,
    departuresGuests: typeof d.departuresGuests === 'number' ? d.departuresGuests : null,
    pulledAt:     toDate(d.pulledAt),
    errorCode:    typeof d.errorCode    === 'string' ? d.errorCode as DashboardErrorCode : null,
    errorMessage: typeof d.errorMessage === 'string' ? d.errorMessage : null,
    errorPage:    typeof d.errorPage    === 'string' ? d.errorPage    : null,
    erroredAt:    toDate(d.erroredAt),
    error:        typeof d.error === 'string' ? d.error : null,
  };
}

/**
 * Single-tenant legacy callers (no property scope). Plan v4: deprecated —
 * always fires null. Use subscribeToDashboardByDate instead.
 */
export function subscribeToDashboardNumbers(
  callback: (nums: DashboardNumbers | null) => void,
): () => void {
  callback(null);
  return () => {};
}

function dashboardFromRow(r: Record<string, unknown>): DashboardNumbers {
  return {
    inHouse:    typeof r.in_house    === 'number' ? r.in_house    : null,
    arrivals:   typeof r.arrivals    === 'number' ? r.arrivals    : null,
    departures: typeof r.departures  === 'number' ? r.departures  : null,
    inHouseGuests:    typeof r.in_house_guests    === 'number' ? r.in_house_guests    : null,
    arrivalsGuests:   typeof r.arrivals_guests    === 'number' ? r.arrivals_guests    : null,
    departuresGuests: typeof r.departures_guests  === 'number' ? r.departures_guests  : null,
    pulledAt:     toDate(r.pulled_at),
    errorCode:    typeof r.error_code    === 'string' ? r.error_code as DashboardErrorCode : null,
    errorMessage: typeof r.error_message === 'string' ? r.error_message : null,
    errorPage:    typeof r.error_page    === 'string' ? r.error_page    : null,
    erroredAt:    toDate(r.errored_at),
    error:        null,
  };
}

export async function getDashboardForDate(
  dateStr: string,
  propertyId: string,
): Promise<DashboardNumbers | null> {
  try {
    // Plan v4 bridge — read today_property_counts_v1 + latest
    // pms_in_house_snapshot.captured_at so callers see the same shape
    // they always saw.
    const counts = await fetchTodayPropertyCounts(propertyId, dateStr);
    const { data: ihs } = await supabase
      .from('pms_in_house_snapshot')
      .select('arrivals_remaining_today, departures_remaining_today, captured_at, has_error, last_error')
      .eq('property_id', propertyId)
      .maybeSingle();
    return {
      inHouse:    counts.in_house,
      arrivals:   typeof ihs?.arrivals_remaining_today === 'number' ? ihs.arrivals_remaining_today : null,
      departures: typeof ihs?.departures_remaining_today === 'number' ? ihs.departures_remaining_today : null,
      inHouseGuests:    null,
      arrivalsGuests:   null,
      departuresGuests: null,
      pulledAt:     toDate(ihs?.captured_at),
      errorCode:    ihs?.has_error ? 'unknown' : null,
      errorMessage: typeof ihs?.last_error === 'string' ? ihs.last_error : null,
      errorPage:    null,
      erroredAt:    null,
      error:        typeof ihs?.last_error === 'string' ? ihs.last_error : null,
    };
  } catch (err) { logErr('getDashboardForDate', err); return null; }
}

// Per-property "in-house / arrivals / departures" live counts.
//
// Plan v4 bridge: was a postgres_changes subscription on
// dashboard_by_date — that table is dropped. Now reads
// pms_in_house_snapshot (point-in-time CUA writes) + today_property_counts
// RPC, and refreshes any time the CUA writes a new row to pms_*.
export function subscribeToDashboardByDate(
  pid: string, date: string,
  callback: (nums: DashboardNumbers | null) => void,
): () => void {
  let active = true;
  const refresh = async () => {
    const nums = await getDashboardForDate(date, pid);
    if (active) callback(nums);
  };
  void refresh();
  const unsub = subscribeTodayRoomWork(pid, () => { void refresh(); });
  return () => { active = false; unsub(); };
}
