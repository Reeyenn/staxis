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
    customCategoryId: item.customCategoryId ?? null,
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
  let daysLeft: number;
  if (d.estimated > 0) {
    // burn/day ≈ estimated / daysLeft → new days = value / burn = value·days/est
    daysLeft = Math.max(0, Math.min(90, Math.round((value / d.estimated) * d.daysLeft)));
  } else {
    // Stepping up off a zero estimate: no burn signal to project from.
    daysLeft = value > 0 ? 90 : 0;
  }
  return {
    ...d,
    counted: value,
    estimated: value,
    status: ratioStatus(value, d.par),
    daysLeft,
    value: value * d.unitCost,
    uncounted: false,
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
  // predictReorder answers 'unknown' when there's not enough usage history to
  // forecast (every item on a young hotel). 'unknown' is NOT 'ok': a hotel
  // with <7 days of data still has items sitting below par, and painting them
  // green "OK for now" contradicts the ledger's red "Order now" pill. With no
  // forecast, fall back to the same stock-vs-par status the ledger shows.
  const urgency: 'now' | 'soon' | 'ok' =
    pred.urgency === 'now' || pred.urgency === 'soon'
      ? pred.urgency
      : pred.urgency === 'unknown' && !d.uncounted
        ? (d.status === 'critical' ? 'now' : d.status === 'low' ? 'soon' : 'ok')
        : 'ok';
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

// Packaging label for an arbitrary quantity ("5 cases of 12" / "24 units").
// Lives here so the reorder row can re-derive it whenever the GM edits the
// quantity — a static label from the original suggestion goes stale.
export function packsLabelFor(d: DisplayItem, qty: number, lang: Lang = 'en'): string {
  const es = lang === 'es';
  const q = Math.max(0, Math.round(qty));
  const packSize = d.raw.packSize ?? 0;
  if (packSize > 0) {
    const packs = Math.max(1, Math.ceil(q / packSize));
    // caseUnit is a data value (e.g. "case", "box") — keep it as stored; only
    // the connective word ("of"/"de") is translated.
    const caseUnit = d.raw.caseUnit || (es ? 'caja' : 'case');
    return `${packs} ${pluralize(caseUnit, packs)} ${es ? 'de' : 'of'} ${packSize}`;
  }
  return `${q} ${pluralize(d.unit, q)}`;
}

// Suggest a reorder quantity for the recommendation card.
// Default = whatever brings stock back to par, rounded up to nearest pack.
export function suggestQuantity(d: DisplayItem, lang: Lang = 'en'): { qty: number; packsLabel: string } {
  const deficit = Math.max(0, d.par - d.estimated);
  const packSize = d.raw.packSize ?? 0;
  const qty = packSize > 0
    ? Math.max(1, Math.ceil(deficit / packSize)) * packSize
    : Math.max(1, deficit);
  return { qty, packsLabel: packsLabelFor(d, qty, lang) };
}

// Pluralize without doubling the trailing "s". "units" stays "units" for any qty.
function pluralize(word: string, qty: number): string {
  if (qty === 1) return word;
  return /s$/i.test(word) ? word : `${word}s`;
}
