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

  // Idempotency — insert-first pattern.
  if (body.actionId) {
    const { data: claimed } = await supabaseAdmin
      .from('offline_action_replays')
      .insert({
        action_id: body.actionId,
        property_id: gate.pid,
        staff_id: gate.staffId,
        endpoint: 'mark-for-inspection',
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

  // Release the idempotency claim on failure so the offline queue's retry can
  // re-apply instead of hitting the dedup branch and falsely reporting success
  // with an empty payload (silent data loss). (Audit fix 2026-06-18.)
  const releaseClaim = async () => {
    if (!body.actionId) return;
    try { await supabaseAdmin.from('offline_action_replays').delete().eq('action_id', body.actionId); }
    catch { /* best-effort */ }
  };

  const roomR = await loadRoomForStaff({
    pid: gate.pid,
    staffId: gate.staffId,
    roomId: body.roomId,
    requestId: gate.requestId,
    headers: gate.headers,
  });
  if (!roomR.ok) { await releaseClaim(); return roomR.response; }
  const room = roomR.room;

  const now = new Date();
  try {
    const w = await writeWorkflowFields(gate.pid, body.roomId, {
      marked_for_inspection_at: body.clear === true ? null : now.toISOString(),
    });
    if (!w.ok) {
      log.error('mark-for-inspection: update failed', {
        requestId: gate.requestId,
        err: w.error,
      });
      await releaseClaim();
      return err('Internal server error', {
        requestId: gate.requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers: gate.headers,
      });
    }

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

    if (body.actionId) {
      try {
        await supabaseAdmin
          .from('offline_action_replays')
          .update({ result_payload: result })
          .eq('action_id', body.actionId);
      } catch (replayErr) {
        log.warn('mark-for-inspection: replay log update failed', {
          requestId: gate.requestId, err: errToString(replayErr),
        });
      }
    }

    return ok(result, { requestId: gate.requestId, headers: gate.headers });
  } catch (caughtErr) {
    log.error('mark-for-inspection: threw', {
      requestId: gate.requestId,
      err: errToString(caughtErr),
    });
    await releaseClaim();
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }
}
