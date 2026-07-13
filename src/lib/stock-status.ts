// Shared stock/completion status — the app-wide 70/30 Good/Low/Critical rule.
//
// Boundary behavior matches the dominant (and unit-tested) implementation,
// `ratioToStatus` in src/lib/compliance/periods.ts:
//   ratio >= 0.7 → good      (exactly 70% of par is Good)
//   ratio >= 0.3 → low       (exactly 30% of par is Low)
//   otherwise    → critical
//
// Known divergent implementations elsewhere (NOT matched here — left as-is):
// - src/lib/reports/catalog/definitions.ts (inline, line ~448): `<=` on both
//   boundaries, so exactly 70% falls to Low and exactly 30% to Critical.
// - src/app/inventory/_components/format.ts `ratioStatus` (and its mirror in
//   src/lib/agent/tools/inventory-actions.ts): a different 0.5/1.0 family
//   (<0.5 critical, <1.0 low) — the Inventory tab's own rule, not 70/30.
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
