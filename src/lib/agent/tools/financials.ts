// ─── Financials assistant tools ───────────────────────────────────────────
// Plain-English Q&A over the finance suite: "how much did we spend on
// maintenance last month?", "are we over budget anywhere?", "what's our profit
// this month?". Chat-only (no surfaces declared → default ['chat']) and gated to
// owner / general_manager / admin — finance is never exposed to front-desk /
// housekeeping / maintenance / staff, matching the page + every /api route.
//
// All reads go through the same property-scoped financials/db helpers the API
// uses, so the agent can never see another hotel's books (ctx.propertyId scope).

import { registerTool, type ToolContext, type ToolHandlerContext, type ToolResult } from '../tools';
import {
  priorMonthKey,
  formatCents,
  departmentLabel,
  isDepartment,
  DEPARTMENTS,
  type Department,
} from '@/lib/financials/shared';
import { getFinanceSummary, budgetVsActual } from '@/lib/financials/db';
import { canForProperty } from '@/lib/capabilities/server';
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

async function resolveMonth(ctx: ToolHandlerContext, period?: Period): Promise<{ month: string; label: string }> {
  // Resolve "this month" in the PROPERTY's timezone, not the server's. On
  // Vercel the server runs in UTC, so a raw new Date() flips to the next month
  // several hours early for US hotels on the evening of the last day of the
  // month — the assistant would then report the wrong month's numbers. Mirror
  // the inventory accounting tool (resolveInventoryAccountingMonth), which is
  // already timezone-correct.
  const { data } = await ctx.db
    .from('properties')
    .select('timezone')
    .maybeSingle();
  const tz = financeMonthTimezone((data as { timezone?: string | null } | null)?.timezone);
  const current = inventoryMonthKeyInZone(new Date(), tz);
  if (period === 'last_month') {
    return { month: priorMonthKey(current), label: 'last month' };
  }
  return { month: current, label: 'this month' };
}

// ─── get_finance_summary ───────────────────────────────────────────────────
// ONE month-of-money tool. Absorbed check_budget_status and get_department_spend
// (2026-07-27), which were three tools over two queries:
//
//   • budgetVsActual() already returns actualCents per department, so
//     get_department_spend's sumExpensesByDepartment() was re-deriving a strict
//     subset of what check_budget_status had already read;
//   • all three carried the same roles, the same view_financials capability and
//     the same section, so the split bought no access control — only a choice
//     the model had to get right before it had seen any of the numbers.
//
// The old descriptions had grown into cross-references ("never use for X, use Y
// instead"), which is what a catalog does instead of merging. One tool answers
// "how did the month go", "are we over anywhere" and "what did maintenance
// spend" from one pair of reads.
registerTool<{ period?: Period; department?: string }>({
  name: 'get_finance_summary',
  section: 'financials',
  description:
    'The hotel\'s CHECKBOOK month: revenue, expenses, profit, cost per occupied room, and every department\'s spend against its budget. ' +
    'Use when: the user asks how the month went, what profit is, what a department spent, whether anyone is over budget, or how much is left — "how are we doing on money", "are we over budget anywhere", "what did maintenance spend last month", "cuánto gastamos". ' +
    'Args: period — "this_month" (default) or "last_month", resolved in the hotel\'s own timezone. department — narrow to one department (front_desk, housekeeping, maintenance, …); omit for the whole hotel plus a per-department breakdown. ' +
    'Returns: revenue / expenses / profit / costPerOccupiedRoom / expensesPctOfRevenue as formatted dollar strings, and byDepartment[] with each department\'s spend, budget, percent used and over/under status. The percentages and remainders are computed here — quote them, do not recompute. ' +
    'Refuses: callers without financial access at this hotel, including a manager an admin has switched off for Financials. This is the CHECKBOOK only — it does not know about inventory usage, deliveries, or shelf value, so send any supplies/linen/towels/inventory-budget question to get_inventory_monthly_accounting instead of answering it from here. Revenue reads "not available yet" until the hotel\'s PMS exposes it; never substitute a guess or call it zero.',
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['this_month', 'last_month'], description: 'Which month. Defaults to this month.' },
      department: {
        type: 'string',
        enum: [...DEPARTMENTS],
        description: 'Narrow the department breakdown to one department. Omit for all of them.',
      },
    },
  },
  allowedRoles: FINANCE_ROLES,
  requiresCapability: 'view_financials',
  handler: async ({ period, department }, ctx): Promise<ToolResult> => {
    const denied = await financeGuard(ctx);
    if (denied) return denied;
    const { month, label } = await resolveMonth(ctx, period);

    // budgetVsActual carries actualCents per department, so the old
    // sumExpensesByDepartment() second read is gone — one query, not two.
    const [s, rows] = await Promise.all([
      getFinanceSummary(ctx.propertyId, month),
      budgetVsActual(ctx.propertyId, month),
    ]);

    const wanted = department && isDepartment(department) ? (department as Department) : null;
    const scoped = wanted ? rows.filter((r) => r.department === wanted) : rows;

    const byDepartment = scoped
      // A department with neither spend nor a budget is noise in the answer.
      .filter((r) => r.actualCents > 0 || r.budgetCents > 0)
      .map((r) => ({
        department: departmentLabel(r.department),
        spend: formatCents(r.actualCents),
        budget: r.budgetCents > 0 ? formatCents(r.budgetCents) : null,
        pctUsed: r.pctUsed != null ? `${Math.round(r.pctUsed)}%` : null,
        // 'over' | 'warn' | 'ok' straight from the finance layer — the model
        // must not decide what "over budget" means from two dollar strings.
        status: r.budgetCents > 0 ? r.status : null,
        remaining: r.budgetCents > 0 ? formatCents(r.remainingCents) : null,
      }));

    const budgeted = scoped.filter((r) => r.budgetCents > 0);
    const over = budgeted.filter((r) => r.status === 'over');

    return {
      ok: true,
      data: {
        month,
        period: label,
        department: wanted ? departmentLabel(wanted) : null,
        revenue: s.revenueCents != null
          ? formatCents(s.revenueCents)
          : 'not available yet (PMS does not expose revenue for this property)',
        expenses: formatCents(s.expensesCents),
        profit: s.profitCents != null ? formatCents(s.profitCents) : 'unknown (revenue not available yet)',
        costPerOccupiedRoom: s.costPerOccupiedRoomCents != null ? formatCents(s.costPerOccupiedRoomCents) : null,
        expensesPctOfRevenue: s.expensesPctOfRevenue != null ? `${s.expensesPctOfRevenue.toFixed(1)}%` : null,
        occupiedRoomNights: s.occupiedRoomNights,
        anyBudgetsSet: budgeted.length > 0,
        byDepartment,
        budgetSummary:
          budgeted.length === 0
            ? 'No department budgets are set for this month yet.'
            : over.length === 0
              ? 'Every department with a budget is within it.'
              : `${over.length} department(s) over budget.`,
        note:
          s.revenueCents == null
            ? 'Revenue auto-flows from the PMS once it exposes financials; expenses and budgets are live now.'
            : undefined,
      },
    };
  },
});
