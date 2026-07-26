// ─── Exam days: work_order_rate_baseline ─────────────────────────────────────
//
// How many work orders a hotel opens in a week is one of the few honest early
// signals it has. A jump means something started breaking — a chiller, a floor
// of doors — days before anybody connects the individual tickets.
//
// TWO THINGS THESE DAYS EXIST TO STOP
//  • the monthly-batcher (02). Plenty of hotels do their maintenance logging in
//    one sitting. Telling them their own filing habit is a building emergency
//    is the fastest way to make the check ignorable.
//  • money out of nowhere (04). The only honest price is what THIS hotel has
//    actually paid to fix things. A hotel that never fills in a repair cost
//    gets a card with no number and a sentence saying exactly why.
//
// Locations are spread deliberately wide on every day here: this detector is
// about the hotel's RATE, and a corpus that accidentally piled three tickets on
// one room would be grading `repeat_room_work_orders` while claiming to grade
// this one.

import type { ExamDay, ExamPlanter } from '../types';

/**
 * `countForWeek(0)` is the current week, 1..12 the weeks before it. Every
 * ticket lands on its own location until the rooms run out, so no PLACE ever
 * reaches the three-in-thirty-days that the repeat-location detector watches.
 */
async function weeklyWorkOrders(
  ctx: ExamPlanter,
  weeks: number,
  countForWeek: (weekIndex: number) => number,
  repairCostCents: number[] = [],
): Promise<void> {
  let placed = 0;
  for (let week = weeks; week >= 0; week -= 1) {
    const windowStart = 1 + 7 * week + 6;
    const count = countForWeek(week);
    for (let i = 0; i < count; i += 1) {
      await ctx.workOrder({
        date: ctx.ago(windowStart - (i % 7)),
        location: `Room ${100 + (placed % 40)}`,
        repairCostCents: repairCostCents[placed] ?? null,
      });
      placed += 1;
    }
  }
}

export const workOrderRateDays: ExamDay[] = [
  {
    id: 'wo-rate-01',
    title: 'fourteen tickets in a week at a hotel that opens three',
    kind: 'clean_positive',
    detector: 'work_order_rate_baseline',
    why:
      'Twelve weeks around three tickets, then fourteen. Something started breaking, and this ' +
      'is the only check in the app that sees it before somebody connects the tickets by hand.',
    async seed(ctx) {
      // The four recorded repair costs land on the OLDEST tickets, so the price
      // is built from what this hotel has historically paid rather than from
      // this week's outlier.
      await weeklyWorkOrders(
        ctx,
        12,
        (week) => (week === 0 ? 14 : 2 + (week % 3)),
        [3_250, 8_500, 12_000, 4_400],
      );
    },
    expect: [
      {
        detectorId: 'work_order_rate_baseline',
        key: 'weekly_work_order_rate',
        why: 'Fourteen against a median of three is eleven extra tickets.',
        magnitude: [11, 11],
        disposition: 'recommend',
        severity: 'attention',
        price: {
          // 10-12 extra tickets at the $32.50-$120 this hotel has actually paid.
          lowCents: [30_000, 30_000],
          highCents: [145_000, 145_000],
          basisMatches: /more work orders than your usual 2-4 a week, at the \$33–\$120 you have actually paid/,
        },
        summaryMatches: /14 work orders opened in the week ending/,
      },
    ],
    silent: [
      {
        detectorId: 'repeat_room_work_orders',
        why: 'Fifty tickets, none of them three-deep on one location. A rate problem is not a place problem.',
      },
      {
        detectorId: 'expected_activity_stopped',
        why: 'Maintenance is being logged every day — the stream this hotel has is healthy.',
      },
    ],
  },

  {
    id: 'wo-rate-02',
    title: 'the hotel that logs maintenance in monthly batches',
    kind: 'hard_negative',
    detector: 'work_order_rate_baseline',
    why:
      'Fourteen tickets every fourth week and two in between is a FILING habit, not a building ' +
      'falling apart. The hotel has proven weeks like this happen here.',
    async seed(ctx) {
      await weeklyWorkOrders(ctx, 12, (week) => (week % 4 === 0 ? 14 : 2));
    },
    expect: [],
    silent: [
      {
        detectorId: 'work_order_rate_baseline',
        why: 'This week is no bigger than the top of their own recent weeks.',
      },
      { detectorId: 'repeat_room_work_orders', why: 'No location repeats three times in thirty days.' },
    ],
  },

  {
    id: 'wo-rate-03',
    title: 'a hotel with no rate at all',
    kind: 'hard_negative',
    detector: 'work_order_rate_baseline',
    why:
      'Six of the last twelve weeks had no maintenance logged at all. "A normal week" is not a ' +
      'thing that exists here, so every busy week would clear any threshold you like, forever.',
    async seed(ctx) {
      await weeklyWorkOrders(ctx, 12, (week) => (week === 0 ? 14 : week % 2 === 1 ? 5 : 0));
    },
    expect: [],
    silent: [
      {
        detectorId: 'work_order_rate_baseline',
        why: 'Too sporadic for "normal" to mean anything — the detector must refuse, not guess.',
      },
      { detectorId: 'repeat_room_work_orders', why: 'No location repeats three times in thirty days.' },
    ],
  },

  {
    id: 'wo-rate-04',
    title: 'exactly three extra tickets, and no dollar figure to go with them',
    kind: 'edge_positive',
    detector: 'work_order_rate_baseline',
    why:
      'Seven against a flat four is the smallest jump this detector will speak about — two ' +
      'extra tickets is noise. And this hotel has never recorded a repair cost, so the card ' +
      'says so instead of borrowing an average from somewhere else.',
    async seed(ctx) {
      await weeklyWorkOrders(ctx, 12, (week) => (week === 0 ? 7 : 4));
    },
    expect: [
      {
        detectorId: 'work_order_rate_baseline',
        key: 'weekly_work_order_rate',
        why: 'Seven against a median of four is three extra tickets — exactly the bar.',
        magnitude: [3, 3],
        price: 'none',
        priceBasisMatches: /no dollar figure: this hotel has recorded a repair cost on only 0 work orders/,
      },
    ],
    silent: [
      { detectorId: 'repeat_room_work_orders', why: 'No location repeats three times in thirty days.' },
    ],
  },

  {
    id: 'wo-rate-05',
    title: 'two extra tickets is a bad week, not a signal',
    kind: 'edge_negative',
    detector: 'work_order_rate_baseline',
    why:
      'The same hotel, one ticket fewer. Six against four clears the statistical bar and fails ' +
      'the "is this worth a manager\'s morning" bar, which is the one that matters.',
    async seed(ctx) {
      await weeklyWorkOrders(ctx, 12, (week) => (week === 0 ? 6 : 4));
    },
    expect: [],
    silent: [
      { detectorId: 'work_order_rate_baseline', why: 'Two extra tickets is under the floor.' },
      { detectorId: 'repeat_room_work_orders', why: 'No location repeats three times in thirty days.' },
    ],
  },
];
