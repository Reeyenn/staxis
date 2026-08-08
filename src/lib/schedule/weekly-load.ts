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
 * ── THE TARGET DATE IS NOT PART OF THE LOAD (fixed 2026-08-07) ─────────────
 * The window used to be the 7 days ENDING AT `targetDate`, inclusive. That
 * double-counted the very day the caller is asking about, and because both
 * caps compare with `>=` it produced a guaranteed off-by-one:
 *
 *   A housekeeper scheduled the ordinary Mon–Fri, 8h a day, hits
 *   days = 5 (>= the default max_days_per_week of 5) AND hours = 40
 *   (>= the default max_weekly_hours of 40) ON FRIDAY — the fifth day, which
 *   is inside her limit, not past it. checkCrewEligibility excluded her with
 *   `weekly_day_cap_reached`, so the nightly auto-fill gave her no rooms.
 *   With a whole crew on that schedule the cron returned `skipped_no_crew`
 *   and assigned nothing at all, every Friday.
 *
 * Both callers ask the same question — "should this person be given MORE work
 * ON targetDate?" — and on that date her shift already exists and is not
 * something the caller can add or remove. So the honest denominator is what she
 * is committed to on the OTHER days of the window: the six days before
 * `targetDate`. `daysWorked >= maxDays` then reads correctly as "targetDate
 * would be one day too many", and 40h across Mon–Fri correctly excludes her
 * from a SIXTH day on Saturday instead of from Friday itself.
 *
 * Only real assigned shifts the staffer hasn't declined count.
 */
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

/** Inclusive shift_date bounds of the "already committed" window. */
export interface WeeklyLoadWindow {
  start: string;
  end: string;
}

/**
 * The six days BEFORE `targetDate`, inclusive on both ends.
 *
 * `targetDate` itself is deliberately absent — see the header. Together with
 * the day being decided this still spans seven days, which is what the caps are
 * denominated in.
 */
export function weeklyLoadWindow(targetDate: string): WeeklyLoadWindow {
  return {
    start: addDaysInTz(targetDate, -6),
    end: addDaysInTz(targetDate, -1),
  };
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
 * The one DB read this module needs. Injectable so a test can exercise the real
 * async path — including which window it asks for — without a database.
 */
export interface WeeklyLoadReader {
  shiftsInWindow(
    propertyId: string,
    window: WeeklyLoadWindow,
  ): Promise<WeeklyLoadShiftRow[]>;
}

/** Service-role reader. The supabase-admin import is deferred so this module
 *  stays importable (and testable) without env vars — that module throws at
 *  load time by design when they're missing. */
export function createSupabaseWeeklyLoadReader(): WeeklyLoadReader {
  return {
    async shiftsInWindow(propertyId, window) {
      const { supabaseAdmin } = await import('@/lib/supabase-admin');
      const { data, error } = await supabaseAdmin
        .from('scheduled_shifts')
        .select('staff_id, shift_date, start_time, end_time')
        .eq('property_id', propertyId)
        .eq('kind', 'shift')
        .neq('status', 'declined')
        .not('staff_id', 'is', null)
        .gte('shift_date', window.start)
        .lte('shift_date', window.end);
      if (error) throw new Error(`scheduled_shifts read failed: ${error.message}`);
      return (data ?? []) as unknown as WeeklyLoadShiftRow[];
    },
  };
}

/**
 * Load the weekly hours + days each housekeeper is ALREADY committed to on the
 * six days before `targetDate` (YYYY-MM-DD, property-local).
 *
 * Returns an empty map on error so callers degrade to "no known load" (the cap
 * simply doesn't fire) rather than crashing the schedule build.
 */
export async function computeWeeklyLoadByStaff(
  propertyId: string,
  targetDate: string,
  reader: WeeklyLoadReader = createSupabaseWeeklyLoadReader(),
): Promise<Map<string, WeeklyLoad>> {
  try {
    const rows = await reader.shiftsInWindow(propertyId, weeklyLoadWindow(targetDate));
    return aggregateWeeklyLoad(rows);
  } catch {
    return new Map();
  }
}
