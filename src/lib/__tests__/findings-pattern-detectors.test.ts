/**
 * Phase 2A: the detectors that need nobody to have predicted the problem.
 *
 * WHAT THESE PROVE
 * Three baseline detectors ("unusual for THIS hotel") and one absence detector
 * ("an expected thing stopped") are pure functions of a preloaded feed, so
 * every claim they make is provable here with no database and no clock. The
 * tests are written against BEHAVIOUR — plant a pattern, assert the verdict —
 * never against the source text, and every assertion below was checked by
 * mutating the implementation and confirming it goes red (mutation list in the
 * branch's task summary).
 *
 * THE ONE THAT MATTERS MOST
 * `a hotel is never surprised by its own habit` is the false-positive guard.
 * The same $2,300 week produces a finding at a hotel that has never had one and
 * SILENCE at a hotel that bulk-orders every fourth week. If that pair ever
 * disagrees, the watcher has started lying to the only customer it has.
 *
 * The tenant wall, the real column names and the real query builder are proven
 * against a real Postgres in findings-pattern-feeds.integration.test.ts — a
 * fake cannot prove that `inventory_orders.received_at` exists, and a column
 * that does not exist is this codebase's most expensive recurring bug.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { addDaysInTz } from '@/lib/schedule/local-date';
import {
  excessBand,
  formatCents,
  multiplyBands,
  percentile,
  sampleBand,
  toPriceRange,
} from '@/lib/findings/pricing';
import {
  buildBaseline,
  cadenceOf,
  daysBetween,
  deviationOf,
  robustBaseline,
  weeklyWindows,
} from '@/lib/findings/detectors/baseline-math';
import {
  detectSupplySpendBaseline,
  spendFixture,
  supplySpendBaselineDetector,
} from '@/lib/findings/detectors/supply-spend-baseline';
import {
  detectWorkOrderRateBaseline,
  workOrderFixture,
  workOrderRateBaselineDetector,
} from '@/lib/findings/detectors/work-order-rate-baseline';
import {
  detectInventoryUsageBaseline,
  inventoryUsageBaselineDetector,
  usageFixture,
} from '@/lib/findings/detectors/inventory-usage-baseline';
import {
  detectExpectedActivityStopped,
  expectedActivityDetector,
  rhythmFixture,
} from '@/lib/findings/detectors/expected-activity';
import { runDetectorEvalCases } from '@/lib/findings/evals';
import { isUsablePriceRange } from '@/lib/findings/types';
import type {
  DetectorContext,
  FeedId,
  FeedOutcome,
  FeedShapes,
  FindingDraft,
} from '@/lib/findings/types';

// ─── harness ────────────────────────────────────────────────────────────────

const TODAY = '2026-01-01';
const PID = '00000000-0000-4000-8000-00000000000a';

function ctxWith(feeds: Partial<Record<FeedId, FeedShapes[FeedId]>>, businessDate = TODAY): DetectorContext {
  const loaded: Partial<Record<FeedId, FeedOutcome>> = {};
  for (const [feed, value] of Object.entries(feeds) as Array<[FeedId, FeedShapes[FeedId]]>) {
    loaded[feed] = {
      value,
      recordCount: 999,
      asOf: new Date('2026-01-01T09:00:00Z'),
      weakestInputAgeDays: 0,
    } as FeedOutcome;
  }
  return {
    propertyId: PID,
    now: new Date('2026-01-01T09:00:00Z'),
    timezone: 'America/Chicago',
    businessDate,
    feeds: loaded,
  };
}

/** Twelve steady weeks around $900, then whatever this week was. */
function steadySpend(currentCents: number) {
  return spendFixture(TODAY, 12, (week) => (week === 0 ? currentCents : 90_000 + (week % 3) * 5_000));
}

function only(drafts: FindingDraft[]): FindingDraft {
  assert.equal(drafts.length, 1, `expected exactly one finding, got ${drafts.length}`);
  return drafts[0];
}

// ─── the price helper ───────────────────────────────────────────────────────

describe('a price range is the spread of the hotel own numbers, or it is nothing', () => {
  test('three invoices give the range they actually span', () => {
    assert.deepEqual(sampleBand([21_000, 26_000, 39_000]), { low: 21_000, high: 39_000 });
  });

  test('three IDENTICAL invoices give no range — they do not tell you the spread', () => {
    assert.equal(
      sampleBand([25_000, 25_000, 25_000]),
      null,
      'widening an identical sample by an invented percentage is exactly the lie the range format exists to prevent',
    );
  });

  test('one invoice is not a basis', () => {
    assert.equal(sampleBand([25_000]), null);
  });

  test('once there are enough invoices the middle half is quoted, not the extremes', () => {
    const many = [5_000, 20_000, 22_000, 25_000, 28_000, 30_000, 200_000];
    const band = sampleBand(many)!;
    assert.ok(band.low > 5_000 && band.high < 200_000, 'the emergency call-out should stop setting the top');
    assert.ok(band.high > band.low);
  });

  test('"how much more than usual" is only knowable to within how much usual moves', () => {
    // Normal runs 820-1140; this week was 2300.
    const band = excessBand(230_000, { low: 82_000, high: 114_000 })!;
    assert.deepEqual(band, { low: 116_000, high: 148_000 });
    assert.equal(
      band.high - band.low,
      114_000 - 82_000,
      "the overspend range is exactly as wide as the hotel's own normal band — not a percentage anyone chose",
    );
  });

  test('a week inside the normal band has no honest overspend figure', () => {
    assert.equal(
      excessBand(100_000, { low: 82_000, high: 114_000 }),
      null,
      '"somewhere between saving money and losing $180" is not worth a manager waking up to',
    );
  });

  test('two bands compound', () => {
    assert.deepEqual(multiplyBands({ low: 10, high: 12 }, { low: 3_250, high: 12_000 }), {
      low: 32_500,
      high: 144_000,
    });
  });

  test('rounding only ever widens — the stored range contains the computed one', () => {
    const price = toPriceRange({ low: 116_342, high: 147_988 }, 'basis')!;
    assert.ok(price.lowCents <= 116_342, 'the low end must not creep up');
    assert.ok(price.highCents >= 147_988, 'the high end must not creep down');
    assert.equal(price.lowCents % 5_000, 0, 'a range this size is quoted to the nearest $50');
  });

  test('a point estimate cannot be smuggled through as a range', () => {
    assert.equal(toPriceRange({ low: 34_000, high: 34_000 }, 'basis'), null);
  });

  test('rounding never manufactures width the numbers do not support', () => {
    const tight = toPriceRange({ low: 34_001, high: 34_002 }, 'basis')!;
    assert.deepEqual(
      { low: tight.lowCents, high: tight.highCents },
      { low: 34_001, high: 34_002 },
      'rounding a 1-cent band out to $10 would be manufactured spread wearing the range format',
    );
  });

  test('a negative low is refused — the schema would refuse it too', () => {
    assert.equal(toPriceRange({ low: -100, high: 40_000 }, 'basis'), null);
  });

  test('the basis is capped to what the column will hold', () => {
    const price = toPriceRange({ low: 10_000, high: 40_000 }, 'x'.repeat(500))!;
    assert.ok(price.basis.length <= 300);
  });

  test('money reads as whole dollars', () => {
    assert.equal(formatCents(230_049), '$2,300');
  });

  test('percentile interpolates rather than snapping to a sample', () => {
    assert.equal(percentile([0, 10], 0.5), 5);
  });
});

// ─── the baseline math ──────────────────────────────────────────────────────

describe('every week is compared with a week shaped like it', () => {
  const split = weeklyWindows([], TODAY, 12);

  test('the current window ends YESTERDAY, never today', () => {
    assert.equal(
      split.current.endDate,
      '2025-12-31',
      "a 3am run comparing two hours of today against seven full days would call every hotel quiet every morning",
    );
    assert.equal(split.current.startDate, '2025-12-25');
  });

  test('every window carries exactly one of each weekday', () => {
    for (const window of [split.current, ...split.baseline]) {
      const weekdays = new Set<number>();
      for (let i = 0; i < 7; i += 1) {
        weekdays.add(new Date(`${addDaysInTz(window.startDate, i)}T00:00:00Z`).getUTCDay());
      }
      assert.equal(
        weekdays.size,
        7,
        `window ${window.startDate}..${window.endDate} does not have a full weekday mix, so a ` +
          'hotel that takes deliveries on Thursdays would be compared against a window with two of them',
      );
    }
  });

  test('the windows are contiguous and never overlap', () => {
    let previousStart = split.current.startDate;
    for (const window of split.baseline) {
      assert.equal(addDaysInTz(window.endDate, 1), previousStart);
      previousStart = window.startDate;
    }
    assert.equal(split.baseline.length, 12);
  });

  test('a day counts towards exactly one window', () => {
    const points = [{ date: '2025-12-28', value: 500 }];
    const built = weeklyWindows(points, TODAY, 12);
    assert.equal(built.current.value, 500);
    assert.equal(built.baseline.reduce((a, w) => a + w.value, 0), 0);
  });
});

describe('the baseline is robust to the hotel own strangeness', () => {
  test('one freak week does not become the new normal', () => {
    const steady = robustBaseline([90, 92, 88, 91, 89, 90, 93, 87, 90, 91]);
    const withFreak = robustBaseline([90, 92, 88, 91, 89, 90, 93, 87, 90, 5_000]);
    assert.ok(
      Math.abs(withFreak.median - steady.median) < 2,
      'a mean would have moved by 490 and taught the detector to ignore the next real spike',
    );
  });

  test('a hotel that bulk-orders monthly is not called anomalous by its own habit', () => {
    // Nine quiet weeks and three bulk ones: the MAD alone is BLIND to this.
    const bimodal = robustBaseline([300, 300, 300, 300, 300, 300, 300, 300, 300, 2000, 2000, 2000]);
    assert.equal(bimodal.mad, 0, 'this is exactly the shape that drives the MAD to zero');
    const deviation = deviationOf(2000, bimodal);
    assert.ok(
      deviation.z < 3.5,
      `the interdecile range must catch what the MAD misses; z was ${deviation.z}`,
    );
    assert.equal(deviation.aboveRoutineHigh, false, 'the hotel has had weeks exactly like this');
  });

  test('a week bigger than anything recent is flagged as outside the routine high', () => {
    const baseline = robustBaseline([300, 310, 290, 305, 295, 300, 315, 285, 300, 305, 295, 300]);
    assert.equal(deviationOf(2_000, baseline).aboveRoutineHigh, true);
    assert.ok(deviationOf(2_000, baseline).z > 3.5);
  });

  test('a hotel whose weeks are nearly identical is not entitled to a card for a 5% move', () => {
    // Spread of about a dollar on a thousand-dollar week. Without the
    // 15%-of-median floor the scaled MAD is 1.48 and a $50 move scores z = 34.
    const tight = robustBaseline([999, 1_000, 1_001, 999, 1_000, 1_001, 999, 1_000, 1_001, 999, 1_000, 1_001]);
    const deviation = deviationOf(1_050, tight);
    assert.equal(deviation.aboveRoutineHigh, true, 'it really is above anything they have done');
    assert.ok(
      deviation.z < 3.5,
      `a claim to know a hotel's normal to better than 15% is a claim nobody can support; z was ${deviation.z}`,
    );
  });

  test('a hotel with literally no spread does not divide by zero', () => {
    const identical = robustBaseline(Array.from({ length: 12 }, () => 1_000));
    assert.equal(Number.isFinite(deviationOf(1_050, identical).z), true);
    assert.ok(deviationOf(1_050, identical).z < 3.5);
  });

  test('a hotel with no history is refused a baseline and told why', () => {
    const refusal = buildBaseline(
      [{ date: '2025-12-28', value: 100 }],
      TODAY,
      '2025-12-20',
      { baselineWeeks: 12, minNonZeroWindows: 8, subject: 'supply deliveries' },
    );
    assert.equal(refusal.ok, false);
    assert.match(refusal.ok ? '' : refusal.because, /only go back to 2025-12-20/);
  });

  test('a hotel that orders too sporadically is refused a baseline and told why', () => {
    const monthly = spendFixture(TODAY, 12, (week) => (week % 4 === 0 ? 200_000 : 0));
    const refusal = buildBaseline(monthly.days, TODAY, monthly.coverageStartDate, {
      baselineWeeks: 12,
      minNonZeroWindows: 8,
      subject: 'supply deliveries',
    });
    assert.equal(refusal.ok, false);
    assert.match(refusal.ok ? '' : refusal.because, /too sporadic/);
  });
});

describe('a rhythm is learned, never configured', () => {
  const everyThreeDays = Array.from({ length: 12 }, (_, i) => addDaysInTz(TODAY, -3 * (i + 1)));

  test('twelve counts three days apart give a three-day rhythm', () => {
    const cadence = cadenceOf(everyThreeDays)!;
    assert.equal(cadence.medianGapDays, 3);
    assert.equal(cadence.events, 12);
  });

  test('two counts ever is no rhythm at all', () => {
    assert.equal(
      cadenceOf([addDaysInTz(TODAY, -40), addDaysInTz(TODAY, -80)]),
      null,
      'no rhythm on record means no expectation, which means no finding',
    );
  });

  test('the tolerance is at least twice the usual gap', () => {
    assert.ok(cadenceOf(everyThreeDays)!.toleranceDays >= 6);
  });

  test('a long wait the hotel routinely takes is inside tolerance', () => {
    // Mostly daily, but they routinely go quiet over a long weekend.
    const dates: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 20; i += 1) {
      cursor += i % 5 === 0 ? 9 : 1;
      dates.push(addDaysInTz(TODAY, -cursor));
    }
    const cadence = cadenceOf(dates)!;
    assert.ok(
      cadence.toleranceDays > cadence.p90GapDays,
      'a hotel that regularly goes 9 days must not get a card on day 8',
    );
  });

  test('a very tight rhythm still gets a floor — nobody wants a card at 12 hours', () => {
    const twiceDaily = Array.from({ length: 20 }, (_, i) => addDaysInTz(TODAY, -i));
    assert.ok(cadenceOf(twiceDaily)!.toleranceDays >= 3);
  });

  test('day arithmetic crosses a month and a year boundary', () => {
    assert.equal(daysBetween('2025-12-28', '2026-01-04'), 7);
    assert.equal(daysBetween('2026-02-27', '2026-03-01'), 2);
  });
});

// ─── supply spend ───────────────────────────────────────────────────────────

describe('supply spending unusual for THIS hotel', () => {
  test('a blowout week becomes one finding with the overspend priced from their own weeks', () => {
    const draft = only(
      detectSupplySpendBaseline(ctxWith({ supply_spend_history: steadySpend(230_000) })),
    );
    assert.equal(draft.key, 'weekly_supply_spend');
    assert.equal(draft.magnitude, 135_000, 'magnitude is the overspend in cents');

    assert.ok(isUsablePriceRange(draft.price), 'a hotel with 12 weeks of history can be priced');
    assert.ok(draft.price!.lowCents > 0);
    assert.ok(draft.price!.highCents > draft.price!.lowCents);
    assert.match(
      draft.price!.basis,
      /your last 12 comparable weeks ran/,
      'the basis has to name rows the manager can go and check',
    );
    assert.match(draft.evidence.basis, /identical mix of weekdays/);
    assert.equal(draft.evidence.values.current_cents, 230_000);
  });

  test('the identity is the problem, not its size — a worse week lands on the same card', () => {
    const first = only(detectSupplySpendBaseline(ctxWith({ supply_spend_history: steadySpend(230_000) })));
    const worse = only(detectSupplySpendBaseline(ctxWith({ supply_spend_history: steadySpend(400_000) })));
    assert.equal(first.key, worse.key);
    assert.ok(worse.magnitude > first.magnitude);
  });

  test('a mildly expensive week says nothing', () => {
    assert.deepEqual(detectSupplySpendBaseline(ctxWith({ supply_spend_history: steadySpend(105_000) })), []);
  });

  test('a cheap week says nothing — under-spending is not a 6am card', () => {
    assert.deepEqual(detectSupplySpendBaseline(ctxWith({ supply_spend_history: steadySpend(1_000) })), []);
  });

  test('a week 30% above normal is still inside this hotel own swing', () => {
    // $1,250 against a $950 median: real money, above anything in the last
    // twelve weeks, and STILL only two robust deviations out. This is the
    // week the bar exists to keep off a manager's morning.
    assert.deepEqual(
      detectSupplySpendBaseline(ctxWith({ supply_spend_history: steadySpend(125_000) })),
      [],
      'clearing the dollar floor is not the same as being unusual',
    );
  });

  test('statistically striking but only $50 is not worth waking anybody up for', () => {
    // A hotel that spends about $10 a week and this week spent $60. Wildly
    // outside its own normal by any measure, and completely uninteresting.
    const tiny = spendFixture(TODAY, 12, (week) => (week === 0 ? 6_000 : 1_000 + (week % 3) * 10));
    assert.deepEqual(
      detectSupplySpendBaseline(ctxWith({ supply_spend_history: tiny })),
      [],
      'a card has to be worth the interruption, not merely an outlier',
    );
  });

  test('a three-week-old hotel gets silence, not a guess', () => {
    const young = spendFixture(TODAY, 2, (week) => (week === 0 ? 230_000 : 90_000));
    assert.deepEqual(
      detectSupplySpendBaseline(ctxWith({ supply_spend_history: young })),
      [],
      'a hotel with no normal must not have one invented for it',
    );
  });

  test('a hotel that orders once a month gets silence — "normal" is not a thing there', () => {
    const sporadic = spendFixture(TODAY, 12, (week) => (week % 4 === 0 ? 230_000 : 0));
    assert.deepEqual(detectSupplySpendBaseline(ctxWith({ supply_spend_history: sporadic })), []);
  });

  // ── the false-positive guard ──────────────────────────────────────────────
  test('a hotel is never surprised by its own habit', () => {
    const CURRENT = 230_000;

    // Hotel one has never had a week like this.
    const surprising = detectSupplySpendBaseline(
      ctxWith({ supply_spend_history: steadySpend(CURRENT) }),
    );

    // Hotel two spends the same $2,300 — but bulk-orders every fourth week and
    // has done three times in the last twelve, on top of steady weekly spend.
    const habitual = detectSupplySpendBaseline(
      ctxWith({
        supply_spend_history: spendFixture(TODAY, 12, (week) =>
          week % 4 === 0 ? CURRENT : 30_000,
        ),
      }),
    );

    assert.equal(surprising.length, 1, 'the hotel with no such week on record should hear about it');
    assert.deepEqual(
      habitual,
      [],
      'THE test: the same $2,300 week, explained by the hotel own like-for-like history, must be silent',
    );
  });
});

// ─── work-order rate ────────────────────────────────────────────────────────

describe('maintenance being logged far faster than usual', () => {
  const steady = (current: number, costs: number[] = []) =>
    workOrderFixture(TODAY, 12, (week) => (week === 0 ? current : 2 + (week % 3)), costs);

  test('a spike becomes one finding priced from what this hotel actually pays', () => {
    const draft = only(
      detectWorkOrderRateBaseline(
        ctxWith({ work_order_history: steady(14, [3_250, 8_500, 12_000, 4_400]) }),
      ),
    );
    assert.equal(draft.key, 'weekly_work_order_rate');
    assert.equal(draft.magnitude, 11);
    assert.ok(isUsablePriceRange(draft.price));
    assert.match(draft.price!.basis, /you have actually paid on your last 4 repairs/);
  });

  test('a hotel that has never recorded a repair cost gets NO dollar figure and says why', () => {
    const draft = only(detectWorkOrderRateBaseline(ctxWith({ work_order_history: steady(14, []) })));
    assert.equal(
      draft.price,
      null,
      'borrowing an average repair cost from elsewhere is the invented number the range format exists to prevent',
    );
    assert.match(
      String(draft.evidence.values.price_basis),
      /no dollar figure: this hotel has recorded a repair cost on only 0 work orders/,
      'an absent price still has to explain itself',
    );
  });

  test('two recorded repairs is still not enough to quote a range', () => {
    const draft = only(
      detectWorkOrderRateBaseline(ctxWith({ work_order_history: steady(14, [3_250, 8_500]) })),
    );
    assert.equal(draft.price, null);
  });

  test('one extra ticket says nothing', () => {
    assert.deepEqual(detectWorkOrderRateBaseline(ctxWith({ work_order_history: steady(5) })), []);
  });

  test('four more than usual is a busy week, not a signal', () => {
    // Above anything in the last twelve weeks and well past the three-ticket
    // floor, yet under three robust deviations. Buildings have busy weeks.
    assert.deepEqual(detectWorkOrderRateBaseline(ctxWith({ work_order_history: steady(7) })), []);
  });

  test('a hotel with a metronomic three-a-week does not get a card over two extra', () => {
    const metronome = (current: number) =>
      workOrderFixture(TODAY, 12, (week) => (week === 0 ? current : 3));
    assert.deepEqual(
      detectWorkOrderRateBaseline(ctxWith({ work_order_history: metronome(5) })),
      [],
      'two extra tickets is inside the noise of any hotel, however consistent its history looks',
    );
    assert.equal(
      detectWorkOrderRateBaseline(ctxWith({ work_order_history: metronome(6) })).length,
      1,
      'and three extra is where it starts speaking',
    );
  });

  test('a quiet week says nothing here — that belongs to the absence detector', () => {
    assert.deepEqual(detectWorkOrderRateBaseline(ctxWith({ work_order_history: steady(0) })), []);
  });

  test('a hotel that barely logs maintenance has no rate and gets silence', () => {
    const sporadic = workOrderFixture(TODAY, 12, (week) =>
      week === 0 ? 14 : week % 5 === 0 ? 2 : 0,
    );
    assert.deepEqual(detectWorkOrderRateBaseline(ctxWith({ work_order_history: sporadic })), []);
  });

  test('a hotel that logs in monthly batches is not surprised by its own batch', () => {
    const batched = workOrderFixture(TODAY, 12, (week) => (week % 4 === 0 ? 14 : 2));
    assert.deepEqual(detectWorkOrderRateBaseline(ctxWith({ work_order_history: batched })), []);
  });
});

// ─── inventory usage ────────────────────────────────────────────────────────

describe('an item going out faster than it used to', () => {
  const ITEM = 'a1b2c3d4-0000-4000-8000-000000000001';
  const STEADY = [4, 4.3, 3.8, 4.1, 4.4, 3.9, 4.2, 4, 4.5, 3.7, 4.1];

  test('a jump becomes one finding keyed on the item, priced at what they pay for it', () => {
    const draft = only(
      detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: usageFixture(ITEM, [...STEADY, 18]) })),
    );
    assert.equal(draft.key, `item_usage:${ITEM}`);
    assert.ok(isUsablePriceRange(draft.price));
    assert.match(draft.price!.basis, /you have been paying/);
    assert.equal(draft.evidence.values.item_name, 'Bath towels');
  });

  test('the key survives the number changing', () => {
    const a = only(detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: usageFixture(ITEM, [...STEADY, 18]) })));
    const b = only(detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: usageFixture(ITEM, [...STEADY, 30]) })));
    assert.equal(a.key, b.key);
    assert.ok(b.magnitude > a.magnitude);
  });

  test('an item with no recorded cost gets no dollar figure and names the item in the reason', () => {
    const draft = only(
      detectInventoryUsageBaseline(
        ctxWith({
          inventory_usage_history: usageFixture(ITEM, [...STEADY, 18], { unitCostCentsSamples: [] }),
        }),
      ),
    );
    assert.equal(draft.price, null);
    assert.match(String(draft.evidence.values.price_basis), /never recorded what it pays for Bath towels/);
  });

  test('a slightly busy stretch says nothing', () => {
    assert.deepEqual(
      detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: usageFixture(ITEM, [...STEADY, 5.2]) })),
      [],
    );
  });

  test('a rate half again as high as usual is not yet outside this item own swing', () => {
    assert.deepEqual(
      detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: usageFixture(ITEM, [...STEADY, 6]) })),
      [],
      'the bar for this series is deliberately higher — nothing here controls for weekday or occupancy',
    );
  });

  test('a slow-moving item does not get a card over four extra units', () => {
    // Same shape as the towels, one tenth the rate: wildly outside its own
    // history by the arithmetic, and four units of soap in real life.
    const slow = STEADY.map((rate) => rate / 10);
    assert.deepEqual(
      detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: usageFixture(ITEM, [...slow, 2]) })),
      [],
    );
    assert.equal(
      detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: usageFixture(ITEM, [...slow, 2.2]) })).length,
      1,
      'and it does once the overage is worth a manager going to look',
    );
  });

  test('an item counted a handful of times has no rate to be unusual against', () => {
    assert.deepEqual(
      detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: usageFixture(ITEM, [4, 4.2, 3.9, 18]) })),
      [],
      'ten prior counts is the honesty floor; four is a coincidence',
    );
  });

  test('an item that swings wildly by nature is not surprised by another swing', () => {
    const wild = usageFixture(ITEM, [1, 18, 2, 17, 1.5, 19, 2.5, 16, 1, 18, 2, 18]);
    assert.deepEqual(detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: wild })), []);
  });

  test('a single-day interval is a snapshot, not a rate', () => {
    const oneDay = usageFixture(ITEM, [...STEADY, 18], { days: 1 });
    assert.deepEqual(detectInventoryUsageBaseline(ctxWith({ inventory_usage_history: oneDay })), []);
  });

  test('two items are two findings, each on its own identity', () => {
    const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';
    const first = usageFixture(ITEM, [...STEADY, 18]);
    const second = usageFixture(OTHER, [...STEADY, 22], { itemName: 'Coffee pods' });
    const drafts = detectInventoryUsageBaseline(
      ctxWith({
        inventory_usage_history: { ...first, items: [...first.items, ...second.items] },
      }),
    );
    assert.deepEqual(drafts.map((d) => d.key).sort(), [`item_usage:${ITEM}`, `item_usage:${OTHER}`]);
  });
});

// ─── absence ────────────────────────────────────────────────────────────────

describe('an expected thing stopped', () => {
  test('a hotel that counts every 3 days and has not counted in 9 hears about it', () => {
    const draft = only(
      detectExpectedActivityStopped(
        ctxWith({
          operating_rhythm: rhythmFixture(
            [{ id: 'inventory_counts', everyNDays: 3, occurrences: 12, silentDays: 9 }],
            TODAY,
          ),
        }),
      ),
    );
    assert.equal(draft.key, 'stopped:inventory_counts');
    assert.equal(draft.magnitude, 9, 'magnitude is days of silence, and it is what a manager consents to');
    assert.equal(draft.evidence.values.typical_gap_days, 3);
  });

  test('the identity is the stream, so day 12 lands on the card day 9 opened', () => {
    const at = (silentDays: number) =>
      only(
        detectExpectedActivityStopped(
          ctxWith({
            operating_rhythm: rhythmFixture(
              [{ id: 'inventory_counts', everyNDays: 3, occurrences: 12, silentDays }],
              TODAY,
            ),
          }),
        ),
      );
    assert.equal(at(9).key, at(12).key);
    assert.equal(at(12).magnitude, 12);
  });

  test('a gap this hotel takes all the time is not a finding', () => {
    assert.deepEqual(
      detectExpectedActivityStopped(
        ctxWith({
          operating_rhythm: rhythmFixture(
            [{ id: 'inventory_counts', everyNDays: 3, occurrences: 12, silentDays: 4 }],
            TODAY,
          ),
        }),
      ),
      [],
    );
  });

  test('a daily habit missing two days is not a card — nobody wants that at 6am', () => {
    assert.deepEqual(
      detectExpectedActivityStopped(
        ctxWith({
          operating_rhythm: rhythmFixture(
            [{ id: 'daily_log_closings', label: 'closing out the daily log', everyNDays: 1, occurrences: 40, silentDays: 2 }],
            TODAY,
          ),
        }),
      ),
      [],
      'however tight the measured rhythm, there is a floor below which silence is just a weekend',
    );
  });

  test('a hotel that has only ever done it twice has no rhythm to break', () => {
    assert.deepEqual(
      detectExpectedActivityStopped(
        ctxWith({
          operating_rhythm: rhythmFixture(
            [{ id: 'inventory_counts', everyNDays: 3, occurrences: 2, silentDays: 60 }],
            TODAY,
          ),
        }),
      ),
      [],
      'no rhythm on record means no expectation, however long the silence',
    );
  });

  test('a weekly hotel is judged weekly and a daily hotel daily', () => {
    const found = detectExpectedActivityStopped(
      ctxWith({
        operating_rhythm: rhythmFixture(
          [
            { id: 'work_order_flow', label: 'logging maintenance', everyNDays: 7, occurrences: 10, silentDays: 8 },
            { id: 'daily_log_closings', label: 'closing out the daily log', everyNDays: 1, occurrences: 40, silentDays: 8 },
          ],
          TODAY,
        ),
      }),
    );
    assert.deepEqual(
      found.map((d) => d.key),
      ['stopped:daily_log_closings'],
      'eight days is business as usual for the weekly stream and a break in the daily one',
    );
  });

  test('the count stream is priced from what counting actually turns up here', () => {
    const draft = only(
      detectExpectedActivityStopped(
        ctxWith({
          operating_rhythm: rhythmFixture(
            [
              {
                id: 'inventory_counts',
                everyNDays: 3,
                occurrences: 12,
                silentDays: 9,
                worthCentsSamples: [4_400, 15_800, 78_750, 44_200],
                worthBasis: 'stock your own counts found unaccounted for',
              },
            ],
            TODAY,
          ),
        }),
      ),
    );
    assert.ok(isUsablePriceRange(draft.price));
    assert.match(draft.price!.basis, /each turned up .* of stock your own counts found unaccounted for/);
  });

  test('a stream with nothing to price it by carries an explicit null and the reason', () => {
    const draft = only(
      detectExpectedActivityStopped(
        ctxWith({
          operating_rhythm: rhythmFixture(
            [{ id: 'daily_log_closings', label: 'closing out the daily log', everyNDays: 1, occurrences: 40, silentDays: 8 }],
            TODAY,
          ),
        }),
      ),
    );
    assert.equal(draft.price, null);
    assert.match(String(draft.evidence.values.price_basis), /no dollar figure/);
  });

  test('two recorded amounts is not enough to price it', () => {
    const draft = only(
      detectExpectedActivityStopped(
        ctxWith({
          operating_rhythm: rhythmFixture(
            [
              {
                id: 'inventory_counts',
                everyNDays: 3,
                occurrences: 12,
                silentDays: 9,
                worthCentsSamples: [4_400, 15_800],
                worthBasis: 'stock your own counts found unaccounted for',
              },
            ],
            TODAY,
          ),
        }),
      ),
    );
    assert.equal(draft.price, null);
    assert.match(String(draft.evidence.values.price_basis), /not enough for an honest range/);
  });
});

// ─── the declarations, through the spine's own hook ─────────────────────────

describe("each detector's frozen cases pass through the spine's eval hook", () => {
  for (const detector of [
    supplySpendBaselineDetector,
    workOrderRateBaselineDetector,
    inventoryUsageBaselineDetector,
    expectedActivityDetector,
  ]) {
    test(`${detector.declaration.id}`, () => {
      const results = runDetectorEvalCases(detector);
      assert.ok(results.length >= 4, 'a detector with one token case has not been thought about');
      assert.deepEqual(
        results.filter((r) => !r.ok).map((f) => `${f.name}: ${f.detail}`),
        [],
      );
    });
  }

  test('every one of them declares a case where it stays SILENT', () => {
    for (const detector of [
      supplySpendBaselineDetector,
      workOrderRateBaselineDetector,
      inventoryUsageBaselineDetector,
      expectedActivityDetector,
    ]) {
      assert.ok(
        detector.declaration.evalCases.some((c) => c.expectKeys.length === 0),
        `${detector.declaration.id} froze no example of staying quiet, which is the half that matters`,
      );
    }
  });
});
