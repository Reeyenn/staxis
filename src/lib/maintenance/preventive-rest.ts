// ═══════════════════════════════════════════════════════════════════════════
// When an upkeep schedule is allowed to be quiet, and for how long.
//
// A preventive schedule has two ways of going quiet that are not "it got done",
// and BOTH of them now have two readers: the nightly detector that writes the
// due card (findings/detectors/preventive-due.ts) and the Staxis list that
// carries the schedule as a row (worklist/core.ts). Before this file the
// detector knew about the first one and the list knew about neither, so
// "Somebody's been called" silenced the card and left the row sitting there.
// Two readers with two copies of a seven is how a rest ends up half applied.
//
//   called    somebody has been called out. Quiet for a week, then it comes
//             back ONCE to ask whether it happened.
//   skipped   this occurrence has been put down without the work being done.
//             Quiet for one full cadence, then it comes back as the ordinary
//             due card with its real lateness intact.
//
// NEITHER touches `last_completed_at`. A rest is not a completion, and a system
// that recorded one as the other would restart the clock on a job nobody
// performed and then stay silent for a full cadence about it.
//
// Pure and dependency-free on purpose: the detector reasons in hotel-local
// calendar dates and the list reasons in instants, so they cannot share one
// comparison, but they must share the two windows or they will drift.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How long a "somebody has been called" rest lasts before Staxis asks whether
 * the work actually happened.
 *
 * SEVEN DAYS, and the founder's own words set the bar: a reminder, not a nag.
 * The window has to clear the realistic time for an arranged vendor to turn up
 * (a plumber booked on Monday is not late on Tuesday) while staying short
 * enough that the question still lands as "did that happen?" rather than as an
 * audit of something everyone has forgotten. Each tap re-arms it.
 */
export const PREVENTIVE_FOLLOW_UP_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * How long a "Skip this one" rest lasts: ONE FULL CADENCE from the skip.
 *
 * Deliberately not "until the next scheduled occurrence". A schedule 200 days
 * late on a 30-day cadence would come straight back under that rule, and a
 * person who just said "not this one" would read that as the button having done
 * nothing.
 *
 * It is also what makes the flag self-expiring, which is why no trigger has to
 * clear it: if the work is later done at time C, the next due date is
 * C + frequencyDays, and C is after the skip, so the rest window has always
 * closed by the time the schedule is due again. See migration 0462.
 */
export function preventiveSkipRestDays(frequencyDays: number): number {
  // A cadence the database could not have stored (0, negative, NaN) still has
  // to produce a finite rest rather than an instant one or an eternal one.
  return Number.isFinite(frequencyDays) && frequencyDays >= 1 ? Math.round(frequencyDays) : 1;
}

/** Which rest, if any, a schedule is inside right now. */
export type PreventiveRest = 'called' | 'skipped' | null;

export interface PreventiveRestInput {
  /** `preventive_tasks.called_at`, as stored. */
  calledAt: string | null;
  /** `preventive_tasks.skipped_at`, as stored. Absent on rows written before 0462. */
  skippedAt?: string | null;
  frequencyDays: number;
  /** The instant to judge against, in ms. */
  nowMs: number;
}

/**
 * Is this schedule resting, and on which of the two grounds?
 *
 * SKIPPED IS CHECKED FIRST. In practice the two never co-exist (each write
 * clears the other, because a skipped occurrence retires the follow-up about
 * the call and a fresh call is not a skip), but a row written by psql or by an
 * older build could carry both, and a rule with no fixed order is a rule that
 * gives two answers.
 *
 * A rest date in the FUTURE is not a rest anybody asked for and is ignored:
 * both columns carry a not-future CHECK (0366, 0462), so this is the belt to
 * those braces rather than a state that should ever be reachable.
 */
export function preventiveRestOf(input: PreventiveRestInput): PreventiveRest {
  const { nowMs } = input;

  const skipped = parseInstant(input.skippedAt ?? null);
  if (skipped !== null && skipped <= nowMs) {
    if (nowMs < skipped + preventiveSkipRestDays(input.frequencyDays) * DAY_MS) return 'skipped';
  }

  const called = parseInstant(input.calledAt);
  if (called !== null && called <= nowMs) {
    if (nowMs < called + PREVENTIVE_FOLLOW_UP_DAYS * DAY_MS) return 'called';
  }

  return null;
}

function parseInstant(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
