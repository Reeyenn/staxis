// ═══════════════════════════════════════════════════════════════════════════
// pms-rooms-writes — server-only writes from housekeeper, agent and
// inspection actions.
//
// Where the writes go, and why (migration 0355):
//   Room work state used to be written onto pms_housekeeping_assignments,
//   next to the PMS housekeeping report. That mixed two owners on one row:
//   the report said who was scheduled and what kind of clean it was; Staxis
//   said whether it had been started, paused, noted or inspected. Whoever
//   wrote last won.
//
//   The two are now separate tables and this file writes only the Staxis one:
//     - room_work — the per-(date, room) record of what OUR people did.
//       Status, timestamps, notes, DND-as-observed, and the assigned staff
//       member by id. No report can touch it; those columns are not on the
//       table reports write.
//     - pms_room_status_log — append-only event log of room status changes,
//       so audit / analytics / reconciliation can see what a human did, with
//       source='manual'.
//
//   pms_housekeeping_assignments is now READ-ONLY from the app. It carries a
//   NOT NULL ingest_run_id (migration 0341): every row has to name the report
//   that produced it, and a housekeeper's tap has no report to name.
//
// Trust model:
//   These helpers are server-only and trust their arguments. Every caller
//   (/api/housekeeper/room-action, the agent room tools, the inspection
//   correction loop) MUST enforce its own auth before calling in:
//     - an authenticated session or a validated public-link capability
//     - property access (the caller owns the pid)
//
// What gets persisted (by field):
//   status, startedAt, completedAt
//     → room_work lifecycle (status / started_at / completed_at, with
//       idempotent timestamp preservation on retries)
//     → pms_room_status_log append (status mapped to PMS enum; source='manual')
//   assignedTo (staff UUID)
//     → room_work.assigned_staff_id + assigned_source='manager'. Fails closed
//       if the staff member is not on this property.
//   isDnd
//     → room_work.dnd_active (Staxis's own observation; the merge layer
//       prefers it over the PMS-reported value)
//   issueNote, dndNote, helpRequested, inspectedBy, inspectedAt,
//   managerNotes, housekeeperNote, isRush, rushDueBy, markedForInspectionAt
//     → room_work columns. Note/rush *_at metadata the Room type doesn't
//       carry is auto-stamped here; callers needing exact metadata
//       (manager_notes_by_account_id, rush_set_by) write via
//       writeWorkflowFields (housekeeper-workflow/workflow-store).
//   type (RoomType), assignedName
//     → NOT PERSISTED. Both are PMS-reported facts that live on the mirror
//       (cleaning_type, housekeeper_name) and the app does not write the
//       mirror. `type` had no caller left after the manager Rooms tab was
//       deleted; assignedName is superseded by assignedTo, which links a real
//       person instead of hoping two systems spell them the same way.
//   checklist, photoUrl
//     → NOT PERSISTED (legacy unused; logged + skipped)
// ═══════════════════════════════════════════════════════════════════════════

import { supabaseAdmin } from './supabase-admin';
import { checkAndIncrementRateLimit } from './api-ratelimit';
import type { Room, RoomStatus } from '@/types';
import { log } from './log';
import { todayStr } from './utils';
import { parseRoomId } from './pms-rooms-server';
import { recordStaffAlias } from './pms/dimension-values';

// Room fields with no destination on the Staxis side of the split.
// `type` and `assignedName` are PMS-reported and live on the mirror, which the
// app no longer writes (0355). checklist / photoUrl are legacy-unused.
const UNSUPPORTED_UPDATE_FIELDS = [
  'checklist',
  'photoUrl',
  'type',
  'assignedName',
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

// Coerce a Date | ISO-string | null | undefined into an ISO string (or null).
//
// LOAD-BEARING: the browser serializes Date fields to JSON strings over the
// wire (JSON has no Date type), so partial.startedAt / partial.completedAt
// arrive at this server module as STRINGS, not Date objects — despite the
// `as Date` casts at the call site. Calling .toISOString() directly on a
// string throws "TypeError: ...toISOString is not a function", which 500'd
// the whole save. That was the (now-removed) manager Rooms tab's "dirty rooms
// never go clean" bug: the clean path sends completedAt and hit the throw;
// the dirty path writes completed_at: null (no .toISOString() call) and
// worked. new Date()
// accepts both a Date and an ISO string, so this normalizes defensively.
function toIso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function statusToAssignmentPatch(
  status: RoomStatus | undefined,
  startedAt: Date | string | null | undefined,
  completedAt: Date | string | null | undefined,
): {
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
} {
  if (status === undefined) {
    const patch: { started_at?: string | null; completed_at?: string | null } = {};
    if (startedAt !== undefined) patch.started_at = toIso(startedAt);
    if (completedAt !== undefined) patch.completed_at = toIso(completedAt);
    return patch;
  }
  if (status === 'in_progress') {
    return {
      status: 'in_progress',
      started_at: toIso(startedAt) ?? new Date().toISOString(),
      completed_at: null,
    };
  }
  if (status === 'clean' || status === 'inspected') {
    // 'inspected' has no direct assignment-side equivalent; treat as
    // completed for write purposes.
    return {
      status: 'completed',
      completed_at: toIso(completedAt) ?? new Date().toISOString(),
      ...(startedAt !== undefined ? { started_at: toIso(startedAt) } : {}),
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
      .from('room_work')
      .select('started_at, completed_at, status, assigned_staff_id, dnd_active')
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
              assigned_staff_id: string | null;
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
    partial.startedAt as Date | string | null | undefined,
    partial.completedAt as Date | string | null | undefined,
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

  // Resolve assignedTo → room_work.assigned_staff_id. The database enforces
  // that the id belongs to this property (composite FK to staff), but we check
  // here too so the caller gets a clear error instead of a constraint message.
  let assignedStaffId: string | null | undefined;
  if (partial.assignedTo !== undefined) {
    if (partial.assignedTo === null || partial.assignedTo === '') {
      assignedStaffId = null;
    } else {
      const { data: staffRow, error: staffErr } = await supabaseAdmin
        .from('staff')
        .select('id, name')
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
      assignedStaffId = String(staffRow.id);
      // A human just said this name means this person. Record it, so the next
      // report that prints the same name resolves without guessing. Only
      // human decisions land in staff_aliases — never an inferred match.
      if (staffRow.name) {
        await recordStaffAlias(pid, String(staffRow.name), assignedStaffId, 'manager');
      }
    }
  }

  // Workflow-state fields (migrations 0269 + 0270) that previously had no
  // pms_* home and were logged-and-skipped. Map the Room-shaped fields onto
  // the assignment columns. Note/rush *_at metadata the Room type doesn't
  // carry is auto-stamped here; callers needing exact metadata
  // (manager_notes_by_account_id, rush_set_by) write via writeWorkflowFields.
  const nowIso = new Date().toISOString();
  const workflowPatch: Record<string, unknown> = {};
  if (partial.issueNote !== undefined) workflowPatch.issue_note = partial.issueNote ?? null;
  if (partial.dndNote !== undefined) workflowPatch.dnd_note = partial.dndNote ?? null;
  if (partial.helpRequested !== undefined) workflowPatch.help_requested = Boolean(partial.helpRequested);
  if (partial.inspectedBy !== undefined) workflowPatch.inspected_by = partial.inspectedBy ?? null;
  if (partial.inspectedAt !== undefined) {
    workflowPatch.inspected_at = toIso(partial.inspectedAt as Date | string | null);
  }
  if (partial.managerNotes !== undefined) {
    workflowPatch.manager_notes = partial.managerNotes ?? null;
    workflowPatch.manager_notes_at = partial.managerNotes ? nowIso : null;
  }
  if (partial.housekeeperNote !== undefined) {
    workflowPatch.housekeeper_note = partial.housekeeperNote ?? null;
    workflowPatch.housekeeper_note_at = partial.housekeeperNote ? nowIso : null;
  }
  if (partial.isRush !== undefined) {
    workflowPatch.is_rush = Boolean(partial.isRush);
    workflowPatch.rush_set_at = partial.isRush ? nowIso : null;
    if (!partial.isRush) workflowPatch.rush_due_by = null;
  }
  if (partial.rushDueBy !== undefined) {
    workflowPatch.rush_due_by = toIso(partial.rushDueBy as Date | string | null);
  }
  if (partial.markedForInspectionAt !== undefined) {
    workflowPatch.marked_for_inspection_at = toIso(partial.markedForInspectionAt as Date | string | null);
  }
  // Resetting a room back to dirty (not_started) invalidates any prior
  // inspection sign-off. Clear inspected_at/inspected_by here so a later
  // re-clean doesn't make deriveStatus re-derive 'inspected' from a stale
  // inspected_at (a false green sign-off that also skips re-inspection).
  // Don't clobber an explicit inspected value passed in the same update.
  if (statusPatch.status === 'not_started') {
    if (partial.inspectedAt === undefined) workflowPatch.inspected_at = null;
    if (partial.inspectedBy === undefined) workflowPatch.inspected_by = null;
  }
  const hasWorkflowField = Object.keys(workflowPatch).length > 0;

  // ── No-op pre-check (Codex Major #1) ─────────────────────────────────
  // If the existing assignment row already matches every requested
  // lifecycle field, skip both writes. Forced off when a workflow field is
  // present — its prior value isn't in the cheap pre-fetch, so we can't
  // prove it's a no-op; note/rush/flag updates must always land.
  const isNoOpUpdate = (() => {
    if (!existing) return false;
    if (hasWorkflowField) return false;
    if (statusPatch.status !== undefined && statusPatch.status !== existing.status) return false;
    if (statusPatch.started_at !== undefined && statusPatch.started_at !== existing.started_at) return false;
    if (statusPatch.completed_at !== undefined && statusPatch.completed_at !== existing.completed_at) return false;
    if (assignedStaffId !== undefined && assignedStaffId !== existing.assigned_staff_id) return false;
    if (partial.isDnd !== undefined && Boolean(partial.isDnd) !== Boolean(existing.dnd_active)) return false;
    return true;
  })();
  if (isNoOpUpdate) {
    log.warn('[pms-rooms-writes] applyRoomUpdate: no-op (already matches existing) — skipping both writes', {
      pid, rid, date, roomNumber,
    });
    return;
  }

  // ── Write 1: persist to room_work ─────────────────────────────────────
  // Atomic conditional-update guard (replaces the read-then-upsert TOCTOU
  // race). When the row already exists AND this is a status transition,
  // UPDATE only if the status is still what we read (optimistic
  // concurrency) — two devices flipping the same room can't both win, and
  // the loser suppresses its now-stale status_log append. Pure-field
  // updates (notes/rush/flags, no status change) and the insert-if-absent
  // path stay last-writer-wins on the (property_id, date, room_number) key.
  const assignmentPatch: Record<string, unknown> = {
    ...statusPatch,
    // assigned_source is set alongside the id (and cleared with it) because
    // room_work_assigned_source_chk requires an assignment to say how it was
    // decided. This path is always a human or the agent acting for one.
    ...(assignedStaffId !== undefined
      ? { assigned_staff_id: assignedStaffId, assigned_source: assignedStaffId ? 'manager' : null }
      : {}),
    ...(partial.isDnd !== undefined ? { dnd_active: Boolean(partial.isDnd) } : {}),
    ...workflowPatch,
  };

  let statusRaceLost = false;
  if (existing && statusPatch.status !== undefined) {
    let q = supabaseAdmin
      .from('room_work')
      .update(assignmentPatch)
      .eq('property_id', pid)
      .eq('date', date)
      .eq('room_number', roomNumber);
    // Guard on the status we read — null-safe (PostgREST .eq(null) matches
    // nothing; use .is for a null prior status).
    q = existing.status === null ? q.is('status', null) : q.eq('status', existing.status);
    const { data: updatedRows, error: updErr } = await q.select('room_number');
    if (updErr) {
      log.error('[pms-rooms-writes] applyRoomUpdate conditional update failed', {
        pid, rid, date, roomNumber, msg: updErr.message,
      });
      throw updErr;
    }
    if (!updatedRows || updatedRows.length === 0) {
      // Lost the optimistic-concurrency race: another writer moved this
      // room's status since our read. Don't append a stale status_log row.
      statusRaceLost = true;
      log.warn('[pms-rooms-writes] applyRoomUpdate: status changed concurrently — skipping (race lost)', {
        pid, rid, date, roomNumber, expected: existing.status, target: statusPatch.status,
      });
    }
  } else {
    // Insert-if-absent (or pure-field update on an existing row). Note: a
    // pure-field write (assignedTo / notes / rush) on a room that has an
    // inventory row but NO work row for `date` MATERIALIZES the row with
    // the table's default status 'not_started' → the merge derives 'dirty'. For
    // assign_room that's the intended signal (assigning a room puts it on the
    // HK plan = needs cleaning); callers that must NOT create a tile (e.g.
    // front-desk rush) deliberately UPDATE-only at the route layer instead
    // of calling applyRoomUpdate.
    const { error: assignErr } = await supabaseAdmin
      .from('room_work')
      .upsert(
        { property_id: pid, date, room_number: roomNumber, ...assignmentPatch },
        { onConflict: 'property_id,date,room_number' },
      );
    if (assignErr) {
      log.error('[pms-rooms-writes] applyRoomUpdate room_work upsert failed', {
        pid, rid, date, roomNumber, msg: assignErr.message,
      });
      throw assignErr;
    }
  }

  // ── Write 2: append pms_room_status_log when status flips PMS-visible ──
  // Codex Major #3: pick the vacant/occupied prefix from the room's
  // current status, so resetting an occupied stayover to "dirty" writes
  // 'occupied_dirty' rather than the misleading 'vacant_dirty'.
  const logValue = statusToLogValue(partial.status, currentRawStatus);
  if (!statusRaceLost && logValue !== null && logValue !== currentRawStatus) {
    // Phase 3: append the manual status row AND — when write-back is enabled
    // for this property — enqueue a robot job to push it into the real PMS,
    // atomically (staxis_enqueue_pms_write). We read the flag first so we only
    // rate-limit (and count) when a push would actually happen. Fail-closed:
    // if the limiter errs, allowEnqueue stays false — the mirror still updates,
    // the PMS push is just skipped (reconcilable on the next change).
    let allowEnqueue = false;
    try {
      const { data: wbRow } = await supabaseAdmin
        .from('properties')
        .select('pms_writeback_enabled')
        .eq('id', pid)
        .maybeSingle();
      if (wbRow?.pms_writeback_enabled) {
        const rl = await checkAndIncrementRateLimit('pms-writeback-enqueue', pid);
        allowEnqueue = rl.allowed;
        if (!rl.allowed) {
          log.warn('[pms-rooms-writes] pms-writeback enqueue rate-limited; mirror updated, PMS push skipped this time', {
            pid, roomNumber,
          });
        }
      }
    } catch (e) {
      log.warn('[pms-rooms-writes] pms-writeback gate check failed; PMS push skipped (mirror still updates)', {
        pid, roomNumber, msg: (e as Error).message,
      });
    }

    const { error: logInsertErr } = await supabaseAdmin.rpc('staxis_enqueue_pms_write', {
      p_property_id: pid,
      p_room_number: roomNumber,
      p_status: logValue,
      p_changed_by: null,
      p_action_key: 'room_status',
      p_payload: { target_status: logValue },
      p_allow_enqueue: allowEnqueue,
    });
    if (logInsertErr) {
      // Don't roll back the assignment upsert — the assignment is the
      // authoritative read source. status_log is the supplementary audit
      // trail. A failure here downgrades to "audit gap" not "tap appears
      // broken." log.error routes to Sentry so the gap is discoverable.
      log.error('[pms-rooms-writes] applyRoomUpdate enqueue RPC failed (assignment write succeeded)', {
        pid, rid, date, roomNumber, logValue, msg: logInsertErr.message,
      });
    }
  }
}
