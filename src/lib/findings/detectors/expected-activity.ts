// ─── Detector: an expected thing stopped ─────────────────────────────────────
//
// Staff data fails by OMISSION, and nothing in the app catches that. Every
// other check in Staxis reads what was written down; this one reads what wasn't.
// A hotel that logged maintenance every week for four months and has logged
// nothing for eleven days does not have a healthier building — it has a data
// problem, and every number downstream of that feed is quietly getting worse
// while every screen keeps saying "all clear".
//
// THE RHYTHM IS THE HOTEL'S, NOT OURS
// There is no configured cadence anywhere in this file. "Linen gets counted
// every three days here" is not a setting a Staxis employee typed in; it is
// what the hotel's own dates say, recomputed nightly. A hotel that counts
// weekly and a hotel that counts twice a day both get judged against
// themselves, and a hotel with no rhythm on record gets judged against nothing:
//
//   no rhythm  ->  no expectation  ->  no finding.
//
// That is the honesty rule, and it is why the detector says nothing at all
// about a hotel in its first month. It is also why the tolerance is the larger
// of twice the usual gap and one day past the long-but-normal wait: a hotel
// whose counts sometimes slip nine days has DEMONSTRATED that nine days happens
// there, and a card on day eight is how a watcher turns into noise.
//
// PRICE
// Only one of these streams can be priced from the hotel's own numbers, and it
// is priced from the thing counting actually turns up: the stock their own
// counts found the books could not account for. The other two carry an explicit
// null and an evidence line saying why. Attaching "about $300" to "nobody
// closed the daily log" would be a number we made up, and the range format
// exists precisely so that cannot happen quietly.

import { registerDetector } from '../registry';
import { formatCentsBand, plural, priceFromBand, sampleBand } from '../pricing';
import type { ActivityStream, OperatingRhythmHistory } from '../history';
import type { Detector, DetectorContext, DetectorParams, FindingDraft } from '../types';
import { readFeed } from '../types';
import { cadenceOf, daysBetween } from './baseline-math';

const RECEIPT = 'expected_activity_gap';

/** Fewest occurrences before a stream counts as a habit rather than a couple of accidents. */
const MIN_EVENTS = 6;
/** Never nag about a two-day silence, however tight the measured rhythm is. */
const MIN_TOLERANCE_DAYS = 3;
/** Fewest recorded amounts before this detector will quote any dollar range. */
const MIN_WORTH_SAMPLES = 3;

function draftForStream(stream: ActivityStream, businessDate: string): FindingDraft | null {
  const cadence = cadenceOf(stream.dates, {
    minEvents: MIN_EVENTS,
    minToleranceDays: MIN_TOLERANCE_DAYS,
  });
  // No rhythm on record: this hotel has never established that it does this,
  // so there is nothing for it to have stopped doing.
  if (!cadence) return null;

  const lastDate = [...stream.dates].sort().pop();
  if (!lastDate) return null;

  const silentDays = daysBetween(lastDate, businessDate);
  if (silentDays < cadence.toleranceDays) return null;

  const worthBand = stream.worthBasis
    ? sampleBand(stream.worthCentsSamples, { minSamples: MIN_WORTH_SAMPLES })
    : null;
  const pricing = priceFromBand(
    worthBand,
    worthBand && stream.worthBasis
      ? `your last ${plural(stream.worthCentsSamples.length, 'count')} each turned up ` +
        `${formatCentsBand(worthBand)} of ${stream.worthBasis}`
      : '',
    stream.worthBasis
      ? `no dollar figure: this hotel has only ${plural(stream.worthCentsSamples.length, 'record')} ` +
        'of what this turns up, which is not enough for an honest range'
      : "no dollar figure: nothing in this hotel's own records puts a price on this, and a " +
        'made-up number would be worse than none',
  );

  return {
    // Identity is the STREAM, never the number of days. Day 12 lands on the
    // card that opened on day 9 instead of stacking a second one beside it.
    key: `stopped:${stream.id}`,
    summary:
      `Nobody has been ${stream.label} for ${plural(silentDays, 'day')}. This hotel ` +
      `normally does it about every ${plural(round1(cadence.medianGapDays), 'day')}.`,
    severity: 'attention',
    magnitude: silentDays,
    evidence: {
      queryId: RECEIPT,
      params: { stream: stream.id, as_of: businessDate },
      values: {
        last_seen: lastDate,
        days_silent: silentDays,
        typical_gap_days: round1(cadence.medianGapDays),
        long_but_normal_gap_days: round1(cadence.p90GapDays),
        tolerance_days: round1(cadence.toleranceDays),
        occurrences_on_record: cadence.events,
        price_basis: pricing.note,
      },
      basis:
        `${plural(cadence.events, 'time')} on record, most recently ${lastDate}; ` +
        `the usual wait here is ${round1(cadence.medianGapDays)} days and the longest ` +
        `routine wait is ${round1(cadence.p90GapDays)}`,
    },
    price: pricing.price,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function detectExpectedActivityStopped(ctx: DetectorContext): FindingDraft[] {
  const history: OperatingRhythmHistory = readFeed(ctx, 'operating_rhythm');
  const drafts: FindingDraft[] = [];
  for (const stream of history.streams) {
    const draft = draftForStream(stream, ctx.businessDate);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

// ─── Eval fixtures ───────────────────────────────────────────────────────────

/** `everyNDays` occurrences, the most recent one `silentDays` ago. */
export function rhythmFixture(
  streams: Array<{
    id: string;
    label?: string;
    everyNDays: number;
    occurrences: number;
    silentDays: number;
    worthCentsSamples?: number[];
    worthBasis?: string | null;
  }>,
  businessDate: string,
): OperatingRhythmHistory {
  const built: ActivityStream[] = streams.map((spec) => {
    const dates: string[] = [];
    for (let i = 0; i < spec.occurrences; i += 1) {
      dates.push(shiftDate(businessDate, -(spec.silentDays + i * spec.everyNDays)));
    }
    return {
      id: spec.id,
      label: spec.label ?? 'counting inventory',
      dates: dates.sort(),
      worthCentsSamples: spec.worthCentsSamples ?? [],
      worthBasis: spec.worthBasis ?? null,
    };
  });
  return {
    streams: built,
    coverageStartDate: built.flatMap((s) => s.dates).sort()[0] ?? null,
    windowDays: 98,
  };
}

function shiftDate(yyyymmdd: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyymmdd);
  if (!m) throw new Error(`Invalid YYYY-MM-DD: ${yyyymmdd}`);
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000);
  return at.toISOString().slice(0, 10);
}

const EVAL_DATE = '2026-01-01';

export const expectedActivityDetector: Detector<DetectorParams> = {
  declaration: {
    id: 'expected_activity_stopped',
    description:
      'Something this hotel does on a rhythm of its own — counting inventory, closing the daily log, logging maintenance — has gone quiet for far longer than it ever does.',
    inputs: ['operating_rhythm'],
    requires: [
      {
        feed: 'operating_rhythm',
        minRecords: MIN_EVENTS,
        because:
          'this hotel has too few counts, daily logs and work orders on record to have a rhythm that could stop',
      },
    ],
    receiptQueryId: RECEIPT,
    defaultDisposition: 'ask',
    defaultSeverity: 'attention',
    // Consenting to a 4-day gap is not consenting to a 12-day one.
    escalation: { factor: 2, minDelta: 3 },
    maxPerRun: 6,
    // If the hotel starts again, the detector stops finding it and the card
    // should go within a couple of days rather than linger as a stale scold.
    staleAfterDays: 3,
    evalCases: [
      {
        name: 'a hotel that counts every 3 days and has not counted in 9 gets one card',
        feeds: {
          operating_rhythm: rhythmFixture(
            [{ id: 'inventory_counts', everyNDays: 3, occurrences: 12, silentDays: 9 }],
            EVAL_DATE,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: ['stopped:inventory_counts'],
        expectMagnitude: { 'stopped:inventory_counts': 9 },
      },
      {
        name: 'a gap the hotel takes all the time is not a finding',
        feeds: {
          operating_rhythm: rhythmFixture(
            [{ id: 'inventory_counts', everyNDays: 3, occurrences: 12, silentDays: 4 }],
            EVAL_DATE,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
      {
        name: 'a hotel that has only ever done it twice has no rhythm to break',
        feeds: {
          operating_rhythm: rhythmFixture(
            [{ id: 'inventory_counts', everyNDays: 3, occurrences: 2, silentDays: 40 }],
            EVAL_DATE,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: [],
      },
      {
        name: 'three streams, and only the one that actually stopped speaks',
        feeds: {
          operating_rhythm: rhythmFixture(
            [
              { id: 'inventory_counts', everyNDays: 3, occurrences: 12, silentDays: 2 },
              {
                id: 'daily_log_closings',
                label: 'closing out the daily log',
                everyNDays: 1,
                occurrences: 40,
                silentDays: 8,
              },
              {
                id: 'work_order_flow',
                label: 'logging maintenance',
                everyNDays: 7,
                occurrences: 10,
                silentDays: 5,
              },
            ],
            EVAL_DATE,
          ),
        },
        businessDate: EVAL_DATE,
        expectKeys: ['stopped:daily_log_closings'],
        expectMagnitude: { 'stopped:daily_log_closings': 8 },
      },
    ],
  },
  detect: detectExpectedActivityStopped,
};

registerDetector(expectedActivityDetector);
