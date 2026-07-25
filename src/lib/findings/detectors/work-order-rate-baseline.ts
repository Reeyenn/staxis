// ─── Detector: maintenance being logged far faster than usual ────────────────
//
// The count of work orders a hotel opens in a week is one of the few honest
// early signals it has. A jump means something started breaking — a chiller, a
// water heater, a floor of doors — days before anybody connects the individual
// tickets. Nobody could write the rule in advance because the normal rate is a
// property of the building and the staff, so again the hotel's own twelve weeks
// draw the line.
//
// ONLY UPWARDS, ON PURPOSE
// A COLLAPSE in work-order logging is not health, it is usually the staff
// having stopped using the app — and that is the absence detector's job, where
// it gets phrased as "nobody has logged maintenance in nine days" instead of a
// baseline card claiming the building got better.
//
// MONEY, OR SILENCE
// The only honest price here is what THIS hotel has actually paid to fix
// things (`work_orders.repair_cost`). A hotel that has never filled that in
// gets a finding with no dollar figure and an evidence line saying exactly why.
// Borrowing an average repair cost from somewhere else would be the invented
// number the whole range format exists to prevent.

import { addDaysInTz } from '@/lib/schedule/local-date';

import { registerDetector } from '../registry';
import { excessBand, formatCentsBand, multiplyBands, priceFromBand, plural, sampleBand } from '../pricing';
import type { DailySeriesPoint, WorkOrderHistory } from '../history';
import type { Detector, DetectorContext, DetectorParams, FindingDraft } from '../types';
import { readFeed } from '../types';
import { buildBaseline, deviationOf } from './baseline-math';

const RECEIPT = 'work_order_rate_weekly_baseline';

const BASELINE_WEEKS = 12;
/** A hotel that logs maintenance most weeks. Fewer and there is no rate here. */
const MIN_NON_ZERO_WINDOWS = 8;
const MIN_Z = 3.5;
/** Two extra tickets is noise; a real spike is bigger than that. */
const MIN_EXTRA_WORK_ORDERS = 3;
/** Fewest recorded repair costs before we will quote a dollar figure. */
const MIN_COST_SAMPLES = 3;

export function detectWorkOrderRateBaseline(ctx: DetectorContext): FindingDraft[] {
  const history: WorkOrderHistory = readFeed(ctx, 'work_order_history');

  const built = buildBaseline(
    history.createdPerDay,
    ctx.businessDate,
    history.coverageStartDate,
    {
      baselineWeeks: BASELINE_WEEKS,
      minNonZeroWindows: MIN_NON_ZERO_WINDOWS,
      subject: 'work orders',
    },
  );
  if (!built.ok) return [];

  const { split, baseline } = built;
  const current = split.current.value;
  const deviation = deviationOf(current, baseline);

  if (!deviation.aboveRoutineHigh) return [];
  if (deviation.z < MIN_Z) return [];

  const extra = current - baseline.median;
  if (extra < MIN_EXTRA_WORK_ORDERS) return [];

  const normalBand = { low: baseline.p25, high: baseline.p75 };
  const extraBand = excessBand(current, normalBand);
  const costBand = sampleBand(history.repairCostCentsSamples, { minSamples: MIN_COST_SAMPLES });

  const noDollarReason = !costBand
    ? history.repairCostCentsSamples.length < MIN_COST_SAMPLES
      ? `no dollar figure: this hotel has recorded a repair cost on only ` +
        `${plural(history.repairCostCentsSamples.length, 'work order')}, which is not enough ` +
        'to say what a repair costs here'
      : 'no dollar figure: every repair cost this hotel has recorded is the same number, ' +
        'so there is no honest range to quote'
    : 'no dollar figure: your last 12 weeks are too uniform to say how many of this week' +
      "'s work orders were the extra ones";

  const pricing = priceFromBand(
    extraBand && costBand ? multiplyBands(extraBand, costBand) : null,
    costBand && extraBand
      ? `${Math.round(extraBand.low)}-${Math.round(extraBand.high)} more work orders than your ` +
        `usual ${Math.round(baseline.p25)}-${Math.round(baseline.p75)} a week, at the ` +
        `${formatCentsBand(costBand)} you have actually paid on your last ` +
        `${plural(history.repairCostCentsSamples.length, 'repair')}`
      : '',
    noDollarReason,
  );

  return [
    {
      key: 'weekly_work_order_rate',
      summary:
        `${plural(Math.round(current), 'work order')} opened in the week ending ` +
        `${split.current.endDate} — your last ${BASELINE_WEEKS} weeks averaged about ` +
        `${Math.round(baseline.median)} a week.`,
      severity: 'attention',
      magnitude: Math.round(extra),
      evidence: {
        queryId: RECEIPT,
        params: {
          baseline_weeks: BASELINE_WEEKS,
          current_start: split.current.startDate,
          current_end: split.current.endDate,
          baseline_start: split.baselineStartDate,
        },
        values: {
          current_work_orders: Math.round(current),
          median_per_week: Math.round(baseline.median * 100) / 100,
          trimmed_mean_per_week: Math.round(baseline.trimmedMean * 100) / 100,
          p25_per_week: Math.round(baseline.p25 * 100) / 100,
          p75_per_week: Math.round(baseline.p75 * 100) / 100,
          p90_per_week: Math.round(baseline.p90 * 100) / 100,
          robust_z: Math.round(deviation.z * 100) / 100,
          baseline_windows: baseline.n,
          repair_cost_samples: history.repairCostCentsSamples.length,
          price_basis: pricing.note,
        },
        basis:
          `work orders created in the 7 days ending ${split.current.endDate}, against the ` +
          `${BASELINE_WEEKS} weeks before it — every window an identical mix of weekdays`,
      },
      price: pricing.price,
    },
  ];
}

// ─── Eval fixtures ───────────────────────────────────────────────────────────

/** `weekCount(0)` is the current week; 1..N are the weeks before it. */
export function workOrderFixture(
  businessDate: string,
  weeks: number,
  weekCount: (weekIndex: number) => number,
  repairCostCentsSamples: number[] = [],
): WorkOrderHistory {
  const createdPerDay: DailySeriesPoint[] = [];
  for (let week = 0; week <= weeks; week += 1) {
    const endDate = addDaysInTz(businessDate, -1 - 7 * week);
    const startDate = addDaysInTz(endDate, -6);
    const count = weekCount(week);
    // Spread across the week's days so the fixture looks like a hotel logging
    // tickets, not like one ticket a week carrying a big number.
    for (let i = 0; i < count; i += 1) {
      createdPerDay.push({ date: addDaysInTz(startDate, i % 7), value: 1 });
    }
    if (count === 0) createdPerDay.push({ date: startDate, value: 0 });
  }
  createdPerDay.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    createdPerDay,
    repairCostCentsSamples,
    coverageStartDate: createdPerDay[0]?.date ?? null,
    windowDays: 98,
  };
}

const EVAL_DATE = '2026-01-01';

export const workOrderRateBaselineDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'work_order_rate_baseline',
    description:
      "Work orders being opened far faster than this hotel's own normal week — something started breaking.",
    inputs: ['work_order_history'],
    requires: [
      {
        feed: 'work_order_history',
        minRecords: 24,
        because:
          'this hotel has logged fewer than 24 work orders in the last 14 weeks, which is not enough to know what a normal week looks like here',
      },
    ],
    receiptQueryId: RECEIPT,
    defaultDisposition: 'recommend',
    defaultSeverity: 'attention',
    escalation: { factor: 2, minDelta: 3 },
    maxPerRun: 1,
    staleAfterDays: 14,
    evalCases: [
      {
        name: 'a spike against twelve steady weeks is one finding',
        feeds: {
          work_order_history: workOrderFixture(
            EVAL_DATE,
            12,
            (week) => (week === 0 ? 14 : 2 + (week % 3)),
            [3_250, 8_500, 12_000, 4_400],
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: ['weekly_work_order_rate'],
      },
      {
        name: 'one extra ticket says nothing',
        feeds: {
          work_order_history: workOrderFixture(EVAL_DATE, 12, (week) =>
            week === 0 ? 5 : 2 + (week % 3),
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
      {
        name: 'a hotel that logs maintenance in monthly batches is not surprised by its own batch',
        feeds: {
          work_order_history: workOrderFixture(EVAL_DATE, 12, (week) =>
            week % 4 === 0 ? 14 : 2,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
      {
        name: 'a hotel that barely logs maintenance gets no rate and no verdict',
        feeds: {
          work_order_history: workOrderFixture(EVAL_DATE, 12, (week) =>
            week === 0 ? 14 : week % 5 === 0 ? 2 : 0,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
      {
        name: 'a quiet week belongs to the absence detector, not to this one',
        feeds: {
          work_order_history: workOrderFixture(EVAL_DATE, 12, (week) =>
            week === 0 ? 0 : 2 + (week % 3),
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
    ],
  },
  detect: detectWorkOrderRateBaseline,
};

registerDetector(workOrderRateBaselineDetector);
