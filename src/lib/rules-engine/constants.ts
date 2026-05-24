/**
 * Static defaults for the rules engine.
 *
 * These are intentionally hard-coded for the first paying customer
 * (Comfort Suites Beaumont — limited-service Choice franchise). When a
 * boutique or extended-stay property onboards we'll move them to a
 * per-property config table; today they're constants so the engine has
 * one less moving part to debug.
 */

import type { CleaningType } from '@/types/cleaning-tasks';

/** Property-local time the room MUST be empty by, absent late-checkout. */
export const STANDARD_CHECKOUT_TIME = '11:00';

/** Property-local time arriving guests can typically check in. */
export const STANDARD_CHECKIN_TIME = '15:00';

/**
 * Base duration (minutes) per cleaning type, before any rule modifiers.
 * standard = standard room; suite = suite (per pms_rooms_inventory.is_suite).
 * Source: HOUSEKEEPING_FEATURES.md §3 "Cleaning Types & Service Catalog".
 */
export const BASE_DURATION_MIN: Record<CleaningType, { standard: number; suite: number }> = {
  departure:       { standard: 35, suite: 55 },
  departure_deep:  { standard: 50, suite: 75 },
  stayover:        { standard: 18, suite: 30 },
  refresh:         { standard: 15, suite: 20 },
  deep:            { standard: 90, suite: 120 },
  room_check:      { standard: 5,  suite: 5 },
  inspection_only: { standard: 5,  suite: 5 },
  no_clean:        { standard: 0,  suite: 0 },
};

/** Threshold (minutes) below which the gap between checkout and next
 *  arrival counts as a "tight turnaround" — the room must be ready well
 *  before the next guest gets there. 180 min = 3 hours. */
export const TIGHT_TURNAROUND_THRESHOLD_MIN = 180;

/** Buffer (minutes) subtracted from next arrival ETA to compute the
 *  due-by time on a tight turnaround. Front desk wants the room ready
 *  ~15 min before the guest arrives so they're not waiting at the desk. */
export const TIGHT_TURNAROUND_DUE_BUFFER_MIN = 15;

/** Stays this many nights or longer use the weekly deep-clean cadence
 *  (full clean every 7 days). Source: HOUSEKEEPING_FEATURES.md §2. */
export const LONG_STAY_NIGHTS_THRESHOLD = 14;

/** Pet-stay clean adds this many minutes on top of the base. */
export const PET_STAY_DURATION_MIN = 10;
