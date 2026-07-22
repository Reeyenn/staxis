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
import { supabaseAdmin } from '@/lib/supabase-admin';
import { todayInTz } from '@/lib/forecast';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireFinanceAccess(req, pid);
  if (!gate.ok) return gate.response;

  const monthParam = req.nextUrl.searchParams.get('month');
  const month = monthParam && isMonthKey(monthParam) ? monthParam : monthKey(new Date());

  try {
    // Pace the projection against the property's LOCAL day-of-month, not UTC.
    // A raw new Date() on Vercel (server TZ = UTC) advances the day-of-month
    // several hours early each evening for US-timezone hotels, inflating
    // daysElapsed and skewing the end-of-month spend projection. Mirror the
    // sibling /api/dashboard/labor-cost route's timezone anchor.
    const { data: propRow } = await supabaseAdmin
      .from('properties')
      .select('timezone')
      .eq('id', gate.pid)
      .maybeSingle<{ timezone: string | null }>();
    const timezone = propRow?.timezone || 'America/Chicago';
    const todayISO = todayInTz(timezone);
    // Anchor at UTC midnight of the LOCAL date so daysElapsedInMonth's
    // getUTCDate()/monthKey() read the property-local day-of-month.
    const localAnchor = new Date(`${todayISO}T00:00:00Z`);
    const dim = daysInMonthOf(month);
    const elapsed = daysElapsedInMonth(month, localAnchor);

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
