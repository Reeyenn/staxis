// ─── The sweep's verification language ───────────────────────────────────────
//
// WHAT THIS FILE IS FOR
// The weekly sweep asks a model "what looks odd here that no check flagged?".
// Whatever comes back is a HYPOTHESIS and nothing more. This file is the half
// that decides whether it was true.
//
// TWO RULES SHAPE EVERYTHING BELOW.
//
// 1. THE MODEL AUTHORS NO NUMBERS. Not a threshold, not a window, not a count.
//    A hypothesis is a (check kind, subject) pair drawn from a closed
//    vocabulary the prompt hands it — `weekly_spike` on `supply_spend`,
//    `stream_stopped` on `inventory_counts`. There is no field in the contract
//    where a number could ride in, which is the same enforcement the judge uses
//    and for the same reason: a rule you ask for politely is a rule.
//
// 2. EVERY THRESHOLD IS DERIVED FROM THE TARGET HOTEL'S OWN DATA. The
//    reproducers below call `buildBaseline`, `deviationOf` and `cadenceOf` —
//    the exact primitives the shipped detectors use — so a candidate that gets
//    promoted is expressed in a derivation this codebase already performs at
//    every hotel, rather than in a constant lifted from the hotel that
//    happened to generate it.
//
// WHY THE REPRODUCER NEVER READS THE MODEL'S SENTENCE
// `reproduceHypothesis` takes the check kind and the subject. The model's prose
// is not a parameter. It cannot be talked into agreeing, because it cannot read
// the argument — and a claim that survives that is a claim about the data
// rather than about the phrasing.
//
// WHAT "ALREADY COVERED" MEANS
// Three of the five checks in the vocabulary are exactly what a shipped
// detector already does. They stay in the vocabulary because they are useful
// verification — a model noticing them is a model reading the data correctly —
// but a candidate that reproduces one is recorded as already covered and goes
// no further. Proposing a detector we shipped in Phase 2A would be the sweep
// congratulating itself.

import type { DailySeriesPoint, InventoryUsageHistory, OperatingRhythmHistory, SupplySpendHistory, WorkOrderHistory } from './history';
import type { JsonValue } from './types';
import {
  buildBaseline,
  cadenceOf,
  daysBetween,
  deviationOf,
  robustBaseline,
  weeklyWindows,
} from './detectors/baseline-math';

// ─── The closed vocabulary ───────────────────────────────────────────────────

export const CHECK_KINDS = [
  'stream_stopped',
  'weekly_spike',
  'item_usage_shift',
  'weekday_concentration',
  'variance_growth',
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

/** The two numeric series a weekly check can run against. */
export const SERIES_IDS = ['supply_spend', 'work_orders'] as const;
export type SeriesId = (typeof SERIES_IDS)[number];

/**
 * Which shipped detector already watches this. A candidate that lands on one is
 * a correct observation and a redundant proposal.
 */
export const COVERED_BY: Readonly<Partial<Record<string, string>>> = Object.freeze({
  'stream_stopped': 'expected_activity',
  'weekly_spike:supply_spend': 'supply_spend_baseline',
  'weekly_spike:work_orders': 'work_order_rate_baseline',
  'item_usage_shift': 'inventory_usage_baseline',
});

/**
 * How a threshold is derived — never a number, always a rule expressed over the
 * TARGET hotel's own record. This is the vocabulary a promoted detector is
 * allowed to speak, and it is an enum precisely so a literal cannot be smuggled
 * through it as a string.
 *
 * EVERY NUMBER IN THESE SENTENCES IS SPELLED IN WORDS, and that is not a style
 * choice. A promoted detector's text must survive the flat rule "it contains no
 * digits" (see sweep-promotion.ts), which is the only version of "no literals
 * from the source hotel" that cannot be argued with at review time. Structural
 * constants of the derivation still need saying, so they are said in words; a
 * hotel's own figure could never survive being written that way by accident.
 */
export const THRESHOLD_DERIVATIONS = Object.freeze({
  hotel_weekly_robust_baseline:
    "the hotel's own twelve preceding seven-day windows: its own median, a spread widened " +
    'by its own interdecile range and floored at a fixed fraction of its own median, and ' +
    "only when the week also exceeds the hotel's own recent high",
  hotel_learned_cadence:
    "the hotel's own gaps between these events: twice its own median gap, or one day past " +
    'the longest wait it routinely takes, whichever is longer',
  hotel_weekday_share:
    "the hotel's own share of activity per weekday, compared against its own spread across " +
    'the other weekdays',
  hotel_item_interval_baseline:
    "the item's own earlier count-to-count intervals at this hotel: its own median daily " +
    'rate plus its own spread',
  hotel_spread_over_time:
    "the hotel's own week-to-week spread in the recent half of its record against its own " +
    'spread in the earlier half',
});

export type ThresholdDerivation = keyof typeof THRESHOLD_DERIVATIONS;

// ─── What the model is shown ─────────────────────────────────────────────────

export interface SweepSeriesSummary {
  id: SeriesId;
  label: string;
  unit: 'cents' | 'count';
  /** Complete 7-day totals, oldest first, ending with the week that just ended. */
  weeks: number[];
  /** Days in the window with any activity at all. */
  activeDays: number;
  /** Totals by weekday, Sunday first. */
  byWeekday: number[];
}

export interface SweepStreamSummary {
  id: string;
  label: string;
  events: number;
  daysSinceLast: number | null;
  medianGapDays: number | null;
}

export interface SweepItemSummary {
  /** Opaque handle. The sweep hands this back; it is never rendered anywhere. */
  itemId: string;
  name: string;
  unit: string;
  intervals: number;
  medianDailyRate: number;
  latestDailyRate: number;
}

export interface SweepSummary {
  businessDate: string;
  windowDays: number;
  series: SweepSeriesSummary[];
  streams: SweepStreamSummary[];
  items: SweepItemSummary[];
  /** Per detector: how many findings this hotel currently has open from it. */
  openFindings: Array<{ detectorId: string; open: number }>;
  /** What is already watched, so the model is not asked to rediscover it. */
  watched: Array<{ id: string; description: string }>;
}

/** Every feed the sweep reasons over. One hotel's, and only one hotel's. */
export interface SweepFeeds {
  supplySpend: SupplySpendHistory;
  workOrders: WorkOrderHistory;
  inventory: InventoryUsageHistory;
  rhythm: OperatingRhythmHistory;
}

export interface SweepSummaryInput extends SweepFeeds {
  businessDate: string;
  openFindings: Array<{ detectorId: string; open: number }>;
  watched: Array<{ id: string; description: string }>;
}

/** How many prior 7-day windows every weekly derivation uses. */
export const BASELINE_WEEKS = 12;

/** Items are capped so one hotel with 400 SKUs cannot inflate the prompt. */
const MAX_ITEMS = 8;

const DOW = [0, 1, 2, 3, 4, 5, 6];

/** Weekday of a YYYY-MM-DD, 0 = Sunday. Calendar arithmetic, no zones — the
 *  dates are already hotel-local by the time they reach here. */
function weekdayOf(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return robustBaseline(values).median;
}

function seriesPoints(feeds: SweepFeeds, id: SeriesId): DailySeriesPoint[] {
  return id === 'supply_spend' ? feeds.supplySpend.days : feeds.workOrders.createdPerDay;
}

function seriesCoverage(feeds: SweepFeeds, id: SeriesId): string | null {
  return id === 'supply_spend'
    ? feeds.supplySpend.coverageStartDate
    : feeds.workOrders.coverageStartDate;
}

const SERIES_LABEL: Record<SeriesId, string> = {
  supply_spend: 'what this hotel spends restocking',
  work_orders: 'work orders this hotel opens',
};

const SERIES_UNIT: Record<SeriesId, 'cents' | 'count'> = {
  supply_spend: 'cents',
  work_orders: 'count',
};

/**
 * Aggregate one hotel down to totals, counts and trends.
 *
 * PURE, AND OVER EXACTLY ONE HOTEL'S FEEDS. There is no property id in this
 * function and no way to reach a second hotel's data from inside it, which is
 * how "hotel B's numbers never appear in hotel A's prompt" is a structural
 * property rather than a review checklist item.
 *
 * NO RAW ROWS EVER. Every field below is a total, a count, a median or a date
 * boundary. A guest name, a work-order description or an invoice line cannot
 * appear in the output because none of them are in the input shapes.
 */
export function buildSweepSummary(input: SweepSummaryInput): SweepSummary {
  const series: SweepSeriesSummary[] = SERIES_IDS.map((id) => {
    const points = seriesPoints(input, id);
    const split = weeklyWindows(points, input.businessDate, BASELINE_WEEKS);
    const byWeekday = DOW.map(() => 0);
    for (const point of points) {
      const day = weekdayOf(point.date);
      if (day === null) continue;
      byWeekday[day] += point.value;
    }
    return {
      id,
      label: SERIES_LABEL[id],
      unit: SERIES_UNIT[id],
      // Oldest first, current week last — the order a human reads a trend in.
      weeks: [...split.baseline].reverse().map((w) => Math.round(w.value)).concat(
        Math.round(split.current.value),
      ),
      activeDays: points.filter((p) => p.value !== 0).length,
      byWeekday: byWeekday.map((v) => Math.round(v)),
    };
  });

  const streams: SweepStreamSummary[] = input.rhythm.streams.map((stream) => {
    const unique = [...new Set(stream.dates)].sort();
    const last = unique[unique.length - 1] ?? null;
    const cadence = cadenceOf(stream.dates);
    return {
      id: stream.id,
      label: stream.label,
      events: unique.length,
      daysSinceLast: last ? daysBetween(last, input.businessDate) : null,
      medianGapDays: cadence ? Math.round(cadence.medianGapDays * 10) / 10 : null,
    };
  });

  const items: SweepItemSummary[] = input.inventory.items
    .filter((item) => item.intervals.length >= 2)
    .map((item) => {
      const rates = item.intervals.map((i) => (i.days > 0 ? i.unitsUsed / i.days : 0));
      return {
        itemId: item.itemId,
        name: item.itemName,
        unit: item.unit,
        intervals: item.intervals.length,
        medianDailyRate: Math.round(median(rates) * 100) / 100,
        latestDailyRate: Math.round(rates[rates.length - 1] * 100) / 100,
      };
    })
    .sort((a, b) => b.intervals - a.intervals || (a.itemId < b.itemId ? -1 : 1))
    .slice(0, MAX_ITEMS);

  return {
    businessDate: input.businessDate,
    windowDays: input.supplySpend.windowDays,
    series,
    streams,
    items,
    openFindings: input.openFindings,
    watched: input.watched,
  };
}

// ─── Hypotheses and their verdicts ───────────────────────────────────────────

export interface Hypothesis {
  /** The model's own sentence. Carried for the log; NEVER rendered, and never
   *  read by a reproducer. */
  claim: string;
  check: CheckKind;
  /** A stream id, a series id, or an item id — whichever the check takes. */
  subject: string;
}

export interface Reproduction {
  reproduced: boolean;
  /** Why not, when not. The hypothesis ledger stores this verbatim. */
  reason: string;
  /** The numbers a human can re-check the verdict against. */
  values: Record<string, JsonValue>;
  /** Code-written, from those numbers. What the card would say. */
  basis: string;
  magnitude: number;
  derivation: ThresholdDerivation;
  /** The hotel-specific thing this is about ("bath towels"). Stays local. */
  subjectLabel: string | null;
}

function dead(reason: string, derivation: ThresholdDerivation): Reproduction {
  return { reproduced: false, reason, values: {}, basis: '', magnitude: 0, derivation, subjectLabel: null };
}

/** The threshold every deviation check clears. Robust standard deviations. */
export const DEVIATION_Z = 3;

/**
 * Run the real check. Deterministic, and a function of the hotel's data plus a
 * (kind, subject) pair only.
 *
 * The feeds handed in are a FRESH read, not the snapshot the summary was built
 * from — a claim that only holds against the exact bytes the model saw is a
 * claim about the prompt, not about the hotel.
 */
export function reproduceHypothesis(
  hypothesis: Hypothesis,
  feeds: SweepFeeds,
  businessDate: string,
): Reproduction {
  switch (hypothesis.check) {
    case 'stream_stopped':
      return reproduceStreamStopped(hypothesis.subject, feeds, businessDate);
    case 'weekly_spike':
      return reproduceWeeklySpike(hypothesis.subject, feeds, businessDate);
    case 'weekday_concentration':
      return reproduceWeekdayConcentration(hypothesis.subject, feeds);
    case 'variance_growth':
      return reproduceVarianceGrowth(hypothesis.subject, feeds, businessDate);
    case 'item_usage_shift':
      return reproduceItemUsageShift(hypothesis.subject, feeds);
    default:
      return dead('unknown check kind', 'hotel_weekly_robust_baseline');
  }
}

function reproduceStreamStopped(
  subject: string,
  feeds: SweepFeeds,
  businessDate: string,
): Reproduction {
  const derivation: ThresholdDerivation = 'hotel_learned_cadence';
  const stream = feeds.rhythm.streams.find((s) => s.id === subject);
  if (!stream) return dead(`no stream "${subject}" at this hotel`, derivation);

  const cadence = cadenceOf(stream.dates);
  if (!cadence) {
    return dead('this hotel has no rhythm on record for it to have broken', derivation);
  }
  const unique = [...new Set(stream.dates)].sort();
  const last = unique[unique.length - 1];
  const daysSinceLast = daysBetween(last, businessDate);

  const values: Record<string, JsonValue> = {
    events: cadence.events,
    median_gap_days: Math.round(cadence.medianGapDays * 10) / 10,
    tolerance_days: Math.round(cadence.toleranceDays * 10) / 10,
    days_since_last: daysSinceLast,
  };
  if (daysSinceLast <= cadence.toleranceDays) {
    return {
      ...dead(
        `${daysSinceLast} days since the last one is inside this hotel's own normal wait`,
        derivation,
      ),
      values,
    };
  }
  return {
    reproduced: true,
    reason: '',
    values,
    basis:
      `${daysSinceLast} days since ${stream.label} last happened here, against a typical ` +
      `${Math.round(cadence.medianGapDays * 10) / 10} days`,
    magnitude: daysSinceLast,
    derivation,
    subjectLabel: stream.label,
  };
}

function reproduceWeeklySpike(
  subject: string,
  feeds: SweepFeeds,
  businessDate: string,
): Reproduction {
  const derivation: ThresholdDerivation = 'hotel_weekly_robust_baseline';
  if (!(SERIES_IDS as readonly string[]).includes(subject)) {
    return dead(`no series "${subject}"`, derivation);
  }
  const id = subject as SeriesId;
  const gate = buildBaseline(
    seriesPoints(feeds, id),
    businessDate,
    seriesCoverage(feeds, id),
    { baselineWeeks: BASELINE_WEEKS, minNonZeroWindows: 6, subject: SERIES_LABEL[id] },
  );
  if (!gate.ok) return dead(gate.because, derivation);

  const dev = deviationOf(gate.split.current.value, gate.baseline);
  const values: Record<string, JsonValue> = {
    week_value: Math.round(gate.split.current.value),
    hotel_median_week: Math.round(gate.baseline.median),
    hotel_routine_high: Math.round(gate.baseline.p90),
    z: Math.round(dev.z * 100) / 100,
  };
  if (!(dev.z >= DEVIATION_Z && dev.aboveRoutineHigh)) {
    return {
      ...dead("the week sits inside what this hotel's own weeks routinely do", derivation),
      values,
    };
  }
  return {
    reproduced: true,
    reason: '',
    values,
    basis:
      `the week that just ended is ${Math.round(dev.z * 10) / 10} times this hotel's own ` +
      `spread above its own median week, and above its own recent high`,
    magnitude: Math.round(dev.z * 100) / 100,
    derivation,
    subjectLabel: SERIES_LABEL[id],
  };
}

/** Fewest events before a weekday pattern can be anything but coincidence. */
const MIN_WEEKDAY_EVENTS = 14;

function reproduceWeekdayConcentration(subject: string, feeds: SweepFeeds): Reproduction {
  const derivation: ThresholdDerivation = 'hotel_weekday_share';
  if (!(SERIES_IDS as readonly string[]).includes(subject)) {
    return dead(`no series "${subject}"`, derivation);
  }
  const id = subject as SeriesId;
  const points = seriesPoints(feeds, id);

  const byWeekday = DOW.map(() => 0);
  let total = 0;
  let events = 0;
  for (const point of points) {
    const day = weekdayOf(point.date);
    if (day === null || point.value === 0) continue;
    byWeekday[day] += point.value;
    total += point.value;
    events += 1;
  }
  if (events < MIN_WEEKDAY_EVENTS || total <= 0) {
    return dead(
      `only ${events} active days on record — too few for a weekday pattern to mean anything`,
      derivation,
    );
  }
  const activeWeekdays = byWeekday.filter((v) => v > 0).length;
  if (activeWeekdays < 3) {
    return dead(
      `activity falls on only ${activeWeekdays} weekday(s) — that is the hotel's schedule, not a pattern`,
      derivation,
    );
  }

  const shares = byWeekday.map((v) => v / total);
  const topShare = Math.max(...shares);
  const topDay = shares.indexOf(topShare);
  const baseline = robustBaseline(shares);
  const dev = deviationOf(topShare, baseline);

  const values: Record<string, JsonValue> = {
    weekday: topDay,
    weekday_share_pct: Math.round(topShare * 1000) / 10,
    typical_weekday_share_pct: Math.round(baseline.median * 1000) / 10,
    active_days: events,
    z: Math.round(dev.z * 100) / 100,
  };
  if (!(dev.z >= DEVIATION_Z && topShare >= 0.4)) {
    return { ...dead('no single weekday stands out from the others here', derivation), values };
  }
  return {
    reproduced: true,
    reason: '',
    values,
    basis:
      `${Math.round(topShare * 1000) / 10}% of it lands on one weekday, against a typical ` +
      `${Math.round(baseline.median * 1000) / 10}% for the others`,
    magnitude: Math.round(topShare * 1000) / 10,
    derivation,
    subjectLabel: SERIES_LABEL[id],
  };
}

/** Half the baseline each side. Fewer than this and "spread" is noise. */
const VARIANCE_HALF_WEEKS = 6;

function reproduceVarianceGrowth(
  subject: string,
  feeds: SweepFeeds,
  businessDate: string,
): Reproduction {
  const derivation: ThresholdDerivation = 'hotel_spread_over_time';
  if (!(SERIES_IDS as readonly string[]).includes(subject)) {
    return dead(`no series "${subject}"`, derivation);
  }
  const id = subject as SeriesId;
  const coverage = seriesCoverage(feeds, id);
  const split = weeklyWindows(seriesPoints(feeds, id), businessDate, BASELINE_WEEKS);
  if (!coverage || coverage > split.baselineStartDate) {
    return dead(
      `this hotel's record does not go back the ${BASELINE_WEEKS} weeks a spread comparison needs`,
      derivation,
    );
  }

  // newest first out of weeklyWindows; take the recent half and the earlier half.
  const values12 = split.baseline.map((w) => w.value);
  const recent = [split.current.value, ...values12.slice(0, VARIANCE_HALF_WEEKS - 1)];
  const earlier = values12.slice(VARIANCE_HALF_WEEKS - 1, VARIANCE_HALF_WEEKS * 2 - 1);
  if (earlier.length < VARIANCE_HALF_WEEKS - 1) {
    return dead('not enough complete weeks on both sides to compare spreads', derivation);
  }

  const recentSpread = robustBaseline(recent).scaledMad;
  const earlierSpread = robustBaseline(earlier).scaledMad;
  const recentMedian = robustBaseline(recent).median;

  const out: Record<string, JsonValue> = {
    recent_spread: Math.round(recentSpread),
    earlier_spread: Math.round(earlierSpread),
    recent_median: Math.round(recentMedian),
  };
  if (earlierSpread <= 0 || recentMedian <= 0) {
    return {
      ...dead('this hotel had no steady baseline to have become less steady than', derivation),
      values: out,
    };
  }
  const ratio = recentSpread / earlierSpread;
  out.ratio = Math.round(ratio * 100) / 100;
  // Twice as jumpy AND the jumpiness is a real fraction of the hotel's own
  // level — a series that wobbles by a rounding error is not unstable.
  if (!(ratio >= 2 && recentSpread >= 0.25 * recentMedian)) {
    return { ...dead('week-to-week movement here is no larger than it used to be', derivation), values: out };
  }
  return {
    reproduced: true,
    reason: '',
    values: out,
    basis:
      `week-to-week movement is ${Math.round(ratio * 10) / 10} times what it was earlier in ` +
      "this hotel's own record",
    magnitude: Math.round(ratio * 100) / 100,
    derivation,
    subjectLabel: SERIES_LABEL[id],
  };
}

/** Fewest earlier intervals before an item's own normal rate exists. */
const MIN_ITEM_INTERVALS = 6;

function reproduceItemUsageShift(subject: string, feeds: SweepFeeds): Reproduction {
  const derivation: ThresholdDerivation = 'hotel_item_interval_baseline';
  const item = feeds.inventory.items.find((i) => i.itemId === subject);
  if (!item) return dead('no such item at this hotel', derivation);

  const rates = item.intervals.map((i) => (i.days > 0 ? i.unitsUsed / i.days : 0));
  if (rates.length < MIN_ITEM_INTERVALS + 1) {
    return dead(
      `only ${rates.length} counted intervals for it — too few for the item to have a normal`,
      derivation,
    );
  }
  const latest = rates[rates.length - 1];
  const baseline = robustBaseline(rates.slice(0, -1));
  const dev = deviationOf(latest, baseline);

  const values: Record<string, JsonValue> = {
    latest_daily_rate: Math.round(latest * 100) / 100,
    typical_daily_rate: Math.round(baseline.median * 100) / 100,
    intervals: rates.length,
    z: Math.round(dev.z * 100) / 100,
  };
  if (!(dev.z >= DEVIATION_Z && dev.aboveRoutineHigh)) {
    return { ...dead("the item is moving at its own usual rate here", derivation), values };
  }
  return {
    reproduced: true,
    reason: '',
    values,
    basis:
      `it is moving at ${Math.round(latest * 100) / 100} a day against its own usual ` +
      `${Math.round(baseline.median * 100) / 100}`,
    magnitude: Math.round(dev.z * 100) / 100,
    derivation,
    subjectLabel: item.itemName,
  };
}

// ─── Candidate identity ──────────────────────────────────────────────────────

/**
 * The PROPERTY-AGNOSTIC identity of a candidate.
 *
 * This string is written to `finding_sweep_runs.signatures` and compared across
 * hotels, so it must contain nothing that belongs to one of them. Checks whose
 * subject is a Staxis-defined series or stream keep it; the one whose subject is
 * an item id collapses to `any_item`, because an item id IS that hotel's data
 * and two hotels noticing the same thing about different items is exactly the
 * agreement we are trying to count.
 */
export function candidateSignature(check: CheckKind, subject: string): string {
  if (check === 'item_usage_shift') return `${check}:any_item`;
  return `${check}:${subject}`;
}

/** The shipped detector that already does this, if any. */
export function coveredBy(check: CheckKind, subject: string): string | null {
  return COVERED_BY[`${check}:${subject}`] ?? COVERED_BY[check] ?? null;
}
