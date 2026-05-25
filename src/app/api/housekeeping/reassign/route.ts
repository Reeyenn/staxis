/**
 * POST /api/housekeeping/reassign
 *
 * Manager-initiated reassignment of one cleaning_task to a different
 * housekeeper. Triggered by drag-and-drop in ScheduleTab.tsx.
 *
 * Auth: requireSession (manager-facing). NOT requireCronSecret.
 *
 * Body: {
 *   propertyId: uuid,
 *   taskId: uuid,
 *   toHousekeeperId: uuid,
 *   reason?: string,          // optional manager note
 * }
 *
 * Behaviour (atomic-ish):
 *   1. Verify the task belongs to the property and isn't already in
 *      progress / completed / cancelled (those are off-limits for
 *      reassignment).
 *   2. Flip is_active=false on the current active assignment (the
 *      audit history row).
 *   3. Insert a new hk_assignments row with is_active=true,
 *      assigned_by='manual', and the manager's user id stamped on
 *      assigned_by_user_id.
 *   4. Update cleaning_tasks.assignee_id to the new HK.
 *
 * Idempotent: if the task is already assigned to toHousekeeperId,
 * returns ok with a no-op flag rather than churning audit rows. This
 * keeps the UI from creating spurious history rows when a drag ends
 * back on the same column.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateString } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Statuses that can be reassigned. Anything else (in_progress, completed,
// inspection_pending, …) is locked — the HK is already touching the room
// or the work is done.
const REASSIGNABLE_STATUSES = new Set([
  'scheduled',
  'ready_now',
  'deferred',
]);

interface ReassignBody {
  propertyId?: unknown;
  taskId?: unknown;
  toHousekeeperId?: unknown;
  reason?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: ReassignBody;
  try {
    body = (await req.json()) as ReassignBody;
  } catch {
    return err('invalid JSON body', { requestId, status: 400, code: 'validation_failed' });
  }

  const pidCheck = validateUuid(body.propertyId, 'propertyId');
  if (pidCheck.error) return err(pidCheck.error, { requestId, status: 400, code: 'validation_failed' });
  const taskCheck = validateUuid(body.taskId, 'taskId');
  if (taskCheck.error) return err(taskCheck.error, { requestId, status: 400, code: 'validation_failed' });
  const hkCheck = validateUuid(body.toHousekeeperId, 'toHousekeeperId');
  if (hkCheck.error) return err(hkCheck.error, { requestId, status: 400, code: 'validation_failed' });

  const propertyId = pidCheck.value!;
  const taskId = taskCheck.value!;
  const toHkId = hkCheck.value!;

  // Tenant-scope gate: the session caller must have access to this
  // property before any task/staff lookup or mutation. Without this
  // any signed-in user with two UUIDs (task + housekeeper) could move
  // work between housekeepers at another hotel via the service-role
  // client.
  const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
  if (!hasAccess) {
    log.warn('reassign: forbidden — user lacks property access', {
      requestId, userId: auth.userId, propertyId,
    });
    return err('forbidden — no access to this property', {
      requestId, status: 403, code: 'forbidden',
    });
  }

  let reason: string | null = null;
  if (body.reason != null) {
    const reasonCheck = validateString(body.reason, { max: 280, label: 'reason' });
    if (reasonCheck.error) {
      return err(reasonCheck.error, { requestId, status: 400, code: 'validation_failed' });
    }
    reason = reasonCheck.value ?? null;
  }

  try {
    // 1. Load the task and confirm it belongs to the property + is reassignable.
    const { data: taskRow, error: taskErr } = await supabaseAdmin
      .from('cleaning_tasks')
      .select('id, property_id, status, assignee_id')
      .eq('id', taskId)
      .maybeSingle();
    if (taskErr) {
      log.error('reassign: load task failed', { requestId, taskId, msg: taskErr.message });
      return err('load task failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    if (!taskRow) {
      return err('task not found', { requestId, status: 404, code: 'not_found' });
    }
    if (taskRow.property_id !== propertyId) {
      return err('task does not belong to property', { requestId, status: 403, code: 'forbidden' });
    }
    if (!REASSIGNABLE_STATUSES.has(taskRow.status)) {
      return err(`cannot reassign task in status "${taskRow.status}"`, {
        requestId, status: 409, code: 'validation_failed',
      });
    }

    // 2. Confirm the destination HK is on staff for this property + housekeeping.
    const { data: hkRow, error: hkErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, department, is_active')
      .eq('id', toHkId)
      .eq('property_id', propertyId)
      .maybeSingle();
    if (hkErr) {
      log.error('reassign: load hk failed', { requestId, toHkId, msg: hkErr.message });
      return err('load housekeeper failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    if (!hkRow) {
      return err('housekeeper not found at property', { requestId, status: 404, code: 'not_found' });
    }
    if (hkRow.department !== 'housekeeping') {
      return err('target is not a housekeeper', { requestId, status: 400, code: 'validation_failed' });
    }
    if (hkRow.is_active === false) {
      return err('housekeeper is inactive', { requestId, status: 409, code: 'validation_failed' });
    }

    // 3. No-op: already assigned to the target HK. Skip churn.
    if (taskRow.assignee_id === toHkId) {
      return ok({ noop: true, assignee_id: toHkId }, { requestId });
    }

    // 4. Flip is_active=false on the existing active assignment (if any).
    //    There may be no current active row if the cron hasn't run yet.
    const { error: deactivateErr } = await supabaseAdmin
      .from('hk_assignments')
      .update({ is_active: false })
      .eq('cleaning_task_id', taskId)
      .eq('is_active', true);
    if (deactivateErr) {
      log.error('reassign: deactivate failed', { requestId, taskId, msg: deactivateErr.message });
      return err('reassignment failed', { requestId, status: 500, code: 'upstream_failure' });
    }

    // 5. Insert the new active row.
    const { error: insertErr } = await supabaseAdmin.from('hk_assignments').insert({
      property_id: propertyId,
      cleaning_task_id: taskId,
      housekeeper_id: toHkId,
      queue_order: 0,
      is_active: true,
      assigned_at: new Date().toISOString(),
      assigned_by: 'manual',
      assigned_by_user_id: auth.userId,
      reason: reason ?? 'manager reassigned',
      score: null,
    });
    if (insertErr) {
      log.error('reassign: insert failed', { requestId, taskId, msg: insertErr.message });
      return err('reassignment failed', { requestId, status: 500, code: 'upstream_failure' });
    }

    // 6. Cache assignee on cleaning_tasks. Best-effort — hk_assignments
    //    is the source of truth.
    const { error: updErr } = await supabaseAdmin
      .from('cleaning_tasks')
      .update({ assignee_id: toHkId })
      .eq('id', taskId);
    if (updErr) {
      log.warn('reassign: cache update failed', { requestId, taskId, msg: updErr.message });
    }

    log.info('reassign: ok', { requestId, taskId, toHkId, byUser: auth.userId });
    return ok({ taskId, assignee_id: toHkId }, { requestId });
  } catch (e) {
    log.error('reassign: unexpected error', { requestId, msg: errToString(e) });
    return err('reassignment failed', { requestId, status: 500, code: 'internal_error' });
  }
}
