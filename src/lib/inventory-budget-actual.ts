/**
 * Pure budget-vs-actual rules for Inventory.
 *
 * A purchase is not an expense just because it arrived, and shelf value is
 * never a monthly expense. The only number allowed to trigger an over/under
 * budget state is a completed, full-calendar-month inventory usage actual:
 *
 *   beginning inventory + purchases - ending inventory = actual usage
 */

import type {
  InventoryMonthCloseDashboard,
  InventoryMonthCloseHistoryRow,
} from './inventory-month-close';

export type InventoryBudgetActualState =
  | 'complete'
  | 'pending'
  | 'partial'
  | 'unallocated';

export interface InventoryBudgetActualInput {
  status: 'not_started' | 'open' | 'closed';
  isPartial: boolean;
  allocation: 'pending' | 'itemized' | 'total_only';
  actualUsageValue: number | null;
  byBudgetKey: Record<string, number> | null;
}

/** Dollar-denominated view model consumed by Inventory's budget UI. Database
 * and API persistence stay in integer cents; InventoryShell performs the one
 * boundary conversion before handing periods to presentation components. */
export interface InventoryBudgetActualPeriod extends InventoryBudgetActualInput {
  monthStart: string; // YYYY-MM-01
  /** Usage-budget configuration frozen with a closed period. Dollar values. */
  usageBudgetMode: 'total' | 'sections' | null;
  usageBudgetTotalValue: number | null;
  usageBudgetByKey: Record<string, number> | null;
  purchasesValue: number | null;
  /** Whether loggedPurchasesValue is the full received-purchase total. */
  loggedPurchasesComplete: boolean;
  /** Known subtotal; use ≥ when loggedPurchasesComplete is false. */
  loggedPurchasesValue: number;
}

function centsRecordToDollars(
  value: Record<string, number> | null,
): Record<string, number> | null {
  if (value == null) return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, cents]) => [key, cents / 100]),
  );
}

function historyPeriod(row: InventoryMonthCloseHistoryRow): InventoryBudgetActualPeriod {
  return {
    monthStart: `${row.month}-01`,
    status: row.status,
    isPartial: row.isPartial,
    allocation: row.allocationMode ?? 'pending',
    actualUsageValue: row.actualUsageCents == null ? null : row.actualUsageCents / 100,
    byBudgetKey: centsRecordToDollars(row.byBudgetKey),
    usageBudgetMode: row.usageBudgetMode,
    usageBudgetTotalValue: row.usageBudgetTotalCents == null
      ? null
      : row.usageBudgetTotalCents / 100,
    usageBudgetByKey: centsRecordToDollars(row.usageBudgetByKey),
    purchasesValue: row.status === 'closed' && row.purchasesCents != null
      ? row.purchasesCents / 100
      : null,
    loggedPurchasesComplete: row.loggedPurchaseCents != null,
    loggedPurchasesValue: row.knownLoggedPurchaseCents / 100,
  };
}

/** Convert the integer-cent API contract exactly once at the presentation
 * boundary. The live dashboard wins over an older history row for its month. */
export function inventoryBudgetPeriodsFromDashboard(
  dashboard: InventoryMonthCloseDashboard,
): InventoryBudgetActualPeriod[] {
  const byMonth = new Map<string, InventoryBudgetActualPeriod>();
  for (const row of dashboard.history) byMonth.set(row.month, historyPeriod(row));
  byMonth.set(dashboard.month, {
    monthStart: `${dashboard.month}-01`,
    status: dashboard.status,
    isPartial: dashboard.isPartial,
    allocation: dashboard.purchase.allocationMode ?? 'pending',
    actualUsageValue: dashboard.totals.actualUsageCents == null
      ? null
      : dashboard.totals.actualUsageCents / 100,
    byBudgetKey: centsRecordToDollars(dashboard.byBudgetKey),
    usageBudgetMode: dashboard.usageBudgetMode,
    usageBudgetTotalValue: dashboard.usageBudgetTotalCents == null
      ? null
      : dashboard.usageBudgetTotalCents / 100,
    usageBudgetByKey: centsRecordToDollars(dashboard.usageBudgetByKey),
    // Open dashboards can carry a preview purchase value for the close
    // equation. It is not confirmed until the immutable close is written.
    purchasesValue: dashboard.status === 'closed'
      && dashboard.purchase.confirmedPurchaseCents != null
      ? dashboard.purchase.confirmedPurchaseCents / 100
      : null,
    loggedPurchasesComplete: dashboard.purchase.loggedPurchaseCents != null,
    loggedPurchasesValue: dashboard.purchase.knownLoggedPurchaseCents / 100,
  });
  return [...byMonth.values()].sort((a, b) => b.monthStart.localeCompare(a.monthStart));
}

/**
 * Return the immutable cap that belongs with a closed actual. `null` means
 * the period predates budget snapshots; zero means it closed with no cap for
 * that key. Live/open planning continues to use the editable budget rows.
 */
export function inventoryBudgetSnapshotCap(
  period: InventoryBudgetActualPeriod | null | undefined,
  budgetKey: string,
): number | null {
  if (!period || period.status !== 'closed' || period.usageBudgetMode == null) return null;
  if (budgetKey === 'total') return period.usageBudgetTotalValue ?? 0;
  if (period.usageBudgetMode !== 'sections') return null;
  return period.usageBudgetByKey?.[budgetKey] ?? 0;
}

/**
 * Resolve the cap that is allowed to accompany an actual. Open/planning
 * periods may use the editable cap. A closed period must use its immutable
 * snapshot; legacy closes without one return null instead of borrowing a
 * later budget edit.
 */
export function inventoryBudgetComparisonCap(
  period: InventoryBudgetActualPeriod | null | undefined,
  budgetKey: string,
  planningCap: number,
): number | null {
  return period?.status === 'closed'
    ? inventoryBudgetSnapshotCap(period, budgetKey)
    : planningCap;
}

export type InventoryPurchaseEvidence =
  | { state: 'confirmed' | 'logged' | 'incomplete'; value: number }
  | null;

/** Missing period data is unknown, never an exact zero purchase total. */
export function inventoryPurchaseEvidence(
  period: InventoryBudgetActualPeriod | null | undefined,
): InventoryPurchaseEvidence {
  if (!period) return null;
  if (period.purchasesValue != null) return { state: 'confirmed', value: period.purchasesValue };
  return {
    state: period.loggedPurchasesComplete ? 'logged' : 'incomplete',
    value: period.loggedPurchasesValue,
  };
}

export interface ResolvedInventoryBudgetActual {
  state: InventoryBudgetActualState;
  value: number | null;
}

/** Resolve the actual that may be compared with one configured budget key. */
export function resolveInventoryBudgetActual(
  period: InventoryBudgetActualInput | null | undefined,
  budgetKey: string,
): ResolvedInventoryBudgetActual {
  if (!period || period.status !== 'closed' || period.actualUsageValue == null) {
    return { state: 'pending', value: null };
  }
  // A baseline established mid-month produces a useful tracking-period
  // result, but comparing it with a full calendar-month budget would be false.
  if (period.isPartial) return { state: 'partial', value: null };

  if (budgetKey === 'total') {
    return { state: 'complete', value: period.actualUsageValue };
  }
  if (period.allocation !== 'itemized' || period.byBudgetKey == null) {
    return { state: 'unallocated', value: null };
  }
  // An absent itemized key is a real zero: the closed snapshot proves no
  // usage was attributed to that budget bucket.
  return { state: 'complete', value: period.byBudgetKey[budgetKey] ?? 0 };
}

export type InventoryBudgetBand = 'ok' | 'near' | 'over' | 'nocap';

export function inventoryBudgetBand(cap: number, actual: number): InventoryBudgetBand {
  if (cap <= 0) return 'nocap';
  if (actual > cap) return 'over';
  if (actual >= cap * 0.8) return 'near';
  return 'ok';
}
