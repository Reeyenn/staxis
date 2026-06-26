// ─── Financials assistant tools ───────────────────────────────────────────
// Plain-English Q&A over the finance suite: "how much did we spend on
// maintenance last month?", "are we over budget anywhere?", "what's our profit
// this month?". Chat-only (no surfaces declared → default ['chat']) and gated to
// owner / general_manager / admin — finance is never exposed to front-desk /
// housekeeping / maintenance / staff, matching the page + every /api route.
//
// All reads go through the same property-scoped financials/db helpers the API
// uses, so the agent can never see another hotel's books (ctx.propertyId scope).

import { registerTool, type ToolResult } from '../tools';
import {
  monthKey,
  priorMonthKey,
  formatCents,
  departmentLabel,
  isDepartment,
  DEPARTMENTS,
  type Department,
} from '@/lib/financials/shared';
import { getFinanceSummary, budgetVsActual, sumExpensesByDepartment } from '@/lib/financials/db';

type Period = 'this_month' | 'last_month';
const FINANCE_ROLES = ['admin', 'owner', 'general_manager'] as const;

function resolveMonth(period?: Period): { month: string; label: string } {
  const now = new Date();
  if (period === 'last_month') {
    const m = priorMonthKey(monthKey(now));
    return { month: m, label: 'last month' };
  }
  return { month: monthKey(now), label: 'this month' };
}

// ─── get_finance_summary ───────────────────────────────────────────────────
registerTool<{ period?: Period }>({
  name: 'get_finance_summary',
  description:
    'Get the finance summary for a month: revenue (from the PMS), total expenses, profit, cost per occupied room, and expenses as a % of revenue. Use for "how are we doing financially", "what\'s our profit", "how much have we spent". Period defaults to this month.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Which month.' },
    },
  },
  allowedRoles: FINANCE_ROLES,
  requiresCapability: 'view_financials',
  handler: async ({ period }, ctx): Promise<ToolResult> => {
    const { month, label } = resolveMonth(period);
    const s = await getFinanceSummary(ctx.propertyId, month);
    return {
      ok: true,
      data: {
        month,
        period: label,
        revenue: s.revenueCents != null ? formatCents(s.revenueCents) : 'not available yet (PMS does not expose revenue for this property)',
        expenses: formatCents(s.expensesCents),
        profit: s.profitCents != null ? formatCents(s.profitCents) : 'unknown (revenue not available yet)',
        costPerOccupiedRoom: s.costPerOccupiedRoomCents != null ? formatCents(s.costPerOccupiedRoomCents) : null,
        expensesPctOfRevenue: s.expensesPctOfRevenue != null ? `${s.expensesPctOfRevenue.toFixed(1)}%` : null,
        occupiedRoomNights: s.occupiedRoomNights,
        note:
          s.revenueCents == null
            ? 'Revenue auto-flows from the PMS once it exposes financials; expenses and budgets are live now.'
            : undefined,
      },
    };
  },
});

// ─── check_budget_status ───────────────────────────────────────────────────
registerTool<{ period?: Period }>({
  name: 'check_budget_status',
  description:
    'Check whether any department is over (or trending over) its monthly budget, and by how much. Use for "are we over budget anywhere", "how is the housekeeping budget", "which departments are over". Period defaults to this month.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Which month.' },
    },
  },
  allowedRoles: FINANCE_ROLES,
  requiresCapability: 'view_financials',
  handler: async ({ period }, ctx): Promise<ToolResult> => {
    const { month, label } = resolveMonth(period);
    const rows = await budgetVsActual(ctx.propertyId, month);
    const budgeted = rows.filter((r) => r.budgetCents > 0);
    const over = budgeted.filter((r) => r.status === 'over');
    const warn = budgeted.filter((r) => r.status === 'warn');
    return {
      ok: true,
      data: {
        month,
        period: label,
        anyBudgetsSet: budgeted.length > 0,
        overBudget: over.map((r) => ({
          department: departmentLabel(r.department),
          budget: formatCents(r.budgetCents),
          actual: formatCents(r.actualCents),
          over: formatCents(Math.abs(r.remainingCents)),
          pctUsed: r.pctUsed != null ? `${Math.round(r.pctUsed)}%` : null,
        })),
        approachingBudget: warn.map((r) => ({
          department: departmentLabel(r.department),
          budget: formatCents(r.budgetCents),
          actual: formatCents(r.actualCents),
          pctUsed: r.pctUsed != null ? `${Math.round(r.pctUsed)}%` : null,
        })),
        summary:
          budgeted.length === 0
            ? 'No department budgets are set for this month yet.'
            : over.length === 0
              ? 'Every department with a budget is within it.'
              : `${over.length} department(s) over budget.`,
      },
    };
  },
});

// ─── get_department_spend ──────────────────────────────────────────────────
registerTool<{ department?: string; period?: Period }>({
  name: 'get_department_spend',
  description:
    'Get how much was spent in a specific department for a month (e.g. "how much did we spend on maintenance last month"). If no department is given, returns the breakdown across all departments. Period defaults to this month.',
  inputSchema: {
    type: 'object',
    properties: {
      department: {
        type: 'string',
        enum: [...DEPARTMENTS],
        description: 'Department to report on. Omit for a full breakdown.',
      },
      period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Which month.' },
    },
  },
  allowedRoles: FINANCE_ROLES,
  requiresCapability: 'view_financials',
  handler: async ({ department, period }, ctx): Promise<ToolResult> => {
    const { month, label } = resolveMonth(period);
    const byDept = await sumExpensesByDepartment(ctx.propertyId, month);
    if (department && isDepartment(department)) {
      const dept = department as Department;
      return {
        ok: true,
        data: { month, period: label, department: departmentLabel(dept), spend: formatCents(byDept[dept] ?? 0) },
      };
    }
    const total = Object.values(byDept).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      data: {
        month,
        period: label,
        total: formatCents(total),
        byDepartment: DEPARTMENTS.filter((d) => (byDept[d] ?? 0) > 0).map((d) => ({
          department: departmentLabel(d),
          spend: formatCents(byDept[d] ?? 0),
        })),
      },
    };
  },
});
