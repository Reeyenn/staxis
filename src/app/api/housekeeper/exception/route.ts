/**
 * POST /api/housekeeper/exception
 *
 * Housekeeper marks a room with one of five exception types:
 *   - dnd       (Do Not Disturb)
 *   - nsr       (No Service Required)
 *   - dla       (Double-Lock Active)
 *   - sleep_out (Guest paid but never arrived)
 *   - skipped   (Could not clean, needs supervisor)
 *
 * Sets rooms.exception_type, rooms.exception_note, rooms.exception_at.
 * Also mirrors to the legacy rooms.is_dnd flag when type === 'dnd' so
 * any older dashboard reads still pick up DND status.
 *
 * Clearing an exception (housekeeper changes their mind) uses the
 * `clear: true` flag instead of a type.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import {
  transition,
  EXCEPTION_TYPES,
  type ExceptionType,
} from '@/lib/housekeeper-workflow/state-machine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
  exceptionType?: ExceptionType;
  note?: string;
  clear?: boolean;
}

function isExceptionType(x: unknown): x is ExceptionType {
  return typeof x === 'string' && (EXCEPTION_TYPES as readonly string[]).includes(x);
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-exception');
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

  const isClear = body.clear === true;
  if (!isClear && !isExceptionType(body.exceptionType)) {
    return err('invalid exceptionType', {
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
    isClear ? 'clear_exception' : 'exception',
    now,
    isClear ? null : (body.exceptionType ?? null),
  );
  if (!result.ok || !result.next) {
    return err(result.reason ?? 'illegal transition', {
      requestId: gate.requestId,
      status: 409,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  const note = (body.note ?? '').slice(0, 500) || null;

  const updatePayload: Record<string, unknown> = {
    exception_type: result.next.exceptionType,
    exception_note: result.next.exceptionType ? note : null,
    exception_at: result.next.exceptionType ? now : null,
    // Transition also resets workflow state on a new exception.
    status: result.next.status,
    started_at: result.next.startedAt,
    completed_at: result.next.completedAt,
    is_paused: result.next.isPaused,
    paused_at: result.next.pausedAt,
    total_paused_seconds: result.next.totalPausedSeconds,
    // Keep legacy is_dnd in sync for any dashboard reads not yet upgraded.
    is_dnd: result.next.exceptionType === 'dnd',
    dnd_note: result.next.exceptionType === 'dnd' ? note : null,
  };

  const { error: updErr } = await supabaseAdmin
    .from('rooms')
    .update(updatePayload)
    .eq('id', body.roomId);
  if (updErr) {
    log.error('exception: room update failed', {
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

  return ok(
    {
      roomId: body.roomId,
      exceptionType: result.next.exceptionType,
      cleared: isClear,
      at: now,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
