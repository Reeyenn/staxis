/**
 * POST /api/housekeeper/resume-clean
 *
 * Housekeeper taps "Resume" after pausing. Accumulates the elapsed pause
 * time into the assignment's total_paused_seconds, clears is_paused and
 * paused_at.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
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

  // Persist to the pms assignment row (Plan-v4; migration 0269).
  const w = await writeWorkflowFields(gate.pid, body.roomId, {
    is_paused: false,
    paused_at: null,
    total_paused_seconds: result.next.totalPausedSeconds,
  });
  if (!w.ok) {
    log.error('resume-clean: write failed', {
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

  return ok(
    {
      roomId: body.roomId,
      resumedAt: now,
      totalPausedSeconds: result.next.totalPausedSeconds,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
