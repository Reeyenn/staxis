export type MonthClosePurchaseSource = 'logged_deliveries' | 'manual_total' | 'zero';

export interface MonthCloseIssue {
  code: string;
  message: string;
  itemId: string | null;
  itemName: string | null;
  count: number | null;
}

interface MonthCloseItemView {
  itemId: string;
  itemName: string;
  archivedAt: string | null;
  endingQuantity: number | null;
  beginningUnitCostCents: number | null;
  endingUnitCostCents: number | null;
  physicalUnitCostCents: number | null;
  endingCountedAt: string | null;
}

export interface MonthCloseDashboardView {
  propertyId: string;
  month: string;
  timezone: string;
  status: 'not_started' | 'open' | 'closed';
  canStart: boolean;
  canClose: boolean;
  closeAvailableOn: string;
  closeId: string | null;
  isPartial: boolean;
  budgetComparisonAvailable: boolean;
  baselineAt: string | null;
  activityStartAt: string | null;
  closedAt: string | null;
  closedByName: string | null;
  totals: {
    beginningCents: number | null;
    openingAdjustmentCents: number;
    purchasesCents: number | null;
    endingCents: number | null;
    actualUsageCents: number | null;
  };
  purchase: {
    source: MonthClosePurchaseSource | null;
    allocationMode: 'itemized' | 'total_only' | null;
    loggedDeliveryCount: number;
    loggedPurchaseCents: number | null;
    knownLoggedPurchaseCents: number;
    uncostedDeliveryCount: number;
    manualPurchaseCents: number | null;
    confirmedPurchaseCents: number | null;
  };
  completeness: {
    complete: boolean;
    readyToClose: boolean;
    blockers: MonthCloseIssue[];
    warnings: MonthCloseIssue[];
  };
  items: MonthCloseItemView[];
}

export interface MonthCloseMutationReceipt {
  mutationCommitted: true;
  dashboard: null;
  propertyId: string;
  month: string;
  action: 'start' | 'close';
  mutationRequestId: string;
}

export interface MonthCloseMutationScope {
  propertyId: string;
  sequence: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordAt(record: UnknownRecord, key: string): UnknownRecord | null {
  return isRecord(record[key]) ? record[key] as UnknownRecord : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNullableText(value: unknown): string | null {
  return value == null ? null : asText(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asCents(value: unknown): number | null {
  const number = asFiniteNumber(value);
  return number == null ? null : Math.round(number);
}

function asCount(value: unknown): number {
  return isCount(value) ? value : 0;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0;
}

function asPurchaseSource(value: unknown): MonthClosePurchaseSource | null {
  return value === 'logged_deliveries' || value === 'manual_total' || value === 'zero'
    ? value
    : null;
}

function normalizeIssue(value: unknown): MonthCloseIssue | null {
  if (!isRecord(value)) return null;
  const code = asText(value.code);
  const message = asText(value.message);
  if (!code || !message) return null;
  if (value.count != null && !isCount(value.count)) return null;
  if (value.itemId != null && !asText(value.itemId)) return null;
  if (value.itemName != null && !asText(value.itemName)) return null;
  return {
    code,
    message,
    itemId: asNullableText(value.itemId),
    itemName: asNullableText(value.itemName),
    count: asFiniteNumber(value.count),
  };
}

function normalizeIssues(value: unknown): MonthCloseIssue[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeIssue).filter((issue): issue is MonthCloseIssue => issue != null);
}

function normalizeItems(value: unknown): MonthCloseItemView[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: MonthCloseItemView[] = [];
  for (const row of value) {
    if (!isRecord(row)) return null;
    const itemId = asText(row.itemId);
    const itemName = asText(row.itemName);
    if (!itemId || !itemName) return null;
    for (const key of [
      'endingQuantity', 'beginningUnitCostCents', 'endingUnitCostCents',
      'physicalUnitCostCents',
    ]) {
      if (!(key in row) || (row[key] !== null && asFiniteNumber(row[key]) == null)) return null;
    }
    normalized.push({
      itemId,
      itemName,
      archivedAt: asNullableText(row.archivedAt),
      endingQuantity: asFiniteNumber(row.endingQuantity),
      beginningUnitCostCents: asCents(row.beginningUnitCostCents),
      endingUnitCostCents: asCents(row.endingUnitCostCents),
      physicalUnitCostCents: asCents(row.physicalUnitCostCents),
      endingCountedAt: asNullableText(row.endingCountedAt),
    });
  }
  return normalized;
}

/** Rejects incomplete finance payloads so the UI cannot invent plausible zero values. */
export function normalizeMonthCloseDashboard(payload: unknown): MonthCloseDashboardView | null {
  if (!isRecord(payload)) return null;
  const data = recordAt(payload, 'data');
  const candidate = (data && recordAt(data, 'dashboard'))
    ?? data
    ?? recordAt(payload, 'dashboard')
    ?? payload;

  const status = asText(candidate.status);
  if (status !== 'not_started' && status !== 'open' && status !== 'closed') return null;
  const month = asText(candidate.month);
  if (!month || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) return null;

  const propertyId = asText(candidate.propertyId);
  const timezone = asText(candidate.timezone);
  const totals = recordAt(candidate, 'totals');
  const purchase = recordAt(candidate, 'purchase');
  const completeness = recordAt(candidate, 'completeness');
  const window = recordAt(candidate, 'window');
  const items = normalizeItems(candidate.items);
  if (!propertyId || !timezone || !totals || !purchase || !completeness || !window || !items) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    return null;
  }
  if (
    typeof candidate.canStart !== 'boolean'
    || typeof candidate.canClose !== 'boolean'
    || typeof candidate.isPartial !== 'boolean'
    || typeof candidate.budgetComparisonAvailable !== 'boolean'
    || typeof completeness.complete !== 'boolean'
    || typeof completeness.readyToClose !== 'boolean'
    || !Array.isArray(completeness.blockers)
    || !Array.isArray(completeness.warnings)
    || !asText(candidate.closeAvailableOn)
    || !asText(window.monthStart)
    || !asText(window.endExclusive)
    || !asText(window.graceEndExclusive)
    || !asText(window.activityStartAt)
  ) return null;
  const blockers = normalizeIssues(completeness.blockers);
  const warnings = normalizeIssues(completeness.warnings);
  if (blockers.length !== completeness.blockers.length || warnings.length !== completeness.warnings.length) return null;
  const nullableMoneyKeys = ['beginningCents', 'purchasesCents', 'endingCents', 'actualUsageCents'] as const;
  if (nullableMoneyKeys.some((key) => !(key in totals) || (totals[key] !== null && asCents(totals[key]) == null))) return null;
  if (asCents(totals.openingAdjustmentCents) == null) return null;
  const nullablePurchaseMoney = ['loggedPurchaseCents', 'manualPurchaseCents', 'confirmedPurchaseCents'] as const;
  if (nullablePurchaseMoney.some((key) => !(key in purchase) || (purchase[key] !== null && asCents(purchase[key]) == null))) return null;
  if (
    !isCount(purchase.loggedDeliveryCount)
    || asCents(purchase.knownLoggedPurchaseCents) == null
    || !isCount(purchase.uncostedDeliveryCount)
  ) return null;
  const allocationMode = purchase.allocationMode === 'itemized' || purchase.allocationMode === 'total_only'
    ? purchase.allocationMode
    : null;

  return {
    propertyId,
    month,
    timezone,
    status,
    canStart: candidate.canStart,
    canClose: candidate.canClose,
    closeAvailableOn: asText(candidate.closeAvailableOn)!,
    closeId: asNullableText(candidate.closeId),
    isPartial: candidate.isPartial,
    budgetComparisonAvailable: candidate.budgetComparisonAvailable,
    baselineAt: asNullableText(candidate.baselineAt),
    activityStartAt: asNullableText(window.activityStartAt) ?? asNullableText(candidate.activityStartAt),
    closedAt: asNullableText(candidate.closedAt),
    closedByName: asNullableText(candidate.closedByName),
    totals: {
      beginningCents: asCents(totals.beginningCents),
      openingAdjustmentCents: asCents(totals.openingAdjustmentCents)!,
      purchasesCents: asCents(totals.purchasesCents),
      endingCents: asCents(totals.endingCents),
      actualUsageCents: asCents(totals.actualUsageCents),
    },
    purchase: {
      source: asPurchaseSource(purchase.source),
      allocationMode,
      loggedDeliveryCount: asCount(purchase.loggedDeliveryCount),
      loggedPurchaseCents: asCents(purchase.loggedPurchaseCents),
      knownLoggedPurchaseCents: asCents(purchase.knownLoggedPurchaseCents)!,
      uncostedDeliveryCount: asCount(purchase.uncostedDeliveryCount),
      manualPurchaseCents: asCents(purchase.manualPurchaseCents),
      confirmedPurchaseCents: asCents(purchase.confirmedPurchaseCents),
    },
    completeness: {
      complete: completeness.complete,
      readyToClose: completeness.readyToClose,
      blockers,
      warnings,
    },
    items,
  };
}

/** Reject a valid dashboard for the wrong hotel at the client boundary. */
export function normalizeMonthCloseDashboardForProperty(
  payload: unknown,
  propertyId: string,
): MonthCloseDashboardView | null {
  const dashboard = normalizeMonthCloseDashboard(payload);
  return dashboard?.propertyId === propertyId ? dashboard : null;
}

/** Minimal success receipt used when the mutation committed but its follow-up read failed. */
export function inventoryMonthCloseMutationReceipt(args: {
  propertyId: string;
  month: string;
  action: 'start' | 'close';
  mutationRequestId: string;
}): MonthCloseMutationReceipt {
  return {
    mutationCommitted: true,
    dashboard: null,
    propertyId: args.propertyId,
    month: args.month,
    action: args.action,
    mutationRequestId: args.mutationRequestId,
  };
}

export function normalizeMonthCloseMutationReceipt(payload: unknown): MonthCloseMutationReceipt | null {
  if (!isRecord(payload)) return null;
  const candidate = recordAt(payload, 'data') ?? payload;
  const propertyId = asText(candidate.propertyId);
  const month = asText(candidate.month);
  const mutationRequestId = asText(candidate.mutationRequestId);
  if (
    candidate.mutationCommitted !== true
    || candidate.dashboard !== null
    || !propertyId
    || !month
    || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)
    || (candidate.action !== 'start' && candidate.action !== 'close')
    || !mutationRequestId
  ) return null;
  return {
    mutationCommitted: true,
    dashboard: null,
    propertyId,
    month,
    action: candidate.action,
    mutationRequestId,
  };
}

/** Ignore late save responses after a hotel switch or newer mutation. */
export function isCurrentMonthCloseMutation(
  scope: MonthCloseMutationScope,
  activePropertyId: string | null,
  currentSequence: number,
): boolean {
  return scope.propertyId === activePropertyId && scope.sequence === currentSequence;
}
