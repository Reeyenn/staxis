/**
 * POST /api/front-desk/room-move
 *
 * Move a guest from room A to room B in the same property:
 *   1. Orchestrator rebuilds both rooms (A → dirty/checkout,
 *      B → stayover) + reassigns today's pms_reservation + writes
 *      audit rows to pms_room_status_log. See
 *      src/lib/front-desk-coordination/room-move-orchestrator.ts.
 *   2. dispatchSMS('room_move') fans out to BOTH:
 *      a. Front-desk staff currently on shift ("Confirmed — guest moved
 *         from 305 to 312").
 *      b. Housekeeping managers on shift ("Room move: guest left 305
 *         (needs clean), now in 312").
 *
 * Body:
 *   {
 *     pid: uuid,
 *     today: 'YYYY-MM-DD',
 *     fromRoom: string,
 *     toRoom: string,
 *     reason: 'maintenance' | 'guest_request' | 'upgrade' | 'other',
 *     note?: string (≤500)
 *   }
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import {
  validateUuid,
  validateString,
  validateEnum,
} from '@/lib/api-validate';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  dispatchSMS,
  executeRoomMove,
  findCurrentlyWorkingFrontDesk,
  resolveCallerRole,
  passesFrontDeskGate,
  ROLES_ALLOWED_FRONT_DESK_WRITE,
} from '@/lib/front-desk-coordination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REASONS = ['maintenance', 'guest_request', 'upgrade', 'other'] as const;

interface Body {
  pid?: unknown;
  today?: unknown;
  fromRoom?: unknown;
  toRoom?: unknown;
  reason?: unknown;
  note?: unknown;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);

  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  const pidV = validateUuid(body.pid, 'pid');
  if (pidV.error) {
    return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const pid = pidV.value!;

  const today = typeof body.today === 'string' ? body.today : '';
  if (!DATE_RE.test(today)) {
    return err('today must be YYYY-MM-DD', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const fromV = validateString(body.fromRoom, { max: 10, label: 'fromRoom' });
  if (fromV.error) {
    return err(fromV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const toV = validateString(body.toRoom, { max: 10, label: 'toRoom' });
  if (toV.error) {
    return err(toV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const fromRoom = fromV.value!;
  const toRoom = toV.value!;
  if (fromRoom === toRoom) {
    return err('fromRoom and toRoom must differ', {
      requestId, status: 400, code: ApiErrorCode.ValidationFailed,
    });
  }

  const reasonV = validateEnum(body.reason, REASONS, 'reason');
  if (reasonV.error) {
    return err(reasonV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null && body.note !== '') {
    const v = validateString(body.note, { max: 500, label: 'note' });
    if (v.error) {
      return err(v.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    note = v.value!;
  }

  const callerInfo = await resolveCallerRole(auth.userId);
  if (!passesFrontDeskGate(callerInfo, pid, ROLES_ALLOWED_FRONT_DESK_WRITE)) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit(
    'front-desk-room-move',
    hashToRateLimitKey(`${auth.userId}:${pid}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    // Look up the actor's account_id (for the audit changed_by field).
    let actorAccountId: string | null = null;
    try {
      const { data: acct } = await supabaseAdmin
        .from('accounts')
        .select('id')
        .eq('data_user_id', auth.userId)
        .maybeSingle();
      if (acct) actorAccountId = (acct as { id: string }).id;
    } catch { /* non-fatal */ }

    const result = await executeRoomMove({
      propertyId: pid,
      fromRoom,
      toRoom,
      today,
      reason: reasonV.value!,
      note,
      actorAccountId,
    });

    // Dispatch front-desk + housekeeping pings.
    const [frontDeskRecipients, hkManagerRecipients] = await Promise.all([
      findCurrentlyWorkingFrontDesk(pid),
      listHousekeepingManagersOnShift(pid),
    ]);

    const reasonLabel = reasonV.value!.replace(/_/g, ' ');
    const fdBody = `Confirmed — guest moved from ${fromRoom} to ${toRoom} (${reasonLabel}).`;
    const hkBody = `Room move: guest left ${fromRoom} (needs clean), now in ${toRoom}.`;

    const fdDispatch = await dispatchSMS({
      propertyId: pid,
      eventType: 'room_move',
      body: fdBody,
      payload: {
        from_room: fromRoom,
        to_room: toRoom,
        reason: reasonV.value!,
        note,
        audience: 'front_desk',
        actor_user_id: auth.userId,
      },
      recipients: frontDeskRecipients.map((r) => ({
        staffId: r.staffId, name: r.name, phone: r.phone,
      })),
    });
    const hkDispatch = await dispatchSMS({
      propertyId: pid,
      eventType: 'room_move',
      body: hkBody,
      payload: {
        from_room: fromRoom,
        to_room: toRoom,
        reason: reasonV.value!,
        note,
        audience: 'housekeeping',
        actor_user_id: auth.userId,
      },
      recipients: hkManagerRecipients,
    });

    return ok({
      moved: result.ok,
      fromRoom,
      toRoom,
      reason: reasonV.value,
      orchestration: {
        ok: result.ok,
        fromRoomsUpdated: result.fromRoomsUpdated,
        toRoomsUpdated: result.toRoomsUpdated,
        reservationUpdated: result.reservationUpdated,
        statusLogWritten: result.statusLogWritten,
        errors: result.errors,
      },
      dispatch: {
        front_desk: { mode: fdDispatch.mode, outcomeCount: fdDispatch.outcomes.length },
        housekeeping: { mode: hkDispatch.mode, outcomeCount: hkDispatch.outcomes.length },
      },
    }, { requestId });
  } catch (e) {
    log.error('[front-desk/room-move] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

async function listHousekeepingManagersOnShift(propertyId: string) {
  try {
    // Column names per migration 0147: scheduled_shifts has start_time /
    // end_time, not shift_start_time / shift_end_time. We only need
    // staff_id here — same coarse filter as the walk-in helper above.
    const { data, error } = await supabaseAdmin
      .from('scheduled_shifts')
      .select('staff_id')
      .eq('property_id', propertyId)
      .eq('department', 'housekeeping')
      .eq('kind', 'shift')
      .in('status', ['published', 'sent', 'confirmed'])
      .eq('shift_date', new Date().toISOString().slice(0, 10));
    if (error || !data) return [];

    const staffIds = Array.from(new Set(
      data
        .map((r) => (r as { staff_id?: string | null }).staff_id)
        .filter((id): id is string => typeof id === 'string'),
    ));
    if (staffIds.length === 0) return [];

    const { data: staffRows } = await supabaseAdmin
      .from('staff')
      .select('id, name, phone, is_scheduling_manager')
      .eq('property_id', propertyId)
      .in('id', staffIds);

    return (staffRows ?? [])
      .filter((r) => (r as { is_scheduling_manager?: boolean | null }).is_scheduling_manager === true)
      .map((r) => {
        const row = r as { id: string; name: string; phone: string | null };
        return { staffId: row.id, name: row.name, phone: row.phone };
      });
  } catch {
    return [];
  }
}
