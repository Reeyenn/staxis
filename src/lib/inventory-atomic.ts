// Pure types and payload builders for the transactional inventory RPCs.
//
// Keeping the camelCase -> Postgres JSON mapping here (rather than scattered
// through React components) makes the write contract small, auditable, and
// unit-testable without a browser or Supabase connection.

import type { CommitPlan } from './inventory-invoice-commit';

export interface AtomicInventoryCountRow {
  itemId: string;
  /** Stock value the browser observed before this count. Postgres rejects the
   * write if another count or receipt changed it first, preventing a stale
   * absolute count from erasing a newer delivery. */
  expectedStock: number;
  countedStock: number;
  estimatedStock?: number | null;
  notes?: string | null;
}

export interface InventoryCountRpcRow {
  item_id: string;
  expected_stock: number;
  counted_stock: number;
  estimated_stock?: number | null;
  notes?: string | null;
}

export type InventoryDeliveryLine =
  | {
      lineKey: string;
      itemId: string;
      quantity: number;
      quantityCases?: number | null;
      unitCost?: number | null;
    }
  | {
      lineKey: string;
      itemId: null;
      itemName: string;
      category: 'housekeeping' | 'maintenance' | 'breakfast';
      unit: string;
      parLevel: number;
      quantity: number;
      quantityCases?: number | null;
      unitCost?: number | null;
    };

export type InventoryDeliveryRpcLine =
  | {
      line_key: string;
      item_id: string;
      quantity: number;
      quantity_cases?: number | null;
      unit_cost?: number | null;
    }
  | {
      line_key: string;
      item_id: null;
      item_name: string;
      category: 'housekeeping' | 'maintenance' | 'breakfast';
      unit: string;
      par_level: number;
      quantity: number;
      quantity_cases?: number | null;
      unit_cost?: number | null;
    };

function requireFinite(name: string, value: number, min: number, inclusive: boolean): void {
  if (!Number.isFinite(value) || (inclusive ? value < min : value <= min)) {
    const relation = inclusive ? `at least ${min}` : `greater than ${min}`;
    throw new Error(`${name} must be finite and ${relation}.`);
  }
}

function requireUniqueKeys(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) throw new Error(`${label} cannot be blank.`);
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

export function toInventoryCountRpcRows(rows: readonly AtomicInventoryCountRow[]): InventoryCountRpcRow[] {
  if (rows.length === 0) throw new Error('At least one inventory count is required.');
  requireUniqueKeys(rows.map((row) => row.itemId), 'inventory item id');
  return rows.map((row) => {
    requireFinite('Expected stock', row.expectedStock, 0, true);
    requireFinite('Counted stock', row.countedStock, 0, true);
    if (row.estimatedStock != null) requireFinite('Estimated stock', row.estimatedStock, 0, true);
    return {
      item_id: row.itemId,
      expected_stock: row.expectedStock,
      counted_stock: row.countedStock,
      ...(row.estimatedStock == null ? {} : { estimated_stock: row.estimatedStock }),
      ...(row.notes == null ? {} : { notes: row.notes }),
    };
  });
}

export function toInventoryDeliveryRpcLines(lines: readonly InventoryDeliveryLine[]): InventoryDeliveryRpcLine[] {
  if (lines.length === 0) throw new Error('At least one delivery line is required.');
  requireUniqueKeys(lines.map((line) => line.lineKey), 'delivery line key');
  return lines.map((line) => {
    requireFinite('Delivery quantity', line.quantity, 0, false);
    if (line.quantityCases != null) requireFinite('Delivery case quantity', line.quantityCases, 0, false);
    if (line.unitCost != null) requireFinite('Unit cost', line.unitCost, 0, true);
    const common = {
      line_key: line.lineKey,
      quantity: line.quantity,
      ...(line.quantityCases == null ? {} : { quantity_cases: line.quantityCases }),
      ...(line.unitCost == null ? {} : { unit_cost: line.unitCost }),
    };
    if (line.itemId !== null) {
      if (!line.itemId.trim()) throw new Error('Inventory item id cannot be blank.');
      return { ...common, item_id: line.itemId };
    }
    if (!line.itemName.trim()) throw new Error('A new delivery item needs a name.');
    if (!line.unit.trim()) throw new Error('A new delivery item needs a unit.');
    requireFinite('Par level', line.parLevel, 0, true);
    return {
      ...common,
      item_id: null,
      item_name: line.itemName.trim(),
      category: line.category,
      unit: line.unit.trim(),
      par_level: line.parLevel,
    };
  });
}

/** Convert the reviewed invoice plan into additive delivery lines. Absolute
 * stockUpdates are deliberately ignored: the database increments the latest
 * locked stock value, so a stale browser estimate can never overwrite a count
 * that another employee saved while the invoice was being reviewed. */
export function deliveryLinesFromCommitPlan(plan: CommitPlan): InventoryDeliveryLine[] {
  const creates = new Map(plan.creates.map((create) => [create.createKey, create]));
  return plan.orders.flatMap((order): InventoryDeliveryLine[] => {
    if (order.itemId) {
      return [{
        lineKey: order.lineKey,
        itemId: order.itemId,
        quantity: order.quantity,
        quantityCases: order.quantityCases,
        unitCost: order.unitCost,
      }];
    }
    const create = order.createKey ? creates.get(order.createKey) : undefined;
    if (!create) return [];
    return [{
      lineKey: order.lineKey,
      itemId: null,
      itemName: create.name,
      category: create.category,
      unit: create.unit,
      parLevel: create.parLevel,
      quantity: order.quantity,
      quantityCases: order.quantityCases,
      unitCost: order.unitCost,
    }];
  });
}

/** Deterministic payload identity used to keep the same request UUID on a
 * retry, while assigning a new UUID if the operator edits the payload. */
export function inventoryPayloadFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

export type QuickCountWriteDecision = 'skip-saved' | 'skip-current' | 'write';

/**
 * Decide whether a debounced quick count still needs a database write.
 *
 * A realtime snapshot is only authoritative when no different value has just
 * committed locally. This matters for a fast 10 → 11 → 10 sequence: the
 * browser may still display the original 10 after Postgres has committed 11,
 * so the final 10 must be written instead of being mistaken for a no-op.
 */
export function decideQuickCountWrite(
  requestedValue: number,
  lastSavedValue: number | undefined,
  snapshotValue: number,
  snapshotHasPriorCount: boolean,
): QuickCountWriteDecision {
  if (lastSavedValue === requestedValue) return 'skip-saved';
  if (lastSavedValue == null && snapshotHasPriorCount && snapshotValue === requestedValue) {
    return 'skip-current';
  }
  return 'write';
}
