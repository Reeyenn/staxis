/**
 * Pure helpers for the Labor Cost % widget.
 *
 * Mirrors src/lib/forecast/index.ts in spirit: NOTHING in here does I/O. The
 * API routes (/api/dashboard/labor-cost, /api/settings/wages) own the Supabase
 * reads, then hand the pre-fetched rows to these functions. Keeping the wage
 * resolution + hours math + band classification pure lets the unit tests
 * exercise the rules directly (no PG glue, no mocks) and guarantees the
 * Dashboard tile and the Settings page agree on what a wage "is".
 *
 * Money is INTEGER CENTS end-to-end (matching the financials convention).
 */

import { DEFAULT_HOURLY_WAGE_CENTS } from '@/lib/forecast';

// Re-export so callers have a single import surface for "the wage we assume
// when nothing is on file". Defined once in forecast/index.ts (US BLS median
// for hotel housekeepers, rounded conservatively) — do NOT duplicate the
// literal here.
export { DEFAULT_HOURLY_WAGE_CENTS };

// ─────────────────────────────────────────────────────────────────────
// Roles + access
// ─────────────────────────────────────────────────────────────────────

/**
 * The four scheduled_shifts departments. A per-role wage default is keyed by
 * one of these. Matches the CHECK constraint on labor_wage_settings.role and
 * scheduled_shifts.department.
 */
export const LABOR_ROLE_DEPARTMENTS = [
  'housekeeping', 'front_desk', 'maintenance', 'other',
] as const;
export type LaborRole = typeof LABOR_ROLE_DEPARTMENTS[number];

export function isLaborRole(v: unknown): v is LaborRole {
  return typeof v === 'string' && (LABOR_ROLE_DEPARTMENTS as readonly string[]).includes(v);
}

/**
 * Roles permitted to see labor cost dollars + individual wages.
 *
 * Wages are sensitive pay data — same trio as canManageTeam / canViewFinancials
 * (admin / owner / general_manager). Front-desk / housekeeping / maintenance /
 * staff must NOT see the tile, the wage settings page, or any wage figure. Kept
 * as a Set so the route handler does a single .has() per request and the test
 * can iterate it. If you change this, change canViewFinancials too — both gate
 * sensitive money surfaces.
 */
const LABOR_ALLOWED_ROLES: ReadonlySet<string> = new Set([
  'admin', 'owner', 'general_manager',
]);

export function canViewLaborCost(role: string | null | undefined): boolean {
  if (!role) return false;
  return LABOR_ALLOWED_ROLES.has(role);
}

// ─────────────────────────────────────────────────────────────────────
// Target band
// ─────────────────────────────────────────────────────────────────────

/**
 * Default labor-cost-as-%-of-revenue target. 30% is a common limited-service
 * benchmark. A simple constant for now; per-property configurability is a
 * follow-up (would live on properties as e.g. labor_target_pct).
 */
export const DEFAULT_LABOR_TARGET_PCT = 30;

/** Width of the "warn" band above target, in percentage points. */
export const LABOR_WARN_BAND_PTS = 5;

export type LaborStatus = 'good' | 'warn' | 'over';

/**
 * Classify a labor % against the target band:
 *   good — pct ≤ target
 *   warn — target < pct ≤ target + LABOR_WARN_BAND_PTS
 *   over — pct > target + LABOR_WARN_BAND_PTS
 *
 * Defensive: a non-finite pct (NaN from a 0/0 that slipped through) classifies
 * as 'good' rather than throwing — the caller is expected to pass null pct
 * through as null status instead of calling this at all when revenue is 0.
 */
export function classifyLaborBand(
  pct: number,
  targetPct: number = DEFAULT_LABOR_TARGET_PCT,
): LaborStatus {
  if (!Number.isFinite(pct)) return 'good';
  if (pct <= targetPct) return 'good';
  if (pct <= targetPct + LABOR_WARN_BAND_PTS) return 'warn';
  return 'over';
}

// ─────────────────────────────────────────────────────────────────────
// Shift hours (overnight-safe)
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse a Postgres `time` value ('HH:MM' or 'HH:MM:SS') into minutes since
 * midnight. Returns null on anything unparseable so the caller can skip the
 * row rather than feed NaN into the cost math. Seconds contribute as a
 * fraction of a minute (a shift boundary is virtually always :00, but this
 * keeps a '...:30' honest).
 */
export function parseTimeToMinutes(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = m[3] ? Number(m[3]) : 0;
  if (h > 23) return null;
  return h * 60 + min + s / 60;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Duration of one shift in minutes, handling overnight shifts where the end
 * time is at or before the start time (e.g. 23:00 → 07:00 = 480 min).
 *
 *   end > start   → end - start              (same-day shift)
 *   end < start   → end - start + 1440        (crossed midnight)
 *   end == start  → 0                         (degenerate / data error; not 24h)
 *
 * Returns 0 (not NaN) on unparseable times so a single bad row can't poison
 * the whole property's labor cost. Capped at 24h.
 */
export function shiftMinutes(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): number {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  if (start == null || end == null) return 0;
  let dur = end - start;
  if (dur < 0) dur += MINUTES_PER_DAY;
  if (!Number.isFinite(dur) || dur < 0) return 0;
  return Math.min(dur, MINUTES_PER_DAY);
}

// ─────────────────────────────────────────────────────────────────────
// Wage resolution
// ─────────────────────────────────────────────────────────────────────

export type WageSource = 'person' | 'role' | 'staff' | 'default';

export interface WageResolutionInputs {
  /** labor_wage_settings per-person override (cents), if one exists. */
  personOverrideCents?: number | null;
  /** labor_wage_settings role default (cents) for this person's department. */
  roleDefaultCents?: number | null;
  /** Existing staff.hourly_wage, in DOLLARS (legacy column). */
  staffHourlyWageDollars?: number | null;
}

/**
 * Resolve a single person's hourly wage in cents, following the order the
 * product spec fixes:
 *
 *   per-person override → role default → existing staff.hourly_wage → benchmark
 *
 * `source` tells the caller which rung was used. source==='default' is the
 * signal that NO real wage was on file for this person — it drives the
 * "Set wages" prompt + the missing_wages flag, exactly like the forecast's
 * wage_pending. staff.hourly_wage is treated as a real wage (source 'staff'),
 * because it is one — it just isn't managed from the new settings page.
 */
export function resolveWageCents(input: WageResolutionInputs): {
  cents: number;
  source: WageSource;
} {
  if (isPositiveCents(input.personOverrideCents)) {
    return { cents: Math.round(input.personOverrideCents as number), source: 'person' };
  }
  if (isPositiveCents(input.roleDefaultCents)) {
    return { cents: Math.round(input.roleDefaultCents as number), source: 'role' };
  }
  const dollars = input.staffHourlyWageDollars;
  if (typeof dollars === 'number' && Number.isFinite(dollars) && dollars > 0) {
    // staff.hourly_wage is numeric DOLLARS on main; convert to cents here —
    // the single dollars→cents boundary for this column (mirrors the forecast
    // route's ×100 conversion).
    return { cents: Math.round(dollars * 100), source: 'staff' };
  }
  return { cents: DEFAULT_HOURLY_WAGE_CENTS, source: 'default' };
}

function isPositiveCents(v: number | null | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// ─────────────────────────────────────────────────────────────────────
// Labor cost (daily overtime, 1.5×)
// ─────────────────────────────────────────────────────────────────────

/** Daily hours past which a person's time counts as overtime. */
export const LABOR_OT_DAILY_MINUTES = 8 * 60; // 480
/** Overtime pay multiplier. */
export const LABOR_OT_MULTIPLIER = 1.5;

/**
 * Labor cost (cents) for ONE person given their total scheduled minutes for
 * the day and their hourly wage in cents. Anything over 8h/day is paid at
 * 1.5×. Mirrors src/lib/reports/aggregate.ts buildLaborBlock — the federal
 * rule is 40h/week, but without a weekly timeclock feed we approximate at the
 * daily level (>8h on a single day = OT). Rounds each component (regular / OT)
 * independently, matching buildLaborBlock so the two surfaces never drift by a
 * cent.
 */
export function laborCentsForMinutes(minutes: number, hourlyWageCents: number): number {
  const m = Math.max(0, Number.isFinite(minutes) ? minutes : 0);
  const wage = Math.max(0, Number.isFinite(hourlyWageCents) ? hourlyWageCents : 0);
  const otMinutes = Math.max(0, m - LABOR_OT_DAILY_MINUTES);
  const regularMinutes = m - otMinutes;
  return (
    Math.round((regularMinutes / 60) * wage)
    + Math.round((otMinutes / 60) * wage * LABOR_OT_MULTIPLIER)
  );
}

/**
 * Sum labor cost (cents) across people, each already collapsed to their total
 * scheduled minutes for the day + resolved wage. Per-person OT is applied
 * inside laborCentsForMinutes (overtime is a per-person daily concept, so the
 * minutes MUST be summed per person before this is called — never across
 * people).
 */
export function totalLaborCents(
  perStaff: Array<{ minutes: number; wageCents: number }>,
): number {
  let cents = 0;
  for (const p of perStaff) cents += laborCentsForMinutes(p.minutes, p.wageCents);
  return cents;
}

/**
 * Labor cost as a percentage of revenue, rounded to one decimal. Returns null
 * when revenue is null or ≤ 0 — the honest "show cost only, hide %" state. A
 * 0/0 never produces NaN because the null guard fires first.
 */
export function laborCostPct(
  laborCostCents: number,
  revenueCents: number | null,
): number | null {
  if (revenueCents == null || !Number.isFinite(revenueCents) || revenueCents <= 0) return null;
  return Math.round((laborCostCents / revenueCents) * 1000) / 10;
}
