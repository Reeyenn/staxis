/**
 * Single source of truth for "is this housekeeper eligible to be auto-
 * scheduled on this date?"
 *
 * Why this file exists (Round 18):
 *
 * Three callers used to implement this filter independently:
 *   - src/app/(hotel)/staff/page.tsx       `isEligible()` — canonical, with all
 *                                   the rules (vacation, weekly hours,
 *                                   weekly days, phone, isActive)
 *   - src/app/api/cron/schedule-auto-fill/route.ts — partial filter that
 *                                   only checked department/is_active/
 *                                   schedule_priority. MISSED vacation
 *                                   and weekly-hour caps.
 *   - src/app/housekeeping/_components/ScheduleTab.tsx — pass-through of
 *                                   crew list, no eligibility filter
 *                                   (delegates to autoAssignRooms).
 *
 * Codex+self review caught that the cron version was a strict subset of
 * the canonical rules, meaning the cron would silently assign rooms to
 * housekeepers on vacation, over their weekly hour cap, or over their
 * max-days-per-week. At fleet scale this is real operational harm.
 *
 * Centralizing here means: any future rule (e.g. "skip if not paired
 * device", "skip if recently quit") updates ONE place and all callers
 * benefit.
 */

import type { StaffMember, SchedulePriority } from '@/types';

/** Reasons an otherwise-eligible housekeeper might still be excluded.
 *  Useful for surfacing WHY someone wasn't auto-assigned. */
export type IneligibilityReason =
  | 'inactive'
  | 'no_phone'
  | 'wrong_department'
  | 'priority_excluded'
  | 'on_vacation'
  | 'on_approved_time_off'
  | 'weekly_day_cap_reached'
  | 'weekly_hour_cap_reached';

export interface EligibilityResult {
  eligible: boolean;
  reason?: IneligibilityReason;
}

export interface ActiveCrewOptions {
  /** YYYY-MM-DD in property local time. Used for vacation-date matching. */
  targetDate: string;
  /** If true, require a phone (needed for shift confirmation SMS).
   *  Cron auto-fill keeps this off — the cron just writes the schedule
   *  to the DB; shift confirmations are a separate manager action. */
  requirePhone?: boolean;
  /** If true, exclude housekeepers tagged Priority/Normal/Excluded as
   *  excluded. The UI ALSO does this inside autoAssignRooms; setting it
   *  here just short-circuits earlier. */
  respectSchedulePriority?: boolean;
  /** Set of staff.id values with an approved time_off_request for
   *  targetDate. Callers pre-fetch this from the DB (the pure check
   *  here doesn't query). When set, matching staff are filtered out
   *  with reason='on_approved_time_off'. */
  staffIdsOnApprovedTimeOff?: ReadonlySet<string>;
}

/** Single eligibility check for one staff member on one date.
 *  Pure — no side effects, no DB calls. */
export function checkCrewEligibility(
  s: StaffMember,
  opts: ActiveCrewOptions,
): EligibilityResult {
  if (s.isActive === false) return { eligible: false, reason: 'inactive' };
  if (s.department && s.department !== 'housekeeping') {
    return { eligible: false, reason: 'wrong_department' };
  }
  if (opts.requirePhone && !s.phone) {
    return { eligible: false, reason: 'no_phone' };
  }
  if (opts.respectSchedulePriority && s.schedulePriority === 'excluded') {
    return { eligible: false, reason: 'priority_excluded' };
  }
  if (s.vacationDates?.includes(opts.targetDate)) {
    return { eligible: false, reason: 'on_vacation' };
  }
  if (opts.staffIdsOnApprovedTimeOff?.has(s.id)) {
    return { eligible: false, reason: 'on_approved_time_off' };
  }
  const daysWorked = s.daysWorkedThisWeek ?? 0;
  const maxDays = s.maxDaysPerWeek ?? 5;
  if (daysWorked >= maxDays) {
    return { eligible: false, reason: 'weekly_day_cap_reached' };
  }
  const weeklyHours = s.weeklyHours ?? 0;
  const maxWeeklyHours = s.maxWeeklyHours ?? 40;
  if (weeklyHours >= maxWeeklyHours) {
    return { eligible: false, reason: 'weekly_hour_cap_reached' };
  }
  return { eligible: true };
}

/** Filter a staff roster down to those eligible for auto-scheduling on
 *  the given date, using the canonical rules. */
export function selectActiveCrew(
  staff: ReadonlyArray<StaffMember>,
  opts: ActiveCrewOptions,
): StaffMember[] {
  return staff.filter((s) => checkCrewEligibility(s, opts).eligible);
}

/** Variant that returns BOTH the eligible roster AND the rejected list
 *  with reasons — useful for cron telemetry ("skipped 3 housekeepers:
 *  2 on vacation, 1 at weekly hour cap"). */
export function selectActiveCrewWithReasons(
  staff: ReadonlyArray<StaffMember>,
  opts: ActiveCrewOptions,
): {
  eligible: StaffMember[];
  excluded: Array<{ staff: StaffMember; reason: IneligibilityReason }>;
} {
  const eligible: StaffMember[] = [];
  const excluded: Array<{ staff: StaffMember; reason: IneligibilityReason }> = [];
  for (const s of staff) {
    const r = checkCrewEligibility(s, opts);
    if (r.eligible) eligible.push(s);
    else if (r.reason) excluded.push({ staff: s, reason: r.reason });
  }
  return { eligible, excluded };
}

/** Re-export for callers that build StaffMember-like shapes server-side
 *  and want type safety on the schedulePriority union. */
export type { SchedulePriority };

// ─────────────────────────────────────────────────────────────────────────
// Schedule-derived crew (2026-07-24)
// ─────────────────────────────────────────────────────────────────────────
/**
 * "Who is on the housekeeping crew on date D?" — resolved from the REAL
 * staff schedule (`scheduled_shifts`), not from `staff.scheduled_today`.
 *
 * Why this exists:
 *   `staff.scheduled_today` is a single non-date-aware boolean that is
 *   only ever initialized to `false` and never written by the Staff
 *   schedule editor. The housekeeping board, the timeline and the
 *   auto-assign runner all read it, so they disagreed with the schedule
 *   a manager actually built: someone off today still showed up as a
 *   droppable crew row, and the nightly auto-assign cron filtered on a
 *   flag that is false for everyone (so it placed nothing).
 *
 * The join mirrors /api/housekeeping/forecast: scheduled_shifts scoped
 * by property + department='housekeeping' + shift_date, excluding
 * 'declined' rows, de-duplicated by staff_id.
 *
 * FAIL-SAFE RULE (the most important behaviour here):
 *   A hotel that has never adopted the Staff schedule has ZERO rows in
 *   scheduled_shifts. A naive filter would render an empty board, which
 *   looks exactly like a broken product. So when there is no shift on
 *   file for that date we fall back to the whole active roster and
 *   report `source: 'unscheduled_fallback'` so the UI can explain why.
 *   Likewise, approved time off is respected but is NEVER allowed to
 *   empty the crew — if it would, we keep everyone and flag it — and it
 *   never removes someone who already holds today's rooms
 *   (`alwaysIncludeStaffIds`), because their work would go with them.
 */

/** Minimal shape of a `scheduled_shifts` row this resolver needs. */
export interface ScheduledShiftRow {
  staff_id: string | null;
  shift_date: string;
  start_time: string | null;
  end_time: string | null;
  status?: string | null;
  kind?: string | null;
}

/** Roster entry the caller already loaded (board/timeline/runner all
 *  read `staff` before calling us, so we don't re-query it). */
export interface CrewRosterMember {
  id: string;
  isActive?: boolean | null;
}

export type CrewSource = 'scheduled' | 'unscheduled_fallback';

export interface CrewMemberForDate {
  staffId: string;
  /** Real scheduled minutes for that date (summed across their shifts).
   *  Falls back to the property's default shift length when we're in
   *  fallback mode or a shift row has no usable times. Capacity bars
   *  must use THIS, not a uniform per-property shiftMinutes. */
  scheduledMinutes: number;
  /** False when the person is on the board despite having no shift
   *  (fallback mode, or "called in" — they already hold work today). */
  isScheduled: boolean;
}

export interface HousekeepingCrewForDate {
  date: string;
  source: CrewSource;
  members: CrewMemberForDate[];
  memberIds: Set<string>;
  minutesByStaffId: Map<string, number>;
  /** Staff with an approved time-off request for this date. */
  timeOffStaffIds: Set<string>;
  /** True when honoring time off would have emptied the crew, so we
   *  kept everyone instead. */
  timeOffIgnoredToKeepCrew: boolean;
  /** True when the schedule read failed and we degraded to the roster. */
  degraded: boolean;
}

/** Fallback shift length when a property hasn't set one. Matches the
 *  board's historical hard-coded 420 (7h). */
export const DEFAULT_CREW_SHIFT_MINUTES = 420;

/** Parse a Postgres `time` value ("08:00:00", "08:00") to minutes past
 *  midnight. Returns null on anything unparseable. */
export function timeToMinutes(t: string | null | undefined): number | null {
  if (typeof t !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Length of one shift in minutes. An end at or before the start means
 *  the shift crosses midnight (11pm→7am), so add a day. */
export function shiftDurationMinutes(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  fallbackMinutes: number,
): number {
  const start = timeToMinutes(startTime);
  const end = timeToMinutes(endTime);
  if (start === null || end === null) return fallbackMinutes;
  const raw = end - start;
  // raw === 0 is nonsense data (a zero-length shift), NOT a 24-hour one —
  // don't let the midnight wrap turn it into 1440. Anything that still
  // lands at/below zero falls back too: a 0-minute capacity bar would
  // divide-by-zero into a permanent "over cap".
  if (raw === 0) return fallbackMinutes;
  const mins = raw > 0 ? raw : raw + 1440;
  return mins > 0 ? mins : fallbackMinutes;
}

/**
 * Pure core. Given the roster + the day's shift rows, decide who is on
 * the crew and for how many minutes. No DB, no clock — every caller and
 * every test goes through this.
 */
export function computeHousekeepingCrewForDate(input: {
  date: string;
  roster: ReadonlyArray<CrewRosterMember>;
  shifts: ReadonlyArray<ScheduledShiftRow>;
  timeOffStaffIds?: ReadonlySet<string>;
  defaultShiftMinutes?: number | null;
  /** Staff who must appear regardless of the schedule OR of approved time
   *  off — e.g. someone who already holds assigned rooms today ("called
   *  in", or sent home after the day was planned). Hiding them would
   *  strand their work. Must still be on the active roster. */
  alwaysIncludeStaffIds?: ReadonlySet<string>;
  degraded?: boolean;
}): HousekeepingCrewForDate {
  const {
    date, roster, shifts,
    timeOffStaffIds = new Set<string>(),
    alwaysIncludeStaffIds = new Set<string>(),
    degraded = false,
  } = input;

  const defaultMinutes =
    typeof input.defaultShiftMinutes === 'number' && input.defaultShiftMinutes > 0
      ? input.defaultShiftMinutes
      : DEFAULT_CREW_SHIFT_MINUTES;

  // Only active roster members can ever be on the crew.
  const activeIds = new Set<string>();
  for (const r of roster) {
    if (r.isActive === false) continue;
    activeIds.add(r.id);
  }

  // Shifts that count toward "working this date". Filtered in-memory as
  // well as in SQL so a caller (or a test fake) handing us a wider row
  // set can never leak an adjacent day or an open/declined slot in.
  //
  // DRAFT shifts count on purpose. Migration 0147 defines `draft` as "the
  // manager is building the week, not yet visible to staff" — but every
  // consumer of this resolver is a MANAGER surface (the board, the
  // timeline, the auto-assign runner). A manager who penciled in tomorrow
  // should see tomorrow's crew on the board. Only `declined` (the person
  // said no) and `kind='open'` (nobody claimed it) are excluded.
  const minutesByStaffId = new Map<string, number>();
  for (const s of shifts) {
    if (s.shift_date !== date) continue;
    if (!s.staff_id) continue;
    if (s.kind === 'open') continue;
    if (s.status === 'declined') continue;
    if (!activeIds.has(s.staff_id)) continue;
    const mins = shiftDurationMinutes(s.start_time, s.end_time, defaultMinutes);
    minutesByStaffId.set(s.staff_id, (minutesByStaffId.get(s.staff_id) ?? 0) + mins);
  }

  const timeOff = new Set<string>();
  for (const id of timeOffStaffIds) if (activeIds.has(id)) timeOff.add(id);

  let source: CrewSource;
  let candidateIds: string[];
  if (minutesByStaffId.size === 0) {
    // ── FAIL-SAFE: nothing on the schedule for this date. Show everyone
    //    rather than an empty board.
    source = 'unscheduled_fallback';
    candidateIds = [...activeIds];
  } else {
    source = 'scheduled';
    candidateIds = [...minutesByStaffId.keys()];
    for (const id of alwaysIncludeStaffIds) {
      if (activeIds.has(id) && !minutesByStaffId.has(id)) candidateIds.push(id);
    }
  }

  // Approved time off removes people — with two exceptions.
  //
  //  1. `alwaysIncludeStaffIds` WINS over time off. These are people who
  //     already hold assigned rooms today. Approving a same-day time-off
  //     request mid-shift used to drop them off the crew while their rooms
  //     kept their name on them: the Board shunted those rooms into the
  //     Unassigned lane, and the Timeline (which has no unassigned lane)
  //     dropped them from the screen and from the over-cap math entirely.
  //     Someone holding today's work must always render, or the work goes
  //     invisible.
  //  2. Time off is never allowed to empty the crew — an unexplained empty
  //     board is worse than a slightly-too-wide one.
  let kept = candidateIds.filter(
    (id) => !timeOff.has(id) || alwaysIncludeStaffIds.has(id),
  );
  let timeOffIgnoredToKeepCrew = false;
  if (kept.length === 0 && candidateIds.length > 0) {
    kept = candidateIds;
    timeOffIgnoredToKeepCrew = true;
  }

  const members: CrewMemberForDate[] = kept.map((staffId) => ({
    staffId,
    scheduledMinutes: minutesByStaffId.get(staffId) ?? defaultMinutes,
    isScheduled: source === 'scheduled' && minutesByStaffId.has(staffId),
  }));

  // Drop minutes for anyone who didn't make the final crew so callers
  // can't accidentally size a bar for someone who isn't rendered.
  const finalMinutes = new Map<string, number>();
  for (const m of members) finalMinutes.set(m.staffId, m.scheduledMinutes);

  return {
    date,
    source,
    members,
    memberIds: new Set(members.map((m) => m.staffId)),
    minutesByStaffId: finalMinutes,
    timeOffStaffIds: timeOff,
    timeOffIgnoredToKeepCrew,
    degraded,
  };
}

/** DB reads this resolver needs. Injectable so tests exercise the real
 *  async path without a database. */
export interface CrewScheduleReader {
  shiftsForDate(propertyId: string, date: string): Promise<ScheduledShiftRow[]>;
  approvedTimeOffForDate(propertyId: string, date: string): Promise<string[]>;
}

/** Service-role reader. The supabase-admin import is deferred so this
 *  module stays importable (and testable) without env vars — that module
 *  throws at load time by design when they're missing. */
export function createSupabaseCrewScheduleReader(): CrewScheduleReader {
  return {
    async shiftsForDate(propertyId, date) {
      const { supabaseAdmin } = await import('@/lib/supabase-admin');
      const { data, error } = await supabaseAdmin
        .from('scheduled_shifts')
        .select('staff_id, shift_date, start_time, end_time, status, kind')
        .eq('property_id', propertyId)
        .eq('department', 'housekeeping')
        .eq('shift_date', date)
        .neq('status', 'declined');
      if (error) throw new Error(`scheduled_shifts read failed: ${error.message}`);
      return (data ?? []) as unknown as ScheduledShiftRow[];
    },
    async approvedTimeOffForDate(propertyId, date) {
      const { supabaseAdmin } = await import('@/lib/supabase-admin');
      const { data, error } = await supabaseAdmin
        .from('time_off_requests')
        .select('staff_id')
        .eq('property_id', propertyId)
        .eq('status', 'approved')
        .eq('request_date', date);
      if (error) throw new Error(`time_off_requests read failed: ${error.message}`);
      return (data ?? []).map((r) => String((r as { staff_id: unknown }).staff_id));
    },
  };
}

/**
 * Resolve the housekeeping crew for one property + one date.
 *
 * `date` is a property-local YYYY-MM-DD. Callers that don't have one
 * should derive it with `propertyLocalToday(new Date(), property.timezone)`
 * from ./local-date — an off-by-one day here silently empties or wrongly
 * fills the board.
 *
 * Never throws: a failed read degrades to the full roster (`degraded:
 * true`, `source: 'unscheduled_fallback'`) because an unexplained empty
 * board is worse than a slightly-too-wide one.
 */
export async function resolveHousekeepingCrewForDate(args: {
  propertyId: string;
  date: string;
  roster: ReadonlyArray<CrewRosterMember>;
  defaultShiftMinutes?: number | null;
  alwaysIncludeStaffIds?: ReadonlySet<string>;
  reader?: CrewScheduleReader;
}): Promise<HousekeepingCrewForDate> {
  const reader = args.reader ?? createSupabaseCrewScheduleReader();
  let shifts: ScheduledShiftRow[] = [];
  let timeOff: string[] = [];
  let degraded = false;
  try {
    [shifts, timeOff] = await Promise.all([
      reader.shiftsForDate(args.propertyId, args.date),
      reader.approvedTimeOffForDate(args.propertyId, args.date),
    ]);
  } catch {
    shifts = [];
    timeOff = [];
    degraded = true;
  }
  return computeHousekeepingCrewForDate({
    date: args.date,
    roster: args.roster,
    shifts,
    timeOffStaffIds: new Set(timeOff),
    defaultShiftMinutes: args.defaultShiftMinutes,
    alwaysIncludeStaffIds: args.alwaysIncludeStaffIds,
    degraded,
  });
}
