/**
 * PMS abstraction — shared types.
 *
 * Every concrete PMSAdapter (Choice Advantage, Opera Cloud, Cloudbeds, …)
 * speaks this same vocabulary back to the rest of the app. The Railway
 * scraper, the Fly.io CUA worker, and the Next.js API routes all import
 * from here so there's exactly one definition of "what does an arrival
 * look like" no matter which PMS produced it.
 *
 * This file is intentionally type-only. No runtime logic lives here —
 * adapters live in src/lib/pms/adapters/, the registry is in registry.ts,
 * and the recipe runner is in recipe.ts.
 *
 * Keep PMS_TYPES in sync with:
 *   - the dropdown in src/app/settings/pms/page.tsx
 *   - the check constraint on scraper_credentials.pms_type (migration 0031)
 */

// ─── PMS family identifiers ──────────────────────────────────────────────
// These strings are persisted in the DB. Treat them as a stable contract —
// renaming a value requires a migration that backfills old rows.

export const PMS_TYPES = [
  'choice_advantage',
  'opera_cloud',
  'cloudbeds',
  'roomkey',
  'skytouch',
  'webrezpro',
  'hotelogix',
  'other',
] as const;

export type PMSType = typeof PMS_TYPES[number];

export function isPMSType(v: unknown): v is PMSType {
  return typeof v === 'string' && (PMS_TYPES as readonly string[]).includes(v);
}

// ─── Credentials ─────────────────────────────────────────────────────────

/**
 * What every adapter needs to log in. Stored in scraper_credentials per
 * property. ca_login_url + ca_username + ca_password were named for Choice
 * Advantage (the original property); the column names live on for
 * compatibility but the adapter contract uses generic names.
 */
export interface PMSCredentials {
  loginUrl: string;
  username: string;
  password: string;
}

// ─── Domain types — what each adapter returns ────────────────────────────

export interface PMSArrival {
  guestName: string;
  roomNumber: string;
  /** ISO date — YYYY-MM-DD in the property's local timezone. */
  arrivalDate: string;
  /** ISO date — YYYY-MM-DD. */
  departureDate: string;
  /** Length of stay in nights. */
  numNights: number;
  numAdults?: number;
  numChildren?: number;
  rateCode?: string;
  confirmationNumber?: string;
  /** Free-form notes from the PMS (special requests, VIP flags, etc.). */
  notes?: string;
}

export interface PMSDeparture {
  guestName: string;
  roomNumber: string;
  arrivalDate: string;
  departureDate: string;
  confirmationNumber?: string;
  /** True if the guest has already been checked out in the PMS. Tells
   *  housekeeping the room is available to clean now vs. later. */
  checkedOut?: boolean;
}

export type RoomCondition =
  | 'occupied'        // guest is in the room
  | 'vacant_clean'    // guest left, housekeeping done, ready to sell
  | 'vacant_dirty'    // guest left, housekeeping needed
  | 'inspected'       // post-housekeeping inspection passed
  | 'out_of_order'    // OOO — not bookable, maintenance in progress
  | 'unknown';        // PMS reports something the recipe couldn't classify

export interface PMSRoomStatus {
  roomNumber: string;
  status: RoomCondition;
  guestName?: string;
  arrivalDate?: string;
  departureDate?: string;
  /** 'stayover' if the guest is staying another night, 'checkout' if leaving today. */
  staySegment?: 'stayover' | 'checkout' | 'arrival' | null;
}

export interface PMSStaffMember {
  name: string;
  /** PMS-internal role string. We map to our own roles in the loader. */
  role?: string;
  phone?: string;
  email?: string;
  /** Some PMSes track an internal employee id; we keep it for matching. */
  externalId?: string;
}

export interface PMSRoomDescriptor {
  roomNumber: string;
  /** Floor number or building section as shown in the PMS. */
  floor?: string;
  /** Room type code from the PMS (e.g. "KSTE" for King Suite). */
  type?: string;
  /** Bed configuration if surfaced ("1 King", "2 Queen"). */
  beds?: string;
}

export interface DashboardCounts {
  /** Rooms currently occupied. */
  occupied: number;
  /** Arrivals scheduled today (any status). */
  arrivalsToday: number;
  /** Departures scheduled today (any status). */
  departuresToday: number;
  /** Total sellable rooms in the property. */
  totalRooms: number;
  /** Rooms currently flagged out-of-order. */
  oooRooms: number;
  /** When this snapshot was read from the PMS. */
  pulledAt: string; // ISO timestamp
}

export interface HistoricalOccupancyDay {
  /** ISO date — YYYY-MM-DD. */
  date: string;
  occupied: number;
  totalRooms: number;
}

// ─── Adapter result envelope ─────────────────────────────────────────────

/**
 * Every adapter method returns one of these. Successful results carry the
 * payload; failures carry a code + human message. We never throw across
 * the adapter boundary — exceptions inside an adapter are caught and
 * converted to AdapterError so callers (the scraper loop, the CUA worker,
 * API routes) never need try/catch around adapter calls.
 *
 * This mirrors the scraper-errors.js pattern from the Railway scraper.
 */
export type AdapterResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AdapterError };

export type AdapterErrorCode =
  | 'auth_failed'           // login rejected (bad credentials)
  | 'session_expired'       // we had a session, PMS booted us out
  | 'rate_limited'          // PMS asked us to slow down
  | 'page_changed'          // recipe selectors no longer match — needs re-mapping
  | 'network'               // connection / timeout / DNS
  | 'parse_failed'          // page loaded but we couldn't extract structured data
  | 'unsupported'           // adapter doesn't implement this method
  | 'unknown';

export interface AdapterError {
  code: AdapterErrorCode;
  message: string;
  /** Optional structured detail for debugging — never shown to end users. */
  detail?: Record<string, unknown>;
  /** Indicates whether the caller should retry (transient) or not (terminal). */
  retryable: boolean;
}

export function adapterError(
  code: AdapterErrorCode,
  message: string,
  opts: { detail?: Record<string, unknown>; retryable?: boolean } = {},
): AdapterError {
  return {
    code,
    message,
    detail: opts.detail,
    retryable: opts.retryable ?? (code === 'network' || code === 'rate_limited'),
  };
}
