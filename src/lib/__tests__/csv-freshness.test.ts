/**
 * Tests for csvFreshness in src/lib/db/plan-snapshots.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/csv-freshness.test.ts
 *
 * History: before this helper, the Schedule tab compared today's
 * planSnapshot.pulledAt against current time and applied a stale/error
 * threshold whenever current time was inside the scraper window (5am–11pm).
 * That window includes 7–11pm — which is when the scraper has CORRECTLY
 * switched to evening pulls writing to TOMORROW's snapshot row, leaving
 * today's pulledAt frozen by design. Result: red "CSV pull failing"
 * banner every night ~9–11pm, no actual outage. These tests pin the new
 * behavior so that bug doesn't regress.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { csvFreshness } from '../db/plan-snapshots';
import type { PlanSnapshot, CsvPipelineStatus, CsvPullStatus } from '../db/plan-snapshots';

// ─── Test fixtures ─────────────────────────────────────────────────────────

const EMPTY_PIPELINE: CsvPipelineStatus = { morning: null, evening: null };

function makeSnapshot(pulledAt: Date | null): PlanSnapshot {
  return {
    date: '2026-04-29',
    pulledAt,
    pullType: 'morning',
    totalRooms: 74, checkouts: 11, stayovers: 43, stayoverDay1: 0, stayoverDay2: 0,
    stayoverArrivalDay: 0, stayoverUnknown: 0, arrivals: 10, vacantClean: 0, vacantDirty: 0,
    ooo: 0, checkoutMinutes: 0, stayoverDay1Minutes: 0, stayoverDay2Minutes: 0,
    vacantDirtyMinutes: 0, totalCleaningMinutes: 0, recommendedHKs: 4,
    checkoutRoomNumbers: [], stayoverDay1RoomNumbers: [], stayoverDay2RoomNumbers: [],
    stayoverArrivalRoomNumbers: [], arrivalRoomNumbers: [], vacantCleanRoomNumbers: [],
    vacantDirtyRoomNumbers: [], oooRoomNumbers: [], rooms: [],
  };
}

function makePullStatus(over: Partial<CsvPullStatus> & { pullType: 'morning' | 'evening' }): CsvPullStatus {
  return {
    pullType: over.pullType,
    at: over.at ?? null,
    status: over.status ?? null,
    errorCode: over.errorCode ?? null,
    error: over.error ?? null,
    consecutiveFailures: over.consecutiveFailures ?? 0,
  };
}

// Convert "YYYY-MM-DD HH:MM CT" to ms-since-epoch. Used to control nowMs
// regardless of the host machine's timezone — without this, the ms returned
// would shift if a CI runner is in UTC vs. the dev's CDT.
//
// We anchor to America/Chicago by computing the UTC offset for that date.
// Chicago is UTC-5 (CDT) from mid-March → early November, UTC-6 (CST) otherwise.
// All dates in these tests fall in CDT (April), so we use -5.
function ctMs(yyyymmdd: string, hhmm: string): number {
  return new Date(`${yyyymmdd}T${hhmm}:00-05:00`).getTime();
}

// ─── Tests: time-of-day windows with healthy pipeline ──────────────────────

describe('csvFreshness — morning-pull window (5am–7pm CT)', () => {
  test('fresh when snapshot is recent (≤75 min ago)', () => {
    const now = ctMs('2026-04-29', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '09:00'))); // 30 min ago
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'fresh');
    assert.equal(fr.minutesAgo, 30);
  });

  test('stale at 75–180 min', () => {
    const now = ctMs('2026-04-29', '14:00');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '12:30'))); // 90 min
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'stale');
    assert.equal(fr.reason, 'snapshot_stale');
    assert.equal(fr.minutesAgo, 90);
  });

  test('error at >180 min', () => {
    const now = ctMs('2026-04-29', '16:00');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '12:30'))); // 210 min
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'error');
    assert.equal(fr.reason, 'snapshot_stale');
    assert.equal(fr.minutesAgo, 210);
  });

  test('stale (no_snapshot) when snapshot missing during morning window', () => {
    const now = ctMs('2026-04-29', '09:30');
    const fr = csvFreshness(null, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'stale');
    assert.equal(fr.reason, 'no_snapshot');
    assert.equal(fr.minutesAgo, null);
    assert.equal(fr.referenceAt, null);
  });
});

describe('csvFreshness — frozen-evening window (7–11pm CT) — THE bug fix', () => {
  // The screenshot Reeyen shipped on 2026-04-29 shows last good pull at
  // 6:11 PM, 274 min ago, banner reads "CSV pull failing. Tell Reeyen."
  // BEFORE the fix this rendered as state='error'. AFTER, it should be
  // state='fresh' with reason='frozen_evening'.
  test('reproduces the 2026-04-29 false alarm — should be fresh, not error', () => {
    const now = ctMs('2026-04-29', '22:45');                            // 10:45 PM CT
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '18:11')));   // 6:11 PM, 274 min ago
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh', 'must NOT be error: today\'s snapshot is intentionally frozen post-7pm');
    assert.equal(fr.reason, 'frozen_evening');
    assert.equal(fr.minutesAgo, 274);
  });

  test('fresh at 7pm sharp — boundary of morning-pull window', () => {
    const now = ctMs('2026-04-29', '19:00');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '18:11')));
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'frozen_evening');
  });

  test('still fresh at 9:11pm even though >180 min stale (would have been error before)', () => {
    const now = ctMs('2026-04-29', '21:11');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '18:11'))); // 180 min
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'frozen_evening');
  });
});

describe('csvFreshness — overnight off-hours (11pm–5am CT)', () => {
  test('fresh at midnight', () => {
    const now = ctMs('2026-04-30', '00:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '18:11')));
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'off_hours');
  });

  test('fresh at 4:59am', () => {
    const now = ctMs('2026-04-30', '04:59');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '18:11')));
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'off_hours');
  });
});

// ─── Tests: pipeline failure overrides time-of-day ─────────────────────────

describe('csvFreshness — pipeline_error overrides everything', () => {
  test('morning pipeline failing = error even with fresh snapshot', () => {
    const now = ctMs('2026-04-29', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '09:00'))); // 30 min ago, fresh
    const pipeline: CsvPipelineStatus = {
      morning: makePullStatus({
        pullType: 'morning',
        at: new Date(ctMs('2026-04-29', '09:25')),
        status: 'error',
        errorCode: 'selector_miss',
        error: 'CSV checkbox not actionable',
        consecutiveFailures: 3,
      }),
      evening: null,
    };
    const fr = csvFreshness(snap, pipeline, now);
    assert.equal(fr.state, 'error');
    assert.equal(fr.reason, 'pipeline_error');
    assert.equal(fr.errorCode, 'selector_miss');
    assert.equal(fr.errorMessage, 'CSV checkbox not actionable');
  });

  test('evening pipeline failing = error even after 7pm', () => {
    const now = ctMs('2026-04-29', '22:00');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '18:11')));
    const pipeline: CsvPipelineStatus = {
      morning: null,
      evening: makePullStatus({
        pullType: 'evening',
        at: new Date(ctMs('2026-04-29', '21:50')),
        status: 'error',
        errorCode: 'login_failed',
        error: 'Credentials rejected',
        consecutiveFailures: 4,
      }),
    };
    const fr = csvFreshness(snap, pipeline, now);
    assert.equal(fr.state, 'error');
    assert.equal(fr.reason, 'pipeline_error');
    assert.equal(fr.errorCode, 'login_failed');
  });

  test('single failure (consecutiveFailures=1) does NOT trigger pipeline_error', () => {
    // Threshold is 2 — a single transient blip self-recovers next tick.
    const now = ctMs('2026-04-29', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '09:00')));
    const pipeline: CsvPipelineStatus = {
      morning: makePullStatus({
        pullType: 'morning',
        at: new Date(ctMs('2026-04-29', '09:25')),
        status: 'error',
        consecutiveFailures: 1,
      }),
      evening: null,
    };
    const fr = csvFreshness(snap, pipeline, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'fresh');
  });

  test('successful most-recent pull (consecutiveFailures=0) clears pipeline_error', () => {
    const now = ctMs('2026-04-29', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-29', '09:00')));
    const pipeline: CsvPipelineStatus = {
      morning: makePullStatus({
        pullType: 'morning',
        at: new Date(ctMs('2026-04-29', '09:25')),
        status: 'success',
        consecutiveFailures: 0,
      }),
      evening: null,
    };
    const fr = csvFreshness(snap, pipeline, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'fresh');
  });
});
