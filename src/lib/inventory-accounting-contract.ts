export interface InventoryAccountingYtdContract {
  monthStart: string;
  receiptsValue: number;
  purchasesValue: number | null;
  actualUsageValue: number | null;
  actualStatus: 'pending' | 'complete' | 'partial' | 'unallocated';
  isPartial: boolean;
  discardsValue: number | null;
  knownDiscardsValue: number;
  discardsComplete: boolean;
}

export interface InventoryAccountingSummaryContract {
  monthKey: string;
  monthStart: string;
  totals: {
    openingValue: number | null;
    receiptsValue: number;
    loggedPurchasesValue: number | null;
    knownLoggedPurchasesValue: number;
    purchasesValue: number | null;
    actualUsageValue: number | null;
    actualStatus: 'pending' | 'complete' | 'partial' | 'unallocated';
    allocation: 'pending' | 'itemized' | 'total_only';
    isPartial: boolean;
    budgetComparisonAvailable: boolean;
    discardsValue: number | null;
    knownDiscardsValue: number;
    discardsComplete: boolean;
    closingValue: number | null;
    unaccountedShrinkageValue: number | null;
    knownUnaccountedShrinkageValue: number;
    shrinkageComplete: boolean;
    budgetCents: number | null;
    spendCents: number | null;
  };
  byCategory: Array<{ reconciliationsThisMonth: number }>;
  ytd: InventoryAccountingYtdContract[];
  costPerOccupiedRoom: {
    thisMonth: number | null;
    occupiedNightsThisMonth: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

function isMoney(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

const ACTUAL_STATUSES = new Set(['pending', 'complete', 'partial', 'unallocated']);
const ALLOCATIONS = new Set(['pending', 'itemized', 'total_only']);

function isYtdRow(value: unknown): value is InventoryAccountingYtdContract {
  if (!isRecord(value)) return false;
  return typeof value.monthStart === 'string'
    && isFiniteNumber(value.receiptsValue)
    && isMoney(value.purchasesValue)
    && isMoney(value.actualUsageValue)
    && typeof value.actualStatus === 'string'
    && ACTUAL_STATUSES.has(value.actualStatus)
    && typeof value.isPartial === 'boolean'
    && isMoney(value.discardsValue)
    && isFiniteNumber(value.knownDiscardsValue)
    && typeof value.discardsComplete === 'boolean';
}

/** A partial/malformed HTTP 200 must render unavailable, never flow into zero fallbacks. */
export function isInventoryAccountingSummaryPayload(value: unknown): value is InventoryAccountingSummaryContract {
  if (!isRecord(value) || typeof value.monthKey !== 'string' || typeof value.monthStart !== 'string') return false;
  if (!isRecord(value.totals) || !Array.isArray(value.byCategory) || !Array.isArray(value.ytd)) return false;
  if (!isRecord(value.costPerOccupiedRoom)) return false;
  const totals = value.totals;
  const moneyKeys = [
    'openingValue', 'loggedPurchasesValue', 'purchasesValue', 'actualUsageValue',
    'discardsValue', 'closingValue', 'unaccountedShrinkageValue', 'budgetCents', 'spendCents',
  ] as const;
  const requiredNumberKeys = [
    'receiptsValue', 'knownLoggedPurchasesValue', 'knownDiscardsValue',
    'knownUnaccountedShrinkageValue',
  ] as const;
  if (moneyKeys.some((key) => !isMoney(totals[key]))) return false;
  if (requiredNumberKeys.some((key) => !isFiniteNumber(totals[key]))) return false;
  if (
    typeof totals.actualStatus !== 'string' || !ACTUAL_STATUSES.has(totals.actualStatus)
    || typeof totals.allocation !== 'string' || !ALLOCATIONS.has(totals.allocation)
    || typeof totals.isPartial !== 'boolean'
    || typeof totals.budgetComparisonAvailable !== 'boolean'
    || typeof totals.discardsComplete !== 'boolean'
    || typeof totals.shrinkageComplete !== 'boolean'
  ) return false;
  if (!value.byCategory.every((row) => isRecord(row) && isCount(row.reconciliationsThisMonth))) return false;
  if (!value.ytd.every(isYtdRow)) return false;
  return isMoney(value.costPerOccupiedRoom.thisMonth)
    && isCount(value.costPerOccupiedRoom.occupiedNightsThisMonth);
}
