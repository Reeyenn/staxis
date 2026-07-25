// ─── Detector: an item going out the door faster than it used to ─────────────
//
// Between any two counts of an item, the hotel's own books say what happened:
//
//   used = stock at the earlier count + delivered - discarded - stock at the later count
//
// Divide by the days between and you have a rate, in that item's own units, for
// that hotel, computed from rows a manager entered themselves. When one of
// those rates jumps clear of the ten before it, something changed: a leak, a
// guest amenity being over-set, a housekeeper restocking a cart that never gets
// counted back, or theft. The detector does not guess which — it says the rate
// moved and shows the arithmetic.
//
// WHAT THIS SERIES CANNOT DO, STATED RATHER THAN PAPERED OVER
// The other two baseline detectors compare fixed 7-day windows, so every window
// they weigh has an identical mix of weekdays. This one CANNOT: counts happen
// when somebody counts, so one interval may be a busy Fri-Sun and the next a
// quiet midweek. There is no weekday control here, and nothing corrects for
// occupancy either — a full house genuinely uses more soap. That is exactly why
// the bar is higher than its siblings' (a bigger z, and at least ten prior
// intervals for the item) and why the finding is phrased as something to look
// at rather than something that is definitely wrong.
//
// Annual seasonality is not handled by any of the three. Twelve weeks cannot
// see a year.

import { addDaysInTz } from '@/lib/schedule/local-date';

import { registerDetector } from '../registry';
import {
  excessBand,
  formatCents,
  multiplyBands,
  percentile,
  plural,
  priceFromBand,
} from '../pricing';
import type { InventoryItemUsage, InventoryUsageHistory } from '../history';
import type { Detector, DetectorContext, DetectorParams, FindingDraft } from '../types';
import { readFeed } from '../types';
import { robustBaseline, deviationOf } from './baseline-math';

const RECEIPT = 'inventory_item_usage_baseline';

/** Prior count-to-count intervals needed before an item has a "normal rate". */
const MIN_BASELINE_INTERVALS = 10;
/** A one-day interval is a snapshot, not a rate. */
const MIN_CURRENT_INTERVAL_DAYS = 2;
/** Higher than the weekly detectors': this series has no weekday control. */
const MIN_Z = 4;
/** And the overage has to be enough units to be worth a manager's morning. */
const MIN_EXTRA_UNITS = 5;

function draftForItem(item: InventoryItemUsage): FindingDraft | null {
  if (item.intervals.length < MIN_BASELINE_INTERVALS + 1) return null;

  const ordered = [...item.intervals].sort((a, b) => (a.endDate < b.endDate ? -1 : 1));
  const latest = ordered[ordered.length - 1];
  if (latest.days < MIN_CURRENT_INTERVAL_DAYS) return null;

  const priorRates = ordered.slice(0, -1).map((i) => i.unitsUsed / i.days);
  const baseline = robustBaseline(priorRates);
  if (baseline.median <= 0) return null;

  const currentRate = latest.unitsUsed / latest.days;
  const deviation = deviationOf(currentRate, baseline);
  if (!deviation.aboveRoutineHigh) return null;
  if (deviation.z < MIN_Z) return null;

  const extraUnits = (currentRate - baseline.median) * latest.days;
  if (extraUnits < MIN_EXTRA_UNITS) return null;

  // The units band comes from the spread of this item's own past rates; the
  // per-unit price is what the hotel actually paid for it. Width therefore
  // comes from real variation, never from a percentage somebody chose.
  const normalBand = { low: baseline.p25, high: baseline.p75 };
  const rateExcess = excessBand(currentRate, normalBand);
  const unitsBand = rateExcess
    ? { low: rateExcess.low * latest.days, high: rateExcess.high * latest.days }
    : null;

  const costs = [...item.unitCostCentsSamples].sort((a, b) => a - b);
  const unitCostCents = costs.length > 0 ? percentile(costs, 0.5) : null;

  const pricing = priceFromBand(
    unitsBand && unitCostCents !== null
      ? multiplyBands(unitsBand, { low: unitCostCents, high: unitCostCents })
      : null,
    unitCostCents !== null && unitsBand
      ? `${Math.round(unitsBand.low)}-${Math.round(unitsBand.high)} ${item.unit} more than this ` +
        `item's usual rate over ${plural(Math.round(latest.days), 'day')}, at the ` +
        `${formatCents(unitCostCents)} a ${item.unit} you have been paying`
      : '',
    unitCostCents === null
      ? `no dollar figure: this hotel has never recorded what it pays for ${item.itemName}`
      : `no dollar figure: this item's past usage is too uniform to say how much of the ` +
        'latest stretch was the extra',
  );

  return {
    // Identity is the ITEM, never the size of the overage.
    key: `item_usage:${item.itemId}`,
    summary:
      `${item.itemName} is going out at about ${round1(currentRate)} ${item.unit} a day — ` +
      `this item's own usual rate here is about ${round1(baseline.median)}.`,
    severity: 'attention',
    magnitude: Math.round(extraUnits),
    evidence: {
      queryId: RECEIPT,
      params: {
        item_id: item.itemId,
        interval_end: latest.endDate,
        interval_days: Math.round(latest.days * 100) / 100,
      },
      values: {
        item_name: item.itemName,
        unit: item.unit,
        current_rate_per_day: round1(currentRate),
        median_rate_per_day: round1(baseline.median),
        trimmed_mean_rate_per_day: round1(baseline.trimmedMean),
        p25_rate_per_day: round1(baseline.p25),
        p75_rate_per_day: round1(baseline.p75),
        p90_rate_per_day: round1(baseline.p90),
        robust_z: Math.round(deviation.z * 100) / 100,
        baseline_intervals: baseline.n,
        units_used: Math.round(latest.unitsUsed * 100) / 100,
        price_basis: pricing.note,
      },
      basis:
        `stock counted on ${latest.endDate} against the count before it, plus deliveries and ` +
        `discards in between — measured against this item's previous ${baseline.n} counts`,
    },
    price: pricing.price,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function detectInventoryUsageBaseline(ctx: DetectorContext): FindingDraft[] {
  const history: InventoryUsageHistory = readFeed(ctx, 'inventory_usage_history');
  const drafts: FindingDraft[] = [];
  for (const item of history.items) {
    const draft = draftForItem(item);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

// ─── Eval fixtures ───────────────────────────────────────────────────────────

/**
 * Counts of one item, `days` apart, at the given per-day rates. The LAST rate
 * is the one being judged; everything before it is the item's own history.
 */
export function usageFixture(
  itemId: string,
  ratesPerDay: readonly number[],
  opts: { unit?: string; itemName?: string; days?: number; unitCostCentsSamples?: number[] } = {},
): InventoryUsageHistory {
  const days = opts.days ?? 3;
  const firstCount = '2025-10-04';
  const item: InventoryItemUsage = {
    itemId,
    itemName: opts.itemName ?? 'Bath towels',
    unit: opts.unit ?? 'each',
    unitCostCentsSamples: opts.unitCostCentsSamples ?? [450, 480, 520],
    intervals: ratesPerDay.map((rate, index) => ({
      endDate: addDaysInTz(firstCount, index * days),
      days,
      unitsUsed: rate * days,
    })),
  };
  return { items: [item], coverageStartDate: firstCount, windowDays: 98 };
}

const STEADY = [4, 4.3, 3.8, 4.1, 4.4, 3.9, 4.2, 4, 4.5, 3.7, 4.1];

export const inventoryUsageBaselineDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'inventory_usage_baseline',
    description:
      "An inventory item going out far faster than its own usual rate at this hotel, measured between the hotel's own counts.",
    inputs: ['inventory_usage_history'],
    requires: [
      {
        feed: 'inventory_usage_history',
        minRecords: MIN_BASELINE_INTERVALS + 1,
        because:
          'this hotel has not counted the same item enough times to know how fast anything normally goes out',
      },
    ],
    receiptQueryId: RECEIPT,
    defaultDisposition: 'fyi',
    defaultSeverity: 'attention',
    escalation: { factor: 2, minDelta: 5 },
    // A handful of items at most; a night where every item looks strange is a
    // counting problem, not fifty separate findings.
    maxPerRun: 5,
    staleAfterDays: 21,
    evalCases: [
      {
        name: 'a rate that jumps clear of the item own history is one finding, keyed on the item',
        feeds: {
          inventory_usage_history: usageFixture('a1b2c3d4-0000-4000-8000-000000000001', [
            ...STEADY,
            18,
          ]),
        },
        expectKeys: ['item_usage:a1b2c3d4-0000-4000-8000-000000000001'],
      },
      {
        name: 'a slightly busy stretch says nothing',
        feeds: {
          inventory_usage_history: usageFixture('a1b2c3d4-0000-4000-8000-000000000001', [
            ...STEADY,
            5.2,
          ]),
        },
        expectKeys: [],
      },
      {
        name: 'an item counted only a handful of times has no rate to be unusual against',
        feeds: {
          inventory_usage_history: usageFixture('a1b2c3d4-0000-4000-8000-000000000001', [
            4, 4.2, 3.9, 18,
          ]),
        },
        expectKeys: [],
      },
      {
        name: 'an item that swings wildly by nature is not surprised by another swing',
        feeds: {
          inventory_usage_history: usageFixture('a1b2c3d4-0000-4000-8000-000000000001', [
            1, 18, 2, 17, 1.5, 19, 2.5, 16, 1, 18, 2, 18,
          ]),
        },
        expectKeys: [],
      },
      {
        name: 'an item nobody is using is not a finding',
        feeds: {
          inventory_usage_history: usageFixture('a1b2c3d4-0000-4000-8000-000000000001', [
            ...STEADY,
            0,
          ]),
        },
        expectKeys: [],
      },
    ],
  },
  detect: detectInventoryUsageBaseline,
};

registerDetector(inventoryUsageBaselineDetector);
