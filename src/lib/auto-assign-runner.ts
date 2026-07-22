/**
 * auto-assign-runner — the per-property auto-assignment worker.
 *
 * Extracted from src/app/api/cron/run-auto-assign/route.ts (2026-06-05)
 * so the new manager-facing "Auto-assign" button on the Schedule board
 * (POST /api/housekeeping/auto-assign) can reuse the EXACT same engine +
 * persistence path the 15-min cron uses. The cron's GET handler still
 * owns fan-out across properties + the heartbeat; this module owns the
 * single-property work.
 *
 * Defaults preserve the cron's historical behaviour 1:1:
 *   - businessDate          = today in the property's timezone
 *   - respectScheduledToday = true  (only crew marked working today)
 *   - respectPriority       = false (cron ignores schedule_priority)
 *   - assignedBy            = 'auto'
 *
 * The manager button calls with respectScheduledToday=false (the manager
 * is looking at the crew on the board and wants the rooms spread across
 * all of them) and respectPriority=true (skip housekeepers the manager
 * marked "Excluded" in the priority modal).
 *
 * Idempotent: only assigns cleaning_tasks WITHOUT an active
 * hk_assignments row, so manual reassignments + prior runs stick.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  assignTasks,
  makeAssignmentConfig,
  type AssignmentTask,
  type AssignmentHousekeeper,
  type AssignmentTaskPriority,
} from '@/lib/assignment-engine';
import { fetchCleanTimeBaseDurations } from '@/lib/clean-time-standards-server';
import { computeWeeklyLoadByStaff } from '@/lib/schedule/weekly-load';

// ───────────────────────────────────────────────────────────────────────
// Status windows
// ───────────────────────────────────────────────────────────────────────

/** Cleaning task statuses we're willing to auto-assign. Anything beyond
 *  these (in_progress, completed, cancelled, etc.) has either started
 *  or is no longer relevant — the engine never touches those rows. */
export const AUTO_ASSIGNABLE_STATUSES = ['scheduled', 'ready_now', 'deferred'] as const;

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

/** Compute today's date in YYYY-MM-DD using the property's timezone. */
export function todayInTz(tz: string | null): string {
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
  schedule_priority: string | null;
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

function staffRowToHk(s: StaffRow, weeklyHours: number): AssignmentHousekeeper {
  return {
    id: s.id,
    name: s.name,
    language: s.language === 'es' ? 'es' : 'en',
    isSenior: s.is_senior === true,
    isActive: s.is_active !== false,
    homeFloor: null,
    // Real committed hours this week (from scheduled_shifts) — NOT the stale
    // staff.weekly_hours column, which is never populated. This is what makes
    // the overtime penalty (scoreOvertime) actually fire near the cap.
    weeklyHours,
    maxWeeklyHours: s.max_weekly_hours ?? 40,
    // The runner pre-filters the working set below, so anyone reaching the
    // engine is genuinely working — never let isOutToday re-exclude them.
    isOutToday: false,
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

export interface PropertyRunResult {
  propertyId: string;
  assigned: number;
  unassigned: number;
  skippedAlreadyAssigned: number;
  reason?: string;
}

export interface AutoAssignRunOptions {
  /** Override the business date (YYYY-MM-DD). Defaults to today in `tz`.
   *  The manager board passes the date it's currently showing. */
  businessDate?: string;
  /** Only assign to crew with scheduled_today !== false. Cron: true.
   *  Manager button: false (assign across everyone on the board). */
  respectScheduledToday?: boolean;
  /** Skip crew with schedule_priority === 'excluded'. Cron: false.
   *  Manager button: true (honor the priority modal's Excluded chips). */
  respectPriority?: boolean;
  /** Stored on hk_assignments.assigned_by. Defaults to 'auto'. */
  assignedBy?: 'auto' | 'manual';
  /** Stored on hk_assignments.assigned_by_user_id when a manager triggered it. */
  assignedByUserId?: string | null;
}

export async function runAutoAssignForProperty(
  propertyId: string,
  tz: string | null,
  opts: AutoAssignRunOptions = {},
): Promise<PropertyRunResult> {
  const respectScheduledToday = opts.respectScheduledToday ?? true;
  const respectPriority = opts.respectPriority ?? false;
  const assignedBy = opts.assignedBy ?? 'auto';
  const assignedByUserId = opts.assignedByUserId ?? null;

  // Refuse to run for properties without a configured timezone. Without
  // it `todayInTz` silently falls back to UTC, which around local
  // midnight produces the WRONG business_date — a property at UTC-5
  // running at 02:00 UTC would assign "tomorrow's" tasks because UTC
  // has already rolled. Better to skip and surface the misconfig.
  // (Only matters when the caller relies on the default date.)
  if (!opts.businessDate && (!tz || typeof tz !== 'string' || tz.trim().length === 0)) {
    return {
      propertyId,
      assigned: 0, unassigned: 0, skippedAlreadyAssigned: 0,
      reason: 'missing or invalid timezone',
    };
  }
  if (tz) {
    // Validate the tz string parses — Intl.DateTimeFormat throws on
    // unrecognized IANA names. Skip silently with a reason rather than
    // letting the throw bubble up and 500 the whole cron.
    try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); }
    catch {
      return {
        propertyId,
        assigned: 0, unassigned: 0, skippedAlreadyAssigned: 0,
        reason: `invalid timezone: ${tz}`,
      };
    }
  }

  const todayDate = opts.businessDate ?? todayInTz(tz);

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

  // 3. Load housekeeping roster, then narrow to the working set per the
  //    caller's policy. Vacation is ALWAYS respected; scheduled_today and
  //    schedule_priority are gated by the options so the cron and the
  //    manual manager action can diverge without two code paths.
  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name, language, is_senior, is_active, scheduled_today, schedule_priority, department, weekly_hours, max_weekly_hours, vacation_dates')
    .eq('property_id', propertyId)
    .eq('department', 'housekeeping');
  if (staffErr) throw new Error(`load staff: ${staffErr.message}`);
  const allStaff = (staffRows ?? []) as StaffRow[];
  const working = allStaff.filter(s => {
    if (s.is_active === false) return false;
    if ((s.vacation_dates ?? []).includes(todayDate)) return false;
    if (respectScheduledToday && s.scheduled_today === false) return false;
    if (respectPriority && s.schedule_priority === 'excluded') return false;
    return true;
  });
  // Committed weekly hours per housekeeper (from scheduled_shifts) so the
  // engine's overtime penalty reflects reality instead of a constant 0.
  const weeklyLoad = await computeWeeklyLoadByStaff(propertyId, todayDate);
  const workingHks = working.map(s => staffRowToHk(s, weeklyLoad.get(s.id)?.hours ?? 0));

  if (workingHks.length === 0) {
    return {
      propertyId,
      assigned: 0,
      unassigned: tasksToPlace.length,
      skippedAlreadyAssigned: alreadyAssigned.size,
      reason: 'no housekeepers working today',
    };
  }

  // 4. Run the engine. Overlay the property's manager-set Clean Times
  //    (migration 0244) onto the static base durations so the assignment
  //    fallback (used only for tasks lacking a stored estimated_minutes)
  //    matches the board/timeline. Degrades to defaults when none exist.
  const cleanTimeBase = await fetchCleanTimeBaseDurations(propertyId);
  const cfg = makeAssignmentConfig({ baseDurations: cleanTimeBase });
  const assignmentTasks = tasksToPlace.map(taskRowToAssignmentTask);
  const result = assignTasks(assignmentTasks, workingHks, cfg);

  // 5. Persist decisions. Insert hk_assignments rows then update the
  // cleaning_tasks.assignee_id cache. Concurrent runs are possible (the
  // 15-min cron + a manager click overlapping), so we insert one row at a
  // time and treat a 23505 unique-violation as "another runner placed
  // this task already" — keeps the path idempotent under contention.
  let conflictNoops = 0;
  let insertFailures = 0;
  let placedCount = 0;
  if (result.decisions.length > 0) {
    for (const d of result.decisions) {
      const { error: insErr } = await supabaseAdmin.from('hk_assignments').insert({
        property_id: propertyId,
        cleaning_task_id: d.taskId,
        housekeeper_id: d.housekeeperId,
        queue_order: d.queueOrder,
        is_active: true,
        assigned_at: new Date().toISOString(),
        assigned_by: assignedBy,
        assigned_by_user_id: assignedByUserId,
        reason: d.reason,
        score: d.score,
      });
      if (insErr) {
        // 23505 unique_violation = the partial unique index on
        // (cleaning_task_id) where is_active=true fired. Another runner
        // placed this task between our existing-assignment check and this
        // insert. Treat as a successful no-op.
        const code = (insErr as { code?: string }).code ?? '';
        if (code === '23505') {
          conflictNoops += 1;
          continue;
        }
        // Any OTHER insert error: log + count + continue so a single bad
        // task doesn't take the whole run down. The next pass retries the
        // unplaced ones because they still have no active row.
        log.warn('auto-assign-runner: insert failed (will retry next run)', {
          propertyId, taskId: d.taskId, msg: insErr.message, code,
        });
        insertFailures += 1;
        continue;
      }
      placedCount += 1;

      // Cache the assignee on cleaning_tasks. The assignee_id guard (null
      // OR already-us) prevents clobbering a manager reassignment that
      // raced between our insert and this update — see run-auto-assign for
      // the full race analysis.
      const { error: updErr } = await supabaseAdmin
        .from('cleaning_tasks')
        .update({ assignee_id: d.housekeeperId })
        .eq('id', d.taskId)
        .eq('property_id', propertyId)
        .or(`assignee_id.is.null,assignee_id.eq.${d.housekeeperId}`);
      if (updErr) {
        log.warn('auto-assign-runner: failed to cache assignee_id', {
          propertyId, taskId: d.taskId, msg: updErr.message,
        });
      }
    }
    if (conflictNoops > 0) {
      log.info('auto-assign-runner: concurrent placements detected', {
        propertyId, conflictNoops,
      });
    }
  }

  return {
    propertyId,
    assigned: placedCount,
    unassigned: result.unassigned.length + insertFailures,
    skippedAlreadyAssigned: alreadyAssigned.size,
    reason: insertFailures > 0 ? `${insertFailures} insert failure(s) — retry next run` : undefined,
  };
}
