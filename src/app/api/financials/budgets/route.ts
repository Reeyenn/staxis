/**
 * /api/financials/budgets — per-department monthly budget vs. actual.
 *
 *   GET  ?pid=&month=YYYY-MM   → { month, budgets: BudgetVsActual[] }
 *   POST { pid, department, month, budgetCents|budgetDollars, notes? } → upsert,
 *          returns the refreshed budgets list.
 *
 * Actual = sum of checkbook expenses for that dept/month (computed live), so a
 * budget can never drift from the real ledger. Money is integer cents.
 */

import type { NextRequest } from 'next/server';
import { requireFinanceAccess } from '@/lib/financials/api-gate';
import { ok, err } from '@/lib/api-response';
import { isDepartment, isMonthKey, parseDollarsToCents, monthKey } from '@/lib/financials/shared';
import { validateInt } from '@/lib/api-validate';
import { budgetVsActual, upsertBudget } from '@/lib/financials/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const pid = req.nextUrl.searchParams.get('pid');
  const gate = await requireFinanceAccess(req, pid);
  if (!gate.ok) return gate.response;

  const monthParam = req.nextUrl.searchParams.get('month');
  const month = monthParam && isMonthKey(monthParam) ? monthParam : monthKey(new Date());

  try {
    const budgets = await budgetVsActual(gate.pid, month);
    return ok({ month, budgets }, { requestId: gate.requestId });
  } catch {
    return err('failed to load budgets', { requestId: gate.requestId, status: 500, code: 'load_failed' });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const gate = await requireFinanceAccess(req, body.pid as string | undefined);
  if (!gate.ok) return gate.response;

  if (!isDepartment(body.department)) {
    return err('department is invalid', { requestId: gate.requestId, status: 400, code: 'invalid_department' });
  }
  if (!isMonthKey(body.month)) {
    return err('month must be YYYY-MM', { requestId: gate.requestId, status: 400, code: 'invalid_month' });
  }

  let budgetCents: number | null = null;
  if (body.budgetCents !== undefined && body.budgetCents !== null) {
    const r = validateInt(body.budgetCents, { min: 0, max: 1_000_000_000_00, label: 'budgetCents' });
    if (r.error) return err(r.error, { requestId: gate.requestId, status: 400, code: 'invalid_amount' });
    budgetCents = r.value ?? null;
  } else if (body.budgetDollars !== undefined) {
    budgetCents = parseDollarsToCents(body.budgetDollars as string);
  }
  if (budgetCents == null || budgetCents < 0) {
    return err('budget must be a non-negative number', { requestId: gate.requestId, status: 400, code: 'invalid_amount' });
  }

  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 500) : null;

  try {
    await upsertBudget(gate.pid, body.department, body.month, budgetCents, notes);
    const budgets = await budgetVsActual(gate.pid, body.month);
    return ok({ month: body.month, budgets }, { requestId: gate.requestId });
  } catch {
    return err('failed to save budget', { requestId: gate.requestId, status: 500, code: 'save_failed' });
  }
}
