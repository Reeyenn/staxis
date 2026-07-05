/**
 * Shared capability check for all /api/housekeeper/* workflow routes.
 *
 * The housekeeper page is publicly linkable (SMS magic-link). RLS would
 * filter every supabase.from(...) write to zero rows because the visitor
 * has no auth.uid. So we route through supabaseAdmin (service-role) and
 * gate writes with a capability check on (pid, staffId): the staff member
 * must exist on the property and the room (if any) must belong to that
 * staff member.
 *
 * Pattern lifted from src/app/api/housekeeper/room-action/route.ts — kept
 * out of that file so the new workflow routes share one canonical
 * implementation.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import type { Room } from '@/types';
import { mergePmsRoomsForStaff } from '@/lib/pms-rooms-server';
import { log, getOrMintRequestId } from '@/lib/log';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
  type RateLimitEndpoint,
} from '@/lib/api-ratelimit';
import { verifyStaffLinkToken } from '@/lib/staff-link-auth';

export interface CapabilityOk<TBody> {
  ok: true;
  pid: string;
  staffId: string;
  staffName: string;
  requestId: string;
  headers: Record<string, string>;
  body: TBody;
}

export interface CapabilityFail {
  ok: false;
  response: Response;
}

export type CapabilityResult<TBody> = CapabilityOk<TBody> | CapabilityFail;

/**
 * Parse the request body, validate (pid, staffId), apply rate limit, and
 * confirm the staff member belongs to the property. Returns either the
 * verified identity + parsed body, or a Response the route should return
 * immediately.
 *
 * The body is typed to whatever shape `TBody` the caller passes — we
 * only inspect `pid` and `staffId` here; everything else passes through
 * untouched.
 */
export async function gateHousekeeperRequest<TBody extends { pid?: unknown; staffId?: unknown }>(
  req: NextRequest,
  endpoint: RateLimitEndpoint,
): Promise<CapabilityResult<TBody>> {
  const requestId = getOrMintRequestId(req);
  const headers = { 'x-request-id': requestId };

  let body: TBody;
  try {
    body = (await req.json()) as TBody;
  } catch {
    return {
      ok: false,
      response: err('invalid json', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
        headers,
      }),
    };
  }

  const pid = typeof body.pid === 'string' ? body.pid : '';
  const staffId = typeof body.staffId === 'string' ? body.staffId : '';
  if (!pid || !staffId) {
    return {
      ok: false,
      response: err('missing pid/staffId', {
        requestId,
        status: 400,
        code: ApiErrorCode.ValidationFailed,
        headers,
      }),
    };
  }

  const rl = await checkAndIncrementRateLimit(endpoint, hashToRateLimitKey(`${pid}:${staffId}`));
  if (!rl.allowed) {
    return { ok: false, response: rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec) };
  }

  try {
    // Security audit 2026-06-26 #1: the credential is the per-staff link token
    // (`tok`), NOT the (pid, staffId) tuple. verifyStaffLinkToken resolves
    // identity from the token, confirms it's bound to this pid+staffId, and
    // enforces the is_active gate. A raw tuple with no valid token is rejected.
    const bodyToken = (body as { tok?: unknown }).tok;
    const verified = await verifyStaffLinkToken(req, { pid, staffId, requestId, bodyToken });
    if (!verified.ok) {
      return { ok: false, response: verified.response };
    }
    return {
      ok: true,
      pid,
      staffId,
      staffName: verified.staff.name || 'Housekeeper',
      requestId,
      headers,
      body,
    };
  } catch (caughtErr) {
    log.error('housekeeper-workflow: unexpected gate error', {
      requestId,
      endpoint,
      err: errToString(caughtErr),
    });
    return {
      ok: false,
      response: err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers,
      }),
    };
  }
}

/**
 * Fetch the room and confirm it's on the property AND either unassigned or
 * assigned to this staff. Returns the row or a Response.
 *
 * Pulls every workflow-relevant column so the route handlers don't need
 * a second round-trip just to read state.
 */
export interface RoomRowForWorkflow {
  id: string;
  property_id: string;
  number: string | null;
  date: string | null;
  type: string | null;
  priority: string | null;
  status: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  is_dnd: boolean | null;
  is_paused: boolean | null;
  paused_at: string | null;
  total_paused_seconds: number | null;
  exception_type: string | null;
  exception_note: string | null;
  exception_at: string | null;
  checklist_template_id: string | null;
  checklist_progress: unknown;
  manager_notes: string | null;
  is_rush: boolean | null;
  rush_due_by: string | null;
  marked_for_inspection_at: string | null;
  floor: string | null;
  // stayover_day comes off the legacy rooms columns (0-indexed: 0 = arrival
  // day, 1 = light, 2 = full, ...). complete-clean buckets it into the
  // cleaning_events row so the supply ML model sees the same shape as the
  // legacy room-action route. Missing this column means every new
  // cleaning_events row had stayover_day=null after the rebuild.
  stayover_day: number | null;
}

export async function loadRoomForStaff(args: {
  pid: string;
  staffId: string;
  roomId: string;
  requestId: string;
  headers: Record<string, string>;
}): Promise<{ ok: true; room: RoomRowForWorkflow } | { ok: false; response: NextResponse }> {
  const { pid, staffId, roomId, requestId, headers } = args;

  // Plan-v4: rooms live in the pms_* schema, not the (empty) legacy `rooms`
  // table. Read through the same merge the page uses — it applies the staff
  // capability filter (only rooms assigned to this staff by name) and
  // surfaces the workflow-state columns (migration 0269). A roomId that
  // isn't in this staff's set → 404 (also blocks cross-staff enumeration).
  let rooms: Room[];
  try {
    rooms = await mergePmsRoomsForStaff(pid, staffId);
  } catch (e) {
    log.error('[loadRoomForStaff] pms read failed', {
      requestId, pid, staffId, msg: errToString(e),
    });
    return {
      ok: false,
      response: err('Internal server error', {
        requestId,
        status: 500,
        code: ApiErrorCode.InternalError,
        headers,
      }),
    };
  }
  const room = rooms.find((r) => r.id === roomId);
  if (!room) {
    return {
      ok: false,
      response: err('room not found', {
        requestId,
        status: 404,
        code: ApiErrorCode.NotFound,
        headers,
      }),
    };
  }
  return { ok: true, room: roomToWorkflowRow(room, pid) };
}

// Map the merged Room (pms read shape) onto the legacy RoomRowForWorkflow the
// workflow endpoints' state-machine logic expects — so those routes keep
// working unchanged while reading from pms_*.
function roomToWorkflowRow(room: Room, pid: string): RoomRowForWorkflow {
  const iso = (d: Date | string | null | undefined): string | null =>
    d ? new Date(d).toISOString() : null;
  return {
    id: room.id,
    property_id: pid,
    number: room.number,
    date: room.date,
    type: room.type,
    priority: room.priority,
    status: room.status,
    assigned_to: room.assignedTo ?? null,
    assigned_name: room.assignedName ?? null,
    started_at: iso(room.startedAt),
    completed_at: iso(room.completedAt),
    is_dnd: room.isDnd ?? null,
    is_paused: room.isPaused ?? null,
    paused_at: iso(room.pausedAt),
    total_paused_seconds: room.totalPausedSeconds ?? null,
    exception_type: room.exceptionType ?? null,
    exception_note: room.exceptionNote ?? null,
    exception_at: iso(room.exceptionAt),
    checklist_template_id: room.checklistTemplateId ?? null,
    checklist_progress: room.checklistProgress ?? null,
    manager_notes: room.managerNotes ?? null,
    is_rush: room.isRush ?? null,
    rush_due_by: iso(room.rushDueBy),
    marked_for_inspection_at: iso(room.markedForInspectionAt),
    floor: room.floor ?? null,
    stayover_day: room.stayoverDay ?? null,
  };
}
