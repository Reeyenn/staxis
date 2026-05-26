/**
 * End-of-day cost projection.
 *
 * Given the day's live cost (calculatePropertyDayCost output) plus the
 * pulled task rows, estimate where the day's total labor cost will
 * land by end-of-shift. The banner uses this to show
 * "today $245 · projected EOD $410 · budget $400 ⚠️ over".
 *
 * Algorithm:
 *   1. Start with the already-accrued cents (completed + in-progress
 *      tasks). The aggregator has already computed this.
 *   2. For each task that hasn't started yet (status='scheduled' or
 *      'ready_now'), estimate the cost based on:
 *         a. The assignee's wage if set.
 *         b. The property's average wage across all wage-set staff if
 *            the assignee has no wage (or is unassigned).
 *         c. Skip entirely if no wage info at all (basedOnHistoricalPace
 *            flips false so the UI can show a "—" hint).
 *      Use estimated_minutes from cleaning_tasks; fall back to 30 min
 *      if missing (matches summarizeRemainingWork's fallback).
 *   3. projectedCents = accruedCents + sum(remaining task estimates).
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import {
  aggregateDayCost,
  asCleaningTaskRows,
  type PropertyDayCost,
} from './calculate-day-cost';

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
  hourly_wage: number | null;
}

interface PauseEventRow {
  staff_id: string;
  room_number: string | null;
  paused_at: string;
  resumed_at: string | null;
}

interface LunchBreakRow {
  staff_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface ProjectedEndOfDayCost {
  /** Cents accrued so far (= calculatePropertyDayCost.totalCents). */
  accruedCents: number;
  /** Estimated additional cents for scheduled-but-not-started work. */
  remainingEstimateCents: number;
  /** accruedCents + remainingEstimateCents. */
  projectedCents: number;
  /**
   * True when the projection had at least one wage to anchor on
   * (either per-assignee or property average). False = "—" hint.
   */
  basedOnHistoricalPace: boolean;
  /** Snapshot time. */
  asOf: string;
}

function effectiveWageCents(row: StaffWageRow): number | null {
  if (row.hourly_wage_cents !== null && row.hourly_wage_cents !== undefined) {
    if (Number.isFinite(row.hourly_wage_cents) && row.hourly_wage_cents > 0) {
      return row.hourly_wage_cents;
    }
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
 * Pure projection — accepts pre-fetched rows + the already-computed
 * day cost so tests can pump arbitrary fixtures and the API route
 * can avoid a second DB round-trip.
 */
export function projectFromRows(args: {
  tasks: CleaningTaskRow[];
  staff: StaffWageRow[];
  dayCost: PropertyDayCost;
  now?: Date;
}): ProjectedEndOfDayCost {
  const { tasks, staff, dayCost } = args;
  const now = args.now ?? new Date();

  const wageByStaff = new Map<string, number | null>();
  for (const s of staff) wageByStaff.set(s.id, effectiveWageCents(s));

  // Property average wage across staff with a known wage. Used for
  // unassigned tasks. If nobody has a wage set, this is null and
  // projection bails on the "basedOnHistoricalPace" flag.
  const wageValues: number[] = [];
  for (const v of wageByStaff.values()) {
    if (v !== null && v > 0) wageValues.push(v);
  }
  const avgPropertyWageCents = wageValues.length > 0
    ? wageValues.reduce((sum, v) => sum + v, 0) / wageValues.length
    : null;

  let remainingEstimateCents = 0;
  let anyAnchorWage = false;

  for (const t of tasks) {
    if (t.status !== 'scheduled' && t.status !== 'ready_now') continue;
    const estMinutes = (t.estimated_minutes && Number.isFinite(t.estimated_minutes))
      ? t.estimated_minutes
      : 30;

    let wageCents: number | null = null;
    if (t.assignee_id) wageCents = wageByStaff.get(t.assignee_id) ?? null;
    if (wageCents === null) wageCents = avgPropertyWageCents;
    // Treat explicit 0 wage as known (matches day-cost aggregator);
    // only skip when the resolution returned null. Adversarial M5.
    if (wageCents === null) continue;

    anyAnchorWage = true;
    if (wageCents > 0) {
      remainingEstimateCents += Math.round((estMinutes * wageCents) / 60);
    }
  }

  return {
    accruedCents: dayCost.totalCents,
    remainingEstimateCents,
    projectedCents: dayCost.totalCents + remainingEstimateCents,
    basedOnHistoricalPace: anyAnchorWage || dayCost.perHousekeeper.length > 0,
    asOf: now.toISOString(),
  };
}

/**
 * Production entry point: load the day's tasks + staff, compute the
 * day cost, then project end-of-day. Returns null on DB failure.
 */
export async function projectEndOfDayCost(args: {
  propertyId: string;
  businessDate: string;
  now?: Date;
}): Promise<{ dayCost: PropertyDayCost; projection: ProjectedEndOfDayCost } | null> {
  const { propertyId, businessDate, now } = args;
  const startBound = `${businessDate}T00:00:00Z`;
  const lookbackHours = 36;
  const winStartMs = Date.parse(startBound) - lookbackHours * 3_600_000;
  const winEndMs = Date.parse(startBound) + (24 + lookbackHours) * 3_600_000;
  const pauseStart = new Date(winStartMs).toISOString();
  const pauseEnd = new Date(winEndMs).toISOString();

  try {
    const [tasksRes, staffRes, pauseRes, lunchRes] = await Promise.all([
      supabaseAdmin
        .from('cleaning_tasks')
        .select('id, cleaning_type, status, started_at, completed_at, estimated_minutes, assignee_id, room_number')
        .eq('property_id', propertyId)
        .eq('business_date', businessDate),
      supabaseAdmin
        .from('staff')
        .select('id, name, hourly_wage_cents, hourly_wage')
        .eq('property_id', propertyId),
      // room_id → room_number lookup happens after this resolves so
      // pause attribution is room-scoped (adversarial review C2).
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

    if (tasksRes.error || staffRes.error) {
      log.error('[cost-tracking] projection load failed', {
        propertyId, businessDate,
        tasksErr: tasksRes.error?.message,
        staffErr: staffRes.error?.message,
      });
      return null;
    }

    const tasks = asCleaningTaskRows(tasksRes.data);
    const staff = (staffRes.data ?? []) as StaffWageRow[];
    const lunchBreaks = (lunchRes.data ?? []) as LunchBreakRow[];

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

    const dayCost = aggregateDayCost({ tasks, staff, pauseEvents, lunchBreaks, now });
    const projection = projectFromRows({ tasks, staff, dayCost, now });

    return { dayCost, projection };
  } catch (err) {
    log.error('[cost-tracking] projectEndOfDayCost threw', {
      propertyId, businessDate,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
