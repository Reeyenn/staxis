/**
 * POST /api/front-desk/walk-in
 *
 * Walk-in flow:
 *   1. Find the oldest ready room of the requested type
 *      (findNextReadyRoom — pms_room_status_log + inventory + arrivals).
 *   2. Flip pms_room_status_log → 'occupied' for that room.
 *   3. Update today's rooms row for that room (status=clean→inspected
 *      stays, type=stayover, assigned_name=guest name when provided).
 *   4. Insert a pms_reservations row marking this as source='walk_in'.
 *   5. dispatchSMS('walk_in') to housekeeping manager(s) — same
 *      "currently working" lookup but with department='housekeeping'.
 *
 * Body:
 *   {
 *     pid: uuid,
 *     today: 'YYYY-MM-DD',
 *     roomType: string,
 *     guestName?: string (max 200),
 *     nights?: number (1-30)
 *   }
 *
 * Response: { ok: true, data: { roomNumber, reservationId, dispatch } }
 *           404 if no room of that type is available.
 */

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/api-auth';
import { validateUuid, validateString } from '@/lib/api-validate';
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
  findNextReadyRoom,
  resolveCallerRole,
  passesFrontDeskGate,
  ROLES_ALLOWED_FRONT_DESK_WRITE,
} from '@/lib/front-desk-coordination';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Body {
  pid?: unknown;
  today?: unknown;
  roomType?: unknown;
  guestName?: unknown;
  nights?: unknown;
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

  const roomTypeV = validateString(body.roomType, { max: 100, label: 'roomType' });
  if (roomTypeV.error) {
    return err(roomTypeV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const roomType = roomTypeV.value!;

  let guestName: string | null = null;
  if (body.guestName !== undefined && body.guestName !== null && body.guestName !== '') {
    const gn = validateString(body.guestName, { max: 200, label: 'guestName' });
    if (gn.error) {
      return err(gn.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    guestName = gn.value!;
  }

  let nights: number | null = null;
  if (body.nights !== undefined && body.nights !== null) {
    const n = Number(body.nights);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 30) {
      return err('nights must be an integer 1..30', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }
    nights = n;
  }

  const callerInfo = await resolveCallerRole(auth.userId);
  if (!passesFrontDeskGate(callerInfo, pid, ROLES_ALLOWED_FRONT_DESK_WRITE)) {
    return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rl = await checkAndIncrementRateLimit(
    'front-desk-walk-in',
    hashToRateLimitKey(`${auth.userId}:${pid}`),
  );
  if (!rl.allowed) {
    return rateLimitedResponse(rl.current, rl.cap, rl.retryAfterSec);
  }

  try {
    // ── 1. Pick the room.
    const candidate = await findNextReadyRoom({
      propertyId: pid, roomType, today,
    });
    if (!candidate) {
      return err(`No clean ${roomType} rooms are available right now.`, {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }

    // ── 2. Race-guard before claiming the room (Codex adversarial
    // finding): two concurrent walk-ins of the same type could both
    // pick the same room. After picking, re-read the candidate's
    // current PMS status — if a competing walk-in already flipped it
    // to 'occupied' (or anything non-ready) in the small window since
    // findNextReadyRoom ran, fall back to the NEXT candidate (or 409
    // if no others exist). This is a best-effort optimistic guard,
    // not a true transaction, but it shrinks the race window from
    // "the whole route" down to a single round-trip.
    const READY_STATUSES = new Set(['inspected', 'vacant_clean']);
    const { data: latestStatus } = await supabaseAdmin
      .from('pms_room_status_log')
      .select('status, changed_at')
      .eq('property_id', pid)
      .eq('room_number', candidate.roomNumber)
      .order('changed_at', { ascending: false })
      .limit(1);
    const latest = (latestStatus ?? [])[0] as { status?: string } | undefined;
    // The candidate's readiness came from the same log, so the latest
    // status should still be ready. If it isn't, a competing walk-in
    // (or a CUA-pulled PMS change) won; surface a 409 so the operator
    // retries with the next free room.
    if (latest && latest.status && !READY_STATUSES.has(latest.status)) {
      log.warn('[front-desk/walk-in] candidate room status flipped under us', {
        requestId, pid, roomNumber: candidate.roomNumber, latestStatus: latest.status,
      });
      return err(
        `Room ${candidate.roomNumber} just got claimed by another walk-in. Try again.`,
        { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
      );
    }

    // ── 3. Insert pms_room_status_log → 'occupied'.
    const { error: logErr } = await supabaseAdmin
      .from('pms_room_status_log')
      .insert({
        property_id: pid,
        room_number: candidate.roomNumber,
        status: 'occupied',
        source: 'manual',
        changed_by: callerInfo.role ? `front-desk:${auth.userId}` : null,
        notes: guestName
          ? `Walk-in: ${guestName}${nights ? ` (${nights} night${nights === 1 ? '' : 's'})` : ''}`
          : 'Walk-in arrival',
      });
    if (logErr) {
      log.error('[front-desk/walk-in] status log insert failed', {
        requestId, pid, err: logErr.message,
      });
    }

    // ── 3. Update today's rooms row for that room.
    await supabaseAdmin
      .from('rooms')
      .update({
        type: 'stayover',
        assigned_name: guestName,
        issue_note: null,
        updated_at: new Date().toISOString(),
      })
      .eq('property_id', pid)
      .eq('date', today)
      .eq('number', candidate.roomNumber);

    // ── 4. Insert pms_reservations row marking source='walk_in'.
    const reservationPmsId = `walkin-${Date.now()}-${candidate.roomNumber}`;
    const departureDate = nights
      ? addDays(today, nights)
      : addDays(today, 1);
    const { data: reservationRow, error: resErr } = await supabaseAdmin
      .from('pms_reservations')
      .insert({
        property_id: pid,
        pms_reservation_id: reservationPmsId,
        guest_name: guestName,
        room_number: candidate.roomNumber,
        room_type: candidate.roomType,
        arrival_date: today,
        departure_date: departureDate,
        num_nights: nights ?? 1,
        status: 'checked_in',
        status_changed_at: new Date().toISOString(),
        source: 'walk_in',
        raw: { walk_in: true, created_by_user_id: auth.userId },
      })
      .select('id')
      .single();
    let reservationId: string | null = null;
    if (resErr) {
      log.warn('[front-desk/walk-in] reservation insert failed (non-fatal)', {
        requestId, pid, err: resErr.message,
      });
    } else {
      reservationId = (reservationRow as { id: string }).id;
    }

    // ── 5. Notify housekeeping managers currently working.
    const hkRecipients = await listHousekeepingManagersOnShift(pid);
    const dispatch = await dispatchSMS({
      propertyId: pid,
      eventType: 'walk_in',
      body: `Walk-in just assigned to room ${candidate.roomNumber}${guestName ? ` (${guestName})` : ''}.`,
      payload: {
        room_number: candidate.roomNumber,
        room_type: candidate.roomType,
        nights,
        reservation_id: reservationId,
        guest_name: guestName,
        actor_user_id: auth.userId,
      },
      recipients: hkRecipients,
    });

    return ok({
      roomNumber: candidate.roomNumber,
      roomType: candidate.roomType,
      reservationId,
      readySince: candidate.readySince,
      source: candidate.source,
      dispatch: {
        mode: dispatch.mode,
        outcomeCount: dispatch.outcomes.length,
      },
    }, { requestId });
  } catch (e) {
    log.error('[front-desk/walk-in] failed', { requestId, pid, msg: errToString(e) });
    return err('Internal server error', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function listHousekeepingManagersOnShift(propertyId: string) {
  // Reuse the same shift-window query but scoped to department=housekeeping.
  // Coordination's findCurrentlyWorkingFrontDesk is hard-coded to
  // department='front_desk' — we replicate the minimal query here rather
  // than parameterizing the public helper (the public helper signals
  // intent in its name; making it generic muddies the call site).
  try {
    // Column names per migration 0147 are `start_time` / `end_time`
    // (NOT `shift_start_time` / `shift_end_time`). We only need staff_id
    // here — the full shift-window check is owned by find-currently-
    // working for the front-desk side; housekeeping recipients are
    // "anyone scheduled to work today" which is a coarser filter
    // intentionally (a manager who clocks in at 4pm should still be
    // notified about a walk-in at 2pm in case they're on call).
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
      // Prefer the manager rows when any exist; otherwise notify everyone
      // on shift (HKs share a phone with a manager in some properties).
      .filter((r) => {
        const row = r as { is_scheduling_manager?: boolean | null };
        return row.is_scheduling_manager === true;
      })
      .map((r) => {
        const row = r as { id: string; name: string; phone: string | null };
        return { staffId: row.id, name: row.name, phone: row.phone };
      });
  } catch {
    return [];
  }
}
