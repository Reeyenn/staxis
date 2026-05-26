// ═══════════════════════════════════════════════════════════════════════════
// pms-rooms-writes — server-only writes from manager actions on the
// Rooms tab into the new pms_* schema.
//
// Why this exists:
//   Plan v4 dropped the legacy `rooms` table. Manager tile-cycling
//   actions used to update one row in `rooms`. They now upsert
//   pms_housekeeping_assignments (and, for phantom rooms, also
//   pms_rooms_inventory).
//
//   The browser side (src/lib/db/rooms.ts) used to call supabase
//   directly. With RLS deny-all on pms_*, that won't work — writes go
//   through /api/housekeeping/room-action which calls these helpers.
//
// CUA clobber risk (Codex Critical #1):
//   pms_housekeeping_assignments is the schema-documented "active feed"
//   for HK plan extraction by CUA, with notes that the table is
//   "overwritten on each pull within the same day." In practice as of
//   2026-05-25 the CUA recipe-adapter has NO route writing to
//   pms_housekeeping_assignments — the table is currently Staxis-owned
//   via these helpers, and CUA's planned HK Center extraction has not
//   been wired up. Verified in cua-service/src/recipe-adapter.ts.
//
//   If/when CUA does start writing HK assignments, the upsert here will
//   collide with the CUA upsert. The right next move is one of:
//     (a) Add a Staxis-side overlay table that the merge prefers over
//         CUA values, OR
//     (b) Teach the CUA upsert to COALESCE manager-set fields
//         (started_at, completed_at, status when source='manual').
//   Tracking the issue here so it's visible when the CUA-side wiring
//   ships. Until then: writes are safe.
//
// Trust model:
//   These helpers are server-only and trust their arguments. The API
//   route MUST enforce:
//     - requireSession (manager-facing UI)
//     - userHasPropertyAccess (the user owns the pid they're acting on)
//
// What gets persisted:
//   - status changes → pms_housekeeping_assignments.status / started_at /
//     completed_at, anchored to today's date in America/Chicago.
//   - type changes → pms_housekeeping_assignments.cleaning_type
//     ('departure' or 'stayover').
//   - assignedTo / assignedName → pms_housekeeping_assignments.housekeeper_name
//     (assignedTo resolved to the staff record's name; fails closed if
//     the staffId doesn't belong to the property).
//   - isDnd → pms_housekeeping_assignments.dnd_active
//   - issueNote, dndNote, helpRequested, checklist, photoUrl: NOT
//     PERSISTED. These were Maria-set annotations on the legacy `rooms`
//     table. There's no destination column in the new schema; the helper
//     logs a warn so a future migration adding a `room_annotations`
//     table can pick this up cleanly.
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase-admin';
import type { Room, RoomStatus } from '@/types';
import { log } from './log';
import { todayStr } from './utils';
import {
  reverseMapType,
  parseRoomId,
  composeRoomId,
  normalizeName,
} from './pms-rooms-server';

// Fields the legacy Room type carried that have no destination in the
// new schema. We log when a caller tries to update one so it's discoverable.
const UNSUPPORTED_UPDATE_FIELDS = [
  'issueNote',
  'inspectedBy',
  'inspectedAt',
  'dndNote',
  'helpRequested',
  'checklist',
  'photoUrl',
] as const;

/**
 * Status mapping for writes — legacy RoomStatus → assignment columns.
 * Returns the patch object to merge into the pms_housekeeping_assignments
 * upsert. `null` means "don't change this field."
 */
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
    // No status change — just pass through any explicit timestamps.
    const patch: { started_at?: string | null; completed_at?: string | null } = {};
    if (startedAt !== undefined) patch.started_at = startedAt ? startedAt.toISOString() : null;
    if (completedAt !== undefined) patch.completed_at = completedAt ? completedAt.toISOString() : null;
    return patch;
  }
  // Map the legacy enum to assignment lifecycle.
  if (status === 'in_progress') {
    return {
      status: 'in_progress',
      started_at: (startedAt ?? new Date()).toISOString(),
      completed_at: null,
    };
  }
  if (status === 'clean' || status === 'inspected') {
    // 'inspected' has no direct assignment-side equivalent; treat as
    // completed for write purposes (the supervisor sign-off lives in a
    // different table when that workflow ships).
    return {
      status: 'completed',
      completed_at: (completedAt ?? new Date()).toISOString(),
      // Leave started_at if already set; only stamp it if not.
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

/**
 * Today's date in the app timezone (Chicago / Central). Used when a
 * caller writes against a phantom row without an explicit date.
 *
 * Codex Major #9: previously used UTC, which rolled to "tomorrow" at
 * 7pm Houston time during CDT. A manager marking a 7pm room "cleaning"
 * created a tomorrow-dated assignment instead of today's. Aligning with
 * `todayStr()` (the same helper useTodayStr emits on the client) keeps
 * server defaults in sync with the client's idea of "today."
 */
function todayIsoDate(): string {
  return todayStr();
}

/**
 * Apply a partial Room update server-side. Idempotent: the assignment
 * row is upserted on (property_id, date, room_number).
 *
 * `rid` accepts either the composite "${date}:${room_number}" id this
 * service produces, OR a legacy "phantom-${number}" id for rooms not
 * yet in pms_rooms_inventory. Anything else is rejected.
 */
export async function applyRoomUpdate(
  pid: string,
  rid: string,
  partial: Partial<Room>,
): Promise<void> {
  // Parse the rid → (date, room_number).
  let date: string;
  let roomNumber: string;
  const parsed = parseRoomId(rid);
  if (parsed) {
    ({ date, roomNumber } = parsed);
  } else if (rid.startsWith('phantom-')) {
    roomNumber = rid.slice('phantom-'.length);
    // Phantom rooms have no implicit date — write to today's assignment.
    date = partial.date || todayIsoDate();
  } else {
    // Unknown id shape (e.g. legacy UUID from a stale cache). Log + skip.
    log.warn('[pms-rooms-writes] unrecognized room id — skipping', {
      pid, rid, msg: 'expected "${date}:${room_number}" or "phantom-${number}"',
    });
    return;
  }

  // Log skipped fields without blocking the legitimate-fields write.
  for (const key of UNSUPPORTED_UPDATE_FIELDS) {
    if (partial[key as keyof Room] !== undefined) {
      log.warn('[pms-rooms-writes] field has no destination in pms_* schema — skipping', {
        pid, rid, field: key,
      });
    }
  }

  // Build the assignment patch.
  const statusPatch = statusToAssignmentPatch(
    partial.status,
    partial.startedAt as Date | null | undefined,
    partial.completedAt as Date | null | undefined,
  );
  const cleaningType = partial.type !== undefined ? reverseMapType(partial.type) : undefined;

  // assignedTo (a staff UUID) → look up the staff name to write into housekeeper_name.
  // assignedName takes precedence if both are provided.
  // Codex Major #12 — propagate the staff-lookup error rather than silently
  // writing an unset name when the lookup fails.
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
        // Bad assignedTo (staff not on this property). Reject the write —
        // fail closed rather than silently clear the name and lose the
        // intended assignment.
        throw new Error(
          `applyRoomUpdate: staffId ${partial.assignedTo} does not belong to property ${pid}`,
        );
      }
      housekeeperName = String(staffRow.name);
    }
  }

  // Pre-fetch existing assignment so we can preserve already-set
  // timestamps on idempotent retries (Codex Major #14). A double-tap or
  // network retry of "Mark cleaning" must not bump started_at forward —
  // the original tap's started_at is the canonical value.
  const { data: existingRow } = await supabaseAdmin
    .from('pms_housekeeping_assignments')
    .select('started_at, completed_at, status')
    .eq('property_id', pid)
    .eq('date', date)
    .eq('room_number', roomNumber)
    .maybeSingle();
  const existing = existingRow as
    | { started_at: string | null; completed_at: string | null; status: string | null }
    | null;

  // Preserve existing started_at when the patch is a "still in-progress"
  // update (status didn't change OR explicit started_at not supplied).
  if (
    statusPatch.started_at !== undefined &&
    statusPatch.started_at !== null &&
    existing?.started_at &&
    partial.startedAt === undefined &&
    partial.status === 'in_progress'
  ) {
    statusPatch.started_at = existing.started_at;
  }
  // Same for completed_at — once set, don't bump forward on a "still done"
  // retry unless the caller passed an explicit completedAt.
  if (
    statusPatch.completed_at !== undefined &&
    statusPatch.completed_at !== null &&
    existing?.completed_at &&
    partial.completedAt === undefined &&
    (partial.status === 'clean' || partial.status === 'inspected')
  ) {
    statusPatch.completed_at = existing.completed_at;
  }

  // The upsert payload — only set columns the caller is changing.
  const upsert: Record<string, unknown> = {
    property_id: pid,
    date,
    room_number: roomNumber,
    ...statusPatch,
    ...(cleaningType !== undefined ? { cleaning_type: cleaningType } : {}),
    ...(housekeeperName !== undefined ? { housekeeper_name: housekeeperName || null } : {}),
    ...(partial.isDnd !== undefined ? { dnd_active: Boolean(partial.isDnd) } : {}),
  };

  const { error } = await supabaseAdmin
    .from('pms_housekeeping_assignments')
    .upsert(upsert, { onConflict: 'property_id,date,room_number' });

  if (error) {
    log.error('[pms-rooms-writes] applyRoomUpdate failed', {
      pid, rid, date, roomNumber, msg: error.message,
    });
    throw error;
  }
}

/**
 * Materialize a phantom room — insert (or upsert) into pms_rooms_inventory
 * AND apply the initial assignment update. Returns the composite Room.id
 * (`${date}:${room_number}`) the client can use for subsequent updates.
 *
 * Note: pms_rooms_inventory is normally owned by the CUA. Manual inserts
 * here may be overwritten by the next CUA sync; we log a warn so this is
 * traceable. For limited-service hotels where CUA runs every 30s, the
 * window for clobber is small, but the user-visible behavior is "I added
 * a room → it disappears next sync."
 */
export async function applyRoomAdd(
  pid: string,
  room: Omit<Room, 'id'>,
): Promise<string> {
  const roomNumber = room.number?.trim();
  if (!roomNumber) {
    throw new Error('applyRoomAdd: room.number is required');
  }
  const date = room.date || todayIsoDate();

  // Upsert inventory row — idempotent on (property_id, room_number).
  const { error: invErr } = await supabaseAdmin
    .from('pms_rooms_inventory')
    .upsert(
      {
        property_id: pid,
        room_number: roomNumber,
        room_type: null,
      },
      { onConflict: 'property_id,room_number' },
    );
  if (invErr) {
    log.error('[pms-rooms-writes] applyRoomAdd inventory upsert failed', {
      pid, roomNumber, msg: invErr.message,
    });
    throw invErr;
  }
  log.warn('[pms-rooms-writes] manual inventory insert — CUA may clobber on next sync', {
    pid, roomNumber,
  });

  // Apply the assignment-side state via the same update path.
  const rid = composeRoomId(date, roomNumber);
  await applyRoomUpdate(pid, rid, { ...room });
  return rid;
}

/**
 * Remove a room's *assignment* for a given date. Does NOT delete the
 * inventory row — pms_rooms_inventory is CUA-owned and a hard delete
 * would just re-appear on next sync. If the caller wants the room gone
 * from the housekeeper board, deleting the assignment is the right
 * destructive scope.
 */
export async function applyRoomDelete(pid: string, rid: string): Promise<void> {
  const parsed = parseRoomId(rid);
  if (!parsed) {
    log.warn('[pms-rooms-writes] applyRoomDelete: unrecognized rid', { pid, rid });
    return;
  }
  const { error } = await supabaseAdmin
    .from('pms_housekeeping_assignments')
    .delete()
    .eq('property_id', pid)
    .eq('date', parsed.date)
    .eq('room_number', parsed.roomNumber);
  if (error) {
    log.error('[pms-rooms-writes] applyRoomDelete failed', {
      pid, rid, msg: error.message,
    });
    throw error;
  }
}

/**
 * Batched add — inventory upsert + per-row assignment writes.
 * Returns {requested, inventoryInserted, assignmentsFailed} so the route
 * can surface a non-2xx if anything went wrong (Codex Major #11 — the
 * previous version logged failures and returned success).
 */
export interface BulkRoomAddResult {
  requested: number;
  inventoryInserted: number;
  assignmentsFailed: string[]; // room numbers that failed
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

  log.warn('[pms-rooms-writes] manual bulk inventory insert — CUA may clobber on next sync', {
    pid, count: rooms.length,
  });

  await Promise.all(
    rooms.map(async r => {
      const number = r.number?.trim();
      if (!number) return;
      const rid = composeRoomId(r.date || todayIsoDate(), number);
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

// Re-export normalizeName so call sites importing from a single path stay clean.
export { normalizeName };
