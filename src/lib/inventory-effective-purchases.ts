/**
 * Pure effective-purchase projection for the append-only inventory delivery
 * ledger introduced by migration 0324.
 *
 * The order ledger keeps the original receipt plus signed compensating rows.
 * Missing-cost completeness cannot be inferred by treating every NULL ledger
 * row as an unresolved delivery: a fully voided receipt is complete $0, and an
 * originally uncosted receipt can later be corrected to a known amount.  The
 * immutable correction chain is therefore the source of truth for each root's
 * terminal item, quantity, and value.
 */

export interface EffectivePurchaseOrderInput {
  id: string;
  item_id: string;
  quantity: number | string | null;
  unit_cost: number | string | null;
  total_cost: number | string | null;
  entry_kind?: string | null;
  corrects_order_id?: string | null;
  correction_event_id?: string | null;
  received_at?: string | null;
}

export interface EffectivePurchaseCorrectionInput {
  id: string;
  original_order_id: string;
  prior_correction_id: string | null;
  correction_kind: string;
  corrected_item_id: string | null;
  corrected_quantity: number | string;
  corrected_total_cost: number | string | null;
}

export interface EffectivePurchaseReceipt {
  rootOrderId: string;
  receivedAt: string | null;
  itemId: string | null;
  quantity: number;
  /** Null means this still-live receipt has unresolved cost evidence. */
  valueCents: number | null;
  voided: boolean;
}

export interface EffectivePurchaseSummary {
  receipts: EffectivePurchaseReceipt[];
  loggedDeliveryCount: number;
  uncostedDeliveryCount: number;
  knownLoggedPurchaseCents: number;
  loggedPurchaseCents: number | null;
  byItem: Map<string, { quantity: number; cents: number }>;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function receiptValueCents(
  order: Pick<EffectivePurchaseOrderInput, 'quantity' | 'unit_cost' | 'total_cost'>,
): number | null {
  const quantity = finite(order.quantity);
  const total = finite(order.total_cost);
  const unit = finite(order.unit_cost);
  if (quantity == null || quantity <= 0) {
    throw new Error('Inventory receipt has an invalid quantity.');
  }
  const dollars = total ?? (unit == null ? null : quantity * unit);
  if (dollars == null) return null;
  if (dollars < 0) throw new Error('Inventory receipt has a negative purchase value.');
  return Math.round(dollars * 100);
}

function terminalCorrection(
  rootOrderId: string,
  rows: readonly EffectivePurchaseCorrectionInput[],
): EffectivePurchaseCorrectionInput {
  const byId = new Map<string, EffectivePurchaseCorrectionInput>();
  const referenced = new Set<string>();
  for (const row of rows) {
    if (!row.id || row.original_order_id !== rootOrderId || byId.has(row.id)) {
      throw new Error(`Inventory delivery correction chain is invalid for receipt ${rootOrderId}.`);
    }
    byId.set(row.id, row);
    if (row.prior_correction_id) referenced.add(row.prior_correction_id);
  }
  const terminals = rows.filter((row) => !referenced.has(row.id));
  if (terminals.length !== 1) {
    throw new Error(`Inventory delivery correction chain has no unique terminal event for receipt ${rootOrderId}.`);
  }

  // Walk terminal -> root. This rejects cycles, missing parents, and disconnected
  // correction fragments instead of displaying a plausible but wrong subtotal.
  const visited = new Set<string>();
  let cursor: EffectivePurchaseCorrectionInput | undefined = terminals[0];
  while (cursor) {
    if (visited.has(cursor.id)) {
      throw new Error(`Inventory delivery correction chain contains a cycle for receipt ${rootOrderId}.`);
    }
    visited.add(cursor.id);
    if (!cursor.prior_correction_id) break;
    cursor = byId.get(cursor.prior_correction_id);
    if (!cursor) {
      throw new Error(`Inventory delivery correction chain is incomplete for receipt ${rootOrderId}.`);
    }
  }
  if (visited.size !== rows.length) {
    throw new Error(`Inventory delivery correction chain is disconnected for receipt ${rootOrderId}.`);
  }
  return terminals[0];
}

export function summarizeEffectivePurchases(
  orders: readonly EffectivePurchaseOrderInput[],
  corrections: readonly EffectivePurchaseCorrectionInput[],
): EffectivePurchaseSummary {
  const roots = new Map<string, EffectivePurchaseOrderInput>();
  const correctionOrders: EffectivePurchaseOrderInput[] = [];
  for (const order of orders) {
    const kind = order.entry_kind ?? 'receipt';
    if (kind === 'receipt') {
      if (!order.id || roots.has(order.id)) {
        throw new Error('Inventory purchase ledger contains a duplicate receipt root.');
      }
      roots.set(order.id, order);
    } else if (kind === 'correction') {
      correctionOrders.push(order);
    } else {
      throw new Error(`Inventory purchase ledger has an unsupported entry kind: ${kind}.`);
    }
  }

  const correctionsByRoot = new Map<string, EffectivePurchaseCorrectionInput[]>();
  const correctionById = new Map<string, EffectivePurchaseCorrectionInput>();
  for (const correction of corrections) {
    if (!roots.has(correction.original_order_id)) {
      throw new Error(`Inventory correction references a receipt outside the loaded purchase window: ${correction.original_order_id}.`);
    }
    if (correctionById.has(correction.id)) {
      throw new Error(`Inventory delivery correction ${correction.id} is duplicated.`);
    }
    correctionById.set(correction.id, correction);
    const group = correctionsByRoot.get(correction.original_order_id) ?? [];
    group.push(correction);
    correctionsByRoot.set(correction.original_order_id, group);
  }

  // A signed correction row without its immutable evidence would otherwise be
  // silently treated as an ordinary receipt. Refuse the projection instead.
  for (const order of correctionOrders) {
    const rootId = order.corrects_order_id ?? '';
    const eventId = order.correction_event_id ?? '';
    const evidence = correctionById.get(eventId);
    if (!rootId || !roots.has(rootId) || !eventId || evidence?.original_order_id !== rootId) {
      throw new Error('Inventory purchase correction ledger is missing its immutable evidence.');
    }
  }

  const receipts: EffectivePurchaseReceipt[] = [];
  for (const root of roots.values()) {
    const chain = correctionsByRoot.get(root.id) ?? [];
    if (chain.length === 0) {
      const quantity = finite(root.quantity);
      if (quantity == null || quantity <= 0) {
        throw new Error(`Inventory receipt ${root.id} has an invalid quantity.`);
      }
      receipts.push({
        rootOrderId: root.id,
        receivedAt: root.received_at ?? null,
        itemId: root.item_id,
        quantity,
        valueCents: receiptValueCents(root),
        voided: false,
      });
      continue;
    }

    const terminal = terminalCorrection(root.id, chain);
    const quantity = finite(terminal.corrected_quantity);
    if (terminal.correction_kind === 'void') {
      if (quantity !== 0 || terminal.corrected_item_id !== null || terminal.corrected_total_cost !== null) {
        throw new Error(`Voided inventory receipt ${root.id} has an invalid terminal shape.`);
      }
      receipts.push({
        rootOrderId: root.id,
        receivedAt: root.received_at ?? null,
        itemId: null,
        quantity: 0,
        valueCents: 0,
        voided: true,
      });
      continue;
    }
    if (terminal.correction_kind !== 'correction' || quantity == null || quantity <= 0 || !terminal.corrected_item_id) {
      throw new Error(`Corrected inventory receipt ${root.id} has an invalid terminal shape.`);
    }
    const correctedTotal = finite(terminal.corrected_total_cost);
    if (correctedTotal != null && correctedTotal < 0) {
      throw new Error(`Corrected inventory receipt ${root.id} has a negative purchase value.`);
    }
    receipts.push({
      rootOrderId: root.id,
      receivedAt: root.received_at ?? null,
      itemId: terminal.corrected_item_id,
      quantity,
      valueCents: correctedTotal == null ? null : Math.round(correctedTotal * 100),
      voided: false,
    });
  }

  const uncostedDeliveryCount = receipts.filter((receipt) => !receipt.voided && receipt.valueCents == null).length;
  const knownLoggedPurchaseCents = receipts.reduce((sum, receipt) => sum + (receipt.valueCents ?? 0), 0);
  const byItem = new Map<string, { quantity: number; cents: number }>();
  for (const receipt of receipts) {
    if (!receipt.itemId || receipt.voided) continue;
    const current = byItem.get(receipt.itemId) ?? { quantity: 0, cents: 0 };
    current.quantity += receipt.quantity;
    current.cents += receipt.valueCents ?? 0;
    byItem.set(receipt.itemId, current);
  }

  return {
    receipts,
    loggedDeliveryCount: receipts.length,
    uncostedDeliveryCount,
    knownLoggedPurchaseCents,
    loggedPurchaseCents: uncostedDeliveryCount === 0 ? knownLoggedPurchaseCents : null,
    byItem,
  };
}
