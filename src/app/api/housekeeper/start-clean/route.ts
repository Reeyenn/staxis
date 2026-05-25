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
      // Property-specific override wins if present, default otherwise.
      .or(`property_id.eq.${gate.pid},and(property_id.is.null,is_default.eq.true)`)
      .eq('cleaning_type', cleaningType)
      .eq('is_active', true)
      .order('property_id', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (tpl?.id) templateId = tpl.id as string;
  }

  // Conditional UPDATE: only flip to in_progress if the row is still
  // exactly the dirty/no-exception state we read above. If a second
  // device already started the room (or set an exception, or completed
  // it), the row count comes back 0 and we 409 — preventing two devices
  // from both racing into in_progress and stomping each other's
  // started_at + checklist_progress.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('rooms')
    .update({
      status: result.next.status,
      started_at: result.next.startedAt,
      completed_at: null,
      is_paused: false,
      paused_at: null,
      total_paused_seconds: 0,
      checklist_template_id: templateId,
      checklist_progress: [],
    })
    .eq('id', body.roomId)
    .eq('status', 'dirty')
    .is('exception_type', null)
    .select('id');

  if (updErr) {
    log.error('start-clean: update failed', {
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
  if (!updated || updated.length === 0) {
    // Room state shifted under us between the read and the conditional
    // write — another device already started, an exception was set, or
    // the room moved past dirty. Surface a 409 so the client can refetch.
    return err('room state changed', {
      requestId: gate.requestId,
      status: 409,
      code: ApiErrorCode.ValidationFailed,
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
