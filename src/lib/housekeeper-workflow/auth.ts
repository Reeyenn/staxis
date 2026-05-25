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

import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { err, ApiErrorCode } from '@/lib/api-response';
import { errToString } from '@/lib/utils';
import { log, getOrMintRequestId } from '@/lib/log';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
  type RateLimitEndpoint,
} from '@/lib/api-ratelimit';

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
    const { data: staff, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, property_id, name, is_active')
      .eq('id', staffId)
      .maybeSingle();
    if (staffErr) {
      log.error('housekeeper-workflow: staff lookup failed', {
        requestId,
        endpoint,
        err: errToString(staffErr),
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
    if (!staff || staff.property_id !== pid) {
      return {
        ok: false,
        response: err('staff/property mismatch', {
          requestId,
          status: 403,
          code: ApiErrorCode.Forbidden,
          headers,
        }),
      };
    }
    return {
      ok: true,
      pid,
      staffId,
      staffName: staff.name ?? 'Housekeeper',
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
}

export async function loadRoomForStaff(args: {
  pid: string;
  staffId: string;
  roomId: string;
  requestId: string;
  headers: Record<string, string>;
}): Promise<{ ok: true; room: RoomRowForWorkflow } | { ok: false; response: Response }> {
  const { pid, staffId, roomId, requestId, headers } = args;

  // The select string is wide enough that the supabase-js type inference
  // gives up and returns a GenericStringError shape. We cast the result
  // to our own RoomRowForWorkflow shape — we know the columns exist per
  // migration 0214; if a migration drops one, the runtime cast becomes
  // `undefined` and the route fails closed at the property/assignment
  // checks below.
  const queryRes = await supabaseAdmin
    .from('rooms')
    .select(
      'id, property_id, number, date, type, priority, status, assigned_to, assigned_name, ' +
        'started_at, completed_at, is_dnd, is_paused, paused_at, total_paused_seconds, ' +
        'exception_type, exception_note, exception_at, checklist_template_id, checklist_progress, ' +
        'manager_notes, is_rush, rush_due_by, marked_for_inspection_at, floor',
    )
    .eq('id', roomId)
    .maybeSingle();
  const roomErr = queryRes.error;
  const room = queryRes.data as RoomRowForWorkflow | null;

  if (roomErr || !room) {
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
  if (room.property_id !== pid) {
    return {
      ok: false,
      response: err('room/property mismatch', {
        requestId,
        status: 403,
        code: ApiErrorCode.Forbidden,
        headers,
      }),
    };
  }
  if (room.assigned_to && room.assigned_to !== staffId) {
    return {
      ok: false,
      response: err('room not assigned to this staff', {
        requestId,
        status: 403,
        code: ApiErrorCode.Forbidden,
        headers,
      }),
    };
  }
  return { ok: true, room };
}
