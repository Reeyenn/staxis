// ─── Financials assistant tools ───────────────────────────────────────────
// Plain-English Q&A over the finance suite: "how much did we spend on
// maintenance last month?", "are we over budget anywhere?", "what's our profit
// this month?". Chat-only (no surfaces declared → default ['chat']) and gated to
// owner / general_manager / admin — finance is never exposed to front-desk /
// housekeeping / maintenance / staff, matching the page + every /api route.
//
// All reads go through the same property-scoped financials/db helpers the API
// uses, so the agent can never see another hotel's books (ctx.propertyId scope).

import { registerTool, type ToolContext, type ToolResult } from '../tools';
import {
  priorMonthKey,
  formatCents,
  departmentLabel,
  isDepartment,
  DEPARTMENTS,
  type Department,
} from '@/lib/financials/shared';
import { getFinanceSummary, budgetVsActual, sumExpensesByDepartment } from '@/lib/financials/db';
import { canForProperty } from '@/lib/capabilities/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { inventoryMonthKeyInZone } from '@/lib/inventory-month-close';

type Period = 'this_month' | 'last_month';
const FINANCE_ROLES = ['admin', 'owner', 'general_manager'] as const;

// Per-hotel money gate. `allowedRoles: FINANCE_ROLES` (enforced in executeTool)
// is a STATIC role check — it can't see a per-hotel override that an admin used
// to RESTRICT a specific manager from Financials. This honors that override at
// THIS property, so a manager pulled off the books can't get the numbers by
// asking the assistant. view_financials is a MANAGER_FLOOR cap, so line staff
// are denied here too (defense in depth). (Access cleanup 2026-06-26.)
async function financeGuard(ctx: ToolContext): Promise<ToolResult | null> {
  if (await canForProperty({ role: ctx.user.role }, 'view_financials', ctx.propertyId)) {
    return null;
  }
  return { ok: false, error: 'Financials are restricted for your role at this property.' };
}

function financeMonthTimezone(value: unknown): string {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : 'America/Chicago';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return 'America/Chicago';
  }
}

async function resolveMonth(ctx: ToolContext, period?: Period): Promise<{ month: string; label: string }> {
  // Resolve "this month" in the PROPERTY's timezone, not the server's. On
  // Vercel the server runs in UTC, so a raw new Date() flips to the next month
  // several hours early for US hotels on the evening of the last day of the
  // month — the assistant would then report the wrong month's numbers. Mirror
  // the inventory accounting tool (resolveInventoryAccountingMonth), which is
  // already timezone-correct.
  const { data } = await supabaseAdmin
    .from('properties')
    .select('timezone')
    .eq('id', ctx.propertyId)
    .maybeSingle();
  const tz = financeMonthTimezone((data as { timezone?: string | null } | null)?.timezone);
  const current = inventoryMonthKeyInZone(new Date(), tz);
  if (period === 'last_month') {
    return { month: priorMonthKey(current), label: 'last month' };
  }
  return { month: current, label: 'this month' };
}

// ─── get_finance_summary ───────────────────────────────────────────────────
registerTool<{ period?: Period }>({
  name: 'get_finance_summary',
  section: 'financials',
  description:
    'Get the CHECKBOOK finance summary for a month: revenue (from the PMS), total expenses, profit, cost per occupied room, and expenses as a % of revenue. Use for overall financial performance. If the question specifically mentions inventory, supplies, shelf value, deliveries, or inventory usage, use get_inventory_monthly_accounting instead. Period defaults to this month.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Which month.' },
    },
  },
  allowedRoles: FINANCE_ROLES,
  requiresCapability: 'view_financials',
  handler: async ({ period }, ctx): Promise<ToolResult> => {
    const denied = await financeGuard(ctx);
    if (denied) return denied;
    const { month, label } = await resolveMonth(ctx, period);
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
  section: 'financials',
  description:
    'Check CHECKBOOK EXPENSE budgets by department and whether recorded expenses are over them. Use for general operating-expense questions such as payroll/checkbook housekeeping expenses. Never use for an inventory/supplies/linen budget or "housekeeping inventory budget"; use get_inventory_monthly_accounting because inventory budgets compare closed usage, not expenses or shelf value. Period defaults to this month.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Which month.' },
    },
  },
  allowedRoles: FINANCE_ROLES,
  requiresCapability: 'view_financials',
  handler: async ({ period }, ctx): Promise<ToolResult> => {
    const denied = await financeGuard(ctx);
    if (denied) return denied;
    const { month, label } = await resolveMonth(ctx, period);
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
  section: 'financials',
  description:
    'Get CHECKBOOK EXPENSES recorded in a department for a month (e.g. a maintenance invoice entered in Financials). If the question mentions inventory, supplies, deliveries, shelf value, or usage, use get_inventory_monthly_accounting instead. If no department is given, returns the checkbook breakdown across all departments. Period defaults to this month.',
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
    const denied = await financeGuard(ctx);
    if (denied) return denied;
    const { month, label } = await resolveMonth(ctx, period);
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
