/**
 * POST /api/housekeeper/report-found-item
 *
 * A housekeeper logs a found item from their room card. Mirrors
 * /api/housekeeper/add-note: gateHousekeeperRequest capability check,
 * offline-replay idempotency (actionId), audit-log row. Writes a 'found' row
 * into lost_and_found_items (the app-side L&F table), room auto-filled from the
 * job card.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { validateString, validateEnum } from '@/lib/api-validate';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import { createItem } from '@/lib/lost-and-found/store';
import { LAF_CATEGORIES } from '@/lib/lost-and-found/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
  itemDescription?: string;
  category?: string | null;
  photoPath?: string | null;
  actionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-report-found-item');
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

  const descV = validateString(body.itemDescription, { max: 500, label: 'itemDescription' });
  if (descV.error) {
    return err(descV.error, {
      requestId: gate.requestId,
      status: 400,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
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

  // Photo path must be scoped to this property's storage prefix.
  let photoPath: string | null = null;
  if (body.photoPath) {
    const p = String(body.photoPath);
    if (p.length > 200 || !p.startsWith(`${gate.pid}/`) || !/^[A-Za-z0-9/_.-]+$/.test(p)) {
      return err('invalid photoPath', {
        requestId: gate.requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
        headers: gate.headers,
      });
    }
    photoPath = p;
  }

  // Idempotency — insert-first pattern (mirrors add-note).
  if (body.actionId) {
    const { data: claimed } = await supabaseAdmin
      .from('offline_action_replays')
      .insert({
        action_id: body.actionId,
        property_id: gate.pid,
        staff_id: gate.staffId,
        endpoint: 'report-found-item',
        result_payload: {},
      })
      .select('action_id')
      .maybeSingle();
    if (!claimed) {
      const { data: prev } = await supabaseAdmin
        .from('offline_action_replays')
        .select('result_payload')
        .eq('action_id', body.actionId)
        .maybeSingle();
      return ok(
        { ...((prev?.result_payload as Record<string, unknown> | undefined) ?? {}), deduped: true },
        { requestId: gate.requestId, headers: gate.headers },
      );
    }
  }

  // Confirm the room belongs to this property + staff, and grab its number.
  const roomR = await loadRoomForStaff({
    pid: gate.pid,
    staffId: gate.staffId,
    roomId: body.roomId,
    requestId: gate.requestId,
    headers: gate.headers,
  });
  if (!roomR.ok) return roomR.response;
  const room = roomR.room;

  try {
    const created = await createItem(gate.pid, {
      type: 'found',
      itemDescription: descV.value!,
      category,
      roomNumber: room.number,
      location: room.number ? `Room ${room.number}` : null,
      photoPath,
      foundBy: gate.staffName,
      foundByStaffId: gate.staffId,
      source: 'housekeeper',
    });
    if (!created.ok) {
      return err('Internal server error', {
        requestId: gate.requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers: gate.headers,
      });
    }

    // Audit log (non-fatal).
    try {
      const today = room.date ?? new Date().toISOString().slice(0, 10);
      await supabaseAdmin.from('housekeeper_audit_log').insert({
        property_id: gate.pid,
        staff_id: gate.staffId,
        business_date: today,
        room_id: body.roomId,
        room_number: room.number,
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
    if (body.actionId) {
      try {
        await supabaseAdmin
          .from('offline_action_replays')
          .update({ result_payload: result })
          .eq('action_id', body.actionId);
      } catch (replayErr) {
        log.warn('report-found-item: replay log update failed', {
          requestId: gate.requestId,
          err: errToString(replayErr),
        });
      }
    }

    return ok(result, { requestId: gate.requestId, headers: gate.headers });
  } catch (caughtErr) {
    log.error('report-found-item: threw', {
      requestId: gate.requestId,
      err: errToString(caughtErr),
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }
}
