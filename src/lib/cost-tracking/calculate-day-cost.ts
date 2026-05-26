/**
 * Property-day cost aggregator.
 *
 * Reads cleaning_tasks + staff + room_pause_events + staff_breaks for
 * one (property, business_date), runs each task through the pure
 * calculator in calculate-task-cost.ts, then rolls the per-task cents
 * up into per-housekeeper, per-cleaning-type, and grand totals.
 *
 * I/O is centralized here so the LaborCostBanner / AutoAssignBoard /
 * PerformanceTab / daily report all read from one place and get the
 * same numbers.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  activeMinutes,
  calculateTaskCost,
  type PauseInterval,
} from './calculate-task-cost';

/**
 * Statuses that count toward labor cost. A task with one of these
 * statuses has at least started; superseded/cancelled/skipped don't
 * count even if they have a started_at timestamp (they were aborted
 * before the work was billable).
 */
const BILLABLE_STATUSES = new Set([
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

/**
 * Statuses that mean the task is still in progress (no completed_at yet).
 * The live-cost banner depends on this set being correct — anything
 * past the in-progress phase should have completed_at populated, so we
 * fall back to "use completed_at if present, else now" inside the
 * pure calculator. This set is informational only for projection.
 */
const STILL_RUNNING_STATUSES = new Set(['in_progress', 'paused']);

interface CleaningTaskRow {
  id: string;
  cleaning_type: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  estimated_minutes: number | null;
  assignee_id: string | null;
  room_number: string;
}

interface StaffWageRow {
  id: string;
  name: string;
  hourly_wage_cents: number | null;
  hourly_wage: number | null;  // legacy fallback
}

interface PauseEventRow {
  staff_id: string;
  /**
   * Joined room_number from rooms.id → cleaning_tasks.room_number.
   * The aggregator scopes each pause to its room (not just to the
   * staff member) — otherwise a pause on Room 101 would subtract
   * minutes from a concurrent Room 102 task whenever the time
   * windows overlapped. In practice housekeepers work one task at
   * a time, but the schema doesn't enforce that, so we use room
   * scoping defensively. (Adversarial review 2026-05-26, finding C2.)
   */
  room_number: string | null;
  paused_at: string;
  resumed_at: string | null;
}

interface LunchBreakRow {
  staff_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface PerHousekeeperCost {
  staffId: string;
  name: string;
  cents: number;
  billableMinutes: number;
  /** True if this housekeeper has at least one task with no wage set. */
  wageUnknown: boolean;
}

export interface PropertyDayCost {
  /** Sum of every housekeeper's cents for the day. */
  totalCents: number;
  /** Per-housekeeper breakdown, sorted by cents desc. */
  perHousekeeper: PerHousekeeperCost[];
  /** Cents bucketed by cleaning_type. */
  byCleaningType: Record<string, number>;
  /**
   * True if at least one cost contributor was skipped because the
   * housekeeper's wage isn't set. The UI uses this to render a "—"
   * marker next to incomplete totals.
   */
  anyWageUnknown: boolean;
  /**
   * Snapshot time used for live (in-progress) tasks. Caller can show
   * this as "as of HH:MM" so a 30-second-stale banner isn't surprising.
   */
  asOf: string;
}

export interface PropertyDayCostInput {
  propertyId: string;
  businessDate: string;
  /** Override "now" for tests. Defaults to current time. */
  now?: Date;
}

/**
 * Resolve a staff member's effective wage in cents. Prefer the new
 * cents column; if the owner hasn't set it but the legacy dollar
 * column has a value, convert that. Returns null when the wage is
 * genuinely unset (both columns null/zero).
 */
function effectiveWageCents(row: StaffWageRow): number | null {
  if (row.hourly_wage_cents !== null && row.hourly_wage_cents !== undefined) {
    if (Number.isFinite(row.hourly_wage_cents) && row.hourly_wage_cents > 0) {
      return row.hourly_wage_cents;
    }
    // Explicit zero in cents column = "set to free" — treat as known.
    if (row.hourly_wage_cents === 0) return 0;
  }
  if (row.hourly_wage !== null && row.hourly_wage !== undefined) {
    if (Number.isFinite(row.hourly_wage) && row.hourly_wage > 0) {
      return Math.round(row.hourly_wage * 100);
    }
  }
  return null;
}

/**
 * Pure aggregator — given pre-fetched rows, compute the day cost
 * breakdown. Exported for tests so they don't have to mock supabase.
 */
export function aggregateDayCost(args: {
  tasks: CleaningTaskRow[];
  staff: StaffWageRow[];
  pauseEvents: PauseEventRow[];
  lunchBreaks: LunchBreakRow[];
  now?: Date;
}): PropertyDayCost {
  const now = args.now ?? new Date();

  const staffById = new Map(args.staff.map(s => [s.id, s]));
  const wageByStaff = new Map<string, number | null>();
  for (const s of args.staff) {
    wageByStaff.set(s.id, effectiveWageCents(s));
  }

  // Group pause events by (staff_id, room_number). Pauses without a
  // room scope fall back to staff-wide attribution — we still want to
  // count them somewhere if room data is missing.
  const pausesByStaffRoom = new Map<string, PauseInterval[]>();
  const pausesByStaffOnly = new Map<string, PauseInterval[]>();
  for (const p of args.pauseEvents) {
    const interval = { pausedAt: p.paused_at, resumedAt: p.resumed_at };
    if (p.room_number) {
      const key = `${p.staff_id}::${p.room_number}`;
      const arr = pausesByStaffRoom.get(key) ?? [];
      arr.push(interval);
      pausesByStaffRoom.set(key, arr);
    } else {
      const arr = pausesByStaffOnly.get(p.staff_id) ?? [];
      arr.push(interval);
      pausesByStaffOnly.set(p.staff_id, arr);
    }
  }

  // Group lunch breaks by staff. Sum each staff's total closed lunch
  // minutes; we'll subtract proportionally across that staff's tasks
  // so the per-task cents in the byCleaningType breakdown reflects
  // a roughly accurate per-clean cost.
  const lunchMinutesByStaff = new Map<string, number>();
  for (const lb of args.lunchBreaks) {
    if (!lb.ended_at) continue;     // open lunch — don't credit yet
    const startMs = Date.parse(lb.started_at);
    const endMs = Date.parse(lb.ended_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;
    const mins = (endMs - startMs) / 60_000;
    lunchMinutesByStaff.set(
      lb.staff_id,
      (lunchMinutesByStaff.get(lb.staff_id) ?? 0) + mins,
    );
  }

  // First pass: compute each task's gross billable minutes + cents
  // (no lunch deducted yet). We need each staff's total to know how
  // to distribute lunch.
  type TaskComputation = {
    task: CleaningTaskRow;
    grossMinutes: number;
    grossCents: number;
    wageKnown: boolean;
    wageCents: number | null;
  };
  const computations: TaskComputation[] = [];
  const grossMinutesByStaff = new Map<string, number>();

  for (const task of args.tasks) {
    if (!task.assignee_id) continue;
    if (!task.started_at) continue;
    if (!BILLABLE_STATUSES.has(task.status)) continue;

    const wageCents = wageByStaff.get(task.assignee_id) ?? null;
    // Pause attribution: prefer (staff, room) scoped pauses; fall back
    // to staff-wide if pauses arrived without a room_number (rare —
    // only the legacy housekeeper-page tile cycle wrote those).
    const roomKey = `${task.assignee_id}::${task.room_number}`;
    const pauseEvents = pausesByStaffRoom.get(roomKey)
      ?? pausesByStaffOnly.get(task.assignee_id)
      ?? [];
    // The pure calculator clips each pause to the task window — pauses
    // outside the window contribute 0.

    const result = calculateTaskCost({
      startedAt: task.started_at,
      completedAt: task.completed_at,
      hourlyWageCents: wageCents,
      pauseEvents,
      // Lunch is applied as a day-level deduction below, not per-task.
      lunchBreakMinutes: 0,
      now,
    });

    computations.push({
      task,
      grossMinutes: result.billableMinutes,
      grossCents: result.cents,
      wageKnown: result.wageKnown,
      wageCents,
    });

    grossMinutesByStaff.set(
      task.assignee_id,
      (grossMinutesByStaff.get(task.assignee_id) ?? 0) + result.billableMinutes,
    );
  }

  // Second pass: distribute lunch deduction across each staff's tasks
  // proportionally. Run only when the staff member has a wage; without
  // a wage there's no $ to deduct anyway.
  const lunchCentsByStaff = new Map<string, number>();
  for (const [staffId, lunchMins] of lunchMinutesByStaff) {
    const wageCents = wageByStaff.get(staffId);
    if (wageCents === null || wageCents === undefined) continue;
    const grossMins = grossMinutesByStaff.get(staffId) ?? 0;
    if (grossMins <= 0) continue;
    // Cap lunch at the staff's total billable so we never produce a
    // negative day total (a long lunch on a short-shift day shouldn't
    // result in "owed money").
    const cappedLunch = Math.min(lunchMins, grossMins);
    const lunchCents = Math.round((cappedLunch * wageCents) / 60);
    lunchCentsByStaff.set(staffId, lunchCents);
  }

  // Roll up per-staff totals. Distribute the lunch deduction
  // proportionally across the staff's tasks for the byCleaningType
  // breakdown.
  const perStaffAccum = new Map<string, PerHousekeeperCost>();
  const cleaningTypeAccum: Record<string, number> = {};

  for (const c of computations) {
    const staffId = c.task.assignee_id!;
    const staffRow = staffById.get(staffId);
    const name = staffRow?.name ?? 'Unknown';

    // Per-task lunch share: (this task's gross minutes / staff total)
    // × staff's lunch cents. Only applied when wage known.
    const staffGross = grossMinutesByStaff.get(staffId) ?? 0;
    const staffLunchCents = lunchCentsByStaff.get(staffId) ?? 0;
    const taskLunchCents =
      c.wageKnown && staffGross > 0 && staffLunchCents > 0
        ? Math.round((c.grossMinutes / staffGross) * staffLunchCents)
        : 0;
    const taskNetCents = Math.max(0, c.grossCents - taskLunchCents);

    const accum = perStaffAccum.get(staffId) ?? {
      staffId,
      name,
      cents: 0,
      billableMinutes: 0,
      wageUnknown: false,
    };
    accum.cents += taskNetCents;
    accum.billableMinutes += c.grossMinutes;
    if (!c.wageKnown) accum.wageUnknown = true;
    perStaffAccum.set(staffId, accum);

    if (c.wageKnown && taskNetCents > 0) {
      const bucket = c.task.cleaning_type;
      cleaningTypeAccum[bucket] = (cleaningTypeAccum[bucket] ?? 0) + taskNetCents;
    }
  }

  // Sort housekeepers by cents desc for stable UI ordering.
  const perHousekeeper = Array.from(perStaffAccum.values())
    .sort((a, b) => b.cents - a.cents);

  // Adjust per-staff billable minutes to net-of-lunch for display.
  // (We tracked gross above so we could distribute lunch proportionally;
  // now subtract the staff's lunch from their billableMinutes field.)
  for (const ph of perHousekeeper) {
    const lunchMins = lunchMinutesByStaff.get(ph.staffId) ?? 0;
    const grossMins = grossMinutesByStaff.get(ph.staffId) ?? 0;
    ph.billableMinutes = Math.max(0, grossMins - Math.min(lunchMins, grossMins));
  }

  const totalCents = perHousekeeper.reduce((sum, ph) => sum + ph.cents, 0);
  const anyWageUnknown = perHousekeeper.some(ph => ph.wageUnknown);

  return {
    totalCents,
    perHousekeeper,
    byCleaningType: cleaningTypeAccum,
    anyWageUnknown,
    asOf: now.toISOString(),
  };
}

/**
 * I/O layer: load the day's data and run the aggregator.
 *
 * Returns null on database error so the caller (the labor-cost API
 * route) can serve a clean 500 with a request id rather than crashing.
 */
export async function calculatePropertyDayCost(
  input: PropertyDayCostInput,
): Promise<PropertyDayCost | null> {
  const { propertyId, businessDate, now } = input;

  // Bound the time window for pause + lunch queries. Use the local
  // business_date with a generous ±1 day window — pause/lunch rows
  // are property-local-date scoped and the day boundary check happens
  // inside the aggregator via task-window clipping.
  const startBound = `${businessDate}T00:00:00Z`;
  // For lunch breaks we filter on business_date directly (it's a date
  // column). For pauses we filter on paused_at within a ~36h window
  // so DST + late-shift overlap is captured.
  const lookbackHours = 36;
  const winStartMs = Date.parse(startBound) - lookbackHours * 3_600_000;
  const winEndMs = Date.parse(startBound) + (24 + lookbackHours) * 3_600_000;
  const pauseStart = new Date(winStartMs).toISOString();
  const pauseEnd = new Date(winEndMs).toISOString();

  try {
    const [
      tasksRes,
      staffRes,
      pauseRes,
      lunchRes,
    ] = await Promise.all([
      supabaseAdmin
        .from('cleaning_tasks')
        .select('id, cleaning_type, status, started_at, completed_at, estimated_minutes, assignee_id, room_number')
        .eq('property_id', propertyId)
        .eq('business_date', businessDate),
      supabaseAdmin
        .from('staff')
        .select('id, name, hourly_wage_cents, hourly_wage')
        .eq('property_id', propertyId),
      // room_id → room_number lookup happens in JS after this resolves
      // (joining via supabase-js returns a nested object which is awkward
      // to flatten; one extra query for rooms is cheap and keeps the
      // row shape flat). Adversarial review C2 (2026-05-26).
      supabaseAdmin
        .from('room_pause_events')
        .select('staff_id, room_id, paused_at, resumed_at')
        .eq('property_id', propertyId)
        .gte('paused_at', pauseStart)
        .lt('paused_at', pauseEnd),
      supabaseAdmin
        .from('staff_breaks')
        .select('staff_id, started_at, ended_at')
        .eq('property_id', propertyId)
        .eq('business_date', businessDate)
        .eq('break_type', 'lunch'),
    ]);

    if (tasksRes.error) {
      log.error('[cost-tracking] tasks load failed', { propertyId, businessDate, err: tasksRes.error.message });
      return null;
    }
    if (staffRes.error) {
      log.error('[cost-tracking] staff load failed', { propertyId, businessDate, err: staffRes.error.message });
      return null;
    }
    if (pauseRes.error) {
      // Non-fatal — degrade gracefully without pause data.
      log.warn('[cost-tracking] pause load failed — proceeding with empty pause set', {
        propertyId, businessDate, err: pauseRes.error.message,
      });
    }
    if (lunchRes.error) {
      // Non-fatal — same idea.
      log.warn('[cost-tracking] lunch load failed — proceeding with empty lunch set', {
        propertyId, businessDate, err: lunchRes.error.message,
      });
    }

    const tasks = (tasksRes.data ?? []) as CleaningTaskRow[];
    const staff = (staffRes.data ?? []) as StaffWageRow[];
    const lunchBreaks = (lunchRes.data ?? []) as LunchBreakRow[];

    // Map room_id → room_number for pause attribution. Cheap: one
    // extra select per (property, day) at the size of "rooms in the
    // hotel" (usually 50-300). pause_events.room_id is FK to rooms.id.
    const rawPauses = (pauseRes.data ?? []) as Array<{
      staff_id: string;
      room_id: string;
      paused_at: string;
      resumed_at: string | null;
    }>;
    const distinctRoomIds = Array.from(new Set(rawPauses.map(p => p.room_id).filter(Boolean)));
    let roomsById = new Map<string, string>();
    if (distinctRoomIds.length > 0) {
      const { data: roomRows } = await supabaseAdmin
        .from('rooms')
        .select('id, room_number')
        .in('id', distinctRoomIds);
      roomsById = new Map((roomRows ?? []).map(r => [r.id as string, r.room_number as string]));
    }
    const pauseEvents: PauseEventRow[] = rawPauses.map(p => ({
      staff_id: p.staff_id,
      room_number: roomsById.get(p.room_id) ?? null,
      paused_at: p.paused_at,
      resumed_at: p.resumed_at,
    }));

    return aggregateDayCost({ tasks, staff, pauseEvents, lunchBreaks, now });
  } catch (err) {
    log.error('[cost-tracking] calculatePropertyDayCost threw', {
      propertyId, businessDate,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Helper for the projection function — exposes the "remaining work"
 * shape derived from the same task pull.
 */
export interface RemainingWorkSummary {
  /** Tasks with no started_at yet, in property+date scope. */
  scheduledTasks: number;
  /** Estimated minutes summed across scheduled tasks. */
  scheduledEstimatedMinutes: number;
  /** Currently-running tasks (started, no completed_at). */
  runningTasks: number;
}

/**
 * Inline aggregator that gives the projection layer the rows it needs
 * — we reuse the same DB pull instead of round-tripping again. Same
 * row shapes as the aggregator above.
 */
export function summarizeRemainingWork(tasks: CleaningTaskRow[]): RemainingWorkSummary {
  let scheduledTasks = 0;
  let scheduledEstimatedMinutes = 0;
  let runningTasks = 0;
  for (const t of tasks) {
    if (t.status === 'scheduled' || t.status === 'ready_now') {
      scheduledTasks += 1;
      if (t.estimated_minutes && Number.isFinite(t.estimated_minutes)) {
        scheduledEstimatedMinutes += t.estimated_minutes;
      } else {
        scheduledEstimatedMinutes += 30; // fallback for missing estimate
      }
    } else if (STILL_RUNNING_STATUSES.has(t.status)) {
      runningTasks += 1;
    }
  }
  return { scheduledTasks, scheduledEstimatedMinutes, runningTasks };
}

/**
 * Helper exported for the API route + tests: turn the live `tasks`
 * pull into the same task row shape the aggregator expects. The
 * Supabase client returns generic objects; this is a single
 * narrowing point.
 */
export function asCleaningTaskRows(data: unknown): CleaningTaskRow[] {
  return (Array.isArray(data) ? data : []) as CleaningTaskRow[];
}

export { activeMinutes };
