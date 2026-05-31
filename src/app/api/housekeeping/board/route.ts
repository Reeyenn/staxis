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
 *   - Loads cleaning_tasks for the given property + business_date.
 *   - Loads the property's housekeeping staff.
 *   - Loads the current is_active=true hk_assignments rows.
 *   - Computes per-HK workload totals using each task's
 *     estimated_minutes (falling back to the engine's base map).
 *
 * Response shape:
 *   {
 *     tasks: [{ id, room_number, cleaning_type, priority, due_by,
 *               estimated_minutes_resolved, status, assignee_id,
 *               queue_order, requires_inspection, extras }],
 *     housekeepers: [{ id, name, language, is_senior, is_active,
 *                      scheduled_today, workload_minutes }],
 *     unassigned: number,
 *   }
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
import { fetchCleanTimeBaseDurations } from '@/lib/clean-time-standards-server';

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
}

interface AssignmentRow {
  cleaning_task_id: string;
  housekeeper_id: string;
  queue_order: number;
  reason: string | null;
  assigned_by: string;
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
    // hotel's cleaning_tasks + staff roster by spraying property UUIDs
    // (matches the pattern in /api/housekeeping/rooms).
    const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
    if (!hasAccess) {
      log.warn('board: forbidden — user lacks property access', {
        requestId, userId: auth.userId, propertyId,
      });
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: 'forbidden',
      });
    }

    // 1. Tasks for today (any status — the UI surfaces in-progress and
    //    completed too so the manager has the full picture).
    //
    // If cleaning_tasks doesn't exist yet (migration 0210 not applied),
    // the board collapses to a "no auto-assigned work yet" empty state.
    // Comfort Suites Beaumont is live on the legacy plan_snapshot path —
    // a 500 here would break the whole Schedule tab, which is too high
    // a blast radius for a feature that's still in shadow mode.
    const { data: taskRows, error: taskErr } = await supabaseAdmin
      .from('cleaning_tasks')
      .select('id, property_id, room_number, cleaning_type, priority, due_by, estimated_minutes, requires_inspection, extras, status')
      .eq('property_id', propertyId)
      .eq('business_date', businessDate);
    if (taskErr) {
      log.warn('board: cleaning_tasks load failed; returning empty board', {
        requestId, msg: taskErr.message,
      });
      return ok({ tasks: [], housekeepers: [], unassigned: 0 }, { requestId });
    }
    const tasks = (taskRows ?? []) as CleaningTaskRow[];

    // 2. Active assignments for these tasks. Inactive history rows are
    //    intentionally excluded — the manager view shows "who has this
    //    task right now", not the full audit log.
    const taskIds = tasks.map(t => t.id);
    let assignments: AssignmentRow[] = [];
    if (taskIds.length > 0) {
      const { data: assignmentRows, error: assignErr } = await supabaseAdmin
        .from('hk_assignments')
        .select('cleaning_task_id, housekeeper_id, queue_order, reason, assigned_by')
        .eq('property_id', propertyId)
        .eq('is_active', true)
        .in('cleaning_task_id', taskIds);
      if (assignErr) {
        // Same reasoning as above: if hk_assignments (0211) isn't applied
        // yet, the board renders tasks without assignees rather than
        // 500ing the whole Schedule tab.
        log.warn('board: hk_assignments load failed; rendering unassigned', {
          requestId, msg: assignErr.message,
        });
      } else {
        assignments = (assignmentRows ?? []) as AssignmentRow[];
      }
    }
    const assignmentByTask = new Map<string, AssignmentRow>();
    for (const a of assignments) assignmentByTask.set(a.cleaning_task_id, a);

    // 3. Housekeeping staff.
    const { data: staffRows, error: staffErr } = await supabaseAdmin
      .from('staff')
      .select('id, name, language, is_senior, is_active, scheduled_today, department')
      .eq('property_id', propertyId)
      .eq('department', 'housekeeping');
    if (staffErr) {
      log.error('board: load staff failed', { requestId, msg: staffErr.message });
      return err('load staff failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const staff = (staffRows ?? []) as StaffRow[];

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
    const cfg = {
      shiftMinutes: 420,
      baseDurations: { ...DEFAULT_BASE_DURATIONS, ...cleanTimeBase },
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
        assignment_reason: assignment?.reason ?? null,
        assigned_by: assignment?.assigned_by ?? null,
      };
    });

    // 5. Per-HK workload totals — sum of resolved minutes across all
    //    NOT-YET-COMPLETED tasks. Completed/cancelled tasks don't
    //    contribute (they've already happened and would mislead the
    //    bar chart).
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

    return ok({ tasks: tasksOut, housekeepers: housekeepersOut, unassigned }, { requestId });
  } catch (e) {
    log.error('board: unexpected error', { requestId, msg: errToString(e) });
    return err('board failed', { requestId, status: 500, code: 'internal_error' });
  }
}
