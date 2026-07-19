export interface InventoryPurchaseCostRow {
  total_cost: number | null;
  quantity: number | null;
  unit_cost: number | null;
  entry_kind?: 'receipt' | 'correction' | string | null;
}

/** A received line is cost-complete only when it has positive quantity and
 * either a non-negative authoritative total or non-negative unit cost. */
export function inventoryPurchaseRowValue(row: InventoryPurchaseCostRow): number | null {
  // Correction rows are compensating ledger entries. Their authoritative
  // total is deliberately signed; accepting it makes every purchase sum net
  // to the corrected delivery without rewriting the original receipt.
  if (row.entry_kind === 'correction') {
    if (row.total_cost == null) return null;
    const correctionTotal = Number(row.total_cost);
    return Number.isFinite(correctionTotal) ? correctionTotal : null;
  }
  const quantity = Number(row.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  if (row.total_cost != null) {
    const total = Number(row.total_cost);
    return Number.isFinite(total) && total >= 0 ? total : null;
  }
  if (row.unit_cost != null) {
    const unit = Number(row.unit_cost);
    return Number.isFinite(unit) && unit >= 0 ? unit * quantity : null;
  }
  return null;
}
