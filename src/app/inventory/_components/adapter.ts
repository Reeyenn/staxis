// Adapter — converts raw DB rows + ML state + occupancy bundle into
// the display-shaped objects every Snow component expects.

import type { InventoryItem } from '@/types';
import type { OccupancyBundle, OccupancySinceLastCount } from '@/lib/inventory-estimate';
import { calculateEstimatedStock, computeOccupancyForItem } from '@/lib/inventory-estimate';
import {
  predictReorder,
  ruleOccupancyBurnPerDay,
  selectBurnRate,
  type DailyAverages,
  type PredictionResult,
} from '@/lib/inventory-predictions';
import type { DisplayItem } from './types';
import { ratioStatus } from './format';
import { thumbKindFor } from './ItemThumb';
import type { InvCat } from './tokens';
import type { Lang } from './inv-i18n';

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
  const daysLeft = burnForDays > 0 ? estimated / burnForDays : 90;

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
    burn: selected.burn,
    burnUnit: selected.burnUnit,
    burnSource: selected.burnSource,
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
  lang: Lang = 'en',
): { urgency: 'now' | 'soon' | 'ok'; pred: PredictionResult; reason: string } {
  const overrideRate = mlRateMap.get(d.id);
  const pred = predictReorder(d.raw, averages ?? EMPTY_AVERAGES, d.estimated, overrideRate);
  const urgency: 'now' | 'soon' | 'ok' =
    pred.urgency === 'now' ? 'now' : pred.urgency === 'soon' ? 'soon' : 'ok';
  // Build a friendly reason string. predictReorder doesn't return one.
  // Honesty-audit Phase 4: append a source suffix so a row that came from
  // the 60-day fallback is visibly different from a row backed by ML.
  const es = lang === 'es';
  let reason: string;
  if (pred.daysUntilOut == null) {
    reason = es ? 'sin historial de uso aún' : 'no usage history yet';
  } else {
    const days = Math.max(0, Math.round(pred.daysUntilOut));
    reason = es
      ? `${days}d restantes, ${d.leadDays}d entrega`
      : `${days}d left, ${d.leadDays}d lead`;
  }
  if (d.burnSource === 'fallback-60d') {
    reason = `${reason} · ${es ? 'est' : 'est'}`;
  } else if (d.burnSource === 'no-data') {
    reason = `${reason} · ${es ? 'sin datos' : 'no data'}`;
  } else if (d.burnSource === 'ml') {
    reason = `${reason} · ${es ? 'ia' : 'ai'}`;
  }
  return { urgency, pred, reason };
}

// Suggest a reorder quantity for the recommendation card.
// Default = whatever brings stock back to par, rounded up to nearest pack.
export function suggestQuantity(d: DisplayItem, lang: Lang = 'en'): { qty: number; packsLabel: string } {
  const es = lang === 'es';
  const deficit = Math.max(0, d.par - d.estimated);
  const packSize = d.raw.packSize ?? 0;
  if (packSize > 0) {
    const packs = Math.max(1, Math.ceil(deficit / packSize));
    const qty = packs * packSize;
    // caseUnit is a data value (e.g. "case", "box") — keep it as stored; only
    // the connective word ("of"/"de") is translated.
    const caseUnit = d.raw.caseUnit || (es ? 'caja' : 'case');
    return {
      qty,
      packsLabel: `${packs} ${pluralize(caseUnit, packs)} ${es ? 'de' : 'of'} ${packSize}`,
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
