/**
 * POST /api/housekeeper/structured-issue
 *
 * Housekeeper fills out the structured issue form (action / item /
 * location / severity / note / optional photo) and submits. The route
 * creates a pms_work_orders_v2 row via the staxis_create_structured_issue
 * RPC (atomic — RPC handles severity → priority + description build).
 *
 * Returns the new work_order id so the client can upload the photo via
 * /api/housekeeper/photo-presign to the housekeeping-issue-photos bucket.
 *
 * Idempotent: an `actionId` UUID on the body deduplicates replays from
 * the offline queue (the offline_action_replays table).
 *
 * Audit: also writes a housekeeper_audit_log row tagged
 * 'structured_issue_filed' with the input snapshot.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import {
  claimOfflineAction,
  completeOfflineActionClaim,
  releaseOfflineActionClaim,
} from '@/lib/housekeeper-workflow/offline-action-replay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
  roomNumber?: string;
  action?: 'replace' | 'repair' | 'clean' | 'report';
  item?: string;
  locationDetail?: string;
  severity?: 'minor' | 'major' | 'urgent';
  note?: string;
  /** Optional — UUID from the client so replays don't double-file. */
  actionId?: string;
  /** Optional — set when the client has already uploaded a photo via
   *  /api/housekeeper/photo-presign and wants to attach it on submit. */
  photoPath?: string;
}

const ALLOWED_ACTIONS = new Set(['replace', 'repair', 'clean', 'report']);
const ALLOWED_SEVERITY = new Set(['minor', 'major', 'urgent']);

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-structured-issue');
  if (!gate.ok) return gate.response;
  const body = gate.body;
  if (!body.roomNumber || body.roomNumber.length > 20) {
    return err('invalid roomNumber', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }
  if (!ALLOWED_ACTIONS.has(body.action ?? '')) {
    return err('invalid action', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }
  const item = (body.item ?? '').trim();
  if (!item || item.length > 100) {
    return err('invalid item', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }
  const locationDetail = (body.locationDetail ?? '').trim().slice(0, 200);
  if (!ALLOWED_SEVERITY.has(body.severity ?? '')) {
    return err('invalid severity', {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }
  const note = (body.note ?? '').trim().slice(0, 500);

  // Harden the optional photoPath: it must point into THIS hotel's storage
  // folder and contain no '..' traversal. The path is produced by
  // /api/housekeeper/photo-presign as `<pid>/<scopeKey>/<uuid>.<ext>`; reject
  // anything else so a forged path can't reference another hotel's storage.
  // (Audit hardening 2026-06-18.)
  if (body.photoPath !== undefined && body.photoPath !== null && body.photoPath !== '') {
    if (typeof body.photoPath !== 'string' || !body.photoPath.startsWith(`${gate.pid}/`) || body.photoPath.includes('..')) {
      return err('invalid photoPath', {
        requestId: gate.requestId, status: 400, code: ApiErrorCode.ValidationFailed, headers: gate.headers,
      });
    }
  }

  const replayContext = body.actionId
    ? {
        actionId: body.actionId,
        propertyId: gate.pid,
        staffId: gate.staffId,
        endpoint: 'structured-issue',
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
  let businessMutationCommitted = false;

  try {
    const { data: workOrderId, error: rpcErr } = await supabaseAdmin.rpc(
      'staxis_create_structured_issue',
      {
        p_property_id: gate.pid,
        p_room_number: body.roomNumber,
        p_reporter_staff_id: gate.staffId,
        p_action: body.action,
        p_item: item,
        p_location_detail: locationDetail || null,
        p_severity: body.severity,
        p_note: note || null,
      },
    );
    if (rpcErr || !workOrderId) {
      log.error('structured-issue: rpc failed', {
        requestId: gate.requestId,
        err: errToString(rpcErr ?? 'no work_order_id'),
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

    // If a photoPath was supplied, attach it to the work order's raw blob
    // for the maintenance UI to render. The photo itself lives in the
    // housekeeping-issue-photos bucket and is fetched via signed URL.
    if (body.photoPath) {
      try {
        await supabaseAdmin
          .from('pms_work_orders_v2')
          .update({
            raw: {
              source: 'housekeeper_app',
              photo_path: body.photoPath,
              reporter_staff_id: gate.staffId,
              action: body.action,
              item,
              location_detail: locationDetail,
              severity: body.severity,
              note,
            },
          })
          .eq('id', workOrderId);
      } catch (photoErr) {
        log.warn('structured-issue: photo attach failed (non-fatal)', {
          requestId: gate.requestId,
          err: errToString(photoErr),
        });
      }
    }

    // Audit row — best-effort, never blocks the response.
    try {
      const today = new Date().toISOString().slice(0, 10);
      await supabaseAdmin.from('housekeeper_audit_log').insert({
        property_id: gate.pid,
        staff_id: gate.staffId,
        business_date: today,
        room_id: body.roomId ?? null,
        room_number: body.roomNumber,
        event_type: 'structured_issue_filed',
        payload: {
          work_order_id: workOrderId,
          action: body.action,
          item,
          location_detail: locationDetail,
          severity: body.severity,
          has_photo: !!body.photoPath,
        },
      });
    } catch (auditErr) {
      log.warn('structured-issue: audit log failed (non-fatal)', {
        requestId: gate.requestId,
        err: errToString(auditErr),
      });
    }

    const result = {
      workOrderId: workOrderId as string,
      photoAttached: !!body.photoPath,
    };

    if (replayContext) {
      const replayCompleted = await completeOfflineActionClaim(replayContext, result);
      if (!replayCompleted) {
        // The work order already exists. Keep the pending claim so a replay
        // after response loss cannot create a duplicate.
        log.warn('structured-issue: committed mutation has a pending replay result', {
          requestId: gate.requestId,
          actionId: replayContext.actionId,
        });
      }
    }

    return ok(result, { requestId: gate.requestId, headers: gate.headers });
  } catch (caughtErr) {
    log.error('structured-issue: threw', {
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
