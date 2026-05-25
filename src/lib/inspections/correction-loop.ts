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
import {
  completeInspection,
  countConsecutiveFails,
  getInspectionById,
  linkRecheck,
} from '@/lib/db/inspections';
import type {
  Inspection,
  InspectionFailedItem,
} from '@/types/inspections';
import { ESCALATION_THRESHOLD } from '@/types/inspections';

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
    const priorFails = await countConsecutiveFails(before.parentInspectionId);
    if (priorFails + 1 >= threshold) {
      escalated = true;
      escalationReason = `Failed ${priorFails + 1} consecutive inspections on room ${before.roomNumber}`;
    }
  }

  // 1. Update the inspections row.
  let correctionNoticeSentAt: string | null = null;
  if (input.result === 'fail') correctionNoticeSentAt = new Date().toISOString();

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

  // 2. Link the parent if this was a re-check. (Sets parent.recheck_inspection_id = this.id.)
  if (before.parentInspectionId) {
    try {
      await linkRecheck(before.parentInspectionId, finalized.id);
    } catch {
      // Non-fatal — the chain is also reconstructible by walking parent_inspection_id.
      // Swallow so a transient failure doesn't roll back the inspection itself.
    }
  }

  // 3. Side effects per result.
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

// ─── Side effects ─────────────────────────────────────────────────────────

/**
 * On pass: mark the room "inspected" if it still has a rows-table entry
 * (legacy compat). If a cleaning_task is linked, flip its status to
 * inspected_pass. Errors are swallowed individually so a missing rooms
 * row doesn't block the cleaning_task flip and vice versa.
 */
export async function applyPassSideEffects(inspection: Inspection): Promise<void> {
  if (inspection.roomId) {
    await supabaseAdmin
      .from('rooms')
      .update({
        status: 'inspected',
        inspected_at: new Date().toISOString(),
      })
      .eq('id', inspection.roomId)
      .then(
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

  if (inspection.roomId) {
    await supabaseAdmin
      .from('rooms')
      .update({
        status: 'dirty',
        completed_at: null,
        issue_note: note,
      })
      .eq('id', inspection.roomId)
      .then(
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
