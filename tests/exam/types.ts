// ─── The practice exam: what a labelled hotel-day IS ─────────────────────────
//
// Before this, "the detectors work" was provable only by shipping and waiting.
// A threshold nudged by one digit, a like-for-like control quietly dropped, a
// dedupe key that started carrying the measurement — none of those break a
// build, and all of them are only visible weeks later as a manager who stopped
// reading the cards.
//
// So: a frozen corpus of hotel-days where the ground truth is KNOWN. Each day
// is a deterministic seed script plus a label saying what MUST be found, what
// MUST NOT be, and WHY. The grader builds the day, runs the real runner over
// it, and scores recall (did it still catch everything) and precision (did it
// invent anything).
//
// THREE RULES THE SHAPE ENFORCES
//
//  1. `expect` is the COMPLETE set of findings a day may produce. Not "these
//     among others" — these, and nothing else. A detector that starts firing on
//     a day it has no business firing on is a precision failure by construction,
//     with no separate list to remember to update.
//
//  2. `silent` names the detectors whose data IS present and busy on this day
//     and which must say nothing anyway. That is the difference between a day
//     that proves something and a day that is merely empty: a hard negative is
//     only a hard negative if the detector had every opportunity to be wrong.
//
//  3. Every label carries a `why` in one line of plain English. The corpus is
//     the documentation for what these detectors actually promise; a label
//     nobody can read is a label nobody will maintain.
//
// The labels live beside their seed on purpose. Two files drift; one cannot.

import type { PGlite } from '@electric-sql/pglite';

import type {
  FindingDisposition,
  FindingSeverity,
  FindingTargetKind,
} from '@/lib/findings/types';

/** What a day is testing. Drives the coverage ratchet in ./index.ts. */
export type ExamKind =
  /** The pattern is unmistakably present. MUST fire. */
  | 'clean_positive'
  /** Busy, realistic, pattern absent. MUST NOT fire. */
  | 'clean_negative'
  /** The one that costs trust: a hotel whose "spike" is its own habit, a hotel
   *  too new to have a normal, a look-alike. MUST NOT fire. */
  | 'hard_negative'
  /** Barely over the line. MUST fire. */
  | 'edge_positive'
  /** Barely under it. MUST NOT fire. */
  | 'edge_negative'
  /** The ledger's own behaviour: dedupe, escalation, a silenced problem. */
  | 'silencer'
  /** Not enough data to speak. MUST be reported as a SKIP with a reason —
   *  never as silence, which reads as a clean bill of health. */
  | 'honest_skip';

/** Bounds a stored price range must land inside. Inclusive. */
export interface PriceLabel {
  lowCents: readonly [number, number];
  highCents: readonly [number, number];
  /** The basis line a manager would check the claim against. */
  basisMatches: RegExp;
}

/** One finding a day MUST produce, and everything about it worth pinning. */
export interface ExpectedFinding {
  detectorId: string;
  /** The DRAFT key, without the detector prefix the runner adds. */
  key: string;
  /** One line: why this is the right answer for this hotel-day. */
  why: string;
  /** Inclusive bounds on `magnitude`. A range, not a number, because the
   *  arithmetic is float and a corpus that pinned exact bits would fail on a
   *  rounding change that harmed nobody. */
  magnitude: readonly [number, number];
  disposition?: FindingDisposition;
  severity?: FindingSeverity;
  /** The thing the finding is about, as a screen would look it up. `null`
   *  asserts the finding is about the HOTEL and carries no target. */
  target?: { kind: FindingTargetKind; value: string } | null;
  /** A real range with these bounds, or 'none' — the finding must carry no
   *  dollar figure at all. Omit to say nothing about money either way. */
  price?: PriceLabel | 'none';
  /** `evidence.values.price_basis` — the sentence that explains the number, or
   *  explains its absence. */
  priceBasisMatches?: RegExp;
  summaryMatches?: RegExp;
  /** The fix Staxis offered, by kind — or 'none' for a card with no button. */
  action?: { kind: string } | 'none';
}

/** A detector that had every chance to fire on this day and must not. */
export interface SilentDetector {
  detectorId: string;
  why: string;
}

/** A detector the runner must report as skipped, with the reason it gives. */
export interface SkippedDetector {
  detectorId: string;
  becauseMatches: RegExp;
  why: string;
}

/** A second night on the same hotel: change the world, run again, re-grade. */
export interface SecondNight {
  why: string;
  mutate(ctx: ExamPlanter): Promise<void>;
  /** Between the two runs, do this to the ledger — a manager tapping "known
   *  problem", say. Runs after `mutate`, before the second run. */
  handOfTheManager?(ctx: ExamPlanter): Promise<void>;
  expect: ExpectedFinding[];
  /** Total rows the findings table may hold for this hotel afterwards. The
   *  dedupe assertion: a bigger number tomorrow lands on the same card. */
  maxTotalRows?: number;
}

export interface ExamDay {
  /** Stable, human-quotable: 'exam-07'. Appears in every failure sentence. */
  id: string;
  title: string;
  kind: ExamKind;
  /** The detector this day exists to grade. */
  detector: string;
  /** One line. The label file is documentation; this is the sentence. */
  why: string;
  timezone?: string;
  /** Section flags for the hotel. Omit for "everything on". */
  enabledSections?: Record<string, boolean> | null;
  seed(ctx: ExamPlanter): Promise<void>;
  /** The COMPLETE set. Anything else the runner writes is an invented finding. */
  expect: ExpectedFinding[];
  silent: SilentDetector[];
  skipped?: SkippedDetector[];
  secondNight?: SecondNight;
}

/**
 * Everything a seed script may touch. A day gets its OWN hotel — which is why
 * a dropped tenant filter does not merely leak on this corpus, it makes every
 * other day's data visible and collapses the whole exam at once.
 */
export interface ExamPlanter {
  readonly pg: PGlite;
  readonly propertyId: string;
  readonly now: Date;
  readonly timezone: string;
  /** The hotel's own calendar today. Every window in the layer hangs off it. */
  readonly businessDate: string;

  /** `businessDate` minus n days, hotel-local. */
  ago(days: number): string;
  /** Midday UTC on a hotel-local date — far from any boundary in either zone. */
  atNoon(date: string): string;
  /** An instant this many minutes before `now`. */
  minutesAgo(minutes: number): string;
  /** A stable inventory-item id for this hotel. */
  itemId(slot?: number): string;

  item(spec: { slot?: number; name?: string; unit?: string; reorderAt?: number | null; reorderLeadDays?: number | null }): Promise<string>;
  supplyDelivery(spec: { date: string; cents?: number; itemSlot?: number; quantity?: number; unitCostCents?: number }): Promise<void>;
  workOrder(spec: { date: string; location?: string; status?: string; repairCostCents?: number | null }): Promise<void>;
  count(spec: { date: string; itemSlot?: number; stock: number; varianceValueCents?: number | null }): Promise<void>;
  discard(spec: { date: string; itemSlot?: number; quantity: number }): Promise<void>;
  dailyLog(date: string): Promise<void>;
  complaint(spec: { date: string; room: string; category: string; severity?: string }): Promise<void>;
  inspection(spec: { date: string; room: string; result: string }): Promise<void>;
  cleaningEvent(spec: { date: string; room: string; minutes: number }): Promise<void>;
  pmsWorkOrder(spec: { date: string; room: string; category: string }): Promise<void>;
  pmsRoom(spec: { room: string; roomType?: string; isSuite?: boolean }): Promise<void>;
  pmsReservation(spec: {
    room: string;
    arrivalDate: string;
    departureDate: string;
    status?: string;
    notes?: string | null;
  }): Promise<void>;
  hkAssignment(spec: {
    room: string;
    date?: string;
    cleaningType?: string;
    startedMinutesAgo?: number | null;
    completed?: boolean;
  }): Promise<void>;
  roomStatus(spec: { room: string; status: string; changedAt?: string }): Promise<void>;
}
