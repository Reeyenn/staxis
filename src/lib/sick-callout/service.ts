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
  planRedistribution,
  planRevert,
  buildImpactedAssignments,
  computeRedistributeAt,
  type RedistributableTask,
  type RedistributionEligibleStaff,
  type CurrentTaskState,
} from './redistribute-policy';
import type {
  CalloutEvent,
  CalloutReporter,
  CalloutReason,
  CalloutLeaveTiming,
  CalloutBannerEntry,
  ImpactedAssignment,
  RevertOutcomeEntry,
} from './types';

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
 * TODO(integrate-with-feature/hk-auto-assignment): swap the naive
 * planRedistribution call for their smart re-spread engine once it lands.
 * Same signature; this function shouldn't need to change.
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

  // Pull this property's cleaning_tasks for the date, assigned to the
  // sick HK. We pull EVERY status (not just scheduled) so the policy
  // function can correctly separate already-started rooms (retained
  // credit) from not-yet-started rooms (redistributed).
  const tasksLookup = await supabase
    .from('cleaning_tasks')
    .select('id, room_number, assignee_id, status, started_at')
    .eq('property_id', callout.property_id)
    .eq('business_date', callout.business_date)
    .eq('assignee_id', callout.staff_id);

  // The cleaning_tasks table is owned by feature/cleaning-rules-engine
  // and may not yet exist in this deploy. Treat "table missing" as
  // "nothing to redistribute" — the callout is still recorded and the
  // manager UI just shows an empty redistribution.
  const tasksMissingTable =
    tasksLookup.error &&
    /relation .*cleaning_tasks.* does not exist/i.test(tasksLookup.error.message ?? '');
  if (tasksLookup.error && !tasksMissingTable) {
    throw new Error(
      `runRedistributionForCallout: cleaning_tasks read failed: ${tasksLookup.error.message}`,
    );
  }
  const tasks: RedistributableTask[] = tasksMissingTable
    ? []
    : (tasksLookup.data ?? []).map((r) => ({
        id: r.id as string,
        room_number: r.room_number as string,
        assignee_id: (r.assignee_id as string | null) ?? null,
        status: r.status as string,
        started_at: (r.started_at as string | null) ?? null,
      }));

  // Pull eligible staff — same property, active, not on vacation today,
  // not themselves out on a callout today, not the sick HK. We pre-fetch
  // current load (count of cleaning_tasks already assigned) so the
  // planner can balance pickups.
  const eligible = await fetchEligibleStaffForRedistribution(
    supabase,
    callout.property_id,
    callout.business_date,
    callout.staff_id,
  );

  const plan = planRedistribution(tasks, eligible);
  const impacted = buildImpactedAssignments(plan, callout.staff_id);

  // Apply the reassignments. We batch by new_assignee_id to keep the
  // round-trip count small. Update failures are surfaced — the cron
  // will retry the whole callout on the next tick.
  for (const { task, new_assignee_id } of plan.assignments) {
    const upd = await supabase
      .from('cleaning_tasks')
      .update({ assignee_id: new_assignee_id })
      .eq('id', task.id);
    if (upd.error && !tasksMissingTable) {
      throw new Error(
        `runRedistributionForCallout: failed to reassign task ${task.id}: ${upd.error.message}`,
      );
    }
  }

  // Stamp the callout with what we did. The status_text on the row
  // stays 'active' (only revert flips that); redistributed_at being
  // set is the signal that the cron is done with this row.
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

async function fetchEligibleStaffForRedistribution(
  supabase: SupabaseClient,
  propertyId: string,
  businessDate: string,
  excludeStaffId: string,
): Promise<RedistributionEligibleStaff[]> {
  // All housekeeping staff at the property who aren't the sick one and
  // aren't already on a callout today. The vacation/schedule check is
  // a coarse filter — feature/hk-auto-assignment will tighten it.
  const staffLookup = await supabase
    .from('staff')
    .select('id, is_active, vacation_dates, department')
    .eq('property_id', propertyId)
    .neq('id', excludeStaffId);
  if (staffLookup.error) {
    throw new Error(`fetchEligibleStaff: staff lookup failed: ${staffLookup.error.message}`);
  }
  const baseCandidates = (staffLookup.data ?? [])
    .filter((s) => s.is_active !== false)
    .filter((s) => (s.department ?? 'housekeeping') === 'housekeeping')
    .filter((s) => {
      const vac = (s.vacation_dates as string[] | null) ?? [];
      return !vac.includes(businessDate);
    });

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
  const candidates = baseCandidates.filter((s) => !sickIds.has(s.id as string));
  if (candidates.length === 0) return [];

  // Look up current loads. cleaning_tasks may not exist yet; treat as
  // zero load for all.
  const loadLookup = await supabase
    .from('cleaning_tasks')
    .select('assignee_id')
    .eq('property_id', propertyId)
    .eq('business_date', businessDate)
    .in('assignee_id', candidates.map((s) => s.id as string));
  const loadByStaff = new Map<string, number>();
  if (!loadLookup.error && loadLookup.data) {
    for (const row of loadLookup.data as Array<{ assignee_id: string | null }>) {
      if (!row.assignee_id) continue;
      loadByStaff.set(row.assignee_id, (loadByStaff.get(row.assignee_id) ?? 0) + 1);
    }
  }

  return candidates.map((s) => ({
    id: s.id as string,
    current_load: loadByStaff.get(s.id as string) ?? 0,
  }));
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
