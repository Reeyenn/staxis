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
      customCategoryId?: string | null;
      unit: string;
      parLevel: number;
      setAside?: number;
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
      custom_category_id: string | null;
      unit: string;
      par_level: number;
      set_aside: number;
      quantity: number;
      quantity_cases?: number | null;
      unit_cost?: number | null;
    };

export type InventoryStockLossReason =
  | 'missing'
  | 'lost'
  | 'damaged'
  | 'stained'
  | 'theft'
  | 'other';

export interface InventoryStockLossInput {
  itemId: string;
  /** On-hand value displayed when the loss form opened. Postgres rejects a
   * stale form instead of subtracting from a newer count or delivery. */
  expectedStock: number;
  quantity: number;
  reason: InventoryStockLossReason;
  notes?: string | null;
}

export interface InventoryDeliveryCorrectionLine {
  lineKey: string;
  /** Root/original inventory_orders id. Correction rows are never targets. */
  orderId: string;
  /** Effective state displayed when History opened the correction form. */
  expectedItemId: string;
  expectedQuantity: number;
  expectedUnitCost: number | null;
  /** Null item + zero quantity means void. */
  correctedItemId: string | null;
  correctedQuantity: number;
  correctedUnitCost: number | null;
}

export interface InventoryDeliveryCorrectionRpcLine {
  line_key: string;
  order_id: string;
  expected_item_id: string;
  expected_quantity: number;
  expected_unit_cost: number | null;
  corrected_item_id: string | null;
  corrected_quantity: number;
  corrected_unit_cost: number | null;
}

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
      // Explicit null means the actual receipt cost is unknown. Omitting this
      // key let the legacy RPC substitute a catalog estimate and create a fake
      // invoice total.
      unit_cost: line.unitCost ?? null,
    };
    if (line.itemId !== null) {
      if (!line.itemId.trim()) throw new Error('Inventory item id cannot be blank.');
      return { ...common, item_id: line.itemId };
    }
    if (!line.itemName.trim()) throw new Error('A new delivery item needs a name.');
    if (!line.unit.trim()) throw new Error('A new delivery item needs a unit.');
    requireFinite('Par level', line.parLevel, 0, true);
    const setAside = line.setAside ?? 0;
    requireFinite('Set aside', setAside, 0, true);
    if (!Number.isInteger(setAside)) throw new Error('Set aside must be a whole number.');
    if (setAside > line.quantity) throw new Error('Set aside cannot exceed the received quantity.');
    return {
      ...common,
      item_id: null,
      item_name: line.itemName.trim(),
      category: line.category,
      custom_category_id: line.customCategoryId?.trim() || null,
      unit: line.unit.trim(),
      par_level: line.parLevel,
      set_aside: setAside,
    };
  });
}

export function validateInventoryStockLoss(input: InventoryStockLossInput): InventoryStockLossInput {
  if (!input.itemId.trim()) throw new Error('Inventory item id cannot be blank.');
  requireFinite('Expected stock', input.expectedStock, 0, true);
  requireFinite('Loss quantity', input.quantity, 0, false);
  if (!Number.isInteger(input.quantity)) throw new Error('Loss quantity must be a whole number.');
  if (input.quantity > input.expectedStock) throw new Error('Loss quantity cannot exceed current stock.');
  const reasons: readonly InventoryStockLossReason[] = [
    'missing', 'lost', 'damaged', 'stained', 'theft', 'other',
  ];
  if (!reasons.includes(input.reason)) throw new Error('Inventory loss reason is invalid.');
  return {
    ...input,
    itemId: input.itemId.trim(),
    notes: input.notes?.trim() || null,
  };
}

export function toInventoryDeliveryCorrectionRpcLines(
  lines: readonly InventoryDeliveryCorrectionLine[],
): InventoryDeliveryCorrectionRpcLine[] {
  if (lines.length === 0) throw new Error('At least one delivery correction line is required.');
  requireUniqueKeys(lines.map((line) => line.lineKey), 'delivery correction line key');
  requireUniqueKeys(lines.map((line) => line.orderId), 'delivery order id');
  return lines.map((line) => {
    const lineKey = line.lineKey.trim();
    const orderId = line.orderId.trim();
    const expectedItemId = line.expectedItemId.trim();
    if (!orderId) throw new Error('Delivery order id cannot be blank.');
    if (!expectedItemId) throw new Error('Expected inventory item id cannot be blank.');
    requireFinite('Expected delivery quantity', line.expectedQuantity, 0, true);
    requireFinite('Corrected delivery quantity', line.correctedQuantity, 0, true);
    if (line.expectedUnitCost != null) requireFinite('Expected unit cost', line.expectedUnitCost, 0, true);
    if (line.correctedUnitCost != null) requireFinite('Corrected unit cost', line.correctedUnitCost, 0, true);
    const correctedItemId = line.correctedItemId?.trim() || null;
    if (line.correctedQuantity === 0) {
      if (correctedItemId != null) throw new Error('A voided delivery cannot have a corrected item.');
      if (line.correctedUnitCost != null) throw new Error('A voided delivery cannot have a corrected unit cost.');
    } else if (correctedItemId == null) {
      throw new Error('A corrected delivery with stock needs an item.');
    }
    return {
      line_key: lineKey,
      order_id: orderId,
      expected_item_id: expectedItemId,
      expected_quantity: line.expectedQuantity,
      expected_unit_cost: line.expectedUnitCost,
      corrected_item_id: correctedItemId,
      corrected_quantity: line.correctedQuantity,
      corrected_unit_cost: line.correctedUnitCost,
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
      customCategoryId: create.customCategoryId,
      unit: create.unit,
      parLevel: create.parLevel,
      setAside: create.setAside,
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
