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

async function getDashboardForDate(
  dateStr: string,
  propertyId: string,
): Promise<DashboardNumbers | null> {
  try {
    // Plan v4 bridge — read today_property_counts_v1 + latest
    // pms_in_house_snapshot.captured_at so callers see the same shape
    // they always saw.
    const [counts, { data: ihs, error: ihsError }] = await Promise.all([
      fetchTodayPropertyCounts(propertyId, dateStr, { throwOnError: true }),
      supabase
        .from('pms_in_house_snapshot')
        .select('arrivals_remaining_today, departures_remaining_today, captured_at, has_error, last_error')
        .eq('property_id', propertyId)
        .maybeSingle(),
    ]);
    if (ihsError) throw ihsError;
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
  let refreshSequence = 0;
  const refresh = async () => {
    const requestSequence = ++refreshSequence;
    const nums = await getDashboardForDate(date, pid);
    // Realtime/foreground catch-up can start while the initial read is still
    // in flight. Latest-started wins so a slow pre-event snapshot can never
    // overwrite the newer result after it publishes.
    if (active && requestSequence === refreshSequence) callback(nums);
  };
  void refresh();
  const unsub = subscribeTodayRoomWork(pid, () => { void refresh(); });
  return () => {
    active = false;
    refreshSequence += 1;
    unsub();
  };
}
