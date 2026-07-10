/**
 * POST /api/housekeeper/start-clean
 *
 * Housekeeper taps "Start" on a room. Transitions the room from
 * `dirty` → `in_progress` and records `started_at`.
 *
 * Replaces the single-tap-Done flow that lived in
 * /api/housekeeper/room-action 'finish'. Started_at is the real
 * tap-time now, not derived server-side.
 *
 * Public surface, RLS-bypass: supabaseAdmin + capability check via
 * gateHousekeeperRequest. Same rationale as the rest of the
 * /api/housekeeper/* family.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';
import { writeWorkflowFields } from '@/lib/housekeeper-workflow/workflow-store';
import { transition, inferCleaningType } from '@/lib/housekeeper-workflow/state-machine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-start-clean');
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
    'start',
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

  // Pick the right checklist template the first time the room is started.
  // Re-Start (after a Reset) keeps the same template so progress doesn't
  // shift under the housekeeper's fingers.
  let templateId: string | null = room.checklist_template_id;
  if (!templateId) {
    const cleaningType = inferCleaningType(room.type);
    const { data: tpl } = await supabaseAdmin
      .from('cleaning_checklist_templates')
      .select('id')
      // Per-property template only — no global-default fallback (0305). A hotel
      // with no checklist starts the room with no steps (templateId stays null).
      .eq('property_id', gate.pid)
      .eq('cleaning_type', cleaningType)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();
    if (tpl?.id) templateId = tpl.id as string;
  }

  // Persist to the pms assignment row (Plan-v4; migration 0269). The state
  // machine above already validated the dirty/no-exception precondition off
  // the freshly-read row, so we write the new state directly.
  const w = await writeWorkflowFields(gate.pid, body.roomId, {
    status: result.next.status,
    started_at: result.next.startedAt,
    completed_at: null,
    is_paused: false,
    paused_at: null,
    total_paused_seconds: 0,
    checklist_template_id: templateId,
    checklist_progress: [],
  });
  if (!w.ok) {
    log.error('start-clean: write failed', {
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
      startedAt: result.next.startedAt,
      checklistTemplateId: templateId,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
