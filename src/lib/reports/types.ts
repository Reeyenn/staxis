/**
 * Shared types for the daily + weekly housekeeping report engine.
 *
 * Two reasons these live in their own file:
 *   1. The cron route, the email template, and the test fixture all need
 *      the same shape — easier to maintain one canonical definition than
 *      to copy-paste it across three files.
 *   2. Anomalies feed back into the daily payload, but the detector is a
 *      separate module, so the Anomaly type sits here as the contract
 *      between the two.
 *
 * Money is stored in cents (bigint-ish — we use number, since labor
 * costs never exceed ~$1B and JS number is safe up to 2^53).
 * Times are minutes as numbers (e.g. 22.5 = 22 min 30 sec).
 */

export type CleaningType = 'departure' | 'stayover' | 'deep' | 'other';

export interface OperationsBlock {
  roomsCleanedToday: number;
  totalRoomsOnBoard: number;       // assigned rooms (cleaning_tasks count)
  roomsOOO: number;                // out-of-order — work_orders.out_of_order=true
  roomsOOS: number;                // out-of-service — pms vacant_dirty held aside
  occupancyPct: number;            // 0-100
  avgMinutesPerDeparture: number | null;
  avgMinutesPerStayover: number | null;
  avgMinutesPerDeepClean: number | null;
  roomsPerHousekeeper: number;
}

export interface QualityBlock {
  inspectionsCompleted: number;
  inspectionsPassed: number;
  passRatePct: number;             // 0-100
  reclearRequestedCount: number;   // inspections.result='fail' (correction_pending → re-do)
  reclearRatePct: number;          // 0-100
  topFailureReasons: Array<{ reason: string; count: number }>;  // top 3 from inspection failed_items
}

export interface LaborBlock {
  totalHoursWorked: number;
  totalOvertimeHours: number;
  costPerOccupiedRoomCents: number;
  laborCostCents: number;
  laborBudgetCents: number | null; // null if property has no weekly_budget set
  sickCalloutsToday: number;
}

export interface IssuesBlock {
  workOrdersCreatedToday: number;
  urgentItemsStillPending: number;  // work_orders.status in (open, in_progress) AND priority IN (urgent,high)
}

export interface TomorrowOutlookBlock {
  arrivals: number;
  departures: number;
  projectedRoomsToClean: number;
  recommendedHeadcount: number | null;   // from /ml-service if available, else null
  recommendedLaborCostCents: number | null;
  roomsPendingOOO: number;
  roomsPendingInspection: number;
}

export interface Anomaly {
  kind: 'speed_outlier' | 'pass_rate_drop' | 'callout_spike' | 'work_order_spike';
  /** Plain-English message shown verbatim in the email. */
  message: string;
  /** Optional context (numeric values) for the test/diagnostic UI. */
  context?: Record<string, number | string>;
}

export interface DailyReportPayload {
  propertyId: string;
  propertyName: string;
  /** Property-local business date (YYYY-MM-DD). */
  reportDate: string;
  /** Property-local timezone (so the email can format times correctly). */
  timezone: string;
  operations: OperationsBlock;
  quality: QualityBlock;
  labor: LaborBlock;
  issues: IssuesBlock;
  tomorrow: TomorrowOutlookBlock;
  anomalies: Anomaly[];
  /** Where the "View full dashboard →" button should deep-link. */
  dashboardUrl: string;
}

export interface StaffPerformance {
  staffId: string;
  name: string;
  roomsCleaned: number;
  avgMinutesPerRoom: number | null;
  inspectionPassRatePct: number | null;
}

export interface WeeklyTrend {
  metric:
    | 'rooms_cleaned'
    | 'labor_cost_cents'
    | 'inspection_pass_rate_pct'
    | 'callouts';
  thisWeek: number;
  priorWeek: number;
  deltaPct: number;            // -100..+∞; null if priorWeek is 0
}

export interface WeeklyReportPayload {
  propertyId: string;
  propertyName: string;
  /** ISO date of the Sunday at the end of the Mon–Sun window. */
  reportDate: string;
  /** ISO date of the Monday at the start of the window. */
  weekStartDate: string;
  timezone: string;
  /** Aggregated daily metrics across the Mon–Sun window. */
  operations: OperationsBlock;
  quality: QualityBlock;
  labor: LaborBlock;
  issues: IssuesBlock;
  /** Same outlook block as daily — for the upcoming week. */
  nextWeek: {
    projectedArrivals: number;
    projectedDepartures: number;
    projectedRoomsToClean: number;
    recommendedHeadcount: number | null;
  };
  trends: WeeklyTrend[];
  topPerformer: StaffPerformance | null;
  improvementOpportunity: StaffPerformance | null;
  /**
   * Claude-generated 1-paragraph plain-English insight. The dashboard
   * renders this verbatim at the top of the email. Null if Claude was
   * unavailable / skipped; the email still goes out with the metrics
   * but without the insight block.
   */
  insightText: string | null;
  anomalies: Anomaly[];
  dashboardUrl: string;
}

/**
 * One row of the per-recipient delivery outcome stored in report_runs.
 * Updated as each Resend call resolves so a partial failure shows
 * exactly which addresses bounced.
 */
export interface RecipientOutcome {
  email: string;
  accountId: string | null;       // null for CC-only recipients
  role: 'gm' | 'owner' | 'cc';
  channel: 'email' | 'sms';
  status: 'sent' | 'failed' | 'rate_limited' | 'skipped';
  resendId?: string;
  error?: string;
  attempts: number;
  lastAttemptAt: string;          // ISO
}
