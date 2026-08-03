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
 * Defaults:
 *   - businessDate    = today in the property's timezone
 *   - respectPriority = false (cron ignores schedule_priority)
 *   - assignedBy      = 'auto'
 *
 * The manager button calls with respectPriority=true (skip housekeepers
 * the manager set to "Never" on their staff card in Staff).
 *
 * WHO IS WORKING (2026-07-24): resolved from the REAL staff schedule
 * (`scheduled_shifts`) via resolveHousekeepingCrewForDate — the same
 * shared helper the board + timeline routes use, so the rooms the engine
 * places always land on someone the manager can see on the board.
 *
 * This replaced the old `respectScheduledToday` option, which gated on
 * `staff.scheduled_today` — a boolean that is `not null default false`
 * and that nothing ever writes. The cron passed `true`, so the filter
 * excluded EVERY housekeeper and the nightly run placed nothing; the
 * manager button passed `false` and assigned across the whole roster
 * including people who were off. Both now agree with the schedule, and
 * both fall back to the full roster when the hotel has no shifts on file
 * for that date (never silently assign nothing).
 *
 * Idempotent: only assigns canonical plan rows WITHOUT a current
 * room_work assignee, so manual reassignments + prior runs stick.
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
import { resolveHousekeepingCrewForDate } from '@/lib/schedule/active-crew';

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
  assignee_id: string | null;
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
  // Priority must match the AssignmentTaskPriority union. The canonical plan
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
  /** Skip crew with schedule_priority === 'excluded'. Cron: false.
   *  Manager button: true (honor the "Never auto-assign" setting on the
   *  staff member's card in Staff). */
  respectPriority?: boolean;
  /** Stored in room_work assignment history. Defaults to 'auto'. */
  assignedBy?: 'auto' | 'manual';
  /** Stored in room_work assignment history when a manager triggered it. */
  assignedByUserId?: string | null;
}

export async function runAutoAssignForProperty(
  propertyId: string,
  tz: string | null,
  opts: AutoAssignRunOptions = {},
): Promise<PropertyRunResult> {
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

  // 1. Load today's canonical plan rows in auto-assignable statuses.
  const { data: taskRows, error: taskErr } = await supabaseAdmin
    .from('room_work_plan_v1')
    .select('id, property_id, room_number, cleaning_type, priority, due_by, estimated_minutes, requires_inspection, extras, rule_inputs, status, assignee_id')
    .eq('property_id', propertyId)
    .eq('business_date', todayDate)
    .in('status', AUTO_ASSIGNABLE_STATUSES);
  if (taskErr) throw new Error(`load tasks: ${taskErr.message}`);
  const allTasks = (taskRows ?? []) as CleaningTaskRow[];

  if (allTasks.length === 0) {
    return { propertyId, assigned: 0, unassigned: 0, skippedAlreadyAssigned: 0, reason: 'no tasks today' };
  }

  // 2. Filter to tasks WITHOUT a current canonical assignee. Idempotency.
  const alreadyAssigned = new Set(
    allTasks.filter((task) => task.assignee_id).map((task) => task.id),
  );
  const tasksToPlace = allTasks.filter(t => !t.assignee_id);

  if (tasksToPlace.length === 0) {
    return {
      propertyId,
      assigned: 0, unassigned: 0,
      skippedAlreadyAssigned: alreadyAssigned.size,
      reason: 'all tasks already assigned',
    };
  }

  // 3. Load housekeeping roster, then narrow to the working set.
  //    Vacation + (optionally) schedule_priority are applied first, then
  //    the shared schedule resolver decides who is actually on shift for
  //    this date. Applying the roster filters BEFORE the resolver means
  //    the no-shifts-on-file fallback falls back to "everyone who could
  //    work", not "everyone on payroll".
  const { data: staffRows, error: staffErr } = await supabaseAdmin
    .from('staff')
    .select('id, name, language, is_senior, is_active, schedule_priority, department, weekly_hours, max_weekly_hours, vacation_dates')
    .eq('property_id', propertyId)
    .eq('department', 'housekeeping');
  if (staffErr) throw new Error(`load staff: ${staffErr.message}`);
  const allStaff = (staffRows ?? []) as StaffRow[];
  const available = allStaff.filter(s => {
    if (s.is_active === false) return false;
    if ((s.vacation_dates ?? []).includes(todayDate)) return false;
    if (respectPriority && s.schedule_priority === 'excluded') return false;
    return true;
  });

  const crew = await resolveHousekeepingCrewForDate({
    propertyId,
    date: todayDate,
    roster: available.map(s => ({ id: s.id, isActive: s.is_active })),
  });
  const working = available.filter(s => crew.memberIds.has(s.id));

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

  // 5. Persist decisions through the canonical assignment operation. It
  // rechecks the current assignee after taking the component-set lock, so a
  // manager reassignment that wins the race is a safe no-op rather than a
  // stale cache overwrite.
  let conflictNoops = 0;
  let insertFailures = 0;
  let placedCount = 0;
  if (result.decisions.length > 0) {
    for (const d of result.decisions) {
      const { data: assignmentRows, error: assignErr } = await supabaseAdmin.rpc(
        'assign_room_work_atomic',
        {
          p_property_id: propertyId,
          p_task_id: d.taskId,
          p_to_housekeeper_id: d.housekeeperId,
          p_assigned_by_user: assignedByUserId,
          p_reason: d.reason,
          p_queue_order: d.queueOrder,
          p_score: d.score,
          p_only_if_unassigned: true,
          p_assigned_by: assignedBy,
        },
      );
      if (assignErr) {
        const code = (assignErr as { code?: string }).code ?? '';
        if (code === '23505' || (code === 'P0001' && assignErr.message.includes('task not reassignable'))) {
          conflictNoops += 1;
          continue;
        }
        // Any other canonical error is retried by the next run; one bad
        // task must not prevent the rest of the property's batch from being
        // considered.
        log.warn('auto-assign-runner: canonical assignment failed (will retry next run)', {
          propertyId, taskId: d.taskId, msg: assignErr.message, code,
        });
        insertFailures += 1;
        continue;
      }
      const rpcRow = (Array.isArray(assignmentRows) ? assignmentRows[0] : assignmentRows) as {
        noop?: boolean;
      } | null;
      if (!rpcRow) {
        insertFailures += 1;
        log.warn('auto-assign-runner: canonical assignment returned no row', {
          propertyId, taskId: d.taskId,
        });
        continue;
      }
      if (rpcRow.noop) {
        conflictNoops += 1;
      } else {
        placedCount += 1;
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
