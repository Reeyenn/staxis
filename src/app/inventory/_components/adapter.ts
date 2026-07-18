// Adapter — converts raw DB rows + ML state + occupancy bundle into
// the display-shaped objects every Snow component expects.

import type { InventoryItem } from '@/types';
import type { OccupancyBundle, OccupancySinceLastCount } from '@/lib/inventory-estimate';
import { calculateEstimatedStock, computeOccupancyForItem } from '@/lib/inventory-estimate';
import {
  ruleOccupancyBurnPerDay,
  selectBurnRate,
  type DailyAverages,
} from '@/lib/inventory-predictions';
import type { DisplayItem } from './types';
import { ratioStatus } from './format';
import { thumbKindFor } from './ItemThumb';
import type { InvCat } from './tokens';

export function toDisplayItem(
  item: InventoryItem,
  opts: {
    occupancy: OccupancyBundle | null;
    dailyAverages: DailyAverages | null;
    mlRateMap: Map<string, number>;
    autoFillGraduated: Set<string>;
  },
): DisplayItem {
  let occ: OccupancySinceLastCount = { checkouts: 0, stayovers: 0, windowStart: '', source: 'none' };
  let estimated = item.currentStock;
  if (opts.occupancy) {
    occ = computeOccupancyForItem(opts.occupancy, item);
    const result = calculateEstimatedStock(item, occ);
    estimated = result.estimated;
  }

  const par = Math.max(0, item.parLevel || 0);
  // Set-aside units (stained / awaiting repair, 0321) are owned but not
  // usable: value math stays on the TOTAL, but status and days-left run on
  // what can actually be used — 30 stained sheets must not hide a shortage.
  const setAside = Math.max(0, item.setAside ?? 0);
  const usable = Math.max(0, Math.round(estimated) - setAside);
  const status = ratioStatus(usable, par);

  // Honesty-audit Phase 4: explicit burn-source selection via the pure
  // helper in @/lib/inventory-predictions. The previous inline if/else
  // produced numbers without telling the UI which source they came from.
  // selectBurnRate classifies every item into ml / rule-occupancy /
  // fallback-60d / no-data, and the UI consumes burnSource to decide
  // when to show a real number vs. an em-dash and how to pre-check the
  // reorder panel.
  const occRoomsToday = opts.dailyAverages
    ? Math.max(1, opts.dailyAverages.avgDailyCheckouts + opts.dailyAverages.avgDailyStayovers)
    : 1;
  const ml = opts.mlRateMap.get(item.id);
  const selected = selectBurnRate(
    {
      id: item.id,
      usagePerCheckout: item.usagePerCheckout,
      usagePerStayover: item.usagePerStayover,
      parLevel: par,
    },
    ml,
    occRoomsToday,
  );
  // For the days-left NUMBER, use the same occupancy-weighted formula the
  // reorder panel (predictReorder) uses, so the card and the panel can't show
  // contradictory days-left for the same item. selectBurnRate is still the
  // source-of-truth for the badge (ml / rule-occupancy / fallback-60d / no-data).
  const burnForDays =
    selected.burnSource === 'rule-occupancy' && opts.dailyAverages
      ? ruleOccupancyBurnPerDay(
          item.usagePerCheckout,
          item.usagePerStayover,
          opts.dailyAverages.avgDailyCheckouts,
          opts.dailyAverages.avgDailyStayovers,
        )
      : selected.burnPerDay;
  // Days-left runs on USABLE stock — a set-aside pile can't serve rooms.
  const daysLeft = burnForDays > 0 ? usable / burnForDays : 90;

  return {
    raw: item,
    id: item.id,
    name: item.name,
    cat: item.category as InvCat,
    customCategoryId: item.customCategoryId ?? null,
    thumb: thumbKindFor(item.name, item.category as InvCat),
    counted: item.currentStock,
    setAside,
    usable,
    estimated: Math.max(0, Math.round(estimated)),
    par,
    unit: item.unit || 'unit',
    unitCost: item.unitCost ?? 0,
    vendor: item.vendorName ?? '',
    leadDays: item.reorderLeadDays ?? 3,
    burn: selected.burn,
    burnUnit: selected.burnUnit,
    burnSource: selected.burnSource,
    graduated: opts.autoFillGraduated.has(item.id),
    status,
    // Never counted + empty = brand-new seeded item (current_stock 0, no
    // last_counted_at). No real signal yet → render neutral "not counted yet",
    // not a red "critical". A real zero COUNT (last_counted_at set) stays
    // critical — that's a genuine stockout, not an unknown.
    uncounted: item.lastCountedAt == null && item.currentStock === 0,
    daysLeft: Math.max(0, Math.min(90, Math.round(daysLeft))),
    value: item.currentStock * (item.unitCost ?? 0),
    lastCountedAt: item.lastCountedAt ?? null,
  };
}

// Layer an in-flight quick-count over a DisplayItem so the ledger row AND the
// masthead stats recompute live before the debounced save lands (README:
// "draftCounts … layered over DisplayItem.estimated until the save lands, then
// cleared on refresh"). A tapped item is now a real count, so `uncounted`
// flips false and it rejoins triage; status/value follow the draft, and
// days-left scales proportionally off the original burn (no re-plumbing of the
// burn math — `burnSource` is preserved so the honesty em-dash rule still
// applies for fallback/no-data items).
export function applyDraft(d: DisplayItem, draft: number | undefined): DisplayItem {
  if (draft == null) return d;
  const value = Math.max(0, Math.round(draft));
  // The stepper edits the TOTAL on hand; the set-aside portion stays put, so
  // usable (which drives status/days) moves with the draft.
  const usable = Math.max(0, value - d.setAside);
  let daysLeft: number;
  if (d.usable > 0) {
    // burn/day ≈ usable / daysLeft → new days = usable·days/oldUsable
    daysLeft = Math.max(0, Math.min(90, Math.round((usable / d.usable) * d.daysLeft)));
  } else {
    // Stepping up off a zero usable estimate: no burn signal to project from.
    daysLeft = usable > 0 ? 90 : 0;
  }
  return {
    ...d,
    counted: value,
    estimated: value,
    usable,
    status: ratioStatus(usable, d.par),
    daysLeft,
    value: value * d.unitCost,
    uncounted: false,
  };
}
