/**
 * Per-table validators for Plan v7 Phase 2b — the 9 net-new tables
 * + a registry that the generic-table-writer looks up by tableName.
 *
 * These complement the descriptor-driven type/range/enum checks in
 * generic-table-writer with cross-field invariants Postgres can't
 * encode in a CHECK constraint (rooms_picked_up ≤ rooms_blocked,
 * forecast_date ≥ snapshot_date, occupied_rooms ≤ total_rooms-ish).
 *
 * Each function takes a row (as Record<string, unknown> because the
 * row comes from the generic writer's untyped path) and returns either
 * `{ ok: true }` or `{ ok: false, reason }`. The writer logs the reason
 * to error_logs and drops the row from the batch.
 *
 * Tables that already have validators in validators.ts (pms_reservations,
 * pms_room_status_log, pms_housekeeping_assignments, pms_work_orders_v2,
 * pms_in_house_snapshot) keep theirs — those are wired in directly by
 * the legacy writers in new-schema-writer.ts and are reused via
 * thinValidator wrappers when the generic writer takes over.
 */

import {
  validateReservation,
  validateRoomStatus,
  validateHousekeeping,
  validateWorkOrder,
  validateInHouseSnapshot,
  validNonEmptyString,
  validInteger,
  validPercent,
  validCents,
  validISODate,
  type ReservationRow,
  type RoomStatusRow,
  type HousekeepingRow,
  type WorkOrderRow,
  type InHouseSnapshotRow,
} from './validators.js';

export type ValidatorResult = { ok: true } | { ok: false; reason: string };
export type Validator = (row: Record<string, unknown>) => ValidatorResult;

// ─── pms_guests ──────────────────────────────────────────────────────────

export function validateGuest(row: Record<string, unknown>): ValidatorResult {
  if (!validNonEmptyString(row.pms_guest_id)) return { ok: false, reason: 'pms_guest_id required' };
  if (!validNonEmptyString(row.name)) return { ok: false, reason: 'name required' };
  // Loyalty fields must be non-negative if present.
  if (row.loyalty_points !== undefined && row.loyalty_points !== null && !validInteger(row.loyalty_points, { min: 0 })) {
    return { ok: false, reason: 'loyalty_points must be non-negative integer' };
  }
  if (row.lifetime_stays !== undefined && row.lifetime_stays !== null && !validInteger(row.lifetime_stays, { min: 0 })) {
    return { ok: false, reason: 'lifetime_stays must be non-negative integer' };
  }
  return { ok: true };
}

// ─── pms_rooms_inventory ─────────────────────────────────────────────────

export function validateRoomsInventory(row: Record<string, unknown>): ValidatorResult {
  if (!validNonEmptyString(row.room_number)) return { ok: false, reason: 'room_number required' };
  if (row.max_occupancy !== undefined && row.max_occupancy !== null &&
      !validInteger(row.max_occupancy, { min: 0, max: 20 })) {
    return { ok: false, reason: 'max_occupancy out of 0..20 range' };
  }
  return { ok: true };
}

// ─── pms_revenue_daily ───────────────────────────────────────────────────

export function validateRevenueDaily(row: Record<string, unknown>): ValidatorResult {
  if (!validISODate(row.date)) return { ok: false, reason: 'date must be ISO YYYY-MM-DD' };
  if (!validInteger(row.occupied_rooms, { min: 0 })) return { ok: false, reason: 'occupied_rooms required, non-negative' };
  // feature/cua-per-hotel-data — validate the revenue / RevPAR metrics ONLY when
  // the feed actually extracted them. A historical-OCCUPANCY report (and some
  // partial getRevenueDaily reports) legitimately carry occupancy WITHOUT
  // rooms-revenue / ADR / RevPAR; hard-requiring all four made this layer-2
  // validator STRICTER than the descriptor and rejected those rows outright.
  // `null` is the writer's "column not extracted" sentinel (applyTemplateParsers
  // maps an absent column to null) so treat null/undefined as absent. Present
  // values are still fully checked — nothing else is loosened.
  //
  // NOTE: the live pms_revenue_daily descriptor still marks these columns
  // required (layer-1, generic-table-writer.validateRows), so a row genuinely
  // missing them is gated THERE. This change only stops layer-2 from
  // double-rejecting a row layer-1 already accepts, and unblocks partial reports
  // on any revenue-shaped table whose descriptor does not require every metric.
  const present = (v: unknown): boolean => v !== undefined && v !== null;
  if (present(row.rooms_revenue_cents) && !validCents(row.rooms_revenue_cents)) {
    return { ok: false, reason: 'rooms_revenue_cents must be non-negative integer' };
  }
  if (present(row.occupancy_pct) && !validPercent(row.occupancy_pct)) {
    return { ok: false, reason: 'occupancy_pct must be 0..100' };
  }
  if (present(row.adr_cents) && !validCents(row.adr_cents)) {
    return { ok: false, reason: 'adr_cents must be non-negative integer' };
  }
  if (present(row.revpar_cents) && !validCents(row.revpar_cents)) {
    return { ok: false, reason: 'revpar_cents must be non-negative integer' };
  }
  // Cross-field: RevPAR = ADR * occupancy/100. Allow 5% slop for rounding. Only
  // checkable when all three are present (an occupancy-only row has nothing to
  // cross-check); each was individually range-validated above when present.
  if (present(row.adr_cents) && present(row.occupancy_pct) && present(row.revpar_cents)) {
    const adr = row.adr_cents as number;
    const occ = row.occupancy_pct as number;
    const revpar = row.revpar_cents as number;
    const expected = adr * (occ / 100);
    const slop = Math.max(50, expected * 0.05);  // 50¢ floor or 5%
    if (Math.abs(revpar - expected) > slop) {
      return { ok: false, reason: `RevPAR mismatch: expected ~${expected.toFixed(0)}, got ${revpar} (ADR=${adr}, occ=${occ}%)` };
    }
  }
  return { ok: true };
}

// ─── pms_forecast_daily ──────────────────────────────────────────────────

export function validateForecastDaily(row: Record<string, unknown>): ValidatorResult {
  if (!validISODate(row.forecast_date)) return { ok: false, reason: 'forecast_date must be ISO' };
  if (!validISODate(row.snapshot_date)) return { ok: false, reason: 'snapshot_date must be ISO' };
  // Cross-field: forecasts must be FORWARD-LOOKING.
  if ((row.forecast_date as string) < (row.snapshot_date as string)) {
    return { ok: false, reason: `forecast_date ${row.forecast_date} is in the past relative to snapshot_date ${row.snapshot_date}` };
  }
  if (!validPercent(row.projected_occupancy_pct)) return { ok: false, reason: 'projected_occupancy_pct must be 0..100' };
  return { ok: true };
}

// ─── pms_channel_performance ─────────────────────────────────────────────

export function validateChannelPerformance(row: Record<string, unknown>): ValidatorResult {
  if (!validISODate(row.date)) return { ok: false, reason: 'date must be ISO' };
  if (!validNonEmptyString(row.channel)) return { ok: false, reason: 'channel required' };
  if (!validInteger(row.bookings_count, { min: 0 })) return { ok: false, reason: 'bookings_count must be non-negative' };
  if (!validInteger(row.rooms_sold, { min: 0 })) return { ok: false, reason: 'rooms_sold must be non-negative' };
  if (!validCents(row.revenue_cents)) return { ok: false, reason: 'revenue_cents must be non-negative integer' };
  // Cross-field: rooms_sold can't exceed bookings_count × MAX_ROOMS_PER_BOOKING.
  // Empirically: most bookings = 1 room; some are 2; >5 is weird.
  const bookings = row.bookings_count as number;
  const sold = row.rooms_sold as number;
  if (bookings > 0 && sold > bookings * 10) {
    return { ok: false, reason: `rooms_sold ${sold} implausibly high vs bookings_count ${bookings}` };
  }
  return { ok: true };
}

// ─── pms_activity_log ────────────────────────────────────────────────────

export function validateActivityLog(row: Record<string, unknown>): ValidatorResult {
  if (typeof row.captured_at !== 'string') return { ok: false, reason: 'captured_at required' };
  if (!validNonEmptyString(row.pms_user)) return { ok: false, reason: 'pms_user required' };
  if (!validNonEmptyString(row.action)) return { ok: false, reason: 'action required' };
  return { ok: true };
}

// ─── pms_lost_and_found ──────────────────────────────────────────────────

const LOST_FOUND_STATUSES = new Set(['unclaimed', 'claimed', 'disposed']);

export function validateLostAndFound(row: Record<string, unknown>): ValidatorResult {
  if (!validNonEmptyString(row.item_description)) return { ok: false, reason: 'item_description required' };
  if (!validNonEmptyString(row.location_found)) return { ok: false, reason: 'location_found required' };
  if (!validISODate(row.found_at)) return { ok: false, reason: 'found_at must be ISO date' };
  if (typeof row.status !== 'string' || !LOST_FOUND_STATUSES.has(row.status)) {
    return { ok: false, reason: `status must be one of ${[...LOST_FOUND_STATUSES].join(', ')}` };
  }
  return { ok: true };
}

// ─── pms_groups_and_blocks ───────────────────────────────────────────────

export function validateGroupsAndBlocks(row: Record<string, unknown>): ValidatorResult {
  if (!validNonEmptyString(row.pms_group_id)) return { ok: false, reason: 'pms_group_id required' };
  if (!validNonEmptyString(row.group_name)) return { ok: false, reason: 'group_name required' };
  if (!validISODate(row.block_start_date)) return { ok: false, reason: 'block_start_date must be ISO' };
  if (!validInteger(row.rooms_blocked, { min: 0 })) return { ok: false, reason: 'rooms_blocked required' };
  // Cross-field: rooms_picked_up can't exceed rooms_blocked.
  if (row.rooms_picked_up !== undefined && row.rooms_picked_up !== null) {
    if (!validInteger(row.rooms_picked_up, { min: 0 })) {
      return { ok: false, reason: 'rooms_picked_up must be non-negative integer' };
    }
    const blocked = row.rooms_blocked as number;
    const picked = row.rooms_picked_up as number;
    if (picked > blocked * 2) {  // allow some wash-up for over-pickup
      return { ok: false, reason: `rooms_picked_up ${picked} implausibly higher than rooms_blocked ${blocked}` };
    }
  }
  // Cross-field: block_end_date >= block_start_date if both present.
  if (row.block_end_date && typeof row.block_end_date === 'string' && validISODate(row.block_end_date)) {
    if ((row.block_end_date as string) < (row.block_start_date as string)) {
      return { ok: false, reason: `block_end_date ${row.block_end_date} before block_start_date ${row.block_start_date}` };
    }
  }
  return { ok: true };
}

// ─── pms_rates_and_inventory ─────────────────────────────────────────────

export function validateRatesAndInventory(row: Record<string, unknown>): ValidatorResult {
  if (!validISODate(row.date)) return { ok: false, reason: 'date must be ISO' };
  if (!validNonEmptyString(row.room_type)) return { ok: false, reason: 'room_type required' };
  if (!validNonEmptyString(row.rate_plan)) return { ok: false, reason: 'rate_plan required' };
  if (!validCents(row.rate_amount_cents)) return { ok: false, reason: 'rate_amount_cents must be non-negative integer' };
  if (!validInteger(row.available_rooms, { min: 0 })) return { ok: false, reason: 'available_rooms must be non-negative' };
  return { ok: true };
}

// ─── Registry: tableName → validator ─────────────────────────────────────

/**
 * Used by generic-table-writer.ts (layer-2 validation) to dispatch each
 * row to its per-table validator. Tables not in the registry skip layer 2
 * (descriptor-driven layer 1 still runs).
 */
export const VALIDATOR_REGISTRY: Record<string, Validator> = {
  // Phase 2 net-new tables.
  pms_guests:                 validateGuest,
  pms_rooms_inventory:        validateRoomsInventory,
  pms_revenue_daily:          validateRevenueDaily,
  pms_forecast_daily:         validateForecastDaily,
  pms_channel_performance:    validateChannelPerformance,
  pms_activity_log:           validateActivityLog,
  pms_lost_and_found:         validateLostAndFound,
  pms_groups_and_blocks:      validateGroupsAndBlocks,
  pms_rates_and_inventory:    validateRatesAndInventory,
  // Phase 1 tables — wrap the existing typed validators so the generic
  // writer can call them uniformly.
  pms_reservations: (row: Record<string, unknown>) => {
    const r = validateReservation(row as ReservationRow);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: r.errors.join('; ') };
  },
  pms_room_status_log: (row: Record<string, unknown>) => {
    const r = validateRoomStatus(row as RoomStatusRow);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: r.errors.join('; ') };
  },
  pms_housekeeping_assignments: (row: Record<string, unknown>) => {
    const r = validateHousekeeping(row as HousekeepingRow);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: r.errors.join('; ') };
  },
  pms_work_orders_v2: (row: Record<string, unknown>) => {
    const r = validateWorkOrder(row as WorkOrderRow);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: r.errors.join('; ') };
  },
  pms_in_house_snapshot: (row: Record<string, unknown>) => {
    const r = validateInHouseSnapshot(row as InHouseSnapshotRow);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: r.errors.join('; ') };
  },
};

export function getValidator(tableName: string): Validator | undefined {
  return VALIDATOR_REGISTRY[tableName];
}
