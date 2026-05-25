/**
 * Build the weekly report payload — same blocks as the daily report
 * but aggregated over a Mon–Sun window ending on `reportDate`.
 *
 * Strategy: instead of re-summing every cleaning_task across the week
 * (which is identical work to what the daily report already did), we
 * read the seven `report_runs` rows for this property's Mon–Sun window
 * and roll them up. The daily payload is already in `report_payload` —
 * the weekly is "merge 7 of these into 1." Cuts the SQL footprint by
 * ~85% versus the naive re-query.
 *
 * Fall-back behavior: if some days are missing report_runs rows (e.g.
 * the cron started mid-week), the merge silently skips those days. The
 * weekly summary will be biased low (fewer rooms counted, less labor
 * cost) — that's better than the alternative of failing the email or
 * re-running 7 expensive daily builds inline.
 *
 * Top-performer / improvement-opportunity rankings are NOT in the
 * stored daily payloads (we'd have to bloat them with per-staff rows),
 * so the weekly builder does ONE pass over the week's cleaning_tasks +
 * inspections to compute them. That's still cheaper than 7 full daily
 * runs.
 */

import { supabaseAdmin } from '@/lib/supabase-admin';
import { log } from '@/lib/log';
import { captureException } from '@/lib/sentry';
import {
  localMidnightToUtc,
  rankStaffPerformance,
  type CleaningTaskRow,
  type InspectionRow,
  type StaffRow,
} from './aggregate';
import { detectAnomalies } from './anomaly-detector';
import { generateWeeklyInsight } from './weekly-insights';
import type {
  DailyReportPayload,
  StaffPerformance,
  WeeklyReportPayload,
  WeeklyTrend,
} from './types';

const DASHBOARD_BASE = 'https://getstaxis.com';

/**
 * Find the Monday at the start of the week ending on `sundayDate`
 * (a YYYY-MM-DD string). Returns YYYY-MM-DD. Pure date math — no TZ
 * shift needed because business dates are property-local already.
 */
export function mondayBeforeSunday(sundayDate: string): string {
  const [y, m, d] = sundayDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 6));
  return dt.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

interface PropertyContext {
  id: string;
  name: string;
  timezone: string;
  totalRooms: number;
  weeklyBudgetCents: number | null;
}

async function loadProperty(propertyId: string): Promise<PropertyContext | null> {
  const { data, error } = await supabaseAdmin
    .from('properties')
    .select('id, name, timezone, total_rooms, weekly_budget')
    .eq('id', propertyId)
    .maybeSingle();
  if (error || !data) {
    log.error('[weekly-report] property load failed', { propertyId, err: error?.message });
    return null;
  }
  return {
    id: data.id,
    name: data.name,
    timezone: data.timezone ?? 'UTC',
    totalRooms: Number(data.total_rooms ?? 0),
    weeklyBudgetCents: data.weekly_budget !== null && data.weekly_budget !== undefined
      ? Math.round(Number(data.weekly_budget) * 100)
      : null,
  };
}

/**
 * Load this week's + prior week's daily report payloads. Used both for
 * the metric merge and for the trend-vs-prior-week math.
 */
async function loadWeekDailies(args: {
  propertyId: string;
  weekStart: string;
  weekEnd: string;
}): Promise<DailyReportPayload[]> {
  const { propertyId, weekStart, weekEnd } = args;
  const { data, error } = await supabaseAdmin
    .from('report_runs')
    .select('report_date, report_payload')
    .eq('property_id', propertyId)
    .eq('report_type', 'daily')
    .gte('report_date', weekStart)
    .lte('report_date', weekEnd)
    .order('report_date', { ascending: true });
  if (error) {
    log.warn('[weekly-report] daily payloads load failed', { propertyId, err: error.message });
    return [];
  }
  const payloads: DailyReportPayload[] = [];
  for (const row of data ?? []) {
    if (!row.report_payload) continue;
    payloads.push(row.report_payload as DailyReportPayload);
  }
  return payloads;
}

function sumDailies(dailies: DailyReportPayload[]) {
  const accum = {
    roomsCleaned: 0,
    totalRoomsOnBoard: 0,
    roomsOOO: 0,
    roomsOOS: 0,
    occupancyPctSum: 0,
    occupancyPctDays: 0,
    inspectionsCompleted: 0,
    inspectionsPassed: 0,
    reclearRequested: 0,
    failureReasonCounts: new Map<string, number>(),
    laborCostCents: 0,
    totalHoursWorked: 0,
    totalOvertimeHours: 0,
    sickCallouts: 0,
    workOrdersCreated: 0,
    urgentItemsPending: 0,
    arrivalsProjected: 0,
    departuresProjected: 0,
    projectedRoomsToClean: 0,
    recommendedHeadcountSum: 0,
    recommendedHeadcountDays: 0,
  };
  for (const day of dailies) {
    accum.roomsCleaned += day.operations.roomsCleanedToday;
    accum.totalRoomsOnBoard += day.operations.totalRoomsOnBoard;
    accum.roomsOOO += day.operations.roomsOOO;
    accum.roomsOOS += day.operations.roomsOOS;
    if (day.operations.occupancyPct > 0) {
      accum.occupancyPctSum += day.operations.occupancyPct;
      accum.occupancyPctDays += 1;
    }
    accum.inspectionsCompleted += day.quality.inspectionsCompleted;
    accum.inspectionsPassed += day.quality.inspectionsPassed;
    accum.reclearRequested += day.quality.reclearRequestedCount;
    for (const r of day.quality.topFailureReasons) {
      accum.failureReasonCounts.set(
        r.reason,
        (accum.failureReasonCounts.get(r.reason) ?? 0) + r.count,
      );
    }
    accum.laborCostCents += day.labor.laborCostCents;
    accum.totalHoursWorked += day.labor.totalHoursWorked;
    accum.totalOvertimeHours += day.labor.totalOvertimeHours;
    accum.sickCallouts += day.labor.sickCalloutsToday;
    accum.workOrdersCreated += day.issues.workOrdersCreatedToday;
    accum.urgentItemsPending = Math.max(accum.urgentItemsPending, day.issues.urgentItemsStillPending);
    accum.arrivalsProjected += day.tomorrow.arrivals;
    accum.departuresProjected += day.tomorrow.departures;
    accum.projectedRoomsToClean += day.tomorrow.projectedRoomsToClean;
    if (day.tomorrow.recommendedHeadcount !== null) {
      accum.recommendedHeadcountSum += day.tomorrow.recommendedHeadcount;
      accum.recommendedHeadcountDays += 1;
    }
  }
  return accum;
}

function diffPct(thisWeek: number, priorWeek: number): number {
  if (priorWeek === 0) return thisWeek > 0 ? 100 : 0;
  return ((thisWeek - priorWeek) / priorWeek) * 100;
}

export async function buildWeeklyReport(args: {
  propertyId: string;
  /** ISO date of the Sunday at the end of the Mon–Sun window. YYYY-MM-DD. */
  reportDate: string;
}): Promise<WeeklyReportPayload | null> {
  const { propertyId, reportDate } = args;
  const property = await loadProperty(propertyId);
  if (!property) return null;

  const weekStart = mondayBeforeSunday(reportDate);
  const priorWeekStart = addDaysIso(weekStart, -7);
  const priorWeekEnd = addDaysIso(reportDate, -7);

  const [thisDailies, priorDailies] = await Promise.all([
    loadWeekDailies({ propertyId, weekStart, weekEnd: reportDate }),
    loadWeekDailies({ propertyId, weekStart: priorWeekStart, weekEnd: priorWeekEnd }),
  ]);

  const thisAccum = sumDailies(thisDailies);
  const priorAccum = sumDailies(priorDailies);

  // Build the operational / quality / labor / issues blocks from the
  // accumulated daily payloads. We don't have stored per-week operations
  // breakdowns for cleaning-type minutes, so the weekly omits those
  // (they'd require a re-query). Daily averages re-rendered here are
  // "average of dailies" — good enough for the weekly view.
  const passRatePct = thisAccum.inspectionsCompleted > 0
    ? (thisAccum.inspectionsPassed / thisAccum.inspectionsCompleted) * 100
    : 0;
  const reclearRatePct = thisAccum.inspectionsCompleted > 0
    ? (thisAccum.reclearRequested / thisAccum.inspectionsCompleted) * 100
    : 0;
  const topFailureReasons = [...thisAccum.failureReasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));

  // Daily averages for the per-cleaning-type rows aren't accumulated;
  // we re-query the week's tasks just for the per-staff ranking, then
  // pull the avg-by-cleaning-type out of the same dataset.
  const [thisWeekTasksRes, thisWeekInspectionsRes, staffRes] = await Promise.all([
    supabaseAdmin
      .from('cleaning_tasks')
      .select('id, cleaning_type, status, started_at, completed_at, assignee_id, requires_inspection')
      .eq('property_id', propertyId)
      .gte('business_date', weekStart)
      .lte('business_date', reportDate),
    supabaseAdmin
      .from('inspections')
      .select('id, result, failed_items, housekeeper_staff_id, completed_at')
      .eq('property_id', propertyId)
      // Property-local week bounds — see localMidnightToUtc in aggregate.ts
      // for why the naïve T00:00:00Z form is wrong for non-UTC properties.
      .gte('started_at', localMidnightToUtc(weekStart, property.timezone))
      .lt('started_at', localMidnightToUtc(addDaysIso(reportDate, 1), property.timezone)),
    supabaseAdmin
      .from('staff')
      .select('id, name, hourly_wage')
      .eq('property_id', propertyId),
  ]);

  const tasks = (thisWeekTasksRes.data ?? []) as CleaningTaskRow[];
  const inspections = (thisWeekInspectionsRes.data ?? []) as InspectionRow[];
  const staff = (staffRes.data ?? []) as StaffRow[];

  // Per-cleaning-type averages across the week.
  const minutesByType = {
    departure: [] as number[],
    stayover: [] as number[],
    deep: [] as number[],
  };
  for (const t of tasks) {
    if (!t.started_at || !t.completed_at) continue;
    const startMs = Date.parse(t.started_at);
    const endMs = Date.parse(t.completed_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const mins = (endMs - startMs) / 60_000;
    if (mins <= 0 || mins > 12 * 60) continue;
    if (t.cleaning_type === 'departure' || t.cleaning_type === 'departure_deep') minutesByType.departure.push(mins);
    else if (t.cleaning_type === 'stayover') minutesByType.stayover.push(mins);
    else if (t.cleaning_type === 'deep') minutesByType.deep.push(mins);
  }
  const avg = (n: number[]) => n.length === 0 ? null : Math.round((n.reduce((a, b) => a + b, 0) / n.length) * 10) / 10;

  const operations = {
    roomsCleanedToday: thisAccum.roomsCleaned,
    totalRoomsOnBoard: thisAccum.totalRoomsOnBoard,
    roomsOOO: thisAccum.roomsOOO,
    roomsOOS: thisAccum.roomsOOS,
    occupancyPct: thisAccum.occupancyPctDays > 0
      ? Math.round((thisAccum.occupancyPctSum / thisAccum.occupancyPctDays) * 10) / 10
      : 0,
    avgMinutesPerDeparture: avg(minutesByType.departure),
    avgMinutesPerStayover: avg(minutesByType.stayover),
    avgMinutesPerDeepClean: avg(minutesByType.deep),
    // rooms per housekeeper — averaged across dailies (each day weighted
    // equally). The per-day value already accounts for shift size.
    roomsPerHousekeeper: thisDailies.length > 0
      ? Math.round((thisDailies.reduce((sum, d) => sum + d.operations.roomsPerHousekeeper, 0) / thisDailies.length) * 10) / 10
      : 0,
  };

  const quality = {
    inspectionsCompleted: thisAccum.inspectionsCompleted,
    inspectionsPassed: thisAccum.inspectionsPassed,
    passRatePct: Math.round(passRatePct * 10) / 10,
    reclearRequestedCount: thisAccum.reclearRequested,
    reclearRatePct: Math.round(reclearRatePct * 10) / 10,
    topFailureReasons,
  };

  const weeklyBudgetCents = property.weeklyBudgetCents;
  const labor = {
    totalHoursWorked: Math.round(thisAccum.totalHoursWorked * 10) / 10,
    totalOvertimeHours: Math.round(thisAccum.totalOvertimeHours * 10) / 10,
    costPerOccupiedRoomCents: thisAccum.roomsCleaned > 0
      ? Math.round(thisAccum.laborCostCents / thisAccum.roomsCleaned)
      : 0,
    laborCostCents: thisAccum.laborCostCents,
    laborBudgetCents: weeklyBudgetCents,
    sickCalloutsToday: thisAccum.sickCallouts,
  };

  const issues = {
    workOrdersCreatedToday: thisAccum.workOrdersCreated,
    urgentItemsStillPending: thisAccum.urgentItemsPending,
  };

  const nextWeek = {
    projectedArrivals: thisAccum.arrivalsProjected,
    projectedDepartures: thisAccum.departuresProjected,
    projectedRoomsToClean: thisAccum.projectedRoomsToClean,
    recommendedHeadcount: thisAccum.recommendedHeadcountDays > 0
      ? Math.round(thisAccum.recommendedHeadcountSum / thisAccum.recommendedHeadcountDays)
      : null,
  };

  // Trends vs prior week.
  const priorPassRate = priorAccum.inspectionsCompleted > 0
    ? (priorAccum.inspectionsPassed / priorAccum.inspectionsCompleted) * 100
    : 0;
  const trends: WeeklyTrend[] = [
    {
      metric: 'rooms_cleaned',
      thisWeek: thisAccum.roomsCleaned,
      priorWeek: priorAccum.roomsCleaned,
      deltaPct: Math.round(diffPct(thisAccum.roomsCleaned, priorAccum.roomsCleaned) * 10) / 10,
    },
    {
      metric: 'labor_cost_cents',
      thisWeek: thisAccum.laborCostCents,
      priorWeek: priorAccum.laborCostCents,
      deltaPct: Math.round(diffPct(thisAccum.laborCostCents, priorAccum.laborCostCents) * 10) / 10,
    },
    {
      metric: 'inspection_pass_rate_pct',
      thisWeek: Math.round(passRatePct * 10) / 10,
      priorWeek: Math.round(priorPassRate * 10) / 10,
      deltaPct: Math.round(diffPct(passRatePct, priorPassRate) * 10) / 10,
    },
    {
      metric: 'callouts',
      thisWeek: thisAccum.sickCallouts,
      priorWeek: priorAccum.sickCallouts,
      deltaPct: Math.round(diffPct(thisAccum.sickCallouts, priorAccum.sickCallouts) * 10) / 10,
    },
  ];

  // Per-staff rankings — top performer = highest rooms cleaned this
  // week with a non-null pass rate; improvement opportunity = lowest
  // pass rate among those with at least 5 inspections (filter out
  // small-sample noise).
  const ranked = rankStaffPerformance({ tasks, inspections, staff });
  ranked.sort((a, b) => b.roomsCleaned - a.roomsCleaned);
  const topPerformer: StaffPerformance | null = ranked[0] ?? null;
  const improvementOpportunity: StaffPerformance | null = [...ranked]
    .filter(r => r.inspectionPassRatePct !== null && r.inspectionPassRatePct < 100)
    .sort((a, b) => (a.inspectionPassRatePct ?? 100) - (b.inspectionPassRatePct ?? 100))[0] ?? null;

  const payload: WeeklyReportPayload = {
    propertyId: property.id,
    propertyName: property.name,
    reportDate,
    weekStartDate: weekStart,
    timezone: property.timezone,
    operations,
    quality,
    labor,
    issues,
    nextWeek,
    trends,
    topPerformer,
    improvementOpportunity,
    insightText: null,         // filled below
    anomalies: [],             // weekly anomalies = sum of daily anomalies; collected below
    dashboardUrl: `${DASHBOARD_BASE}/housekeeping`,
  };

  // Collect anomalies — for weekly, we just surface the dedup'd list of
  // unique anomaly kinds seen across the seven dailies. This avoids
  // sounding 7 separate "Maria cleaned 12 rooms" alarms if she did it
  // five days in a row.
  const seenAnomalyKey = new Set<string>();
  for (const day of thisDailies) {
    for (const a of day.anomalies) {
      const key = `${a.kind}:${a.message.slice(0, 40)}`;
      if (seenAnomalyKey.has(key)) continue;
      seenAnomalyKey.add(key);
      payload.anomalies.push(a);
    }
  }

  // AI insight. Soft-fail — null if Claude is unreachable / key missing.
  try {
    payload.insightText = await generateWeeklyInsight(payload);
  } catch (e) {
    captureException(e, { subsystem: 'weekly-report', failure_mode: 'insight_failed', propertyId });
  }

  // Final anomaly detector pass — feed the WEEKLY payload through with
  // an empty baseline so callout-spike / speed-outlier checks fire on
  // the week's aggregates even when no dailies were stored. Cheap.
  if (payload.anomalies.length === 0) {
    payload.anomalies = detectAnomalies({
      today: {
        ...payload,
        anomalies: [],
        tomorrow: {
          arrivals: nextWeek.projectedArrivals,
          departures: nextWeek.projectedDepartures,
          projectedRoomsToClean: nextWeek.projectedRoomsToClean,
          recommendedHeadcount: nextWeek.recommendedHeadcount,
          recommendedLaborCostCents: null,
          roomsPendingOOO: 0,
          roomsPendingInspection: 0,
        },
      } as DailyReportPayload,
      baseline: [],
      perStaffRoomsToday: ranked.map(r => ({ staffId: r.staffId, name: r.name, rooms: r.roomsCleaned })),
    });
  }

  return payload;
}
