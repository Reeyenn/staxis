/**
 * POST /api/housekeeper/checklist/toggle
 *
 * Toggle a checklist item on/off for a room. Backed by the
 * staxis_checklist_toggle RPC (migration 0215) which:
 *   1. Locks the rooms row.
 *   2. Verifies the item belongs to the room's current checklist
 *      template (stale UIs / forged taps with a foreign template's
 *      item ID get a 409).
 *   3. Atomically updates the jsonb array without read-modify-write
 *      loss under concurrent toggles.
 *
 * Toggle semantics: if `checked` is omitted, the route flips the current
 * state (reads first, then flips). Explicit `checked=true|false` lets
 * the client be authoritative when it knows what it wants.
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

  // Resolve the desired post-toggle state. If `checked` is supplied,
  // trust it. Otherwise flip whatever the current jsonb says — small
  // race window here is fine because the RPC below is idempotent on the
  // explicit boolean.
  const raw = room.checklist_progress;
  const currentList = Array.isArray(raw)
    ? (raw as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const nextChecked = typeof body.checked === 'boolean'
    ? body.checked
    : !currentList.includes(body.itemId);

  // Plan-v4: persist checklist progress on the pms assignment row
  // (migration 0269) instead of the legacy `rooms` jsonb + RPC.
  const nextList = nextChecked
    ? Array.from(new Set([...currentList, body.itemId]))
    : currentList.filter((x) => x !== body.itemId);

  const w = await writeWorkflowFields(gate.pid, body.roomId, {
    checklist_progress: nextList,
  });
  if (!w.ok) {
    log.error('checklist-toggle: write failed', {
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
      itemId: body.itemId,
      checked: nextChecked,
      checkedCount: nextList.length,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
