/**
 * /api/financials/summary — month finance summary.
 *
 *   GET ?pid=&month=YYYY-MM → FinanceSummary
 *
 * Profit = PMS revenue (pms_revenue_daily — the SAME source the owner Dashboard
 * reads) minus checkbook expenses, computed live. Also returns cost-per-occupied-
 * room and expenses-as-%-of-revenue. Revenue is null (not 0) when the PMS doesn't
 * expose financials yet, so the UI shows an honest cold-start instead of fake $0.
 *
 * This endpoint backs BOTH the Financials page header AND the Dashboard finance
 * tile, guaranteeing the two surfaces never disagree on revenue/profit.
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { isMonthKey, monthKey } from '@/lib/financials/shared';
import { getFinanceSummary } from '@/lib/financials/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireFinanceAccess(req, pid);
  if (!gate.ok) return gate.response;

  const monthParam = req.nextUrl.searchParams.get('month');
  const month = monthParam && isMonthKey(monthParam) ? monthParam : monthKey(new Date());

  try {
    const summary = await getFinanceSummary(gate.pid, month);
    return ok({ summary }, { requestId: gate.requestId });
  } catch {
    return err('failed to load summary', { requestId: gate.requestId, status: 500, code: 'load_failed' });
  }
}
