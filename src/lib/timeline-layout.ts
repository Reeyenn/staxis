/**
 * Pure positioning math for the housekeeping Timeline view.
 *
 * Kept in src/lib (not in _components/) so it can be imported and
 * unit-tested with node:test without pulling in React. The TimelineView
 * component wraps these helpers in JSX.
 *
 * Coordinate system:
 *   The timeline X axis is measured in PIXELS from the left edge of the
 *   plot area (after the row-header gutter). One MINUTE on the wall
 *   clock maps to `pxPerMinute` pixels. So a task that starts 30
 *   minutes into the shift sits at x = 30 * pxPerMinute, and a 45-min
 *   task spans 45 * pxPerMinute pixels wide.
 *
 * Lane layout (`layoutLane`):
 *   Given a sorted queue of tasks for one housekeeper, derive a
 *   wall-clock start/end for each card by simulating the day forward:
 *     - completed task: anchored at its real started_at, ends at
 *       real completed_at (so the bar's WIDTH reflects how long the
 *       clean actually took, not the estimate)
 *     - in-progress task: starts at started_at, ends at started_at +
 *       estimated_minutes (the engine's best guess for now-line math)
 *     - scheduled task: starts at max(prior_end, shift_start), runs
 *       for estimated_minutes
 *   Anchoring on real timestamps keeps the timeline honest even when
 *   the engine's schedule has slipped — the manager sees "Maria
 *   started this 18 minutes late" rather than a clean column that
 *   doesn't match what's on the floor.
 */

export interface LayoutTaskInput {
  id: string;
  queue_order: number;
  estimated_minutes_resolved: number;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface LayoutTaskOutput extends LayoutTaskInput {
  /** Wall-clock UTC ms when this card starts. */
  start_ms: number;
  /** Wall-clock UTC ms when this card ends. */
  end_ms: number;
  /** Pixels from the left edge of the plot area. */
  x: number;
  /** Pixel width of the card. Always >= MIN_CARD_WIDTH_PX. */
  width: number;
  /** For in-progress tasks: 0..1 fraction of estimated minutes elapsed,
   *  clipped to 1. NULL for not-started / completed tasks. */
  progress: number | null;
  /** True when the card's projected end is in the past but the task
   *  isn't completed/cancelled. The UI uses this for the "behind
   *  schedule" pulse / warning icon. */
  is_behind: boolean;
}

/** Statuses that count as "still on the plate" for behind-schedule math. */
const LIVE_STATUSES = new Set([
  'scheduled', 'ready_now', 'in_progress', 'paused', 'inspection_pending',
  'correction_pending', 'check_pending', 'deferred',
]);

/** Statuses that represent finished work — bar widths come from
 *  completed_at - started_at, not estimated minutes. */
const TERMINAL_STATUSES = new Set([
  'completed', 'inspected_pass', 'inspected_fail',
  'correction_complete', 'check_complete', 'cancelled', 'skipped', 'superseded',
]);

/** Minimum pixel width so a 5-min "room check" card stays click-able
 *  even when the timeline is zoomed all the way out. */
export const MIN_CARD_WIDTH_PX = 28;

export interface LaneLayoutConfig {
  /** Shift start in UTC ms. Used as the anchor for the first scheduled
   *  task and as x=0 for pixel coordinates. */
  shiftStartMs: number;
  /** Pixels per minute. Plot-area width / shift_minutes typically. */
  pxPerMinute: number;
  /** Current wall-clock UTC ms. Used for the "behind schedule" flag
   *  and the in-progress progress fraction. */
  nowMs: number;
}

/**
 * Walk a sorted queue forward and emit each card's wall-clock window +
 * pixel position. Anchors on real timestamps where they exist so a
 * housekeeper running 20 minutes behind shows as 20 minutes of red.
 *
 * Cursor semantics — important for "what time does the NEXT card start":
 *   - completed: cursor advances to actual completed_at
 *   - in_progress: cursor advances to max(projected_end, nowMs) so the
 *     next room never gets placed mid-overrun (would render the next
 *     task in the past while the current one is still running)
 *   - paused: the task is back on the queue; place it where the cursor
 *     currently sits, run for the FULL estimated duration. We don't try
 *     to subtract elapsed work, because paused tasks usually need to
 *     restart from the beginning (housekeeper went to lunch, left the
 *     room dirty); the elapsed time is informational, not deductible.
 *   - scheduled: place at cursor for estimated_minutes, advance cursor.
 */
export function layoutLane(
  tasksInQueueOrder: LayoutTaskInput[],
  cfg: LaneLayoutConfig,
): LayoutTaskOutput[] {
  const out: LayoutTaskOutput[] = [];
  // Cursor that advances as we emit each card. Each task starts no
  // earlier than the prior task's end AND no earlier than shift_start.
  let cursorMs = cfg.shiftStartMs;
  for (const t of tasksInQueueOrder) {
    const estMs = Math.max(0, t.estimated_minutes_resolved) * 60_000;
    const startedMs = t.started_at ? Date.parse(t.started_at) : null;
    const completedMs = t.completed_at ? Date.parse(t.completed_at) : null;
    let startMs: number;
    let endMs: number;
    let progress: number | null = null;
    // The cursor advances by this much after we emit the card. Usually
    // = endMs, but in-progress overrun stretches it to nowMs so the
    // NEXT card lands no earlier than "right now".
    let cursorAdvanceTo: number;
    if (TERMINAL_STATUSES.has(t.status) && startedMs && completedMs) {
      // Completed: bar width = actual duration on the floor.
      startMs = startedMs;
      endMs = completedMs;
      cursorAdvanceTo = completedMs;
    } else if (t.status === 'in_progress' && startedMs) {
      // In progress: anchor at real start, project end by estimate.
      // If the estimate is already in the past (overrun), the next
      // scheduled task should still wait until at least nowMs — we
      // shouldn't schedule the next room mid-overrun.
      startMs = startedMs;
      endMs = startedMs + estMs;
      const elapsedMs = Math.max(0, cfg.nowMs - startedMs);
      progress = estMs > 0 ? Math.min(1, elapsedMs / estMs) : 0;
      cursorAdvanceTo = Math.max(endMs, cfg.nowMs);
    } else if (t.status === 'paused' && startedMs) {
      // Paused: it's back in the queue. Show it where the cursor sits
      // now (the manager's eye reads "this is what Maria will pick up
      // next"), and bill the full estimated duration so the next card
      // doesn't sneak in front of it.
      startMs = Math.max(cursorMs, cfg.shiftStartMs);
      endMs = startMs + estMs;
      cursorAdvanceTo = endMs;
    } else if (startedMs) {
      // Other started-but-not-running statuses (inspection_pending,
      // correction_pending, check_pending). Anchor at the real start.
      startMs = startedMs;
      endMs = startedMs + estMs;
      cursorAdvanceTo = Math.max(endMs, cfg.nowMs);
    } else {
      // Not started yet: place sequentially after the cursor.
      startMs = Math.max(cursorMs, cfg.shiftStartMs);
      endMs = startMs + estMs;
      cursorAdvanceTo = endMs;
    }
    const x = ((startMs - cfg.shiftStartMs) / 60_000) * cfg.pxPerMinute;
    const rawWidth = ((endMs - startMs) / 60_000) * cfg.pxPerMinute;
    const width = Math.max(MIN_CARD_WIDTH_PX, rawWidth);
    const isBehind = LIVE_STATUSES.has(t.status) && endMs < cfg.nowMs;
    out.push({
      ...t,
      start_ms: startMs,
      end_ms: endMs,
      x,
      width,
      progress,
      is_behind: isBehind,
    });
    cursorMs = Math.max(cursorMs, cursorAdvanceTo);
  }
  return out;
}

/**
 * Pixel position for the "now" indicator. Returns null when current
 * time is outside the shift window (so the UI hides the line entirely
 * rather than pinning it to the edge).
 */
export function nowLineX(
  nowMs: number,
  cfg: { shiftStartMs: number; shiftEndMs: number; pxPerMinute: number },
): number | null {
  if (nowMs < cfg.shiftStartMs) return null;
  if (nowMs > cfg.shiftEndMs) return null;
  return ((nowMs - cfg.shiftStartMs) / 60_000) * cfg.pxPerMinute;
}

/**
 * For a single lane, detect any two cards whose pixel rectangles
 * overlap. Used by the UI to fall back to a "stacked" layout when the
 * real schedule has bunched two tasks too close. Returns the list of
 * overlapping pairs so the UI can decide whether to render at the
 * overlap point or visually offset them.
 */
export function detectOverlaps(
  laneTasks: LayoutTaskOutput[],
): Array<{ a: string; b: string }> {
  const out: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < laneTasks.length; i++) {
    for (let j = i + 1; j < laneTasks.length; j++) {
      const a = laneTasks[i];
      const b = laneTasks[j];
      const aEnd = a.x + a.width;
      const bEnd = b.x + b.width;
      // Standard interval-overlap check, exclusive at the boundary so
      // back-to-back cards (a ends exactly where b starts) don't trip.
      if (a.x < bEnd && b.x < aEnd) {
        out.push({ a: a.id, b: b.id });
      }
    }
  }
  return out;
}

/** Hourly gridline positions across the shift window. Used by the
 *  timeline header to draw vertical rules + hour labels.
 *
 *  Assumes shiftStartMs is already aligned to a top-of-hour in the
 *  property's local timezone — the server emits start_iso that way (it
 *  resolves 7am-local on shift_date). We step forward in 60-min hops
 *  from there, so every tick lands on the local clock's :00. */
export function hourGridlines(cfg: {
  shiftStartMs: number;
  shiftEndMs: number;
  pxPerMinute: number;
}): Array<{ x: number; ms: number }> {
  const out: Array<{ x: number; ms: number }> = [];
  for (let ms = cfg.shiftStartMs; ms <= cfg.shiftEndMs; ms += 60 * 60_000) {
    const x = ((ms - cfg.shiftStartMs) / 60_000) * cfg.pxPerMinute;
    out.push({ x, ms });
  }
  return out;
}

/**
 * Compute the UTC ISO timestamp for `date @ hour:00:00` in the given
 * IANA timezone. Used by the timeline server to emit the shift window
 * (`shift.start_iso`) — "7am local on shift_date, in UTC".
 *
 * Lives in this pure module (not in the route file) so the tz behaviour
 * can be unit-tested with node:test without spinning up the server's
 * Supabase + Next imports.
 *
 * Implementation: start from the naive UTC interpretation, then refine
 * by the diff between the requested wall-clock and the wall-clock the
 * zone actually shows for that instant. One pass is enough for stable
 * zones, but it can be off on the DST transition day (the offset at
 * the pre-refinement instant differs from the offset at the refined
 * instant). A second pass — using the offset at the refined instant —
 * closes the loop. We iterate up to 3 times for safety; in practice
 * the answer stabilises in pass 2.
 */
export function localDateTimeToUtcIso(
  isoDate: string,
  hourLocal: number,
  timezone: string,
): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`invalid date: ${isoDate}`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const target = Date.UTC(y, m - 1, d, hourLocal, 0, 0, 0);
  let candidate = target;
  for (let pass = 0; pass < 3; pass++) {
    const parts = fmt.formatToParts(new Date(candidate));
    const pick = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0');
    const hh = pick('hour') === 24 ? 0 : pick('hour');
    const shown = Date.UTC(
      pick('year'), pick('month') - 1, pick('day'),
      hh, pick('minute'), pick('second'), 0,
    );
    const diff = shown - target;
    if (diff === 0) break;
    candidate = candidate - diff;
  }
  return new Date(candidate).toISOString();
}
