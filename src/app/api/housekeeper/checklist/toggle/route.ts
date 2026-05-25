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

  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
    'staxis_checklist_toggle',
    {
      p_room_id: body.roomId,
      p_item_id: body.itemId,
      p_checked: nextChecked,
    },
  );
  if (rpcErr) {
    log.error('checklist-toggle: rpc failed', {
      requestId: gate.requestId,
      pid: gate.pid,
      staffId: gate.staffId,
      err: errToString(rpcErr),
    });
    return err('Internal server error', {
      requestId: gate.requestId,
      status: 500,
      code: ApiErrorCode.InternalError,
      headers: gate.headers,
    });
  }

  type ToggleRow = {
    new_checked_count: number;
    is_checked: boolean;
    template_mismatch: boolean;
  };
  const row = Array.isArray(rpcResult) && rpcResult.length > 0
    ? (rpcResult[0] as ToggleRow)
    : null;

  if (row?.template_mismatch) {
    return err('checklist item does not belong to this room\'s template', {
      requestId: gate.requestId,
      status: 409,
      code: ApiErrorCode.ValidationFailed,
      headers: gate.headers,
    });
  }

  return ok(
    {
      roomId: body.roomId,
      itemId: body.itemId,
      checked: row?.is_checked ?? nextChecked,
      checkedCount: row?.new_checked_count ?? 0,
    },
    { requestId: gate.requestId, headers: gate.headers },
  );
}
