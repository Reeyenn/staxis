/**
 * Sick-callout coverage flow — DB-touching service layer.
 *
 * Public surface:
 *   - createCallout()             — insert the callout row, return its id
 *   - revertCallout()             — flip status='reverted', un-spread rooms
 *   - runRedistributionForCallout() — find rooms to re-spread, write impacted_assignments
 *   - listActiveCalloutsForBanner() — banner read for the manager Schedule tab
 *   - hasActiveCalloutToday()     — used by the housekeeper page button label
 *
 * Conventions:
 *   - All public functions take supabaseAdmin from the caller so the route
 *     handlers can pass through the same client they used for capability
 *     checks, and so future cron callers can hand a fresh client.
 *   - Idempotency: createCallout returns the existing row when a duplicate
 *     hits the partial-unique index (one active callout per staff per day).
 *     callers see no error, same callout_id back.
 *   - All redistribution failures are NON-fatal to the callout itself —
 *     a Postgres hiccup mid-flow leaves the callout row intact with
 *     redistributed_at=null, and the cron processor retries on the next tick.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  planRevert,
  computeRedistributeAt,
  type CurrentTaskState,
} from './redistribute-policy';
import {
  rebalanceForSickCallout,
  makeAssignmentConfig,
  type AssignmentTask,
  type AssignmentHousekeeper,
  type AssignmentTaskPriority,
} from '@/lib/assignment-engine';
import type {
  CalloutEvent,
  CalloutReporter,
  CalloutReason,
  CalloutLeaveTiming,
  CalloutBannerEntry,
  ImpactedAssignment,
  RevertOutcomeEntry,
} from './types';

// Statuses on cleaning_tasks that mean "not yet started" — only these
// rows are candidates for redistribution. Anything started (in_progress,
// paused, completed, inspection_*, correction_*, check_*) stays with the
// sick HK so they keep credit for work they actually did.
const STATUSES_NOT_YET_STARTED = new Set(['scheduled', 'ready_now', 'deferred']);

// Statuses that mean the sick HK was actively cleaning a room. Used by the
// retained-with-sick audit on impacted_assignments + by the cron's
// "after_current_room" gate.
const STATUSES_TASK_ALREADY_OWNED = new Set([
  'in_progress',
  'paused',
  'completed',
  'inspection_pending',
  'inspected_pass',
  'inspected_fail',
  'correction_pending',
  'correction_complete',
  'check_pending',
  'check_complete',
]);

// ───────────────────────────────────────────────────────────────────────
// SHARED TYPES
// ───────────────────────────────────────────────────────────────────────

export interface CreateCalloutInput {
  propertyId: string;
  staffId: string;
  businessDate: string;            // 'YYYY-MM-DD'
  reportedBy: CalloutReporter;
  reportedByUserId?: string | null;
  reason?: CalloutReason | null;
  note?: string | null;
  leaveTiming?: CalloutLeaveTiming | null;
}

export interface CreateCalloutResult {
  calloutId: string;
  /** True on a fresh insert; false when the partial-unique index caught
      a duplicate and we returned the existing active callout. */
  created: boolean;
  /** When the cron should fire the redistribute. */
  redistributeAt: string;
}

export interface RevertCalloutInput {
  calloutId: string;
  /** Auth UUID of the manager doing the revert; null if a housekeeper
      reverted their own callout (in which case revertedByStaffId is set). */
  revertedByUserId?: string | null;
  revertedByStaffId?: string | null;
  revertReason?: string | null;
}

export interface RevertCalloutResult {
  returnedCount: number;
  retainedCount: number;
  outcome: RevertOutcomeEntry[];
  /** The callout row after revert, for the API response. */
  callout: CalloutEvent;
}

// ───────────────────────────────────────────────────────────────────────
// CREATE CALLOUT
// ───────────────────────────────────────────────────────────────────────

/**
 * Insert a callout event. Returns the new (or existing) callout id and
 * when the redistribute will fire. Does NOT run the redistribute itself
 * — that's done by runRedistributionForCallout() so the API route can
 * return fast and the cron picks up the work asynchronously.
 *
 * Idempotency: the partial unique index on (staff_id, business_date)
 * WHERE status='active' guarantees at most one active callout per HK per
 * day. On conflict, we look up the existing row and return it as if the
 * caller had just created it — so re-tapping the mobile button or a
 * Twilio webhook retry doesn't error out and doesn't create duplicates.
 */
export async function createCallout(
  supabase: SupabaseClient,
  input: CreateCalloutInput,
): Promise<CreateCalloutResult> {
  const reportedAt = new Date();
  const redistributeAt = computeRedistributeAt(reportedAt, input.leaveTiming ?? null);

  const payload = {
    property_id: input.propertyId,
    staff_id: input.staffId,
    business_date: input.businessDate,
    reported_at: reportedAt.toISOString(),
    reported_by: input.reportedBy,
    reported_by_user_id: input.reportedByUserId ?? null,
    reason: input.reason ?? null,
    note: input.note ?? null,
    leave_timing: input.leaveTiming ?? null,
    status: 'active' as const,
    redistribute_at: redistributeAt.toISOString(),
  };

  const insert = await supabase
    .from('callout_events')
    .insert(payload)
    .select('id, redistribute_at')
    .maybeSingle();

  if (insert.data && !insert.error) {
    return {
      calloutId: insert.data.id as string,
      created: true,
      redistributeAt: insert.data.redistribute_at as string,
    };
  }

  // The partial unique index throws 23505 on duplicate active rows.
  // Look up the existing active callout and return it idempotently.
  const code = (insert.error as { code?: string } | null)?.code ?? '';
  if (code === '23505') {
    const existing = await supabase
      .from('callout_events')
      .select('id, redistribute_at')
      .eq('staff_id', input.staffId)
      .eq('business_date', input.businessDate)
      .eq('status', 'active')
      .maybeSingle();
    if (existing.data && !existing.error) {
      return {
        calloutId: existing.data.id as string,
        created: false,
        redistributeAt: (existing.data.redistribute_at as string | null) ?? reportedAt.toISOString(),
      };
    }
    throw new Error(
      `createCallout: duplicate active callout but lookup failed: ${existing.error?.message ?? 'no row'}`,
    );
  }

  throw new Error(`createCallout: insert failed: ${insert.error?.message ?? 'unknown'}`);
}

// ───────────────────────────────────────────────────────────────────────
// REDISTRIBUTE
// ───────────────────────────────────────────────────────────────────────

/**
 * Re-spread the sick housekeeper's remaining cleaning_tasks across the
 * other eligible HKs scheduled today. Writes the impacted_assignments
 * payload to the callout row and stamps redistributed_at.
 *
 * Returns immediately if redistributed_at is already set (idempotent —
 * the cron may retry a callout it already processed during the same
 * tick if the first attempt's COMMIT was slow).
 *
 * Uses `rebalanceForSickCallout` from @/lib/assignment-engine for the
 * actual scoring (floor cohesion, language match, skill match, workload
 * balance, overtime cap). Side effects (hk_assignments insert/deactivate,
 * cleaning_tasks.assignee_id update) mirror /api/cron/run-auto-assign so
 * the same source-of-truth rules hold for both initial assignment and
 * rebalance.
 */
export async function runRedistributionForCallout(
  supabase: SupabaseClient,
  calloutId: string,
): Promise<{ alreadyDone: boolean; impacted: ImpactedAssignment[] }> {
  // Read the callout under a fresh lookup so we don't double-process if
  // the cron re-fires a row that was already handled.
  const calloutLookup = await supabase
    .from('callout_events')
    .select('*')
    .eq('id', calloutId)
    .maybeSingle();
  if (calloutLookup.error || !calloutLookup.data) {
    throw new Error(`runRedistributionForCallout: callout ${calloutId} not found`);
  }
  const callout = calloutLookup.data as CalloutEvent;
  if (callout.status !== 'active') {
    return { alreadyDone: true, impacted: callout.impacted_assignments ?? [] };
  }
  if (callout.redistributed_at) {
    return { alreadyDone: true, impacted: callout.impacted_assignments ?? [] };
  }

  // Pull the sick HK's cleaning_tasks. We pull EVERY status so we can
  // separate retained-with-sick (already started) from candidates for
  // redistribution (not yet started).
  const tasksLookup = await supabase
    .from('cleaning_tasks')
    .select('id, property_id, room_number, cleaning_type, priority, due_by, estimated_minutes, requires_inspection, extras, rule_inputs, status, assignee_id, started_at')
    .eq('property_id', callout.property_id)
    .eq('business_date', callout.business_date)
    .eq('assignee_id', callout.staff_id);

  // The cleaning_tasks table is owned by feature/cleaning-rules-engine and
  // may not yet exist in some dev deploys. Treat "table missing" as
  // "nothing to redistribute" — the callout is still recorded.
  const tasksMissingTable =
    tasksLookup.error &&
    /relation .*cleaning_tasks.* does not exist/i.test(tasksLookup.error.message ?? '');
  if (tasksLookup.error && !tasksMissingTable) {
    throw new Error(
      `runRedistributionForCallout: cleaning_tasks read failed: ${tasksLookup.error.message}`,
    );
  }
  const allSickTasks = tasksMissingTable ? [] : (tasksLookup.data ?? []);

  // Split: candidates for re-spread vs. tasks that stay with the sick HK.
  const toRespread = allSickTasks.filter((r) =>
    STATUSES_NOT_YET_STARTED.has(r.status as string),
  );
  // Tasks the sick HK keeps don't go into impacted_assignments (the revert
  // path doesn't touch them). The line below references the bucket so
  // future cron logging can surface it.
  void allSickTasks.filter((r) => STATUSES_TASK_ALREADY_OWNED.has(r.status as string));

  // Build engine inputs.
  const assignmentTasks: AssignmentTask[] = toRespread.map((r) =>
    cleaningTaskRowToAssignmentTask(r as CleaningTaskRow),
  );
  const { roster, workloadByHk } = await fetchEligibleRosterAndWorkload(
    supabase,
    callout.property_id,
    callout.business_date,
    callout.staff_id,
  );

  // Score + place.
  const cfg = makeAssignmentConfig({});
  const result = rebalanceForSickCallout(assignmentTasks, roster, workloadByHk, cfg);

  // Map engine output → ImpactedAssignment[] for the audit log.
  const decisionByTaskId = new Map(result.decisions.map((d) => [d.taskId, d]));
  const impacted: ImpactedAssignment[] = toRespread.map((task) => {
    const decision = decisionByTaskId.get(task.id as string);
    return {
      task_id: task.id as string,
      room_number: task.room_number as string,
      original_assignee_id: callout.staff_id,
      redistributed_to: decision?.housekeeperId ?? null,
      task_status_at_redistribute: task.status as string,
    };
  });

  // Apply DB changes. Order: deactivate sick HK's hk_assignments → insert
  // rebalance rows → update cached cleaning_tasks.assignee_id.
  const hkAssignmentsAvailable = await hkAssignmentsTableExists(supabase);

  if (hkAssignmentsAvailable && toRespread.length > 0) {
    const taskIds = toRespread.map((t) => t.id as string);
    const { error: deactivateErr } = await supabase
      .from('hk_assignments')
      .update({ is_active: false })
      .eq('property_id', callout.property_id)
      .eq('housekeeper_id', callout.staff_id)
      .eq('is_active', true)
      .in('cleaning_task_id', taskIds);
    if (deactivateErr) {
      throw new Error(
        `runRedistributionForCallout: failed to deactivate sick HK's hk_assignments: ${deactivateErr.message}`,
      );
    }

    if (result.decisions.length > 0) {
      const now = new Date().toISOString();
      const inserts = result.decisions.map((d) => ({
        property_id: callout.property_id,
        cleaning_task_id: d.taskId,
        housekeeper_id: d.housekeeperId,
        queue_order: d.queueOrder,
        is_active: true,
        assigned_at: now,
        assigned_by: 'rebalance' as const,
        assigned_by_user_id: callout.reported_by_user_id,
        reason: d.reason,
        score: d.score,
      }));
      const { error: insertErr } = await supabase
        .from('hk_assignments')
        .insert(inserts);
      if (insertErr) {
        throw new Error(
          `runRedistributionForCallout: failed to insert rebalance hk_assignments: ${insertErr.message}`,
        );
      }
    }
  }

  // Update cached assignee_id on cleaning_tasks (manager UI + housekeeper
  // page read from here directly).
  for (const entry of impacted) {
    const upd = await supabase
      .from('cleaning_tasks')
      .update({ assignee_id: entry.redistributed_to })
      .eq('id', entry.task_id);
    if (upd.error && !tasksMissingTable) {
      throw new Error(
        `runRedistributionForCallout: failed to reassign task ${entry.task_id}: ${upd.error.message}`,
      );
    }
  }

  // Stamp the callout. Status stays 'active' (only revert flips it);
  // redistributed_at being set is the signal the cron is done.
  const stamp = await supabase
    .from('callout_events')
    .update({
      redistributed_at: new Date().toISOString(),
      impacted_assignments: impacted,
    })
    .eq('id', calloutId)
    .eq('status', 'active');
  if (stamp.error) {
    throw new Error(
      `runRedistributionForCallout: failed to stamp callout ${calloutId}: ${stamp.error.message}`,
    );
  }

  return { alreadyDone: false, impacted };
}

// ───────────────────────────────────────────────────────────────────────
// Engine-input adapters (mirror /api/cron/run-auto-assign/route.ts)
// ───────────────────────────────────────────────────────────────────────

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
  assignee_id?: string | null;
  started_at?: string | null;
};

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

const ASSIGNMENT_PRIORITY: Record<string, AssignmentTaskPriority> = {
  urgent: 'urgent', high: 'high', normal: 'normal', low: 'low',
};

function cleaningTaskRowToAssignmentTask(t: CleaningTaskRow): AssignmentTask {
  const extrasArr = Array.isArray(t.extras) ? (t.extras as unknown[]) : [];
  const extras = extrasArr.filter((x): x is string => typeof x === 'string');
  const ri = t.rule_inputs ?? {};
  const lang = typeof ri.guest_language === 'string' ? ri.guest_language : null;
  const guest_language: 'en' | 'es' | null =
    lang === 'es' ? 'es' : lang === 'en' ? 'en' : null;
  return {
    id: t.id,
    property_id: t.property_id,
    room_number: t.room_number,
    cleaning_type: t.cleaning_type,
    priority: ASSIGNMENT_PRIORITY[t.priority] ?? 'normal',
    due_by: t.due_by,
    estimated_minutes: t.estimated_minutes,
    requires_inspection: t.requires_inspection === true,
    extras,
    guest_language,
  };
}

function staffRowToHousekeeper(s: StaffRow, businessDate: string): AssignmentHousekeeper {
  const onVacation = (s.vacation_dates ?? []).includes(businessDate);
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

/**
 * Load eligible roster + current per-HK workload in minutes. Workload feeds
 * the engine's workload-balance scorer so we don't pile new rooms on
 * already-loaded HKs.
 */
async function fetchEligibleRosterAndWorkload(
  supabase: SupabaseClient,
  propertyId: string,
  businessDate: string,
  excludeStaffId: string,
): Promise<{ roster: AssignmentHousekeeper[]; workloadByHk: Record<string, number> }> {
  const staffLookup = await supabase
    .from('staff')
    .select('id, name, language, is_senior, is_active, scheduled_today, department, weekly_hours, max_weekly_hours, vacation_dates')
    .eq('property_id', propertyId)
    .eq('department', 'housekeeping')
    .neq('id', excludeStaffId);
  if (staffLookup.error) {
    throw new Error(`fetchEligibleRoster: staff lookup failed: ${staffLookup.error.message}`);
  }
  const rows = (staffLookup.data ?? []) as StaffRow[];

  // Drop anyone who is themselves out on an active callout today.
  const calloutLookup = await supabase
    .from('callout_events')
    .select('staff_id')
    .eq('property_id', propertyId)
    .eq('business_date', businessDate)
    .eq('status', 'active');
  const sickIds = new Set(
    ((calloutLookup.data ?? []) as Array<{ staff_id: string }>).map((r) => r.staff_id),
  );

  const roster = rows
    .filter((s) => !sickIds.has(s.id))
    .map((s) => staffRowToHousekeeper(s, businessDate))
    .filter((h) => h.isActive && !h.isOutToday);

  const workloadByHk: Record<string, number> = {};
  if (roster.length === 0) {
    return { roster, workloadByHk };
  }
  const loadLookup = await supabase
    .from('cleaning_tasks')
    .select('assignee_id, estimated_minutes, cleaning_type')
    .eq('property_id', propertyId)
    .eq('business_date', businessDate)
    .in('assignee_id', roster.map((h) => h.id));
  if (!loadLookup.error && loadLookup.data) {
    const FALLBACK_MIN_BY_TYPE: Record<string, number> = {
      departure: 30, departure_deep: 60, stayover: 15, refresh: 10,
      deep: 60, room_check: 5, inspection_only: 8, no_clean: 0,
    };
    for (const row of loadLookup.data as Array<{
      assignee_id: string | null;
      estimated_minutes: number | null;
      cleaning_type: string | null;
    }>) {
      if (!row.assignee_id) continue;
      const min =
        row.estimated_minutes ??
        FALLBACK_MIN_BY_TYPE[row.cleaning_type ?? ''] ??
        20;
      workloadByHk[row.assignee_id] = (workloadByHk[row.assignee_id] ?? 0) + min;
    }
  }
  return { roster, workloadByHk };
}

async function hkAssignmentsTableExists(supabase: SupabaseClient): Promise<boolean> {
  const probe = await supabase.from('hk_assignments').select('id').limit(0);
  if (probe.error && /relation .*hk_assignments.* does not exist/i.test(probe.error.message ?? '')) {
    return false;
  }
  return true;
}

// ───────────────────────────────────────────────────────────────────────
// REVERT
// ───────────────────────────────────────────────────────────────────────

export async function revertCallout(
  supabase: SupabaseClient,
  input: RevertCalloutInput,
): Promise<RevertCalloutResult> {
  const calloutLookup = await supabase
    .from('callout_events')
    .select('*')
    .eq('id', input.calloutId)
    .maybeSingle();
  if (calloutLookup.error || !calloutLookup.data) {
    throw new Error(`revertCallout: callout ${input.calloutId} not found`);
  }
  const callout = calloutLookup.data as CalloutEvent;
  if (callout.status === 'reverted') {
    return {
      returnedCount: 0,
      retainedCount: 0,
      outcome: callout.revert_outcome ?? [],
      callout,
    };
  }

  const impacted = (callout.impacted_assignments ?? []) as ImpactedAssignment[];

  // Look up the CURRENT state of every impacted task so the revert
  // policy can apply the "started_at the new assignee → stays with them"
  // rule against fresh data.
  const taskIds = impacted.map((e) => e.task_id);
  const currentByTaskId = new Map<string, CurrentTaskState>();
  if (taskIds.length > 0) {
    const lookup = await supabase
      .from('cleaning_tasks')
      .select('id, status, assignee_id')
      .in('id', taskIds);
    if (lookup.error) {
      const missing = /relation .*cleaning_tasks.* does not exist/i.test(lookup.error.message ?? '');
      if (!missing) {
        throw new Error(`revertCallout: cleaning_tasks read failed: ${lookup.error.message}`);
      }
    } else {
      for (const row of (lookup.data ?? []) as Array<{
        id: string;
        status: string;
        assignee_id: string | null;
      }>) {
        currentByTaskId.set(row.id, {
          id: row.id,
          status: row.status,
          assignee_id: row.assignee_id ?? null,
        });
      }
    }
  }

  const decisions = planRevert(impacted, currentByTaskId);
  let returnedCount = 0;
  let retainedCount = 0;

  // Mirror the redistribute path's hk_assignments lifecycle: deactivate
  // the rebalance row(s) we're undoing, then insert a fresh rebalance
  // row putting the task back with the sick HK, then update the cached
  // cleaning_tasks.assignee_id pointer.
  const hkAssignmentsAvailable = await hkAssignmentsTableExists(supabase);
  const tasksToReturn = decisions.filter((d) => d.apply);

  if (hkAssignmentsAvailable && tasksToReturn.length > 0) {
    const returnTaskIds = tasksToReturn.map((d) => d.task_id);
    const { error: deactivateErr } = await supabase
      .from('hk_assignments')
      .update({ is_active: false })
      .eq('property_id', callout.property_id)
      .eq('is_active', true)
      .in('cleaning_task_id', returnTaskIds);
    if (deactivateErr) {
      throw new Error(
        `revertCallout: failed to deactivate rebalance hk_assignments: ${deactivateErr.message}`,
      );
    }

    const now = new Date().toISOString();
    const inserts = tasksToReturn.map((d, idx) => ({
      property_id: callout.property_id,
      cleaning_task_id: d.task_id,
      housekeeper_id: callout.staff_id,
      queue_order: idx,
      is_active: true,
      assigned_at: now,
      assigned_by: 'rebalance' as const,
      assigned_by_user_id: input.revertedByUserId ?? null,
      reason: 'callout reverted — returned to original housekeeper',
      score: null,
    }));
    const { error: insertErr } = await supabase
      .from('hk_assignments')
      .insert(inserts);
    if (insertErr) {
      throw new Error(
        `revertCallout: failed to insert revert hk_assignments: ${insertErr.message}`,
      );
    }
  }

  for (const d of decisions) {
    if (d.apply) {
      const upd = await supabase
        .from('cleaning_tasks')
        .update({ assignee_id: d.new_assignee_id })
        .eq('id', d.task_id);
      if (upd.error) {
        const missing = /relation .*cleaning_tasks.* does not exist/i.test(upd.error.message ?? '');
        if (!missing) {
          throw new Error(
            `revertCallout: failed to restore assignee for ${d.task_id}: ${upd.error.message}`,
          );
        }
      }
      returnedCount += 1;
    } else if (d.outcome.reason === 'already_started' || d.outcome.reason === 'task_completed') {
      retainedCount += 1;
    }
  }

  const outcome = decisions.map((d) => d.outcome);

  const stamp = await supabase
    .from('callout_events')
    .update({
      status: 'reverted',
      reverted_at: new Date().toISOString(),
      reverted_by_user_id: input.revertedByUserId ?? null,
      reverted_by_staff_id: input.revertedByStaffId ?? null,
      revert_reason: input.revertReason ?? null,
      revert_outcome: outcome,
    })
    .eq('id', input.calloutId)
    .eq('status', 'active')
    .select('*')
    .maybeSingle();
  if (stamp.error || !stamp.data) {
    throw new Error(
      `revertCallout: failed to stamp callout: ${stamp.error?.message ?? 'no row returned'}`,
    );
  }

  return {
    returnedCount,
    retainedCount,
    outcome,
    callout: stamp.data as CalloutEvent,
  };
}

// ───────────────────────────────────────────────────────────────────────
// READS
// ───────────────────────────────────────────────────────────────────────

export async function hasActiveCalloutToday(
  supabase: SupabaseClient,
  propertyId: string,
  staffId: string,
  businessDate: string,
): Promise<boolean> {
  const lookup = await supabase
    .from('callout_events')
    .select('id')
    .eq('property_id', propertyId)
    .eq('staff_id', staffId)
    .eq('business_date', businessDate)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();
  if (lookup.error) {
    // Treat as "no callout" — better to show the normal flow than to
    // block the page on a transient DB hiccup.
    return false;
  }
  return !!lookup.data;
}

/**
 * Build the banner payload: all active callouts for a property/date plus a
 * per-callout summary of who picked up which rooms. Used by both the
 * CalloutBanner read and the manager dashboard "today's callouts" widget.
 */
export async function listActiveCalloutsForBanner(
  supabase: SupabaseClient,
  propertyId: string,
  businessDate: string,
): Promise<CalloutBannerEntry[]> {
  const callouts = await supabase
    .from('callout_events')
    .select('id, staff_id, reason, reported_at, reported_by, redistributed_at, impacted_assignments')
    .eq('property_id', propertyId)
    .eq('business_date', businessDate)
    .eq('status', 'active')
    .order('reported_at', { ascending: true });
  if (callouts.error) {
    throw new Error(`listActiveCallouts: read failed: ${callouts.error.message}`);
  }
  const rows = (callouts.data ?? []) as Array<{
    id: string;
    staff_id: string;
    reason: CalloutReason | null;
    reported_at: string;
    reported_by: CalloutReporter;
    redistributed_at: string | null;
    impacted_assignments: ImpactedAssignment[] | null;
  }>;
  if (rows.length === 0) return [];

  // Resolve names for every staff_id referenced (sick HK + receivers).
  const staffIds = new Set<string>();
  for (const r of rows) {
    staffIds.add(r.staff_id);
    for (const a of r.impacted_assignments ?? []) {
      if (a.redistributed_to) staffIds.add(a.redistributed_to);
    }
  }
  const staffLookup = await supabase
    .from('staff')
    .select('id, name')
    .in('id', Array.from(staffIds));
  const nameById = new Map<string, string>();
  for (const s of (staffLookup.data ?? []) as Array<{ id: string; name: string }>) {
    nameById.set(s.id, s.name);
  }

  return rows.map((r) => {
    const pickupsByStaff = new Map<string | null, number>();
    for (const a of r.impacted_assignments ?? []) {
      const k = a.redistributed_to;
      pickupsByStaff.set(k, (pickupsByStaff.get(k) ?? 0) + 1);
    }
    const pickups: CalloutBannerEntry['pickups'] = Array.from(pickupsByStaff.entries())
      .map(([staffId, count]) => ({
        staff_id: staffId,
        staff_name: staffId ? (nameById.get(staffId) ?? 'Housekeeper') : 'Unassigned',
        count,
      }))
      .sort((a, b) => a.staff_name.localeCompare(b.staff_name));
    return {
      callout_id: r.id,
      staff_id: r.staff_id,
      staff_name: nameById.get(r.staff_id) ?? 'Housekeeper',
      reason: r.reason,
      reported_at: r.reported_at,
      reported_by: r.reported_by,
      redistributed_at: r.redistributed_at,
      total_redistributed: r.impacted_assignments?.length ?? 0,
      pickups,
    };
  });
}
