// Adapter — converts raw DB rows + ML state + occupancy bundle into
// the display-shaped objects every Snow component expects.

import type { InventoryItem } from '@/types';
import type { OccupancyBundle, OccupancySinceLastCount } from '@/lib/inventory-estimate';
import { calculateEstimatedStock, computeOccupancyForItem } from '@/lib/inventory-estimate';
import { predictReorder, type DailyAverages, type PredictionResult } from '@/lib/inventory-predictions';
import type { DisplayItem } from './types';
import { ratioStatus } from './format';
import { thumbKindFor } from './ItemThumb';
import type { InvCat } from './tokens';

const ITEM_TYPICAL_BURN_DAYS = 60; // fallback horizon when no rate data exists

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
  const status = ratioStatus(estimated, par);

  // Per-day burn — prefer ML rate when present, else fall back to
  // usage-per-occ-room math, else default to 60-day burn-through.
  const ml = opts.mlRateMap.get(item.id);
  let burn: number;
  let burnUnit: '/day' | '/occ-room';
  if (typeof ml === 'number' && ml > 0) {
    burn = ml;
    burnUnit = '/day';
  } else if (item.usagePerCheckout || item.usagePerStayover) {
    const perCheckout = item.usagePerCheckout ?? 0;
    const perStayover = item.usagePerStayover ?? 0;
    const ratePerOccRoom = Math.max(perCheckout, perStayover);
    burn = ratePerOccRoom;
    burnUnit = '/occ-room';
  } else {
    burn = par > 0 ? par / ITEM_TYPICAL_BURN_DAYS : 1;
    burnUnit = '/day';
  }

  // Convert to per-day for daysLeft.
  const occRoomsToday = opts.dailyAverages
    ? Math.max(1, opts.dailyAverages.avgDailyCheckouts + opts.dailyAverages.avgDailyStayovers)
    : 1;
  const burnPerDay = burnUnit === '/occ-room' ? burn * occRoomsToday : burn;
  const daysLeft = burnPerDay > 0 ? estimated / burnPerDay : 90;

  return {
    raw: item,
    id: item.id,
    name: item.name,
    cat: item.category as InvCat,
    thumb: thumbKindFor(item.name, item.category as InvCat),
    counted: item.currentStock,
    estimated: Math.max(0, Math.round(estimated)),
    par,
    unit: item.unit || 'unit',
    unitCost: item.unitCost ?? 0,
    vendor: item.vendorName ?? '',
    leadDays: item.reorderLeadDays ?? 3,
    burn,
    burnUnit,
    graduated: opts.autoFillGraduated.has(item.id),
    status,
    daysLeft: Math.max(0, Math.min(90, Math.round(daysLeft))),
    value: item.currentStock * (item.unitCost ?? 0),
    lastCountedAt: item.lastCountedAt ?? null,
  };
}

// Convert a DisplayItem + DailyAverages into a reorder recommendation
// (now/soon/ok) using the existing predictReorder helper.
const EMPTY_AVERAGES: DailyAverages = {
  avgDailyCheckouts: 0,
  avgDailyStayovers: 0,
  daysOfData: 0,
  source: 'none',
};
export function recommendReorder(
  d: DisplayItem,
  averages: DailyAverages | null,
  mlRateMap: Map<string, number>,
): { urgency: 'now' | 'soon' | 'ok'; pred: PredictionResult; reason: string } {
  const overrideRate = mlRateMap.get(d.id);
  const pred = predictReorder(d.raw, averages ?? EMPTY_AVERAGES, d.estimated, overrideRate);
  const urgency: 'now' | 'soon' | 'ok' =
    pred.urgency === 'now' ? 'now' : pred.urgency === 'soon' ? 'soon' : 'ok';
  // Build a friendly reason string. predictReorder doesn't return one.
  let reason: string;
  if (pred.daysUntilOut == null) {
    reason = 'no usage history yet';
  } else {
    reason = `${Math.max(0, Math.round(pred.daysUntilOut))}d left, ${d.leadDays}d lead`;
  }
  return { urgency, pred, reason };
}

// Suggest a reorder quantity for the recommendation card.
// Default = whatever brings stock back to par, rounded up to nearest pack.
export function suggestQuantity(d: DisplayItem): { qty: number; packsLabel: string } {
  const deficit = Math.max(0, d.par - d.estimated);
  const packSize = d.raw.packSize ?? 0;
  if (packSize > 0) {
    const packs = Math.max(1, Math.ceil(deficit / packSize));
    const qty = packs * packSize;
    const caseUnit = d.raw.caseUnit || 'case';
    return {
      qty,
      packsLabel: `${packs} ${pluralize(caseUnit, packs)} of ${packSize}`,
    };
  }
  const qty = Math.max(1, deficit);
  return { qty, packsLabel: `${qty} ${pluralize(d.unit, qty)}` };
}

// Pluralize without doubling the trailing "s". "units" stays "units" for any qty.
function pluralize(word: string, qty: number): string {
  if (qty === 1) return word;
  return /s$/i.test(word) ? word : `${word}s`;
}
