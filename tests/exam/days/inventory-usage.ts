// ─── Exam days: inventory_usage_baseline ─────────────────────────────────────
//
// Between any two counts of an item the hotel's own books say what happened:
//
//   used = stock at the earlier count + delivered - discarded - stock at the later count
//
// Divide by the days between and you have a rate, in that item's own units, for
// that hotel, from rows a manager typed themselves. When one of those rates
// jumps clear of the ten before it, something changed — a leak, an amenity
// being over-set, a cart that never gets counted back, or theft.
//
// THIS SERIES HAS NO WEEKDAY CONTROL AND CANNOT HAVE ONE.
// Counts happen when somebody counts, so one stretch may be a full Fri-Sun and
// the next a dead midweek. That is exactly why the bar here is higher than its
// weekly siblings' — a bigger z, and ten prior stretches for the item — and why
// day 03 below matters more than day 01: an item that swings by nature must
// never be told its own swing is a leak.

import type { ExamDay, ExamPlanter } from '../types';

/** Deliveries dated before the first count, so they price the item without
 *  landing inside any stretch the usage arithmetic measures. */
async function priceHistory(ctx: ExamPlanter, slot = 0): Promise<void> {
  const unitCosts = [450, 480, 520];
  for (let i = 0; i < unitCosts.length; i += 1) {
    await ctx.supplyDelivery({
      date: ctx.ago(70 - i),
      itemSlot: slot,
      quantity: 1,
      unitCostCents: unitCosts[i],
    });
  }
}

/**
 * Counts of one item `spacing` days apart. `unitsUsed` is oldest stretch first;
 * the LAST entry is the one being judged and everything before it is the item's
 * own history.
 */
async function countSeries(
  ctx: ExamPlanter,
  unitsUsed: readonly number[],
  opts: { slot?: number; spacing?: number } = {},
): Promise<void> {
  const slot = opts.slot ?? 0;
  const spacing = opts.spacing ?? 5;
  const stretches = unitsUsed.length;
  let stock = 2_000;
  await ctx.count({ date: ctx.ago(1 + spacing * stretches), itemSlot: slot, stock });
  for (let i = 0; i < stretches; i += 1) {
    stock -= unitsUsed[i];
    await ctx.count({
      date: ctx.ago(1 + spacing * (stretches - 1 - i)),
      itemSlot: slot,
      stock,
    });
  }
}

/** Eleven stretches of a hotel using about four towels a day. */
const STEADY_UNITS = [20, 22, 19, 21, 23, 20, 18, 22, 21, 20, 24];

export const inventoryUsageDays: ExamDay[] = [
  {
    id: 'inv-01',
    title: 'towels going out four and a half times faster than usual',
    kind: 'clean_positive',
    detector: 'inventory_usage_baseline',
    why:
      "Eleven stretches around four a day, then eighteen. The hotel's own counts say so; the " +
      'card shows the arithmetic and does not guess at the cause.',
    async seed(ctx) {
      await ctx.item({ name: 'Bath towels', unit: 'each' });
      await priceHistory(ctx);
      await countSeries(ctx, [...STEADY_UNITS, 90]);
    },
    expect: [
      {
        detectorId: 'inventory_usage_baseline',
        key: 'item_usage:{item0}',
        why: '13.8 units a day over the usual rate, across a five-day stretch, is 69 extra towels.',
        magnitude: [68, 70],
        // No reorder point and no lead time on file, so there is nothing Staxis
        // may correct — the card is still true, it just has no button.
        disposition: 'fyi',
        action: 'none',
        target: { kind: 'inventory_item', value: '{item0}' },
        price: {
          lowCents: [32_600, 32_700],
          highCents: [33_500, 33_700],
          basisMatches: /more than this item's usual rate over 5 days, at the \$5 a each you have been paying/,
        },
        summaryMatches: /Bath towels is going out at about 18 each a day/,
      },
    ],
    silent: [],
    skipped: [
      {
        detectorId: 'supply_spend_baseline',
        becauseMatches: /fewer than 12 days/,
        why: 'Three priced deliveries is not a spending history — skipped with a reason, not silent.',
      },
    ],
  },

  {
    id: 'inv-02',
    title: 'the same leak, on an item whose reorder point Staxis can fix',
    kind: 'clean_positive',
    detector: 'inventory_usage_baseline',
    why:
      'This hotel typed in a reorder point of 40 and a four-day lead time. At eighteen a day ' +
      'they will be out before the van arrives, so the card arrives with the fix attached — ' +
      'and becomes a decision waiting rather than a note.',
    async seed(ctx) {
      await ctx.item({ name: 'Bath towels', unit: 'each', reorderAt: 40, reorderLeadDays: 4 });
      await priceHistory(ctx);
      await countSeries(ctx, [...STEADY_UNITS, 90]);
    },
    expect: [
      {
        detectorId: 'inventory_usage_baseline',
        key: 'item_usage:{item0}',
        why: 'Same arithmetic as exam day 01; the only difference is that a fix exists.',
        magnitude: [68, 70],
        disposition: 'propose',
        action: { kind: 'raise_inventory_reorder_point' },
        target: { kind: 'inventory_item', value: '{item0}' },
      },
    ],
    silent: [],
  },

  {
    id: 'inv-03',
    title: 'an item that swings by nature is not surprised by another swing',
    kind: 'hard_negative',
    detector: 'inventory_usage_baseline',
    why:
      'Some items really do alternate between one and eighteen a day — a linen line counted ' +
      'either side of a group booking. The spread of its own past rates already contains this ' +
      "stretch, and a hotel told its normal is a leak stops counting.",
    async seed(ctx) {
      await ctx.item({ name: 'Bath towels', unit: 'each' });
      await priceHistory(ctx);
      await countSeries(ctx, [5, 90, 10, 85, 7, 95, 12, 80, 5, 90, 10, 90]);
    },
    expect: [],
    silent: [
      {
        detectorId: 'inventory_usage_baseline',
        why: 'Eighteen a day is not above the high end of what this item routinely does.',
      },
    ],
  },

  {
    id: 'inv-04',
    title: 'an item counted four times has no rate to be unusual against',
    kind: 'hard_negative',
    detector: 'inventory_usage_baseline',
    why:
      'The hotel has a long history on towels and has counted shampoo four times. The feed ' +
      'passes its floor on the strength of the towels, so the detector RUNS — and must still ' +
      'refuse to have an opinion about the shampoo.',
    async seed(ctx) {
      await ctx.item({ slot: 0, name: 'Bath towels', unit: 'each' });
      await ctx.item({ slot: 1, name: 'Shampoo', unit: 'bottles' });
      await priceHistory(ctx, 0);
      await countSeries(ctx, [...STEADY_UNITS, 20]);
      await countSeries(ctx, [4, 5, 120], { slot: 1, spacing: 6 });
    },
    expect: [],
    silent: [
      {
        detectorId: 'inventory_usage_baseline',
        why: 'Three stretches is not a rate, however dramatic the third one looks.',
      },
    ],
  },

  {
    id: 'inv-05',
    title: 'a hair over four robust deviations',
    kind: 'edge_positive',
    detector: 'inventory_usage_baseline',
    why:
      'A flat four a day and then 6.6 — 4.33 deviations out, just past a bar deliberately set ' +
      'higher than the weekly detectors’ because this series has no weekday control.',
    async seed(ctx) {
      await ctx.item({ name: 'Bath towels', unit: 'each' });
      await priceHistory(ctx);
      await countSeries(ctx, [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 33]);
    },
    expect: [
      {
        detectorId: 'inventory_usage_baseline',
        key: 'item_usage:{item0}',
        why: '2.6 units a day over the usual rate across five days is 13 extra towels.',
        magnitude: [13, 13],
        price: 'none',
        priceBasisMatches: /no dollar figure: this item's past usage is too uniform/,
      },
    ],
    silent: [],
  },

  {
    id: 'inv-06',
    title: 'a hair under four robust deviations stays quiet',
    kind: 'edge_negative',
    detector: 'inventory_usage_baseline',
    why:
      'The same hotel, two towels fewer: 3.67 deviations. A detector that speaks here has had ' +
      'its bar lowered to the weekly detectors’, which this series cannot support.',
    async seed(ctx) {
      await ctx.item({ name: 'Bath towels', unit: 'each' });
      await priceHistory(ctx);
      await countSeries(ctx, [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 31]);
    },
    expect: [],
    silent: [
      { detectorId: 'inventory_usage_baseline', why: 'Inside the bar this series needs.' },
    ],
  },
];
