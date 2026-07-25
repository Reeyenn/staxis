// ─── Baseline and cadence math ───────────────────────────────────────────────
//
// The arithmetic behind "unusual for THIS hotel" and "this stopped". Pure, no
// clock, no database, no model — a manager who asks "why did it say that?" gets
// an answer made of their own numbers, and the same inputs give the same answer
// every night. An LLM at this layer would flag a thing on Monday and miss the
// identical thing on Tuesday, and a manager experiences inconsistency as lying.
//
// WHAT "LIKE WITH LIKE" MEANS HERE
// Every window is exactly 7 calendar days, so every window contains exactly one
// Monday, one Tuesday and so on. A hotel that gets its deliveries on Thursdays
// and does its deep cleans on Sundays is therefore never compared against a
// window with two Thursdays in it. That is the whole of the seasonality
// handling: weekday mix, and nothing else. Annual seasonality, holidays, local
// events and shoulder-season occupancy are NOT modelled — twelve weeks of
// history cannot see a year, and pretending otherwise would be the same lie in
// a different coat.
//
// WHY MEDIAN AND MAD RATHER THAN MEAN AND STANDARD DEVIATION
// One genuinely strange week — a mattress order, a burst pipe — moves a mean
// and inflates a standard deviation, which is exactly backwards: the outlier
// teaches the detector to ignore outliers. The median barely moves and the MAD
// barely widens, so next week's outlier is still an outlier.

import { addDaysInTz } from '@/lib/schedule/local-date';

import { percentile } from '../pricing';
import type { DailySeriesPoint } from '../history';

/** Consistency between the MAD and a standard deviation for normal data. */
const MAD_TO_SIGMA = 1.4826;

// ─── Weekly windows ──────────────────────────────────────────────────────────

export interface WeekWindow {
  /** First day INCLUDED, hotel-local. */
  startDate: string;
  /** Last day INCLUDED, hotel-local. */
  endDate: string;
  /** Sum of the series over those 7 days. Missing days count as zero. */
  value: number;
}

export interface WeeklySplit {
  /** The 7 complete days ending yesterday. What we are judging. */
  current: WeekWindow;
  /** The consecutive 7-day windows before it, newest first. */
  baseline: WeekWindow[];
  /** First day of the OLDEST baseline window — the history this needs. */
  baselineStartDate: string;
}

/**
 * Cut a daily series into the current week and the weeks before it.
 *
 * The current window ends YESTERDAY, never today: a detector that runs at 3am
 * and compares a two-hour-old partial day against seven full ones would call
 * every hotel quiet every morning.
 */
export function weeklyWindows(
  points: readonly DailySeriesPoint[],
  businessDate: string,
  baselineWeeks: number,
): WeeklySplit {
  const byDate = new Map<string, number>();
  for (const point of points) {
    byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.value);
  }

  const window = (endOffset: number): WeekWindow => {
    const endDate = addDaysInTz(businessDate, endOffset);
    const startDate = addDaysInTz(endDate, -6);
    let value = 0;
    for (let i = 0; i < 7; i += 1) value += byDate.get(addDaysInTz(startDate, i)) ?? 0;
    return { startDate, endDate, value };
  };

  const current = window(-1);
  const baseline: WeekWindow[] = [];
  for (let week = 1; week <= baselineWeeks; week += 1) baseline.push(window(-1 - 7 * week));

  return {
    current,
    baseline,
    baselineStartDate: baseline[baseline.length - 1]?.startDate ?? current.startDate,
  };
}

// ─── The baseline itself ─────────────────────────────────────────────────────

export interface Baseline {
  n: number;
  median: number;
  /** 20% trimmed mean. Recorded in the receipt as a second, checkable centre. */
  trimmedMean: number;
  mad: number;
  /** MAD scaled to be comparable with a standard deviation. */
  scaledMad: number;
  p10: number;
  p25: number;
  p75: number;
  /** The high end of what this hotel routinely does. The lie-detector below. */
  p90: number;
  /** How many baseline windows were non-zero. A rhythm, or the lack of one. */
  nonZeroWindows: number;
}

/** Interdecile range → standard deviation, for normally distributed data. */
const INTERDECILE_TO_SIGMA = 2.563;

export function robustBaseline(values: readonly number[]): Baseline {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return {
      n: 0, median: 0, trimmedMean: 0, mad: 0, scaledMad: 0,
      p10: 0, p25: 0, p75: 0, p90: 0, nonZeroWindows: 0,
    };
  }

  const median = percentile(sorted, 0.5);
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = percentile(deviations, 0.5);

  const trim = Math.floor(n * 0.2);
  const kept = n - 2 * trim > 0 ? sorted.slice(trim, n - trim) : sorted;
  const trimmedMean = kept.reduce((a, b) => a + b, 0) / kept.length;

  return {
    n,
    median,
    trimmedMean,
    mad,
    scaledMad: mad * MAD_TO_SIGMA,
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    nonZeroWindows: sorted.filter((v) => v !== 0).length,
  };
}

export interface Deviation {
  /** How far outside normal, in robust standard deviations. */
  z: number;
  /** The spread the z was measured against, and where it came from. */
  spread: number;
  /** False when this hotel has had weeks like this recently. */
  aboveRoutineHigh: boolean;
}

/**
 * How unusual this week is FOR THIS HOTEL.
 *
 * Three things widen the spread, and each of them exists because of a specific
 * way the naive version lies:
 *
 *  • the scaled MAD — the ordinary robust spread;
 *  • the interdecile range — because the MAD is BLIND TO A BIMODAL HABIT. A
 *    hotel that places a bulk order every fourth week has nine quiet windows
 *    and three big ones; nine identical quiet windows drive the MAD to zero and
 *    every bulk week then scores as a wild anomaly. The interdecile range sees
 *    both humps and refuses to call the habit an accident;
 *  • 15% of the hotel's own median — because a claim to know a hotel's normal
 *    to better than 15% is a claim nobody can support, and "technically an
 *    outlier" alerts are how a watcher teaches managers to stop reading it.
 *
 * `aboveRoutineHigh` is the plainest guard of the three and the one a manager
 * would recognise: if this week is no bigger than the high end of their own
 * recent weeks, the hotel has DEMONSTRATED that weeks like this happen here,
 * and there is nothing to report. A caller must require it.
 */
export function deviationOf(
  current: number,
  baseline: Baseline,
  floorFraction = 0.15,
): Deviation {
  const spread = Math.max(
    baseline.scaledMad,
    (baseline.p90 - baseline.p10) / INTERDECILE_TO_SIGMA,
    floorFraction * Math.abs(baseline.median),
  );
  return {
    z: spread > 0 ? (current - baseline.median) / spread : 0,
    spread,
    aboveRoutineHigh: current > baseline.p90,
  };
}

/** Why a baseline was refused. Surfaced so silence is explainable, not blank. */
export type BaselineRefusal =
  | { ok: false; because: string }
  | { ok: true; split: WeeklySplit; baseline: Baseline };

export interface BaselineGate {
  /** How many complete weeks before the current one to compare against. */
  baselineWeeks: number;
  /** Fewest of those windows that must be non-zero to call it a rhythm. */
  minNonZeroWindows: number;
  /** What the series is, for the refusal sentence: "supply deliveries". */
  subject: string;
}

/**
 * Build a baseline, or refuse and say why.
 *
 * TWO REFUSALS, BOTH OF THEM THE POINT:
 *
 *  1. The hotel has not been recording this long enough. A two-week-old hotel
 *     has no normal; guessing one would mean its first delivery is an anomaly.
 *  2. The hotel records this too sporadically for "normal" to mean anything.
 *     A hotel that orders once a month has ten empty windows and two full
 *     ones; every ordering week would clear any threshold you like, forever.
 *     This is the single biggest false-positive source in the whole design.
 */
export function buildBaseline(
  points: readonly DailySeriesPoint[],
  businessDate: string,
  coverageStartDate: string | null,
  gate: BaselineGate,
): BaselineRefusal {
  const split = weeklyWindows(points, businessDate, gate.baselineWeeks);

  if (!coverageStartDate || coverageStartDate > split.baselineStartDate) {
    return {
      ok: false,
      because:
        `this hotel's ${gate.subject} only go back to ` +
        `${coverageStartDate ?? 'no record at all'}, so there is no ${gate.baselineWeeks}-week ` +
        'normal to compare against yet',
    };
  }

  const baseline = robustBaseline(split.baseline.map((w) => w.value));
  if (baseline.nonZeroWindows < gate.minNonZeroWindows) {
    return {
      ok: false,
      because:
        `only ${baseline.nonZeroWindows} of the last ${gate.baselineWeeks} weeks had any ` +
        `${gate.subject} at all — too sporadic for "normal" to mean anything here`,
    };
  }

  return { ok: true, split, baseline };
}

// ─── Cadence: what this hotel's rhythm actually is ───────────────────────────

export interface Cadence {
  events: number;
  /** Typical wait between two of them, in days. Never below 1. */
  medianGapDays: number;
  /** The long-but-normal wait. The hotel has done this and it was fine. */
  p90GapDays: number;
  /** Silence beyond this is a genuine break in the pattern. */
  toleranceDays: number;
}

/**
 * Learn a hotel's rhythm from its own dates, or return null.
 *
 * Null is the honest answer far more often than it looks: a hotel that counted
 * inventory twice ever has no rhythm to break, and the correct behaviour is
 * silence, not a card claiming they are overdue against a cadence we invented.
 *
 * The tolerance is the larger of twice the typical gap and one day past the
 * longest wait they routinely take. The second term is the false-positive
 * guard: a hotel whose counts sometimes slip nine days has demonstrated that
 * nine days is survivable there, and telling them about it on day eight is how
 * a watcher becomes noise.
 */
export function cadenceOf(
  dates: readonly string[],
  opts: { minEvents?: number; minToleranceDays?: number } = {},
): Cadence | null {
  const minEvents = opts.minEvents ?? 6;
  const minToleranceDays = opts.minToleranceDays ?? 3;

  const unique = [...new Set(dates)].sort();
  if (unique.length < minEvents) return null;

  const gaps: number[] = [];
  for (let i = 1; i < unique.length; i += 1) gaps.push(daysBetween(unique[i - 1], unique[i]));
  if (gaps.length < minEvents - 1) return null;

  const sorted = [...gaps].sort((a, b) => a - b);
  const medianGapDays = Math.max(1, percentile(sorted, 0.5));
  const p90GapDays = percentile(sorted, 0.9);

  return {
    events: unique.length,
    medianGapDays,
    p90GapDays,
    toleranceDays: Math.max(2 * medianGapDays, p90GapDays + 1, minToleranceDays),
  };
}

/** Whole days from one YYYY-MM-DD to another. Calendar arithmetic, no zones. */
export function daysBetween(from: string, to: string): number {
  const parse = (value: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) throw new Error(`Invalid YYYY-MM-DD: ${value}`);
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}
