/**
 * POST /api/housekeeper/report-found-item
 *
 * A housekeeper logs a found item from their room card. Mirrors
 * /api/housekeeper/add-note for auth + idempotency + audit, but writes a
 * 'found' row into lost_and_found_items (the app-side L&F table).
 *
 * Unlike add-note (which mutates the rooms row and therefore needs a real
 * rooms.id), a found item is keyed to property + room NUMBER — it doesn't
 * touch the rooms table. The housekeeper list runs on Plan-v4 derived rooms
 * whose id is a synthetic `date:number` string, so we take the room number as
 * descriptive context (capability is already proven by gateHousekeeperRequest:
 * the staff member belongs to the property). This is the same "room is
 * optional context" model the front-desk log flow uses.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateString, validateEnum } from '@/lib/api-validate';
import { gateHousekeeperRequest } from '@/lib/housekeeper-workflow/auth';
import {
  claimOfflineAction,
  completeOfflineActionClaim,
  releaseOfflineActionClaim,
} from '@/lib/housekeeper-workflow/offline-action-replay';
import { createItem, isValidItemPhotoPath } from '@/lib/lost-and-found/store';
import { LAF_CATEGORIES } from '@/lib/lost-and-found/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  /** Room number (descriptive context). The page auto-fills it from the card. */
  roomNumber?: string;
  itemDescription?: string;
  category?: string | null;
  photoPath?: string | null;
  actionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-report-found-item');
  if (!gate.ok) return gate.response;
  const body = gate.body;

  const descV = validateString(body.itemDescription, { max: 500, label: 'itemDescription' });
  if (descV.error) {
    return err(descV.error, {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  // Room number is optional context, capped. Tolerates the Plan-v4 synthetic
  // "date:number" id by taking the trailing number if a colon is present.
  let roomNumber: string | null = null;
  if (typeof body.roomNumber === 'string' && body.roomNumber.trim()) {
    const raw = body.roomNumber.includes(':')
      ? body.roomNumber.split(':').pop()!.trim()
      : body.roomNumber.trim();
    const roomV = validateString(raw, { max: 20, label: 'roomNumber' });
    if (roomV.error) {
      return err(roomV.error, {
        requestId: gate.requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
        headers: gate.headers,
      });
    }
    roomNumber = roomV.value!;
  }

  let category: string | null = null;
  if (body.category) {
    const c = validateEnum(body.category, LAF_CATEGORIES, 'category');
    if (c.error) {
      return err(c.error, {
        requestId: gate.requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
        headers: gate.headers,
      });
    }
    category = c.value!;
  }

  // Photo path must match the EXACT shape the presign route mints under this
  // property — never an arbitrary, traversal, or cross-tenant key.
  let photoPath: string | null = null;
  if (body.photoPath) {
    if (!isValidItemPhotoPath(gate.pid, body.photoPath)) {
      return err('invalid photoPath', {
        requestId: gate.requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
        headers: gate.headers,
      });
    }
    photoPath = String(body.photoPath);
  }

  const replayContext = body.actionId
    ? {
        actionId: body.actionId,
        propertyId: gate.pid,
        staffId: gate.staffId,
        endpoint: 'report-found-item',
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
    const created = await createItem(gate.pid, {
      type: 'found',
      itemDescription: descV.value!,
      category,
      roomNumber,
      location: roomNumber ? `Room ${roomNumber}` : null,
      photoPath,
      foundBy: gate.staffName,
      foundByStaffId: gate.staffId,
      source: 'housekeeper',
    });
    if (!created.ok) {
      if (!(await releaseClaim())) return releaseFailureResponse();
      return err('Internal server error', {
        requestId: gate.requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers: gate.headers,
      });
    }
    businessMutationCommitted = true;

    // Audit log (non-fatal).
    try {
      const today = new Date().toISOString().slice(0, 10);
      await supabaseAdmin.from('housekeeper_audit_log').insert({
        property_id: gate.pid,
        staff_id: gate.staffId,
        business_date: today,
        room_id: null,
        room_number: roomNumber,
        event_type: 'report_found_item',
        payload: { itemId: created.id, description: descV.value, category, hasPhoto: !!photoPath },
      });
    } catch (auditErr) {
      log.warn('report-found-item: audit log failed (non-fatal)', {
        requestId: gate.requestId,
        err: errToString(auditErr),
      });
    }

    const result = { saved: true, itemId: created.id };
    if (replayContext) {
      const replayCompleted = await completeOfflineActionClaim(replayContext, result);
      if (!replayCompleted) {
        log.warn('report-found-item: committed mutation has a pending replay result', {
          requestId: gate.requestId,
          actionId: replayContext.actionId,
        });
      }
    }

    return ok(result, { requestId: gate.requestId, headers: gate.headers });
  } catch (caughtErr) {
    log.error('report-found-item: threw', {
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
