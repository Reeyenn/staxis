import type {
  EffectiveInventoryDelivery,
  InventoryCount,
  InventoryDiscard,
  InventoryItem,
} from '@/types';

type NullableMoney = number | null;

export interface InventoryFinancialEvidence {
  inventory: Record<string, {
    unitCost: NullableMoney;
    openingAdjustmentUnitCost: NullableMoney;
  }>;
  counts: Record<string, {
    unitCost: NullableMoney;
    varianceValue: NullableMoney;
  }>;
  orders: Record<string, {
    unitCost: NullableMoney;
    totalCost: NullableMoney;
  }>;
  discards: Record<string, {
    unitCost: NullableMoney;
    costValue: NullableMoney;
  }>;
  currentMonthSpend: {
    total: number;
    complete: boolean;
  };
}

export const EMPTY_INVENTORY_FINANCIAL_EVIDENCE: InventoryFinancialEvidence = {
  inventory: {},
  counts: {},
  orders: {},
  discards: {},
  currentMonthSpend: { total: 0, complete: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nullableFinite(value: unknown): value is NullableMoney {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function parseMap<K extends string>(
  value: unknown,
  keys: readonly K[],
): Record<string, Record<K, NullableMoney>> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, Record<K, NullableMoney>> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) return null;
    const parsed = {} as Record<K, NullableMoney>;
    for (const key of keys) {
      const rawValue = raw[key];
      if (!nullableFinite(rawValue)) return null;
      parsed[key] = rawValue;
    }
    result[id] = parsed;
  }
  return result;
}

/** Parse the standard API envelope without trusting partial/malformed money. */
export function inventoryFinancialEvidenceFromPayload(
  payload: unknown,
): InventoryFinancialEvidence | null {
  if (!isRecord(payload)) return null;
  const value = isRecord(payload.data) ? payload.data : payload;
  const inventory = parseMap(value.inventory, ['unitCost', 'openingAdjustmentUnitCost']);
  const counts = parseMap(value.counts, ['unitCost', 'varianceValue']);
  const orders = parseMap(value.orders, ['unitCost', 'totalCost']);
  const discards = parseMap(value.discards, ['unitCost', 'costValue']);
  const spend = value.currentMonthSpend;
  if (
    !inventory || !counts || !orders || !discards || !isRecord(spend)
    || typeof spend.total !== 'number' || !Number.isFinite(spend.total)
    || typeof spend.complete !== 'boolean'
  ) return null;
  return {
    inventory: inventory as InventoryFinancialEvidence['inventory'],
    counts: counts as InventoryFinancialEvidence['counts'],
    orders: orders as InventoryFinancialEvidence['orders'],
    discards: discards as InventoryFinancialEvidence['discards'],
    currentMonthSpend: { total: spend.total, complete: spend.complete },
  };
}

export function hydrateInventoryItems(
  rows: readonly InventoryItem[],
  evidence: InventoryFinancialEvidence['inventory'],
): InventoryItem[] {
  return rows.map((row) => {
    const money = evidence[row.id];
    return {
      ...row,
      unitCost: money?.unitCost == null ? undefined : money.unitCost,
      openingAdjustmentUnitCost: money?.openingAdjustmentUnitCost ?? null,
    };
  });
}

export function hydrateInventoryCounts(
  rows: readonly InventoryCount[],
  evidence: InventoryFinancialEvidence['counts'],
): InventoryCount[] {
  return rows.map((row) => {
    const money = evidence[row.id];
    return {
      ...row,
      unitCost: money?.unitCost == null ? undefined : money.unitCost,
      varianceValue: money?.varianceValue == null ? undefined : money.varianceValue,
    };
  });
}

export function hydrateInventoryDiscards(
  rows: readonly InventoryDiscard[],
  evidence: InventoryFinancialEvidence['discards'],
): InventoryDiscard[] {
  return rows.map((row) => {
    const money = evidence[row.id];
    return {
      ...row,
      unitCost: money?.unitCost == null ? undefined : money.unitCost,
      costValue: money?.costValue == null ? undefined : money.costValue,
    };
  });
}

export function hydrateInventoryDeliveries(
  rows: readonly EffectiveInventoryDelivery[],
  evidence: InventoryFinancialEvidence['orders'],
): EffectiveInventoryDelivery[] {
  return rows.map((row) => {
    const originalMoney = evidence[row.rootOrderId] ?? evidence[row.original.id];
    const originalUnitCost = originalMoney?.unitCost ?? null;
    const originalTotalCost = originalMoney?.totalCost ?? null;
    const financialsHydrated = originalMoney !== undefined;
    return {
      ...row,
      original: {
        ...row.original,
        unitCost: originalUnitCost == null ? undefined : originalUnitCost,
        totalCost: originalTotalCost == null ? undefined : originalTotalCost,
      },
      // Corrected values come from the already finance-gated correction RPC,
      // but are retained only when this separately gated evidence snapshot
      // proves finance access is still current. This closes the race where a
      // capability is revoked between two parallel requests.
      effectiveUnitCost: !financialsHydrated
        ? null
        : row.status === 'active' ? originalUnitCost : row.effectiveUnitCost,
      effectiveTotalCost: !financialsHydrated
        ? null
        : row.status === 'active' ? originalTotalCost : row.effectiveTotalCost,
      lastCorrection: !row.lastCorrection || financialsHydrated
        ? row.lastCorrection
        : {
            ...row.lastCorrection,
            previousUnitCost: null,
            previousTotalCost: null,
            correctedUnitCost: null,
            correctedTotalCost: null,
          },
    };
  });
}

export interface InventoryFinancialRequestScope {
  propertyId: string;
  viewerKey: string;
  financialsEnabled: boolean;
}

export function inventoryBoardRequestIsCurrent(
  requested: InventoryFinancialRequestScope,
  current: InventoryFinancialRequestScope | null,
): boolean {
  return Boolean(
    current
    && requested.propertyId === current.propertyId
    && requested.viewerKey === current.viewerKey
    && requested.financialsEnabled === current.financialsEnabled,
  );
}

/** Guard every async continuation against hotel, identity, and access changes. */
export function inventoryFinancialRequestIsCurrent(
  requested: InventoryFinancialRequestScope,
  current: InventoryFinancialRequestScope | null,
): boolean {
  return requested.financialsEnabled
    && inventoryBoardRequestIsCurrent(requested, current);
}
