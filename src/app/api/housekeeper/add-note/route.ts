/**
 * POST /api/housekeeper/add-note
 *
 * Housekeeper attaches a quick note to a room. Distinct from "Report
 * Issue" — this doesn't open a work order. The note lands on
 * `rooms.housekeeper_note` so manager dashboards can see it, and an
 * audit row goes into housekeeper_audit_log.
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
  noteText?: string;
  /** Empty string or null clears the note. */
  actionId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-add-note');
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

  // Idempotency — insert-first pattern (see structured-issue/route.ts).
  if (body.actionId) {
    const { data: claimed } = await supabaseAdmin
      .from('offline_action_replays')
      .insert({
        action_id: body.actionId,
        property_id: gate.pid,
        staff_id: gate.staffId,
        endpoint: 'add-note',
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

  const roomR = await loadRoomForStaff({
    pid: gate.pid,
    staffId: gate.staffId,
    roomId: body.roomId,
    requestId: gate.requestId,
    headers: gate.headers,
  });
  if (!roomR.ok) return roomR.response;
  const room = roomR.room;

  const noteText = (body.noteText ?? '').trim().slice(0, 1000);
  const now = new Date();

  try {
    const w = await writeWorkflowFields(gate.pid, body.roomId, {
      housekeeper_note: noteText || null,
      housekeeper_note_at: noteText ? now.toISOString() : null,
    });
    if (!w.ok) {
      log.error('add-note: update failed', {
        requestId: gate.requestId,
        err: w.error,
      });
      return err('Internal server error', {
        requestId: gate.requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers: gate.headers,
      });
    }

    // Audit log
    try {
      const today = room.date ?? now.toISOString().slice(0, 10);
      await supabaseAdmin.from('housekeeper_audit_log').insert({
        property_id: gate.pid,
        staff_id: gate.staffId,
        business_date: today,
        room_id: body.roomId,
        room_number: room.number,
        event_type: 'add_note',
        payload: { note: noteText, cleared: !noteText },
      });
    } catch (auditErr) {
      log.warn('add-note: audit log failed (non-fatal)', {
        requestId: gate.requestId,
        err: errToString(auditErr),
      });
    }

    const result = { saved: true, noteText: noteText || null };

    if (body.actionId) {
      try {
        await supabaseAdmin
          .from('offline_action_replays')
          .update({ result_payload: result })
          .eq('action_id', body.actionId);
      } catch (replayErr) {
        log.warn('add-note: replay log update failed', {
          requestId: gate.requestId, err: errToString(replayErr),
        });
      }
    }

    return ok(result, { requestId: gate.requestId, headers: gate.headers });
  } catch (caughtErr) {
    log.error('add-note: threw', {
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
