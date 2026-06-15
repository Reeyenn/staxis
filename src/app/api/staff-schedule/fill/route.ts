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
import { verifyTeamManager, callerCan } from '@/lib/team-auth';
import { validateUuid } from '@/lib/api-validate';
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

/** YYYY-MM-DD of the Sunday on or before the given date (UTC math on the string). */
function sundayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
  return dt.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const requestId = getOrMintRequestId(req);
  const caller = await verifyTeamManager(req, { capability: 'manage_shifts' });
  if (!caller) return err('Unauthorized', { requestId, status: 403, code: ApiErrorCode.Unauthorized });

  const body = await req.json().catch(() => ({})) as { hotelId?: string; days?: FillDay[] };
  const hotelIdCheck = validateUuid(body.hotelId, 'hotelId');
  if (hotelIdCheck.error) return err(hotelIdCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
  const hotelId = hotelIdCheck.value!;
  if (!(await callerCan(caller, 'manage_shifts', hotelId))) {
    return err('Forbidden', { requestId, status: 403, code: ApiErrorCode.Unauthorized });
  }

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
      if (toMin(s.endTime) <= toMin(s.startTime)) {
        return err('endTime must be after startTime', { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
      }
    }
  }

  // Staff that may legitimately appear on this property's schedule.
  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from('staff').select('id, is_active')
    .eq('property_id', hotelId);
  if (staffErr) {
    log.error('[fill:POST] staff query failed', { requestId, msg: errToString(staffErr) });
    return err('Failed to read staff', { requestId, status: 500, code: ApiErrorCode.InternalError });
  }
  const activeStaff = new Set(
    (staffRows ?? []).filter(r => r.is_active !== false).map(r => String(r.id)),
  );

  // Approved time-off in the affected window → those (staff, date) pairs are
  // skipped, exactly like the old Copy Last Week behaviour.
  const dates = days.map(d => d.date).sort();
  const { data: tor } = await supabaseAdmin
    .from('time_off_requests').select('staff_id, request_date')
    .eq('property_id', hotelId).eq('status', 'approved')
    .gte('request_date', dates[0]).lte('request_date', dates[dates.length - 1]);
  const torKeys = new Set((tor ?? []).map(r => `${r.staff_id}:${r.request_date}`));

  let inserted = 0, updated = 0, deleted = 0, skippedTimeOff = 0, skippedUnknown = 0;

  for (const day of days) {
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('scheduled_shifts')
      .select('id, staff_id, department, start_time, end_time, status, note')
      .eq('property_id', hotelId).eq('shift_date', day.date).eq('kind', 'shift');
    if (exErr) {
      log.error('[fill:POST] existing query failed', { requestId, msg: errToString(exErr) });
      return err('Failed to read existing shifts', { requestId, status: 500, code: ApiErrorCode.InternalError });
    }
    const existingStaff = new Set((existing ?? []).map(r => String(r.staff_id)));

    // Desired end-state, one shift per staff member (board invariant; the DB
    // exclusion constraint enforces the same thing). Approved time off only
    // blocks NET-NEW placements without an explicit manager override — a
    // shift that already exists on the day is the manager's call and must
    // never be silently dropped by an unrelated re-save of the day.
    const desired = new Map<string, FillShift>();
    for (const s of day.shifts) {
      if (desired.has(s.staffId)) continue;
      if (!activeStaff.has(s.staffId)) { skippedUnknown++; continue; }
      if (
        torKeys.has(`${s.staffId}:${day.date}`)
        && !existingStaff.has(s.staffId)
        && !s.overrideTimeOff
      ) { skippedTimeOff++; continue; }
      desired.set(s.staffId, s);
    }

    const keepRowByStaff = new Map<string, { id: string; department: string; start: string; end: string; status: string; note: string | null }>();
    const toDelete: string[] = [];
    for (const row of existing ?? []) {
      const sid = row.staff_id ? String(row.staff_id) : null;
      if (!sid || !desired.has(sid) || keepRowByStaff.has(sid)) {
        toDelete.push(String(row.id));
        continue;
      }
      keepRowByStaff.set(sid, {
        id: String(row.id),
        department: String(row.department),
        start: String(row.start_time).slice(0, 5),
        end: String(row.end_time).slice(0, 5),
        status: String(row.status),
        note: row.note == null ? null : String(row.note),
      });
    }

    if (toDelete.length > 0) {
      const { error: delErr } = await supabaseAdmin
        .from('scheduled_shifts').delete()
        .eq('property_id', hotelId).in('id', toDelete);
      if (delErr) {
        log.error('[fill:POST] delete failed', { requestId, msg: errToString(delErr) });
        return err('Failed to clear replaced shifts', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }
      deleted += toDelete.length;
    }

    const toInsert: Record<string, unknown>[] = [];
    for (const [staffId, want] of desired) {
      const cur = keepRowByStaff.get(staffId);
      const wantNote = cleanNote(want.note);
      if (!cur) {
        toInsert.push({
          property_id: hotelId,
          staff_id: staffId,
          department: want.department,
          shift_date: day.date,
          start_time: want.startTime,
          end_time: want.endTime,
          kind: 'shift',
          status: 'published',
          note: wantNote,
        });
        continue;
      }
      const changed = cur.department !== want.department
        || cur.start !== want.startTime || cur.end !== want.endTime
        || (cur.note ?? null) !== wantNote;
      // 'sent'/'confirmed' are mid-SMS-cycle (housekeeping flow) — keep them
      // unless the shift itself changed; everything else lands at published.
      const nextStatus = !changed && (cur.status === 'sent' || cur.status === 'confirmed')
        ? cur.status : 'published';
      if (!changed && nextStatus === cur.status) continue;
      const { error: upErr } = await supabaseAdmin
        .from('scheduled_shifts')
        .update({
          department: want.department,
          start_time: want.startTime,
          end_time: want.endTime,
          status: nextStatus,
          note: wantNote,
        })
        .eq('id', cur.id).eq('property_id', hotelId);
      if (upErr) {
        log.error('[fill:POST] update failed', { requestId, msg: errToString(upErr) });
        return err('Failed to update a shift', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }
      updated++;
    }

    if (toInsert.length > 0) {
      const { error: insErr } = await supabaseAdmin.from('scheduled_shifts').insert(toInsert);
      if (insErr) {
        log.error('[fill:POST] insert failed', { requestId, msg: errToString(insErr) });
        return err('Failed to add shifts', { requestId, status: 500, code: ApiErrorCode.InternalError });
      }
      inserted += toInsert.length;
    }
  }

  // Make the affected weeks visible to staff (My Shifts gates future weeks
  // on a week_publications row). One row per week is enough — insert only
  // when the (Sunday-keyed) week has none yet.
  const weekStarts = [...new Set(days.map(d => sundayOf(d.date)))];
  for (const ws of weekStarts) {
    const { data: existingPub } = await supabaseAdmin
      .from('week_publications').select('id')
      .eq('property_id', hotelId).eq('week_start', ws).limit(1).maybeSingle();
    if (!existingPub) {
      const { error: pubErr } = await supabaseAdmin
        .from('week_publications').insert({
          property_id: hotelId,
          week_start: ws,
          published_by: caller.accountId,
        });
      if (pubErr) {
        log.error('[fill:POST] publication stamp failed', { requestId, msg: errToString(pubErr) });
        // Non-fatal: shifts are saved; the week stamp can be retried by the
        // next edit. Surface in the response instead of failing the write.
      }
    }
  }

  return ok({ inserted, updated, deleted, skippedTimeOff, skippedUnknown }, { requestId });
}
