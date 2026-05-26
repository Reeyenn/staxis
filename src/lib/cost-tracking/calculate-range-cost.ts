/**
 * Multi-day cost aggregation.
 *
 * The Performance tab needs "this week vs last week" plus a per-day
 * trendline. Calling calculatePropertyDayCost in a 14-day loop would
 * fire ~56 queries per page render (4 per day × 14). Instead we pull
 * all four tables ONCE for the whole range, then group by business_
 * date in JS and run the existing aggregator per day.
 *
 * Hard cap: 31 days. A range longer than that would be a different UI
 * (monthly chart / report download) and shouldn't load through this
 * code path.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { aggregateDayCost, type PropertyDayCost } from './calculate-day-cost';

const MAX_RANGE_DAYS = 31;

interface CleaningTaskRow {
  id: string;
  cleaning_type: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  estimated_minutes: number | null;
  assignee_id: string | null;
  room_number: string;
  business_date: string;
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
  business_date: string;
}

interface LunchBreakRow {
  staff_id: string;
  business_date: string;
  started_at: string;
  ended_at: string | null;
}

export interface RangeDailyCost {
  date: string;
  totalCents: number;
  perHousekeeper: PropertyDayCost['perHousekeeper'];
  anyWageUnknown: boolean;
}

export interface RangePerStaffTotal {
  staffId: string;
  name: string;
  totalCents: number;
  /** Per-day cents for this staff member — same length as `days`. */
  perDay: Array<{ date: string; cents: number }>;
}

export interface PropertyRangeCost {
  fromDate: string;
  toDate: string;
  days: RangeDailyCost[];
  perStaffTotal: RangePerStaffTotal[];
  totalCents: number;
  anyWageUnknown: boolean;
}

function enumerateDates(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  let cursor = start;
  while (cursor <= end) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return out;
}

/**
 * Pure aggregator over pre-fetched rows. Exported so the API route
 * (next file) can call this directly with a single batched pull.
 */
export function aggregateRangeCost(args: {
  fromDate: string;
  toDate: string;
  tasks: CleaningTaskRow[];
  staff: StaffWageRow[];
  pauseEvents: PauseEventRow[];
  lunchBreaks: LunchBreakRow[];
  now?: Date;
}): PropertyRangeCost {
  const dateList = enumerateDates(args.fromDate, args.toDate);

  // Group inputs by business_date in one pass — the per-day aggregator
  // expects narrow row sets, not the full range.
  const tasksByDate = new Map<string, CleaningTaskRow[]>();
  for (const t of args.tasks) {
    const arr = tasksByDate.get(t.business_date) ?? [];
    arr.push(t);
    tasksByDate.set(t.business_date, arr);
  }
  const pausesByDate = new Map<string, PauseEventRow[]>();
  for (const p of args.pauseEvents) {
    const arr = pausesByDate.get(p.business_date) ?? [];
    arr.push(p);
    pausesByDate.set(p.business_date, arr);
  }
  const lunchesByDate = new Map<string, LunchBreakRow[]>();
  for (const lb of args.lunchBreaks) {
    const arr = lunchesByDate.get(lb.business_date) ?? [];
    arr.push(lb);
    lunchesByDate.set(lb.business_date, arr);
  }

  const days: RangeDailyCost[] = [];
  let totalCents = 0;
  let anyWageUnknown = false;

  // Per-staff accumulator across all days.
  const perStaffByDay = new Map<string, Map<string, number>>();
  const staffNames = new Map(args.staff.map(s => [s.id, s.name]));

  for (const date of dateList) {
    const tasks = tasksByDate.get(date) ?? [];
    const pauses = pausesByDate.get(date) ?? [];
    const lunches = lunchesByDate.get(date) ?? [];
    const dayCost = aggregateDayCost({
      tasks, staff: args.staff, pauseEvents: pauses, lunchBreaks: lunches, now: args.now,
    });
    days.push({
      date,
      totalCents: dayCost.totalCents,
      perHousekeeper: dayCost.perHousekeeper,
      anyWageUnknown: dayCost.anyWageUnknown,
    });
    totalCents += dayCost.totalCents;
    if (dayCost.anyWageUnknown) anyWageUnknown = true;

    for (const ph of dayCost.perHousekeeper) {
      const dayMap = perStaffByDay.get(ph.staffId) ?? new Map<string, number>();
      dayMap.set(date, ph.cents);
      perStaffByDay.set(ph.staffId, dayMap);
    }
  }

  // Flatten per-staff totals.
  const perStaffTotal: RangePerStaffTotal[] = [];
  for (const [staffId, dayMap] of perStaffByDay) {
    let staffTotal = 0;
    const perDay: Array<{ date: string; cents: number }> = [];
    for (const date of dateList) {
      const cents = dayMap.get(date) ?? 0;
      staffTotal += cents;
      perDay.push({ date, cents });
    }
    perStaffTotal.push({
      staffId,
      name: staffNames.get(staffId) ?? 'Unknown',
      totalCents: staffTotal,
      perDay,
    });
  }
  perStaffTotal.sort((a, b) => b.totalCents - a.totalCents);

  return {
    fromDate: args.fromDate,
    toDate: args.toDate,
    days,
    perStaffTotal,
    totalCents,
    anyWageUnknown,
  };
}

/**
 * I/O wrapper: one pull per table, then group + aggregate.
 *
 * Returns null on DB error.
 */
export async function calculatePropertyRangeCost(args: {
  propertyId: string;
  fromDate: string;
  toDate: string;
  now?: Date;
}): Promise<PropertyRangeCost | null> {
  const { propertyId, fromDate, toDate } = args;
  const dateList = enumerateDates(fromDate, toDate);
  if (dateList.length === 0) {
    return {
      fromDate, toDate, days: [], perStaffTotal: [],
      totalCents: 0, anyWageUnknown: false,
    };
  }
  if (dateList.length > MAX_RANGE_DAYS) {
    log.warn('[cost-tracking] range too long, clamping', {
      propertyId, requested: dateList.length, max: MAX_RANGE_DAYS,
    });
    return null;
  }

  const pauseStart = `${fromDate}T00:00:00Z`;
  const pauseEnd = new Date(Date.parse(`${toDate}T00:00:00Z`) + 36 * 3_600_000).toISOString();

  try {
    const [tasksRes, staffRes, pauseRes, lunchRes] = await Promise.all([
      supabaseAdmin
        .from('cleaning_tasks')
        .select('id, cleaning_type, status, started_at, completed_at, estimated_minutes, assignee_id, room_number, business_date')
        .eq('property_id', propertyId)
        .gte('business_date', fromDate)
        .lte('business_date', toDate),
      supabaseAdmin
        .from('staff')
        .select('id, name, hourly_wage_cents, hourly_wage')
        .eq('property_id', propertyId),
      // room_id → room_number lookup happens after this resolves
      // for room-scoped pause attribution. Adversarial review C2.
      supabaseAdmin
        .from('room_pause_events')
        .select('staff_id, room_id, paused_at, resumed_at, business_date')
        .eq('property_id', propertyId)
        .gte('paused_at', pauseStart)
        .lt('paused_at', pauseEnd),
      supabaseAdmin
        .from('staff_breaks')
        .select('staff_id, business_date, started_at, ended_at')
        .eq('property_id', propertyId)
        .gte('business_date', fromDate)
        .lte('business_date', toDate)
        .eq('break_type', 'lunch'),
    ]);

    if (tasksRes.error || staffRes.error) {
      log.error('[cost-tracking] range pull failed', {
        propertyId, fromDate, toDate,
        tasksErr: tasksRes.error?.message,
        staffErr: staffRes.error?.message,
      });
      return null;
    }

    const rawPauses = (pauseRes.data ?? []) as Array<{
      staff_id: string;
      room_id: string;
      paused_at: string;
      resumed_at: string | null;
      business_date: string;
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
      business_date: p.business_date,
    }));

    return aggregateRangeCost({
      fromDate, toDate,
      tasks: (tasksRes.data ?? []) as CleaningTaskRow[],
      staff: (staffRes.data ?? []) as StaffWageRow[],
      pauseEvents,
      lunchBreaks: (lunchRes.data ?? []) as LunchBreakRow[],
      now: args.now,
    });
  } catch (err) {
    log.error('[cost-tracking] calculatePropertyRangeCost threw', {
      propertyId, fromDate, toDate,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export { MAX_RANGE_DAYS };
