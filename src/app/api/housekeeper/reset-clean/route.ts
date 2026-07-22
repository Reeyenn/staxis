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
import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';

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
    // Reopening a finished room invalidates its inspection sign-off — clear it
    // so re-cleaning doesn't re-derive a false 'inspected' state (which would
    // also drop the room from the re-inspection queue).
    inspected_at: null,
    inspected_by: null,
  });
  if (!w.ok) {
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  // Discard the latest non-discarded cleaning_events row for this room so a
  // re-clean doesn't double-count. Mirrors the legacy room-action 'reset' path
  // the redesigned page replaced: complete-clean already wrote a 'recorded'
  // event, and without discarding it a subsequent re-clean inserts a SECOND
  // event — counting the single physical clean twice in Performance metrics and
  // the supply-ML training set. Non-fatal: the assignment reset already landed.
  const roomDate = roomR.room.date;
  const roomNumber = roomR.room.number;
  if (roomDate && roomNumber) {
    const { data: latest } = await supabaseAdmin
      .from('cleaning_events')
      .select('id')
      .eq('property_id', gate.pid)
      .eq('date', roomDate)
      .eq('room_number', roomNumber)
      .eq('staff_id', gate.staffId)
      .in('status', ['recorded', 'flagged'])
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.id) {
      const { error: discardErr } = await supabaseAdmin
        .from('cleaning_events')
        .update({ status: 'discarded', flag_reason: 'reset_by_user' })
        .eq('id', latest.id as string);
      if (discardErr) {
        log.error('reset-clean: cleaning_events discard failed (non-fatal)', {
          requestId: gate.requestId, pid: gate.pid, staffId: gate.staffId, err: discardErr,
        });
      }
    }
  }

  return ok({ roomId: body.roomId }, { requestId: gate.requestId, headers: gate.headers });
}
