/**
 * POST /api/housekeeping/reset-assignments
 *
 * Manager-initiated "Reset" button on the Schedule board. Clears every
 * active assignment for the property + date so the manager can rebalance
 * from scratch (typically Reset → Auto-assign).
 *
 * Safety: only touches cleaning_tasks still in a reassignable status
 * (scheduled / ready_now / deferred). Work that has already STARTED
 * (in_progress) or finished (completed / cancelled / inspection_*) keeps
 * its assignment — you can't un-assign a room a housekeeper is mid-clean
 * on. This mirrors the status window the reassign RPC enforces.
 *
 * Not a single transaction (no RPC), but the order is safe: deactivate
 * the hk_assignments rows first, then null the cleaning_tasks.assignee_id
 * cache. A crash between the two leaves the cache pointing at a now-
 * inactive assignment, which the board read (which joins active rows)
 * already tolerates — and the next auto-assign/reassign re-syncs it.
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
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { canForUserId } from '@/lib/capabilities/server';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateDateStr } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Kept in sync with auto-assign-runner.AUTO_ASSIGNABLE_STATUSES and the
// reassign RPC's status window.
const RESETTABLE_STATUSES = ['scheduled', 'ready_now', 'deferred'] as const;

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

  if (!(await canForUserId(auth.userId, 'assign_work', propertyId))) {
    return err('forbidden — assigning work is restricted for your role at this property', { requestId, status: 403, code: 'forbidden' });
  }
  const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
  if (!hasAccess) {
    log.warn('reset-assignments: forbidden — user lacks property access', {
      requestId, userId: auth.userId, propertyId,
    });
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: 'forbidden',
    });
  }

  try {
    // 1. Which tasks are eligible to reset (still reassignable). When a
    //    single taskId is given, narrow to it (still status + tenant gated).
    let taskQuery = supabaseAdmin
      .from('cleaning_tasks')
      .select('id')
      .eq('property_id', propertyId)
      .eq('business_date', businessDate)
      .in('status', RESETTABLE_STATUSES);
    if (singleTaskId) taskQuery = taskQuery.eq('id', singleTaskId);
    const { data: taskRows, error: taskErr } = await taskQuery;
    if (taskErr) {
      log.error('reset-assignments: load tasks failed', { requestId, msg: taskErr.message });
      return err('reset failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const taskIds = (taskRows ?? []).map(t => t.id as string);
    if (taskIds.length === 0) {
      return ok({ cleared: 0 }, { requestId });
    }

    // 2. Deactivate the active assignments for those tasks.
    const { data: deactivated, error: deErr } = await supabaseAdmin
      .from('hk_assignments')
      .update({ is_active: false })
      .eq('property_id', propertyId)
      .eq('is_active', true)
      .in('cleaning_task_id', taskIds)
      .select('id');
    if (deErr) {
      log.error('reset-assignments: deactivate failed', { requestId, msg: deErr.message });
      return err('reset failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const cleared = deactivated?.length ?? 0;

    // 3. Null the assignee_id cache on those tasks.
    const { error: cacheErr } = await supabaseAdmin
      .from('cleaning_tasks')
      .update({ assignee_id: null })
      .eq('property_id', propertyId)
      .in('id', taskIds);
    if (cacheErr) {
      // Non-fatal: hk_assignments is the source of truth; the board joins
      // active rows. Warn and report success on the deactivation.
      log.warn('reset-assignments: cache clear failed', { requestId, msg: cacheErr.message });
    }

    log.info('reset-assignments: ok', { requestId, propertyId, businessDate, cleared });
    return ok({ cleared }, { requestId });
  } catch (e) {
    log.error('reset-assignments: unexpected error', { requestId, msg: errToString(e) });
    return err('reset failed', { requestId, status: 500, code: 'internal_error' });
  }
}
