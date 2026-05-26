// ═══════════════════════════════════════════════════════════════════════════
// pms-rooms-writes — server-only writes from manager actions on the
// Rooms tab into the new pms_* schema.
//
// Why this exists:
//   Plan v4 dropped the legacy `rooms` table; manager tile-cycling actions
//   (Mark cleaning / Mark ready / Reset) used to update one row in `rooms`.
//   They now land into TWO tables:
//     - pms_housekeeping_assignments — the per-(date, room) HK plan row.
//       Holds started_at / completed_at / status / dnd_active / cleaning_type
//       / housekeeper_name. Read by the manager Rooms board.
//     - pms_room_status_log — append-only event log of room status changes.
//       Mirrors the manager-set status to a Staxis-owned event so audit /
//       analytics / future CUA-conflict reconciliation can see what the
//       manager did, with source='manual'.
//
//   Two-table writes keep BOTH consumers honest: the assignments row is the
//   canonical "needs cleaning today" signal the merge layer reads first,
//   and the status_log row is the auditable change event the rest of the
//   pipeline (Performance tab, ML, etc.) can consume by-source.
//
// CUA clobber risk:
//   pms_housekeeping_assignments is the schema-documented "active feed"
//   for HK plan extraction by CUA. As of 2026-05-25 cua-service has no
//   route writing to it — verified in cua-service/src/recipe-adapter.ts —
//   so manager writes are safe. When CUA wiring lands, we'll need either
//   (a) a Staxis-side overlay table that merge prefers over CUA, or
//   (b) a CUA upsert that COALESCEs manager-set fields. Issue tracked
//   in the file header so it's visible at that point.
//
//   pms_room_status_log is explicitly multi-source (source check constraint:
//   'cua' | 'manual' | 'scheduled' | 'workflow'), so manual writes don't
//   conflict with CUA writes — both append, the latest row per
//   (property_id, room_number) wins.
//
// Trust model:
//   These helpers are server-only and trust their arguments. The API
//   route (/api/housekeeping/room-action) MUST enforce:
//     - requireSession (manager-facing UI)
//     - userHasPropertyAccess (user owns the pid)
//
// What gets persisted (by field):
//   status, startedAt, completedAt
//     → pms_housekeeping_assignments lifecycle (status / started_at /
//       completed_at, with idempotent timestamp preservation on retries)
//     → pms_room_status_log append (status mapped to PMS enum; source='manual')
//   type (RoomType: checkout/stayover/vacant)
//     → pms_housekeeping_assignments.cleaning_type
//   assignedTo (staff UUID) / assignedName
//     → pms_housekeeping_assignments.housekeeper_name (resolved to staff
//       name when assignedTo is provided; fails closed if not on property)
//   isDnd
//     → pms_housekeeping_assignments.dnd_active
//   issueNote, inspectedBy, inspectedAt, dndNote, helpRequested,
//   checklist, photoUrl
//     → NOT PERSISTED (no destination column; logged + skipped)
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase-admin';
import type { Room, RoomStatus } from '@/types';
import { log } from './log';
import { todayStr } from './utils';
import {
  reverseMapType,
  parseRoomId,
  composeRoomId,
} from './pms-rooms-server';

const UNSUPPORTED_UPDATE_FIELDS = [
  'issueNote',
  'inspectedBy',
  'inspectedAt',
  'dndNote',
  'helpRequested',
  'checklist',
  'photoUrl',
] as const;

// ── Status mapping for writes ──────────────────────────────────────────────
// Two mappings happen on a status change:
//   1. assignment lifecycle (statusToAssignmentPatch): what to write into
//      pms_housekeeping_assignments
//   2. status_log enum (statusToLogValue): what to append into
//      pms_room_status_log as the manual event
//
// status_log enum doesn't have 'in_progress' (a Staxis-side concept; PMS
// only sees the resulting clean/dirty state). For in_progress we DO NOT
// append a status_log row — the in-progress state lives only in the
// assignment row. The status_log gets a row only when the room transitions
// to a PMS-visible state (clean / dirty / inspected).

function statusToAssignmentPatch(
  status: RoomStatus | undefined,
  startedAt: Date | null | undefined,
  completedAt: Date | null | undefined,
): {
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
} {
  if (status === undefined) {
    const patch: { started_at?: string | null; completed_at?: string | null } = {};
    if (startedAt !== undefined) patch.started_at = startedAt ? startedAt.toISOString() : null;
    if (completedAt !== undefined) patch.completed_at = completedAt ? completedAt.toISOString() : null;
    return patch;
  }
  if (status === 'in_progress') {
    return {
      status: 'in_progress',
      started_at: (startedAt ?? new Date()).toISOString(),
      completed_at: null,
    };
  }
  if (status === 'clean' || status === 'inspected') {
    // 'inspected' has no direct assignment-side equivalent; treat as
    // completed for write purposes.
    return {
      status: 'completed',
      completed_at: (completedAt ?? new Date()).toISOString(),
      ...(startedAt !== undefined ? { started_at: startedAt ? startedAt.toISOString() : null } : {}),
    };
  }
  // 'dirty' = reset
  return {
    status: 'not_started',
    started_at: null,
    completed_at: null,
  };
}

// Returns the pms_room_status_log.status value to append for this state
// change, or null if no row should be appended.
//
// Occupancy-aware (Codex Major #3): we look at the room's current
// status_log row to pick the right vacant/occupied prefix. Without this,
// resetting an occupied stayover room to 'dirty' would write 'vacant_dirty'
// and the next merge poll could briefly mis-render until CUA's next pass.
function statusToLogValue(
  status: RoomStatus | undefined,
  currentRawStatus: string | null,
): string | null {
  const isOccupied =
    currentRawStatus === 'occupied' ||
    currentRawStatus === 'occupied_clean' ||
    currentRawStatus === 'occupied_dirty';
  if (status === 'clean') return isOccupied ? 'occupied_clean' : 'vacant_clean';
  if (status === 'dirty') return isOccupied ? 'occupied_dirty' : 'vacant_dirty';
  if (status === 'inspected') return 'inspected';
  // 'in_progress' → no log row. The PMS doesn't see "being cleaned" as a
  // status — just clean or dirty. The assignment row captures it.
  return null;
}

/**
 * Today's date in the app timezone (America/Chicago). Used when a caller
 * writes against a phantom row or update without an explicit date.
 * Aligned with `todayStr()` (the same helper useTodayStr emits on the
 * client) so server defaults match the client's idea of "today."
 */
function todayIsoDate(): string {
  return todayStr();
}

// Helper: given a Room.id (either composite "${date}:${room_number}",
// "phantom-${number}", or a legacy UUID from a stale cache), resolve to
// (date, room_number). For legacy UUIDs we look up the inventory row.
async function resolveRoomKey(
  pid: string,
  rid: string,
  fallbackDate: string,
): Promise<{ date: string; roomNumber: string } | null> {
  const parsed = parseRoomId(rid);
  if (parsed) return parsed;
  if (rid.startsWith('phantom-')) {
    return { date: fallbackDate, roomNumber: rid.slice('phantom-'.length) };
  }
  // UUID lookup: mergePmsRoomsForDate emits Room.id = inv.id, a UUID.
  // The manager Rooms tab is single-date — partial.date OR today is the
  // assignment date.
  const looksUuid = /^[0-9a-f-]{36}$/i.test(rid);
  if (!looksUuid) return null;
  const { data, error } = await supabaseAdmin
    .from('pms_rooms_inventory')
    .select('room_number')
    .eq('id', rid)
    .eq('property_id', pid)
    .maybeSingle();
  if (error) {
    log.error('[pms-rooms-writes] resolveRoomKey inventory lookup failed', {
      pid, rid, msg: error.message,
    });
    return null;
  }
  if (!data) return null;
  return { date: fallbackDate, roomNumber: String(data.room_number) };
}

/**
 * Apply a partial Room update server-side. Writes to BOTH
 * pms_housekeeping_assignments (upsert) AND pms_room_status_log
 * (append, when the new status is a PMS-visible state).
 *
 * Idempotency: pre-fetches the existing assignment row and preserves
 * already-set timestamps on retries (a double-tap of "Mark cleaning"
 * must not bump started_at forward; "Mark ready" must not bump
 * completed_at forward).
 */
export async function applyRoomUpdate(
  pid: string,
  rid: string,
  partial: Partial<Room>,
): Promise<void> {
  const fallbackDate = (partial.date as string | undefined) || todayIsoDate();
  const key = await resolveRoomKey(pid, rid, fallbackDate);
  if (!key) {
    log.warn('[pms-rooms-writes] applyRoomUpdate: unrecognized room id — skipping', {
      pid, rid, msg: 'expected "${date}:${room_number}", "phantom-${number}", or UUID matching pms_rooms_inventory.id',
    });
    return;
  }
  const { date, roomNumber } = key;

  // Log + skip unsupported fields.
  for (const f of UNSUPPORTED_UPDATE_FIELDS) {
    if (partial[f as keyof Room] !== undefined) {
      log.warn('[pms-rooms-writes] field has no destination in pms_* schema — skipping', {
        pid, rid, field: f,
      });
    }
  }

  // Pre-fetch existing assignment + latest status_log row so we can:
  //   - preserve idempotent timestamps on retries (M14 from prior round)
  //   - pick the right vacant/occupied prefix for the status_log append
  //     (Codex Major #3)
  //   - skip no-op writes entirely (Codex Major #1 — narrows the race
  //     window for "two tabs both call mark-cleaning at once")
  const [existingAssignRes, latestStatusRes] = await Promise.allSettled([
    supabaseAdmin
      .from('pms_housekeeping_assignments')
      .select('started_at, completed_at, status, cleaning_type, housekeeper_name, dnd_active')
      .eq('property_id', pid)
      .eq('date', date)
      .eq('room_number', roomNumber)
      .maybeSingle(),
    supabaseAdmin
      .from('pms_room_status_log')
      .select('status')
      .eq('property_id', pid)
      .eq('room_number', roomNumber)
      .order('changed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const existing =
    existingAssignRes.status === 'fulfilled' && !existingAssignRes.value.error
      ? (existingAssignRes.value.data as
          | {
              started_at: string | null;
              completed_at: string | null;
              status: string | null;
              cleaning_type: string | null;
              housekeeper_name: string | null;
              dnd_active: boolean | null;
            }
          | null)
      : null;

  const currentRawStatus =
    latestStatusRes.status === 'fulfilled' && !latestStatusRes.value.error
      ? ((latestStatusRes.value.data as { status?: string } | null)?.status ?? null)
      : null;

  const statusPatch = statusToAssignmentPatch(
    partial.status,
    partial.startedAt as Date | null | undefined,
    partial.completedAt as Date | null | undefined,
  );

  // Preserve already-set started_at on a redundant in_progress write.
  if (
    statusPatch.started_at &&
    existing?.started_at &&
    partial.startedAt === undefined &&
    partial.status === 'in_progress'
  ) {
    statusPatch.started_at = existing.started_at;
  }
  // Same for completed_at on a redundant clean/inspected write.
  if (
    statusPatch.completed_at &&
    existing?.completed_at &&
    partial.completedAt === undefined &&
    (partial.status === 'clean' || partial.status === 'inspected')
  ) {
    statusPatch.completed_at = existing.completed_at;
  }

  // Resolve assignedTo → housekeeper_name. Fail closed if the staff is
  // not on this property — silently clearing the name would lose the
  // intended assignment.
  let housekeeperName: string | undefined;
  if (partial.assignedName !== undefined) {
    housekeeperName = partial.assignedName ?? undefined;
  } else if (partial.assignedTo !== undefined) {
    if (partial.assignedTo === null || partial.assignedTo === '') {
      housekeeperName = '';
    } else {
      const { data: staffRow, error: staffErr } = await supabaseAdmin
        .from('staff')
        .select('name')
        .eq('id', partial.assignedTo)
        .eq('property_id', pid)
        .maybeSingle();
      if (staffErr) {
        log.error('[pms-rooms-writes] staff lookup failed during update', {
          pid, rid, assignedTo: partial.assignedTo, msg: staffErr.message,
        });
        throw staffErr;
      }
      if (!staffRow) {
        throw new Error(
          `applyRoomUpdate: staffId ${partial.assignedTo} does not belong to property ${pid}`,
        );
      }
      housekeeperName = String(staffRow.name);
    }
  }

  const cleaningType = partial.type !== undefined ? reverseMapType(partial.type) : undefined;

  // ── No-op pre-check (Codex Major #1) ─────────────────────────────────
  // If the existing assignment row already matches every requested field,
  // skip both writes entirely. This eliminates the race window for the
  // most common double-tap case ("Mark cleaning" tapped twice in quick
  // succession) — the second call detects "already in_progress with this
  // started_at" and exits cleanly. The first writer's timestamp wins.
  const isNoOpUpdate = (() => {
    if (!existing) return false;
    if (statusPatch.status !== undefined && statusPatch.status !== existing.status) return false;
    if (statusPatch.started_at !== undefined && statusPatch.started_at !== existing.started_at) return false;
    if (statusPatch.completed_at !== undefined && statusPatch.completed_at !== existing.completed_at) return false;
    if (cleaningType !== undefined && cleaningType !== existing.cleaning_type) return false;
    if (housekeeperName !== undefined && (housekeeperName || null) !== existing.housekeeper_name) return false;
    if (partial.isDnd !== undefined && Boolean(partial.isDnd) !== Boolean(existing.dnd_active)) return false;
    return true;
  })();
  if (isNoOpUpdate) {
    log.warn('[pms-rooms-writes] applyRoomUpdate: no-op (already matches existing) — skipping both writes', {
      pid, rid, date, roomNumber,
    });
    return;
  }

  // ── Write 1: upsert pms_housekeeping_assignments ──────────────────────
  const upsert: Record<string, unknown> = {
    property_id: pid,
    date,
    room_number: roomNumber,
    ...statusPatch,
    ...(cleaningType !== undefined ? { cleaning_type: cleaningType } : {}),
    ...(housekeeperName !== undefined ? { housekeeper_name: housekeeperName || null } : {}),
    ...(partial.isDnd !== undefined ? { dnd_active: Boolean(partial.isDnd) } : {}),
  };

  const { error: assignErr } = await supabaseAdmin
    .from('pms_housekeeping_assignments')
    .upsert(upsert, { onConflict: 'property_id,date,room_number' });
  if (assignErr) {
    log.error('[pms-rooms-writes] applyRoomUpdate assignments upsert failed', {
      pid, rid, date, roomNumber, msg: assignErr.message,
    });
    throw assignErr;
  }

  // ── Write 2: append pms_room_status_log when status flips PMS-visible ──
  // Codex Major #3: pick the vacant/occupied prefix from the room's
  // current status, so resetting an occupied stayover to "dirty" writes
  // 'occupied_dirty' rather than the misleading 'vacant_dirty'.
  const logValue = statusToLogValue(partial.status, currentRawStatus);
  if (logValue !== null && logValue !== currentRawStatus) {
    const { error: logInsertErr } = await supabaseAdmin
      .from('pms_room_status_log')
      .insert({
        property_id: pid,
        room_number: roomNumber,
        status: logValue,
        source: 'manual',
        changed_at: new Date().toISOString(),
      });
    if (logInsertErr) {
      // Don't roll back the assignment upsert — the assignment is the
      // authoritative read source. status_log is the supplementary audit
      // trail. A failure here downgrades to "audit gap" not "tap appears
      // broken." log.error routes to Sentry so the gap is discoverable.
      log.error('[pms-rooms-writes] applyRoomUpdate status_log insert failed (assignment write succeeded)', {
        pid, rid, date, roomNumber, logValue, msg: logInsertErr.message,
      });
    }
  }
}

/**
 * Materialize a phantom room — insert (or upsert) into pms_rooms_inventory
 * AND apply the initial assignment update. Returns the composite Room.id
 * (`${date}:${room_number}`) the client can use for subsequent updates.
 *
 * CUA clobber warning: pms_rooms_inventory is the schema-documented
 * CUA-owned table. As of 2026-05-25 CUA does upsert into it (via
 * recipe-adapter's getRoomLayout route). A manually-added room WILL be
 * preserved if its room_number matches a real PMS room (the upsert is
 * idempotent on (property_id, room_number)). A truly synthetic room
 * (not in the PMS) will persist as long as the upsert keys don't
 * collide, but the next sync's "rooms that disappeared from the PMS"
 * pass — if/when that lands — could clean it up.
 */
export async function applyRoomAdd(
  pid: string,
  room: Omit<Room, 'id'>,
): Promise<string> {
  const roomNumber = room.number?.trim();
  if (!roomNumber) {
    throw new Error('applyRoomAdd: room.number is required');
  }
  const date = (room.date as string | undefined) || todayIsoDate();

  // Codex Major #5: check whether the inventory row already exists BEFORE
  // we upsert, so we know whether a follow-up failure leaves a phantom
  // inventory row (which we then clean up). If the row already existed
  // pre-call we don't touch it on failure — could be a PMS-extracted row.
  const { data: existingInv } = await supabaseAdmin
    .from('pms_rooms_inventory')
    .select('id')
    .eq('property_id', pid)
    .eq('room_number', roomNumber)
    .maybeSingle();
  const wePreExisted = Boolean(existingInv);

  const { error: invErr } = await supabaseAdmin
    .from('pms_rooms_inventory')
    .upsert(
      { property_id: pid, room_number: roomNumber, room_type: null },
      { onConflict: 'property_id,room_number' },
    );
  if (invErr) {
    log.error('[pms-rooms-writes] applyRoomAdd inventory upsert failed', {
      pid, roomNumber, msg: invErr.message,
    });
    throw invErr;
  }
  if (!wePreExisted) {
    log.warn('[pms-rooms-writes] manual inventory insert — CUA upsert preserves on next sync if room_number matches PMS', {
      pid, roomNumber,
    });
  }

  const rid = composeRoomId(date, roomNumber);
  try {
    await applyRoomUpdate(pid, rid, { ...room });
    return rid;
  } catch (err) {
    // Assignment write failed. If we just created the inventory row,
    // clean it up so a failed add doesn't leave a phantom row that
    // shows up on the manager board with no state. Pre-existing rows
    // stay untouched (they may belong to CUA / a real PMS room).
    if (!wePreExisted) {
      const { error: cleanupErr } = await supabaseAdmin
        .from('pms_rooms_inventory')
        .delete()
        .eq('property_id', pid)
        .eq('room_number', roomNumber);
      if (cleanupErr) {
        log.error('[pms-rooms-writes] applyRoomAdd cleanup of phantom inventory row failed', {
          pid, roomNumber, msg: cleanupErr.message,
        });
      }
    }
    throw err;
  }
}

/**
 * Remove a room's assignment for a given date. Does NOT delete the
 * inventory row.
 *
 * Semantic note (Codex Major #9): pms_rooms_inventory is the canonical
 * "rooms this property has" list, owned by the CUA. Hard-deleting an
 * inventory row would just re-appear on the next CUA sync if the room
 * is still in the PMS, so a hard delete makes no sense for PMS rooms.
 * For manually-added rooms (no PMS counterpart) the inventory row will
 * persist after this call — the room reappears on mergePmsRoomsForDate
 * polls as an unassigned tile until the manager re-adds an assignment.
 *
 * In practice deleteRoom has NO callers in the current codebase (the
 * RoomsTab UI has no delete button). It exists for API completeness;
 * if a future UI surface needs hard-delete semantics, it should land
 * an inventory-aware variant.
 */
export async function applyRoomDelete(pid: string, rid: string): Promise<void> {
  const key = await resolveRoomKey(pid, rid, todayIsoDate());
  if (!key) {
    log.warn('[pms-rooms-writes] applyRoomDelete: unrecognized rid', { pid, rid });
    return;
  }
  const { error } = await supabaseAdmin
    .from('pms_housekeeping_assignments')
    .delete()
    .eq('property_id', pid)
    .eq('date', key.date)
    .eq('room_number', key.roomNumber);
  if (error) {
    log.error('[pms-rooms-writes] applyRoomDelete failed', {
      pid, rid, msg: error.message,
    });
    throw error;
  }
}

/**
 * Batched add — inventory upsert + per-row assignment writes.
 * Returns a result object so the API route can surface partial failure
 * instead of silently logging-and-success'ing.
 */
export interface BulkRoomAddResult {
  requested: number;
  inventoryInserted: number;
  assignmentsFailed: string[];
}

export async function applyBulkRoomAdd(
  pid: string,
  rooms: Omit<Room, 'id'>[],
): Promise<BulkRoomAddResult> {
  const result: BulkRoomAddResult = {
    requested: rooms.length,
    inventoryInserted: 0,
    assignmentsFailed: [],
  };
  if (rooms.length === 0) return result;

  const inventoryRows = rooms
    .map(r => ({
      property_id: pid,
      room_number: r.number?.trim(),
      room_type: null,
    }))
    .filter(r => r.room_number);

  const { error: invErr } = await supabaseAdmin
    .from('pms_rooms_inventory')
    .upsert(inventoryRows, { onConflict: 'property_id,room_number' });
  if (invErr) {
    log.error('[pms-rooms-writes] applyBulkRoomAdd inventory upsert failed', {
      pid, count: rooms.length, msg: invErr.message,
    });
    throw invErr;
  }
  result.inventoryInserted = inventoryRows.length;

  log.warn('[pms-rooms-writes] manual bulk inventory insert', {
    pid, count: rooms.length,
  });

  await Promise.all(
    rooms.map(async r => {
      const number = r.number?.trim();
      if (!number) return;
      const date = (r.date as string | undefined) || todayIsoDate();
      const rid = composeRoomId(date, number);
      try {
        await applyRoomUpdate(pid, rid, { ...r });
      } catch (err) {
        log.error('[pms-rooms-writes] applyBulkRoomAdd row assignment failed', {
          pid, rid, msg: (err as { message?: string }).message ?? String(err),
        });
        result.assignmentsFailed.push(number);
      }
    }),
  );

  return result;
}
