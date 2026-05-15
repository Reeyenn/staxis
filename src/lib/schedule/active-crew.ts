/**
 * Single source of truth for "is this housekeeper eligible to be auto-
 * scheduled on this date?"
 *
 * Why this file exists (Round 18):
 *
 * Three callers used to implement this filter independently:
 *   - src/app/staff/page.tsx       `isEligible()` — canonical, with all
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
