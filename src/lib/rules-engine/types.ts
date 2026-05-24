/**
 * Internal types for the rules engine.
 *
 * Boundary:
 *   - context.ts produces a RoomContext per (property_id, room_number)
 *     from the live pms_* tables.
 *   - rules/*.ts receive that RoomContext and return a RuleFireResult
 *     or null. Pure functions, no DB. Easily unit-testable.
 *   - merger.ts collapses RuleFireResults into a TaskSpec, then into a
 *     row ready to upsert into cleaning_tasks.
 */

import type {
  CleaningType,
  Priority,
  TaskExtra,
  TaskStatus,
} from '@/types/cleaning-tasks';

/** The PMS room-status enum, re-exported here so rules can pattern-match
 *  without importing the migration. Mirrors pms_room_status_log.status. */
export type PmsRoomStatus =
  | 'vacant_clean'
  | 'vacant_dirty'
  | 'occupied'
  | 'occupied_clean'
  | 'occupied_dirty'
  | 'out_of_order'
  | 'out_of_inventory'
  | 'inspected'
  | 'unknown';

/** The reservation rows the engine cares about per room per business_date. */
export interface DepartingReservation {
  pms_reservation_id: string;
  departure_time: string | null;           // HH:MM:SS, property-local
  late_checkout_approved: boolean;
  late_checkout_until: string | null;      // HH:MM:SS, property-local
  actual_checkout_at: string | null;       // ISO UTC, when room went vacant_dirty after departure
  num_nights: number | null;
  is_vip: boolean;
  has_pet: boolean;
  package_name: string | null;
  rate_code: string | null;
  special_requests: string | null;
}

export interface ArrivingReservation {
  pms_reservation_id: string;
  arrival_time: string | null;             // HH:MM:SS, property-local
  early_checkin_approved: boolean;
  early_checkin_from: string | null;       // HH:MM:SS, property-local
  is_vip: boolean;
  loyalty_tier: string | null;
  language: string | null;                 // from preferences/dietary_needs/special_requests
  has_pet: boolean;
  adults: number | null;
  children: number | null;
  infants: number | null;
  package_name: string | null;
  rate_code: string | null;
  special_requests: string | null;
  has_baby_cot: boolean;
  has_extra_bed: boolean;
  has_early_checkin_request: boolean;
  has_honeymoon: boolean;
  has_anniversary: boolean;
}

export interface StayingReservation {
  pms_reservation_id: string;
  arrival_date: string;                    // YYYY-MM-DD
  departure_date: string;                  // YYYY-MM-DD
  num_nights: number | null;
  day_of_stay: number;                     // 1-indexed (day 1 = arrival night)
  is_vip: boolean;
  loyalty_tier: string | null;
  language: string | null;
  has_pet: boolean;
  eco_stay_opt_in: boolean;
  dnd_active: boolean;
  nsr_active: boolean;
  package_name: string | null;
  rate_code: string | null;
  special_requests: string | null;
}

/** Per-property facts the engine carries across all rooms. */
export interface PropertyContext {
  property_id: string;
  property_timezone: string;
  business_date: string;                   // YYYY-MM-DD in property-local time
  now_utc: Date;
  day_of_week: 0 | 1 | 2 | 3 | 4 | 5 | 6;  // 0 = Sunday, 6 = Saturday (in property-local time)
  /** Property-local cutoff times. HH:MM. */
  standard_checkout_time: string;
  standard_checkin_time: string;
}

/** Everything a rule needs to decide whether it fires for one room. */
export interface RoomContext {
  property: PropertyContext;

  room_number: string;
  room_type: string | null;
  is_suite: boolean;
  pet_friendly: boolean;

  /** Most recent row in pms_room_status_log for this (property, room). */
  current_status: PmsRoomStatus;
  status_changed_at: string | null;        // ISO UTC

  departing: DepartingReservation | null;
  arriving: ArrivingReservation | null;
  staying: StayingReservation | null;

  /** The PMS's own opinion of today's HK plan for this room, if any. */
  pms_hk_assignment: {
    cleaning_type: string | null;
    status: string;
    dnd_active: boolean;
    late_checkout_approved: boolean;
    late_checkout_until: string | null;
    early_checkin_approved: boolean;
    early_checkin_from: string | null;
  } | null;
}

/** What a single rule emits when it fires. The merger applies these in
 *  order; base-cleaning-type rules set `cleaning_type`, modifier rules
 *  leave it undefined and contribute to extras / minutes / etc. */
export interface PartialTaskSpec {
  cleaning_type?: CleaningType;
  priority?: Priority;
  /** Set on tight-turnaround rules. Engine takes the EARLIEST due_by. */
  due_by?: Date | null;
  /** Base estimate from the cleaning-type-setting rule. */
  estimated_minutes_base?: number;
  /** Additive deltas from modifier rules (e.g. +10 for pet). */
  estimated_minutes_delta?: number;
  requires_inspection?: boolean;
  extras?: TaskExtra[];
  notes?: string[];
  status?: TaskStatus;
}

export interface RuleFireResult {
  id: string;
  summary: string;
  partial: PartialTaskSpec;
}

export interface Rule {
  id: string;
  /** Human-readable description, surfaced in module README. */
  description: string;
  evaluate(ctx: RoomContext): RuleFireResult | null;
}
