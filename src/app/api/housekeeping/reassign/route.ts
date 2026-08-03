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
 * Behaviour (atomic): delegates to the canonical assign_room_work_atomic
 * RPC (0435). The RPC locks the canonical parent/component set, verifies the
 * property/status/staff boundary, appends assignment history, and updates
 * the current room_work assignment snapshot in one transaction.
 *
 * Idempotent: if the task is already assigned to toHousekeeperId, the
 * RPC returns noop=true without writing — the UI can drop a tile back
 * on its origin column without spawning churn audit rows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { hotelWriteDecisionForUserId } from '@/lib/team-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateString } from '@/lib/api-validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Reassignable statuses are enforced inside the canonical RPC (0435).
// Kept in sync there: scheduled, ready_now, deferred.

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
  let reason: string | null = null;
  if (body.reason != null) {
    const reasonCheck = validateString(body.reason, { max: 280, label: 'reason' });
    if (reasonCheck.error) {
      return err(reasonCheck.error, { requestId, status: 400, code: 'validation_failed' });
    }
    reason = reasonCheck.value ?? null;
  }

  try {
    // Atomic reassignment through the canonical SECURITY DEFINER operation.
    // It is the only manager-side assignment writer after the Stage B
    // cutover; legacy tables remain available to old rollback clients and
    // continue to flow one-way into room_work through the Stage A bridge.
    const { data: rpcRows, error: rpcErr } = await supabaseAdmin.rpc(
      'assign_room_work_atomic',
      {
        p_property_id: propertyId,
        p_task_id: taskId,
        p_to_housekeeper_id: toHkId,
        p_assigned_by_user: auth.userId,
        p_reason: reason ?? 'manager reassigned',
        p_assigned_by: 'manual',
      },
    );

    if (rpcErr) {
      // Map Postgres SQLSTATE codes back to HTTP status. The RPC raises
      // P0002 for not-found cases and P0001 for validation/tenant
      // violations; everything else is treated as an upstream failure.
      const code = (rpcErr as { code?: string }).code ?? '';
      const msg = rpcErr.message ?? 'reassign failed';
      if (code === 'P0002') {
        log.warn('reassign: not found', { requestId, taskId, toHkId, msg });
        return err(msg, { requestId, status: 404, code: 'not_found' });
      }
      if (code === 'P0001') {
        log.warn('reassign: rejected', { requestId, taskId, toHkId, msg });
        // 409 conflict for state issues, 403 for tenant violations.
        const isTenant = /property/i.test(msg);
        return err(msg, {
          requestId, status: isTenant ? 403 : 409,
          code: isTenant ? 'forbidden' : 'validation_failed',
        });
      }
      log.error('reassign: rpc failed', { requestId, taskId, msg, code });
      return err('reassignment failed', { requestId, status: 500, code: 'upstream_failure' });
    }

    // The RPC returns a single-row table: { task_id, assignee_id, noop }.
    // Supabase wraps it as an array.
    type RpcRow = { task_id: string; assignee_id: string; noop: boolean };
    const rpcRow = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as RpcRow | null;
    if (!rpcRow) {
      log.error('reassign: empty rpc result', { requestId, taskId });
      return err('reassignment failed', { requestId, status: 500, code: 'upstream_failure' });
    }

    if (rpcRow.noop) {
      return ok({ noop: true, assignee_id: rpcRow.assignee_id }, { requestId });
    }

    log.info('reassign: ok', { requestId, taskId, toHkId, byUser: auth.userId });
    return ok({ taskId: rpcRow.task_id, assignee_id: rpcRow.assignee_id }, { requestId });
  } catch (e) {
    log.error('reassign: unexpected error', { requestId, msg: errToString(e) });
    return err('reassignment failed', { requestId, status: 500, code: 'internal_error' });
  }
}
