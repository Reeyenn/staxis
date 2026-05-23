/**
 * Writes extracted PMS data into the new 15-table schema (migration 0202).
 *
 * One exported function per active Phase 1 feed:
 *   - saveReservations          → pms_reservations
 *   - saveRoomStatuses          → pms_room_status_log + pms_rooms_inventory
 *   - saveHousekeepingAssignments → pms_housekeeping_assignments
 *   - saveWorkOrders            → pms_work_orders_v2 (with reconciliation)
 *   - saveInHouseSnapshot       → pms_in_house_snapshot (atomic)
 *
 * Every write goes through the validator layer first. Per-row failures
 * drop the bad row + log; whole-feed failures preserve the previous
 * good value (last-good preservation from scraper/dashboard-pull.js).
 *
 * Work-order reconciliation is the most subtle: three-way diff between
 * "what PMS shows now" and "what we have stored" — preserves the
 * existing scraper/ooo-pull.js semantics (insert new, update existing,
 * auto-resolve disappeared, reopen previously-resolved).
 */

import { supabase } from '../supabase.js';
import { log } from '../log.js';
import {
  validateReservation,
  validateRoomStatus,
  validateHousekeeping,
  validateWorkOrder,
  validateInHouseSnapshot,
  logValidation,
  type ReservationRow,
  type RoomStatusRow,
  type HousekeepingRow,
  type WorkOrderRow,
  type InHouseSnapshotRow,
} from '../validators.js';

// ─── Reservations (arrivals + departures) ─────────────────────────────────

export interface SaveReservationsResult {
  ok: boolean;
  inserted: number;
  updated: number;
  rejected: number;
  errors: string[];
}

export async function saveReservations(
  propertyId: string,
  rows: ReservationRow[],
): Promise<SaveReservationsResult> {
  const result: SaveReservationsResult = { ok: true, inserted: 0, updated: 0, rejected: 0, errors: [] };
  const upserts: Array<Record<string, unknown>> = [];

  for (const raw of rows) {
    const validation = validateReservation(raw);
    logValidation(propertyId, 'reservations', validation, raw.pms_reservation_id);
    if (!validation.ok) {
      result.rejected++;
      continue;
    }
    upserts.push({
      property_id: propertyId,
      pms_reservation_id: validation.clean.pms_reservation_id,
      pms_guest_id: validation.clean.pms_guest_id ?? null,
      guest_name: validation.clean.guest_name ?? null,
      room_number: validation.clean.room_number ?? null,
      arrival_date: validation.clean.arrival_date ?? null,
      departure_date: validation.clean.departure_date ?? null,
      num_nights: validation.clean.num_nights ?? null,
      adults: validation.clean.adults ?? null,
      children: validation.clean.children ?? null,
      status: validation.clean.status ?? null,
      notes: (validation.clean.notes as string | undefined) ?? null,
      raw: raw as unknown as Record<string, unknown>,
      last_synced_at: new Date().toISOString(),
    });
  }

  if (upserts.length === 0) {
    return result;
  }

  const { error } = await supabase
    .from('pms_reservations')
    .upsert(upserts, { onConflict: 'property_id,pms_reservation_id' });

  if (error) {
    log.error('persistence: pms_reservations upsert failed', { propertyId, err: error });
    result.ok = false;
    result.errors.push(error.message);
  } else {
    // upsert returns no count by default; treat all as upserts (insert-or-update).
    result.inserted = upserts.length;
  }

  return result;
}

// ─── Room statuses ────────────────────────────────────────────────────────
//
// Append to pms_room_status_log when status changes vs the most recent
// log row. Avoids exploding the log with no-op rewrites every 30 sec.
// Also keeps pms_rooms_inventory rows fresh (last_synced_at).

export interface SaveRoomStatusesResult {
  ok: boolean;
  statusChanges: number;
  inventoryRefreshed: number;
  rejected: number;
  errors: string[];
}

export async function saveRoomStatuses(
  propertyId: string,
  rows: RoomStatusRow[],
): Promise<SaveRoomStatusesResult> {
  const result: SaveRoomStatusesResult = {
    ok: true,
    statusChanges: 0,
    inventoryRefreshed: 0,
    rejected: 0,
    errors: [],
  };
  const now = new Date().toISOString();

  const validRows: RoomStatusRow[] = [];
  for (const raw of rows) {
    const validation = validateRoomStatus(raw);
    logValidation(propertyId, 'room_status', validation, raw.room_number);
    if (!validation.ok) {
      result.rejected++;
      continue;
    }
    validRows.push(validation.clean);
  }

  if (validRows.length === 0) return result;

  // Load current latest status per room to detect changes.
  const { data: latest, error: latestErr } = await supabase
    .from('pms_room_status_log')
    .select('room_number, status, changed_at')
    .eq('property_id', propertyId)
    .order('changed_at', { ascending: false });

  if (latestErr) {
    log.warn('persistence: failed to load latest room statuses (will append all)', {
      propertyId,
      err: latestErr.message,
    });
  }

  // Build a "current status per room" map from the log (first row per room since ordered desc).
  const currentByRoom = new Map<string, string>();
  for (const row of (latest ?? []) as Array<{ room_number: string; status: string }>) {
    if (!currentByRoom.has(row.room_number)) {
      currentByRoom.set(row.room_number, row.status);
    }
  }

  // Find rooms whose status changed.
  const inserts: Array<Record<string, unknown>> = [];
  const inventoryUpserts: Array<Record<string, unknown>> = [];
  for (const row of validRows) {
    if (!row.room_number || !row.status) continue;
    const current = currentByRoom.get(row.room_number);
    if (current !== row.status) {
      inserts.push({
        property_id: propertyId,
        room_number: row.room_number,
        status: row.status,
        changed_at: row.changed_at ?? now,
        source: 'cua',
        raw: row as unknown as Record<string, unknown>,
        last_synced_at: now,
      });
    }
    // Always refresh inventory last_synced_at — the room exists.
    inventoryUpserts.push({
      property_id: propertyId,
      room_number: row.room_number,
      last_synced_at: now,
    });
  }

  // Append status changes.
  if (inserts.length > 0) {
    const { error } = await supabase.from('pms_room_status_log').insert(inserts);
    if (error) {
      log.error('persistence: pms_room_status_log insert failed', { propertyId, err: error });
      result.ok = false;
      result.errors.push(error.message);
    } else {
      result.statusChanges = inserts.length;
    }
  }

  // Refresh inventory rows. Upsert on (property_id, room_number) — we
  // don't have richer room metadata at this point, just touching
  // last_synced_at so admin can see "did we see this room recently?"
  if (inventoryUpserts.length > 0) {
    const { error } = await supabase
      .from('pms_rooms_inventory')
      .upsert(inventoryUpserts, { onConflict: 'property_id,room_number' });
    if (error) {
      log.warn('persistence: pms_rooms_inventory upsert failed (non-fatal)', { propertyId, err: error });
    } else {
      result.inventoryRefreshed = inventoryUpserts.length;
    }
  }

  return result;
}

// ─── Housekeeping assignments ─────────────────────────────────────────────
//
// One row per (property_id, date, room_number). Upserts overwrite — the
// latest PMS state is the truth.

export interface SaveHousekeepingResult {
  ok: boolean;
  upserted: number;
  rejected: number;
  errors: string[];
}

export async function saveHousekeepingAssignments(
  propertyId: string,
  rows: HousekeepingRow[],
): Promise<SaveHousekeepingResult> {
  const result: SaveHousekeepingResult = { ok: true, upserted: 0, rejected: 0, errors: [] };
  const now = new Date().toISOString();
  const upserts: Array<Record<string, unknown>> = [];

  for (const raw of rows) {
    const validation = validateHousekeeping(raw);
    logValidation(propertyId, 'housekeeping', validation, `${raw.date}/${raw.room_number}`);
    if (!validation.ok) {
      result.rejected++;
      continue;
    }
    upserts.push({
      property_id: propertyId,
      date: validation.clean.date,
      room_number: validation.clean.room_number,
      housekeeper_name: validation.clean.housekeeper_name ?? null,
      cleaning_type: validation.clean.cleaning_type ?? null,
      status: validation.clean.status ?? 'not_started',
      dnd_active: (validation.clean.dnd_active as boolean | undefined) ?? null,
      raw: raw as unknown as Record<string, unknown>,
      last_synced_at: now,
    });
  }

  if (upserts.length === 0) return result;

  const { error } = await supabase
    .from('pms_housekeeping_assignments')
    .upsert(upserts, { onConflict: 'property_id,date,room_number' });

  if (error) {
    log.error('persistence: pms_housekeeping_assignments upsert failed', { propertyId, err: error });
    result.ok = false;
    result.errors.push(error.message);
  } else {
    result.upserted = upserts.length;
  }

  return result;
}

// ─── Work orders (with reconciliation) ────────────────────────────────────
//
// Preserves scraper/ooo-pull.js semantics:
//   1. NEW in PMS → insert with status='open'
//   2. EXISTING in PMS + open in DB → update in place
//   3. EXISTING in DB (open) but NOT in PMS → mark status='resolved'
//   4. PREVIOUSLY resolved + reappeared in PMS → reopen (status='open')
// Loading ALL ca_ooo rows (resolved + open) is required for case 4.

export interface SaveWorkOrdersResult {
  ok: boolean;
  inserted: number;
  updated: number;
  resolved: number;
  reopened: number;
  rejected: number;
  errors: string[];
}

export async function saveWorkOrders(
  propertyId: string,
  pmsRows: WorkOrderRow[],
): Promise<SaveWorkOrdersResult> {
  const result: SaveWorkOrdersResult = {
    ok: true,
    inserted: 0,
    updated: 0,
    resolved: 0,
    reopened: 0,
    rejected: 0,
    errors: [],
  };
  const now = new Date().toISOString();

  // Validate first; rejected rows still contribute to "currently in PMS"
  // set so we don't false-resolve. Build pmsKeys from RAW data before
  // validation, as ooo-pull.js does (F5 — Codex 2026-05-12 audit).
  const pmsKeys = new Set<string>();
  for (const raw of pmsRows) {
    if (typeof raw.pms_work_order_id === 'string' && raw.pms_work_order_id.trim() !== '') {
      pmsKeys.add(raw.pms_work_order_id.trim());
    }
  }

  const validRows: WorkOrderRow[] = [];
  for (const raw of pmsRows) {
    const validation = validateWorkOrder(raw);
    logValidation(propertyId, 'work_orders', validation, raw.pms_work_order_id);
    if (!validation.ok) {
      result.rejected++;
      continue;
    }
    validRows.push(validation.clean);
  }

  // Load ALL existing work orders for this property (open + resolved).
  const { data: existing, error: existingErr } = await supabase
    .from('pms_work_orders_v2')
    .select('id, pms_work_order_id, status')
    .eq('property_id', propertyId);

  if (existingErr) {
    log.error('persistence: pms_work_orders_v2 lookup failed', { propertyId, err: existingErr });
    result.ok = false;
    result.errors.push(existingErr.message);
    return result;
  }

  const existingByKey = new Map<string, { id: string; status: string }>();
  for (const row of (existing ?? []) as Array<{ id: string; pms_work_order_id: string; status: string }>) {
    existingByKey.set(row.pms_work_order_id, { id: row.id, status: row.status });
  }

  // Process PMS rows: insert new, update existing, reopen if previously resolved.
  for (const row of validRows) {
    if (!row.pms_work_order_id) continue;
    const existingRow = existingByKey.get(row.pms_work_order_id);
    const payload: Record<string, unknown> = {
      property_id: propertyId,
      pms_work_order_id: row.pms_work_order_id,
      room_number: row.room_number ?? null,
      description: row.description ?? null,
      priority: row.priority ?? 'medium',
      out_of_order: (row.out_of_order as boolean | undefined) ?? null,
      raw: row as unknown as Record<string, unknown>,
      last_synced_at: now,
    };

    if (!existingRow) {
      // New work order.
      const { error } = await supabase
        .from('pms_work_orders_v2')
        .insert({ ...payload, status: 'open', reported_at: now });
      if (error) {
        result.errors.push(`insert ${row.pms_work_order_id}: ${error.message}`);
        result.ok = false;
      } else {
        result.inserted++;
      }
    } else if (existingRow.status === 'resolved') {
      // Reopen — was resolved, now back in PMS.
      const { error } = await supabase
        .from('pms_work_orders_v2')
        .update({ ...payload, status: 'open', resolved_at: null })
        .eq('id', existingRow.id);
      if (error) {
        result.errors.push(`reopen ${row.pms_work_order_id}: ${error.message}`);
        result.ok = false;
      } else {
        result.reopened++;
      }
    } else {
      // Update in place.
      const { error } = await supabase
        .from('pms_work_orders_v2')
        .update(payload)
        .eq('id', existingRow.id);
      if (error) {
        result.errors.push(`update ${row.pms_work_order_id}: ${error.message}`);
        result.ok = false;
      } else {
        result.updated++;
      }
    }
  }

  // Auto-resolve: rows currently 'open' or 'in_progress' in DB that are
  // not in pmsKeys. Use pmsKeys (raw) rather than validRows so a
  // malformed-but-present row doesn't false-resolve.
  const toResolve = (existing ?? []).filter(
    (row: { pms_work_order_id: string; status: string }) =>
      (row.status === 'open' || row.status === 'in_progress') && !pmsKeys.has(row.pms_work_order_id),
  ) as Array<{ id: string }>;

  if (toResolve.length > 0) {
    const ids = toResolve.map((r) => r.id);
    const { error } = await supabase
      .from('pms_work_orders_v2')
      .update({ status: 'resolved', resolved_at: now })
      .in('id', ids);
    if (error) {
      result.errors.push(`auto-resolve: ${error.message}`);
      result.ok = false;
    } else {
      result.resolved = toResolve.length;
    }
  }

  return result;
}

// ─── In-house snapshot (atomic, with last-good preservation) ──────────────
//
// One row per property, upserted on every poll. ATOMIC: if validation
// fails on the snapshot fields, we keep the previous last_good values
// and set has_error=true + last_error. UI shows stale-but-correct data
// rather than half-broken numbers (matches scraper/dashboard-pull.js).

export interface SaveInHouseResult {
  ok: boolean;
  wrote: 'fresh' | 'last_good_preserved' | 'error';
  message?: string;
}

export async function saveInHouseSnapshot(
  propertyId: string,
  snapshot: InHouseSnapshotRow,
  context: { expectedRoomCountRange?: [number, number] } = {},
): Promise<SaveInHouseResult> {
  const now = new Date().toISOString();

  // Load previous snapshot for anomaly detection.
  const { data: prev } = await supabase
    .from('pms_in_house_snapshot')
    .select('total_occupied_rooms, total_guests_in_house, total_vacant_clean, total_vacant_dirty, total_ooo, last_good_at')
    .eq('property_id', propertyId)
    .maybeSingle();

  const previousTotalOccupied = (prev?.total_occupied_rooms as number | undefined) ?? undefined;
  const validation = validateInHouseSnapshot(snapshot, {
    previousTotalOccupied,
    expectedRoomCountRange: context.expectedRoomCountRange,
  });
  logValidation(propertyId, 'in_house_snapshot', validation);

  if (!validation.ok) {
    // Last-good preservation: don't overwrite the count fields. Only
    // mark has_error + last_error.
    const { error } = await supabase
      .from('pms_in_house_snapshot')
      .upsert(
        {
          property_id: propertyId,
          has_error: true,
          last_error: validation.errors.join('; '),
          last_error_at: now,
          // captured_at + last_synced_at still get bumped — proves we
          // tried — but the count fields stay at their last good value.
          captured_at: now,
          last_synced_at: now,
          // Don't touch total_* fields here.
        },
        { onConflict: 'property_id' },
      );
    if (error) {
      log.error('persistence: pms_in_house_snapshot error-write failed', { propertyId, err: error });
      return { ok: false, wrote: 'error', message: error.message };
    }
    log.warn('persistence: in-house snapshot validation failed — last good preserved', {
      propertyId,
      errors: validation.errors,
    });
    return { ok: false, wrote: 'last_good_preserved', message: validation.errors.join('; ') };
  }

  const { error } = await supabase
    .from('pms_in_house_snapshot')
    .upsert(
      {
        property_id: propertyId,
        total_guests_in_house: validation.clean.total_guests_in_house ?? null,
        total_occupied_rooms: validation.clean.total_occupied_rooms ?? null,
        total_vacant_clean: validation.clean.total_vacant_clean ?? null,
        total_vacant_dirty: validation.clean.total_vacant_dirty ?? null,
        total_ooo: validation.clean.total_ooo ?? null,
        arrivals_remaining_today: validation.clean.arrivals_remaining_today ?? null,
        departures_remaining_today: validation.clean.departures_remaining_today ?? null,
        captured_at: now,
        last_good_at: now,
        has_error: false,
        last_error: null,
        last_error_at: null,
        raw: snapshot as unknown as Record<string, unknown>,
        last_synced_at: now,
      },
      { onConflict: 'property_id' },
    );

  if (error) {
    log.error('persistence: pms_in_house_snapshot fresh-write failed', { propertyId, err: error });
    return { ok: false, wrote: 'error', message: error.message };
  }

  return { ok: true, wrote: 'fresh' };
}
