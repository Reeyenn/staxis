/**
 * /api/financials/forecast — mid-month overspend forecast + spend anomalies.
 *
 *   GET ?pid=&month=YYYY-MM → { month, daysElapsed, daysInMonth, forecasts[],
 *                               anomalies[], confidence }
 *
 * For each department: project end-of-month spend from spend-to-date paced by
 * days elapsed, adjusted by the PMS occupancy forecast for the rest of the month
 * (when available), and flag "trending X% over budget". Anomalies compare this
 * month's per-department spend to last month's. Pure-math engines; honest cold
 * start (low-confidence early in the month / with no spend → no false alarms).
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import {
  isMonthKey,
  monthKey,
  daysInMonth as daysInMonthOf,
  daysElapsedInMonth,
  priorMonthKey,
} from '@/lib/financials/shared';
import { budgetVsActual, sumExpensesByDepartment } from '@/lib/financials/db';
import { getOccupancyPacingFactor } from '@/lib/financials/revenue';
import { forecastDepartmentOverspend } from '@/lib/financials/forecast';
import { detectDepartmentSpikes } from '@/lib/financials/anomaly';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireFinanceAccess(req, pid);
  if (!gate.ok) return gate.response;

  const monthParam = req.nextUrl.searchParams.get('month');
  const month = monthParam && isMonthKey(monthParam) ? monthParam : monthKey(new Date());

  try {
    const now = new Date();
    const todayISO = now.toISOString().slice(0, 10);
    const dim = daysInMonthOf(month);
    const elapsed = daysElapsedInMonth(month, now);

    const [vsActual, priorByDept, occFactor] = await Promise.all([
      budgetVsActual(gate.pid, month),
      sumExpensesByDepartment(gate.pid, priorMonthKey(month)),
      getOccupancyPacingFactor(gate.pid, month, todayISO),
    ]);

    const forecasts = vsActual
      .filter((b) => b.budgetCents > 0 || b.actualCents > 0)
      .map((b) =>
        forecastDepartmentOverspend(b.department, b.budgetCents, b.actualCents, elapsed, dim, occFactor),
      );

    const currentByDept = Object.fromEntries(vsActual.map((b) => [b.department, b.actualCents])) as Record<
      (typeof vsActual)[number]['department'],
      number
    >;
    const anomalies = detectDepartmentSpikes(currentByDept, priorByDept);

    return ok(
      {
        month,
        daysElapsed: elapsed,
        daysInMonth: dim,
        occupancyAdjusted: occFactor != null,
        forecasts,
        anomalies,
      },
      { requestId: gate.requestId },
    );
  } catch {
    return err('failed to build forecast', { requestId: gate.requestId, status: 500, code: 'forecast_failed' });
  }
}
