/**
 * GET /api/housekeeping/forecast?propertyId=…&range=today|week|14day
 *
 * Returns a forward-looking forecast for the Schedule tab's Forecast
 * view: per-day departures, stayovers, cleaning minutes needed,
 * scheduled vs recommended housekeeper count, projected labor cost,
 * and an honest accuracy label per row.
 *
 * Why a single multi-day endpoint vs N single-day calls:
 *   - The day cards in ForecastView all render together. Issuing 14
 *     parallel single-day requests would hammer rate limits and force
 *     the UI to deal with 14 separate loading states.
 *   - Each day's reads (pms_reservations, demand_predictions,
 *     optimizer_results, scheduled_shifts) are dominated by the
 *     property-scope filter + a date `in (…)` clause. Batching them
 *     turns the request into a fixed handful of round-trips regardless
 *     of range length.
 *
 * Data sources (all RLS-locked; service-role reads):
 *   - pms_reservations             → departures / arrivals / stayovers per day
 *   - pms_rooms_inventory          → total room count (used for stayover math)
 *   - demand_predictions           → predicted_minutes_p50 + headcount band
 *   - optimizer_results            → recommended_headcount + inputs_snapshot
 *   - scheduled_shifts             → who's actually scheduled per day
 *   - staff                        → wage data (when set; falls back to default)
 *   - cleaning_events (min date)    → drives the honesty label
 *   - properties                    → timezone, shift_minutes, cleaning minutes
 *
 * Auth:
 *   - requireSession + 2FA enforcement (default)
 *   - userHasPropertyAccess for tenant scope
 *   - Manager-tier role gate (admin / owner / general_manager). The
 *     forecast surfaces labor cost projections — front-desk and
 *     housekeeping roles don't need that.
 *
 * Rate limit: 60/hr per (userId, propertyId). Manager opens the tab,
 * switches ranges, leaves it polling — well above realistic ops use.
 *
 * Graceful degrade:
 *   - Any prediction table missing for this date → that day is
 *     labeled 'capacity_unavailable' and the recommended headcount
 *     falls back to the deterministic formula (minutes / shift + 1).
 *   - ml-service down / no row written → same fallback. The forecast
 *     NEVER 500s on a missing prediction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, userHasPropertyAccess } from '@/lib/api-auth';
import { ok, err, ApiErrorCode } from '@/lib/api-response';
import { getOrMintRequestId, log } from '@/lib/log';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { validateUuid, validateEnum } from '@/lib/api-validate';
import {
  checkAndIncrementRateLimit,
  rateLimitedResponse,
  hashToRateLimitKey,
} from '@/lib/api-ratelimit';
import {
  expandRange,
  todayInTz,
  classifyGap,
  resolveAccuracyLabel,
  totalCleaningMinutes,
  recommendedHeadcount,
  projectLaborCents,
  summarizeRange,
  canViewForecast,
  HISTORY_THRESHOLD_DAYS,
  DEFAULT_SHIFT_MINUTES,
  type AccuracyLabel,
  type DaySummary,
  type ForecastRange,
  type GapStatus,
} from '@/lib/forecast';
import {
  parseInputsSnapshot,
  deriveModelKind,
  type OptimizerModelKind,
} from '@/lib/ml-schedule-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_RANGES: readonly ForecastRange[] = ['today', 'week', '14day'];

interface PropertyRow {
  id: string;
  timezone: string | null;
  shift_minutes: number | null;
  checkout_minutes: number | null;
  stayover_day1_minutes: number | null;
  stayover_day2_minutes: number | null;
}

interface ReservationRow {
  arrival_date: string | null;
  departure_date: string | null;
  status: string | null;
}

interface DemandPredictionRow {
  date: string;
  predicted_minutes_p50: number | null;
  predicted_headcount_p80: number | null;
  predicted_headcount_p95: number | null;
}

interface OptimizerResultRow {
  date: string;
  recommended_headcount: number;
  inputs_snapshot: unknown;
}

interface ScheduledShiftRow {
  shift_date: string;
  staff_id: string | null;
  status: string;
}

interface StaffWageRow {
  id: string;
  /**
   * Stored as numeric dollars on main today (staff.hourly_wage). The
   * cost-tracking branch is adding a per-staff hourly_wage_cents
   * column. Until that lands we convert dollars→cents in code; when
   * it does land we'd flip to reading the cents column directly.
   */
  hourly_wage: number | null;
}

interface DayPayload {
  date: string;
  departures: number;
  stayovers_light: number;
  stayovers_full: number;
  deep_cleans: number;
  total_minutes_needed: number;
  housekeepers_scheduled: number;
  housekeepers_recommended: number;
  projected_labor_cents: number;
  wage_pending: boolean;
  gap_status: GapStatus;
  accuracy_label: AccuracyLabel;
  model_kind: OptimizerModelKind | null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = getOrMintRequestId(req);
  const auth = await requireSession(req, { requestId });
  if (!auth.ok) return auth.response;

  try {
    const url = new URL(req.url);
    const pidRaw = url.searchParams.get('propertyId');
    const rangeRaw = url.searchParams.get('range');

    const pidCheck = validateUuid(pidRaw, 'propertyId');
    if (pidCheck.error) {
      return err(pidCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const rangeCheck = validateEnum(rangeRaw, ALLOWED_RANGES, 'range');
    if (rangeCheck.error) {
      return err(rangeCheck.error, { requestId, status: 400, code: ApiErrorCode.ValidationFailed });
    }
    const propertyId = pidCheck.value!;
    const range = rangeCheck.value!;

    // Tenant scope — confirm the caller has access. Without this any
    // signed-in manager could pull any hotel's forecast by spraying
    // propertyIds.
    const hasAccess = await userHasPropertyAccess(auth.userId, propertyId);
    if (!hasAccess) {
      log.warn('forecast: forbidden — user lacks property access', {
        requestId, userId: auth.userId, propertyId,
      });
      return err('forbidden — no access to this property', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    // Role gate — manager / GM / owner only. The forecast surfaces labor
    // cost projections that aren't appropriate for housekeeping or
    // front-desk roles.
    const { data: accountRow, error: accountErr } = await supabaseAdmin
      .from('accounts')
      .select('role')
      .eq('data_user_id', auth.userId)
      .maybeSingle();
    if (accountErr) {
      log.error('forecast: accounts lookup failed', { requestId, msg: accountErr.message });
      return err('account lookup failed', {
        requestId, status: 500, code: ApiErrorCode.UpstreamFailure,
      });
    }
    const role = (accountRow?.role as string | undefined) ?? '';
    if (!canViewForecast(role)) {
      log.warn('forecast: forbidden — role not permitted', {
        requestId, userId: auth.userId, role,
      });
      return err('forbidden — role does not have forecast access', {
        requestId, status: 403, code: ApiErrorCode.Forbidden,
      });
    }

    // Rate limit (60/hr per user × property). hashToRateLimitKey
    // produces a UUID-shaped digest so the same api_limits.property_id
    // column can hold either a real property UUID or a composite key.
    const rateKey = hashToRateLimitKey(`${auth.userId}:${propertyId}`);
    const rate = await checkAndIncrementRateLimit('housekeeping-forecast', rateKey);
    if (!rate.allowed) {
      return rateLimitedResponse(rate.current, rate.cap, rate.retryAfterSec);
    }

    // Property metadata for timezone + cleaning-minute fallbacks.
    const { data: propRow, error: propErr } = await supabaseAdmin
      .from('properties')
      .select(
        'id, timezone, shift_minutes, ' +
        'checkout_minutes, stayover_day1_minutes, stayover_day2_minutes',
      )
      .eq('id', propertyId)
      .maybeSingle<PropertyRow>();
    if (propErr) {
      log.error('forecast: property load failed', { requestId, msg: propErr.message });
      return err('property load failed', {
        requestId, status: 500, code: ApiErrorCode.UpstreamFailure,
      });
    }
    if (!propRow) {
      return err('property not found', {
        requestId, status: 404, code: ApiErrorCode.NotFound,
      });
    }
    const timezone = propRow.timezone || 'America/Chicago';
    const today = todayInTz(timezone);
    const dates = expandRange(today, range);
    const rangeStart = dates[0];
    const rangeEnd = dates[dates.length - 1];

    // ── Parallel reads ────────────────────────────────────────────────
    // All five reads are independent (none depends on another's result)
    // so issue them in parallel — turns the route into one round-trip
    // worth of latency rather than five sequential ones.
    const [
      reservationsRes,
      demandRes,
      optimizerRes,
      shiftsRes,
      staffRes,
      historyRes,
    ] = await Promise.all([
      // 1. Reservations spanning the range. Filter loosely — anything
      //    that could overlap a date in the range. The day-by-day
      //    bucketing happens in-memory below.
      supabaseAdmin
        .from('pms_reservations')
        .select('arrival_date, departure_date, status')
        .eq('property_id', propertyId)
        .or(
          `and(arrival_date.gte.${rangeStart},arrival_date.lte.${rangeEnd}),` +
          `and(departure_date.gte.${rangeStart},departure_date.lte.${rangeEnd}),` +
          `and(arrival_date.lte.${rangeStart},departure_date.gte.${rangeEnd})`,
        )
        .returns<ReservationRow[]>(),

      // 2. Demand predictions for each date in the range.
      supabaseAdmin
        .from('demand_predictions')
        .select('date, predicted_minutes_p50, predicted_headcount_p80, predicted_headcount_p95')
        .eq('property_id', propertyId)
        .in('date', dates)
        .returns<DemandPredictionRow[]>(),

      // 3. Optimizer recommendations + kind metadata.
      supabaseAdmin
        .from('optimizer_results')
        .select('date, recommended_headcount, inputs_snapshot')
        .eq('property_id', propertyId)
        .in('date', dates)
        .returns<OptimizerResultRow[]>(),

      // 4. Scheduled shifts (housekeeping only) for each date.
      supabaseAdmin
        .from('scheduled_shifts')
        .select('shift_date, staff_id, status')
        .eq('property_id', propertyId)
        .eq('department', 'housekeeping')
        .in('shift_date', dates)
        .neq('status', 'declined')
        .returns<ScheduledShiftRow[]>(),

      // 5. Staff wage rows. Reads the per-staff hourly_wage (numeric
      //    dollars) that's been on main since the initial schema. The
      //    cost-tracking branch is adding a more granular
      //    hourly_wage_cents — until that lands we convert dollars→
      //    cents in code below. Null wages cleanly fall back to the
      //    DEFAULT_HOURLY_WAGE_CENTS placeholder.
      supabaseAdmin
        .from('staff')
        .select('id, hourly_wage')
        .eq('property_id', propertyId)
        .eq('department', 'housekeeping')
        .eq('is_active', true)
        .returns<StaffWageRow[]>(),

      // 6. History days — the date of the property's earliest cleaning
      //    event. Drives the honesty label.
      supabaseAdmin
        .from('cleaning_events')
        .select('date')
        .eq('property_id', propertyId)
        .order('date', { ascending: true })
        .limit(1),
    ]);

    // Wrap each read with a posture appropriate to the table's
    // criticality. Codex audit (Major — additional finding): silently
    // degrading pms_reservations to [] produced a forecast that read
    // "tomorrow is empty" when actually the reservations table was
    // momentarily unavailable. Operational tables hard-fail; ML +
    // optional tables soft-degrade.
    if (reservationsRes.error) {
      log.error('forecast: pms_reservations read failed — failing hard', {
        requestId, msg: reservationsRes.error.message,
      });
      return err('reservation data unavailable', {
        requestId, status: 502, code: ApiErrorCode.UpstreamFailure,
      });
    }
    const reservations: ReservationRow[] = (reservationsRes.data ?? []) as ReservationRow[];

    const demand: DemandPredictionRow[] = unwrap(demandRes, 'demand_predictions', requestId);
    const optimizer: OptimizerResultRow[] = unwrap(optimizerRes, 'optimizer_results', requestId);
    const shifts: ScheduledShiftRow[] = unwrap(shiftsRes, 'scheduled_shifts', requestId);
    const wageRows: StaffWageRow[] = unwrap(staffRes, 'staff', requestId);
    const historyRows = (historyRes.data ?? []) as Array<{ date: string }>;
    if (historyRes.error) {
      log.warn('forecast: cleaning_events load failed; treating as no history', {
        requestId, msg: historyRes.error.message,
      });
    }

    // History days for the honesty label. Treat "no events recorded"
    // as null (→ industry_estimate_learning) rather than 0 (→ same
    // label, but more explicit about WHY).
    const firstEventDate = historyRows[0]?.date ?? null;
    const historyDays = firstEventDate ? dayDiff(firstEventDate, today) : null;

    // Per-staff wage map (cents). Codex audit Major #3: the prior
    // code averaged set wages across ALL staff and reused that single
    // average for every day — which hid the gap when scheduled staff
    // actually lacked wages. Now we look up each scheduled staff's
    // wage at projection time and flag wage_pending per day.
    // staff.hourly_wage is numeric dollars on main today; the cost-
    // tracking branch is adding a finer-grained hourly_wage_cents.
    // Until that lands we convert dollars → cents here (×100).
    const wageByStaffId = new Map<string, number | null>();
    for (const row of wageRows) {
      const dollars = row.hourly_wage;
      const valid = typeof dollars === 'number' && Number.isFinite(dollars) && dollars > 0;
      wageByStaffId.set(row.id, valid ? Math.round(dollars * 100) : null);
    }
    const anyStaffWageUnset = wageRows.some(r => {
      const d = r.hourly_wage;
      return !(typeof d === 'number' && Number.isFinite(d) && d > 0);
    });

    // Index reads by date for O(1) per-day lookups.
    const demandByDate = new Map<string, DemandPredictionRow>();
    for (const d of demand) demandByDate.set(d.date, d);
    const optimizerByDate = new Map<string, OptimizerResultRow>();
    for (const o of optimizer) optimizerByDate.set(o.date, o);

    // Scheduled headcount per date. Distinct staff_ids only — the
    // table can carry both an 'open' slot row and an 'assigned' row
    // per (date, staff) when an open shift gets filled, and counting
    // both would double-credit.
    const scheduledByDate = new Map<string, Set<string>>();
    for (const s of shifts) {
      if (!s.staff_id) continue;
      let set = scheduledByDate.get(s.shift_date);
      if (!set) {
        set = new Set();
        scheduledByDate.set(s.shift_date, set);
      }
      set.add(s.staff_id);
    }

    // ── Per-day buckets ───────────────────────────────────────────────
    // Bucket reservations into departures + new arrivals per date, and
    // count stayovers from "overlaps but neither arrives nor departs
    // here". Stayovers split into day-1 light vs day-2+ full based on
    // how many nights into the stay the day falls.
    const departuresByDate = new Map<string, number>();
    const arrivalsByDate = new Map<string, number>();
    const stayoversLightByDate = new Map<string, number>();
    const stayoversFullByDate = new Map<string, number>();
    const isCancelled = (r: ReservationRow) =>
      r.status === 'cancelled' || r.status === 'no_show';

    for (const d of dates) {
      departuresByDate.set(d, 0);
      arrivalsByDate.set(d, 0);
      stayoversLightByDate.set(d, 0);
      stayoversFullByDate.set(d, 0);
    }

    for (const r of reservations) {
      if (isCancelled(r)) continue;
      if (r.departure_date && departuresByDate.has(r.departure_date)) {
        departuresByDate.set(
          r.departure_date,
          (departuresByDate.get(r.departure_date) ?? 0) + 1,
        );
      }
      if (r.arrival_date && arrivalsByDate.has(r.arrival_date)) {
        arrivalsByDate.set(
          r.arrival_date,
          (arrivalsByDate.get(r.arrival_date) ?? 0) + 1,
        );
      }
      // Stayovers: arrival < date < departure → guest is in-house but
      // not arriving or departing today. Split light/full by how many
      // nights they've already stayed (Day 1 = light Day 2+ = full).
      if (!r.arrival_date || !r.departure_date) continue;
      for (const d of dates) {
        if (d <= r.arrival_date) continue;
        if (d >= r.departure_date) continue;
        const nightsSoFar = dayDiff(r.arrival_date, d);
        if (nightsSoFar === 1) {
          stayoversLightByDate.set(d, (stayoversLightByDate.get(d) ?? 0) + 1);
        } else if (nightsSoFar >= 2) {
          stayoversFullByDate.set(d, (stayoversFullByDate.get(d) ?? 0) + 1);
        }
      }
    }

    // ── Compose per-day rows ──────────────────────────────────────────
    const dayRows: DayPayload[] = dates.map((date) => {
      const departures = departuresByDate.get(date) ?? 0;
      const stayoversLight = stayoversLightByDate.get(date) ?? 0;
      const stayoversFull = stayoversFullByDate.get(date) ?? 0;
      const deepCleans = 0; // see DEFAULT_DEEP_CLEAN_MINUTES doc — schedule table not yet on main

      const minutesNeeded = totalCleaningMinutes({
        departures,
        stayoversLight,
        stayoversFull,
        deepCleans,
        checkoutMinutes: propRow.checkout_minutes,
        stayoverDay1Minutes: propRow.stayover_day1_minutes,
        stayoverDay2Minutes: propRow.stayover_day2_minutes,
      });

      const opt = optimizerByDate.get(date);
      const dem = demandByDate.get(date);
      const optimizerRecommendation = opt ? opt.recommended_headcount : null;

      const recommended = recommendedHeadcount({
        totalCleaningMinutes: minutesNeeded,
        shiftMinutes: propRow.shift_minutes,
        optimizerRecommendation,
      });

      const scheduledSet = scheduledByDate.get(date);
      const housekeepersScheduled = scheduledSet ? scheduledSet.size : 0;

      const gapStatus = classifyGap({
        housekeepersScheduled,
        housekeepersRecommended: recommended,
      });

      // Look up each scheduled staff member's wage. Missing wage →
      // null entry, which trips wage_pending and falls back to the
      // industry-benchmark cents constant inside projectLaborCents.
      const scheduledWagesCents: Array<number | null> = scheduledSet
        ? Array.from(scheduledSet, sid => wageByStaffId.get(sid) ?? null)
        : [];
      const laborProjection = projectLaborCents({
        scheduledWagesCents,
        shiftMinutes: propRow.shift_minutes,
      });

      // ml-service model kind, when the optimizer row is present.
      let modelKind: OptimizerModelKind | null = null;
      if (opt) {
        const snap = parseInputsSnapshot(opt.inputs_snapshot);
        modelKind = deriveModelKind(snap).modelKind;
      }

      const accuracyLabel = resolveAccuracyLabel({
        historyDays,
        // The optimizer_results row is the canonical source for the
        // recommended-headcount tile. demand_predictions alone is a
        // partial state (cron mid-flight: demand written, optimizer
        // not yet). Codex audit Major #4 — without this tightening
        // a partial state would render "AI prediction" while the
        // recommendation silently fell back to the deterministic
        // formula. Tying availability to `opt` keeps the label honest:
        // if the optimizer hasn't published a row, the day is labeled
        // capacity_unavailable.
        predictionAvailable: Boolean(opt),
        modelKind,
      });

      return {
        date,
        departures,
        stayovers_light: stayoversLight,
        stayovers_full: stayoversFull,
        deep_cleans: deepCleans,
        total_minutes_needed: minutesNeeded,
        housekeepers_scheduled: housekeepersScheduled,
        housekeepers_recommended: recommended,
        projected_labor_cents: laborProjection.cents,
        wage_pending: laborProjection.wagePending,
        gap_status: gapStatus,
        accuracy_label: accuracyLabel,
        model_kind: modelKind,
      };
    });

    // Range summary — feeds the banner at the top of the view.
    const daySummaries: DaySummary[] = dayRows.map(d => ({
      totalMinutesNeeded: d.total_minutes_needed,
      housekeepersScheduled: d.housekeepers_scheduled,
      housekeepersRecommended: d.housekeepers_recommended,
      shiftMinutes: propRow.shift_minutes,
      gapStatus: d.gap_status,
    }));
    const summary = summarizeRange(daySummaries);

    return ok(
      {
        range,
        timezone,
        today,
        history_days: historyDays,
        history_threshold_days: HISTORY_THRESHOLD_DAYS,
        shift_minutes: propRow.shift_minutes ?? DEFAULT_SHIFT_MINUTES,
        // Top-level signal: at least one active housekeeper is missing
        // a wage. The UI uses this to surface a roster-level "fill in
        // wages for the rest of your crew" prompt independent of
        // whether any given day's scheduled staff happens to lack one.
        wage_pending_roster: anyStaffWageUnset,
        summary: {
          total_minutes_needed: summary.totalMinutesNeeded,
          total_hours_scheduled: summary.totalHoursScheduled,
          gap_hours: summary.gapHours,
          understaffed_day_count: summary.understaffedDayCount,
        },
        days: dayRows,
      },
      { requestId },
    );
  } catch (e) {
    log.error('forecast: unexpected error', {
      requestId,
      err: e instanceof Error ? e : new Error(String(e)),
    });
    return err('forecast failed', {
      requestId, status: 500, code: ApiErrorCode.InternalError,
    });
  }
}

/**
 * Unwrap a Supabase read result, treating "table missing" or "column
 * missing" errors as empty arrays (graceful degrade) and warning on
 * unexpected errors so they show up in Sentry without 500ing the route.
 *
 * This is the same posture as /api/housekeeping/timeline — better to
 * render an honest empty state than a 500 when a freshly-onboarded
 * hotel hasn't had its first ml-service cron run yet.
 */
function unwrap<T>(
  res: { data: T[] | null; error: { message: string } | null },
  label: string,
  requestId: string,
): T[] {
  if (res.error) {
    log.warn(`forecast: ${label} read failed; degrading to empty`, {
      requestId, msg: res.error.message,
    });
    return [];
  }
  return (res.data ?? []) as T[];
}

/**
 * Whole-day difference between two YYYY-MM-DD strings, computed in UTC
 * to avoid DST surprises. Returns `b - a` in days; negative if b < a.
 */
function dayDiff(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00.000Z`).getTime()
           - new Date(`${a}T00:00:00.000Z`).getTime();
  return Math.round(ms / 86_400_000);
}
