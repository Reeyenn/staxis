// ─── Detector: supply spending unusual FOR THIS HOTEL ────────────────────────
//
// Nobody predicted this problem. There is no rule that says "a Comfort Suites
// should spend under $900 a week on supplies" — there could not be, because the
// number depends on the hotel's size, its occupancy, its vendors and its
// habits. So the hotel's own last twelve weeks draw the line, and all we chose
// was to watch the line at all.
//
// WHAT IT WILL NOT SAY, AND WHY THAT MATTERS MORE THAN WHAT IT WILL
//   • A hotel younger than fourteen weeks gets nothing. It has no normal, and
//     inventing one would make its first bulk order an emergency.
//   • A hotel that orders sporadically gets nothing. If only four of the last
//     twelve weeks had any deliveries at all, "a normal week" is not a thing
//     that exists there.
//   • A week no bigger than the hotel's own recent high gets nothing, however
//     the arithmetic scores it. A hotel that bulk-orders every fourth week has
//     PROVEN that weeks like this happen here.
//   • A quiet week gets nothing. Under-spending is not a card a manager wants
//     at 6am, and the absence detector already covers "ordering stopped".
//
// The price tag is the overspend, and its width is the hotel's own normal band:
// if their usual week runs $820-$1,140 and this one was $2,300, the answer is
// "$1,150-$1,500", never "$1,320". Nobody knows which of their normal weeks
// this one should have been.

import { registerDetector } from '../registry';
import { addDaysInTz } from '@/lib/schedule/local-date';
import {
  excessBand,
  formatCents,
  formatCentsBand,
  priceFromBand,
} from '../pricing';
import type { DailySeriesPoint, SupplySpendHistory } from '../history';
import type { Detector, DetectorContext, DetectorParams, FindingDraft } from '../types';
import { readFeed } from '../types';
import { buildBaseline, deviationOf } from './baseline-math';

const RECEIPT = 'supply_spend_weekly_baseline';

/** Twelve complete weeks before the current one. */
const BASELINE_WEEKS = 12;
/** Fewer than this many spending weeks and there is no "normal" here. */
const MIN_NON_ZERO_WINDOWS = 8;
/** How far outside its own normal a week has to be before it is worth saying. */
const MIN_Z = 3.5;
/** And it has to be real money, not a statistically interesting $12. */
const MIN_EXCESS_CENTS = 20_000;

export function detectSupplySpendBaseline(ctx: DetectorContext): FindingDraft[] {
  const history: SupplySpendHistory = readFeed(ctx, 'supply_spend_history');

  const built = buildBaseline(history.days, ctx.businessDate, history.coverageStartDate, {
    baselineWeeks: BASELINE_WEEKS,
    minNonZeroWindows: MIN_NON_ZERO_WINDOWS,
    subject: 'supply deliveries',
  });
  if (!built.ok) return [];

  const { split, baseline } = built;
  const current = split.current.value;
  const deviation = deviationOf(current, baseline);

  if (!deviation.aboveRoutineHigh) return [];
  if (deviation.z < MIN_Z) return [];

  const excess = current - baseline.median;
  if (excess < MIN_EXCESS_CENTS) return [];

  const normalBand = { low: baseline.p25, high: baseline.p75 };
  const pricing = priceFromBand(
    excessBand(current, normalBand),
    `your last ${BASELINE_WEEKS} comparable weeks ran ${formatCentsBand(normalBand)}; ` +
      `the week ending ${split.current.endDate} was ${formatCents(current)}`,
    'no dollar figure: your last 12 weeks cost almost exactly the same every time, so there ' +
      'is no honest range for how much of this week was the extra',
  );

  return [
    {
      // Identity WITHOUT the number: next week's bigger overspend lands on this
      // same card rather than stacking a second one beside it.
      key: 'weekly_supply_spend',
      summary:
        `Supply spending ran ${formatCents(current)} in the week ending ${split.current.endDate} — ` +
        `your last ${BASELINE_WEEKS} weeks ran ${formatCentsBand(normalBand)}.`,
      severity: 'attention',
      magnitude: Math.round(excess),
      evidence: {
        queryId: RECEIPT,
        params: {
          baseline_weeks: BASELINE_WEEKS,
          current_start: split.current.startDate,
          current_end: split.current.endDate,
          baseline_start: split.baselineStartDate,
        },
        values: {
          current_cents: Math.round(current),
          median_cents: Math.round(baseline.median),
          trimmed_mean_cents: Math.round(baseline.trimmedMean),
          p25_cents: Math.round(baseline.p25),
          p75_cents: Math.round(baseline.p75),
          p90_cents: Math.round(baseline.p90),
          robust_z: Math.round(deviation.z * 100) / 100,
          baseline_windows: baseline.n,
          non_zero_windows: baseline.nonZeroWindows,
          price_basis: pricing.note,
        },
        basis:
          `the 7 days ending ${split.current.endDate} against the ${BASELINE_WEEKS} weeks ` +
          'before it — every window an identical mix of weekdays',
      },
      price: pricing.price,
    },
  ];
}

// ─── Eval fixtures ───────────────────────────────────────────────────────────
// Built rather than hand-listed so the cases say what they MEAN ("twelve normal
// weeks then a blowout") instead of ninety opaque dated rows.

/** `weekCents(0)` is the current week; 1..N are the weeks before it. */
export function spendFixture(
  businessDate: string,
  weeks: number,
  weekCents: (weekIndex: number) => number,
): SupplySpendHistory {
  const days: DailySeriesPoint[] = [];
  for (let week = 0; week <= weeks; week += 1) {
    const endDate = addDaysInTz(businessDate, -1 - 7 * week);
    const startDate = addDaysInTz(endDate, -6);
    const cents = weekCents(week);
    if (cents !== 0) days.push({ date: startDate, value: cents });
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    days,
    coverageStartDate: days[0]?.date ?? null,
    windowDays: 98,
  };
}

const EVAL_DATE = '2026-01-01';

export const supplySpendBaselineDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'supply_spend_baseline',
    description:
      "Supply spending far outside this hotel's own normal week, measured against its last 12 weeks.",
    inputs: ['supply_spend_history'],
    requires: [
      {
        feed: 'supply_spend_history',
        // Twelve baseline weeks plus a current one cannot be built from fewer
        // than a couple of months of spending days. The real history test lives
        // in the detector, which can see the dates; this is the cheap floor.
        minRecords: 12,
        because:
          'this hotel has logged supply deliveries on fewer than 12 days, which is not enough to know what a normal week costs here',
      },
    ],
    receiptQueryId: RECEIPT,
    defaultDisposition: 'recommend',
    defaultSeverity: 'attention',
    // A manager who accepted a $400 overspend accepted $400, not $1,200.
    escalation: { factor: 2, minDelta: 25_000 },
    maxPerRun: 1,
    // Weekly windows: two quiet weeks and the problem is genuinely over.
    staleAfterDays: 14,
    evalCases: [
      {
        name: 'a blowout week against twelve steady ones is one finding',
        feeds: {
          supply_spend_history: spendFixture(EVAL_DATE, 12, (week) =>
            week === 0 ? 230_000 : 90_000 + (week % 3) * 5_000,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: ['weekly_supply_spend'],
      },
      {
        name: 'a slightly expensive week says nothing',
        feeds: {
          supply_spend_history: spendFixture(EVAL_DATE, 12, (week) =>
            week === 0 ? 105_000 : 90_000 + (week % 3) * 5_000,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
      {
        name: 'a hotel that bulk-orders every fourth week is not surprised by its own bulk order',
        feeds: {
          supply_spend_history: spendFixture(EVAL_DATE, 12, (week) =>
            week % 4 === 0 ? 230_000 : 30_000,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
      {
        name: 'a three-week-old hotel gets no baseline and therefore no verdict',
        feeds: {
          supply_spend_history: spendFixture(EVAL_DATE, 2, (week) =>
            week === 0 ? 230_000 : 90_000,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
      {
        name: 'a cheap week is not a card',
        feeds: {
          supply_spend_history: spendFixture(EVAL_DATE, 12, (week) =>
            week === 0 ? 1_000 : 90_000 + (week % 3) * 5_000,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
    ],
  },
  detect: detectSupplySpendBaseline,
};

registerDetector(supplySpendBaselineDetector);
