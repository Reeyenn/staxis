/**
 * Pure aggregation helpers — given pre-fetched DB rows for a property +
 * date window, produce the OperationsBlock / QualityBlock / LaborBlock /
 * IssuesBlock / TomorrowOutlookBlock used by both the daily and weekly
 * report builders.
 *
 * Why these are pure (no supabase imports):
 *   - The daily/weekly builders own the I/O. They fetch one query per
 *     table, then hand the rows here.
 *   - Tests can pump in arbitrary fixtures without mocking the database.
 *   - The weekly builder reuses the exact same math; only the window is
 *     wider.
 *
 * Time accounting: cleaning_tasks.started_at and .completed_at are the
 * authoritative timestamps. minutesBetween() guards against rows where
 * one is null (work-in-progress, missed-completion) or where someone
 * fat-fingered a clock that produces a negative duration.
 */

import type {
  CleaningType,
  IssuesBlock,
  LaborBlock,
  OperationsBlock,
  QualityBlock,
  StaffPerformance,
} from './types';

// ── Input row shapes (subset of the actual DB columns we read) ────────────
//
// We model these as local interfaces rather than importing from
// database.types.ts because the latter is auto-generated from `supabase gen
// types` and changes shape every time the schema does. Pinning to a small
// "what we actually use" shape keeps the aggregator stable.

export interface CleaningTaskRow {
  id: string;
  cleaning_type: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  assignee_id: string | null;
  requires_inspection: boolean;
}

export interface HkAssignmentRow {
  housekeeper_id: string;
  cleaning_task_id: string;
  is_active: boolean;
}

export interface InspectionRow {
  id: string;
  result: 'in_progress' | 'pass' | 'fail' | 'cancelled';
  failed_items: Array<{ label?: string; item_id?: string }> | null;
  housekeeper_staff_id: string | null;
  completed_at: string | null;
}

export interface WorkOrderRow {
  id: string;
  status: 'open' | 'in_progress' | 'closed' | 'deferred' | 'resolved';
  priority: 'urgent' | 'high' | 'medium' | 'low';
  out_of_order: boolean;
  reported_at: string | null;
}

export interface ReservationRow {
  arrival_date: string | null;
  departure_date: string | null;
  status: string | null;
}

export interface InHouseSnapshot {
  total_occupied_rooms: number | null;
  total_vacant_clean: number | null;
  total_vacant_dirty: number | null;
  total_ooo: number | null;
  arrivals_remaining_today: number | null;
  departures_remaining_today: number | null;
  checked_in_today_count: number | null;
  checked_out_today_count: number | null;
}

export interface StaffRow {
  id: string;
  name: string;
  hourly_wage: number | null;
  /**
   * Hourly wage in cents (migration 0229). Source of truth as of
   * 2026-05-26; the legacy hourly_wage dollar column is kept for
   * back-compat with rows whose wage was last set via the bulk-
   * update path. buildLaborBlock prefers cents; falls back to
   * dollars × 100; treats both null as "wage unknown."
   */
  hourly_wage_cents?: number | null;
}

export interface CalloutRow {
  business_date: string;
  reason: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Minutes between two ISO timestamps. Returns null if either is missing or
 * the result is negative (clock skew, partial completion that filled
 * completed_at before started_at, etc.). Negative durations would otherwise
 * silently drag averages down.
 */
function minutesBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const minutes = (endMs - startMs) / 60_000;
  if (minutes < 0) return null;
  // Clamp the absurd upper bound — anything over 12 hours on a single
  // room is almost certainly an unstopped clock, not a genuine clean.
  if (minutes > 12 * 60) return null;
  return minutes;
}

/** Round to one decimal. Cents stay integer; minutes show one decimal. */
function r1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Map cleaning_tasks.cleaning_type → the three buckets the report
 * surfaces. 'refresh', 'room_check', 'inspection_only', 'no_clean' all
 * roll up to 'other' (don't get their own average row).
 */
function bucketCleaningType(t: string): CleaningType {
  if (t === 'departure' || t === 'departure_deep') return 'departure';
  if (t === 'stayover') return 'stayover';
  if (t === 'deep') return 'deep';
  return 'other';
}

function average(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sum = nums.reduce((acc, n) => acc + n, 0);
  return sum / nums.length;
}

// ── Operations ────────────────────────────────────────────────────────────

export function buildOperationsBlock(args: {
  tasks: CleaningTaskRow[];
  assignments: HkAssignmentRow[];
  inHouse: InHouseSnapshot | null;
  workOrders: WorkOrderRow[];
  totalRoomsOnProperty: number;     // properties.total_rooms — for occupancy denominator
}): OperationsBlock {
  const { tasks, assignments, inHouse, workOrders, totalRoomsOnProperty } = args;

  const completed = tasks.filter(t => t.status === 'completed' || t.status === 'inspected_pass' || t.status === 'check_complete' || t.status === 'correction_complete');
  const roomsCleanedToday = completed.length;
  const totalRoomsOnBoard = tasks.length;

  // OOO is "out of order" — work_orders.out_of_order=true AND still open.
  // OOS is "out of service" — held aside vacant rooms; we use the snapshot
  // for that (pms total_ooo). If the snapshot is missing, fall back to 0.
  const roomsOOO = workOrders.filter(w => w.out_of_order && (w.status === 'open' || w.status === 'in_progress')).length;
  const roomsOOS = inHouse?.total_ooo ?? 0;

  // Occupancy = occupied / total. Use the in-house snapshot if present;
  // otherwise compute from reservations would require more data than we
  // have here, so we fall back to 0 (the daily report shows "—" for null).
  const occupied = inHouse?.total_occupied_rooms ?? 0;
  const occupancyPct = totalRoomsOnProperty > 0
    ? Math.min(100, (occupied / totalRoomsOnProperty) * 100)
    : 0;

  // Per-type averages.
  const departureMinutes: number[] = [];
  const stayoverMinutes: number[] = [];
  const deepMinutes: number[] = [];
  for (const task of completed) {
    const mins = minutesBetween(task.started_at, task.completed_at);
    if (mins === null) continue;
    const bucket = bucketCleaningType(task.cleaning_type);
    if (bucket === 'departure') departureMinutes.push(mins);
    else if (bucket === 'stayover') stayoverMinutes.push(mins);
    else if (bucket === 'deep') deepMinutes.push(mins);
  }

  // Distinct housekeepers on the board today. Counts active assignments
  // only (re-assignments via sick-callout flip the old row to is_active=
  // false, so the count is "people actually working" rather than "people
  // ever touched a task").
  const activeAssignees = new Set<string>();
  for (const a of assignments) {
    if (a.is_active) activeAssignees.add(a.housekeeper_id);
  }
  // If nobody has an active assignment yet (early morning, pre-fan-out),
  // fall back to distinct assignees on the task table itself.
  if (activeAssignees.size === 0) {
    for (const t of tasks) {
      if (t.assignee_id) activeAssignees.add(t.assignee_id);
    }
  }
  const housekeepersOnBoard = activeAssignees.size || 1;
  const roomsPerHousekeeper = roomsCleanedToday / housekeepersOnBoard;

  return {
    roomsCleanedToday,
    totalRoomsOnBoard,
    roomsOOO,
    roomsOOS,
    occupancyPct: r1(occupancyPct),
    avgMinutesPerDeparture: departureMinutes.length ? r1(average(departureMinutes)!) : null,
    avgMinutesPerStayover: stayoverMinutes.length ? r1(average(stayoverMinutes)!) : null,
    avgMinutesPerDeepClean: deepMinutes.length ? r1(average(deepMinutes)!) : null,
    roomsPerHousekeeper: r1(roomsPerHousekeeper),
  };
}

// ── Quality ───────────────────────────────────────────────────────────────

export function buildQualityBlock(inspections: InspectionRow[]): QualityBlock {
  const completed = inspections.filter(i => i.result === 'pass' || i.result === 'fail');
  const passed = inspections.filter(i => i.result === 'pass').length;
  const failed = inspections.filter(i => i.result === 'fail').length;
  const passRatePct = completed.length > 0 ? (passed / completed.length) * 100 : 0;
  // "Re-clean rate" — share of completed inspections that failed (housekeeper
  // has to come back). Same denominator as pass rate.
  const reclearRatePct = completed.length > 0 ? (failed / completed.length) * 100 : 0;

  // Top failure reasons — group failed_items by label, top 3 by count.
  const reasonCounts = new Map<string, number>();
  for (const ins of inspections) {
    if (ins.result !== 'fail') continue;
    for (const item of ins.failed_items ?? []) {
      const label = (item.label ?? item.item_id ?? '').trim();
      if (!label) continue;
      reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
    }
  }
  const topFailureReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));

  return {
    inspectionsCompleted: completed.length,
    inspectionsPassed: passed,
    passRatePct: r1(passRatePct),
    reclearRequestedCount: failed,
    reclearRatePct: r1(reclearRatePct),
    topFailureReasons,
  };
}

// ── Labor ─────────────────────────────────────────────────────────────────

const STANDARD_SHIFT_MINUTES_BEFORE_OT = 8 * 60;  // 8h = 480 minutes

/**
 * Compute hours worked per housekeeper from cleaning_tasks timestamps.
 * Per-staff sum of minutesBetween(started_at, completed_at) for all
 * completed-or-later tasks. Anything over the standard shift counts as
 * overtime; the federal definition is 40h/week, but we don't have a
 * reliable weekly clock-in feed yet, so we approximate at the daily
 * level (>8h on a single day = overtime). Refine when we wire up actual
 * timeclocks.
 */
export function buildLaborBlock(args: {
  tasks: CleaningTaskRow[];
  staff: StaffRow[];
  inHouse: InHouseSnapshot | null;
  callouts: CalloutRow[];
  weeklyBudgetCents: number | null;
}): LaborBlock {
  const { tasks, staff, inHouse, callouts, weeklyBudgetCents } = args;

  const minutesByStaff = new Map<string, number>();
  for (const t of tasks) {
    if (!t.assignee_id) continue;
    const mins = minutesBetween(t.started_at, t.completed_at);
    if (mins === null) continue;
    minutesByStaff.set(t.assignee_id, (minutesByStaff.get(t.assignee_id) ?? 0) + mins);
  }

  const staffById = new Map(staff.map(s => [s.id, s]));

  let totalMinutes = 0;
  let totalOtMinutes = 0;
  let laborCostCents = 0;
  for (const [staffId, minutes] of minutesByStaff) {
    totalMinutes += minutes;
    const ot = Math.max(0, minutes - STANDARD_SHIFT_MINUTES_BEFORE_OT);
    totalOtMinutes += ot;
    // Wage resolution (2026-05-26): prefer hourly_wage_cents (set
    // through /api/staff/wage, audit-logged). Fall back to the legacy
    // hourly_wage dollar column for rows whose wage was last touched
    // before migration 0229. Both null → skip cost contribution for
    // this staff member.
    const staffRow = staffById.get(staffId);
    let wageCents: number | null = null;
    if (staffRow?.hourly_wage_cents !== null && staffRow?.hourly_wage_cents !== undefined && staffRow.hourly_wage_cents > 0) {
      wageCents = staffRow.hourly_wage_cents;
    } else if (staffRow?.hourly_wage !== null && staffRow?.hourly_wage !== undefined && staffRow.hourly_wage > 0) {
      wageCents = Math.round(staffRow.hourly_wage * 100);
    }
    if (wageCents !== null) {
      const regularHours = (minutes - ot) / 60;
      const otHours = ot / 60;
      // OT pay is 1.5x. The federal rule is "over 40/week", but until
      // we have a weekly timeclock we approximate at the daily level.
      laborCostCents += Math.round((regularHours * wageCents));
      laborCostCents += Math.round((otHours * wageCents * 1.5));
    }
  }

  const occupiedRooms = inHouse?.total_occupied_rooms ?? 0;
  const costPerOccupiedRoomCents = occupiedRooms > 0
    ? Math.round(laborCostCents / occupiedRooms)
    : 0;

  // Daily slice of the weekly budget — 1/7th of weekly_budget. Stored
  // here as cents. Null bubbles through if the property has no budget.
  const dailyBudgetCents = weeklyBudgetCents !== null
    ? Math.round(weeklyBudgetCents / 7)
    : null;

  return {
    totalHoursWorked: r1(totalMinutes / 60),
    totalOvertimeHours: r1(totalOtMinutes / 60),
    costPerOccupiedRoomCents,
    laborCostCents,
    laborBudgetCents: dailyBudgetCents,
    sickCalloutsToday: callouts.length,
  };
}

// ── Issues ────────────────────────────────────────────────────────────────

export function buildIssuesBlock(args: {
  workOrders: WorkOrderRow[];
  reportDate: string;
  /** Property timezone, used to detect "today's" reported_at when present. */
  timezone: string;
}): IssuesBlock {
  const { workOrders, reportDate, timezone } = args;

  // "Created today" = reported_at falls on reportDate in the property's
  // local timezone. Postgres-side this would be a date_trunc('day', reported_at
  // AT TIME ZONE …) filter; we do it in JS here so the aggregator stays
  // pure and the caller can pump arbitrary fixtures through it.
  const createdToday = workOrders.filter(w => {
    if (!w.reported_at) return false;
    return isoDateInTz(w.reported_at, timezone) === reportDate;
  }).length;

  const urgentItemsStillPending = workOrders.filter(w =>
    (w.status === 'open' || w.status === 'in_progress')
    && (w.priority === 'urgent' || w.priority === 'high')
  ).length;

  return {
    workOrdersCreatedToday: createdToday,
    urgentItemsStillPending,
  };
}

/**
 * Format an ISO timestamp as 'YYYY-MM-DD' in the property's local
 * timezone. Uses Intl.DateTimeFormat (built in to Node 22, which is
 * what Vercel runs). Falls back to UTC on bad timezone strings.
 */
export function isoDateInTz(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date(ms));   // 'en-CA' yields YYYY-MM-DD natively
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Convert a property-local YYYY-MM-DD calendar date into the absolute
 * UTC ISO instant for that day's midnight in the property's timezone.
 *
 * Used to bound time-range queries (e.g. "all inspections that started
 * on 2026-05-23 in Chicago"). The naïve approach of treating the date
 * as UTC (`${reportDate}T00:00:00Z`) is wrong for any non-UTC property
 * — for Chicago in DST, midnight local = 05:00 UTC, so a query bounded
 * by `2026-05-23T00:00Z … 2026-05-24T00:00Z` would miss the 5 hours
 * after local midnight on the 24th and include the 5 hours before
 * local midnight on the 23rd.
 *
 * Implementation: iterate at most twice through the UTC formatter to
 * find the right millisecond. There's no Intl-blessed inverse of
 * formatToParts; this two-iteration trick handles DST transitions
 * (which never exceed ~1 hour) cheaply.
 */
export function localMidnightToUtc(reportDate: string, timezone: string): string {
  // Start with midnight in UTC as the candidate, then correct for the
  // observed offset between the candidate's local-time output and the
  // requested calendar date. Two passes is enough because the offset
  // never shifts by more than 1 hour even across DST boundaries.
  const [y, m, d] = reportDate.split('-').map(Number);
  let guessMs = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(guessMs));
    const lookup = Object.fromEntries(parts.map(p => [p.type, p.value])) as Record<string, string>;
    const localY = Number(lookup.year);
    const localM = Number(lookup.month);
    const localD = Number(lookup.day);
    // Some Intl impls emit 24 for midnight; normalize to 0.
    const localH = lookup.hour === '24' ? 0 : Number(lookup.hour);
    const localMin = Number(lookup.minute);
    const localS = Number(lookup.second);
    // Difference between the observed local clock and the desired
    // local clock (midnight on reportDate) — in milliseconds.
    const observedLocalMs = Date.UTC(localY, localM - 1, localD, localH, localMin, localS);
    const desiredLocalMs  = Date.UTC(y, m - 1, d, 0, 0, 0);
    const deltaMs = desiredLocalMs - observedLocalMs;
    if (deltaMs === 0) break;
    guessMs += deltaMs;
  }
  return new Date(guessMs).toISOString();
}

// ── Per-staff performance (for the weekly top-performer / improvement
//    opportunity sections) ─────────────────────────────────────────────────

export function rankStaffPerformance(args: {
  tasks: CleaningTaskRow[];
  inspections: InspectionRow[];
  staff: StaffRow[];
}): StaffPerformance[] {
  const { tasks, inspections, staff } = args;
  const byStaff = new Map<string, { rooms: number; mins: number[]; passed: number; failed: number }>();

  for (const t of tasks) {
    if (!t.assignee_id) continue;
    const entry = byStaff.get(t.assignee_id) ?? { rooms: 0, mins: [], passed: 0, failed: 0 };
    if (t.status === 'completed' || t.status === 'inspected_pass' || t.status === 'check_complete' || t.status === 'correction_complete') {
      entry.rooms += 1;
      const mins = minutesBetween(t.started_at, t.completed_at);
      if (mins !== null) entry.mins.push(mins);
    }
    byStaff.set(t.assignee_id, entry);
  }
  for (const ins of inspections) {
    if (!ins.housekeeper_staff_id) continue;
    const entry = byStaff.get(ins.housekeeper_staff_id) ?? { rooms: 0, mins: [], passed: 0, failed: 0 };
    if (ins.result === 'pass') entry.passed += 1;
    else if (ins.result === 'fail') entry.failed += 1;
    byStaff.set(ins.housekeeper_staff_id, entry);
  }

  const staffById = new Map(staff.map(s => [s.id, s]));
  const rankings: StaffPerformance[] = [];
  for (const [staffId, entry] of byStaff) {
    const name = staffById.get(staffId)?.name ?? 'Unknown';
    const totalInspected = entry.passed + entry.failed;
    const passRate = totalInspected > 0 ? (entry.passed / totalInspected) * 100 : null;
    rankings.push({
      staffId,
      name,
      roomsCleaned: entry.rooms,
      avgMinutesPerRoom: entry.mins.length ? r1(average(entry.mins)!) : null,
      inspectionPassRatePct: passRate === null ? null : r1(passRate),
    });
  }
  return rankings;
}
