/**
 * Pure helpers for the housekeeping Forecast view.
 *
 * Why this module exists separately from the API route:
 *   The gap-detection rules, honesty-label resolution, and date-range
 *   expansion are pure functions — no Supabase, no fetch, no timezone
 *   guesses in inline code paths. Keeping them here lets the unit tests
 *   exercise the rules directly (no mocks, no PG glue) and lets the
 *   route module focus on shape: validate query → fan-out reads →
 *   resolve labels → respond.
 *
 * NOTHING in here may do I/O. If you find yourself reaching for fetch
 * or supabase, that helper belongs in the route file.
 */

export const FORECAST_RANGES = ['today', 'week', '14day'] as const;
export type ForecastRange = typeof FORECAST_RANGES[number];

/**
 * Roles permitted to read the forecast endpoint + Forecast view.
 *
 * The forecast surfaces labor cost projections + scheduling guidance
 * that aren't appropriate for front-desk / housekeeping / maintenance
 * roles. Kept as a Set so the route handler can do a single .has() per
 * request and so the test can iterate the canonical AppRole list.
 *
 * Mirror src/lib/roles.ts canManageTeam(): both gate the same admin /
 * owner / general_manager tier. If you change one, change the other.
 */
const FORECAST_ALLOWED_ROLES: ReadonlySet<string> = new Set([
  'admin', 'owner', 'general_manager',
]);

export function canViewForecast(role: string | null | undefined): boolean {
  if (!role) return false;
  return FORECAST_ALLOWED_ROLES.has(role);
}

export type GapStatus = 'green' | 'yellow' | 'red';

export type AccuracyLabel =
  | 'ai_prediction'              // ≥ 30 days of cleaning history AND fitted model
  | 'industry_estimate_learning' // < 30 days history OR cold-start/warming-up
  | 'capacity_unavailable';      // ml-service didn't run / failed for this date

// Minimum number of recorded cleaning events before we trust a per-hotel
// model over the cohort prior. Mirrors the threshold the ml-service uses
// for its cold-start ramp; bumping this here without bumping there would
// produce a tile that says "industry estimate" while the model is in
// fact fitted (or vice versa). Source: ml-service training/_cold_start.py.
export const HISTORY_THRESHOLD_DAYS = 30;

// Per-housekeeper labor cost when staff.hourly_wage_cents isn't set yet.
// US BLS 2024 median for hotel housekeepers ≈ $14.60/hr — round to $14
// to err conservatively (a slight under-estimate is less alarming than
// an over-estimate on the projected labor line). The placeholder is
// surfaced honestly via accuracyLabel='wage_pending' so the GM knows
// the dollar figure isn't from their own payroll.
export const DEFAULT_HOURLY_WAGE_CENTS = 1400;

// Per-housekeeper shift cap. Fallback when properties.shift_minutes is
// unset. Mirrors the Schedule tab fallback in ScheduleTab.tsx so the
// two views agree on what "1 housekeeper's day" is worth in minutes.
export const DEFAULT_SHIFT_MINUTES = 420;

// Per-room cleaning minutes — checkout / stayover day 1 / stayover day
// 2+. Fallbacks when the property doesn't have its own values set.
// Mirror src/lib/calculations.ts so auto-assign and forecast agree.
export const DEFAULT_CHECKOUT_MINUTES = 30;
export const DEFAULT_STAYOVER_DAY1_MINUTES = 15;
export const DEFAULT_STAYOVER_DAY2_MINUTES = 20;

// Industry-benchmark deep-clean minutes per room. Limited-service
// hotels typically deep-clean each room once every 90 days; we don't
// yet have a per-property deep-clean schedule table on main, so the
// forecast omits deep cleans from the day rows but exposes the field
// in the response shape (zeroed) so the UI can render a column today
// and the cron can populate it once the schedule table lands.
export const DEFAULT_DEEP_CLEAN_MINUTES = 45;

// ─────────────────────────────────────────────────────────────────────
// Range → dates
// ─────────────────────────────────────────────────────────────────────

/**
 * Expand a forecast range into a list of YYYY-MM-DD dates, anchored to
 * the property's local "today". The anchor date is passed in (not
 * computed here) so callers control the timezone — getting that wrong
 * would land predictions on the wrong day in time zones west of UTC.
 *
 *   today → [todayStr]
 *   week  → [todayStr, +1, +2, +3, +4, +5, +6]    (rolling 7-day starting today)
 *   14day → [todayStr, +1, …, +13]                (rolling 14-day starting today)
 *
 * "Week" is intentionally NOT Monday-to-Sunday — the GM cares about
 * "the next 7 days" much more than calendar week boundaries. Anchoring
 * on today also keeps the summary banner sensible on a Friday afternoon
 * (you don't want it to say "0 days left this week").
 */
export function expandRange(anchor: string, range: ForecastRange): string[] {
  const days = range === 'today' ? 1 : range === 'week' ? 7 : 14;
  return Array.from({ length: days }, (_, i) => addDays(anchor, i));
}

/**
 * Add `n` days to a YYYY-MM-DD string. Works in UTC to avoid DST
 * surprises (a +1 across the spring-forward boundary would otherwise
 * cross a different ISO calendar day in some local times).
 */
export function addDays(yyyyMmDd: string, n: number): string {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`addDays: invalid date string "${yyyyMmDd}"`);
  }
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute "today" in a property's IANA timezone as a YYYY-MM-DD string.
 * Used by callers that don't have a property timezone handy (or that
 * legitimately want the server's local time). Default IANA tz is the
 * APP_TIMEZONE constant from utils.ts; this helper takes the tz as
 * its only arg so it stays pure.
 */
export function todayInTz(tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // en-CA yields YYYY-MM-DD with hyphens out of the box, sidestepping
  // toLocaleString's "M/D/YYYY" → re-parse dance that the older helpers
  // in ml-schedule-helpers.ts have to do.
  return fmt.format(new Date());
}

// ─────────────────────────────────────────────────────────────────────
// Gap detection
// ─────────────────────────────────────────────────────────────────────

export interface GapInputs {
  housekeepersScheduled: number;
  housekeepersRecommended: number;
}

/**
 * Severity of the "is this day understaffed?" check.
 *
 * Rules (per the product spec — keep in sync with the ForecastView
 * legend so the badge and the tooltip never disagree):
 *   green  — scheduled ≥ recommended                 (fully covered)
 *   yellow — scheduled == recommended − 1            (exactly one short)
 *   red    — scheduled ≤ recommended − 2             (two or more short)
 *
 * Negative or non-integer inputs are clamped to 0 — defensive against
 * a Supabase row landing with NULL → null → undefined → NaN through
 * the JSON path. We'd rather render "green" for a missing row than
 * crash the day card.
 */
export function classifyGap(input: GapInputs): GapStatus {
  const scheduled = sanitizeNonNeg(input.housekeepersScheduled);
  const recommended = sanitizeNonNeg(input.housekeepersRecommended);
  if (scheduled >= recommended) return 'green';
  if (scheduled === recommended - 1) return 'yellow';
  return 'red';
}

function sanitizeNonNeg(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

// ─────────────────────────────────────────────────────────────────────
// Honesty label
// ─────────────────────────────────────────────────────────────────────

export interface LabelInputs {
  /** Days since the property's first recorded cleaning event. null when none. */
  historyDays: number | null;
  /**
   * Whether the ml-service ran successfully for this date and the row
   * (optimizer_results or demand_predictions) is present. False means
   * the cron either hasn't run yet or the model is unavailable for
   * this property × date.
   */
  predictionAvailable: boolean;
  /**
   * Optional: derived from optimizer_results.inputs_snapshot. When
   * 'fitted' we promote to "AI prediction" only if we ALSO have ≥
   * HISTORY_THRESHOLD_DAYS of cleaning events. A fitted model with
   * only 12 days of history is still warming up — better to label it
   * conservatively than to oversell.
   */
  modelKind?: 'fitted' | 'warming-up' | 'capacity-unavailable' | null;
}

/**
 * Resolve the honest accuracy label for one day's forecast row.
 *
 * Priority order (most-specific first):
 *   1. predictionAvailable=false  → 'capacity_unavailable'
 *   2. modelKind=capacity-unavail → 'capacity_unavailable'
 *   3. modelKind=warming-up       → 'industry_estimate_learning'
 *   4. historyDays < threshold    → 'industry_estimate_learning'
 *   5. historyDays null            → 'industry_estimate_learning' (treat unknown as "learning")
 *   6. otherwise (fitted + ≥30d)  → 'ai_prediction'
 *
 * The asymmetry between "fitted with 12 days history" and "fitted with
 * 60 days history" is deliberate: the ml-service can mark a row as
 * "fitted" the moment quantile regression returns valid params, even
 * if only 12 days of events backed the fit. The product line we want
 * to hold is: don't tell the GM "AI prediction" until there's enough
 * of THEIR data behind it. The cohort-prior fallback (the "industry
 * benchmark") covers the gap.
 */
export function resolveAccuracyLabel(input: LabelInputs): AccuracyLabel {
  if (!input.predictionAvailable) return 'capacity_unavailable';
  if (input.modelKind === 'capacity-unavailable') return 'capacity_unavailable';
  if (input.modelKind === 'warming-up') return 'industry_estimate_learning';
  if (input.historyDays === null) return 'industry_estimate_learning';
  if (input.historyDays < HISTORY_THRESHOLD_DAYS) return 'industry_estimate_learning';
  return 'ai_prediction';
}

// ─────────────────────────────────────────────────────────────────────
// Cleaning-minute math
// ─────────────────────────────────────────────────────────────────────

export interface CleaningMinuteInputs {
  departures: number;
  stayoversLight: number;
  stayoversFull: number;
  deepCleans: number;
  /** Property override; falls back to DEFAULT_CHECKOUT_MINUTES. */
  checkoutMinutes?: number | null;
  stayoverDay1Minutes?: number | null;
  stayoverDay2Minutes?: number | null;
  deepCleanMinutes?: number | null;
}

/**
 * Total cleaning minutes for one day's mix of rooms. Mirrors the math
 * in ScheduleTab.tsx so the Forecast row "hours needed" matches what
 * Maria sees on the live Kanban for today's date — if these two ever
 * disagree, she'll trust the visible one and ignore the forecast.
 */
export function totalCleaningMinutes(input: CleaningMinuteInputs): number {
  const ck = positiveOr(input.checkoutMinutes, DEFAULT_CHECKOUT_MINUTES);
  const so1 = positiveOr(input.stayoverDay1Minutes, DEFAULT_STAYOVER_DAY1_MINUTES);
  const so2 = positiveOr(input.stayoverDay2Minutes, DEFAULT_STAYOVER_DAY2_MINUTES);
  const dc = positiveOr(input.deepCleanMinutes, DEFAULT_DEEP_CLEAN_MINUTES);
  return (
    Math.max(0, Math.floor(input.departures)) * ck
    + Math.max(0, Math.floor(input.stayoversLight)) * so1
    + Math.max(0, Math.floor(input.stayoversFull)) * so2
    + Math.max(0, Math.floor(input.deepCleans)) * dc
  );
}

function positiveOr(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

// ─────────────────────────────────────────────────────────────────────
// Recommended headcount fallback
// ─────────────────────────────────────────────────────────────────────

export interface HeadcountInputs {
  totalCleaningMinutes: number;
  shiftMinutes: number | null;
  /** If the optimizer ran for this date, use its number directly. */
  optimizerRecommendation: number | null;
}

/**
 * Recommended housekeeper count for a day.
 *
 * If the optimizer ran, trust it (it accounts for the completion-
 * probability target the property is configured for). Otherwise fall
 * back to a deterministic ceiling of total-minutes / shift-cap, +1 for
 * the dedicated laundry/runner. Matches ScheduleTab's recommendedHKs
 * formula so the two views agree when the optimizer is silent.
 *
 * Clamped to ≥1 so a quiet day still reports "1 HK" rather than 0 —
 * even an empty hotel needs someone on property to handle exceptions.
 */
export function recommendedHeadcount(input: HeadcountInputs): number {
  if (
    input.optimizerRecommendation !== null
    && Number.isFinite(input.optimizerRecommendation)
    && input.optimizerRecommendation >= 1
  ) {
    return Math.max(1, Math.round(input.optimizerRecommendation));
  }
  const shift = positiveOr(input.shiftMinutes, DEFAULT_SHIFT_MINUTES);
  const cleaning = Math.max(0, Math.floor(input.totalCleaningMinutes));
  const cleaningCrew = Math.ceil(cleaning / shift);
  return Math.max(1, cleaningCrew) + 1; // +1 for laundry / runner
}

// ─────────────────────────────────────────────────────────────────────
// Labor cost projection
// ─────────────────────────────────────────────────────────────────────

export interface LaborCostInputs {
  /**
   * Wages (in cents) for the staff actually scheduled this day. A null
   * entry means that scheduled person has no wage on file. Length of
   * the array IS the per-day scheduled headcount — passing an empty
   * array means nobody scheduled.
   *
   * Codex audit Major #3: the prior shape passed a single
   * `hourlyWageCents` plus a scheduled count, which silently averaged
   * across SET wages even when scheduled staff lacked wages. Per-staff
   * granularity here is the only way to honestly raise `wagePending`
   * for a day where any scheduled person has no wage on file.
   */
  scheduledWagesCents: Array<number | null>;
  shiftMinutes: number | null;
}

/**
 * Projected labor cost for one day, in cents.
 *
 * For each scheduled person, use their wage if set; otherwise fall
 * back to DEFAULT_HOURLY_WAGE_CENTS. wagePending is true when ANY
 * scheduled person lacks a wage — that's the signal the GM needs to
 * know the projected cost mixes payroll-grade and benchmark numbers.
 */
export function projectLaborCents(input: LaborCostInputs): {
  cents: number;
  wagePending: boolean;
} {
  const shift = positiveOr(input.shiftMinutes, DEFAULT_SHIFT_MINUTES);
  const hours = shift / 60;
  let cents = 0;
  let pending = false;
  for (const wage of input.scheduledWagesCents) {
    const valid =
      typeof wage === 'number' && Number.isFinite(wage) && wage > 0;
    if (!valid) pending = true;
    cents += Math.round(hours * (valid ? wage : DEFAULT_HOURLY_WAGE_CENTS));
  }
  return { cents, wagePending: pending };
}

// ─────────────────────────────────────────────────────────────────────
// Range-level summary
// ─────────────────────────────────────────────────────────────────────

export interface DaySummary {
  totalMinutesNeeded: number;
  housekeepersScheduled: number;
  housekeepersRecommended: number;
  shiftMinutes: number | null;
  gapStatus: GapStatus;
}

export interface RangeSummary {
  totalMinutesNeeded: number;
  totalHoursScheduled: number;
  gapHours: number;
  understaffedDayCount: number;
}

/**
 * Roll up the per-day rows into the one-line banner. Hours scheduled
 * is computed from the actual headcount × the per-day shift cap, NOT
 * from the recommended number — Maria needs to see "what we have"
 * vs. "what we need", not "what we should have wanted".
 */
export function summarizeRange(days: DaySummary[]): RangeSummary {
  let totalMinutesNeeded = 0;
  let totalMinutesScheduled = 0;
  let understaffedDayCount = 0;
  for (const d of days) {
    const shift = positiveOr(d.shiftMinutes, DEFAULT_SHIFT_MINUTES);
    totalMinutesNeeded += Math.max(0, d.totalMinutesNeeded);
    totalMinutesScheduled += sanitizeNonNeg(d.housekeepersScheduled) * shift;
    if (d.gapStatus === 'red') understaffedDayCount += 1;
  }
  const totalHoursNeeded = totalMinutesNeeded / 60;
  const totalHoursScheduled = totalMinutesScheduled / 60;
  return {
    totalMinutesNeeded,
    totalHoursScheduled: round1(totalHoursScheduled),
    gapHours: round1(Math.max(0, totalHoursNeeded - totalHoursScheduled)),
    understaffedDayCount,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
