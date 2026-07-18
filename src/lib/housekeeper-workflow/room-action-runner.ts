/**
 * Shared runner for simple housekeeper "flip a workflow field on a room"
 * endpoints.
 *
 * Several housekeeper POST routes are the same skeleton with only three
 * things different: which workflow field(s) they write, the audit-log
 * event they emit, and the success payload they return. This runner owns
 * the identical scaffolding around those three points:
 *
 *   gate  ->  idempotency claim (insert-first)  ->  releaseClaim closure
 *         ->  loadRoomForStaff  ->  writeWorkflowFields
 *         ->  audit log (best-effort)  ->  replay-payload update  ->  ok
 *
 * The idempotency claim/release is load-bearing: a failed write must
 * release the claim so the offline queue's retry re-applies instead of
 * hitting the dedup branch and falsely reporting success with an empty
 * payload (silent data loss — audit fix 2026-06-18).
 *
 * Currently used by /api/housekeeper/add-note and
 * /api/housekeeper/mark-for-inspection. Other single-field housekeeper
 * writes with the same shape could adopt it later — candidates include
 * exception, reset-clean, and pause/resume-clean, though several of those
 * carry extra pre/post logic (state-machine transitions, cleaning_events
 * writes) that would need to move into buildFields or stay in the route.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import type { RateLimitEndpoint } from '@/lib/api-ratelimit';
import { gateHousekeeperRequest, loadRoomForStaff } from './auth';
import type { RoomRowForWorkflow } from './auth';
import {
  claimOfflineAction,
  completeOfflineActionClaim,
  releaseOfflineActionClaim,
} from './offline-action-replay';
import { writeWorkflowFields } from './workflow-store';
import type { WorkflowPatch } from './workflow-store';

/** The body shape every room-action endpoint shares. */
export interface RoomActionBody {
  pid?: string;
  staffId?: string;
  roomId?: string;
  actionId?: string;
}

export interface RoomActionContext<TBody extends RoomActionBody> {
  body: TBody;
  room: RoomRowForWorkflow;
  /** One Date instance shared across buildFields/auditEvent/buildResult. */
  now: Date;
}

export interface RoomActionConfig<TBody extends RoomActionBody> {
  /** Rate-limit endpoint passed to gateHousekeeperRequest. */
  endpoint: RateLimitEndpoint;
  /**
   * Endpoint tag stored in offline_action_replays and used as the log
   * label prefix (e.g. "add-note", "mark-for-inspection").
   */
  replayEndpoint: string;
  /** Workflow-store patch to write for this action. */
  buildFields: (ctx: RoomActionContext<TBody>) => WorkflowPatch;
  /** Audit-log event type + payload for this action. */
  auditEvent: (ctx: RoomActionContext<TBody>) => {
    event_type: string;
    payload: Record<string, unknown>;
  };
  /** Success payload returned to the caller (and stored as the replay result). */
  buildResult: (ctx: RoomActionContext<TBody>) => Record<string, unknown>;
}

export async function runHousekeeperRoomAction<TBody extends RoomActionBody>(
  req: NextRequest,
  config: RoomActionConfig<TBody>,
): Promise<Response> {
  const { endpoint, replayEndpoint, buildFields, auditEvent, buildResult } = config;

  const gate = await gateHousekeeperRequest<TBody>(req, endpoint);
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

  // Idempotency — insert-first claim (see offline-action-replay.ts). A claim
  // whose payload is still empty means the original attempt died mid-flight:
  // answer 503 so the offline queue retries later, never a false "deduped"
  // success. A claim that cannot be released after a failed write is surfaced
  // the same way. (Audit fix 2026-06-18; hardened 2026-07-18.)
  const replayContext = body.actionId
    ? {
        actionId: body.actionId,
        propertyId: gate.pid,
        staffId: gate.staffId,
        endpoint: replayEndpoint,
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
    if (!(await releaseClaim())) return releaseFailureResponse();
    return roomR.response;
  }
  const room = roomR.room;

  const now = new Date();
  const ctx: RoomActionContext<TBody> = { body, room, now };
  let businessMutationCommitted = false;

  try {
    const w = await writeWorkflowFields(gate.pid, body.roomId, buildFields(ctx));
    if (!w.ok) {
      log.error(`${replayEndpoint}: update failed`, {
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

    // Audit log (best-effort — a failure here must not fail the action).
    try {
      const today = room.date ?? now.toISOString().slice(0, 10);
      const evt = auditEvent(ctx);
      await supabaseAdmin.from('housekeeper_audit_log').insert({
        property_id: gate.pid,
        staff_id: gate.staffId,
        business_date: today,
        room_id: body.roomId,
        room_number: room.number,
        event_type: evt.event_type,
        payload: evt.payload,
      });
    } catch (auditErr) {
      log.warn(`${replayEndpoint}: audit log failed (non-fatal)`, {
        requestId: gate.requestId,
        err: errToString(auditErr),
      });
    }

    const result = buildResult(ctx);

    if (replayContext) {
      // The mutation has committed — the claim must never be deleted now.
      // completeOfflineActionClaim retries once; on double failure the claim
      // stays pending and later replays get 503 rather than a double-apply.
      const replayCompleted = await completeOfflineActionClaim(replayContext, result);
      if (!replayCompleted) {
        log.warn(`${replayEndpoint}: committed mutation has a pending replay result`, {
          requestId: gate.requestId,
          actionId: replayContext.actionId,
        });
      }
    }

    return ok(result, { requestId: gate.requestId, headers: gate.headers });
  } catch (caughtErr) {
    log.error(`${replayEndpoint}: threw`, {
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
