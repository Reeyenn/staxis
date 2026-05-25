/**
 * Flag outliers in a daily report so the email surfaces them in the
 * "Anomalies" section. Pure function — takes today's daily payload + a
 * baseline window (the last N days of summaries) and returns the list of
 * anomalies to render.
 *
 * Thresholds are intentionally simple — they're "raise an eyebrow"
 * heuristics, not statistical alerts. Each one has a clear plain-English
 * message that an owner can interpret without needing the underlying
 * math.
 *
 *   1. Speed outlier — any housekeeper who cleaned >2x the property's
 *      median rooms-per-housekeeper for the day. Catches data entry
 *      errors ("Maria cleaned 12 rooms in 3 hours") and possible
 *      gaming (someone marking rooms done without actually cleaning).
 *
 *   2. Pass-rate drop — today's inspection pass rate is 15+ percentage
 *      points below the 14-day rolling average. Indicates a systemic
 *      training gap or a particular checklist item suddenly failing.
 *
 *   3. Callout spike — 3+ sick callouts today (any single day with that
 *      many people out merits a manager glance).
 *
 *   4. Work-order spike — work_orders created today is 2x the 14-day
 *      rolling average AND >5 in absolute terms. Filters out the trivial
 *      case where average=1 and today=3 (technically 3x, but fine).
 *
 * Why no z-score / proper statistical test:
 *   - The rolling-window data is tiny (14 days). Z-scores on small
 *     windows hallucinate "anomalies" all the time.
 *   - Owners want "is this worth my attention?", not "is this
 *     statistically significant?". A simple, interpretable rule wins.
 */

import type { Anomaly, DailyReportPayload } from './types';

export interface DailyBaselineSlice {
  /** ISO date this slice represents. */
  reportDate: string;
  passRatePct: number;
  workOrdersCreatedToday: number;
  sickCalloutsToday: number;
  /**
   * For per-staff comparisons we need the per-staff rooms-cleaned for
   * today. Stored as a Map from staff_id → rooms today.
   */
  roomsPerStaffToday?: Map<string, number>;
}

export interface AnomalyInputs {
  /** Today's report being built — anomalies get attached back to it. */
  today: DailyReportPayload;

  /**
   * Last 14 days of summarized history (oldest first). May be empty if
   * the property is brand new. Anomalies that need a baseline (#2, #4)
   * silently skip when the window has fewer than 3 valid points.
   */
  baseline: DailyBaselineSlice[];

  /**
   * Per-staff rooms-cleaned today, keyed by staff_id → name. Used by the
   * speed-outlier check. Derived in the daily builder from cleaning_tasks
   * + staff rows.
   */
  perStaffRoomsToday: Array<{ staffId: string; name: string; rooms: number }>;
}

const PASS_RATE_DROP_THRESHOLD_PCT = 15;
const CALLOUT_SPIKE_THRESHOLD = 3;
const WORK_ORDER_RATIO_THRESHOLD = 2;
const WORK_ORDER_ABSOLUTE_THRESHOLD = 5;
const SPEED_OUTLIER_RATIO = 2;
const MIN_BASELINE_POINTS = 3;

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((acc, n) => acc + n, 0) / nums.length;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function detectAnomalies(inputs: AnomalyInputs): Anomaly[] {
  const { today, baseline, perStaffRoomsToday } = inputs;
  const anomalies: Anomaly[] = [];

  // ── 1. Speed outlier — per-housekeeper today vs median for today ───────
  const roomsToday = perStaffRoomsToday.map(s => s.rooms).filter(n => n > 0);
  if (roomsToday.length >= 2) {
    const med = median(roomsToday);
    for (const staff of perStaffRoomsToday) {
      if (staff.rooms >= med * SPEED_OUTLIER_RATIO && staff.rooms > 4) {
        // Threshold: 2x median AND >4 in absolute terms (filters out
        // the trivial case where med=2 and staff did 4).
        anomalies.push({
          kind: 'speed_outlier',
          message: `${staff.name} cleaned ${staff.rooms} rooms today — about ${Math.round((staff.rooms / med) * 10) / 10}× the team average. Double-check the data.`,
          context: { staffId: staff.staffId, rooms: staff.rooms, teamMedian: med },
        });
      }
    }
  }

  // ── 2. Pass-rate drop ──────────────────────────────────────────────────
  const baselinePassRates = baseline
    .map(b => b.passRatePct)
    .filter(n => n > 0);   // skip days with no inspections
  if (baselinePassRates.length >= MIN_BASELINE_POINTS && today.quality.inspectionsCompleted >= 3) {
    const baselineAvg = average(baselinePassRates);
    const drop = baselineAvg - today.quality.passRatePct;
    if (drop >= PASS_RATE_DROP_THRESHOLD_PCT) {
      const top = today.quality.topFailureReasons[0];
      const topPart = top ? ` — top reason: ${top.reason}` : '';
      anomalies.push({
        kind: 'pass_rate_drop',
        message: `Inspection pass rate dropped ${Math.round(drop)} points today (${today.quality.passRatePct}% vs ${Math.round(baselineAvg)}% average)${topPart}.`,
        context: {
          today: today.quality.passRatePct,
          baseline: Math.round(baselineAvg),
          drop: Math.round(drop),
        },
      });
    }
  }

  // ── 3. Callout spike ───────────────────────────────────────────────────
  if (today.labor.sickCalloutsToday >= CALLOUT_SPIKE_THRESHOLD) {
    anomalies.push({
      kind: 'callout_spike',
      message: `${today.labor.sickCalloutsToday} sick callouts today — unusual for a single day. Worth a quick check-in.`,
      context: { count: today.labor.sickCalloutsToday },
    });
  }

  // ── 4. Work-order spike ────────────────────────────────────────────────
  const baselineWO = baseline.map(b => b.workOrdersCreatedToday);
  if (baselineWO.length >= MIN_BASELINE_POINTS) {
    const baselineAvg = average(baselineWO);
    const todayCount = today.issues.workOrdersCreatedToday;
    if (
      baselineAvg > 0
      && todayCount >= baselineAvg * WORK_ORDER_RATIO_THRESHOLD
      && todayCount >= WORK_ORDER_ABSOLUTE_THRESHOLD
    ) {
      anomalies.push({
        kind: 'work_order_spike',
        message: `${todayCount} maintenance tickets created today — about ${Math.round((todayCount / baselineAvg) * 10) / 10}× the recent average. Check if a specific issue is recurring.`,
        context: {
          today: todayCount,
          baseline: Math.round(baselineAvg * 10) / 10,
        },
      });
    }
  }

  return anomalies;
}
