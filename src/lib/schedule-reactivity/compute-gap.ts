/**
 * Compute the demand-vs-scheduled gap for one (property, date, department).
 *
 * Demand model per department:
 *   housekeeping: ML-driven when supply_predictions has a fresh row, else
 *     a rule-based fallback (sum of room-minutes from today_room_work_v1).
 *   front_desk:   properties.front_desk_coverage_hours × 60 (24/7 default).
 *   maintenance:  properties.maintenance_shifts_per_day × shift_minutes.
 *   houseman:     properties.houseman_shifts_per_day × shift_minutes.
 *   breakfast:    (breakfast_window_end − breakfast_window_start). NULL
 *                 window pair → 0 demand (manager opted out).
 *   other:        0 (no demand model; alerts not produced).
 *
 * Pure / DI-friendly: takes a small "reader" surface (plain async fns)
 * rather than supabaseAdmin, so unit tests pass fixtures directly.
 */

import type { Gap, AlertDepartment } from './types';

export interface ComputeGapReader {
  /** Sum of room-minutes from today_room_work_v1 for the property+date.
   *  Returns null when the bridge has no rows yet (CUA hasn't reached the
   *  property or it's an all-vacant day). */
  housekeepingRoomMinutes(propertyId: string, date: string): Promise<number | null>;

  /** ML supply prediction for housekeeping minutes on this date, if a
   *  fresh row exists in supply_predictions. Returns null when the ML
   *  service hasn't predicted yet — caller falls back to rule-based. */
  housekeepingMlMinutes(propertyId: string, date: string): Promise<number | null>;

  /** Sum of (end_time - start_time) minutes from scheduled_shifts for the
   *  (property, date, dept), kind='shift', status != 'declined'. */
  scheduledMinutes(
    propertyId: string,
    date: string,
    dept: AlertDepartment,
  ): Promise<number>;

  /** Per-property config columns we need for non-housekeeping demand. */
  propertyConfig(propertyId: string): Promise<{
    frontDeskCoverageHours: number | null;
    maintenanceShiftsPerDay: number | null;
    housemanShiftsPerDay: number | null;
    breakfastWindowStart: string | null;
    breakfastWindowEnd: string | null;
    shiftMinutes: number | null;
  }>;
}

/** All non-'other' departments — caller iterates these. 'other' is never
 *  alerted on (no demand model defined). */
export const ALERTABLE_DEPTS: ReadonlyArray<AlertDepartment> = [
  'housekeeping',
  'front_desk',
  'maintenance',
  'breakfast',
  'houseman',
];

/**
 * Compute the Gap for one (property, date, department). Returns null when
 * the department's demand model is "off" for this property (e.g. breakfast
 * window pair both null → manager hasn't opted in → no demand → no alert).
 */
export async function computeGapFor(
  propertyId: string,
  date: string,
  dept: AlertDepartment,
  reader: ComputeGapReader,
): Promise<Gap | null> {
  const cfg = await reader.propertyConfig(propertyId);
  const scheduledMinutes = await reader.scheduledMinutes(propertyId, date, dept);

  // Resolve demand per dept. Null demand = "no model for this combo" = skip.
  let demandMinutes: number | null = null;
  const context: Record<string, unknown> = { demandModel: '' };

  switch (dept) {
    case 'housekeeping': {
      const ml = await reader.housekeepingMlMinutes(propertyId, date);
      if (ml !== null) {
        demandMinutes = ml;
        context.demandModel = 'ml_supply';
      } else {
        const rules = await reader.housekeepingRoomMinutes(propertyId, date);
        if (rules !== null) {
          demandMinutes = rules;
          context.demandModel = 'rule_today_room_work';
        }
      }
      break;
    }
    case 'front_desk': {
      const hours = cfg.frontDeskCoverageHours;
      if (hours !== null && hours > 0) {
        demandMinutes = hours * 60;
        context.demandModel = 'rule_front_desk_coverage_hours';
        context.coverageHours = hours;
      }
      break;
    }
    case 'maintenance': {
      const shifts = cfg.maintenanceShiftsPerDay;
      const shiftMin = cfg.shiftMinutes ?? 420; // matches properties.shift_minutes default
      if (shifts !== null && shifts > 0) {
        demandMinutes = shifts * shiftMin;
        context.demandModel = 'rule_maintenance_shifts_per_day';
        context.shiftsPerDay = shifts;
        context.shiftMinutes = shiftMin;
      }
      break;
    }
    case 'houseman': {
      const shifts = cfg.housemanShiftsPerDay;
      const shiftMin = cfg.shiftMinutes ?? 420;
      if (shifts !== null && shifts > 0) {
        demandMinutes = shifts * shiftMin;
        context.demandModel = 'rule_houseman_shifts_per_day';
        context.shiftsPerDay = shifts;
        context.shiftMinutes = shiftMin;
      }
      break;
    }
    case 'breakfast': {
      const start = cfg.breakfastWindowStart;
      const end = cfg.breakfastWindowEnd;
      if (start && end) {
        const mins = timeWindowMinutes(start, end);
        if (mins > 0) {
          demandMinutes = mins;
          context.demandModel = 'rule_breakfast_window';
          context.window = { start, end };
        }
      }
      break;
    }
    case 'other':
      return null;
  }

  if (demandMinutes === null) return null;

  return {
    propertyId,
    alertDate: date,
    department: dept,
    demandMinutes,
    scheduledMinutes,
    gapMinutes: demandMinutes - scheduledMinutes,
    context,
  };
}

/**
 * Compute Gaps for all alertable departments at once. Wraps each call so a
 * single dept failure (e.g. ML reader threw) doesn't block the others.
 *
 * The caller is responsible for deciding what to do with the gaps —
 * suggest-action turns them into Suggestions, create-alert persists.
 */
export async function computeGapsForAllDepts(
  propertyId: string,
  date: string,
  reader: ComputeGapReader,
): Promise<Gap[]> {
  const out: Gap[] = [];
  for (const dept of ALERTABLE_DEPTS) {
    try {
      const g = await computeGapFor(propertyId, date, dept, reader);
      if (g) out.push(g);
    } catch {
      // Per-dept failure must not block the others. Caller logs upstream
      // if the propagation matters; here we keep the loop alive.
      continue;
    }
  }
  return out;
}

/**
 * Compute the minutes between two HH:MM(:SS) time strings, treating the
 * window as same-day (no crossing midnight). Negative or zero returns 0.
 * Exported for tests.
 */
export function timeWindowMinutes(start: string, end: string): number {
  const s = parseHmsToMinutes(start);
  const e = parseHmsToMinutes(end);
  if (s === null || e === null) return 0;
  return Math.max(0, e - s);
}

function parseHmsToMinutes(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}
