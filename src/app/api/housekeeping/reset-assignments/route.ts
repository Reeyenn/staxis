/**
 * POST /api/housekeeping/reset-assignments
 *
 * Manager-initiated "Reset" button on the Schedule board. Clears every
 * active assignment for the property + date so the manager can rebalance
 * from scratch (typically Reset → Auto-assign).
 *
 * Safety: only touches canonical plan rows still in a reassignable status
 * (scheduled / ready_now / deferred). Work that has already STARTED
 * (in_progress) or finished (completed / cancelled / inspection_*) keeps
 * its assignment — you can't un-assign a room a housekeeper is mid-clean
 * on. This mirrors the status window the reassign RPC enforces.
 *
 * The canonical reset operation runs in one transaction and appends the
 * inactive assignment snapshot before clearing room_work's current fields.
 * Legacy tables remain physical for the rollback window, but the manager
 * board and future canonical callers read the room_work result.
 *
 * Auth: requireSession (manager-facing) + property-access gate.
 *
 * Body: { propertyId: uuid, date: YYYY-MM-DD, taskId?: uuid }
 *   - taskId omitted → clear ALL resettable assignments for the date.
 *   - taskId present  → unassign just that one room (powers dragging a
 *     chip back onto the board's "Unassigned" row, since the reassign RPC
 *     can only MOVE a task to a housekeeper, never null it).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { hotelWriteDecisionForUserId } from '@/lib/team-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateDateStr } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  propertyId?: unknown;
  date?: unknown;
  taskId?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('invalid JSON body', { requestId, status: 400, code: 'validation_failed' });
  }

  const pidCheck = validateUuid(body.propertyId, 'propertyId');
  if (pidCheck.error) return err(pidCheck.error, { requestId, status: 400, code: 'validation_failed' });
  const dateCheck = validateDateStr(typeof body.date === 'string' ? body.date : '', { label: 'date' });
  if (dateCheck.error) return err(dateCheck.error, { requestId, status: 400, code: 'validation_failed' });

  const propertyId = pidCheck.value!;
  const businessDate = dateCheck.value!;

  // Optional single-task scope (drag-to-Unassigned).
  let singleTaskId: string | null = null;
  if (body.taskId != null) {
    const taskCheck = validateUuid(body.taskId, 'taskId');
    if (taskCheck.error) return err(taskCheck.error, { requestId, status: 400, code: 'validation_failed' });
    singleTaskId = taskCheck.value!;
  }

  const capabilityDecision = await hotelWriteDecisionForUserId(
    auth.userId,
    propertyId,
    'assign_work',
  );
  if (capabilityDecision === 'unavailable') {
    return capabilityUnavailableResponse(requestId);
  }
  if (capabilityDecision === 'denied') {
    return err('forbidden: assigning work is restricted for your role at this property', { requestId, status: 403, code: 'forbidden' });
  }
  try {
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc(
      'reset_room_work_assignments',
      {
        p_property_id: propertyId,
        p_date: businessDate,
        p_task_id: singleTaskId,
      },
    );
    if (rpcErr) {
      log.error('reset-assignments: canonical reset failed', { requestId, msg: rpcErr.message });
      return err('reset failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const cleared = typeof rpcData === 'number' ? rpcData : Number(rpcData ?? 0);
    if (!Number.isFinite(cleared)) {
      log.error('reset-assignments: canonical reset returned an invalid count', { requestId });
      return err('reset failed', { requestId, status: 500, code: 'upstream_failure' });
    }

    log.info('reset-assignments: ok', { requestId, propertyId, businessDate, cleared });
    return ok({ cleared }, { requestId });
  } catch (e) {
    log.error('reset-assignments: unexpected error', { requestId, msg: errToString(e) });
    return err('reset failed', { requestId, status: 500, code: 'internal_error' });
  }
}
