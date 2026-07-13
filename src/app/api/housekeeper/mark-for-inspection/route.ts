/**
 * POST /api/housekeeper/mark-for-inspection
 *
 * Flips `rooms.marked_for_inspection_at` on a room so the inspections
 * queue picks it up. The inspections tab + worker on main already keys
 * off this column; this endpoint just provides the housekeeper-side tap.
 *
 * Idempotent — re-marking is a no-op (uses the existing timestamp's
 * presence as the "already marked" signal). Set `clear: true` in the
 * body to un-mark.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import {
  claimOfflineAction,
  completeOfflineActionClaim,
  releaseOfflineActionClaim,
} from '@/lib/housekeeper-workflow/offline-action-replay';
import { writeWorkflowFields } from '@/lib/housekeeper-workflow/workflow-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
  clear?: boolean;
  actionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-mark-inspection');
  if (!gate.ok) return gate.response;
  const body = gate.body;
  if (!body.roomId) {
    return err('missing roomId', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  const replayContext = body.actionId
    ? {
        actionId: body.actionId,
        propertyId: gate.pid,
        staffId: gate.staffId,
        endpoint: 'mark-for-inspection',
        requestId: gate.requestId,
      }
    : null;

  if (replayContext) {
    const claim = await claimOfflineAction(replayContext);
    if (!claim.ok) {
      const pending = claim.reason === 'pending';
      return err(pending ? 'Action is still processing' : 'Internal server error', {
        requestId: gate.requestId,
        status: pending ? 503 : 500,
        code: pending ? ApiErrorCode.IdempotencyConflict : ApiErrorCode.InternalError,
        headers: pending ? { ...gate.headers, 'Retry-After': '1' } : gate.headers,
      });
    }
    if (claim.duplicate) {
      return ok(
        { ...claim.resultPayload, deduped: true },
        { requestId: gate.requestId, headers: gate.headers },
      );
    }
  }

  // Release the idempotency claim when the protected write fails so a later
  // offline replay can attempt the write again instead of remaining pending.
  const releaseClaim = () => replayContext
    ? releaseOfflineActionClaim(replayContext)
    : Promise.resolve(true);
  const releaseFailureResponse = () => err('Temporary server error', {
    requestId: gate.requestId,
    status: 503,
    code: ApiErrorCode.UpstreamFailure,
    headers: { ...gate.headers, 'Retry-After': '1' },
  });

  const roomR = await loadRoomForStaff({
    pid: gate.pid,
    staffId: gate.staffId,
    roomId: body.roomId,
    requestId: gate.requestId,
    headers: gate.headers,
  });
  if (!roomR.ok) {
    if (!(await releaseClaim())) {
      return releaseFailureResponse();
    }
    return roomR.response;
  }
  const room = roomR.room;

  const now = new Date();
  let businessMutationCommitted = false;
  try {
    const w = await writeWorkflowFields(gate.pid, body.roomId, {
      marked_for_inspection_at: body.clear === true ? null : now.toISOString(),
    });
    if (!w.ok) {
      log.error('mark-for-inspection: update failed', {
        requestId: gate.requestId,
        err: w.error,
      });
      if (!(await releaseClaim())) return releaseFailureResponse();
      return err('Internal server error', {
        requestId: gate.requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers: gate.headers,
      });
    }
    businessMutationCommitted = true;

    try {
      const today = room.date ?? now.toISOString().slice(0, 10);
      await supabaseAdmin.from('housekeeper_audit_log').insert({
        property_id: gate.pid,
        staff_id: gate.staffId,
        business_date: today,
        room_id: body.roomId,
        room_number: room.number,
        event_type: 'mark_for_inspection',
        payload: { cleared: body.clear === true },
      });
    } catch (auditErr) {
      log.warn('mark-for-inspection: audit log failed', {
        requestId: gate.requestId,
        err: errToString(auditErr),
      });
    }

    const result = {
      marked: body.clear !== true,
      markedAt: body.clear === true ? null : now.toISOString(),
    };

    if (replayContext) {
      const replayCompleted = await completeOfflineActionClaim(replayContext, result);
      if (!replayCompleted) {
        log.warn('mark-for-inspection: committed mutation has a pending replay result', {
          requestId: gate.requestId,
          actionId: replayContext.actionId,
        });
      }
    }

    return ok(result, { requestId: gate.requestId, headers: gate.headers });
  } catch (caughtErr) {
    log.error('mark-for-inspection: threw', {
      requestId: gate.requestId,
      err: errToString(caughtErr),
    });
    if (!businessMutationCommitted && !(await releaseClaim())) {
      return releaseFailureResponse();
    }
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }
}
