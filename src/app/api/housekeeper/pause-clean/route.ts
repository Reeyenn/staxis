/**
 * POST /api/housekeeper/pause-clean
 *
 * Housekeeper taps "Pause" while cleaning. Records the pause start
 * and logs an audit row in `room_pause_events`. Room stays
 * `in_progress` but with `is_paused=true` so the UI can render the
 * pause chip and the resume button.
 *
 * Pause durations accumulate into `rooms.total_paused_seconds` on
 * Resume (or on Done if the user goes straight from paused to done).
 * The cleaning-event audit row uses ACTIVE duration (elapsed minus
 * paused).
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import { writeWorkflowFields } from '@/lib/housekeeper-workflow/workflow-store';
import { transition } from '@/lib/housekeeper-workflow/state-machine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
  reason?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-pause-clean');
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

  const roomR = await loadRoomForStaff({
    pid: gate.pid,
    staffId: gate.staffId,
    roomId: body.roomId,
    requestId: gate.requestId,
    headers: gate.headers,
  });
  if (!roomR.ok) return roomR.response;
  const room = roomR.room;

  const now = new Date().toISOString();
  const result = transition(
    {
      status: (room.status as 'dirty' | 'in_progress' | 'clean' | 'inspected') ?? 'dirty',
      isPaused: !!room.is_paused,
      exceptionType: (room.exception_type as never) ?? null,
      startedAt: room.started_at,
      pausedAt: room.paused_at,
      completedAt: room.completed_at,
      totalPausedSeconds: room.total_paused_seconds ?? 0,
    },
    'pause',
    now,
  );
  if (!result.ok || !result.next) {
    return err(result.reason ?? 'illegal transition', {
      requestId: gate.requestId,
      status: 409,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  // Persist to the pms assignment row (Plan-v4; migration 0269).
  const w = await writeWorkflowFields(gate.pid, body.roomId, {
    is_paused: true,
    paused_at: now,
  });
  if (!w.ok) {
    log.error('pause-clean: write failed', {
      requestId: gate.requestId,
      pid: gate.pid,
      staffId: gate.staffId,
      err: w.error,
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  // Audit row in room_pause_events. Non-fatal — the room update already
  // succeeded and we'd rather the housekeeper not see an error than
  // bother them about an audit-only failure.
  try {
    if (room.date) {
      await supabaseAdmin.from('room_pause_events').insert({
        property_id: gate.pid,
        room_id: body.roomId,
        staff_id: gate.staffId,
        business_date: room.date,
        paused_at: now,
        reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null,
      });
    }
  } catch (auditErr) {
    log.warn('pause-clean: audit insert failed (non-fatal)', {
      requestId: gate.requestId,
      pid: gate.pid,
      staffId: gate.staffId,
      err: errToString(auditErr),
    });
  }

  return ok(
    { roomId: body.roomId, pausedAt: now },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
