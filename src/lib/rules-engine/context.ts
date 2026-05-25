/**
 * Context builder: reads the live pms_* tables for one property,
 * partitions reservations per room (departing today, arriving today,
 * in-house staying), and assembles a `RoomContext` the rules can
 * consume. All free-text detection (VIP / pet / eco / honeymoon /
 * language / etc.) happens here so rules just consume flags.
 *
 * Only rooms with at least one reservation overlapping today OR a
 * PMS HK plan entry for today are included — empty-all-day rooms
 * don't produce tasks, so we skip them.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';

import { STANDARD_CHECKIN_TIME, STANDARD_CHECKOUT_TIME } from './constants';
import {
  detectAnniversary,
  detectBabyCot,
  detectEarlyCheckinRequest,
  detectEcoStay,
  detectExtraBed,
  detectHasPet,
  detectHoneymoon,
  detectIsVip,
  detectLanguage,
  detectLoyaltyTier,
} from './detection';
import {
  computeDayOfStay,
  propertyLocalDate,
  propertyLocalDayOfWeek,
} from './time-utils';
import type {
  ArrivingReservation,
  DepartingReservation,
  PmsRoomStatus,
  PropertyContext,
  RoomContext,
  StayingReservation,
} from './types';

// ─── Raw row shapes ────────────────────────────────────────────────────────

interface RawRoom {
  room_number: string;
  room_type: string | null;
  is_suite: boolean | null;
  pet_friendly: boolean | null;
}

interface RawReservation {
  pms_reservation_id: string;
  room_number: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  num_nights: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  notes: string | null;
  special_requests: string | null;
  dietary_needs: string | null;
  accessibility_needs: string | null;
  package_name: string | null;
  rate_code: string | null;
  status: string | null;
}

/** Reservation status values that mean "this reservation should NOT
 *  generate a cleaning task" — the guest is no longer coming or has
 *  already left the lifecycle. Post-merge sweep fix (Codex Finding #2).
 *  Without this filter, a cancelled VIP arrival would still fire the
 *  vip-arrival rule and produce a spurious task. */
const TERMINAL_RESERVATION_STATUSES = new Set(['cancelled', 'no_show']);

/** Room statuses where the room is physically unavailable to housekeeping.
 *  Post-merge sweep fix (Codex Finding #3). Even if a stale reservation
 *  is still attached, we don't create cleaning tasks for OOO/OOI rooms —
 *  staff can't enter or the room is held for maintenance. */
const BLOCKED_ROOM_STATUSES = new Set<string>(['out_of_order', 'out_of_inventory']);

interface RawStatusLog {
  room_number: string;
  status: string;
  changed_at: string;
}

interface RawHkAssignment {
  room_number: string;
  cleaning_type: string | null;
  status: string;
  dnd_active: boolean | null;
  late_checkout_approved: boolean | null;
  late_checkout_until: string | null;
  early_checkin_approved: boolean | null;
  early_checkin_from: string | null;
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function buildPropertyContext(
  propertyId: string,
  now: Date,
): Promise<PropertyContext | null> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, timezone')
    .eq('id', propertyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as { id: string; timezone: string | null };
  const timezone = row.timezone ?? 'UTC';

  return {
    property_id: propertyId,
    property_timezone: timezone,
    business_date: propertyLocalDate(now, timezone),
    now_utc: now,
    day_of_week: propertyLocalDayOfWeek(now, timezone),
    standard_checkout_time: STANDARD_CHECKOUT_TIME,
    standard_checkin_time: STANDARD_CHECKIN_TIME,
  };
}

export async function buildRoomContexts(
  prop: PropertyContext,
): Promise<RoomContext[]> {
  const propertyId = prop.property_id;

  const [roomsRes, reservationsRes, statusLogRes, hkRes] = await Promise.all([
    supabaseAdmin
      .from('pms_rooms_inventory')
      .select('room_number, room_type, is_suite, pet_friendly')
      .eq('property_id', propertyId),
    supabaseAdmin
      .from('pms_reservations')
      .select(
        'pms_reservation_id, room_number, arrival_date, arrival_time, departure_date, departure_time, num_nights, adults, children, infants, notes, special_requests, dietary_needs, accessibility_needs, package_name, rate_code, status',
      )
      .eq('property_id', propertyId)
      .lte('arrival_date', prop.business_date)
      .gte('departure_date', prop.business_date),
    supabaseAdmin
      .from('pms_room_status_log')
      .select('room_number, status, changed_at')
      .eq('property_id', propertyId)
      .gte(
        'changed_at',
        new Date(prop.now_utc.getTime() - 14 * 24 * 60 * 60_000).toISOString(),
      )
      .order('changed_at', { ascending: false }),
    supabaseAdmin
      .from('pms_housekeeping_assignments')
      .select(
        'room_number, cleaning_type, status, dnd_active, late_checkout_approved, late_checkout_until, early_checkin_approved, early_checkin_from',
      )
      .eq('property_id', propertyId)
      .eq('date', prop.business_date),
  ]);

  if (roomsRes.error) throw roomsRes.error;
  if (reservationsRes.error) throw reservationsRes.error;
  if (statusLogRes.error) throw statusLogRes.error;
  if (hkRes.error) throw hkRes.error;

  return assembleRoomContexts(
    prop,
    (roomsRes.data ?? []) as RawRoom[],
    (reservationsRes.data ?? []) as RawReservation[],
    (statusLogRes.data ?? []) as RawStatusLog[],
    (hkRes.data ?? []) as RawHkAssignment[],
  );
}

/**
 * Pure data shaping — exported separately so the test suite can run it
 * with hand-built fixture rows instead of needing a Supabase mock.
 */
export function assembleRoomContexts(
  prop: PropertyContext,
  rooms: RawRoom[],
  reservations: RawReservation[],
  statusLogs: RawStatusLog[],
  hkAssignments: RawHkAssignment[],
): RoomContext[] {
  const reservationsByRoom = new Map<string, RawReservation[]>();
  for (const r of reservations) {
    if (!r.room_number) continue;
    // Drop terminal reservations (cancelled / no_show) before partitioning.
    // Status is nullable in pms_reservations; null means "PMS didn't expose
    // the status field" which we treat as still-active.
    if (r.status && TERMINAL_RESERVATION_STATUSES.has(r.status)) continue;
    const list = reservationsByRoom.get(r.room_number) ?? [];
    list.push(r);
    reservationsByRoom.set(r.room_number, list);
  }

  const statusByRoom = new Map<string, RawStatusLog>();
  for (const row of statusLogs) {
    if (!statusByRoom.has(row.room_number)) {
      statusByRoom.set(row.room_number, row);
    }
  }

  const hkByRoom = new Map<string, RawHkAssignment>();
  for (const row of hkAssignments) hkByRoom.set(row.room_number, row);

  const ctxList: RoomContext[] = [];
  for (const room of rooms) {
    const res = reservationsByRoom.get(room.room_number) ?? [];
    const status = statusByRoom.get(room.room_number);
    const hk = hkByRoom.get(room.room_number);

    const departingRaw =
      res.find((r) => r.departure_date === prop.business_date) ?? null;
    const arrivingRaw =
      res.find((r) => r.arrival_date === prop.business_date) ?? null;
    const stayingRaw =
      res.find(
        (r) =>
          r.arrival_date != null &&
          r.departure_date != null &&
          r.arrival_date < prop.business_date &&
          r.departure_date > prop.business_date,
      ) ?? null;

    if (!departingRaw && !arrivingRaw && !stayingRaw && !hk) {
      // Room has no reservation activity today and PMS HK plan didn't
      // mention it — nothing to evaluate.
      continue;
    }

    // Skip rooms physically unavailable to housekeeping (OOO / OOI). A
    // stale reservation attached to a blocked room would otherwise
    // produce a task staff cannot perform.
    if (status?.status && BLOCKED_ROOM_STATUSES.has(status.status)) {
      continue;
    }

    ctxList.push(
      buildRoomContextRow(prop, room, departingRaw, arrivingRaw, stayingRaw, status, hk),
    );
  }
  return ctxList;
}

// ─── Internal: per-room context assembly ───────────────────────────────────

function buildRoomContextRow(
  prop: PropertyContext,
  room: RawRoom,
  departingRaw: RawReservation | null,
  arrivingRaw: RawReservation | null,
  stayingRaw: RawReservation | null,
  status: RawStatusLog | undefined,
  hk: RawHkAssignment | undefined,
): RoomContext {
  const currentStatus = normalizeStatus(status?.status);
  const actualCheckoutAt =
    currentStatus === 'vacant_dirty' && status ? status.changed_at : null;

  return {
    property: prop,
    room_number: room.room_number,
    room_type: room.room_type,
    is_suite: room.is_suite === true,
    pet_friendly: room.pet_friendly === true,
    current_status: currentStatus,
    status_changed_at: status?.changed_at ?? null,
    departing: departingRaw ? toDeparting(departingRaw, hk, actualCheckoutAt) : null,
    arriving: arrivingRaw ? toArriving(arrivingRaw, hk) : null,
    staying: stayingRaw ? toStaying(stayingRaw, hk, prop.business_date) : null,
    pms_hk_assignment: hk
      ? {
          cleaning_type: hk.cleaning_type,
          status: hk.status,
          dnd_active: hk.dnd_active === true,
          late_checkout_approved: hk.late_checkout_approved === true,
          late_checkout_until: hk.late_checkout_until,
          early_checkin_approved: hk.early_checkin_approved === true,
          early_checkin_from: hk.early_checkin_from,
        }
      : null,
  };
}

function normalizeStatus(raw: string | undefined): PmsRoomStatus {
  switch (raw) {
    case 'vacant_clean':
    case 'vacant_dirty':
    case 'occupied':
    case 'occupied_clean':
    case 'occupied_dirty':
    case 'out_of_order':
    case 'out_of_inventory':
    case 'inspected':
      return raw;
    default:
      return 'unknown';
  }
}

function toDeparting(
  res: RawReservation,
  hk: RawHkAssignment | undefined,
  actualCheckoutAt: string | null,
): DepartingReservation {
  const textFields = {
    notes: res.notes,
    special_requests: res.special_requests,
    rate_code: res.rate_code,
    package_name: res.package_name,
  };
  return {
    pms_reservation_id: res.pms_reservation_id,
    departure_time: res.departure_time,
    late_checkout_approved: hk?.late_checkout_approved === true,
    late_checkout_until: hk?.late_checkout_until ?? null,
    actual_checkout_at: actualCheckoutAt,
    num_nights: res.num_nights,
    is_vip: detectIsVip(textFields),
    has_pet: detectHasPet(textFields),
    package_name: res.package_name,
    rate_code: res.rate_code,
    special_requests: res.special_requests,
  };
}

function toArriving(
  res: RawReservation,
  hk: RawHkAssignment | undefined,
): ArrivingReservation {
  const textFields = {
    notes: res.notes,
    special_requests: res.special_requests,
    rate_code: res.rate_code,
    package_name: res.package_name,
  };
  return {
    pms_reservation_id: res.pms_reservation_id,
    arrival_time: res.arrival_time,
    early_checkin_approved: hk?.early_checkin_approved === true,
    early_checkin_from: hk?.early_checkin_from ?? null,
    is_vip: detectIsVip(textFields),
    loyalty_tier: detectLoyaltyTier(textFields),
    language: detectLanguage({
      notes: res.notes,
      special_requests: res.special_requests,
      dietary_needs: res.dietary_needs,
      accessibility_needs: res.accessibility_needs,
    }),
    has_pet: detectHasPet(textFields),
    adults: res.adults,
    children: res.children,
    infants: res.infants,
    package_name: res.package_name,
    rate_code: res.rate_code,
    special_requests: res.special_requests,
    has_baby_cot: detectBabyCot({
      notes: res.notes,
      special_requests: res.special_requests,
    }),
    has_extra_bed: detectExtraBed({
      notes: res.notes,
      special_requests: res.special_requests,
    }),
    has_early_checkin_request: detectEarlyCheckinRequest({
      notes: res.notes,
      special_requests: res.special_requests,
    }),
    has_honeymoon: detectHoneymoon(textFields),
    has_anniversary: detectAnniversary(textFields),
  };
}

function toStaying(
  res: RawReservation,
  hk: RawHkAssignment | undefined,
  businessDate: string,
): StayingReservation {
  const textFields = {
    notes: res.notes,
    special_requests: res.special_requests,
    rate_code: res.rate_code,
    package_name: res.package_name,
  };
  return {
    pms_reservation_id: res.pms_reservation_id,
    arrival_date: res.arrival_date ?? businessDate,
    departure_date: res.departure_date ?? businessDate,
    num_nights: res.num_nights,
    day_of_stay: computeDayOfStay(res.arrival_date ?? businessDate, businessDate),
    is_vip: detectIsVip(textFields),
    loyalty_tier: detectLoyaltyTier(textFields),
    language: detectLanguage({
      notes: res.notes,
      special_requests: res.special_requests,
      dietary_needs: res.dietary_needs,
      accessibility_needs: res.accessibility_needs,
    }),
    has_pet: detectHasPet(textFields),
    eco_stay_opt_in: detectEcoStay({
      notes: res.notes,
      special_requests: res.special_requests,
      package_name: res.package_name,
    }),
    dnd_active: hk?.dnd_active === true,
    nsr_active: false,
    package_name: res.package_name,
    rate_code: res.rate_code,
    special_requests: res.special_requests,
  };
}
