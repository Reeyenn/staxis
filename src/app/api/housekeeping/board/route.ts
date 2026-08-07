/**
 * GET /api/housekeeping/board?propertyId=…&date=YYYY-MM-DD
 *
 * Returns the manager-facing auto-assignment board: for a given
 * property + date, the list of cleaning tasks, the housekeeping roster,
 * and the current assignments. The UI in ScheduleTab.tsx renders this
 * as a column-per-housekeeper kanban with workload totals.
 *
 * Auth: requireSession (manager-facing). The future housekeeper-facing
 * view doesn't use this endpoint — they read their own queue from a
 * scoped endpoint.
 *
 * Behaviour:
 *   - Loads the canonical room_work_plan_v1 projection for the given
 *     property + business_date. The projection carries the current
 *     assignment snapshot from room_work.
 *   - Loads the property's housekeeping staff.
 *   - Computes per-HK workload totals using each task's
 *     estimated_minutes (falling back to the engine's base map).
 *
 * Who is on the crew (2026-07-24): resolved from the REAL staff schedule
 * (`scheduled_shifts`) for the selected date via
 * resolveHousekeepingCrewForDate, NOT from the dead `staff.scheduled_today`
 * boolean this route used to pass through unfiltered. When the hotel has
 * no shifts on file for that date we return the whole active roster and
 * say so via `crew_source: 'unscheduled_fallback'` — an unexplained empty
 * board is the worst possible first impression.
 *
 * Response shape:
 *   {
 *     tasks: [{ id, room_number, cleaning_type, priority, due_by,
 *               estimated_minutes_resolved, status, assignee_id,
 *               queue_order, requires_inspection, extras }],
 *     housekeepers: [{ id, name, language, is_senior, is_active,
 *                      is_scheduled, scheduled_minutes, workload_minutes }],
 *     crew_source: 'scheduled' | 'unscheduled_fallback',
 *     shift_minutes: number,
 *     unassigned: number,
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { requireSectionEnabled } from '@/lib/sections/server';
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
import {
  resolveHousekeepingCrewForDate,
  DEFAULT_CREW_SHIFT_MINUTES,
} from '@/lib/schedule/active-crew';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  assignee_id: string | null;
  queue_order: number | null;
  assignment_reason: string | null;
  assigned_by: string | null;
}

interface StaffRow {
  id: string;
  name: string;
  language: string | null;
  is_senior: boolean | null;
  is_active: boolean | null;
  schedule_priority: string | null;
  phone: string | null;
  department: string | null;
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

    // Tenant-scope gate: the session caller must have access to this
    // property. Without it any signed-in user could enumerate another
    // hotel's canonical housekeeping plan + staff roster by spraying property UUIDs
    // (matches the pattern in /api/housekeeping/rooms).
    const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
    if (!hasAccess) {
      log.warn('board: forbidden — user lacks property access', {
        requestId, userId: auth.userId, propertyId,
      });
      return err('forbidden: no access to this property', {
        requestId, status: 403, code: 'forbidden',
      });
    }

    // Section gate (add-on, on top of the tenant guard above): if Housekeeping is off for this hotel, block this route.
    const sectionGate = await requireSectionEnabled(req, propertyId, 'housekeeping');
    if (!sectionGate.ok) return sectionGate.response;

    // 1. Tasks for today (any status — the UI surfaces in-progress and
    //    completed too so the manager has the full picture). The canonical
    //    projection includes PMS-only plans and carries the current
    //    assignment snapshot, so no second assignment read is needed.
    const { data: taskRows, error: taskErr } = await supabaseAdmin
      .from('room_work_plan_v1')
      .select('id, property_id, room_number, cleaning_type, priority, due_by, estimated_minutes, requires_inspection, extras, status, assignee_id, queue_order, assignment_reason, assigned_by')
      .eq('property_id', propertyId)
      .eq('business_date', businessDate);
    // A failed plan read must NOT answer 200 with an empty board. "No rooms to
    // clean today" and "we could not read the plan" look identical on screen,
    // and the manager acts on the first one: crew goes home, rooms stay dirty.
    // Every other read in this handler already fails loudly for this reason
    // (staff below, property below) — this one, the most load-bearing of the
    // three, was the exception. Same posture as mergePmsRoomsForStaff: an
    // error the tab can retry beats a confident wrong answer.
    if (taskErr) {
      log.error('board: canonical plan load failed', {
        requestId, propertyId, date: businessDate, msg: taskErr.message,
      });
      return err('load plan failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const tasks = (taskRows ?? []) as CleaningTaskRow[];

    // 3. Housekeeping staff + the property's default shift length (used
    //    as each crew member's capacity when no shift times are on file).
    const [staffRes, propRes] = await Promise.all([
      supabaseAdmin
        .from('staff')
        .select('id, name, language, is_senior, is_active, schedule_priority, phone, department')
        .eq('property_id', propertyId)
        .eq('department', 'housekeeping'),
      supabaseAdmin
        .from('properties')
        .select('shift_minutes')
        .eq('id', propertyId)
        .maybeSingle(),
    ]);
    if (staffRes.error) {
      log.error('board: load staff failed', { requestId, msg: staffRes.error.message });
      return err('load staff failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    // A failed property read must NOT quietly fall through to the 7h
    // default: every capacity bar, Over-cap pill and "Recommended N HK" on
    // this board is computed against this number, so a hotel on 9h shifts
    // would silently read as over-committed. Fail loudly (the tab shows its
    // retry state) rather than showing confident wrong numbers — same
    // posture as fetchShiftMinutes in /api/settings/clean-times.
    if (propRes.error) {
      log.error('board: load property failed', { requestId, msg: propRes.error.message });
      return err('load property failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const staff = (staffRes.data ?? []) as StaffRow[];
    const defaultShiftMinutes =
      (propRes.data?.shift_minutes as number | null | undefined) ?? DEFAULT_CREW_SHIFT_MINUTES;

    // 3b. Who is actually working this date, per the Staff schedule.
    //     Anyone who already holds a canonical assignment is force-included
    //     even if unscheduled ("called in") — otherwise their rooms would
    //     drop into the Unassigned lane and read as unplanned work.
    const crew = await resolveHousekeepingCrewForDate({
      propertyId,
      date: businessDate,
      roster: staff.map(s => ({ id: s.id, isActive: s.is_active })),
      defaultShiftMinutes,
      alwaysIncludeStaffIds: new Set(
        tasks.flatMap(t => t.assignee_id ? [t.assignee_id] : []),
      ),
    });
    if (crew.degraded) {
      log.warn('board: schedule read failed; showing full roster', {
        requestId, propertyId, date: businessDate,
      });
    }

    // 4. Compute resolved minutes per task + per-HK workload totals.
    //    A "shadow" AssignmentTask wrapper lets us reuse the engine's
    //    duration-resolution logic so the manager UI shows the same
    //    minute totals the engine used during assignment.
    //
    //    baseDurations is the fallback used only when a task has no stored
    //    estimated_minutes. We overlay the property's manager-set Clean Times
    //    (migration 0244) on top of the static defaults so that fallback
    //    reflects the edited minutes too. (The common path — tasks created
    //    by the rules-engine — already carries table-derived
    //    estimated_minutes, so this mainly matters for legacy/estimate-less
    //    rows.) Degrades to the static defaults when no standards exist.
    const cleanTimeBase = await fetchCleanTimeBaseDurations(propertyId);
    const cfg = buildDurationConfig({ shiftMinutes: 420, cleanTimeBase });
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
        assignment_reason: t.assignment_reason,
        assigned_by: t.assigned_by,
      };
    });

    // 5. Per-HK workload totals — sum of resolved minutes across all
    //    NOT-YET-COMPLETED tasks. Completed/cancelled tasks don't
    //    contribute (they've already happened and would mislead the
    //    bar chart).
    const workloadByHk = computeWorkloadByHk(tasksOut);

    const isScheduledById = new Map(crew.members.map(m => [m.staffId, m.isScheduled]));
    const housekeepersOut = staff.filter(s => crew.memberIds.has(s.id)).map(s => ({
      id: s.id,
      name: s.name,
      language: s.language === 'es' ? 'es' : 'en',
      is_senior: s.is_senior === true,
      is_active: s.is_active !== false,
      // True only when this person has a real shift on the Staff schedule
      // for this date. False = on the board because nobody is scheduled
      // (fallback) or because they already hold rooms today.
      is_scheduled: isScheduledById.get(s.id) === true,
      // Real shift length for this person on this date — the capacity bar
      // must size against this, not a uniform per-property shift.
      scheduled_minutes: crew.minutesByStaffId.get(s.id) ?? defaultShiftMinutes,
      // Surfaced so the board can badge an EXCLUDED housekeeper, and for
      // Send-links eligibility. The board only needs presence/absence; the
      // raw contact stays behind the manage_team-gated contacts API.
      schedule_priority: (['priority', 'normal', 'excluded'].includes(s.schedule_priority ?? '')
        ? s.schedule_priority
        : 'normal') as 'priority' | 'normal' | 'excluded',
      has_phone: typeof s.phone === 'string' && s.phone.trim().length > 0,
      workload_minutes: workloadByHk.get(s.id) ?? 0,
    }));

    const unassigned = tasksOut.filter(t => !t.assignee_id).length;

    return ok(
      {
        tasks: tasksOut,
        housekeepers: housekeepersOut,
        unassigned,
        // 'scheduled'             → the list is the people on the Staff schedule.
        // 'unscheduled_fallback'  → nobody is scheduled for this date, so the
        //                           board shows everyone and the UI says why.
        crew_source: crew.source,
        shift_minutes: defaultShiftMinutes,
      },
      { requestId },
    );
  } catch (e) {
    log.error('board: unexpected error', { requestId, msg: errToString(e) });
    return err('board failed', { requestId, status: 500, code: 'internal_error' });
  }
}
