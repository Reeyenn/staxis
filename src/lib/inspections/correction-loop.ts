/**
 * Correction loop — fail handling and re-check chaining.
 *
 * Lifecycle:
 *   1. Inspector marks inspection result=fail with failed_items[].
 *   2. completeFailedInspection() updates inspections row AND writes
 *      a correction notice on the linked room (rooms.issue_note +
 *      status='dirty') so the housekeeper sees it the next time her
 *      page renders. Optionally links the cleaning_task back to
 *      'correction_pending' status.
 *   3. Housekeeper re-cleans → existing /api/housekeeper/room-action
 *      flips rooms.status='clean' and clears issue_note. (We don't
 *      touch that route — it's owned by the housekeeper flow.)
 *   4. Inspector loads the queue; getReadyForRecheck() picks up rooms
 *      where the last inspection failed AND the room has since been
 *      re-cleaned (completed_at > inspection.completed_at).
 *   5. Inspector starts a re-inspection; new inspections row has
 *      parent_inspection_id set; on fail/pass the loop repeats.
 *
 * Escalation:
 *   countConsecutiveFails walks the parent chain. When the count
 *   reaches ESCALATION_THRESHOLD on the new inspection being marked
 *   fail, escalated=true and the manager sees it red-flagged.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  completeInspection,
  countConsecutiveFails,
  fromInspectionRow,
  getInspectionById,
  linkRecheck,
} from '@/lib/db/inspections';
import type {
  Inspection,
  InspectionFailedItem,
} from '@/types/inspections';
import { ESCALATION_THRESHOLD } from '@/types/inspections';
import { applyRoomUpdate } from '@/lib/pms-rooms-writes';
import { parseRoomId, composeRoomId } from '@/lib/pms-rooms-server';

/**
 * Resolve the pms_* composite room id ("${date}:${roomNumber}") for an
 * inspection's room. roomId may already be the composite (housekeeper
 * redesign) — use it when it parses; otherwise rebuild from roomNumber +
 * the inspection's completion/start date. Returns null when neither yields
 * a valid (date, roomNumber) pair.
 */
function inspectionRoomRid(inspection: Inspection): string | null {
  if (inspection.roomId && parseRoomId(inspection.roomId)) return inspection.roomId;
  const date = (inspection.completedAt ?? inspection.startedAt ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !inspection.roomNumber) return null;
  return composeRoomId(date, inspection.roomNumber);
}

export interface CompleteInspectionInput {
  inspectionId: string;
  result: 'pass' | 'fail';
  failedItems: InspectionFailedItem[];
  passedItems: string[];
  notes: string | null;
  /** Override the escalation threshold for tests / per-property config. */
  escalationThreshold?: number;
}

export interface CompleteInspectionResult {
  inspection: Inspection;
  correctionNoticeSent: boolean;
  escalated: boolean;
}

/**
 * Marks an in-progress inspection as pass or fail and runs the side-effect
 * cascade: room status update, correction notice (on fail), parent-chain
 * linking (when this is itself a re-check), escalation flag (after N fails).
 *
 * Throws on:
 *  - inspection not found
 *  - inspection already completed
 *  - DB write errors
 */
export async function finalizeInspection(
  input: CompleteInspectionInput,
): Promise<CompleteInspectionResult> {
  const threshold = input.escalationThreshold ?? ESCALATION_THRESHOLD;
  const before = await getInspectionById(input.inspectionId);
  if (!before) throw new Error(`inspection ${input.inspectionId} not found`);
  if (before.result !== 'in_progress') {
    throw new Error(`inspection ${input.inspectionId} already finalized as ${before.result}`);
  }

  // Decide escalation. Only fails escalate, and only when there's already
  // a chain of failed inspections preceding this one. The current
  // inspection counts toward the threshold — so threshold=3 means
  // "two prior fails + this fail = escalate".
  let escalated = false;
  let escalationReason: string | null = null;
  if (input.result === 'fail' && before.parentInspectionId) {
    // Codex M7: scope the chain walk to this property + room so a
    // malformed parent link can't pull failures from another property
    // into the escalation count.
    const priorFails = await countConsecutiveFails({
      parentId: before.parentInspectionId,
      propertyId: before.propertyId,
      roomNumber: before.roomNumber,
    });
    if (priorFails + 1 >= threshold) {
      escalated = true;
      escalationReason = `Failed ${priorFails + 1} consecutive inspections on room ${before.roomNumber}`;
    }
  }

  // 1. Atomic finalize via RPC. complete_inspection_atomic (migration
  //    0225) wraps the inspections row update + rooms + cleaning_tasks
  //    + parent-link in one transaction. If the RPC succeeds, every
  //    side-effect lands atomically. If it fails (DB error, migration
  //    not applied yet, etc.) we fall back to the non-atomic legacy
  //    path so the workflow stays online during a rollout.
  const correctionNoticeSentAt: string | null =
    input.result === 'fail' ? new Date().toISOString() : null;
  const correctionNote: string | null =
    input.result === 'fail' ? buildCorrectionNote(input.failedItems) : null;

  const atomic = await tryAtomicFinalize({
    inspectionId: input.inspectionId,
    propertyId: before.propertyId,
    result: input.result,
    failedItems: input.failedItems,
    passedItems: input.passedItems,
    notes: input.notes,
    escalated,
    escalationReason,
    correctionNoticeSentAt,
    correctionNote,
  });

  if (atomic.ok) {
    return {
      inspection: atomic.inspection,
      correctionNoticeSent: input.result === 'fail',
      escalated,
    };
  }

  // Codex M6 follow-up — before running the legacy path, re-fetch the
  // row. If the RPC actually committed but the HTTP response was lost
  // (network blip / gateway timeout), the inspection is already in its
  // final state. Running completeInspection now would fail the
  // result='in_progress' guard and surface a spurious error to the UI;
  // the housekeeper retries and the retry fails the same way. Instead,
  // detect the "already-finalized to the requested result" case and
  // return as if the RPC succeeded.
  const refetched = await getInspectionById(input.inspectionId);
  if (refetched && refetched.result === input.result) {
    log.info('[inspections.finalize] RPC committed but response lost — returning existing finalized row', {
      inspectionId: input.inspectionId,
      result: refetched.result,
      err: atomic.err,
    });
    return {
      inspection: refetched,
      correctionNoticeSent: input.result === 'fail',
      escalated: refetched.escalated,
    };
  }
  if (refetched && refetched.result !== 'in_progress') {
    // Row is finalized but NOT to the requested result. That's a real
    // conflict — surface it.
    throw new Error(
      `inspection ${input.inspectionId} was finalized as ${refetched.result}, not the requested ${input.result}`,
    );
  }

  // Legacy non-atomic path. Only reached when the RPC genuinely failed
  // AND the row is still in_progress. Visible logging on every
  // side-effect failure is preserved from the earlier C1 fix.
  log.warn('[inspections.finalize] atomic RPC unavailable, falling back to legacy path', {
    inspectionId: input.inspectionId,
    err: atomic.err,
  });

  const finalized = await completeInspection({
    id: input.inspectionId,
    result: input.result,
    failedItems: input.failedItems,
    passedItems: input.passedItems,
    notes: input.notes,
    escalated,
    escalationReason,
    correctionNoticeSentAt,
  });

  if (before.parentInspectionId) {
    try {
      await linkRecheck(before.parentInspectionId, finalized.id);
    } catch {
      // Non-fatal — chain reconstructible via parent_inspection_id.
    }
  }

  if (input.result === 'pass') {
    await applyPassSideEffects(finalized);
  } else {
    await applyFailSideEffects(finalized);
  }

  return {
    inspection: finalized,
    correctionNoticeSent: input.result === 'fail',
    escalated,
  };
}

interface TryAtomicArgs {
  inspectionId: string;
  propertyId: string;
  result: 'pass' | 'fail';
  failedItems: InspectionFailedItem[];
  passedItems: string[];
  notes: string | null;
  escalated: boolean;
  escalationReason: string | null;
  correctionNoticeSentAt: string | null;
  correctionNote: string | null;
}

type AtomicOutcome =
  | { ok: true; inspection: Inspection }
  | { ok: false; err: string };

/**
 * Wrap the RPC call. Distinguishes between:
 *  - already-finalized / not-found / bad-result / property-mismatch
 *    → re-throws (caller's bug or data-integrity issue)
 *  - any other failure → returns ok=false so caller can fall back
 *
 * The RPC raises with specific message prefixes:
 *   E_NOT_FOUND, E_ALREADY_FINALIZED, E_BAD_RESULT,
 *   E_ROOM_PROPERTY_MISMATCH, E_TASK_PROPERTY_MISMATCH
 *
 * Postgres error messages may be wrapped by PostgREST as
 * "<errcode> ... <message>"; we match on substring rather than prefix
 * for resilience.
 */
const CALLER_BUG_PREFIXES = [
  'E_NOT_FOUND',
  'E_ALREADY_FINALIZED',
  'E_BAD_RESULT',
  // E_ROOM_PROPERTY_MISMATCH removed: 0271 repointed the room side-effect to
  // pms_housekeeping_assignments scoped by (property_id, room_number) and
  // dropped the strict exactly-one-row guard, so the RPC can no longer raise it.
  'E_TASK_PROPERTY_MISMATCH',
] as const;

function isCallerBugError(msg: string): boolean {
  return CALLER_BUG_PREFIXES.some((p) => msg.includes(p));
}

async function tryAtomicFinalize(args: TryAtomicArgs): Promise<AtomicOutcome> {
  try {
    const { data, error } = await supabaseAdmin.rpc('complete_inspection_atomic', {
      p_inspection_id: args.inspectionId,
      p_property_id: args.propertyId,
      p_result: args.result,
      p_failed_items: args.failedItems as unknown as Record<string, unknown>[],
      p_passed_items: args.passedItems,
      p_notes: args.notes,
      p_escalated: args.escalated,
      p_escalation_reason: args.escalationReason,
      p_correction_notice_sent_at: args.correctionNoticeSentAt,
      p_correction_note: args.correctionNote,
    });
    if (error) {
      const msg = error.message ?? '';
      if (isCallerBugError(msg)) throw new Error(msg);
      return { ok: false, err: msg };
    }
    // supabase.rpc returns the function result; for a function that
    // returns a single row, that's the row itself (not wrapped in an
    // array). Some Postgres + PostgREST versions return it wrapped, so
    // unwrap defensively.
    const raw = Array.isArray(data) ? data[0] : data;
    if (!raw) return { ok: false, err: 'RPC returned no row' };
    return { ok: true, inspection: fromInspectionRow(raw as Parameters<typeof fromInspectionRow>[0]) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isCallerBugError(msg)) throw err;
    return { ok: false, err: msg };
  }
}

// ─── Side effects ─────────────────────────────────────────────────────────

/**
 * On pass: mark the room "inspected" if it still has a rows-table entry
 * (legacy compat). If a cleaning_task is linked, flip its status to
 * inspected_pass. Errors are swallowed individually so a missing rooms
 * row doesn't block the cleaning_task flip and vice versa.
 */
export async function applyPassSideEffects(inspection: Inspection): Promise<void> {
  const rid = inspectionRoomRid(inspection);
  if (rid) {
    await applyRoomUpdate(inspection.propertyId, rid, {
      status: 'inspected',
      inspectedAt: new Date(),
    }).then(
      () => undefined,
      () => undefined,
    );
  }

  if (inspection.cleaningTaskId) {
    await supabaseAdmin
      .from('cleaning_tasks')
      .update({
        status: 'inspected_pass',
        inspected_at: new Date().toISOString(),
      })
      .eq('id', inspection.cleaningTaskId)
      .then(
        () => undefined,
        () => undefined,
      );
  }
}

/**
 * On fail: write the correction notice. Sets the linked room's status
 * back to dirty with an issue_note describing what failed — the
 * housekeeper sees this surface naturally in her existing queue (the
 * RoomCard component already renders issue_note as a red banner).
 * Also flips the cleaning_task status to correction_pending.
 */
export async function applyFailSideEffects(inspection: Inspection): Promise<void> {
  const note = buildCorrectionNote(inspection.failedItems);

  const rid = inspectionRoomRid(inspection);
  if (rid) {
    await applyRoomUpdate(inspection.propertyId, rid, {
      status: 'dirty',
      issueNote: note,
    }).then(
      () => undefined,
      () => undefined,
    );
  }

  if (inspection.cleaningTaskId) {
    await supabaseAdmin
      .from('cleaning_tasks')
      .update({
        status: 'correction_pending',
        priority: 'high',
        notes: note,
      })
      .eq('id', inspection.cleaningTaskId)
      .then(
        () => undefined,
        () => undefined,
      );
  }
}

/**
 * Compose the correction note shown to the housekeeper. Short, friendly,
 * names the failing items. Severity is encoded as a prefix so a critical
 * fail reads "Critical:" first.
 */
export function buildCorrectionNote(failedItems: InspectionFailedItem[]): string {
  if (failedItems.length === 0) return 'Re-clean requested by inspector.';

  const labels = failedItems.map((it) => {
    const sev = it.severity === 'critical' ? 'Critical' : it.severity === 'major' ? 'Major' : 'Minor';
    const note = it.note ? ` (${it.note})` : '';
    return `${sev}: ${it.label}${note}`;
  });

  if (labels.length === 1) return `Re-clean needed — ${labels[0]}`;
  return `Re-clean needed — ${labels.join('; ')}`;
}

// ─── Queue helpers ────────────────────────────────────────────────────────

/**
 * For a given list of failed inspections, return only the ones where the
 * linked room has been re-cleaned AFTER the inspection was marked failed.
 * Those are the rooms ready for re-inspection ("pending re-check").
 */
export interface PendingRecheckInput {
  /** Inspections with result='fail' and recheck_inspection_id=null. */
  failedInspections: Array<{
    id: string;
    roomId: string | null;
    completedAt: string | null;
  }>;
  /** Lookup of roomId → { status, completedAt }. */
  roomsById: Map<string, { status: string; completedAt: string | null }>;
}

export function filterReadyForRecheck(
  input: PendingRecheckInput,
): Array<{ inspectionId: string; roomId: string }> {
  const out: Array<{ inspectionId: string; roomId: string }> = [];
  for (const insp of input.failedInspections) {
    if (!insp.roomId || !insp.completedAt) continue;
    const room = input.roomsById.get(insp.roomId);
    if (!room) continue;
    if (room.status !== 'clean') continue;
    if (!room.completedAt) continue;
    if (room.completedAt > insp.completedAt) {
      out.push({ inspectionId: insp.id, roomId: insp.roomId });
    }
  }
  return out;
}
