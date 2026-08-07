/**
 * GET /api/housekeeping/timeline?propertyId=…&date=YYYY-MM-DD
 *
 * Returns the manager-facing TIMELINE view payload — a richer shape than
 * /api/housekeeping/board. The timeline visualises each housekeeper's
 * day as a horizontal strip with one card per cleaning task. To position
 * those cards on a wall-clock axis we need things the board route
 * doesn't return: per-task lifecycle timestamps (started_at, completed_at),
 * the property's shift-day window in UTC, and the property timezone so
 * the client can format hour labels in local time.
 *
 * Why a separate route from /api/housekeeping/board:
 *   - The board view is column-per-HK with a workload bar; it doesn't
 *     need lifecycle timestamps and we want its payload to stay small.
 *   - Card positioning math (scheduled_start derived from queue_order +
 *     cumulative estimated_minutes) lives on the client so drag-to-
 *     reschedule doesn't need to round-trip to compute new positions.
 *   - Both routes are read-only manager views — keeping them separate
 *     means timeline changes can't accidentally break the board.
 *
 * Auth: requireSession (manager-facing). The canonical plan projection and
 * its underlying room_work/PMS sources are service-role reads.
 *
 * Response shape:
 *   {
 *     tasks: [{
 *       id, room_number, cleaning_type, priority, due_by, status,
 *       estimated_minutes_resolved, requires_inspection, extras,
 *       assignee_id, queue_order, started_at, completed_at,
 *     }],
 *     housekeepers: [{
 *       id, name, language, is_senior, is_active, is_scheduled,
 *       scheduled_minutes, workload_minutes,
 *     }],
 *     crew_source: 'scheduled' | 'unscheduled_fallback',
 *     shift: {
 *       date,                       // echoed business_date
 *       timezone,                   // IANA, e.g. "America/Chicago"
 *       start_iso,                  // shift_date @ start_hour_local, in UTC ISO
 *       end_iso,                    // start_iso + shift_minutes
 *       shift_minutes,              // property.shift_minutes (default 480)
 *       start_hour_local,           // hour the shift starts, hotel-local 0-23
 *     },
 *     unassigned: number,
 *   }
 *
 * On projection failure the route returns an empty timeline rather than
 * 500'ing, preserving the board's existing degradation posture.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateDateStr } from '@/lib/api-validate';
import {
  resolveDurationMinutes,
  toShadowAssignmentTask,
  buildDurationConfig,
  computeWorkloadByHk,
} from '@/lib/assignment-engine';
import { fetchCleanTimeBaseDurations } from '@/lib/clean-time-standards-server';
import { localDateTimeToUtcIso } from '@/lib/timeline-layout';
import { resolveHousekeepingCrewForDate } from '@/lib/schedule/active-crew';
import { resolveShiftStartHour } from '@/lib/housekeeping/setup-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The shift start hour is no longer hardcoded here.
//
// It used to be `const DEFAULT_SHIFT_START_HOUR_LOCAL = 7`, with a comment
// promising a per-property column that never shipped. The answer was already
// in the database the whole time: Q4 of the housekeeping questionnaire stores
// `shiftStartTime` in `properties.housekeeping_setup` (migration 0337), and
// nothing read it. `resolveShiftStartHour` does, falling back to
// FALLBACK_SHIFT_START_HOUR for a hotel that has not been asked yet.
// /api/housekeeping/board resolves the same hour through the same helper, so
// the board and the timeline can never disagree about when the day starts.

interface CleaningTaskRow {
  id: string;
  property_id: string;
  room_number: string;
  cleaning_type: string;
  priority: string;
  due_by: string | null;
  estimated_minutes: number | null;
  requires_inspection: boolean | null;
  extras: unknown;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  assignee_id: string | null;
  queue_order: number | null;
}

interface StaffRow {
  id: string;
  name: string;
  language: string | null;
  is_senior: boolean | null;
  is_active: boolean | null;
  department: string | null;
}

interface PropertyRow {
  id: string;
  timezone: string | null;
  shift_minutes: number | null;
  housekeeping_setup: unknown;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const pidRaw = url.searchParams.get('propertyId');
    const dateRaw = url.searchParams.get('date');

    const pidCheck = validateUuid(pidRaw, 'propertyId');
    if (pidCheck.error) {
      return err(pidCheck.error, { requestId, status: 400, code: 'validation_failed' });
    }
    const dateCheck = validateDateStr(dateRaw ?? '', { label: 'date' });
    if (dateCheck.error) {
      return err(dateCheck.error, { requestId, status: 400, code: 'validation_failed' });
    }
    const propertyId = pidCheck.value!;
    const businessDate = dateCheck.value!;

    // Tenant scope — confirm the caller actually has access to this property
    // before we read its cleaning schedule. Without it any signed-in manager
    // could enumerate any hotel's schedule by spraying propertyIds.
    const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
    if (!hasAccess) {
      log.warn('timeline: forbidden — user lacks property access', {
        requestId, userId: auth.userId, propertyId,
      });
      return err('forbidden: no access to this property', {
        requestId, status: 403, code: 'forbidden',
      });
    }

    // 1. Property timezone + shift_minutes + the questionnaire's shift start
    //    for the shift-window math.
    const { data: propRow, error: propErr } = await supabaseAdmin
      .from('properties')
      .select('id, timezone, shift_minutes, housekeeping_setup')
      .eq('id', propertyId)
      .maybeSingle<PropertyRow>();
    if (propErr) {
      log.error('timeline: property load failed', { requestId, msg: propErr.message });
      return err('property load failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    if (!propRow) {
      return err('property not found', { requestId, status: 404, code: 'not_found' });
    }
    const timezone = propRow.timezone || 'America/Chicago';
    const shiftMinutes = propRow.shift_minutes ?? 480;
    // The hotel's own answer to "when does housekeeping start", or 7am when
    // they have not been asked yet.
    const startHourLocal = resolveShiftStartHour(propRow.housekeeping_setup);
    let startIso: string;
    try {
      startIso = localDateTimeToUtcIso(businessDate, startHourLocal, timezone);
    } catch (e) {
      log.error('timeline: shift-start derivation failed', { requestId, msg: errToString(e) });
      return err('shift window derivation failed', { requestId, status: 500, code: 'internal_error' });
    }
    const endIso = new Date(new Date(startIso).getTime() + shiftMinutes * 60_000).toISOString();

    // 2. Canonical plan rows for the day. Mirrors /api/housekeeping/board
    //    but pulls lifecycle timestamps too.
    const { data: taskRows, error: taskErr } = await supabaseAdmin
      .from('room_work_plan_v1')
      .select(
        'id, property_id, room_number, cleaning_type, priority, due_by, ' +
        'estimated_minutes, requires_inspection, extras, status, started_at, completed_at, assignee_id, queue_order',
      )
      .eq('property_id', propertyId)
      .eq('business_date', businessDate)
      // .returns<T>() asserts the row shape so TypeScript's strict mode
      // typechecks the select column list against the local interface.
      // The runtime behavior is unchanged. Without this assertion, the
      // Supabase JS generic infers `GenericStringError[]` when the table
      // isn't in the generated database.types.ts — landing in strict tsc
      // as the same "incompatible row shape" error. Narrowing via
      // `.returns<>()` keeps Postgres's actual row shape (verified by
      // the column list above) as the only place reality is asserted.
      .returns<CleaningTaskRow[]>();
    if (taskErr) {
      log.warn('timeline: canonical plan load failed; returning empty timeline', {
        requestId, msg: taskErr.message,
      });
      return ok(
        {
          tasks: [],
          housekeepers: [],
          unassigned: 0,
          crew_source: 'unscheduled_fallback' as const,
          shift: { date: businessDate, timezone, start_iso: startIso, end_iso: endIso, shift_minutes: shiftMinutes, start_hour_local: startHourLocal },
        },
        { requestId },
      );
    }
    // Wide select string outruns supabase-js inference; cast through unknown.
    const tasks = (taskRows ?? []) as unknown as CleaningTaskRow[];

    // 3. Housekeeping staff for this property.
    const { data: staffRows, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, language, is_senior, is_active, department')
      .eq('property_id', propertyId)
      .eq('department', 'housekeeping');
    if (staffErr) {
      log.error('timeline: load staff failed', { requestId, msg: staffErr.message });
      return err('load staff failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const staff = (staffRows ?? []) as StaffRow[];

    // 3b. Who is actually working this date, per the Staff schedule
    //     (scheduled_shifts) — the same shared resolver the board route
    //     and the auto-assign runner use, so all three agree. Anyone
    //     already holding an assignment is force-included so their strip
    //     never disappears mid-shift.
    const crew = await resolveHousekeepingCrewForDate({
      propertyId,
      date: businessDate,
      roster: staff.map(s => ({ id: s.id, isActive: s.is_active })),
      defaultShiftMinutes: shiftMinutes,
      alwaysIncludeStaffIds: new Set(
        tasks.flatMap(t => t.assignee_id ? [t.assignee_id] : []),
      ),
    });
    if (crew.degraded) {
      log.warn('timeline: schedule read failed; showing full roster', {
        requestId, propertyId, date: businessDate,
      });
    }

    // 4. Resolve per-task minutes — reuse the engine's duration resolver
    //    so the timeline card widths match the assignment-board minutes.
    //    baseDurations overlays the property's manager-set Clean Times
    //    (migration 0244) on the static defaults so the fallback (used only
    //    when a task has no stored estimated_minutes) reflects edited
    //    minutes too. Matches /api/housekeeping/board exactly.
    const cleanTimeBase = await fetchCleanTimeBaseDurations(propertyId);
    const cfg = buildDurationConfig({ shiftMinutes, cleanTimeBase });
    const tasksOut = tasks.map(t => {
      const shadow = toShadowAssignmentTask(t);
      const minutes = resolveDurationMinutes(shadow, cfg);
      return {
        id: t.id,
        room_number: t.room_number,
        cleaning_type: t.cleaning_type,
        priority: shadow.priority,
        due_by: t.due_by,
        status: t.status,
        estimated_minutes_resolved: minutes,
        requires_inspection: shadow.requires_inspection,
        extras: shadow.extras,
        assignee_id: t.assignee_id,
        queue_order: t.queue_order ?? 0,
        started_at: t.started_at,
        completed_at: t.completed_at,
      };
    });

    // 6. Per-HK workload totals — sum of NOT-YET-COMPLETED minutes so
    //    the row header chip matches the board view exactly. Completed/
    //    cancelled tasks don't add to "still on plate" minutes.
    const workloadByHk = computeWorkloadByHk(tasksOut);

    const isScheduledById = new Map(crew.members.map(m => [m.staffId, m.isScheduled]));
    const housekeepersOut = staff.filter(s => crew.memberIds.has(s.id)).map(s => ({
      id: s.id,
      name: s.name,
      language: s.language === 'es' ? 'es' : 'en',
      is_senior: s.is_senior === true,
      is_active: s.is_active !== false,
      // True only with a real shift on the Staff schedule for this date.
      is_scheduled: isScheduledById.get(s.id) === true,
      // Real shift length for this person on this date.
      scheduled_minutes: crew.minutesByStaffId.get(s.id) ?? shiftMinutes,
      workload_minutes: workloadByHk.get(s.id) ?? 0,
    }));

    const unassigned = tasksOut.filter(t => !t.assignee_id).length;

    return ok(
      {
        tasks: tasksOut,
        housekeepers: housekeepersOut,
        unassigned,
        crew_source: crew.source,
        shift: { date: businessDate, timezone, start_iso: startIso, end_iso: endIso, shift_minutes: shiftMinutes, start_hour_local: startHourLocal },
      },
      { requestId },
    );
  } catch (e) {
    log.error('timeline: unexpected error', { requestId, msg: errToString(e) });
    return err('timeline failed', { requestId, status: 500, code: 'internal_error' });
  }
}
