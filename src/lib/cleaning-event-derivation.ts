/**
 * Pure functions for deriving cleaning_event.started_at on the server.
 *
 * 2026-05-07 — Lifted out of /api/housekeeper/room-action so the
 * derivation logic can be unit-tested in isolation. The route file
 * still owns the database lookup of "most recent prior cleaning";
 * this module owns the math that decides which anchor wins.
 *
 * BACKGROUND
 *   Maria's housekeepers chronically skipped the per-room Start tap.
 *   Without it, every Done landed with started_at = completed_at,
 *   duration = 0, and the cleaning_events row was auto-discarded
 *   (under_3min). The Performance tab went blank on day 2 because all
 *   day-2 rows had been discarded silently. We collapsed the per-room
 *   flow to a single Done and started deriving started_at on the server.
 *
 * THE DERIVATION
 *   Anchor priority (most reliable first):
 *     1. The most recent prior cleaning_event by this staff today,
 *        IF the gap to completedAt is plausibly an actual cleaning
 *        (gap >= MIN_PLAUSIBLE_GAP_MIN, gap <= MAX_GAP_MIN). Real
 *        observed wall-clock between Done taps.
 *     2. The shift-start anchor (first room of the day), if it's
 *        within MAX_GAP_MIN of completedAt.
 *     3. Synthetic fallback: completedAt - DEFAULT_DURATION_MIN[type].
 *        Used when nothing else fits — keeps the row out of the
 *        'discarded' bucket so it stays visible in Performance.
 *
 * WHY THE MIN_PLAUSIBLE_GAP_MIN BUMP MATTERS
 *   Without it, batched Done taps (housekeeper finishes 3 rooms then
 *   taps Done × 3 within a few seconds) would all anchor to the
 *   previous Done's completed_at — giving each subsequent row a
 *   sub-second duration and silently discarding it. That's the same
 *   day-2-blank pathology we just fixed, in a different shape.
 *   Treating implausibly-short gaps as "this was actually a batch"
 *   and falling through to synthetic fallback keeps every row visible.
 */

export const MAX_GAP_BETWEEN_CLEANINGS_MS = 4 * 60 * 60 * 1000; // 4h
export const MIN_PLAUSIBLE_GAP_MS = 3 * 60 * 1000;              // 3 min
export const MIN_DURATION_MS = 30 * 1000;                       // 30 s

// Conservative per-room synthetic durations. Picked to slot into the
// 'recorded' band (3–60 min), well clear of the discard thresholds at
// either end. NOT used for the regression model — that one runs on
// shift-level totals.
export const DEFAULT_DURATION_MIN: Record<'checkout' | 'stayover', number> = {
  checkout: 30,
  stayover: 20,
};

export interface DerivationInputs {
  /** ISO timestamp the housekeeper tapped Done. */
  completedAt: string;
  /**
   * The most recent prior cleaning_event.completed_at by this staff
   * today, fetched server-side. Null if there isn't one (first room).
   */
  priorCompletedAt: string | null;
  /**
   * The "Start Shift" anchor saved in the housekeeper's localStorage
   * when they tapped the button. Null if they never tapped it.
   */
  shiftStartedAt: string | null;
  /** 'checkout' or 'stayover' — drives the synthetic fallback. */
  roomType: 'checkout' | 'stayover';
}

/**
 * Decide the canonical started_at for a cleaning_events row, given
 * the candidate anchors. Pure — no I/O, no Date.now().
 *
 * Returned timestamp is always strictly < completedAt (clamped to
 * completedAt - MIN_DURATION_MS) and >= completedAt - MAX_GAP_MS.
 * That keeps the row inside the cleaning_events CHECK constraints
 * and prevents wildly stale values.
 */
export function deriveStartedAtPure(input: DerivationInputs): string {
  const completedAtMs = new Date(input.completedAt).getTime();
  if (!Number.isFinite(completedAtMs)) {
    throw new Error('deriveStartedAtPure: completedAt is not a valid ISO timestamp');
  }

  // 1. Prior cleaning anchor — only if the gap is plausibly an actual cleaning.
  let priorMs: number | null = null;
  if (input.priorCompletedAt) {
    const ms = new Date(input.priorCompletedAt).getTime();
    if (Number.isFinite(ms)) {
      const gapMs = completedAtMs - ms;
      // Plausible-gap test: between MIN_PLAUSIBLE_GAP and MAX_GAP. Anything
      // shorter is a Done-batch (housekeeper tapped multiple Dones in
      // quick succession after finishing a cluster of rooms); we don't
      // want to anchor to it because it would zero-out the duration.
      // Anything longer is an off-shift gap (lunch, end of day, etc.).
      if (gapMs >= MIN_PLAUSIBLE_GAP_MS && gapMs <= MAX_GAP_BETWEEN_CLEANINGS_MS) {
        priorMs = ms;
      }
    }
  }

  // 2. Shift-start anchor — only valid for the FIRST room of the day,
  // and only if it's within MAX_GAP of completedAt.
  let shiftMs: number | null = null;
  if (input.shiftStartedAt) {
    const ms = new Date(input.shiftStartedAt).getTime();
    if (
      Number.isFinite(ms) &&
      ms < completedAtMs &&
      completedAtMs - ms <= MAX_GAP_BETWEEN_CLEANINGS_MS
    ) {
      shiftMs = ms;
    }
  }

  // 3. Synthetic fallback by room type.
  const fallbackMs = completedAtMs - DEFAULT_DURATION_MIN[input.roomType] * 60_000;

  let chosenMs: number;
  if (priorMs !== null) chosenMs = priorMs;
  else if (shiftMs !== null) chosenMs = shiftMs;
  else chosenMs = fallbackMs;

  // Final clamp.
  const minMs = completedAtMs - MAX_GAP_BETWEEN_CLEANINGS_MS;
  const maxMs = completedAtMs - MIN_DURATION_MS;
  chosenMs = Math.max(minMs, Math.min(maxMs, chosenMs));
  return new Date(chosenMs).toISOString();
}
