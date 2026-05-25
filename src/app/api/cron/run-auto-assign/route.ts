/**
 * GET /api/cron/run-auto-assign
 *
 * Continuous auto-assignment cron. Scheduled every 15 min (UTC) by
 * Vercel; see vercel.json crons section + cron-schedule-registry.ts.
 *
 * Schedule choice (2026-05-25):
 *   Picked "every 15 min, unconditional" over the two alternatives the
 *   orchestrator surfaced (fixed 11:30 UTC = 6:30am CT only, vs.
 *   per-property local-time gate). The reasons:
 *
 *     1. The engine is already idempotent — `runForProperty` only
 *        touches tasks WITHOUT an active hk_assignments row. Re-running
 *        every 15 min has no side effects once the day's work is placed.
 *
 *     2. `runForProperty(propertyId, tz)` resolves "today" via the
 *        property's OWN timezone (`todayInTz`). That means a single
 *        UTC-tick cron line correctly handles every timezone the fleet
 *        could add. No hardcoded 11:30 UTC bias, no per-property gating
 *        code path that would need updates when we cross DST.
 *
 *     3. New cleaning_tasks created by the rules-engine cron mid-day
 *        (e.g. late-checkin guests, rush flags) get picked up within
 *        15 min of creation — instead of sitting unassigned until the
 *        next morning's shift-start tick.
 *
 *     4. The "shift-start guarantee" is preserved as a special case:
 *        by 6:30am local at any property, every tick since 6am UTC has
 *        already run, and all tasks for the day are assigned.
 *
 *   Trade-off: 96 invocations/day instead of 1. Vercel cron is metered
 *   on plan minutes — at the route's ~1s typical duration with zero
 *   property work to do, that's ~96s/day of Pro-plan budget. Negligible.
 *
 * Concurrency:
 *   Two overlapping ticks can race on the partial unique index on
 *   hk_assignments(cleaning_task_id) WHERE is_active. The route catches
 *   the resulting 23505 unique-violation and treats it as a no-op (see
 *   the conflictNoops counter below). Net result: whichever tick lost
 *   the race silently steps aside; the task ends up assigned exactly
 *   once.
 *
 * Auto-assigns unassigned cleaning_tasks to housekeepers using the
 * scoring engine in src/lib/assignment-engine.
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
import { writeCronHeartbeat } from '@/lib/cron-heartbeat';
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
  // Refuse to run for properties without a configured timezone. Without
  // it `todayInTz` silently falls back to UTC, which around local
  // midnight produces the WRONG business_date — a property at UTC-5
  // running at 02:00 UTC would assign "tomorrow's" tasks because UTC
  // has already rolled. Better to skip and surface the misconfig.
  if (!tz || typeof tz !== 'string' || tz.trim().length === 0) {
    return {
      propertyId,
      assigned: 0, unassigned: 0, skippedAlreadyAssigned: 0,
      reason: 'missing or invalid timezone',
    };
  }
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

  // 5. Persist decisions. Insert hk_assignments rows then update the
  // cleaning_tasks.assignee_id cache. Concurrent cron runs are possible
  // (two regions, manual retrigger, etc.), so we insert one row at a
  // time and treat a 23505 unique-violation as "another runner placed
  // this task already" — keeps the cron idempotent under contention.
  //
  // Failed inserts (other error codes) abort the rest so we don't paper
  // over a structural issue. Failed cache updates are warned and
  // continue — hk_assignments is the source of truth, the cache just
  // saves a join on the housekeeper-facing reads.
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
        assigned_by: 'auto' as const,
        assigned_by_user_id: null,
        reason: d.reason,
        score: d.score,
      });
      if (insErr) {
        // 23505 unique_violation = the partial unique index on
        // (cleaning_task_id) where is_active=true fired. Means another
        // runner (concurrent cron, manual reassignment that beat us)
        // placed this task between our existing-assignment check and
        // this insert. Treat as a successful no-op — re-running the
        // cron later will see the active row and skip the task entirely.
        const code = (insErr as { code?: string }).code ?? '';
        if (code === '23505') {
          conflictNoops += 1;
          continue;
        }
        // Any OTHER insert error (FK violation, transient connection
        // drop, etc.) was previously a `throw` that aborted the whole
        // property run — leaving the FIRST-K tasks placed and the
        // remaining N-K unplaced, with no record of which is which.
        // Log + count + continue so a single bad task doesn't take
        // the whole cron tick down. The next 15-min tick will retry
        // the unplaced ones because they still have no active row.
        log.warn('run-auto-assign: insert failed (will retry next tick)', {
          propertyId, taskId: d.taskId, msg: insErr.message, code,
        });
        insertFailures += 1;
        continue;
      }
      placedCount += 1;

      // Cache the assignee on cleaning_tasks. Scoped by property_id and
      // — load-bearing for the manual-reassignment race — by `assignee_id`
      // being either null (still unassigned at the cache level) or
      // already matching our HK (idempotent re-write).
      //
      // Without the assignee_id guard, the following race corrupts the
      // cache: (a) cron inserts auto row, (b) before cron updates cache,
      // a manager reassigns via /api/housekeeping/reassign (the RPC
      // SELECT FOR UPDATEs the task row, deactivates auto row, inserts
      // manual row, sets cache to manager's HK), (c) cron now overwrites
      // cache with the auto HK. End state: hk_assignments active row =
      // manager's HK, but cleaning_tasks.assignee_id = auto HK. With the
      // guard, step (c) sees assignee_id != null and != auto HK, so it's
      // a no-op — the cache stays consistent with the source of truth.
      const { error: updErr } = await supabaseAdmin
        .from('cleaning_tasks')
        .update({ assignee_id: d.housekeeperId })
        .eq('id', d.taskId)
        .eq('property_id', propertyId)
        .or(`assignee_id.is.null,assignee_id.eq.${d.housekeeperId}`);
      if (updErr) {
        log.warn('run-auto-assign: failed to cache assignee_id', {
          propertyId, taskId: d.taskId, msg: updErr.message,
        });
      }
    }
    if (conflictNoops > 0) {
      log.info('run-auto-assign: concurrent placements detected', {
        propertyId, conflictNoops,
      });
    }
  }

  return {
    propertyId,
    assigned: placedCount,
    unassigned: result.unassigned.length + insertFailures,
    skippedAlreadyAssigned: alreadyAssigned.size,
    reason: insertFailures > 0 ? `${insertFailures} insert failure(s) — retry next tick` : undefined,
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

    // Heartbeat the doctor's cron_heartbeats_fresh check. Same shape as
    // run-rules-engine — totals + property count so the dashboard can
    // distinguish a quiet tick (no new tasks to assign) from a stuck
    // cron. Failures here are non-fatal: an upstream Supabase blip
    // shouldn't fail the cron just because the heartbeat write didn't
    // land.
    //
    // Status: 'degraded' if any property's run had a reason field set
    // (caught error, missing tz, insert failure, etc.). Without this
    // flag, per-property errors get swallowed into the result list and
    // the doctor stays green even when some properties received no
    // assignments — false-confidence regression Codex flagged on the
    // first sweep of this commit.
    const propsWithIssues = results.filter(r => r.reason);
    const status = propsWithIssues.length > 0 ? 'degraded' : 'ok';
    await writeCronHeartbeat('run-auto-assign', {
      requestId,
      status,
      notes: {
        ...totals,
        properties: results.length,
        propertiesWithIssues: propsWithIssues.length,
        issueReasons: propsWithIssues.map(p => ({ propertyId: p.propertyId, reason: p.reason })),
        scoped: Boolean(overridePid),
      },
    });

    return ok({ totals, perProperty: results, status }, { requestId });
  } catch (e) {
    log.error('run-auto-assign: unexpected error', { requestId, msg: errToString(e) });
    return err('run failed', { requestId, status: 500, code: 'internal_error' });
  }
}
