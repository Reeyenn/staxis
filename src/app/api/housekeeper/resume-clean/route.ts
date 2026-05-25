/**
 * POST /api/housekeeper/resume-clean
 *
 * Housekeeper taps "Resume" after pausing. Accumulates the elapsed pause
 * time into `rooms.total_paused_seconds`, clears `is_paused` and
 * `paused_at`, and closes the open `room_pause_events` audit row.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import { transition } from '@/lib/housekeeper-workflow/state-machine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-resume-clean');
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
    'resume',
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

  const { error: updErr } = await supabaseAdmin
    .from('rooms')
    .update({
      is_paused: false,
      paused_at: null,
      total_paused_seconds: result.next.totalPausedSeconds,
    })
    .eq('id', body.roomId);
  if (updErr) {
    log.error('resume-clean: room update failed', {
      requestId: gate.requestId,
      pid: gate.pid,
      staffId: gate.staffId,
      err: errToString(updErr),
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  // Close the open audit row.
  try {
    const { data: openRow } = await supabaseAdmin
      .from('room_pause_events')
      .select('id')
      .eq('room_id', body.roomId)
      .is('resumed_at', null)
      .order('paused_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (openRow?.id) {
      await supabaseAdmin
        .from('room_pause_events')
        .update({ resumed_at: now })
        .eq('id', openRow.id as string);
    }
  } catch (auditErr) {
    log.warn('resume-clean: audit close failed (non-fatal)', {
      requestId: gate.requestId,
      pid: gate.pid,
      staffId: gate.staffId,
      err: errToString(auditErr),
    });
  }

  return ok(
    {
      roomId: body.roomId,
      resumedAt: now,
      totalPausedSeconds: result.next.totalPausedSeconds,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
