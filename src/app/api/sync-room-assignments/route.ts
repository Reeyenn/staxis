/**
 * POST /api/sync-room-assignments
 *
 * Mirrors the room-level `assigned_to`/`assigned_name` writes that
 * /api/send-shift-confirmations does — BUT without sending any SMS or
 * touching shift_confirmations.
 *
 * Called by the Schedule tab's debounced autosave so that every drag-and-drop
 * change is reflected on the `rooms` rows themselves in real time. This fixes
 * the bug where clicking the crew-row "Link" button before hitting Send would
 * open the HK's page with stale (or no) rooms — because the HK page queries
 * `rooms where assigned_to = staffId` and only the Send flow used to write
 * that field.
 *
 * Body:
 *   {
 *     pid, shiftDate,                           // required
 *     staff: [
 *       { staffId, staffName, assignedRooms }  // room NUMBERS
 *     ],
 *     allowClearAll?: boolean,                  // bypass "all empty" failsafe
 *     uid?: string,                             // legacy — ignored
 *   }
 */
import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { errToString } from '@/lib/utils';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import {
  validateUuid, validateString, validateArray, validateDateStr, LIMITS,
} from '@/lib/api-validate';
import { checkAndIncrementRateLimit, rateLimitedResponse } from '@/lib/api-ratelimit';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { log, getOrMintRequestId } from '@/lib/log';
import { writeErrorLog } from '@/lib/error-log';

interface StaffEntry {
  staffId: string;
  staffName: string;
  assignedRooms?: string[];
}

interface RequestBody {
  pid: string;
  shiftDate: string;
  staff: StaffEntry[];
  allowClearAll?: boolean;
  uid?: string;
}

type PlanRoom = { number: string; stayType?: string | null };

function deriveRoomType(
  number: string,
  planRooms: PlanRoom[] | null,
): 'checkout' | 'stayover' {
  if (!planRooms) return 'checkout';
  const match = planRooms.find(r => r.number === number);
  if (!match) return 'checkout';
  return match.stayType === 'Stay' ? 'stayover' : 'checkout';
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  // Auth: writes to rooms table (assigns/unassigns staff). Without auth
  // any caller could blank out today's room assignments.
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  try {
    const body = await req.json().catch(() => null) as RequestBody | null;
    if (!body || typeof body !== 'object') {
      return err('Invalid JSON body', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }

    // ── Strict validation ───────────────────────────────────────────────────
    // Goal: anything that ends up on a SQL update or in a `rooms.number`
    // column has been confirmed to be the right shape and within sane size
    // limits. Without this, a manager browser bug or a hostile pen-test can
    // push thousands of rows or unbounded strings through the rooms table.
    const pidV = validateUuid(body.pid, 'pid');
    if (pidV.error) return err(pidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const dateV = validateDateStr(body.shiftDate, { allowFutureDays: LIMITS.SHIFT_DATE_FUTURE_DAYS, allowPastDays: 14, label: 'shiftDate' });
    if (dateV.error) return err(dateV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

    const staffArrV = validateArray<unknown>(body.staff, { max: LIMITS.STAFF_ARRAY_MAX, label: 'staff' });
    if (staffArrV.error) return err(staffArrV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    const rawStaff = staffArrV.value!;

    const staff: StaffEntry[] = [];
    for (let i = 0; i < rawStaff.length; i++) {
      const e = rawStaff[i];
      if (!e || typeof e !== 'object') {
        return err(`staff[${i}] not an object`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      const ee = e as Record<string, unknown>;
      const sidV = validateUuid(ee.staffId, `staff[${i}].staffId`);
      if (sidV.error) return err(sidV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      const nameV = validateString(ee.staffName, { max: LIMITS.STAFF_NAME_MAX, label: `staff[${i}].staffName` });
      if (nameV.error) return err(nameV.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });

      // assignedRooms: optional array of short strings.
      const rooms: string[] = [];
      if (ee.assignedRooms != null) {
        const arr = validateArray<unknown>(ee.assignedRooms, { max: LIMITS.ASSIGNED_ROOMS_MAX, label: `staff[${i}].assignedRooms` });
        if (arr.error) return err(arr.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
        for (let j = 0; j < arr.value!.length; j++) {
          const r = validateString(arr.value![j], { max: LIMITS.ROOM_NUMBER_MAX, label: `staff[${i}].assignedRooms[${j}]` });
          if (r.error) return err(r.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
          rooms.push(r.value!);
        }
      }
      staff.push({ staffId: sidV.value!, staffName: nameV.value!, assignedRooms: rooms });
    }

    const pid = pidV.value!;
    const shiftDate = dateV.value!;

    if (!(await userHasPropertyAccess(session.userId, pid))) {
      return err('forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
    }
    // 200 syncs/hour/property — comfortably above one active manager
    // dragging on the schedule board (debounced ~1.5s per change).
    const limit = await checkAndIncrementRateLimit('sync-room-assignments', pid);
    if (!limit.allowed) return rateLimitedResponse(limit.current, limit.cap, limit.retryAfterSec);

    // ── Failsafe: refuse to wipe all assignments without explicit opt-in ────
    const hasAnyAssignment = staff.some(s => (s.assignedRooms ?? []).length > 0);
    const allowClearAll = body.allowClearAll === true;
    if (!hasAnyAssignment && !allowClearAll) {
      return err('Refusing to clear all room assignments without allowClearAll=true', {
        requestId, status: 400, code: ApiErrorCode.ValidationFailed,
      });
    }

    // Pull plan snapshot so we can seed any new (future-date) rooms with the
    // correct checkout/stayover flag — same behaviour as send-shift-confirmations.
    const { data: planRow } = await supabaseAdmin
      .from('plan_snapshots')
      .select('rooms')
      .eq('property_id', pid)
      .eq('date', shiftDate)
      .maybeSingle();
    const planRooms = (planRow?.rooms as PlanRoom[] | null) ?? null;

    // Build the (roomNumber → who) map.
    const assignmentMap = new Map<string, { staffId: string; staffName: string }>();
    for (const entry of staff) {
      for (const num of (entry.assignedRooms ?? [])) {
        assignmentMap.set(num, { staffId: entry.staffId, staffName: entry.staffName });
      }
    }

    const { data: existing, error: roomsErr } = await supabaseAdmin
      .from('rooms')
      .select('id, number, assigned_to, assigned_name')
      .eq('property_id', pid)
      .eq('date', shiftDate);
    if (roomsErr) throw roomsErr;

    const existingByNumber = new Map<string, {
      id: string;
      number: string;
      assigned_to: string | null;
      assigned_name: string | null;
    }>();
    for (const r of (existing ?? [])) {
      if (r.number) existingByNumber.set(r.number as string, {
        id: r.id as string,
        number: r.number as string,
        assigned_to: (r.assigned_to as string | null) ?? null,
        assigned_name: (r.assigned_name as string | null) ?? null,
      });
    }

    const toInsert: Array<Record<string, unknown>> = [];
    // PromiseLike (not Promise) — Supabase query-builder chains are
    // thenables; Promise.all accepts PromiseLike.
    const updates: PromiseLike<unknown>[] = [];
    let writes = 0;

    // Assign / update rooms that are in the new assignment map.
    for (const [num, who] of assignmentMap) {
      const row = existingByNumber.get(num);
      if (row) {
        if (row.assigned_to !== who.staffId || row.assigned_name !== who.staffName) {
          updates.push(
            supabaseAdmin
              .from('rooms')
              .update({ assigned_to: who.staffId, assigned_name: who.staffName })
              .eq('id', row.id)
              .then(({ error }) => { if (error) throw error; }),
          );
          writes++;
        }
      } else {
        toInsert.push({
          property_id: pid,
          number: num,
          date: shiftDate,
          type: deriveRoomType(num, planRooms),
          status: 'dirty',
          priority: 'standard',
          assigned_to: who.staffId,
          assigned_name: who.staffName,
        });
        writes++;
      }
    }

    // Clear assignments on rooms that USED to be assigned but aren't anymore.
    for (const [num, row] of existingByNumber) {
      if (assignmentMap.has(num)) continue;
      if (!row.assigned_to) continue;
      updates.push(
        supabaseAdmin
          .from('rooms')
          .update({ assigned_to: null, assigned_name: null })
          .eq('id', row.id)
          .then(({ error }) => { if (error) throw error; }),
      );
      writes++;
    }

    if (toInsert.length > 0) {
      const { error: insErr } = await supabaseAdmin
        .from('rooms')
        .upsert(toInsert, { onConflict: 'property_id,date,number' });
      if (insErr) throw insErr;
    }
    if (updates.length > 0) {
      await Promise.all(updates);
    }

    return ok({ writes }, { requestId });
  } catch (caughtErr) {
    log.error('sync-room-assignments error', { err: caughtErr, requestId });
    await writeErrorLog({
      source: '/api/sync-room-assignments',
      message: errToString(caughtErr),
      stack: caughtErr instanceof Error ? caughtErr.stack ?? null : null,
    });
    return err('Internal server error', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
}
