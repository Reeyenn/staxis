/**
 * Derive each housekeeper's committed weekly load (hours + distinct days
 * worked) from scheduled_shifts.
 *
 * Why this exists: the overtime / weekly-day-off protections —
 * checkCrewEligibility() in active-crew.ts (a hard exclusion) and
 * scoreOvertime() in the assignment engine (a soft penalty) — read
 * `staff.weekly_hours` and `staff.days_worked_this_week`. Nothing anywhere ever
 * writes those columns, so they sat at 0 and BOTH protections were silently
 * inert: the auto-scheduler would happily push a housekeeper past 40h / a 6th
 * day. This computes the real numbers on demand from the schedule, so callers
 * can overlay them onto the staff objects before running the caps.
 *
 * "This week" = a rolling 7-day window ENDING at the target date (matches the
 * dashboard labor-cost window). Only real assigned shifts the staffer hasn't
 * declined count.
 */
import { supabaseAdmin } from '@/lib/supabase-admin';
import { shiftMinutes } from '@/lib/labor-cost';
import { addDaysInTz } from '@/lib/schedule/local-date';

export interface WeeklyLoad {
  /** Hours committed in the window. */
  hours: number;
  /** Distinct calendar days with an assigned shift in the window. */
  days: number;
}

export interface WeeklyLoadShiftRow {
  staff_id: string | null;
  shift_date: string | null;
  start_time: string | null;
  end_time: string | null;
}

/** Pure aggregation core (no DB) so the math is unit-testable. */
export function aggregateWeeklyLoad(rows: ReadonlyArray<WeeklyLoadShiftRow>): Map<string, WeeklyLoad> {
  const minutesByStaff = new Map<string, number>();
  const daysByStaff = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.staff_id) continue;
    minutesByStaff.set(r.staff_id, (minutesByStaff.get(r.staff_id) ?? 0) + shiftMinutes(r.start_time, r.end_time));
    const set = daysByStaff.get(r.staff_id) ?? new Set<string>();
    if (r.shift_date) set.add(r.shift_date);
    daysByStaff.set(r.staff_id, set);
  }
  const out = new Map<string, WeeklyLoad>();
  for (const [staffId, mins] of minutesByStaff) {
    out.set(staffId, { hours: mins / 60, days: daysByStaff.get(staffId)?.size ?? 0 });
  }
  return out;
}

/**
 * Load the committed weekly hours + days for every housekeeper at a property,
 * for the 7-day window ending at `targetDate` (YYYY-MM-DD, property-local).
 * Returns an empty map on error so callers degrade to "no known load" (the
 * cap simply doesn't fire) rather than crashing the schedule build.
 */
export async function computeWeeklyLoadByStaff(
  propertyId: string,
  targetDate: string,
): Promise<Map<string, WeeklyLoad>> {
  const windowStart = addDaysInTz(targetDate, -6);
  const { data, error } = await supabaseAdmin
    .from('scheduled_shifts')
    .select('staff_id, shift_date, start_time, end_time')
    .eq('property_id', propertyId)
    .eq('kind', 'shift')
    .neq('status', 'declined')
    .not('staff_id', 'is', null)
    .gte('shift_date', windowStart)
    .lte('shift_date', targetDate);
  if (error || !data) return new Map();
  return aggregateWeeklyLoad(data as WeeklyLoadShiftRow[]);
}
