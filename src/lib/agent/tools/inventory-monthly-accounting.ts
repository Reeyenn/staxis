// ─── Ask Staxis: monthly inventory accounting ─────────────────────────────
//
// Read-only bridge to Inventory's accounting source of truth. This tool is
// intentionally separate from Financials' checkbook/expense-budget tools:
//
//   shelf value       = what the hotel owns right now
//   received purchases = deliveries received during the month
//   actual usage      = beginning + confirmed purchases - ending
//   usage budget      = the cap compared only with a full closed-month actual
//
// Closed usage and its budget come from immutable month-close evidence via
// getInventoryAccountingSummary; the agent never re-derives or substitutes a
// live purchase total for usage.

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  getInventoryAccountingSummary,
  localMonthWindowUTC,
  type AccountingSummary,
  type CategoryAccountingRow,
  type InventoryActualStatus,
} from '@/lib/db/inventory-accounting';
import {
  inventoryMonthKeyInZone,
  shiftInventoryMonthKey,
} from '@/lib/inventory-month-close';
import { formatCents } from '@/lib/financials/shared';
import { registerTool, type ToolResult } from '../tools';

export type InventoryAccountingPeriod = 'this_month' | 'last_month';
export type InventoryAccountingScope = 'all' | 'housekeeping' | 'maintenance' | 'breakfast';

interface InventoryAccountingArgs {
  period?: InventoryAccountingPeriod;
  /** Explicit hotel-calendar month. Wins over period when supplied. */
  month?: string;
  category?: InventoryAccountingScope;
}

export interface InventoryShelfEvidence {
  knownValueDollars: number;
  complete: boolean;
  missingCostItemCount: number;
}

type AccountingSource = {
  totals: Pick<AccountingSummary['totals'],
    | 'openingValue'
    | 'loggedPurchasesValue'
    | 'knownLoggedPurchasesValue'
    | 'purchasesValue'
    | 'closingValue'
    | 'actualUsageValue'
    | 'actualStatus'
    | 'allocation'
    | 'isPartial'
    | 'budgetComparisonAvailable'
    | 'budgetCents'
    | 'remainingCents'
    | 'hasCustomBudgetAllocation'
  >;
  byCategory: Array<Pick<CategoryAccountingRow,
    | 'category'
    | 'receiptsValue'
    | 'actualUsageValue'
    | 'budgetCents'
    | 'remainingCents'
  >>;
};

export interface InventoryMoneyValue {
  cents: number;
  display: string;
}

export interface InventoryMonthlyAccountingView {
  month: string;
  category: InventoryAccountingScope;
  categoryLabel: string;
  shelfValueNow: {
    knownValue: InventoryMoneyValue;
    complete: boolean;
    missingCostItemCount: number;
    budgetTreatment: 'does_not_count';
    meaning: string;
  };
  receivedPurchases: {
    knownValue: InventoryMoneyValue;
    complete: boolean;
    confirmedForClose: InventoryMoneyValue | null;
    budgetTreatment: 'formula_input_not_actual_usage';
    meaning: string;
  };
  actualUsage: {
    value: InventoryMoneyValue | null;
    status: InventoryActualStatus;
    formula: 'beginning inventory + confirmed purchases - ending inventory';
    equation: {
      beginningInventory: InventoryMoneyValue;
      confirmedPurchases: InventoryMoneyValue;
      endingInventory: InventoryMoneyValue;
    } | null;
    evidence: 'immutable_month_close' | 'not_closed';
    meaning: string;
  };
  usageBudget: {
    value: InventoryMoneyValue | null;
    evidence: 'immutable_close_snapshot' | 'current_plan';
    comparisonAvailable: boolean;
    status: 'not_set' | 'pending' | 'within' | 'over';
    remaining: InventoryMoneyValue | null;
    overBy: InventoryMoneyValue | null;
    meaning: string;
  };
  notes: string[];
}

const MONTH_RX = /^\d{4}-(0[1-9]|1[0-2])$/;

export function resolveInventoryAccountingMonth(
  args: Pick<InventoryAccountingArgs, 'month' | 'period'>,
  timezone: string,
  now: Date = new Date(),
): string | null {
  const explicit = args.month?.trim();
  if (explicit) return MONTH_RX.test(explicit) ? explicit : null;
  const current = inventoryMonthKeyInZone(now, timezone);
  return args.period === 'last_month' ? shiftInventoryMonthKey(current, -1) : current;
}

function moneyFromDollars(value: number): InventoryMoneyValue {
  const cents = Math.round(value * 100);
  return { cents, display: formatCents(cents) };
}

function moneyFromCents(value: number): InventoryMoneyValue {
  const cents = Math.round(value);
  return { cents, display: formatCents(cents) };
}

function categoryLabel(category: InventoryAccountingScope): string {
  if (category === 'all') return 'All inventory';
  return `${category[0].toUpperCase()}${category.slice(1)} inventory`;
}

function inventoryAccountingTimezone(value: unknown): string {
  const candidate = typeof value === 'string' && value.trim()
    ? value.trim()
    : 'America/Chicago';
  try {
    // Constructing the formatter validates the IANA identifier without tying
    // the answer to the server's own timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return 'America/Chicago';
  }
}

function categoryRow(
  summary: AccountingSource,
  category: Exclude<InventoryAccountingScope, 'all'>,
): AccountingSource['byCategory'][number] | null {
  return summary.byCategory.find((row) => row.category === category) ?? null;
}

/** Build the compact, explicit contract sent back to the model. Exported so
 * the no-substitution accounting rules stay testable without a database. */
export function buildInventoryMonthlyAccountingView(
  month: string,
  category: InventoryAccountingScope,
  summary: AccountingSource,
  shelf: InventoryShelfEvidence,
): InventoryMonthlyAccountingView {
  const row = category === 'all' ? null : categoryRow(summary, category);
  const closed = summary.totals.actualStatus !== 'pending';
  const totalOnlyCategory = category !== 'all'
    && closed
    && summary.totals.allocation === 'total_only';
  const actualStatus: InventoryActualStatus = totalOnlyCategory
    ? 'unallocated'
    : summary.totals.actualStatus;
  const actualDollars = category === 'all'
    ? summary.totals.actualUsageValue
    : row?.actualUsageValue ?? null;
  const budgetCents = category === 'all'
    ? summary.totals.budgetCents
    : row?.budgetCents ?? null;
  const remainingCents = category === 'all'
    ? summary.totals.remainingCents
    : row?.remainingCents ?? null;
  // A manual-total close is unallocated only at category level. Its whole-
  // inventory actual is still complete and may be compared with the frozen
  // whole-inventory usage cap (the same rule as resolveInventoryBudgetActual).
  const actualComparable = category === 'all'
    ? actualStatus === 'complete' || actualStatus === 'unallocated'
    : actualStatus === 'complete';
  const comparisonAvailable = summary.totals.budgetComparisonAvailable
    && actualComparable
    && actualDollars != null
    && budgetCents != null
    && remainingCents != null;
  const budgetStatus = budgetCents == null
    ? 'not_set'
    : !comparisonAvailable
      ? 'pending'
      : remainingCents! < 0
        ? 'over'
        : 'within';

  const loggedKnownDollars = category === 'all'
    ? summary.totals.knownLoggedPurchasesValue
    : row?.receiptsValue ?? 0;
  const confirmedDollars = category === 'all'
    ? summary.totals.purchasesValue
    : closed && summary.totals.allocation === 'itemized'
      ? row?.receiptsValue ?? null
      : null;

  const notes: string[] = [];
  if (!shelf.complete) {
    notes.push('Shelf value is a known minimum because one or more stocked items are missing cost.');
  }
  if (summary.totals.loggedPurchasesValue == null) {
    notes.push('The received-purchase ledger is incomplete; report the known amount as at least that value.');
  }
  if (actualStatus === 'pending') {
    notes.push('Actual usage is pending until the month has a completed inventory close. Do not use purchases or shelf value as the actual.');
  } else if (actualStatus === 'partial') {
    notes.push('This is a partial first tracking period and cannot be compared with a full-month budget.');
  } else if (actualStatus === 'unallocated') {
    notes.push(category === 'all'
      ? 'Total actual usage is closed, but it is not allocated to categories.'
      : 'The month was closed with one total purchase amount, so category usage is unavailable.');
  }
  if (category !== 'all' && budgetCents == null) {
    notes.push('There is no separate usage-budget cap for this category; the hotel may use one total or custom inventory sections.');
  }
  if (summary.totals.hasCustomBudgetAllocation) {
    notes.push('Some usage is assigned to custom inventory budget sections and must not be double-counted in a built-in category.');
  }

  return {
    month,
    category,
    categoryLabel: categoryLabel(category),
    shelfValueNow: {
      knownValue: moneyFromDollars(shelf.knownValueDollars),
      complete: shelf.complete,
      missingCostItemCount: shelf.missingCostItemCount,
      budgetTreatment: 'does_not_count',
      meaning: 'Current on-hand asset value. It is not a monthly purchase or usage actual.',
    },
    receivedPurchases: {
      knownValue: moneyFromDollars(loggedKnownDollars),
      complete: summary.totals.loggedPurchasesValue != null,
      confirmedForClose: confirmedDollars == null ? null : moneyFromDollars(confirmedDollars),
      budgetTreatment: 'formula_input_not_actual_usage',
      meaning: 'Deliveries received during this hotel-calendar month. Purchases feed the close formula but are not the usage actual.',
    },
    actualUsage: {
      value: actualDollars == null ? null : moneyFromDollars(actualDollars),
      status: actualStatus,
      formula: 'beginning inventory + confirmed purchases - ending inventory',
      equation: category === 'all'
        && summary.totals.openingValue != null
        && summary.totals.purchasesValue != null
        && summary.totals.closingValue != null
        ? {
            beginningInventory: moneyFromDollars(summary.totals.openingValue),
            confirmedPurchases: moneyFromDollars(summary.totals.purchasesValue),
            endingInventory: moneyFromDollars(summary.totals.closingValue),
          }
        : null,
      evidence: closed ? 'immutable_month_close' : 'not_closed',
      meaning: 'The cost consumed by the hotel during the tracked month.',
    },
    usageBudget: {
      value: budgetCents == null ? null : moneyFromCents(budgetCents),
      evidence: closed ? 'immutable_close_snapshot' : 'current_plan',
      comparisonAvailable,
      status: budgetStatus,
      remaining: comparisonAvailable && remainingCents! >= 0
        ? moneyFromCents(remainingCents!)
        : null,
      overBy: comparisonAvailable && remainingCents! < 0
        ? moneyFromCents(Math.abs(remainingCents!))
        : null,
      meaning: 'The inventory usage cap. Only a complete full-month actual can be called over or within budget.',
    },
    notes,
  };
}

interface ShelfRow {
  category: string;
  current_stock: number | string | null;
  unit_cost: number | string | null;
}

export function inventoryShelfEvidence(
  rows: readonly ShelfRow[],
  category: InventoryAccountingScope,
): InventoryShelfEvidence {
  let knownValueDollars = 0;
  let missingCostItemCount = 0;
  for (const row of rows) {
    if (category !== 'all' && row.category !== category) continue;
    const stock = Number(row.current_stock ?? 0);
    if (!Number.isFinite(stock) || stock <= 0) continue;
    if (row.unit_cost == null || !Number.isFinite(Number(row.unit_cost))) {
      missingCostItemCount += 1;
      continue;
    }
    knownValueDollars += stock * Number(row.unit_cost);
  }
  return {
    knownValueDollars,
    complete: missingCostItemCount === 0,
    missingCostItemCount,
  };
}

registerTool<InventoryAccountingArgs>({
  name: 'get_inventory_monthly_accounting',
  section: 'inventory',
  requiresCapability: 'view_financials',
  description:
    'Get monthly INVENTORY accounting and usage-budget status, clearly separating current shelf value, received purchases, actual usage, and the inventory usage budget. Use for inventory/supply spending, deliveries, month close, "housekeeping inventory budget", towels/linen/supplies budgets, or whether on-hand stock counts against a budget. Do NOT use generic checkbook expense-budget tools for those questions. Actual usage and over/under status come only from immutable closed-month evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['this_month', 'last_month'],
        description: 'Hotel-calendar month shortcut. Defaults to this month.',
      },
      month: {
        type: 'string',
        pattern: '^\\d{4}-(0[1-9]|1[0-2])$',
        description: 'Specific hotel-calendar month as YYYY-MM. When supplied, this wins over period.',
      },
      category: {
        type: 'string',
        enum: ['all', 'housekeeping', 'maintenance', 'breakfast'],
        description: 'Inventory category. Use housekeeping for a housekeeping inventory/supplies budget question; defaults to all.',
      },
    },
  },
  allowedRoles: ['admin', 'owner', 'general_manager'],
  handler: async ({ period, month, category = 'all' }, ctx): Promise<ToolResult> => {
    if (!['all', 'housekeeping', 'maintenance', 'breakfast'].includes(category)) {
      return { ok: false, error: 'Choose all, housekeeping, maintenance, or breakfast inventory.' };
    }

    const { data: property, error: propertyError } = await supabaseAdmin
      .from('properties')
      .select('timezone')
      .eq('id', ctx.propertyId)
      .maybeSingle();
    if (propertyError) return { ok: false, error: 'Failed to load this hotel\'s inventory calendar.' };
    const timezone = inventoryAccountingTimezone(
      (property as { timezone?: string | null } | null)?.timezone,
    );
    const resolvedMonth = resolveInventoryAccountingMonth({ period, month }, timezone);
    if (!resolvedMonth) return { ok: false, error: 'Month must be written as YYYY-MM.' };

    const [year, month1] = resolvedMonth.split('-').map(Number);
    const window = localMonthWindowUTC(year, month1, timezone);
    try {
      const [summary, shelfResult] = await Promise.all([
        getInventoryAccountingSummary(supabaseAdmin, ctx.propertyId, window.start, {
          endExclusive: window.endExclusive,
          budgetMonthKey: window.budgetMonthKey,
          timeZone: timezone,
        }),
        supabaseAdmin
          .from('inventory')
          .select('category,current_stock,unit_cost')
          .eq('property_id', ctx.propertyId)
          .is('archived_at', null),
      ]);
      if (shelfResult.error) return { ok: false, error: 'Failed to load current shelf value.' };
      const shelf = inventoryShelfEvidence((shelfResult.data ?? []) as ShelfRow[], category);
      return {
        ok: true,
        data: buildInventoryMonthlyAccountingView(resolvedMonth, category, summary, shelf),
      };
    } catch {
      return { ok: false, error: 'Failed to load inventory accounting for that month.' };
    }
  },
});
