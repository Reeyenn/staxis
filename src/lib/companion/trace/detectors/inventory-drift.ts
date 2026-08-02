// ═══════════════════════════════════════════════════════════════════════════
// Detector: the count is telling you something about one item.
//
// Two signals, both computed at count time from tables the hotel already fills
// in by doing its ordinary work:
//
//   USAGE JUMP    This item is going out the door faster than it was, measured
//                 as a DAILY RATE between counts so an eight-week gap and a
//                 four-week gap are comparable. Counts are irregular in a real
//                 hotel and comparing raw totals would call every long month a
//                 crisis.
//
//   PRICE SPLIT   The same item arrived twice at two different unit prices.
//                 Not a judgement about which one is right: a supplier is
//                 allowed to change a price. It is worth one sentence because
//                 nobody reads two invoices side by side.
//
// BASELINE TREATMENT. Nothing is drawn here that a maintenance-shaped page
// would not also get: the item's own row is lit, the page steps back, and the
// ink card hangs in the space underneath. That is deliberate, and it is the
// proof that the overlay needs no page-specific work.
//
// ─── THIS CARD HAS NO BUTTONS, AND THAT IS THE POINT ───────────────────────
// There is no "flag for recount" in this product, and its absence is a decision
// somebody already made and wrote down (see the header of
// findings/actions/catalog/index.ts): `inventory_counts` records a count that
// HAPPENED, there is no request object to create, and inventing a table so that
// a button could exist is backwards. There is no supplier-email tool either.
//
// So the card says the thing and stops. A button that did nothing would be
// worse than no button on a card that just claimed to understand the stockroom.
//
// PURE. Rows in, patterns out, no clock of its own, no model call.
// ═══════════════════════════════════════════════════════════════════════════

import { formatMoney } from '@/lib/findings/pricing';
import { tracePatternKey } from '../identity';
import type { TraceAnchor, TraceFact, TracePattern } from '../types';

export const DETECTOR_ID = 'inventory_drift';

/** How much faster is worth a sentence. Below this it is a busy fortnight. */
export const USAGE_JUMP_RATIO = 1.25;

/** How far apart two prices have to be before it is worth saying. */
export const PRICE_SPLIT_RATIO = 1.1;

/** Counts needed before there are two intervals to compare. */
export const MIN_COUNTS = 3;

/** Days of history the price comparison looks back over. */
export const PRICE_WINDOW_DAYS = 120;

/** One row of `inventory_counts`, as this detector needs it. */
export interface TraceCountPoint {
  readonly itemId: string;
  readonly countedStock: number;
  /** ISO. */
  readonly countedAt: string;
}

/** One effective delivery line. Superseded corrections are filtered upstream. */
export interface TraceDelivery {
  readonly id: string;
  readonly itemId: string;
  readonly quantity: number;
  /** Whole currency units off `inventory_orders.unit_cost`, or null. */
  readonly unitCost: number | null;
  readonly vendorName: string | null;
  /** ISO. `received_at`, which is the closest thing to an invoice date that
   *  this schema stores: the scan reads an invoice date and throws it away. */
  readonly receivedAt: string;
}

export interface TraceInventoryItem {
  readonly id: string;
  readonly name: string;
  readonly parLevel: number | null;
}

export interface InventoryDriftInput {
  readonly now: Date;
  readonly items: readonly TraceInventoryItem[];
  readonly counts: readonly TraceCountPoint[];
  readonly deliveries: readonly TraceDelivery[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
}

/** "24 Jul" — short, unambiguous, and the hotel's own record either way. */
export function shortDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `${at.getUTCDate()} ${at.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
}

/**
 * How much of an item left the building between two counts, per day.
 *
 * opening + everything delivered in between - closing, over the gap. Returns
 * null for a gap too short to mean anything and for arithmetic that comes out
 * negative, which is a miscount rather than a discovery and is not the thing
 * this detector is for.
 */
export function dailyUsageBetween(
  from: TraceCountPoint,
  to: TraceCountPoint,
  deliveries: readonly TraceDelivery[],
): number | null {
  const gap = daysBetween(from.countedAt, to.countedAt);
  if (!Number.isFinite(gap) || gap < 5) return null;
  const fromAt = Date.parse(from.countedAt);
  const toAt = Date.parse(to.countedAt);
  let delivered = 0;
  for (const d of deliveries) {
    const at = Date.parse(d.receivedAt);
    if (at > fromAt && at <= toAt) delivered += d.quantity;
  }
  const used = from.countedStock + delivered - to.countedStock;
  if (!(used > 0)) return null;
  return used / gap;
}

interface ItemHistory {
  readonly item: TraceInventoryItem;
  readonly counts: TraceCountPoint[];
  readonly deliveries: TraceDelivery[];
}

function historiesFor(input: InventoryDriftInput): ItemHistory[] {
  const byItem = new Map<string, ItemHistory>();
  for (const item of input.items) {
    byItem.set(item.id, { item, counts: [], deliveries: [] });
  }
  for (const c of input.counts) {
    byItem.get(c.itemId)?.counts.push(c);
  }
  for (const d of input.deliveries) {
    byItem.get(d.itemId)?.deliveries.push(d);
  }
  for (const h of byItem.values()) {
    h.counts.sort((a, b) => Date.parse(a.countedAt) - Date.parse(b.countedAt));
    h.deliveries.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }
  return [...byItem.values()];
}

// ─── Usage jump ─────────────────────────────────────────────────────────────

function usageJumpFor(h: ItemHistory): TracePattern | null {
  if (h.counts.length < MIN_COUNTS) return null;
  const rates: Array<{ rate: number; from: TraceCountPoint; to: TraceCountPoint }> = [];
  for (let i = 1; i < h.counts.length; i += 1) {
    const rate = dailyUsageBetween(h.counts[i - 1], h.counts[i], h.deliveries);
    if (rate !== null) rates.push({ rate, from: h.counts[i - 1], to: h.counts[i] });
  }
  if (rates.length < 2) return null;

  const latest = rates[rates.length - 1];
  const prior = rates.slice(0, -1);
  const priorMean = prior.reduce((sum, r) => sum + r.rate, 0) / prior.length;
  if (!(priorMean > 0)) return null;
  if (latest.rate < priorMean * USAGE_JUMP_RATIO) return null;

  // A percentage of a tiny number is a big percentage of nothing. The extra
  // units per month have to be worth walking to the stockroom about, and par
  // is the hotel's own statement of what "worth it" means for this item.
  const extraPerMonth = (latest.rate - priorMean) * 30;
  const par = h.item.parLevel ?? 0;
  if (par > 0 && extraPerMonth < par * 0.1) return null;
  if (par <= 0 && extraPerMonth < 5) return null;

  const percent = Math.round(((latest.rate - priorMean) / priorMean) * 100);
  const facts: TraceFact[] = [
    {
      k: 'This period',
      v: `${Math.round(latest.rate * 30)} a month, counted ${shortDay(latest.from.countedAt)} to `
        + `${shortDay(latest.to.countedAt)}`,
    },
    {
      k: 'Before that',
      v: `${Math.round(priorMean * 30)} a month, averaged over `
        + `${prior.length} earlier ${prior.length === 1 ? 'period' : 'periods'}`,
    },
  ];

  return {
    key: tracePatternKey(DETECTOR_ID, ['usage', h.item.id]),
    detectorId: DETECTOR_ID,
    page: 'inventory',
    ask: `${h.item.name} is going out faster than it was. Mind if I show you?`,
    kicker: `Usage up ${percent}% · ${h.item.name}`,
    body: `${h.item.name} is leaving the building about ${percent}% faster than it was over the `
      + 'earlier counts, at the same par. Something changed, and the count is where it shows up first.',
    facts,
    // No money. Usage moving does not by itself cost anything knowable: what it
    // costs depends on which of several causes it is, and that is not something
    // this detector can tell from a count sheet.
    cost: null,
    basis: `${h.counts.length} counts of ${h.item.name} and every delivery logged between them.`,
    anchors: [{ domId: `inv:${h.item.id}`, label: h.item.name.toUpperCase(), present: true }],
    actions: [],
    sensitivity: 'operational',
    severity: percent >= 50 ? 'urgent' : 'watch',
    covers: [`item:inventory:${h.item.id}`],
    magnitude: percent,
  };
}

// ─── Price split ────────────────────────────────────────────────────────────

function priceSplitFor(h: ItemHistory, now: Date): TracePattern | null {
  const cutoff = now.getTime() - PRICE_WINDOW_DAYS * DAY_MS;
  const priced = h.deliveries.filter(
    (d) => typeof d.unitCost === 'number' && d.unitCost > 0 && Date.parse(d.receivedAt) >= cutoff,
  );
  if (priced.length < 2) return null;

  const sorted = [...priced].sort((a, b) => (a.unitCost as number) - (b.unitCost as number));
  const cheap = sorted[0];
  const dear = sorted[sorted.length - 1];
  const low = cheap.unitCost as number;
  const high = dear.unitCost as number;
  if (high < low * PRICE_SPLIT_RATIO) return null;

  const anchors: TraceAnchor[] = [
    { domId: `inv:${h.item.id}`, label: h.item.name.toUpperCase(), present: true },
  ];

  const percent = Math.round(((high - low) / low) * 100);
  const facts: TraceFact[] = [
    {
      k: shortDay(cheap.receivedAt),
      v: `${formatMoney(Math.round(low * 100))} each${cheap.vendorName ? ` from ${cheap.vendorName}` : ''}`,
    },
    {
      k: shortDay(dear.receivedAt),
      v: `${formatMoney(Math.round(high * 100))} each${dear.vendorName ? ` from ${dear.vendorName}` : ''}`,
    },
  ];

  return {
    key: tracePatternKey(DETECTOR_ID, ['price', h.item.id]),
    detectorId: DETECTOR_ID,
    page: 'inventory',
    ask: `${h.item.name} came in at two different prices. Mind if I show you?`,
    kicker: `Two prices · ${h.item.name}`,
    body: `The same ${h.item.name} arrived twice at prices ${percent}% apart. That is allowed and it `
      + 'may be nothing, but nobody reads two invoices side by side, so here they are.',
    facts,
    cost: {
      // A real difference off two real rows, per unit. Not a projection, and
      // deliberately not multiplied by anything: what it costs over a year
      // depends on how much gets ordered, and that is not a number to guess.
      figure: formatMoney(Math.round((high - low) * 100)),
      line: 'more per unit on the later delivery, off the two rows below',
      basis: 'Both figures are unit costs recorded on this hotel\'s own delivery lines.',
    },
    basis: `${priced.length} priced deliveries of ${h.item.name} in the last ${PRICE_WINDOW_DAYS} days.`,
    anchors,
    actions: [],
    sensitivity: 'operational',
    severity: 'watch',
    covers: [`item:inventory:${h.item.id}`],
    magnitude: percent,
  };
}

export function detectInventoryDrift(input: InventoryDriftInput): TracePattern[] {
  const out: TracePattern[] = [];
  for (const h of historiesFor(input)) {
    const jump = usageJumpFor(h);
    if (jump) out.push(jump);
    const split = priceSplitFor(h, input.now);
    if (split) out.push(split);
  }
  return out.sort((a, b) => b.magnitude - a.magnitude);
}
