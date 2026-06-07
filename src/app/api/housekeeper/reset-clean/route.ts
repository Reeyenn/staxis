/**
 * POST /api/housekeeper/reset-clean
 *
 * Housekeeper taps "Start again" on a finished room — reopens it back to
 * dirty (clears started/completed/pause/checklist/exception state). Plan-v4
 * writes the pms assignment row (migration 0269) via writeWorkflowFields.
 *
 * Replaces the legacy room-action 'reset' path for the redesigned page; the
 * old route still exists for any legacy caller but reads the now-empty
 * `rooms` table. Public surface, RLS-bypass: supabaseAdmin + capability
 * check via gateHousekeeperRequest + loadRoomForStaff.
 */

import type { NextRequest } from 'next/server';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import { writeWorkflowFields } from '@/lib/housekeeper-workflow/workflow-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-room-action');
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

  // Capability check (room belongs to this staff via the pms read).
  const roomR = await loadRoomForStaff({
    pid: gate.pid,
    staffId: gate.staffId,
    roomId: body.roomId,
    requestId: gate.requestId,
    headers: gate.headers,
  });
  if (!roomR.ok) return roomR.response;

  const w = await writeWorkflowFields(gate.pid, body.roomId, {
    status: 'dirty',
    started_at: null,
    completed_at: null,
    is_paused: false,
    paused_at: null,
    total_paused_seconds: 0,
    checklist_progress: [],
    exception_type: null,
    exception_note: null,
    exception_at: null,
    is_dnd: false,
  });
  if (!w.ok) {
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  return ok({ roomId: body.roomId }, { requestId: gate.requestId, headers: gate.headers });
}
