// ─── The corpus, and the ratchet that makes it grow ──────────────────────────
//
// THE DOCTRINE, IN ONE LINE: no detector without its exam.
//
// The exam is only worth running if it cannot quietly stop covering things. So
// the suite ENUMERATES the live registry and refuses to pass when a registered
// detector has no days — adding a detector without adding its exam fails the
// build, in the same commit, on the machine of whoever added it. That is what
// makes the library's growth falsifiable rather than merely optimistic.
//
// Every detector needs, at minimum:
//   • one day where the pattern is unmistakably present and it MUST fire
//   • one day where it had every chance and MUST NOT
// and the corpus as a whole wants the other three shapes (hard negative, edge
// either side) wherever the detector has a threshold to be wrong about.
//
// THE ONE WAIVER, AND WHY IT IS NOT A LOOPHOLE
// `cleaning_plan_health` fires on a branch no hotel data can reach — see the
// header of ./days/cleaning-plan-health.ts. A waiver is allowed, and it costs:
// it must name a reason, the detector must still carry negative days, and the
// suite runs that detector's own frozen positive eval case instead. A waiver
// for a detector nobody registered is itself a failure, so the list cannot rot.

import { cleaningPlanHealthDays } from './days/cleaning-plan-health';
import { expectedActivityDays } from './days/expected-activity';
import { inventoryUsageDays } from './days/inventory-usage';
import { operationalPatternDays } from './days/operational-pattern';
import { preventiveDueDays } from './days/preventive-due';
import { repeatRoomWorkOrderDays } from './days/repeat-room-work-orders';
import { roomAttentionDays } from './days/room-attention';
import { supplySpendDays } from './days/supply-spend';
import { workOrderRateDays } from './days/work-order-rate';
import type { ExamDay } from './types';

export const EXAM_DAYS: readonly ExamDay[] = Object.freeze([
  ...supplySpendDays,
  ...workOrderRateDays,
  ...inventoryUsageDays,
  ...expectedActivityDays,
  ...repeatRoomWorkOrderDays,
  ...preventiveDueDays,
  ...operationalPatternDays,
  ...roomAttentionDays,
  ...cleaningPlanHealthDays,
]);

/**
 * Detectors whose FIRING branch cannot be reached from hotel data, with the
 * reason. Each one still owes the corpus its negative days, and the suite
 * proves its positive through the detector's own frozen eval case.
 *
 * Adding an entry here is a claim about the code that a reviewer can check in
 * about a minute. Adding one to dodge writing a seed script is the only way
 * this exam can be cheated, which is why the list is three lines long and in
 * the same file as the doctrine it bends.
 */
export const POSITIVE_UNREACHABLE_FROM_DATA: Readonly<Record<string, string>> = Object.freeze({
  cleaning_plan_health:
    'fires only when the rules engine throws while evaluating one room; every rule and every ' +
    'context builder in src/lib/rules-engine is null-safe, so no arrangement of hotel rows ' +
    'reaches it. Positive graded by the detector\'s own frozen eval case instead.',
});

export interface CoverageGap {
  detectorId: string;
  because: string;
}

/**
 * What the corpus is missing, given the detectors that are actually registered.
 * Empty means the exam still covers the library. Anything else fails the suite.
 */
export function coverageGaps(registeredDetectorIds: readonly string[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const registered = new Set(registeredDetectorIds);

  const daysFor = (id: string) => EXAM_DAYS.filter((day) => day.detector === id);
  const firesFor = (id: string) =>
    EXAM_DAYS.some((day) =>
      [...day.expect, ...(day.secondNight?.expect ?? [])].some((e) => e.detectorId === id),
    );
  const silentFor = (id: string) =>
    EXAM_DAYS.some((day) => day.silent.some((s) => s.detectorId === id));

  for (const id of registeredDetectorIds) {
    if (daysFor(id).length === 0) {
      gaps.push({
        detectorId: id,
        because:
          'has no exam days at all. Every detector ships with its exam — add days to ' +
          'tests/exam/days/ before this one is allowed to speak to a hotel.',
      });
      continue;
    }
    if (!firesFor(id) && !(id in POSITIVE_UNREACHABLE_FROM_DATA)) {
      gaps.push({
        detectorId: id,
        because:
          'has exam days but none where it MUST fire. A detector proven only to stay quiet is ' +
          'a detector proven to be switched off.',
      });
    }
    if (!silentFor(id)) {
      gaps.push({
        detectorId: id,
        because:
          'has no day where it had every chance to fire and had to stay quiet. Recall without ' +
          'precision is a machine that shouts.',
      });
    }
  }

  for (const id of Object.keys(POSITIVE_UNREACHABLE_FROM_DATA)) {
    if (!registered.has(id)) {
      gaps.push({
        detectorId: id,
        because:
          'is waived from needing a firing day but is not registered any more. Delete the ' +
          'waiver — a stale exemption is how a real gap hides.',
      });
    }
  }

  for (const day of EXAM_DAYS) {
    if (!registered.has(day.detector)) {
      gaps.push({
        detectorId: day.detector,
        because: `exam day ${day.id} grades a detector that is not registered.`,
      });
    }
  }

  return gaps;
}

/** Ids must be unique — every failure sentence quotes one. */
export function duplicateDayIds(): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const day of EXAM_DAYS) {
    if (seen.has(day.id)) dupes.push(day.id);
    seen.add(day.id);
  }
  return dupes;
}
