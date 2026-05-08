// ═══════════════════════════════════════════════════════════════════════════
// Dashboard Numbers — Choice Advantage scraper output (in-house, arrivals,
// departures). Single-row scraper_status / dashboard_by_date table.
//
// dashboardFromJson is local because no other domain reads the same shape.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase, logErr, subscribeTable } from './_common';
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

export function dashboardFreshness(
  d: DashboardNumbers | null,
  nowMs: number = Date.now(),
): DashboardFreshness {
  if (!d) return 'unknown';
  if (d.errorCode) return 'error';
  if (!d.pulledAt) return 'unknown';
  // Off-hours suppression: scraper only pulls dashboard numbers between
  // 5am and 11pm Central. Outside that window the data is naturally
  // stale, but Maria shouldn't see a red "PMS stale" banner at midnight
  // when nothing's broken. Mirror the scraper's gate exactly.
  const localHourCT = parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date(nowMs)),
    10,
  );
  const inScraperWindow = localHourCT >= 5 && localHourCT < 23;
  if (!inScraperWindow) return 'fresh';
  const ageMs = nowMs - d.pulledAt.getTime();
  return ageMs > DASHBOARD_STALE_MINUTES * 60_000 ? 'stale' : 'fresh';
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

export function subscribeToDashboardNumbers(
  callback: (nums: DashboardNumbers | null) => void,
): () => void {
  return subscribeTable<DashboardNumbers>(
    'scraper_status:dashboard', 'scraper_status', `key=eq.dashboard`,
    async () => {
      const { data, error } = await supabase
        .from('scraper_status').select('data').eq('key', 'dashboard').maybeSingle();
      if (error) throw error;
      const parsed = dashboardFromJson((data?.data as Record<string, unknown>) ?? null);
      return parsed ? [parsed] : [];
    },
    (rows) => callback(rows[0] ?? null),
  );
}

export async function getDashboardForDate(
  dateStr: string,
  propertyId: string,
): Promise<DashboardNumbers | null> {
  try {
    const { data, error } = await supabase
      .from('dashboard_by_date')
      .select('*')
      .eq('date', dateStr)
      .eq('property_id', propertyId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const r = data as Record<string, unknown>;
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
  } catch (err) { logErr('getDashboardForDate', err); return null; }
}
