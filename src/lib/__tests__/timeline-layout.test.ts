/**
 * Tests for the housekeeping Timeline view's positioning math
 * (src/lib/timeline-layout.ts).
 *
 * What we lock down:
 *   - layoutLane positions scheduled tasks sequentially from shift_start
 *   - in-progress tasks are anchored on their real started_at (not the queue)
 *   - completed tasks use the actual completed_at - started_at as the bar width
 *   - nowLineX returns null outside the shift window and a pixel value inside
 *   - detectOverlaps returns pairs only for tasks whose pixel rectangles
 *     truly intersect (back-to-back is NOT an overlap)
 *   - hourGridlines emits a tick at the top of every hour inside the window
 *   - MIN_CARD_WIDTH_PX floor applies even for 5-minute tasks
 *
 * Run via: npx tsx --test src/lib/__tests__/timeline-layout.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutLane,
  nowLineX,
  detectOverlaps,
  hourGridlines,
  MIN_CARD_WIDTH_PX,
  type LayoutTaskInput,
} from '../timeline-layout';

// A fixed shift window: 2026-05-24T12:00:00Z → 20:00:00Z (8 hr = 480 min).
const SHIFT_START_MS = Date.parse('2026-05-24T12:00:00Z');
const SHIFT_END_MS = SHIFT_START_MS + 480 * 60_000;
const PX_PER_MIN = 2; // makes the math easy to read in assertions

function mkTask(overrides: Partial<LayoutTaskInput> & { id: string }): LayoutTaskInput {
  return {
    id: overrides.id,
    queue_order: overrides.queue_order ?? 0,
    estimated_minutes_resolved: overrides.estimated_minutes_resolved ?? 30,
    status: overrides.status ?? 'scheduled',
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
  };
}

describe('layoutLane', () => {
  test('places sequential scheduled tasks back-to-back from shift_start', () => {
    const tasks = [
      mkTask({ id: 'a', queue_order: 0, estimated_minutes_resolved: 30 }),
      mkTask({ id: 'b', queue_order: 1, estimated_minutes_resolved: 45 }),
      mkTask({ id: 'c', queue_order: 2, estimated_minutes_resolved: 20 }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: SHIFT_START_MS,
    });
    assert.equal(laid[0].x, 0);
    assert.equal(laid[0].width, 30 * PX_PER_MIN);
    assert.equal(laid[1].x, 30 * PX_PER_MIN);
    assert.equal(laid[1].width, 45 * PX_PER_MIN);
    assert.equal(laid[2].x, 75 * PX_PER_MIN);
    assert.equal(laid[2].width, 20 * PX_PER_MIN);
  });

  test('anchors in-progress tasks on real started_at, not the queue cursor', () => {
    const startedReal = new Date(SHIFT_START_MS + 12 * 60_000).toISOString();
    const tasks = [
      mkTask({
        id: 'a', queue_order: 0, estimated_minutes_resolved: 30,
        status: 'in_progress', started_at: startedReal,
      }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: Date.parse(startedReal) + 6 * 60_000,
    });
    assert.equal(laid[0].x, 12 * PX_PER_MIN);
    assert.equal(laid[0].width, 30 * PX_PER_MIN);
    assert.equal(laid[0].progress != null, true);
    assert.ok(Math.abs((laid[0].progress ?? 0) - 0.2) < 0.001);
  });

  test('uses real completed_at - started_at for completed task width', () => {
    const startedReal = new Date(SHIFT_START_MS + 5 * 60_000).toISOString();
    const completedReal = new Date(SHIFT_START_MS + 55 * 60_000).toISOString();
    const tasks = [
      mkTask({
        id: 'a', queue_order: 0, estimated_minutes_resolved: 30,
        status: 'completed', started_at: startedReal, completed_at: completedReal,
      }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: SHIFT_END_MS,
    });
    assert.equal(laid[0].x, 5 * PX_PER_MIN);
    // Real elapsed = 50 min (5 → 55), not the 30-min estimate
    assert.equal(laid[0].width, 50 * PX_PER_MIN);
    assert.equal(laid[0].is_behind, false);
  });

  test('flags scheduled task as is_behind when projected end is in the past', () => {
    const tasks = [
      mkTask({ id: 'a', queue_order: 0, estimated_minutes_resolved: 30 }),
    ];
    // Two hours past shift_start, task should be done by now → behind
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: SHIFT_START_MS + 120 * 60_000,
    });
    assert.equal(laid[0].is_behind, true);
  });

  test('does NOT flag completed tasks as behind even when end_ms is in the past', () => {
    const startedReal = new Date(SHIFT_START_MS + 5 * 60_000).toISOString();
    const completedReal = new Date(SHIFT_START_MS + 35 * 60_000).toISOString();
    const tasks = [
      mkTask({
        id: 'a', queue_order: 0, estimated_minutes_resolved: 30,
        status: 'completed', started_at: startedReal, completed_at: completedReal,
      }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: SHIFT_START_MS + 120 * 60_000,
    });
    assert.equal(laid[0].is_behind, false);
  });

  test('enforces MIN_CARD_WIDTH_PX so short tasks remain click-able', () => {
    // 5-minute task at 0.1 px/min = 0.5 px raw → must clamp to MIN_CARD_WIDTH_PX
    const tasks = [
      mkTask({ id: 'a', queue_order: 0, estimated_minutes_resolved: 5 }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: 0.1,
      nowMs: SHIFT_START_MS,
    });
    assert.equal(laid[0].width, MIN_CARD_WIDTH_PX);
  });

  test('scheduled task after in-progress task starts after in-progress END, not queue cursor', () => {
    // a is in progress, started 30 min into the shift, est 60 min.
    // b is scheduled. b should start at 30+60=90 min (a's projected end),
    // NOT at a's started_at + estimated_minutes via a separate cursor.
    const aStarted = new Date(SHIFT_START_MS + 30 * 60_000).toISOString();
    const tasks = [
      mkTask({
        id: 'a', queue_order: 0, estimated_minutes_resolved: 60,
        status: 'in_progress', started_at: aStarted,
      }),
      mkTask({ id: 'b', queue_order: 1, estimated_minutes_resolved: 30 }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: SHIFT_START_MS + 40 * 60_000,
    });
    assert.equal(laid[1].x, 90 * PX_PER_MIN);
    assert.equal(laid[1].width, 30 * PX_PER_MIN);
  });

  test('overrunning in_progress task does NOT schedule the next room mid-overrun', () => {
    // a started 60 min into shift, est 30 min → projected end at min 90.
    // It is now min 130 — a is running 40 min over. b should NOT start at
    // min 90 (already in the past) — it should start at nowMs (min 130)
    // because the housekeeper hasn't freed up yet.
    const aStarted = new Date(SHIFT_START_MS + 60 * 60_000).toISOString();
    const tasks = [
      mkTask({
        id: 'a', queue_order: 0, estimated_minutes_resolved: 30,
        status: 'in_progress', started_at: aStarted,
      }),
      mkTask({ id: 'b', queue_order: 1, estimated_minutes_resolved: 20 }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: SHIFT_START_MS + 130 * 60_000,
    });
    // b should land at nowMs (min 130 from shift_start), NOT at min 90.
    assert.equal(laid[1].x, 130 * PX_PER_MIN);
    assert.equal(laid[1].width, 20 * PX_PER_MIN);
  });

  test('paused task with started_at lands on the cursor, billed for full estimate', () => {
    // a completed (5 → 25 min, 20 min real). b is paused with a stale
    // started_at; should land at cursor (min 25), bill its full 30-min
    // estimate. c is scheduled and goes after b at min 55.
    const aStarted = new Date(SHIFT_START_MS + 5 * 60_000).toISOString();
    const aCompleted = new Date(SHIFT_START_MS + 25 * 60_000).toISOString();
    const bOldStart = new Date(SHIFT_START_MS + 10 * 60_000).toISOString();
    const tasks = [
      mkTask({
        id: 'a', queue_order: 0, estimated_minutes_resolved: 20,
        status: 'completed', started_at: aStarted, completed_at: aCompleted,
      }),
      mkTask({
        id: 'b', queue_order: 1, estimated_minutes_resolved: 30,
        status: 'paused', started_at: bOldStart,
      }),
      mkTask({ id: 'c', queue_order: 2, estimated_minutes_resolved: 15 }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: SHIFT_START_MS + 26 * 60_000,
    });
    assert.equal(laid[1].x, 25 * PX_PER_MIN);
    assert.equal(laid[1].width, 30 * PX_PER_MIN);
    assert.equal(laid[2].x, 55 * PX_PER_MIN);
    assert.equal(laid[2].width, 15 * PX_PER_MIN);
  });

  test('cursor advances correctly when a queue mixes statuses', () => {
    // Real-world scenario: 1 completed (real 20m), 1 in-progress overrun,
    // 1 scheduled. Next scheduled lands at the LATER of the in-progress
    // overrun and nowMs.
    const aStarted = new Date(SHIFT_START_MS + 0).toISOString();
    const aCompleted = new Date(SHIFT_START_MS + 20 * 60_000).toISOString();
    const bStarted = new Date(SHIFT_START_MS + 25 * 60_000).toISOString();
    const tasks = [
      mkTask({
        id: 'a', queue_order: 0, estimated_minutes_resolved: 25,
        status: 'completed', started_at: aStarted, completed_at: aCompleted,
      }),
      mkTask({
        id: 'b', queue_order: 1, estimated_minutes_resolved: 30,
        status: 'in_progress', started_at: bStarted,
      }),
      mkTask({ id: 'c', queue_order: 2, estimated_minutes_resolved: 20 }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS,
      pxPerMinute: PX_PER_MIN,
      nowMs: SHIFT_START_MS + 90 * 60_000, // b's projected end is at 55, now is 90
    });
    // c should land at nowMs (min 90), not at b's projected end (min 55).
    assert.equal(laid[2].x, 90 * PX_PER_MIN);
  });
});

describe('nowLineX', () => {
  test('returns null when nowMs is before the shift starts', () => {
    const x = nowLineX(SHIFT_START_MS - 60_000, {
      shiftStartMs: SHIFT_START_MS, shiftEndMs: SHIFT_END_MS, pxPerMinute: PX_PER_MIN,
    });
    assert.equal(x, null);
  });

  test('returns null when nowMs is after the shift ends', () => {
    const x = nowLineX(SHIFT_END_MS + 60_000, {
      shiftStartMs: SHIFT_START_MS, shiftEndMs: SHIFT_END_MS, pxPerMinute: PX_PER_MIN,
    });
    assert.equal(x, null);
  });

  test('returns the correct pixel position when inside the window', () => {
    // 2 hours = 120 min after shift_start, at 2 px/min = 240 px
    const x = nowLineX(SHIFT_START_MS + 120 * 60_000, {
      shiftStartMs: SHIFT_START_MS, shiftEndMs: SHIFT_END_MS, pxPerMinute: PX_PER_MIN,
    });
    assert.equal(x, 240);
  });

  test('returns 0 exactly at shift_start', () => {
    const x = nowLineX(SHIFT_START_MS, {
      shiftStartMs: SHIFT_START_MS, shiftEndMs: SHIFT_END_MS, pxPerMinute: PX_PER_MIN,
    });
    assert.equal(x, 0);
  });
});

describe('detectOverlaps', () => {
  test('returns empty for back-to-back tasks (boundary touch is not overlap)', () => {
    const tasks = [
      mkTask({ id: 'a', queue_order: 0, estimated_minutes_resolved: 30 }),
      mkTask({ id: 'b', queue_order: 1, estimated_minutes_resolved: 30 }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS, pxPerMinute: PX_PER_MIN, nowMs: SHIFT_START_MS,
    });
    assert.deepEqual(detectOverlaps(laid), []);
  });

  test('detects two cards that actually overlap on the pixel axis', () => {
    // Both anchored at the same real started_at → they will overlap.
    const sameStart = new Date(SHIFT_START_MS + 10 * 60_000).toISOString();
    const tasks = [
      mkTask({
        id: 'a', queue_order: 0, estimated_minutes_resolved: 30,
        status: 'in_progress', started_at: sameStart,
      }),
      mkTask({
        id: 'b', queue_order: 1, estimated_minutes_resolved: 30,
        status: 'in_progress', started_at: sameStart,
      }),
    ];
    const laid = layoutLane(tasks, {
      shiftStartMs: SHIFT_START_MS, pxPerMinute: PX_PER_MIN, nowMs: SHIFT_START_MS,
    });
    const overlaps = detectOverlaps(laid);
    assert.equal(overlaps.length, 1);
    assert.deepEqual(overlaps[0], { a: 'a', b: 'b' });
  });

  test('returns empty when lane has fewer than 2 tasks', () => {
    const laid = layoutLane([mkTask({ id: 'a' })], {
      shiftStartMs: SHIFT_START_MS, pxPerMinute: PX_PER_MIN, nowMs: SHIFT_START_MS,
    });
    assert.deepEqual(detectOverlaps(laid), []);
  });
});

describe('hourGridlines', () => {
  test('emits one tick per hour across the shift window', () => {
    const ticks = hourGridlines({
      shiftStartMs: SHIFT_START_MS, shiftEndMs: SHIFT_END_MS, pxPerMinute: PX_PER_MIN,
    });
    // 8 hour window → 9 ticks (top-of-hour at 0, 60, 120 … 480)
    assert.equal(ticks.length, 9);
    assert.equal(ticks[0].x, 0);
    assert.equal(ticks[1].x, 60 * PX_PER_MIN);
    assert.equal(ticks[8].x, 480 * PX_PER_MIN);
  });

  test('uses pxPerMinute consistently — tick x matches (ms - start) * px/min', () => {
    const ticks = hourGridlines({
      shiftStartMs: SHIFT_START_MS, shiftEndMs: SHIFT_END_MS, pxPerMinute: 1.5,
    });
    for (const t of ticks) {
      const expected = ((t.ms - SHIFT_START_MS) / 60_000) * 1.5;
      assert.equal(t.x, expected);
    }
  });
});
