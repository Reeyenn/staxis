/**
 * Build the daily report payload for one property + one business date.
 *
 * Owns the I/O for the daily report: queries cleaning_tasks, hk_assignments,
 * inspections, pms_work_orders_v2, pms_reservations, pms_in_house_snapshot,
 * staff, callout_events. Then hands the rows to the pure aggregators in
 * `aggregate.ts` and the anomaly detector in `anomaly-detector.ts`.
 *
 * The cron route imports `buildDailyReport(propertyId, reportDate)` and
 * gets back a finished DailyReportPayload ready to feed the email template.
 *
 * Property-local time semantics:
 *   - `reportDate` is a property-local YYYY-MM-DD string (e.g. 2026-05-23).
 *   - "Today's tasks" = cleaning_tasks where business_date = reportDate.
 *     business_date is already property-local in the schema.
 *   - "Today's work orders" = reported_at falls on reportDate in the
 *     property's timezone (we filter in JS via isoDateInTz).
 *   - "Tomorrow" = reportDate + 1 day in property-local time.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { captureException } from '@/lib/sentry';
import { log } from '@/lib/log';
import { resolveMlShardUrl } from '@/lib/ml-routing';
import {
  buildIssuesBlock,
  buildLaborBlock,
  buildOperationsBlock,
  buildQualityBlock,
  isoDateInTz,
  localMidnightToUtc,
  rankStaffPerformance,
  type CleaningTaskRow,
  type HkAssignmentRow,
  type InHouseSnapshot,
  type InspectionRow,
  type StaffRow,
  type CalloutRow,
  type WorkOrderRow,
} from './aggregate';
import { detectAnomalies, type DailyBaselineSlice } from './anomaly-detector';
import type { DailyReportPayload, TomorrowOutlookBlock } from './types';

const DEFAULT_DASHBOARD_BASE = 'https://getstaxis.com';

interface PropertyContext {
  id: string;
  name: string;
  timezone: string;
  totalRooms: number;
  weeklyBudgetCents: number | null;
}

async function loadProperty(propertyId: string): Promise<PropertyContext | null> {
  // Read both the new cents columns (migration 0229) and the legacy
  // dollar column. Cost-tracking writes only the cents column; the
  // weekly_budget dollar column stays for properties whose owner
  // hasn't touched the new settings UI yet.
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone, total_rooms, weekly_budget, weekly_labor_budget_cents')
    .eq('id', propertyId)
    .maybeSingle();
  if (error || !data) {
    log.error('[daily-report] property load failed', { propertyId, err: error?.message });
    return null;
  }
  let weeklyBudgetCents: number | null = null;
  if (data.weekly_labor_budget_cents !== null && data.weekly_labor_budget_cents !== undefined) {
    weeklyBudgetCents = Number(data.weekly_labor_budget_cents);
  } else if (data.weekly_budget !== null && data.weekly_budget !== undefined) {
    weeklyBudgetCents = Math.round(Number(data.weekly_budget) * 100);
  }
  return {
    id: data.id,
    name: data.name,
    timezone: data.timezone ?? 'UTC',
    totalRooms: Number(data.total_rooms ?? 0),
    weeklyBudgetCents,
  };
}

/**
 * Advance reportDate by one day, in property-local time. Used to compute
 * "tomorrow" for the outlook block. We just add 86400s because business
 * dates don't have DST gaps (a 23h day still rolls to the next date).
 */
function nextDayLocal(reportDate: string): string {
  const [y, m, d] = reportDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * Compute the "tomorrow" outlook block from reservations + recommended
 * headcount. Reads pms_reservations directly; recommendedHeadcount comes
 * from the ml-service (HTTP) if reachable, otherwise null.
 */
async function buildTomorrowOutlook(args: {
  property: PropertyContext;
  reportDate: string;
}): Promise<TomorrowOutlookBlock> {
  const { property, reportDate } = args;
  const tomorrow = nextDayLocal(reportDate);

  const [{ data: arrivalsRows }, { data: departuresRows }] = await Promise.all([
    supabaseAdmin
      .from('pms_reservations')
      .select('id, status')
      .eq('property_id', property.id)
      .eq('arrival_date', tomorrow),
    supabaseAdmin
      .from('pms_reservations')
      .select('id, status')
      .eq('property_id', property.id)
      .eq('departure_date', tomorrow),
  ]);

  const arrivals = (arrivalsRows ?? []).filter(r => r.status !== 'cancelled' && r.status !== 'no_show').length;
  const departures = (departuresRows ?? []).filter(r => r.status !== 'cancelled' && r.status !== 'no_show').length;
  // Projected rooms to clean tomorrow ≈ tomorrow's departures + some
  // share of stayovers (we don't have a clean stayover-vs-arrivals split
  // until the engine runs tomorrow morning; the simple proxy is good
  // enough for the outlook).
  const projectedRoomsToClean = departures + Math.max(0, arrivals - departures);

  // Optional ML headcount call. If the service is reachable, we hit it.
  // Failure modes are all soft — null bubbles through. Routes through
  // the shared shard resolver so we honor multi-shard ML_SERVICE_URLS.
  let recommendedHeadcount: number | null = null;
  let recommendedLaborCostCents: number | null = null;
  try {
    const mlUrl = resolveMlShardUrl(property.id)?.replace(/\/+$/, '');
    if (mlUrl) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4_000);
      try {
        const res = await fetch(`${mlUrl}/predict/headcount?property_id=${property.id}&date=${tomorrow}`, {
          signal: ac.signal,
          headers: { 'accept': 'application/json' },
        });
        if (res.ok) {
          const body = await res.json() as { headcount?: number; labor_cost_cents?: number };
          if (typeof body.headcount === 'number') recommendedHeadcount = body.headcount;
          if (typeof body.labor_cost_cents === 'number') recommendedLaborCostCents = body.labor_cost_cents;
        }
      } finally {
        clearTimeout(t);
      }
    }
  } catch {
    // ml-service unreachable. Null bubbles through; outlook still renders.
  }

  // Pending OOO / inspection at end-of-day — read the current state.
  const { data: pendingOoo } = await supabaseAdmin
    .from('pms_work_orders_v2')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', property.id)
    .eq('out_of_order', true)
    .in('status', ['open', 'in_progress']);
  const { data: pendingInspection } = await supabaseAdmin
    .from('cleaning_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('property_id', property.id)
    .eq('business_date', reportDate)
    .eq('status', 'inspection_pending');
  // The count comes back on the response object via head:true, but the
  // typed wrapper hides it — fall through to a select length if we can't
  // read it cleanly.
  const ooCount = (pendingOoo as unknown as { count?: number } | null)?.count ?? 0;
  const inspCount = (pendingInspection as unknown as { count?: number } | null)?.count ?? 0;

  return {
    arrivals,
    departures,
    projectedRoomsToClean,
    recommendedHeadcount,
    recommendedLaborCostCents,
    roomsPendingOOO: ooCount,
    roomsPendingInspection: inspCount,
  };
}

/**
 * Pull a 14-day baseline of report_runs payloads for anomaly comparison.
 * Returns an empty array if the property is brand new — the detector
 * skips baseline-dependent checks when there aren't enough points.
 */
async function loadBaseline(args: {
  propertyId: string;
  reportDate: string;
}): Promise<DailyBaselineSlice[]> {
  const { propertyId, reportDate } = args;
  const { data, error } = await supabaseAdmin
    .from('report_runs')
    .select('report_date, report_payload')
    .eq('property_id', propertyId)
    .eq('report_type', 'daily')
    .lt('report_date', reportDate)
    .order('report_date', { ascending: false })
    .limit(14);
  if (error) {
    log.warn('[daily-report] baseline load failed', { propertyId, err: error.message });
    return [];
  }
  const slices: DailyBaselineSlice[] = [];
  for (const row of data ?? []) {
    const payload = row.report_payload as DailyReportPayload | null;
    if (!payload) continue;
    slices.push({
      reportDate: row.report_date,
      passRatePct: payload.quality?.passRatePct ?? 0,
      workOrdersCreatedToday: payload.issues?.workOrdersCreatedToday ?? 0,
      sickCalloutsToday: payload.labor?.sickCalloutsToday ?? 0,
    });
  }
  return slices.reverse();   // oldest-first matches detector contract
}

export async function buildDailyReport(args: {
  propertyId: string;
  reportDate: string;       // YYYY-MM-DD property-local
  /**
   * Skip the 14-day baseline load (used only for anomaly detection).
   * The weekly-report's inline fallback passes this — it does its own
   * anomaly pass at the week level, so the per-day baseline isn't
   * needed and skipping it shaves ~1 round-trip from the Sunday
   * weekly hot path (which is already under a 45s send budget).
   * Anomalies still get computed but with an empty baseline, which
   * means the baseline-dependent checks (pass-rate-drop, work-order-
   * spike) silently skip — exactly the silence-when-too-little-data
   * behavior the detector already supports.
   */
  skipBaseline?: boolean;
}): Promise<DailyReportPayload | null> {
  const { propertyId, reportDate } = args;
  const property = await loadProperty(propertyId);
  if (!property) return null;

  // Pull all of today's data in parallel — every query is a clean
  // single-table fetch, no joins.
  const [
    tasksRes,
    inspectionsRes,
    workOrdersRes,
    inHouseRes,
    staffRes,
    calloutsRes,
  ] = await Promise.all([
    supabaseAdmin
      .from('cleaning_tasks')
      .select('id, cleaning_type, status, started_at, completed_at, assignee_id, requires_inspection')
      .eq('property_id', propertyId)
      .eq('business_date', reportDate),
    // Inspections are bounded in property-local time, not UTC. For a
    // Chicago property on 2026-05-23 (DST), local midnight = 05:00 UTC,
    // so the right range is [2026-05-23 05:00 UTC, 2026-05-24 05:00 UTC).
    // The naïve `${reportDate}T00:00Z` would miss the last 5 hours of
    // the local day and pick up 5 hours from the prior day.
    supabaseAdmin
      .from('inspections')
      .select('id, result, failed_items, housekeeper_staff_id, completed_at')
      .eq('property_id', propertyId)
      .gte('started_at', localMidnightToUtc(reportDate, property.timezone))
      .lt('started_at', localMidnightToUtc(nextDayLocal(reportDate), property.timezone)),
    supabaseAdmin
      .from('pms_work_orders_v2')
      .select('id, status, priority, out_of_order, reported_at')
      .eq('property_id', propertyId),
    supabaseAdmin
      .from('pms_in_house_snapshot')
      .select('*')
      .eq('property_id', propertyId)
      .maybeSingle(),
    supabaseAdmin
      .from('staff')
      .select('id, name, hourly_wage, hourly_wage_cents')
      .eq('property_id', propertyId),
    supabaseAdmin
      .from('callout_events')
      .select('business_date, reason')
      .eq('property_id', propertyId)
      .eq('business_date', reportDate)
      .eq('status', 'active'),
  ]);

  const tasks = (tasksRes.data ?? []) as CleaningTaskRow[];
  const inspections = (inspectionsRes.data ?? []) as InspectionRow[];
  const workOrders = (workOrdersRes.data ?? []) as WorkOrderRow[];
  const inHouse = (inHouseRes.data ?? null) as InHouseSnapshot | null;
  const staff = (staffRes.data ?? []) as StaffRow[];
  const callouts = (calloutsRes.data ?? []) as CalloutRow[];

  // hk_assignments fetched separately because it joins to today's tasks.
  const taskIds = tasks.map(t => t.id);
  let assignments: HkAssignmentRow[] = [];
  if (taskIds.length > 0) {
    const { data: aData, error: aErr } = await supabaseAdmin
      .from('hk_assignments')
      .select('housekeeper_id, cleaning_task_id, is_active')
      .in('cleaning_task_id', taskIds);
    if (aErr) {
      log.warn('[daily-report] hk_assignments load failed — falling back to empty', { propertyId, err: aErr.message });
    } else {
      assignments = aData as HkAssignmentRow[];
    }
  }

  const operations = buildOperationsBlock({
    tasks,
    assignments,
    inHouse,
    workOrders,
    totalRoomsOnProperty: property.totalRooms,
  });
  const quality = buildQualityBlock(inspections);
  const labor = buildLaborBlock({
    tasks,
    staff,
    inHouse,
    callouts,
    weeklyBudgetCents: property.weeklyBudgetCents,
  });
  const issues = buildIssuesBlock({
    workOrders,
    reportDate,
    timezone: property.timezone,
  });
  const tomorrow = await buildTomorrowOutlook({ property, reportDate });

  const payload: DailyReportPayload = {
    propertyId: property.id,
    propertyName: property.name,
    reportDate,
    timezone: property.timezone,
    operations,
    quality,
    labor,
    issues,
    tomorrow,
    anomalies: [],   // filled in below
    dashboardUrl: `${DEFAULT_DASHBOARD_BASE}/housekeeping`,
  };

  // Anomaly pass. perStaffRoomsToday is derived from the same ranker
  // the weekly report uses.
  let baseline: DailyBaselineSlice[] = [];
  if (!args.skipBaseline) {
    try {
      baseline = await loadBaseline({ propertyId, reportDate });
    } catch (e) {
      captureException(e, { subsystem: 'daily-report', failure_mode: 'baseline_load_failed', propertyId });
    }
  }
  const ranked = rankStaffPerformance({ tasks, inspections, staff });
  payload.anomalies = detectAnomalies({
    today: payload,
    baseline,
    perStaffRoomsToday: ranked.map(r => ({ staffId: r.staffId, name: r.name, rooms: r.roomsCleaned })),
  });

  return payload;
}

// Re-exports so callers can introspect without importing the inner modules.
export type { DailyReportPayload };
export { isoDateInTz };
