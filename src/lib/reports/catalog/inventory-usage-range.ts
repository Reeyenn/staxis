/**
 * Pure range planning + aggregation for the catalog's Inventory usage report.
 *
 * Inventory usage is finalized at calendar-month close. A selected date range
 * may therefore consume only closed months that it covers in full; edge months
 * are never prorated or silently widened to a whole month.
 */

export type InventoryUsageStatus = 'pending' | 'complete' | 'partial' | 'unallocated';
export type InventoryUsageAllocation = 'pending' | 'itemized' | 'total_only';

export interface InventoryUsageRangePlan {
  /** Calendar months fully contained in the inclusive selected range. */
  fullMonths: string[];
  /** Intersecting edge months that cannot contribute a monthly close actual. */
  partialMonths: string[];
}

export interface InventoryUsageCategoryPeriod {
  category: string;
  actualCents: number | null;
  purchasesCents: number;
  budgetCents: number | null;
  discardsCents: number | null;
  knownDiscardsCents?: number;
  discardsComplete?: boolean;
}

export interface InventoryUsagePeriod {
  month: string;
  actualStatus: InventoryUsageStatus;
  actualCents: number | null;
  allocation: InventoryUsageAllocation;
  isPartial: boolean;
  hasCustomBudgetAllocation: boolean;
  budgetComparisonAvailable: boolean;
  purchasesCents: number | null;
  knownPurchasesCents: number;
  budgetCents: number | null;
  discardsCents: number | null;
  knownDiscardsCents?: number;
  discardsComplete?: boolean;
  categories: InventoryUsageCategoryPeriod[];
}

export interface InventoryUsageCategoryAggregate {
  category: string;
  actualCents: number;
  purchasesCents: number;
  budgetCents: number | null;
  remainingCents: number | null;
  discardsCents: number | null;
  knownDiscardsCents: number;
  discardsComplete: boolean;
}

export interface InventoryUsageRangeAggregate {
  expectedMonths: number;
  closedMonths: number;
  pendingMonths: number;
  partialEdgeMonths: number;
  partialTrackingPeriods: number;
  totalOnlyPeriods: number;
  customAllocationPeriods: number;
  actualCents: number | null;
  purchasesCents: number | null;
  knownPurchasesCents: number;
  purchasesComplete: boolean;
  budgetCents: number | null;
  remainingCents: number | null;
  discardsCents: number | null;
  knownDiscardsCents: number;
  discardsComplete: boolean;
  categoryRowsAvailable: boolean;
  categories: InventoryUsageCategoryAggregate[];
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

function monthEnd(month: string): string {
  const [year, month1] = month.split('-').map(Number);
  return new Date(Date.UTC(year, month1, 0)).toISOString().slice(0, 10);
}

function nextMonth(month: string): string {
  const [year, month1] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, month1, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Plan which month-close facts an inclusive property-local range may use. */
export function planInventoryUsageRange(from: string, to: string): InventoryUsageRangePlan {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    throw new Error('inventory usage range must be ordered YYYY-MM-DD dates');
  }

  const fullMonths: string[] = [];
  const partialMonths: string[] = [];
  let month = from.slice(0, 7);
  const finalMonth = to.slice(0, 7);
  for (let guard = 0; month <= finalMonth && guard < 240; guard += 1) {
    const first = `${month}-01`;
    const last = monthEnd(month);
    if (from <= first && to >= last) fullMonths.push(month);
    else partialMonths.push(month);
    month = nextMonth(month);
  }
  return { fullMonths, partialMonths };
}

/** Aggregate only immutable, closed usage facts for the fully covered months. */
export function aggregateInventoryUsageRange(
  plan: InventoryUsageRangePlan,
  periods: readonly InventoryUsagePeriod[],
): InventoryUsageRangeAggregate {
  const byMonth = new Map(periods.map((period) => [period.month, period] as const));
  const closed = plan.fullMonths.flatMap((month) => {
    const period = byMonth.get(month);
    return period && period.actualStatus !== 'pending' && period.actualCents != null
      ? [period]
      : [];
  });

  const actualCents = closed.length > 0
    ? closed.reduce((total, period) => total + (period.actualCents ?? 0), 0)
    : null;
  const purchasesComplete = closed.length > 0 && closed.every((period) => period.purchasesCents != null);
  const knownPurchasesCents = closed.reduce(
    (total, period) => total + (period.purchasesCents ?? period.knownPurchasesCents),
    0,
  );
  const purchasesCents = purchasesComplete ? knownPurchasesCents : null;
  const budgetComplete = closed.length > 0 && closed.every(
    (period) => period.budgetComparisonAvailable && period.budgetCents != null,
  );
  const budgetCents = budgetComplete
    ? closed.reduce((total, period) => total + (period.budgetCents ?? 0), 0)
    : null;

  const categoryRowsAvailable = closed.length > 0 && closed.every((period) => {
    if (period.allocation !== 'itemized' || period.isPartial || period.hasCustomBudgetAllocation) return false;
    // A configured total budget with no category caps is a whole-inventory
    // comparison; category rows would otherwise hide that budget entirely.
    const isTotalBudgetMode = period.budgetCents != null
      && period.categories.every((category) => category.budgetCents == null);
    return !isTotalBudgetMode;
  });

  const categories: InventoryUsageCategoryAggregate[] = [];
  if (categoryRowsAvailable) {
    const keys = new Set(closed.flatMap((period) => period.categories.map((category) => category.category)));
    for (const category of [...keys].sort()) {
      const rows = closed.map((period) => period.categories.find((row) => row.category === category) ?? null);
      const categoryBudgetComplete = rows.every((row, index) => (
        row != null && closed[index].budgetComparisonAvailable && row.budgetCents != null
      ));
      const categoryBudget = categoryBudgetComplete
        ? rows.reduce((total, row) => total + (row?.budgetCents ?? 0), 0)
        : null;
      const categoryActual = rows.reduce((total, row) => total + (row?.actualCents ?? 0), 0);
      const knownCategoryDiscards = rows.reduce(
        (total, row) => total + (row?.knownDiscardsCents ?? row?.discardsCents ?? 0),
        0,
      );
      const categoryDiscardsComplete = rows.every(
        (row) => row != null && (row.discardsComplete ?? row.discardsCents != null),
      );
      categories.push({
        category,
        actualCents: categoryActual,
        purchasesCents: rows.reduce((total, row) => total + (row?.purchasesCents ?? 0), 0),
        budgetCents: categoryBudget,
        remainingCents: categoryBudget == null ? null : categoryBudget - categoryActual,
        discardsCents: categoryDiscardsComplete ? knownCategoryDiscards : null,
        knownDiscardsCents: knownCategoryDiscards,
        discardsComplete: categoryDiscardsComplete,
      });
    }
  }

  const knownDiscardsCents = closed.reduce(
    (total, period) => total + (period.knownDiscardsCents ?? period.discardsCents ?? 0),
    0,
  );
  const discardsComplete = closed.length > 0 && closed.every(
    (period) => period.discardsComplete ?? period.discardsCents != null,
  );

  return {
    expectedMonths: plan.fullMonths.length,
    closedMonths: closed.length,
    pendingMonths: plan.fullMonths.length - closed.length,
    partialEdgeMonths: plan.partialMonths.length,
    partialTrackingPeriods: closed.filter((period) => period.isPartial || period.actualStatus === 'partial').length,
    totalOnlyPeriods: closed.filter((period) => period.allocation === 'total_only').length,
    customAllocationPeriods: closed.filter((period) => period.hasCustomBudgetAllocation).length,
    actualCents,
    purchasesCents,
    knownPurchasesCents,
    purchasesComplete,
    budgetCents,
    remainingCents: budgetCents == null || actualCents == null ? null : budgetCents - actualCents,
    discardsCents: discardsComplete ? knownDiscardsCents : null,
    knownDiscardsCents,
    discardsComplete,
    categoryRowsAvailable,
    categories,
  };
}
