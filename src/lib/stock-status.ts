// Shared stock/completion status — the app-wide 70/30 Good/Low/Critical rule.
//
// Boundary behavior matches the dominant (and unit-tested) implementation,
// `ratioToStatus` in src/lib/compliance/periods.ts:
//   ratio >= 0.7 → good      (exactly 70% of par is Good)
//   ratio >= 0.3 → low       (exactly 30% of par is Low)
//   otherwise    → critical
//
// Callers that used to disagree and now share this module:
// - src/app/inventory/_components/format.ts `ratioStatus` (re-export).
// - src/lib/agent/tools/inventory-actions.ts `get_low_stock` (was a private
//   0.5/1.0 copy, so the assistant contradicted the board it was describing).
// - src/lib/reports/catalog/definitions.ts `inventory-low-stock`, via
//   `reorderListLabel` below (was `<=` on both boundaries, so exactly 70% of
//   par printed "Low" and exactly 30% printed "Critical").
//
// Still deliberately different (a separate rule, not a drifted copy):
// - src/app/maintenance/_components/EquipmentTab.tsx: qty <= reorderAt
//   (default 30% of par) → low; qty <= 0 → out.

export type StockStatus = 'good' | 'low' | 'critical';

/**
 * Classify an on-hand quantity against a par level with the 70/30 rule.
 * A missing/zero/invalid par can't be judged — returns 'good' (mirrors the
 * `par <= 0 → 'good'` guard in inventory's ratioStatus).
 */
export function stockStatus(onHand: number, par: number): StockStatus {
  if (!Number.isFinite(par) || par <= 0) return 'good';
  const ratio = (Number.isFinite(onHand) ? onHand : 0) / par;
  if (ratio >= 0.7) return 'good';
  if (ratio >= 0.3) return 'low';
  return 'critical';
}

/** Label for a row on a reorder list, where every row is already known to be at
 * or below its reorder point. The two shortage labels are the house 70/30 ones
 * so a row can never be called Critical on one screen and Low on another; an
 * item that is healthy against par but below a hotel-set reorder point is
 * "Reorder", which is why this needs a third word rather than reusing
 * stockStatus directly. */
export function reorderListLabel(onHand: number, par: number): 'Critical' | 'Low' | 'Reorder' {
  // Nothing on the shelf is Critical whatever the par says. stockStatus already
  // answers that for a real par; this also covers the no-par item, which it has
  // to call 'good' because an absent target cannot be judged.
  if (!(Number.isFinite(onHand) && onHand > 0)) return 'Critical';
  const status = stockStatus(onHand, par);
  if (status === 'critical') return 'Critical';
  if (status === 'low') return 'Low';
  return 'Reorder';
}
