// ─── Exam days: supply_spend_baseline ────────────────────────────────────────
//
// "This week's restocking bill is far outside what this hotel normally spends."
// Nobody could have written that rule in advance — the number depends on the
// building, the vendors and the habits — so the hotel's own twelve weeks draw
// the line, and the only thing anybody chose was to watch it.
//
// WHAT THESE DAYS PIN, IN ORDER OF HOW MUCH THEY COST IF THEY BREAK
//  1. the bulk-order hotel (exam day 02). A hotel that orders big every fourth
//     week and gets told its own habit is an emergency stops reading Staxis in
//     a fortnight. This is the single most expensive false positive in the
//     product, and it is the reason `aboveRoutineHigh` exists.
//  2. the new hotel (03). Fourteen days of deliveries is not a normal, and a
//     hotel whose FIRST bulk order is an alert never gets a second chance.
//  3. the money (01, 04). The range is the spread of the hotel's own normal
//     weeks, or there is no range — and a hotel whose weeks are identical gets
//     an explicit "no dollar figure" with the reason, never a fake spread.
//  4. the ledger (07, 08). A bigger overspend tomorrow is the SAME problem.
//
// WHAT THIS CORPUS CANNOT PROVE, STATED RATHER THAN GLOSSED
// `deviationOf().aboveRoutineHigh` — the guard the detector calls "the plainest
// of the three" — is mathematically DEAD at the thresholds shipped today, and
// no exam day can catch its removal. The proof is short: the spread is at least
// (p90-p10)/2.563, so when `current <= p90` the z-score is at most
// 2.563 x (p90-median)/(p90-p10), and median >= p10 makes that at most 2.563 —
// under every MIN_Z in the layer (3.5, 3.5, 4). The bulk-order hotel on day 02
// is therefore stopped by the interdecile term, not by the guard that reads as
// if it were doing the work. Keeping the guard is right (it is the readable
// statement of intent, and it binds again the moment anybody lowers MIN_Z);
// believing this corpus tests it would not be.

import { setFindingStatus } from '@/lib/findings/store';

import type { ExamDay, ExamPlanter } from '../types';

/** One delivery at the start of each of `weeks + 1` weekly windows. */
async function weeklyDeliveries(
  ctx: ExamPlanter,
  weeks: number,
  centsForWeek: (weekIndex: number) => number,
): Promise<void> {
  for (let week = 0; week <= weeks; week += 1) {
    const cents = centsForWeek(week);
    if (cents === 0) continue;
    // The first day of the 7-day window that ends `1 + 7*week` days ago.
    await ctx.supplyDelivery({ date: ctx.ago(1 + 7 * week + 6), cents });
  }
}

/** A steady hotel: twelve comparable weeks around $950, then whatever. */
const STEADY_WEEK = (week: number) => 90_000 + (week % 3) * 5_000;

export const supplySpendDays: ExamDay[] = [
  {
    id: 'supply-01',
    title: 'a $2,300 week against twelve $900-1,000 weeks',
    kind: 'clean_positive',
    detector: 'supply_spend_baseline',
    why:
      'Twelve steady weeks then a bill more than twice the biggest of them. If this does not ' +
      'fire, the detector has stopped detecting anything at all.',
    async seed(ctx) {
      await weeklyDeliveries(ctx, 12, (week) => (week === 0 ? 230_000 : STEADY_WEEK(week)));
    },
    expect: [
      {
        detectorId: 'supply_spend_baseline',
        key: 'weekly_supply_spend',
        why: '$2,300 against a $950 median week is a $1,350 overspend, in cents.',
        magnitude: [135_000, 135_000],
        disposition: 'recommend',
        severity: 'attention',
        target: null,
        price: {
          // Their own normal week ran $900-$1,000, so "how much extra" is only
          // knowable to within that width: $1,300-$1,400, never "$1,350".
          lowCents: [130_000, 130_000],
          highCents: [140_000, 140_000],
          basisMatches: /your last 12 comparable weeks ran \$900–\$1,000/,
        },
        summaryMatches: /Supply spending ran \$2,300 in the week ending/,
        action: 'none',
      },
    ],
    silent: [],
    skipped: [
      {
        detectorId: 'work_order_rate_baseline',
        becauseMatches: /fewer than 24 work orders/,
        why: 'A hotel with no maintenance history must be SKIPPED with a reason, not reported as quiet.',
      },
    ],
  },

  {
    id: 'supply-02',
    title: 'the bulk-order hotel is not surprised by its own bulk order',
    kind: 'hard_negative',
    detector: 'supply_spend_baseline',
    why:
      'This hotel places one big order every fourth week and coasts in between. The arithmetic ' +
      'scores this week as wildly unusual; the hotel has DEMONSTRATED that weeks like this ' +
      'happen here, so there is nothing to report.',
    async seed(ctx) {
      await weeklyDeliveries(ctx, 12, (week) => (week % 4 === 0 ? 230_000 : 30_000));
    },
    expect: [],
    silent: [
      {
        detectorId: 'supply_spend_baseline',
        why: 'This week is no bigger than the top of their own recent weeks.',
      },
    ],
  },

  {
    id: 'supply-03',
    title: 'a ten-week-old hotel, three thousand dollars into a Tuesday',
    kind: 'hard_negative',
    detector: 'supply_spend_baseline',
    why:
      'Ten weeks of steady ordering is plenty of rows, plenty of non-empty weeks, and still not ' +
      'a twelve-week normal. This day is deliberately shaped so the ONLY thing keeping it quiet ' +
      'is the coverage floor: remove that one check and a $3,000 week scores 5.3 deviations out ' +
      'and this hotel gets an emergency card in its third month.',
    async seed(ctx) {
      // Two deliveries a week, so the feed's own row floor is comfortably met
      // and nothing but the history length is doing the work.
      for (let week = 0; week <= 9; week += 1) {
        const cents = week === 0 ? 300_000 : STEADY_WEEK(week);
        await ctx.supplyDelivery({ date: ctx.ago(1 + 7 * week + 6), cents: Math.round(cents / 2) });
        await ctx.supplyDelivery({ date: ctx.ago(1 + 7 * week + 4), cents: Math.round(cents / 2) });
      }
    },
    expect: [],
    silent: [
      {
        detectorId: 'supply_spend_baseline',
        why: 'Coverage starts ten weeks ago; the twelve-week baseline cannot honestly be built.',
      },
    ],
  },

  {
    id: 'supply-09',
    title: 'a hotel that orders once a month',
    kind: 'hard_negative',
    detector: 'supply_spend_baseline',
    why:
      'Three of the last twelve weeks had any deliveries at all. "A normal week" is not a thing ' +
      'that exists here, and every ordering week would clear any threshold you like, forever. ' +
      'This is the single biggest false-positive source in the whole design, and this day is ' +
      'the only one where that specific gate is what stops it.',
    async seed(ctx) {
      for (const week of [0, 4, 8, 12]) {
        const cents = week === 0 ? 230_000 : 90_000;
        for (const offset of [6, 5, 4, 3]) {
          await ctx.supplyDelivery({
            date: ctx.ago(1 + 7 * week + offset),
            cents: Math.round(cents / 4),
          });
        }
      }
    },
    expect: [],
    silent: [
      {
        detectorId: 'supply_spend_baseline',
        why: 'Too sporadic for a normal week to mean anything — the detector must refuse, not guess.',
      },
    ],
  },

  {
    id: 'supply-04',
    title: 'barely over the line, and honest about having no range',
    kind: 'edge_positive',
    detector: 'supply_spend_baseline',
    why:
      "Twelve identical $900 weeks then $1,373 — 3.50 robust deviations out, a hair past the " +
      'bar. It fires, and because every one of their weeks cost the same there is no honest ' +
      'spread to quote, so the card carries NO dollar figure and says why.',
    async seed(ctx) {
      await weeklyDeliveries(ctx, 12, (week) => (week === 0 ? 137_300 : 90_000));
    },
    expect: [
      {
        detectorId: 'supply_spend_baseline',
        key: 'weekly_supply_spend',
        why: '$1,373 against a $900 median is a $473 overspend.',
        magnitude: [47_300, 47_300],
        price: 'none',
        priceBasisMatches: /no dollar figure: your last 12 weeks cost almost exactly the same/,
      },
    ],
    silent: [],
  },

  {
    id: 'supply-05',
    title: 'barely under the line stays quiet',
    kind: 'edge_negative',
    detector: 'supply_spend_baseline',
    why:
      "The same hotel, one dollar cheaper: 3.496 deviations out instead of 3.504. A detector " +
      'that fires here has had its threshold moved.',
    async seed(ctx) {
      await weeklyDeliveries(ctx, 12, (week) => (week === 0 ? 137_200 : 90_000));
    },
    expect: [],
    silent: [
      { detectorId: 'supply_spend_baseline', why: 'Just inside the bar — nothing to say.' },
    ],
  },

  {
    id: 'supply-06',
    title: 'a genuinely busy hotel having a slightly expensive week',
    kind: 'clean_negative',
    detector: 'supply_spend_baseline',
    why:
      'Real hotels do not spend the same amount twice. This one swings between $800 and $1,400 ' +
      'and had a $1,200 week. That is a Tuesday, not a finding.',
    async seed(ctx) {
      const swings = [140_000, 82_000, 96_000, 131_000, 88_000, 104_000, 127_000, 91_000, 113_000, 85_000, 136_000, 99_000];
      await weeklyDeliveries(ctx, 12, (week) => (week === 0 ? 120_000 : swings[week - 1]));
    },
    expect: [],
    silent: [
      {
        detectorId: 'supply_spend_baseline',
        why: '$1,200 sits inside the band this hotel routinely spends in.',
      },
    ],
  },

  {
    id: 'supply-07',
    title: 'a bigger overspend tomorrow is the SAME problem',
    kind: 'silencer',
    detector: 'supply_spend_baseline',
    why:
      'The whole ledger exists so that a worsening number updates one card instead of stacking ' +
      'a second beside it. A dedupe key that carried the measurement would pass every other ' +
      'day in this corpus and fail here.',
    async seed(ctx) {
      await weeklyDeliveries(ctx, 12, (week) => (week === 0 ? 230_000 : STEADY_WEEK(week)));
    },
    expect: [
      {
        detectorId: 'supply_spend_baseline',
        key: 'weekly_supply_spend',
        why: 'Night one: the $1,350 overspend.',
        magnitude: [135_000, 135_000],
      },
    ],
    silent: [],
    secondNight: {
      why: 'Another $1,000 lands in the same week. One row, a bigger number on it.',
      async mutate(ctx) {
        await ctx.supplyDelivery({ date: ctx.ago(4), cents: 100_000 });
      },
      expect: [
        {
          detectorId: 'supply_spend_baseline',
          key: 'weekly_supply_spend',
          why: '$3,300 against the same $950 median.',
          magnitude: [235_000, 235_000],
        },
      ],
      maxTotalRows: 1,
    },
  },

  {
    id: 'supply-08',
    title: 'consent to $1,350 is not consent to $2,350',
    kind: 'silencer',
    detector: 'supply_spend_baseline',
    why:
      'A manager who tapped "known problem" on a $1,350 overspend agreed to $1,350. When the ' +
      'same problem doubles it has to come back — both the factor and the absolute delta have ' +
      'to hold, so a $1,350 creeping to $1,400 still stays quiet.',
    async seed(ctx) {
      await weeklyDeliveries(ctx, 12, (week) => (week === 0 ? 230_000 : STEADY_WEEK(week)));
    },
    expect: [
      {
        detectorId: 'supply_spend_baseline',
        key: 'weekly_supply_spend',
        why: 'Night one: the card the manager silences.',
        magnitude: [135_000, 135_000],
      },
    ],
    silent: [],
    secondNight: {
      why: 'Silenced at $1,350, then the week doubles. Back on the screen.',
      async handOfTheManager(ctx) {
        const rows = await ctx.pg.query<{ id: string }>(
          `select id from findings where property_id = $1 and detector_id = 'supply_spend_baseline'`,
          [ctx.propertyId],
        );
        await setFindingStatus(ctx.propertyId, rows.rows[0].id, 'known_problem', null, ctx.now);
      },
      async mutate(ctx) {
        await ctx.supplyDelivery({ date: ctx.ago(4), cents: 150_000 });
      },
      expect: [
        {
          detectorId: 'supply_spend_baseline',
          key: 'weekly_supply_spend',
          why: '$2,850 is more than twice the $1,350 they consented to, and $1,500 more in absolute terms.',
          magnitude: [285_000, 285_000],
        },
      ],
      maxTotalRows: 1,
    },
  },
];
