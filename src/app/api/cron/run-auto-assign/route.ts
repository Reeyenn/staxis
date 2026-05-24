/**
 * GET /api/cron/run-auto-assign
 *
 * Shift-start cron that auto-assigns unassigned cleaning_tasks to
 * housekeepers using the scoring engine in src/lib/assignment-engine.
 *
 * Behaviour:
 *   - For each enabled property, find cleaning_tasks rows for today's
 *     business_date that are still in an engine-mutable status
 *     (scheduled / ready_now / deferred) AND have no active
 *     hk_assignments row.
 *   - Load the property's housekeeping roster (staff with
 *     department=housekeeping, is_active=true, scheduled_today=true,
 *     not on vacation today).
 *   - Run the scoring engine → AssignmentResult.
 *   - Insert one hk_assignments row per decision (is_active=true,
 *     assigned_by='auto'). Cache the assignee_id back onto cleaning_tasks
 *     so housekeeper-facing reads stay a single-table query.
 *   - Unassigned tasks (e.g. inspection-required + no senior on shift)
 *     are reported in the response but not blocked — manager can
 *     resolve via the drag-and-drop UI.
 *
 * Idempotent: re-running the cron does NOT re-assign tasks that already
 * have an active hk_assignments row. Manual reassignments stick.
 *
 * Auth: Bearer ${CRON_SECRET}.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronSecret } from '@/lib/api-auth';
import { ok, err } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { errToString } from '@/lib/utils';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  assignTasks,
  makeAssignmentConfig,
  type AssignmentTask,
  type AssignmentHousekeeper,
  type AssignmentTaskPriority,
} from '@/lib/assignment-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ───────────────────────────────────────────────────────────────────────
// Status windows
// ───────────────────────────────────────────────────────────────────────

/** Cleaning task statuses we're willing to auto-assign. Anything beyond
 *  these (in_progress, completed, cancelled, etc.) has either started
 *  or is no longer relevant — the engine never touches those rows. */
const AUTO_ASSIGNABLE_STATUSES = ['scheduled', 'ready_now', 'deferred'] as const;

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

/** Compute today's date in YYYY-MM-DD using the property's timezone. */
function todayInTz(tz: string | null): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz ?? 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

type StaffRow = {
  id: string;
  name: string;
  language: string | null;
  is_senior: boolean | null;
  is_active: boolean | null;
  scheduled_today: boolean | null;
  department: string | null;
  weekly_hours: number | null;
  max_weekly_hours: number | null;
  vacation_dates: string[] | null;
};

type CleaningTaskRow = {
  id: string;
  property_id: string;
  room_number: string;
  cleaning_type: string;
  priority: string;
  due_by: string | null;
  estimated_minutes: number | null;
  requires_inspection: boolean | null;
  extras: unknown;
  rule_inputs: Record<string, unknown> | null;
  status: string;
};

function staffRowToHk(s: StaffRow, todayDate: string): AssignmentHousekeeper {
  const onVacation = (s.vacation_dates ?? []).includes(todayDate);
  return {
    id: s.id,
    name: s.name,
    language: s.language === 'es' ? 'es' : 'en',
    isSenior: s.is_senior === true,
    isActive: s.is_active !== false,
    homeFloor: null,
    weeklyHours: s.weekly_hours ?? 0,
    maxWeeklyHours: s.max_weekly_hours ?? 40,
    isOutToday: onVacation || s.scheduled_today === false,
  };
}

function taskRowToAssignmentTask(t: CleaningTaskRow): AssignmentTask {
  // Priority must match the AssignmentTaskPriority union. The cleaning_tasks
  // CHECK constraint already restricts the column to these values, but we
  // defensively narrow here so a future loosening of that constraint
  // doesn't crash the engine — unknown priorities fall back to 'normal'.
  const allowed: Record<string, AssignmentTaskPriority> = {
    urgent: 'urgent', high: 'high', normal: 'normal', low: 'low',
  };
  const priority = allowed[t.priority] ?? 'normal';

  const extrasArr = Array.isArray(t.extras) ? (t.extras as unknown[]) : [];
  const extras = extrasArr.filter((x): x is string => typeof x === 'string');

  // The rules engine stashes guest_language onto rule_inputs when a
  // departing/arriving reservation has it. Engine treats absent as
  // neutral (no language-match signal).
  const ri = t.rule_inputs ?? {};
  const lang = typeof ri.guest_language === 'string' ? ri.guest_language : null;
  const guest_language: 'en' | 'es' | null =
    lang === 'es' ? 'es' : lang === 'en' ? 'en' : null;

  return {
    id: t.id,
    property_id: t.property_id,
    room_number: t.room_number,
    cleaning_type: t.cleaning_type,
    priority,
    due_by: t.due_by,
    estimated_minutes: t.estimated_minutes,
    requires_inspection: t.requires_inspection === true,
    extras,
    guest_language,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Per-property worker
// ───────────────────────────────────────────────────────────────────────

interface PropertyRunResult {
  propertyId: string;
  assigned: number;
  unassigned: number;
  skippedAlreadyAssigned: number;
  reason?: string;
}

async function runForProperty(propertyId: string, tz: string | null): Promise<PropertyRunResult> {
  const todayDate = todayInTz(tz);

  // 1. Load today's cleaning tasks in auto-assignable statuses.
  const { data: taskRows, error: taskErr } = await supabaseAdmin
    .from('cleaning_tasks')
    .select('id, property_id, room_number, cleaning_type, priority, due_by, estimated_minutes, requires_inspection, extras, rule_inputs, status')
    .eq('property_id', propertyId)
    .eq('business_date', todayDate)
    .in('status', AUTO_ASSIGNABLE_STATUSES);
  if (taskErr) throw new Error(`load tasks: ${taskErr.message}`);
  const allTasks = (taskRows ?? []) as CleaningTaskRow[];

  if (allTasks.length === 0) {
    return { propertyId, assigned: 0, unassigned: 0, skippedAlreadyAssigned: 0, reason: 'no tasks today' };
  }

  // 2. Filter to tasks WITHOUT an active hk_assignment. Idempotency.
  const { data: assignmentRows, error: existingErr } = await supabaseAdmin
    .from('hk_assignments')
    .select('cleaning_task_id')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .in('cleaning_task_id', allTasks.map(t => t.id));
  if (existingErr) throw new Error(`load existing assignments: ${existingErr.message}`);
  const alreadyAssigned = new Set((assignmentRows ?? []).map(r => r.cleaning_task_id as string));
  const tasksToPlace = allTasks.filter(t => !alreadyAssigned.has(t.id));

  if (tasksToPlace.length === 0) {
    return {
      propertyId,
      assigned: 0, unassigned: 0,
      skippedAlreadyAssigned: alreadyAssigned.size,
      reason: 'all tasks already assigned',
    };
  }

  // 3. Load housekeeping roster.
  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name, language, is_senior, is_active, scheduled_today, department, weekly_hours, max_weekly_hours, vacation_dates')
    .eq('property_id', propertyId)
    .eq('department', 'housekeeping');
  if (staffErr) throw new Error(`load staff: ${staffErr.message}`);
  const hks = ((staffRows ?? []) as StaffRow[]).map(s => staffRowToHk(s, todayDate));
  const workingHks = hks.filter(h => h.isActive && !h.isOutToday);

  if (workingHks.length === 0) {
    return {
      propertyId,
      assigned: 0,
      unassigned: tasksToPlace.length,
      skippedAlreadyAssigned: alreadyAssigned.size,
      reason: 'no housekeepers working today',
    };
  }

  // 4. Run the engine.
  const cfg = makeAssignmentConfig({});
  const assignmentTasks = tasksToPlace.map(taskRowToAssignmentTask);
  const result = assignTasks(assignmentTasks, workingHks, cfg);

  // 5. Persist decisions. We do hk_assignments inserts then a single
  // bulk update to cleaning_tasks.assignee_id. If anything fails
  // mid-way, the partial state is recoverable — re-running the cron
  // picks up where it left off because finished rows already have
  // active hk_assignments rows.
  if (result.decisions.length > 0) {
    const inserts = result.decisions.map(d => ({
      property_id: propertyId,
      cleaning_task_id: d.taskId,
      housekeeper_id: d.housekeeperId,
      queue_order: d.queueOrder,
      is_active: true,
      assigned_at: new Date().toISOString(),
      assigned_by: 'auto' as const,
      assigned_by_user_id: null,
      reason: d.reason,
      score: d.score,
    }));
    const { error: insErr } = await supabaseAdmin.from('hk_assignments').insert(inserts);
    if (insErr) throw new Error(`insert hk_assignments: ${insErr.message}`);

    // Cache the assignee on cleaning_tasks. Do this per-task because
    // Supabase doesn't support a single-statement UPDATE … FROM
    // VALUES; per-task it's still <50ms for a typical 30-task property.
    for (const d of result.decisions) {
      const { error: updErr } = await supabaseAdmin
        .from('cleaning_tasks')
        .update({ assignee_id: d.housekeeperId })
        .eq('id', d.taskId);
      if (updErr) {
        // Best-effort — the source of truth is hk_assignments. Log and continue.
        log.warn('run-auto-assign: failed to cache assignee_id', {
          propertyId, taskId: d.taskId, msg: updErr.message,
        });
      }
    }
  }

  return {
    propertyId,
    assigned: result.decisions.length,
    unassigned: result.unassigned.length,
    skippedAlreadyAssigned: alreadyAssigned.size,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Route handler
// ───────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const unauth = requireCronSecret(req);
  if (unauth) return unauth;

  try {
    // Honor a single-property override on the request (used by the
    // post-deploy smoke test and by manual re-runs from /admin). When
    // absent, fan out across all properties.
    const url = new URL(req.url);
    const overridePid = url.searchParams.get('propertyId');

    let propsQuery = supabaseAdmin.from('properties').select('id, timezone');
    if (overridePid) propsQuery = propsQuery.eq('id', overridePid);
    const { data: propsRows, error: propsErr } = await propsQuery;
    if (propsErr) {
      log.error('run-auto-assign: load properties failed', { requestId, msg: propsErr.message });
      return err('load properties failed', { requestId, status: 500, code: 'upstream_failure' });
    }
    const properties = (propsRows ?? []) as Array<{ id: string; timezone: string | null }>;

    const results: PropertyRunResult[] = [];
    for (const p of properties) {
      try {
        const r = await runForProperty(p.id, p.timezone);
        results.push(r);
      } catch (e) {
        log.error('run-auto-assign: property failed', {
          requestId, propertyId: p.id, msg: errToString(e),
        });
        results.push({
          propertyId: p.id, assigned: 0, unassigned: 0, skippedAlreadyAssigned: 0,
          reason: `error: ${errToString(e)}`,
        });
      }
    }

    const totals = results.reduce(
      (acc, r) => ({
        assigned: acc.assigned + r.assigned,
        unassigned: acc.unassigned + r.unassigned,
        skipped: acc.skipped + r.skippedAlreadyAssigned,
      }),
      { assigned: 0, unassigned: 0, skipped: 0 },
    );

    log.info('run-auto-assign: complete', { requestId, ...totals, properties: results.length });
    return ok({ totals, perProperty: results }, { requestId });
  } catch (e) {
    log.error('run-auto-assign: unexpected error', { requestId, msg: errToString(e) });
    return err('run failed', { requestId, status: 500, code: 'internal_error' });
  }
}
