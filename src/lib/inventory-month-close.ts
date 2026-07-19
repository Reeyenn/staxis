// Inventory month close domain contract.
//
// A close is accounting-period evidence, not a live inventory estimate:
//
//   actual usage = beginning inventory + confirmed purchases - ending inventory
//
// All aggregate money is integer cents. Per-unit costs may contain fractional
// cents because logged-delivery closes use a periodic weighted-average cost.

export const INVENTORY_CLOSE_COUNT_LOOKBACK_DAYS = 1;
export const INVENTORY_CLOSE_GRACE_DAYS = 3;

export type InventoryPurchaseSource = 'logged_deliveries' | 'manual_total' | 'zero';
export type InventoryCloseAllocationMode = 'itemized' | 'total_only';
export type InventoryMonthCloseStatus = 'not_started' | 'open' | 'closed';
export type InventoryCloseCategory = 'housekeeping' | 'maintenance' | 'breakfast';

export interface InventoryCloseIssue {
  code: string;
  message: string;
  itemId?: string;
  itemName?: string;
  count?: number;
  source?: InventoryPurchaseSource;
}

export interface InventoryMonthCloseItem {
  itemId: string;
  itemName: string;
  category: InventoryCloseCategory;
  customCategoryId: string | null;
  customCategoryName: string | null;
  /** Exactly one allocation key. A custom section wins by (sort, id). */
  budgetKey: string;
  /** All snapshotted legacy mappings; budgetKey is still exclusive. */
  sectionIds: string[];
  archivedAt: string | null;
  beginningQuantity: number;
  beginningSetAside: number;
  beginningUnitCostCents: number | null;
  beginningValueCents: number | null;
  /** Pre-existing shelf stock discovered after this period's baseline. */
  openingAdjustmentQuantity: number;
  openingAdjustmentUnitCostCents: number | null;
  openingAdjustmentValueCents: number;
  openingAdjustmentAt: string | null;
  endingQuantity: number | null;
  endingSetAside: number | null;
  /** Valuation cost: WAC, carried opening cost, or physical-count cost. */
  endingUnitCostCents: number | null;
  /** Cost snapshotted by the chosen physical count, before valuation policy. */
  physicalUnitCostCents: number | null;
  endingValueCents: number | null;
  purchasesCents: number | null;
  purchaseQuantity: number | null;
  actualUsageCents: number | null;
  endingCountedAt: string | null;
}

export interface InventoryMonthCloseHistoryRow {
  closeId: string;
  /** Frozen period-end item dimensions used by historical category reports. */
  endingSnapshotId?: string | null;
  month: string;
  status: 'open' | 'closed';
  isPartial: boolean;
  budgetComparisonAvailable: boolean;
  purchaseSource: InventoryPurchaseSource | null;
  allocationMode: InventoryCloseAllocationMode | null;
  beginningCents: number | null;
  openingAdjustmentCents: number;
  purchasesCents: number | null;
  /** Null means at least one snapshotted logged line has no usable cost. */
  loggedPurchaseCents: number | null;
  /** Sum of only the costed logged lines; never present it as the full total. */
  knownLoggedPurchaseCents: number;
  endingCents: number | null;
  actualUsageCents: number | null;
  byCategory: Record<InventoryCloseCategory, number> | null;
  byItem: Record<string, number> | null;
  byBudgetKey: Record<string, number> | null;
  /** Usage-budget evidence frozen when this period closed (migration 0323). */
  usageBudgetMode: 'total' | 'sections' | null;
  usageBudgetTotalCents: number | null;
  usageBudgetByKey: Record<string, number> | null;
  complete: boolean;
  closedAt: string | null;
}

export interface InventoryMonthCloseDashboard {
  propertyId: string;
  month: string;
  timezone: string;
  status: InventoryMonthCloseStatus;
  closeId: string | null;
  canStart: boolean;
  canClose: boolean;
  closeAvailableOn: string;
  window: {
    monthStart: string;
    endExclusive: string;
    graceEndExclusive: string;
    activityStartAt: string;
  };
  isPartial: boolean;
  /** A partial first period must never be compared with a full-month budget. */
  budgetComparisonAvailable: boolean;
  baselineAt: string | null;
  closedAt: string | null;
  closedByName: string | null;
  notes: string | null;
  totals: {
    beginningCents: number | null;
    openingAdjustmentCents: number;
    purchasesCents: number | null;
    endingCents: number | null;
    actualUsageCents: number | null;
  };
  purchase: {
    source: InventoryPurchaseSource | null;
    allocationMode: InventoryCloseAllocationMode | null;
    /** One inventory_orders row is one received line, not necessarily one invoice. */
    loggedDeliveryCount: number;
    /** Null means at least one logged line in the period is uncosted. */
    loggedPurchaseCents: number | null;
    /** Sum of costed lines only; useful for diagnosing an incomplete total. */
    knownLoggedPurchaseCents: number;
    uncostedDeliveryCount: number;
    manualPurchaseCents: number | null;
    confirmedPurchaseCents: number | null;
  };
  completeness: {
    complete: boolean;
    readyToClose: boolean;
    blockers: InventoryCloseIssue[];
    warnings: InventoryCloseIssue[];
  };
  items: InventoryMonthCloseItem[];
  byCategory: Record<InventoryCloseCategory, number> | null;
  byItem: Record<string, number> | null;
  byBudgetKey: Record<string, number> | null;
  /** Null until close; immutable after the close transition. */
  usageBudgetMode: 'total' | 'sections' | null;
  usageBudgetTotalCents: number | null;
  usageBudgetByKey: Record<string, number> | null;
  history: InventoryMonthCloseHistoryRow[];
}

export interface InventoryMonthClosePostBody {
  propertyId?: unknown;
  month?: unknown;
  action?: unknown;
  requestId?: unknown;
  purchaseSource?: unknown;
  manualPurchaseCents?: unknown;
  notes?: unknown;
}

export interface InventoryMonthCloseMutationFailure {
  status: number;
  code: string;
  message: string;
}

function monthCloseErrorText(error: unknown): { dbCode: string; text: string } {
  if (!error || typeof error !== 'object') {
    return { dbCode: '', text: typeof error === 'string' ? error : '' };
  }
  const record = error as Record<string, unknown>;
  const dbCode = typeof record.code === 'string' ? record.code : '';
  const text = [record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .trim();
  return { dbCode, text };
}

/** Convert Postgres close failures into stable, safe, actionable API errors.
 * The database remains the authority; this mapping prevents the UI from
 * collapsing every recovery case into a generic retry message. */
export function inventoryMonthCloseMutationFailure(
  error: unknown,
  action?: 'start' | 'close',
): InventoryMonthCloseMutationFailure {
  const { dbCode, text } = monthCloseErrorText(error);
  const normalized = text.toLowerCase();

  if (dbCode === 'P0002') {
    return { status: 404, code: 'not_found', message: 'The inventory month was not found. Refresh month close before trying again.' };
  }
  if (/timezone changed after this period opened/.test(normalized)) {
    return {
      status: 409,
      code: 'month_close_timezone_changed',
      message: 'The property timezone changed after this period opened. Nothing was closed. An administrator must rebaseline the current month before usage can be recorded safely.',
    };
  }
  if (/cannot close before the property-local month boundary/.test(normalized)) {
    return {
      status: 409,
      code: 'month_close_too_early',
      message: 'This period cannot close before the hotel’s local month boundary. No values were saved.',
    };
  }
  if (
    /complete physical-count session/.test(normalized)
    || /ending-count window/.test(normalized)
    || /every period item needs a physical count/.test(normalized)
  ) {
    if (action === 'start') {
      return {
        status: 409,
        code: 'month_close_baseline_count_required',
        message: 'No current complete physical count can start this baseline. Run one full count, then start monthly tracking again. Nothing was saved.',
      };
    }
    return {
      status: 409,
      code: 'month_close_ending_count_required',
      message: 'No eligible complete ending count was found. Run a full count in the period’s ending-count window and retry. If that window has passed, refresh to start a fresh current baseline; the missed period remains unclosed.',
    };
  }
  if (
    /activity occurred after the selected ending count/.test(normalized)
    || /delivery or discard occurred after the selected ending count/.test(normalized)
    || /next-month activity occurred before a grace-period ending count/.test(normalized)
    || /opening stock was recorded after the selected ending count/.test(normalized)
    || /activity occurred after the complete opening count/.test(normalized)
  ) {
    return {
      status: 409,
      code: 'month_close_recount_required',
      message: 'Inventory changed around the selected count. Nothing was closed. Run one new complete count, then retry the same action.',
    };
  }
  if (
    /no usable cost/.test(normalized)
    || /unit cost is required/.test(normalized)
    || /unit cost for a manual-total close/.test(normalized)
    || /complete valuation cost/.test(normalized)
  ) {
    return {
      status: 409,
      code: 'month_close_costs_incomplete',
      message: 'Month close is missing required cost evidence. Complete the flagged item or received-line costs, then retry. No values were saved.',
    };
  }
  if (/negative actual usage|actual usage is negative/.test(normalized)) {
    return {
      status: 409,
      code: 'month_close_negative_usage',
      message: 'Estimated usage would be negative. Verify the ending count and purchase source before closing. No values were saved.',
    };
  }
  if (
    /no logged deliveries exist/.test(normalized)
    || /zero purchases cannot be confirmed/.test(normalized)
    || /manual total/.test(normalized)
    || /purchase_source/.test(normalized)
  ) {
    return {
      status: 409,
      code: 'month_close_purchase_selection_invalid',
      message: 'The selected purchase source does not match the period evidence. Review the purchase choice and try again. No values were saved.',
    };
  }
  if (/request id is already bound/.test(normalized)) {
    return {
      status: 409,
      code: 'month_close_request_conflict',
      message: 'This saved retry belongs to different month-close values. Refresh the checklist before trying again.',
    };
  }
  if (/already closed|closed inventory months are immutable/.test(normalized)) {
    return {
      status: 409,
      code: 'month_close_already_closed',
      message: 'This inventory month is already closed and locked. Refresh to view the final record.',
    };
  }
  if (dbCode === '22023' || dbCode === '23514' || dbCode === '23505' || dbCode === '40001') {
    return {
      status: 409,
      code: 'month_close_not_ready',
      message: 'The month close is not ready. Refresh the checklist and resolve the flagged counts, costs, or activity. No values were saved.',
    };
  }
  return {
    status: 500,
    code: 'internal_error',
    message: 'Month close is temporarily unavailable. Nothing was changed; retry the same action when the connection is restored.',
  };
}

export interface InventoryCloseWindow {
  month: string;
  timezone: string;
  monthStart: Date;
  endExclusive: Date;
  graceEndExclusive: Date;
  countWindowStart: Date;
  closeAvailableOn: string;
}

export interface InventoryCalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Resolve an instant to the hotel's calendar, independent of the browser's
 * timezone. Inventory budgets, reports, and comparisons all use this clock. */
export function inventoryCalendarDateInZone(
  instant: Date,
  timeZone: string,
): InventoryCalendarDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new Error('Could not resolve the property-local date.');
  return { year, month, day };
}

export function inventoryDateKeyInZone(instant: Date, timeZone: string): string {
  const { year, month, day } = inventoryCalendarDateInZone(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function inventoryMonthKeyInZone(instant: Date, timeZone: string): string {
  return inventoryDateKeyInZone(instant, timeZone).slice(0, 7);
}

/** Calendar-key arithmetic deliberately runs in UTC so the host/browser
 * timezone and DST cannot change the requested hotel date. */
export function shiftInventoryDateKey(dateKey: string, days: number): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(dateKey)) {
    throw new Error('date must be YYYY-MM-DD');
  }
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Math.trunc(days)));
  return date.toISOString().slice(0, 10);
}

export function shiftInventoryMonthKey(monthKey: string, months: number): string {
  if (!isMonthKey(monthKey)) throw new Error('month must be YYYY-MM');
  const [year, month] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + Math.trunc(months), 1));
  return date.toISOString().slice(0, 7);
}

export function inventoryMonthEndDateKey(monthKey: string): string {
  return shiftInventoryDateKey(`${shiftInventoryMonthKey(monthKey, 1)}-01`, -1);
}

export function formatInventoryMonthKey(monthKey: string, locale: string): string {
  if (!isMonthKey(monthKey)) return monthKey;
  const [year, month] = monthKey.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function formatInventoryDateKey(dateKey: string, locale: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function offsetMs(timeZone: string, instant: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of fmt.formatToParts(instant)) parts[part.type] = part.value;
  return Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second),
  ) - instant.getTime();
}

/** Convert a property-local calendar midnight to its UTC instant. */
export function propertyLocalDayStartUTC(
  year: number,
  month1: number,
  day: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(year, month1 - 1, day);
  for (let i = 0; i < 2; i += 1) {
    guess = Date.UTC(year, month1 - 1, day) - offsetMs(timeZone, new Date(guess));
  }
  return new Date(guess);
}

export function isMonthKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function inventoryCloseWindow(month: string, timeZone: string): InventoryCloseWindow {
  if (!isMonthKey(month)) throw new Error('month must be YYYY-MM');
  // Validate the zone before doing offset arithmetic.
  new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  const [year, month1] = month.split('-').map(Number);
  const nextYear = month1 === 12 ? year + 1 : year;
  const nextMonth = month1 === 12 ? 1 : month1 + 1;
  const monthStart = propertyLocalDayStartUTC(year, month1, 1, timeZone);
  const endExclusive = propertyLocalDayStartUTC(nextYear, nextMonth, 1, timeZone);
  const graceEndExclusive = propertyLocalDayStartUTC(nextYear, nextMonth, 1 + INVENTORY_CLOSE_GRACE_DAYS, timeZone);
  // Calendar-date arithmetic (not 7*24h) keeps this correct across DST.
  const countDate = new Date(Date.UTC(nextYear, nextMonth - 1, 1 - INVENTORY_CLOSE_COUNT_LOOKBACK_DAYS));
  const countWindowStart = propertyLocalDayStartUTC(
    countDate.getUTCFullYear(), countDate.getUTCMonth() + 1, countDate.getUTCDate(), timeZone,
  );
  return {
    month,
    timezone: timeZone,
    monthStart,
    endExclusive,
    graceEndExclusive,
    countWindowStart,
    closeAvailableOn: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
  };
}

export function purchaseSource(value: unknown): InventoryPurchaseSource | null {
  return value === 'logged_deliveries' || value === 'manual_total' || value === 'zero' ? value : null;
}

export function validatePurchaseSelection(
  source: InventoryPurchaseSource,
  manualPurchaseCents: unknown,
): { manualPurchaseCents: number | null; error: string | null } {
  if (source !== 'manual_total') {
    if (manualPurchaseCents !== undefined && manualPurchaseCents !== null) {
      return { manualPurchaseCents: null, error: 'manualPurchaseCents is only valid with manual_total' };
    }
    return { manualPurchaseCents: null, error: null };
  }
  if (typeof manualPurchaseCents !== 'number' || !Number.isSafeInteger(manualPurchaseCents) || manualPurchaseCents <= 0) {
    return { manualPurchaseCents: null, error: 'manualPurchaseCents must be a positive integer; use zero for an explicit $0 month' };
  }
  return { manualPurchaseCents, error: null };
}

/** Periodic weighted-average unit cost, expressed in cents per unit. */
export function periodicWeightedAverageCents(args: {
  openingQuantity: number;
  openingValueCents: number;
  purchaseQuantity: number;
  purchaseValueCents: number;
}): number | null {
  const denominator = args.openingQuantity + args.purchaseQuantity;
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return (args.openingValueCents + args.purchaseValueCents) / denominator;
}

export function inventoryUsageCents(beginningCents: number, purchasesCents: number, endingCents: number): number {
  return beginningCents + purchasesCents - endingCents;
}

/**
 * Value the period's opening position without ever confusing manually
 * discovered shelf stock with a purchase. An immutable adjustment augments
 * the baseline even when the catalog item already existed at that baseline.
 */
export function inventoryOpeningPosition(args: {
  hasOpeningSnapshot: boolean;
  snapshotQuantity?: number | null;
  snapshotUnitCostCents?: number | null;
  snapshotValueCents?: number | null;
  adjustmentQuantity?: number | null;
  adjustmentUnitCostCents?: number | null;
}): {
  quantity: number;
  unitCostCents: number | null;
  valueCents: number | null;
  adjustmentValueCents: number;
  adjustmentApplied: boolean;
} {
  const snapshotQuantity = args.hasOpeningSnapshot && Number.isFinite(args.snapshotQuantity)
    ? Math.max(0, Number(args.snapshotQuantity))
    : 0;
  const snapshotValueCents = args.hasOpeningSnapshot && Number.isFinite(args.snapshotValueCents)
    ? Math.round(Number(args.snapshotValueCents))
    : args.hasOpeningSnapshot
      ? null
      : 0;
  const adjustmentQuantity = Number.isFinite(args.adjustmentQuantity)
    ? Math.max(0, Number(args.adjustmentQuantity))
    : 0;
  const adjustmentUnitCostCents = Number.isFinite(args.adjustmentUnitCostCents)
    ? Math.max(0, Number(args.adjustmentUnitCostCents))
    : null;
  const adjustmentValueCents = adjustmentQuantity > 0 && adjustmentUnitCostCents != null
    ? Math.round(adjustmentQuantity * adjustmentUnitCostCents)
    : 0;
  const adjustmentApplied = adjustmentQuantity > 0 && adjustmentUnitCostCents != null;
  const quantity = snapshotQuantity + (adjustmentApplied ? adjustmentQuantity : 0);
  const valueCents = snapshotValueCents == null
    ? null
    : snapshotValueCents + adjustmentValueCents;
  const unitCostCents = quantity > 0 && valueCents != null
    ? valueCents / quantity
    : args.hasOpeningSnapshot && Number.isFinite(args.snapshotUnitCostCents)
      ? Number(args.snapshotUnitCostCents)
      : adjustmentUnitCostCents;
  return {
    quantity,
    unitCostCents,
    valueCents,
    adjustmentValueCents,
    adjustmentApplied,
  };
}

export interface BudgetSectionCandidate { id: string; sort: number; name?: string }

/** Exclusive legacy-section attribution: lowest sort, then UUID/text id. */
export function chooseExclusiveBudgetKey(
  category: InventoryCloseCategory,
  sections: readonly BudgetSectionCandidate[],
): { budgetKey: string; orderedSectionIds: string[]; multiplyMapped: boolean } {
  const ordered = [...sections].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
  return {
    budgetKey: ordered[0] ? `section:${ordered[0].id}` : category,
    orderedSectionIds: ordered.map((section) => section.id),
    multiplyMapped: ordered.length > 1,
  };
}
