/**
 * PMS adapter contract.
 *
 * Every concrete PMS implementation (Choice Advantage, Opera Cloud,
 * Cloudbeds, the CUA-driven generic adapter) implements this interface.
 * The rest of the app — the Railway scraper loop, the Fly.io CUA worker,
 * Next.js API routes — only ever sees `PMSAdapter`. They never know which
 * PMS is underneath.
 *
 * Adapters never throw across this boundary. Every method returns an
 * AdapterResult<T> envelope. See ./types.ts for AdapterError / adapterError().
 */

import type {
  AdapterResult,
  DashboardCounts,
  HistoricalOccupancyDay,
  PMSArrival,
  PMSCredentials,
  PMSDeparture,
  PMSRoomDescriptor,
  PMSRoomStatus,
  PMSStaffMember,
  PMSType,
} from './types';

export interface PMSAdapter {
  /** Which PMS family this instance speaks to. */
  readonly pmsType: PMSType;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Quick credential + reachability check. Used by the "Test Connection"
   * button on /settings/pms before we save credentials. Should be fast
   * (<10s) and self-contained — no side effects to scraper_credentials
   * or pms_recipes. Just: log in, get past the post-login screen, log out.
   */
  testConnection(): Promise<AdapterResult<{ message: string; detectedPmsName?: string }>>;

  // ─── Bootstrap data ─────────────────────────────────────────────────────
  // Run once at onboarding. The CUA worker calls these to populate the
  // property's rooms, staff, and historical occupancy on day one.

  getRoomLayout(): Promise<AdapterResult<PMSRoomDescriptor[]>>;
  getStaffRoster(): Promise<AdapterResult<PMSStaffMember[]>>;
  /** Pulls last `days` days of occupancy. Caller determines look-back window. */
  getHistoricalOccupancy(days: number): Promise<AdapterResult<HistoricalOccupancyDay[]>>;

  // ─── Steady-state data ─────────────────────────────────────────────────
  // Run on the operating schedule (every 15 min during 5am-11pm by default;
  // scraper_window_start_hour / scraper_window_end_hour per property).

  /** Arrivals scheduled for `date` (default: today, property TZ). */
  getArrivals(date?: string): Promise<AdapterResult<PMSArrival[]>>;
  /** Departures scheduled for `date` (default: today, property TZ). */
  getDepartures(date?: string): Promise<AdapterResult<PMSDeparture[]>>;
  /** Live room status snapshot. */
  getRoomStatus(): Promise<AdapterResult<PMSRoomStatus[]>>;
  /** Aggregated counts for the dashboard widgets. Cheap when supported. */
  getDashboardCounts(): Promise<AdapterResult<DashboardCounts>>;

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /** Close any browser/session resources. Always safe to call. */
  close(): Promise<void>;
}

/**
 * Per-property runtime context the registry hands to each adapter when
 * constructing it. Adapters store these privately; no other module
 * touches credentials directly.
 */
export interface AdapterContext {
  propertyId: string;
  credentials: PMSCredentials;
  /** Property's local timezone, e.g. 'America/Chicago'. */
  timezone: string;
}
