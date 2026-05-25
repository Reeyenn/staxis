/**
 * POST /api/housekeeper/checklist/toggle
 *
 * Toggle a checklist item on/off for a room. Stored as a jsonb array of
 * completed item IDs in `rooms.checklist_progress`. Toggle is idempotent:
 * sending the same id twice keeps it in the same state if `checked` is
 * passed explicitly; otherwise it flips.
 */

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { gateHousekeeperRequest, loadRoomForStaff } from '@/lib/housekeeper-workflow/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

interface Body {
  pid?: string;
  staffId?: string;
  roomId?: string;
  itemId?: string;
  checked?: boolean; // explicit set; if omitted, toggle current state
}

export async function POST(req: NextRequest): Promise<Response> {
  const gate = await gateHousekeeperRequest<Body>(req, 'housekeeper-checklist-toggle');
  if (!gate.ok) return gate.response;
  const body = gate.body;
  if (!body.roomId || !body.itemId) {
    return err('missing roomId/itemId', {
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

  // Parse the current progress array. Defensive against stale shapes
  // and accidental string values in the jsonb column.
  const raw = room.checklist_progress;
  const current: string[] = Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const hasItem = current.includes(body.itemId);

  let next: string[];
  let isChecked: boolean;
  if (typeof body.checked === 'boolean') {
    isChecked = body.checked;
    if (body.checked && !hasItem) {
      next = [...current, body.itemId];
    } else if (!body.checked && hasItem) {
      next = current.filter((x) => x !== body.itemId);
    } else {
      next = current;
    }
  } else {
    isChecked = !hasItem;
    next = hasItem ? current.filter((x) => x !== body.itemId) : [...current, body.itemId];
  }

  const { error: updErr } = await supabaseAdmin
    .from('rooms')
    .update({ checklist_progress: next })
    .eq('id', body.roomId);
  if (updErr) {
    log.error('checklist-toggle: room update failed', {
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
      itemId: body.itemId,
      checked: isChecked,
      checkedCount: next.length,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
