// ─── Financials assistant tools ───────────────────────────────────────────
// Plain-English Q&A over the finance suite: "how much did we spend on
// maintenance last month?", "are we over budget anywhere?", "what's our profit
// this month?". Chat-only (no surfaces declared → default ['chat']) and gated to
// owner / general_manager / admin by role. A front_desk operational standing
// can reach these reads only when executeTool freshly proves its separate
// `seesFinancials` entitlement (the company-finance path); ordinary front desk,
// housekeeping, maintenance and staff remain excluded.
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
import { canViewFinancials } from '@/lib/roles';

type Period = 'this_month' | 'last_month';
const FINANCE_ROLES = ['admin', 'owner', 'general_manager'] as const;

// Per-hotel money gate. The executor has already replaced the route snapshot
// with a fresh authoritative standing, so `seesFinancials` is the prerequisite
// here. True hotel managers then honor Access-tab role overrides. A company
// finance hat remains operationally front_desk and cannot be run through that
// legacy manager-floor resolver; its explicit read bit is the grant, exactly as
// in requireFinanceAccess. This never admits a mutation (all tools here read).
async function financeGuard(ctx: ToolContext): Promise<ToolResult | null> {
  if (ctx.user.seesFinancials !== true) {
    return { ok: false, error: 'Financials are restricted for your role at this property.' };
  }
  if (!canViewFinancials(ctx.user.role)) return null;
  return await canForProperty({ role: ctx.user.role }, 'view_financials', ctx.propertyId)
    ? null
    : { ok: false, error: 'Financials are restricted for your role at this property.' };
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

// ─── Derived figures: computed HERE so the model never has to ──────────────
//
// The number-honesty guard (src/lib/agent/number-guard.ts) refuses any figure
// the model worked out itself, and the prompt tells it not to try. That is only
// fair if the figures managers actually ask for are already ON the tool result.
// The three below are the ones this tool was being asked to produce by mental
// arithmetic:
//
//   "are we on pace?"          → a budget percentage means nothing without how
//                                far into the month you are. 61% used is fine
//                                on the 25th and alarming on the 8th, and the
//                                model was computing that day count in prose.
//   "what's the biggest slice?" → each department's share of the month's spend.
//   "what's that per room?"    → spend ÷ occupied room-nights, per department.
//                                The hotel-wide version already existed
//                                (costPerOccupiedRoom); the per-department one
//                                is the question people actually ask.
//
// Pure and exported so the arithmetic is pinned by a test rather than trusted.

export interface MonthPace {
  /** Days of the month that have happened, in the hotel's own timezone. */
  dayOfMonth: number;
  daysInMonth: number;
  /** Whole percent of the month elapsed. */
  pctElapsed: number;
}

/**
 * How far into `monthKey` the hotel is, in ITS timezone.
 *
 * A month that is not the hotel's current month is COMPLETE — "last month" is
 * 100% elapsed, and saying otherwise would make every closed month look like it
 * was still filling up. Returns null on a malformed key rather than guessing.
 */
export function monthPace(monthKey: string, tz: string, now: Date): MonthPace | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  // Day 0 of the NEXT month is the last day of this one.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  let dayOfMonth = daysInMonth;
  if (inventoryMonthKeyInZone(now, tz) === monthKey) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(now);
    const day = Number(parts);
    if (!Number.isFinite(day)) return null;
    dayOfMonth = Math.min(Math.max(day, 1), daysInMonth);
  }
  return { dayOfMonth, daysInMonth, pctElapsed: Math.round((dayOfMonth / daysInMonth) * 100) };
}

/**
 * `part` as a whole percent of `total`.
 *
 * Null when the total is zero or negative: "0% of nothing" reads as a fact
 * about spending when it is a fact about there being no denominator, and a
 * field that is absent cannot be misread.
 */
export function pctOfTotal(partCents: number, totalCents: number): number | null {
  if (!Number.isFinite(partCents) || !Number.isFinite(totalCents) || totalCents <= 0) return null;
  return Math.round((partCents / totalCents) * 100);
}

/** Whole cents of `spendCents` per occupied room-night, or null when the hotel
 *  has no occupancy for the month (dividing by it would invent a figure). */
export function centsPerOccupiedRoom(spendCents: number, occupiedRoomNights: number): number | null {
  if (!Number.isFinite(spendCents) || !Number.isFinite(occupiedRoomNights)) return null;
  if (occupiedRoomNights <= 0) return null;
  return Math.round(spendCents / occupiedRoomNights);
}

export interface PlannedSpendImpact {
  pctOfBudget: number;
  remainingAfterCents: number;
  wouldExceed: boolean;
}

/**
 * "We're about to spend $600 — what share of the budget is that, and does it
 * fit?" Computed here so the answer is a quote.
 *
 * ADDED BECAUSE OF A LIVE SMOKE, and the failure it found is worth recording.
 * With the number-honesty rule in the prompt and no tool that could answer
 * this, Sonnet did the *rule-abiding* thing and the *wrong* thing: it refused
 * the manager's actual question — "I can't calculate that here… you'd want to
 * check that math on your end" — and then explained its own constraint back to
 * the user. A manager who asks what 600 is against 3,500 and is told to work it
 * out themselves has been failed by the guard, not protected by it.
 *
 * That is the trap this whole layer has to avoid: a rule the model can only
 * satisfy by being useless. The fix is never to loosen the rule (the model's
 * arithmetic would then be unbacked and the guard would retract a correct
 * answer); it is to make sure the figure people ask for is ALREADY THERE.
 * Every future "the model wouldn't answer X" belongs here, not in the prompt.
 *
 * Null when there is no budget to be a percentage of.
 */
export function plannedSpendImpact(
  plannedCents: number,
  budgetCents: number,
  actualCents: number,
): PlannedSpendImpact | null {
  if (!Number.isFinite(plannedCents) || plannedCents < 0) return null;
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) return null;
  if (!Number.isFinite(actualCents)) return null;
  const remainingAfterCents = budgetCents - actualCents - plannedCents;
  return {
    pctOfBudget: Math.round((plannedCents / budgetCents) * 100),
    remainingAfterCents,
    // Strictly negative: spending the budget to the cent is not exceeding it.
    wouldExceed: remainingAfterCents < 0,
  };
}

async function resolveMonth(
  ctx: ToolHandlerContext,
  period?: Period,
): Promise<{ month: string; label: string; tz: string }> {
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
    return { month: priorMonthKey(current), label: 'last month', tz };
  }
  return { month: current, label: 'this month', tz };
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
registerTool<{ period?: Period; department?: string; plannedSpendDollars?: number }>({
  name: 'get_finance_summary',
  section: 'financials',
  description:
    'The hotel\'s CHECKBOOK month: revenue, expenses, profit, cost per occupied room, and every department\'s spend against its budget. ' +
    'Use when: the user asks how the month went, what profit is, what a department spent, whether anyone is over budget, or how much is left — "how are we doing on money", "are we over budget anywhere", "what did maintenance spend last month", "cuánto gastamos". ' +
    'Args: period — "this_month" (default) or "last_month", resolved in the hotel\'s own timezone. department — narrow to one department (front_desk, housekeeping, maintenance, …); omit for the whole hotel plus a per-department breakdown. plannedSpendDollars — pass this WHENEVER the user names an amount they are thinking of spending ("we\'re about to spend $600 on a PTAC", "can we afford a $1,200 repair", "¿nos alcanza para $400?"); it comes back as a share of the budget and what would be left, so you never have to work it out. Pass `department` with it when they said which department. ' +
    'Returns: revenue / expenses / profit / costPerOccupiedRoom / expensesPctOfRevenue as formatted dollar strings; monthProgress with how far into the month the hotel is (dayOfMonth, daysInMonth, pctElapsed); plannedSpend when you passed an amount (its share of the budget and what would be left); and byDepartment[] with each department\'s spend, budget, percent used, over/under status, what is left, its share of the hotel\'s total spend (pctOfHotelSpend) and its spend per occupied room (spendPerOccupiedRoom). EVERY percentage, share, remainder and per-room figure is computed here — quote them exactly and never work one out yourself. "Are we on pace?" is pctUsed against pctElapsed, both of which are on this result. ' +
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
      plannedSpendDollars: {
        type: 'number',
        description: 'An amount the user is considering spending, in dollars. Returns it as a share of the budget and what would be left afterwards.',
      },
    },
  },
  allowedRoles: FINANCE_ROLES,
  requiresCapability: 'view_financials',
  handler: async ({ period, department, plannedSpendDollars }, ctx): Promise<ToolResult> => {
    const denied = await financeGuard(ctx);
    if (denied) return denied;
    const { month, label, tz } = await resolveMonth(ctx, period);

    // budgetVsActual carries actualCents per department, so the old
    // sumExpensesByDepartment() second read is gone — one query, not two.
    const [s, rows] = await Promise.all([
      getFinanceSummary(ctx.propertyId, month),
      budgetVsActual(ctx.propertyId, month),
    ]);

    const wanted = department && isDepartment(department) ? (department as Department) : null;
    const scoped = wanted ? rows.filter((r) => r.department === wanted) : rows;

    // Share-of-spend is a share of the WHOLE hotel's expenses, not of the
    // filtered subset: asking about one department must not silently redefine
    // it as 100% of everything.
    const hotelExpensesCents = rows.reduce((sum, r) => sum + r.actualCents, 0);
    const occupiedRoomNights = s.occupiedRoomNights ?? 0;

    const byDepartment = scoped
      // A department with neither spend nor a budget is noise in the answer.
      .filter((r) => r.actualCents > 0 || r.budgetCents > 0)
      .map((r) => {
        const share = pctOfTotal(r.actualCents, hotelExpensesCents);
        const perRoom = centsPerOccupiedRoom(r.actualCents, occupiedRoomNights);
        return {
          department: departmentLabel(r.department),
          spend: formatCents(r.actualCents),
          budget: r.budgetCents > 0 ? formatCents(r.budgetCents) : null,
          pctUsed: r.pctUsed != null ? `${Math.round(r.pctUsed)}%` : null,
          // 'over' | 'warn' | 'ok' straight from the finance layer — the model
          // must not decide what "over budget" means from two dollar strings.
          status: r.budgetCents > 0 ? r.status : null,
          remaining: r.budgetCents > 0 ? formatCents(r.remainingCents) : null,
          // Derived here so the model quotes instead of dividing. Absent rather
          // than zero when the denominator is missing.
          pctOfHotelSpend: share != null ? `${share}%` : null,
          spendPerOccupiedRoom: perRoom != null ? formatCents(perRoom) : null,
        };
      });

    const budgeted = scoped.filter((r) => r.budgetCents > 0);
    const over = budgeted.filter((r) => r.status === 'over');
    const pace = monthPace(month, tz, new Date());

    // Against the SCOPED budget: with `department` set that is one department's
    // budget, otherwise the sum of the budgets in view. Either way it is the
    // same set the rest of this answer is about, so "26% of budget" cannot mean
    // one thing in one sentence and another in the next.
    const scopedBudgetCents = budgeted.reduce((sum, r) => sum + r.budgetCents, 0);
    const scopedActualCents = budgeted.reduce((sum, r) => sum + r.actualCents, 0);
    const plannedCents = typeof plannedSpendDollars === 'number' && Number.isFinite(plannedSpendDollars)
      ? Math.round(plannedSpendDollars * 100)
      : null;
    const impact = plannedCents === null
      ? null
      : plannedSpendImpact(plannedCents, scopedBudgetCents, scopedActualCents);

    return {
      ok: true,
      data: {
        month,
        period: label,
        // "Are we on pace?" needs a denominator. Without this the model was
        // counting days in prose to answer it.
        monthProgress: pace
          ? {
              dayOfMonth: pace.dayOfMonth,
              daysInMonth: pace.daysInMonth,
              pctElapsed: `${pace.pctElapsed}%`,
              // Guidance for the model. Kept SHORT because a model will
              // sometimes recite a payload note verbatim, and a manager should
              // never be shown this file's field names.
              note: 'On pace = percent of budget used vs percent of month elapsed. Quote both; never project a total.',
            }
          : null,
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
        // Present only when the user named an amount. When they named one and
        // there is no budget to compare it against, this says so rather than
        // going missing — "I have no budget on file for that" is the answer,
        // and a silently absent field would be answered with a guess instead.
        plannedSpend: plannedCents === null
          ? null
          : impact
            ? {
                amount: formatCents(plannedCents),
                scope: wanted ? departmentLabel(wanted) : 'all budgeted departments',
                budget: formatCents(scopedBudgetCents),
                pctOfBudget: `${impact.pctOfBudget}%`,
                remainingAfter: formatCents(impact.remainingAfterCents),
                wouldExceed: impact.wouldExceed,
              }
            : {
                amount: formatCents(plannedCents),
                scope: wanted ? departmentLabel(wanted) : 'all budgeted departments',
                note: 'No budget is set for that, so there is no percentage to give. Say that plainly instead of estimating one.',
              },
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
