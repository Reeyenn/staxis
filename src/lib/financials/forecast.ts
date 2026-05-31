// ════════════════════════════════════════════════════════════════════════════
// Financials — overspend forecast (pure functions, no I/O → unit-testable).
//
// Mid-month, project each department's end-of-month spend from spend-to-date
// paced by days elapsed, optionally adjusted by the PMS occupancy forecast for
// the remaining days. Flag departments "trending X% over budget".
//
// Honest cold start: with < MIN_DAYS_FOR_CONFIDENCE elapsed or zero spend, the
// projection is marked low-confidence and never raises an alert — we don't cry
// wolf on day 2 of the month or for a department that hasn't spent anything.
// ════════════════════════════════════════════════════════════════════════════

import type { Department } from './shared';
import { departmentLabel, formatCents } from './shared';

export const MIN_DAYS_FOR_CONFIDENCE = 5;
// Only alert when the projection clears the budget by more than this buffer, so
// a department pacing to exactly 100% doesn't trip a "trending over" alert.
export const OVERSPEND_BUFFER = 0.05; // 5%

export interface OverspendForecast {
  department: Department;
  budgetCents: number;
  spentToDateCents: number;
  projectedCents: number;
  pctOverBudget: number | null; // (projected - budget) / budget * 100; null when no budget
  trendingOver: boolean;
  confidence: 'low' | 'ok';
  message: string;
}

/**
 * Project month-end spend. dailyRate = spentToDate / daysElapsed; the remaining
 * days are added at that rate, scaled by the occupancy pacing factor (1 = flat).
 * Returns integer cents.
 */
export function projectMonthEndSpend(
  spentToDateCents: number,
  daysElapsed: number,
  daysInMonth: number,
  occupancyFactor = 1,
): number {
  if (daysElapsed <= 0) return Math.round(spentToDateCents);
  if (daysElapsed >= daysInMonth) return Math.round(spentToDateCents);
  const dailyRate = spentToDateCents / daysElapsed;
  const remainingDays = daysInMonth - daysElapsed;
  const factor = Number.isFinite(occupancyFactor) && occupancyFactor > 0 ? occupancyFactor : 1;
  return Math.round(spentToDateCents + dailyRate * remainingDays * factor);
}

export function forecastDepartmentOverspend(
  department: Department,
  budgetCents: number,
  spentToDateCents: number,
  daysElapsed: number,
  daysInMonth: number,
  occupancyFactor: number | null,
): OverspendForecast {
  const projected = projectMonthEndSpend(
    spentToDateCents,
    daysElapsed,
    daysInMonth,
    occupancyFactor ?? 1,
  );
  const pctOverBudget =
    budgetCents > 0 ? ((projected - budgetCents) / budgetCents) * 100 : null;
  const confidence: 'low' | 'ok' =
    daysElapsed < MIN_DAYS_FOR_CONFIDENCE || spentToDateCents <= 0 ? 'low' : 'ok';
  const trendingOver =
    confidence === 'ok' && budgetCents > 0 && projected > budgetCents * (1 + OVERSPEND_BUFFER);

  let message: string;
  if (confidence === 'low') {
    message = `Too early to forecast ${departmentLabel(department)} reliably.`;
  } else if (trendingOver && pctOverBudget != null) {
    message = `${departmentLabel(department)} is trending ${Math.round(pctOverBudget)}% over budget (projected ${formatCents(projected)} vs ${formatCents(budgetCents)}).`;
  } else if (budgetCents > 0) {
    message = `${departmentLabel(department)} is on track (projected ${formatCents(projected)} of ${formatCents(budgetCents)}).`;
  } else {
    message = `${departmentLabel(department)} has no budget set (projected ${formatCents(projected)}).`;
  }

  return {
    department,
    budgetCents,
    spentToDateCents,
    projectedCents: projected,
    pctOverBudget,
    trendingOver,
    confidence,
    message,
  };
}
