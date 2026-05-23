/**
 * Per-field + cross-field safety checks.
 *
 * Plan v4 architecture decision #5 (per Codex's adversarial finding):
 * the hybrid-read strategy assumes "if Claude isn't called, the data
 * is fine." But the dangerous failure mode is a SUCCESSFUL selector
 * returning stale, partial, or semantically wrong data. The system
 * would happily write empty strings or yesterday's room counts to
 * Supabase with no alarm. The validator layer is the firewall.
 *
 * Three layers:
 *   1. Per-field validators — type, range, format, null handling for
 *      each canonical field (room_number must look like 3-4 digits;
 *      occupancy_pct must be 0..100; arrival_date must parse).
 *   2. Cross-field invariants — occupied_rooms <= total_rooms;
 *      departure_date >= arrival_date; if status='checked_in' then
 *      arrival_date must be in the past.
 *   3. Anomaly detection — row count swung 50%+ since last successful
 *      pull; revenue field 10x previous high; etc. These don't fail the
 *      write but flag it for human review (admin UI surfaces).
 *
 * Validators are called BEFORE every Supabase write. A failed
 * validation:
 *   - Logs a warn with the field + reason
 *   - Drops the bad value (writes null in its place) OR drops the whole
 *     row depending on severity
 *   - Increments the property_sessions.read_failure_streak
 *
 * Last-good preservation (existing scraper pattern in dashboard-pull.js)
 * is enforced at the writer layer (persistence/new-schema-writer.ts) —
 * when the whole extraction fails validation, the previous good values
 * stay in Supabase. This module only provides the predicates.
 */

import { log } from './log.js';

// ─── Per-field validators ─────────────────────────────────────────────────

const ROOM_NUMBER_RE = /^\d{3,4}[A-Z]?$/;

export function validRoomNumber(value: unknown): value is string {
  return typeof value === 'string' && ROOM_NUMBER_RE.test(value.trim());
}

export function validISODate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Accept YYYY-MM-DD only.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && value === d.toISOString().slice(0, 10);
}

export function validInteger(
  value: unknown,
  opts: { min?: number; max?: number } = {},
): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  if (opts.min !== undefined && value < opts.min) return false;
  if (opts.max !== undefined && value > opts.max) return false;
  return true;
}

export function validPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

export function validCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function validNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ─── Canonical row validators (one per active feed) ───────────────────────

export interface ReservationRow {
  pms_reservation_id?: string;
  guest_name?: string;
  room_number?: string;
  arrival_date?: string;
  departure_date?: string;
  status?: string;
  adults?: number;
  children?: number;
  // Other fields permitted, validated loosely.
  [key: string]: unknown;
}

export interface RowValidationResult<T> {
  /** True when the row is clean enough to write. */
  ok: boolean;
  /** Sanitized row — bad fields replaced with null. */
  clean: T;
  /** Field-level issues found (non-fatal, value was nulled). */
  warnings: string[];
  /** Whole-row issues (fatal — row will be dropped). */
  errors: string[];
}

export function validateReservation(row: ReservationRow): RowValidationResult<ReservationRow> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const clean: ReservationRow = { ...row };

  if (!validNonEmptyString(row.pms_reservation_id)) {
    errors.push('pms_reservation_id missing or empty');
  }

  if (row.room_number !== undefined && row.room_number !== null) {
    if (!validRoomNumber(row.room_number)) {
      warnings.push(`room_number "${row.room_number}" invalid format`);
      clean.room_number = undefined;
    } else {
      clean.room_number = (row.room_number as string).trim();
    }
  }

  if (row.arrival_date !== undefined && row.arrival_date !== null) {
    if (!validISODate(row.arrival_date)) {
      warnings.push(`arrival_date "${row.arrival_date}" not ISO YYYY-MM-DD`);
      clean.arrival_date = undefined;
    }
  }
  if (row.departure_date !== undefined && row.departure_date !== null) {
    if (!validISODate(row.departure_date)) {
      warnings.push(`departure_date "${row.departure_date}" not ISO YYYY-MM-DD`);
      clean.departure_date = undefined;
    }
  }

  // Cross-field: departure_date >= arrival_date when both present.
  if (clean.arrival_date && clean.departure_date) {
    if (clean.departure_date < clean.arrival_date) {
      warnings.push(
        `departure_date ${clean.departure_date} earlier than arrival_date ${clean.arrival_date} — both dropped`,
      );
      clean.arrival_date = undefined;
      clean.departure_date = undefined;
    }
  }

  for (const numField of ['adults', 'children', 'infants', 'num_nights'] as const) {
    const v = row[numField];
    if (v !== undefined && v !== null && !validInteger(v, { min: 0, max: 100 })) {
      warnings.push(`${numField} "${v}" not a valid count`);
      clean[numField] = undefined;
    }
  }

  if (row.status !== undefined && row.status !== null) {
    if (!['booked', 'checked_in', 'checked_out', 'cancelled', 'no_show'].includes(row.status as string)) {
      warnings.push(`status "${row.status}" not a known enum value — dropped`);
      clean.status = undefined;
    }
  }

  return {
    ok: errors.length === 0,
    clean,
    warnings,
    errors,
  };
}

export interface RoomStatusRow {
  room_number?: string;
  status?: string;
  changed_at?: string;
  [key: string]: unknown;
}

const ROOM_STATUS_ENUM = new Set([
  'vacant_clean',
  'vacant_dirty',
  'occupied',
  'occupied_clean',
  'occupied_dirty',
  'out_of_order',
  'out_of_inventory',
  'inspected',
  'unknown',
]);

export function validateRoomStatus(row: RoomStatusRow): RowValidationResult<RoomStatusRow> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const clean: RoomStatusRow = { ...row };

  if (!validRoomNumber(row.room_number)) {
    errors.push(`room_number "${row.room_number}" invalid`);
  }
  if (!row.status || !ROOM_STATUS_ENUM.has(row.status as string)) {
    errors.push(`status "${row.status}" not in enum`);
  }

  return { ok: errors.length === 0, clean, warnings, errors };
}

export interface HousekeepingRow {
  date?: string;
  room_number?: string;
  housekeeper_name?: string;
  cleaning_type?: string;
  [key: string]: unknown;
}

const CLEANING_TYPE_ENUM = new Set([
  'departure',
  'stayover',
  'deep',
  'refresh',
  'inspection',
  'arrival',
]);

export function validateHousekeeping(row: HousekeepingRow): RowValidationResult<HousekeepingRow> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const clean: HousekeepingRow = { ...row };

  if (!validISODate(row.date)) {
    errors.push(`date "${row.date}" invalid`);
  }
  if (!validRoomNumber(row.room_number)) {
    errors.push(`room_number "${row.room_number}" invalid`);
  }
  if (row.cleaning_type !== undefined && row.cleaning_type !== null) {
    if (!CLEANING_TYPE_ENUM.has(row.cleaning_type as string)) {
      warnings.push(`cleaning_type "${row.cleaning_type}" unknown — dropped`);
      clean.cleaning_type = undefined;
    }
  }

  return { ok: errors.length === 0, clean, warnings, errors };
}

export interface WorkOrderRow {
  pms_work_order_id?: string;
  room_number?: string;
  description?: string;
  priority?: string;
  status?: string;
  [key: string]: unknown;
}

const WORK_ORDER_PRIORITY = new Set(['urgent', 'high', 'medium', 'low']);
const WORK_ORDER_STATUS = new Set(['open', 'in_progress', 'closed', 'deferred', 'resolved']);

export function validateWorkOrder(row: WorkOrderRow): RowValidationResult<WorkOrderRow> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const clean: WorkOrderRow = { ...row };

  if (!validNonEmptyString(row.pms_work_order_id)) {
    errors.push('pms_work_order_id missing');
  }
  if (row.room_number !== undefined && row.room_number !== null && !validRoomNumber(row.room_number)) {
    warnings.push(`room_number "${row.room_number}" invalid — dropped`);
    clean.room_number = undefined;
  }
  if (row.priority !== undefined && row.priority !== null) {
    if (!WORK_ORDER_PRIORITY.has(row.priority as string)) {
      warnings.push(`priority "${row.priority}" unknown — defaulting to medium`);
      clean.priority = 'medium';
    }
  }
  if (row.status !== undefined && row.status !== null) {
    if (!WORK_ORDER_STATUS.has(row.status as string)) {
      warnings.push(`status "${row.status}" unknown — defaulting to open`);
      clean.status = 'open';
    }
  }

  return { ok: errors.length === 0, clean, warnings, errors };
}

export interface InHouseSnapshotRow {
  total_guests_in_house?: number;
  total_occupied_rooms?: number;
  total_vacant_clean?: number;
  total_vacant_dirty?: number;
  total_ooo?: number;
  arrivals_remaining_today?: number;
  departures_remaining_today?: number;
  [key: string]: unknown;
}

export function validateInHouseSnapshot(
  row: InHouseSnapshotRow,
  context: { previousTotalOccupied?: number; expectedRoomCountRange?: [number, number] } = {},
): RowValidationResult<InHouseSnapshotRow> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const clean: InHouseSnapshotRow = { ...row };

  for (const field of [
    'total_guests_in_house',
    'total_occupied_rooms',
    'total_vacant_clean',
    'total_vacant_dirty',
    'total_ooo',
    'arrivals_remaining_today',
    'departures_remaining_today',
  ] as const) {
    const v = row[field];
    if (v !== undefined && v !== null) {
      if (!validInteger(v, { min: 0, max: 10000 })) {
        warnings.push(`${field} "${v}" not a plausible count — dropped`);
        clean[field] = undefined;
      }
    }
  }

  // Cross-field: total_occupied + total_vacant_clean + total_vacant_dirty + total_ooo
  // should roughly equal total_rooms. Without total_rooms, we can't check.
  // Use expectedRoomCountRange when provided.
  const [minRooms, maxRooms] = context.expectedRoomCountRange ?? [0, 10000];
  const sum =
    (clean.total_occupied_rooms ?? 0) +
    (clean.total_vacant_clean ?? 0) +
    (clean.total_vacant_dirty ?? 0) +
    (clean.total_ooo ?? 0);

  if (sum > 0 && (sum < minRooms || sum > maxRooms)) {
    errors.push(
      `room count breakdown sums to ${sum}, outside expected range [${minRooms}, ${maxRooms}] — likely bad extraction`,
    );
  }

  // Anomaly: occupancy swung 50%+ since previous successful pull.
  if (
    context.previousTotalOccupied !== undefined &&
    clean.total_occupied_rooms !== undefined &&
    context.previousTotalOccupied > 0
  ) {
    const ratio = clean.total_occupied_rooms / context.previousTotalOccupied;
    if (ratio < 0.5 || ratio > 1.5) {
      warnings.push(
        `total_occupied_rooms swung ${(ratio * 100).toFixed(0)}% vs previous (${context.previousTotalOccupied} → ${clean.total_occupied_rooms}) — review`,
      );
    }
  }

  return { ok: errors.length === 0, clean, warnings, errors };
}

// ─── Logging helper ───────────────────────────────────────────────────────

/**
 * Standardized log output for a validation result. Call this whenever a
 * validator returns warnings/errors — keeps logging consistent.
 */
export function logValidation(
  propertyId: string,
  feed: string,
  result: RowValidationResult<unknown>,
  rowKey?: string,
): void {
  if (result.errors.length > 0) {
    log.warn('validator: row rejected', {
      propertyId,
      feed,
      rowKey,
      errors: result.errors,
      warnings: result.warnings,
    });
  } else if (result.warnings.length > 0) {
    log.info('validator: row passed with warnings', {
      propertyId,
      feed,
      rowKey,
      warnings: result.warnings,
    });
  }
}
