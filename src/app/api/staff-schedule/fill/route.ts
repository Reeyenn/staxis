// /api/staff-schedule/fill — bulk "replace these days with these shifts"
// for the unified Schedule tab (manager).
//
//   POST  body: { hotelId, days: [{ date, shifts: [{ staffId, department,
//                                    startTime, endTime }] }] }
//
// Replace semantics, per day, assigned shifts only (kind='shift'):
//   • staff present in the payload get their row updated in place (times /
//     department), preserving a mid-SMS-cycle status ('sent'/'confirmed');
//     anything else the manager touches becomes 'published' directly — the
//     redesigned tab has no separate Publish step.
//   • staff missing from the payload have their row deleted.
//   • new staff get a fresh row at status='published'.
//   • kind='open' rows are left alone (this surface doesn't manage them).
//
// Used by every mutation on the new board: drag/resize/add/remove (single
// day), Fill-from-history / template applies (day or whole week), and Undo
// (replays a snapshot). Skips staff with approved time-off on the target
// date (same rule as the old Copy Last Week) and staff no longer in the
// property, reporting both counts.
//
// Also stamps week_publications for each affected (Sunday-keyed) week so
// the staff-facing My Shifts view — which gates future weeks on a
// publication row — sees changes immediately.

import { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import {
  verifyTeamManager,
  callerCapabilityDecision,
  hotelWriteDecisionForUserId,
} from '@/lib/team-auth';
import { capabilityUnavailableResponse } from '@/lib/capabilities/api-gate';
import { requireSectionEnabled } from '@/lib/sections/server';
import { validateUuid } from '@/lib/api-validate';
import { staffScheduleGuardConflict } from '@/lib/schedule/assignment-guards';
import type { StaffDepartment } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DEPTS: StaffDepartment[] = ['housekeeping', 'front_desk', 'maintenance', 'other'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 7;
const MAX_SHIFTS_PER_DAY = 60;

interface FillShift {
  staffId: string;
  department: StaffDepartment;
  startTime: string; // HH:MM
  endTime: string;   // HH:MM
  note?: string | null;
  /** Manager explicitly confirmed scheduling over approved time off. */
  overrideTimeOff?: boolean;
}

const MAX_NOTE_LEN = 300;

function cleanNote(n: unknown): string | null {
  if (typeof n !== 'string') return null;
  const t = n.trim();
  return t ? t.slice(0, MAX_NOTE_LEN) : null;
}
interface FillDay {
  date: string;      // YYYY-MM-DD
  shifts: FillShift[];
}

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_shifts' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as { hotelId?: string; days?: FillDay[] };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  const capabilityDecision = await callerCapabilityDecision(caller, 'manage_shifts', hotelId);
  if (capabilityDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (capabilityDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

  // Section gate (add-on, on top of the manager tenant guard above): if Staff is
  // turned off for this hotel, block schedule writes.
  const sectionGate = await requireSectionEnabled(req, hotelId, 'staff');
  if (!sectionGate.ok) return sectionGate.response;

  const days = body.days;
  if (!Array.isArray(days) || days.length === 0 || days.length > MAX_DAYS) {
    return err(`days must be an array of 1–${MAX_DAYS}`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  }
  const seenDates = new Set<string>();
  for (const d of days) {
    if (!d || !DATE_RE.test(d.date) || seenDates.has(d.date)) {
      return err('Each day needs a unique YYYY-MM-DD date', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    seenDates.add(d.date);
    if (!Array.isArray(d.shifts) || d.shifts.length > MAX_SHIFTS_PER_DAY) {
      return err(`shifts must be an array of 0–${MAX_SHIFTS_PER_DAY}`, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    for (const s of d.shifts) {
      const sid = validateUuid(s?.staffId, 'staffId');
      if (sid.error) return err(sid.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      if (!VALID_DEPTS.includes(s.department)) {
        return err('Invalid department', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      if (!TIME_RE.test(s.startTime) || !TIME_RE.test(s.endTime)) {
        return err('Invalid time format (HH:MM)', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
      // end < start is an overnight shift (for example 23:00–07:00).
      // Equal clocks would be an ambiguous zero/24-hour shift, so reject it.
      if (toMin(s.endTime) === toMin(s.startTime)) {
        return err('startTime and endTime must differ', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
    }
  }

  // Re-resolve current hotel standing immediately before the single atomic
  // service-role mutation. A caller may retain portfolio/read reach after
  // their right to operate this hotel has been removed.
  const commitDecision = await hotelWriteDecisionForUserId(
    caller.authUserId,
    hotelId,
    'manage_shifts',
  );
  if (commitDecision === 'unavailable') return capabilityUnavailableResponse(requestId);
  if (commitDecision === 'denied') {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Forbidden });
  }

  const rpcDays = [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(day => ({
      date: day.date,
      shifts: day.shifts.map(shift => ({
        staffId: shift.staffId,
        department: shift.department,
        startTime: shift.startTime,
        endTime: shift.endTime,
        note: cleanNote(shift.note),
        overrideTimeOff: shift.overrideTimeOff === true,
      })),
    }));
  const { data, error } = await supabaseAdmin.rpc('staxis_replace_staff_schedule_days', {
    p_property_id: hotelId,
    p_days: rpcDays,
    p_published_by: caller.accountId,
  });
  if (error) {
    log.error('[fill:POST] atomic replacement failed', { requestId, msg: errToString(error) });
    const conflict = staffScheduleGuardConflict(error);
    if (conflict || error.code === '23P01') {
      return err(
        conflict === 'approved_time_off'
          ? 'Schedule changed because time off was approved. Refresh and try again.'
          : conflict === 'inactive_staff'
            ? 'Schedule changed because a staff profile was archived. Refresh and try again.'
            : conflict === 'archived_history'
              ? 'Archived shift history cannot be changed. Refresh and try again.'
              : 'Schedule changed while it was being saved. Refresh and try again.',
        { requestId, status: 409, code: ApiErrorCode.IdempotencyConflict },
      );
    }
    return err('Failed to save schedule', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  const result = data && typeof data === 'object'
    ? data as Record<string, unknown>
    : null;
  if (!result || result.ok !== true) {
    log.error('[fill:POST] atomic replacement returned failure', {
      requestId,
      reason: typeof result?.reason === 'string' ? result.reason : 'invalid_result',
    });
    return err('Failed to save schedule', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }

  return ok({
    inserted: Number(result.inserted ?? 0),
    updated: Number(result.updated ?? 0),
    deleted: Number(result.deleted ?? 0),
    skippedTimeOff: Number(result.skippedTimeOff ?? 0),
    skippedUnknown: Number(result.skippedUnknown ?? 0),
  }, { requestId });
}
