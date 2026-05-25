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
 * Auth: requireSession (manager-facing). Service-role reads via
 * supabaseAdmin because cleaning_tasks + hk_assignments are RLS-locked
 * to service-role only (see 0210, 0211).
 *
 * Response shape:
 *   {
 *     tasks: [{
 *       id, room_number, cleaning_type, priority, due_by, status,
 *       estimated_minutes_resolved, requires_inspection, extras,
 *       assignee_id, queue_order, started_at, completed_at,
 *     }],
 *     housekeepers: [{
 *       id, name, language, is_senior, is_active, scheduled_today,
 *       workload_minutes,
 *     }],
 *     shift: {
 *       date,                       // echoed business_date
 *       timezone,                   // IANA, e.g. "America/Chicago"
 *       start_iso,                  // shift_date @ 7am local, in UTC ISO
 *       end_iso,                    // start_iso + shift_minutes
 *       shift_minutes,              // property.shift_minutes (default 480)
 *     },
 *     unassigned: number,
 *   }
 *
 * On schema-missing degradation: if cleaning_tasks (0210) or
 * hk_assignments (0211) isn't applied yet, the route returns an empty
 * timeline rather than 500'ing. Same posture as /api/housekeeping/board.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateDateStr } from '@/lib/api-validate';
import {
  DEFAULT_BASE_DURATIONS,
  resolveDurationMinutes,
  type AssignmentTask,
  type AssignmentTaskPriority,
} from '@/lib/assignment-engine';
import { localDateTimeToUtcIso } from '@/lib/timeline-layout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Default start hour for the housekeeping shift, in property-local time.
// Most limited-service hotels start at 8am; we pick 7am to leave room
// for a senior arriving early. Hotels can override this once the
// per-property "shift_start_hour" column exists (not yet shipped).
const DEFAULT_SHIFT_START_HOUR_LOCAL = 7;

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
}

interface AssignmentRow {
  cleaning_task_id: string;
  housekeeper_id: string;
  queue_order: number;
}

interface StaffRow {
  id: string;
  name: string;
  language: string | null;
  is_senior: boolean | null;
  is_active: boolean | null;
  scheduled_today: boolean | null;
  department: string | null;
}

interface PropertyRow {
  id: string;
  timezone: string | null;
  shift_minutes: number | null;
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
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: 'forbidden',
      });
    }

    // 1. Property timezone + shift_minutes for the shift-window math.
    const { data: propRow, error: propErr } = await supabaseAdmin
      .from('properties')
      .select('id, timezone, shift_minutes')
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
    let startIso: string;
    try {
      startIso = localDateTimeToUtcIso(businessDate, DEFAULT_SHIFT_START_HOUR_LOCAL, timezone);
    } catch (e) {
      log.error('timeline: shift-start derivation failed', { requestId, msg: errToString(e) });
      return err('shift window derivation failed', { requestId, status: 500, code: 'internal_error' });
    }
    const endIso = new Date(new Date(startIso).getTime() + shiftMinutes * 60_000).toISOString();

    // 2. Cleaning tasks for the day. Mirrors /api/housekeeping/board
    //    but pulls lifecycle timestamps too. Same degradation posture:
    //    missing table → empty list, not a 500.
    const { data: taskRows, error: taskErr } = await supabaseAdmin
      .from('cleaning_tasks')
      .select(
        'id, property_id, room_number, cleaning_type, priority, due_by, ' +
        'estimated_minutes, requires_inspection, extras, status, started_at, completed_at',
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
      log.warn('timeline: cleaning_tasks load failed; returning empty timeline', {
        requestId, msg: taskErr.message,
      });
      return ok(
        {
          tasks: [],
          housekeepers: [],
          unassigned: 0,
          shift: { date: businessDate, timezone, start_iso: startIso, end_iso: endIso, shift_minutes: shiftMinutes },
        },
        { requestId },
      );
    }
    const tasks = taskRows ?? [];

    // 3. Active assignments — same posture as the board route.
    const taskIds = tasks.map(t => t.id);
    let assignments: AssignmentRow[] = [];
    if (taskIds.length > 0) {
      const { data: assignmentRows, error: assignErr } = await supabaseAdmin
        .from('hk_assignments')
        .select('cleaning_task_id, housekeeper_id, queue_order')
        .eq('property_id', propertyId)
        .eq('is_active', true)
        .in('cleaning_task_id', taskIds)
        // Deterministic ordering: queue_order first, then cleaning_task_id
        // as a stable tiebreaker so two tasks with the same queue_order
        // always appear in the same order across refreshes.
        .order('queue_order', { ascending: true })
        .order('cleaning_task_id', { ascending: true });
      if (assignErr) {
        log.warn('timeline: hk_assignments load failed; rendering unassigned', {
          requestId, msg: assignErr.message,
        });
      } else {
        assignments = (assignmentRows ?? []) as AssignmentRow[];
      }
    }
    const assignmentByTask = new Map<string, AssignmentRow>();
    for (const a of assignments) assignmentByTask.set(a.cleaning_task_id, a);

    // 4. Housekeeping staff for this property.
    const { data: staffRows, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, language, is_senior, is_active, scheduled_today, department')
      .eq('property_id', propertyId)
      .eq('department', 'housekeeping');
    if (staffErr) {
      log.error('timeline: load staff failed', { requestId, msg: staffErr.message });
      return err('load staff failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const staff = (staffRows ?? []) as StaffRow[];

    // 5. Resolve per-task minutes — reuse the engine's duration resolver
    //    so the timeline card widths match the assignment-board minutes.
    const cfg = {
      shiftMinutes,
      baseDurations: DEFAULT_BASE_DURATIONS,
      weights: {} as never,
      urgentWindowMinutes: 60,
    };
    const tasksOut = tasks.map(t => {
      const shadow: AssignmentTask = {
        id: t.id,
        property_id: t.property_id,
        room_number: t.room_number,
        cleaning_type: t.cleaning_type,
        priority: (['urgent', 'high', 'normal', 'low'].includes(t.priority)
          ? t.priority
          : 'normal') as AssignmentTaskPriority,
        due_by: t.due_by,
        estimated_minutes: t.estimated_minutes,
        requires_inspection: t.requires_inspection === true,
        extras: Array.isArray(t.extras) ? (t.extras as string[]) : [],
        guest_language: null,
      };
      const minutes = resolveDurationMinutes(shadow, cfg);
      const assignment = assignmentByTask.get(t.id);
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
        assignee_id: assignment?.housekeeper_id ?? null,
        queue_order: assignment?.queue_order ?? 0,
        started_at: t.started_at,
        completed_at: t.completed_at,
      };
    });

    // 6. Per-HK workload totals — sum of NOT-YET-COMPLETED minutes so
    //    the row header chip matches the board view exactly. Completed/
    //    cancelled tasks don't add to "still on plate" minutes.
    const workloadByHk = new Map<string, number>();
    for (const t of tasksOut) {
      if (!t.assignee_id) continue;
      const dead = t.status === 'completed' || t.status === 'cancelled' || t.status === 'skipped';
      if (dead) continue;
      const cur = workloadByHk.get(t.assignee_id) ?? 0;
      workloadByHk.set(t.assignee_id, cur + t.estimated_minutes_resolved);
    }

    const housekeepersOut = staff.map(s => ({
      id: s.id,
      name: s.name,
      language: s.language === 'es' ? 'es' : 'en',
      is_senior: s.is_senior === true,
      is_active: s.is_active !== false,
      scheduled_today: s.scheduled_today !== false,
      workload_minutes: workloadByHk.get(s.id) ?? 0,
    }));

    const unassigned = tasksOut.filter(t => !t.assignee_id).length;

    return ok(
      {
        tasks: tasksOut,
        housekeepers: housekeepersOut,
        unassigned,
        shift: { date: businessDate, timezone, start_iso: startIso, end_iso: endIso, shift_minutes: shiftMinutes },
      },
      { requestId },
    );
  } catch (e) {
    log.error('timeline: unexpected error', { requestId, msg: errToString(e) });
    return err('timeline failed', { requestId, status: 500, code: 'internal_error' });
  }
}
