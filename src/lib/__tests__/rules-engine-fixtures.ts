/**
 * Test fixtures for the rules engine.
 *
 * NOT a *.test.ts file — the test runner glob ignores us. Importable
 * by rules-engine-*.test.ts so each test starts from a sane baseline
 * and only mutates the fields it cares about.
 *
 * Convention:
 *   - blankPropertyContext({...}) returns a PropertyContext with the
 *     overrides spread in.
 *   - blankRoomContext({...}) returns a RoomContext with NO reservation
 *     activity. Each test adds the departing/arriving/staying it needs.
 */

import { STANDARD_CHECKIN_TIME, STANDARD_CHECKOUT_TIME } from '@/lib/rules-engine/constants';
import type {
  ArrivingReservation,
  DepartingReservation,
  PropertyContext,
  RoomContext,
  StayingReservation,
} from '@/lib/rules-engine/types';

const FAKE_PROPERTY_ID = '00000000-0000-0000-0000-000000000305';

export function blankPropertyContext(over: Partial<PropertyContext> = {}): PropertyContext {
  const now = over.now_utc ?? new Date('2026-05-26T16:00:00Z'); // 11:00 CDT, Tuesday
  return {
    property_id: FAKE_PROPERTY_ID,
    property_timezone: 'America/Chicago',
    business_date: '2026-05-26',
    now_utc: now,
    day_of_week: 2, // Tuesday
    standard_checkout_time: STANDARD_CHECKOUT_TIME,
    standard_checkin_time: STANDARD_CHECKIN_TIME,
    ...over,
  };
}

export function blankDeparting(over: Partial<DepartingReservation> = {}): DepartingReservation {
  return {
    pms_reservation_id: 'res-departing-1',
    departure_time: '11:00:00',
    late_checkout_approved: false,
    late_checkout_until: null,
    actual_checkout_at: null,
    num_nights: 2,
    is_vip: false,
    has_pet: false,
    package_name: null,
    rate_code: null,
    special_requests: null,
    ...over,
  };
}

export function blankArriving(over: Partial<ArrivingReservation> = {}): ArrivingReservation {
  return {
    pms_reservation_id: 'res-arriving-1',
    arrival_time: '15:00:00',
    early_checkin_approved: false,
    early_checkin_from: null,
    is_vip: false,
    loyalty_tier: null,
    language: null,
    has_pet: false,
    adults: 2,
    children: 0,
    infants: 0,
    package_name: null,
    rate_code: null,
    special_requests: null,
    has_baby_cot: false,
    has_extra_bed: false,
    has_early_checkin_request: false,
    has_honeymoon: false,
    has_anniversary: false,
    ...over,
  };
}

export function blankStaying(over: Partial<StayingReservation> = {}): StayingReservation {
  return {
    pms_reservation_id: 'res-staying-1',
    arrival_date: '2026-05-25',
    departure_date: '2026-05-28',
    num_nights: 3,
    day_of_stay: 2,
    is_vip: false,
    loyalty_tier: null,
    language: null,
    has_pet: false,
    eco_stay_opt_in: false,
    dnd_active: false,
    nsr_active: false,
    package_name: null,
    rate_code: null,
    special_requests: null,
    ...over,
  };
}

export function blankRoomContext(over: Partial<RoomContext> = {}): RoomContext {
  return {
    property: blankPropertyContext(),
    room_number: '305',
    room_type: 'Standard King',
    is_suite: false,
    pet_friendly: false,
    current_status: 'occupied',
    status_changed_at: null,
    departing: null,
    arriving: null,
    staying: null,
    pms_hk_assignment: null,
    ...over,
  };
}
