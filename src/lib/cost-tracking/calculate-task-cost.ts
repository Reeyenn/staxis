/**
 * Pure cost-calculation helpers — given a task's start/end + a wage +
 * (optionally) a list of pause events + lunch minutes, return the cents
 * cost of that work.
 *
 * No DB access here. The DB-aware layer (calculate-day-cost.ts) calls
 * these against pre-fetched rows so the math stays testable with
 * arbitrary fixtures.
 *
 * Money is stored and returned in cents to avoid floating-point drift
 * across the hot path: 0.1 + 0.2 !== 0.3 in JS, so working in cents
 * (integer math at every step until division by 60) keeps a 100-task
 * day's total off by less than a cent.
 */

/** One pause interval applied to a cleaning task. */
export interface PauseInterval {
  /** ISO timestamp of when the task was paused. */
  pausedAt: string;
  /**
   * ISO timestamp of when the task was resumed. If null (the housekeeper
   * paused and never resumed), the pause is treated as ongoing up to
   * `now` — but only when the task itself is still in progress.
   * For completed tasks with an unresolved pause, the pause is ignored
   * (likely a stale/never-cleared event).
   */
  resumedAt: string | null;
}

export interface CalculateTaskCostInput {
  /** ISO timestamp of when the task started. */
  startedAt: string | null;
  /**
   * ISO timestamp of when the task completed. NULL for in-progress
   * tasks — in that case we use `now` as the implicit end. The UI's
   * live-cost banner depends on this behavior.
   */
  completedAt: string | null;
  /**
   * Wage in cents/hour. NULL means owner has not set a wage for this
   * housekeeper yet; the result will have wageKnown=false and cents=0
   * so the UI shows "—" instead of $0.00.
   */
  hourlyWageCents: number | null;
  /**
   * Pause events whose intervals overlap the task window. The day
   * aggregator passes in the (paused_at, resumed_at) rows from
   * `room_pause_events` for the staff member; we subtract the overlap
   * between each pause and (startedAt, effectiveEnd) from billable
   * minutes.
   */
  pauseEvents?: PauseInterval[];
  /**
   * Lunch minutes attributed to this task. The day aggregator decides
   * which task carries the lunch deduction — see attributeLunchToTasks
   * in calculate-day-cost.ts. The pure function just subtracts.
   */
  lunchBreakMinutes?: number;
  /**
   * Override for "now" — used by tests and by the live-cost banner that
   * recalculates on a tick.
   */
  now?: Date;
}

export interface CalculatedTaskCost {
  /** Cost in cents. 0 when wage is unknown (caller should render "—"). */
  cents: number;
  /** Active minutes worked, net of pauses and lunch. Floor'd at 0. */
  billableMinutes: number;
  /**
   * False when hourlyWageCents was null at calculation time. The UI
   * uses this to render "—" instead of $0.00.
   */
  wageKnown: boolean;
  /** True when completedAt was null — the cost is a live snapshot. */
  isLive: boolean;
}

/**
 * Minutes between two ISO timestamps, never negative. Returns 0 if
 * either parse fails or the order is reversed — same defensive
 * posture as `aggregate.ts`'s `minutesBetween`.
 */
function minutesBetween(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  const diff = (endMs - startMs) / 60_000;
  return diff > 0 ? diff : 0;
}

/**
 * Compute the active (paused-adjusted) minutes between startedAt and
 * an effective end. Public for the day-cost aggregator and tests.
 */
export function activeMinutes(args: {
  startedAt: string | null;
  /** ISO timestamp OR a Date — null/undefined means "use `now`". */
  completedAt: string | null;
  pauseEvents?: PauseInterval[];
  now?: Date;
}): { minutes: number; effectiveEndMs: number | null } {
  if (!args.startedAt) return { minutes: 0, effectiveEndMs: null };

  const startMs = Date.parse(args.startedAt);
  if (!Number.isFinite(startMs)) return { minutes: 0, effectiveEndMs: null };

  const isLive = args.completedAt === null;
  const now = (args.now ?? new Date()).getTime();
  const endMs = args.completedAt ? Date.parse(args.completedAt) : now;
  if (!Number.isFinite(endMs)) return { minutes: 0, effectiveEndMs: null };
  if (endMs <= startMs) return { minutes: 0, effectiveEndMs: endMs };

  const grossMinutes = minutesBetween(startMs, endMs);

  let pauseMinutes = 0;
  for (const p of args.pauseEvents ?? []) {
    const pStart = Date.parse(p.pausedAt);
    if (!Number.isFinite(pStart)) continue;

    let pEnd: number;
    if (p.resumedAt === null) {
      // Ongoing pause. Only count it for live tasks — for completed
      // tasks with an unresolved pause event, treat the pause row as
      // stale and skip it (the more conservative call: under-count
      // pauses rather than nuke a completed task's billable to 0).
      if (!isLive) continue;
      pEnd = now;
    } else {
      pEnd = Date.parse(p.resumedAt);
      if (!Number.isFinite(pEnd)) continue;
    }

    // Clip the pause window to the task window. A pause that started
    // before the task or ended after the task only counts for the
    // overlap.
    const overlapStart = Math.max(pStart, startMs);
    const overlapEnd = Math.min(pEnd, endMs);
    if (overlapEnd <= overlapStart) continue;
    pauseMinutes += minutesBetween(overlapStart, overlapEnd);
  }

  const active = grossMinutes - pauseMinutes;
  return {
    minutes: active > 0 ? active : 0,
    effectiveEndMs: endMs,
  };
}

/**
 * Compute the cost for one task.
 *
 * Algorithm:
 *   1. Compute active minutes (gross − pauses).
 *   2. Subtract lunchBreakMinutes (caller has already attributed lunch
 *      to this task).
 *   3. If wage is null → cents=0, wageKnown=false. UI shows "—".
 *   4. Otherwise → cents = round(billableMinutes × wageCents / 60).
 *
 * Round at the end (after the multiply, not after the divide) so a
 * 12.5-minute clean at $15/hr doesn't lose a half-cent per task.
 */
export function calculateTaskCost(input: CalculateTaskCostInput): CalculatedTaskCost {
  const isLive = input.completedAt === null;
  const { minutes: activeMins } = activeMinutes({
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    pauseEvents: input.pauseEvents,
    now: input.now,
  });

  const lunch = Math.max(0, input.lunchBreakMinutes ?? 0);
  const billableMinutes = Math.max(0, activeMins - lunch);

  const wageKnown =
    input.hourlyWageCents !== null
    && input.hourlyWageCents !== undefined
    && Number.isFinite(input.hourlyWageCents)
    && input.hourlyWageCents >= 0;

  if (!wageKnown) {
    return { cents: 0, billableMinutes, wageKnown: false, isLive };
  }

  // hourlyWageCents is guaranteed finite + non-negative by the check above.
  const wage = input.hourlyWageCents as number;
  // billableMinutes × (wage / 60) — multiply first, divide last, round
  // to integer cents at the very end. Floor at 0 (negative would only
  // arise from a negative wage we already rejected).
  const cents = Math.max(0, Math.round((billableMinutes * wage) / 60));

  return { cents, billableMinutes, wageKnown: true, isLive };
}
