import type { InventoryAuditEvent } from '@/lib/inventory-audit-history';
import type { EffectiveInventoryDelivery } from '@/types';

export type InventoryAuditMoneyKind =
  | 'unitCost'
  | 'totalCost'
  | 'previousTotalCost'
  | 'currentTotalCost'
  | 'varianceValue'
  | 'inventoryValue'
  | 'actualUsedValue'
  | 'budgetValue';

export interface InventoryAuditMoneyFact {
  kind: InventoryAuditMoneyKind;
  value: number;
}

function auditDetailNumber(event: InventoryAuditEvent, key: string): number | null {
  const value = event.details[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** Return only money facts whose meaning is certain. In particular, a missing
 * corrected total is not replaced by the old total, and a void's current total
 * is explicitly zero even though its immutable correction row stores null. */
export function inventoryAuditMoneyFacts(
  event: InventoryAuditEvent,
  canViewFinancials: boolean,
): InventoryAuditMoneyFact[] {
  if (!canViewFinancials) return [];

  const fact = (
    key: string,
    kind: InventoryAuditMoneyKind,
    cents = false,
  ): InventoryAuditMoneyFact | null => {
    const value = auditDetailNumber(event, key);
    return value == null ? null : { kind, value: cents ? value / 100 : value };
  };
  const present = (...facts: Array<InventoryAuditMoneyFact | null>) => facts.filter(
    (value): value is InventoryAuditMoneyFact => value !== null,
  );

  switch (event.action) {
    case 'item.created':
    case 'item.updated':
    case 'item.archived':
      return present(fact('unitCostAfter', 'unitCost'));
    case 'count.saved':
    case 'reconciliation.recorded':
      return present(fact('varianceValue', 'varianceValue'));
    case 'delivery.received':
      return present(fact('totalCost', 'totalCost'));
    case 'loss.recorded':
      return present(fact('costValue', 'inventoryValue'));
    case 'delivery.corrected':
      return present(
        fact('previousTotalCost', 'previousTotalCost'),
        fact('correctedTotalCost', 'currentTotalCost'),
      );
    case 'delivery.voided':
      return present(
        fact('previousTotalCost', 'previousTotalCost'),
        { kind: 'currentTotalCost', value: 0 },
      );
    case 'opening_adjustment.recorded':
      return present(fact('valueCents', 'inventoryValue', true));
    case 'month.started':
      return present(fact('beginningValueCents', 'inventoryValue', true));
    case 'month.closed':
      return present(fact('actualUsageCents', 'actualUsedValue', true));
    case 'budget.created':
    case 'budget.updated':
    case 'budget.deleted':
      return present(fact('budgetCents', 'budgetValue', true));
    default:
      return [];
  }
}

/** Audit correction events use their own immutable event id as entityId. The
 * stable delivery root lives in details.originalOrderId instead. */
export function inventoryAuditDeliveryRootOrderId(event: InventoryAuditEvent): string | null {
  if (event.action === 'delivery.received') return event.entityId;
  if (event.action !== 'delivery.corrected' && event.action !== 'delivery.voided') return null;
  const rootOrderId = event.details.originalOrderId;
  return typeof rootOrderId === 'string' && rootOrderId.trim() ? rootOrderId : null;
}

export function canCorrectEffectiveInventoryDelivery(
  delivery: EffectiveInventoryDelivery | null | undefined,
): delivery is EffectiveInventoryDelivery {
  return delivery != null && delivery.status !== 'voided';
}
