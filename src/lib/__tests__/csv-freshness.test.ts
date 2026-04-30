/**
 * Tests for csvFreshness in src/lib/db/plan-snapshots.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/csv-freshness.test.ts
 *
 * Single-window freshness model:
 *   • 5am–11pm CT (scraper window):
 *     - fresh     ≤75 min since last pull
 *     - stale     75–180 min
 *     - error     >180 min  (or pipeline reports active failure)
 *   • 11pm–5am CT (off-hours): always fresh; the scraper is correctly idle.
 *
 * The scraper writes EVERY pull to today's plan_snapshots row, so today's
 * pulledAt should bump every hour throughout the scraper window. There's
 * no morning/evening split anymore — see scraper.js header for history.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { csvFreshness } from '../db/plan-snapshots';
import type { PlanSnapshot, CsvPipelineStatus, CsvPullStatus } from '../db/plan-snapshots';

// ─── Test fixtures ─────────────────────────────────────────────────────────

const EMPTY_PIPELINE: CsvPipelineStatus = { morning: null, evening: null };

function makeSnapshot(pulledAt: Date | null): PlanSnapshot {
  return {
    date: '2026-04-30',
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

// Convert "YYYY-MM-DD HH:MM CT" to ms-since-epoch. We anchor to America/Chicago
// (UTC-5 in CDT, all dates here are in CDT) so tests pass on a UTC CI runner
// just as they do on the dev's CDT laptop.
function ctMs(yyyymmdd: string, hhmm: string): number {
  return new Date(`${yyyymmdd}T${hhmm}:00-05:00`).getTime();
}

// ─── Scraper window — 5am to 11pm CT, single uniform behavior ──────────────

describe('csvFreshness — scraper window (5am–11pm CT) is uniform', () => {
  test('fresh at 9:30am with snapshot 30 min ago', () => {
    const now = ctMs('2026-04-30', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '09:00')));
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'fresh');
    assert.equal(fr.minutesAgo, 30);
  });

  test('fresh at 10:30pm with snapshot 30 min ago — would have falsely alarmed pre-fix', () => {
    // The reason this case exists: under the previous (post-bb51ac1)
    // architecture, evening pulls 7–11pm wrote to TOMORROW's row, so
    // today's snapshot was guaranteed stale by 9pm. After the simplification,
    // every pull writes to today's row, so 10:30pm with a fresh pull is the
    // expected steady state.
    const now = ctMs('2026-04-30', '22:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '22:00')));
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'fresh');
  });

  test('stale at 75–180 min anywhere in window — morning', () => {
    const now = ctMs('2026-04-30', '14:00');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '12:30'))); // 90 min
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'stale');
    assert.equal(fr.reason, 'snapshot_stale');
    assert.equal(fr.minutesAgo, 90);
  });

  test('stale at 75–180 min anywhere in window — evening', () => {
    const now = ctMs('2026-04-30', '21:00');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '19:30'))); // 90 min
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'stale');
    assert.equal(fr.reason, 'snapshot_stale');
    assert.equal(fr.minutesAgo, 90);
  });

  test('error at >180 min — morning', () => {
    const now = ctMs('2026-04-30', '16:00');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '12:30'))); // 210 min
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'error');
    assert.equal(fr.reason, 'snapshot_stale');
    assert.equal(fr.minutesAgo, 210);
  });

  test('error at >180 min — evening (the case that USED to false-alarm)', () => {
    // Old simulated bug: 10:45pm, last pull 6:11pm. With the morning/evening
    // split that used to be expected and OK; with the simplification it's a
    // real outage and we should surface it. This test pins that.
    const now = ctMs('2026-04-30', '22:45');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '18:11'))); // 274 min
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'error');
    assert.equal(fr.reason, 'snapshot_stale');
    assert.equal(fr.minutesAgo, 274);
  });

  test('stale (no_snapshot) when snapshot missing during window', () => {
    const now = ctMs('2026-04-30', '09:30');
    const fr = csvFreshness(null, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'stale');
    assert.equal(fr.reason, 'no_snapshot');
    assert.equal(fr.minutesAgo, null);
    assert.equal(fr.referenceAt, null);
  });
});

// ─── Off-hours — 11pm–5am CT, scraper is idle, suppress alarms ─────────────

describe('csvFreshness — overnight off-hours (11pm–5am CT)', () => {
  test('fresh at midnight even though snapshot is hours old', () => {
    const now = ctMs('2026-05-01', '00:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '22:08')));
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'off_hours');
  });

  test('fresh at 4:59am — boundary, scraper still idle', () => {
    const now = ctMs('2026-05-01', '04:59');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '22:08')));
    const fr = csvFreshness(snap, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'off_hours');
  });

  test('no_snapshot during off-hours = fresh (overnight is normal absence)', () => {
    const now = ctMs('2026-05-01', '02:00');
    const fr = csvFreshness(null, EMPTY_PIPELINE, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'no_snapshot');
  });
});

// ─── Pipeline error overrides time-of-day ──────────────────────────────────

describe('csvFreshness — pipeline_error overrides everything', () => {
  test('morning pipeline failing = error even with fresh snapshot', () => {
    const now = ctMs('2026-04-30', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '09:00'))); // fresh
    const pipeline: CsvPipelineStatus = {
      morning: makePullStatus({
        pullType: 'morning',
        at: new Date(ctMs('2026-04-30', '09:25')),
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

  test('orphan evening row with status=success does NOT trigger pipeline_error', () => {
    // The 'evening' row never gets new writes after the simplification, but
    // it still exists in scraper_status with its last write (success). The
    // failure threshold check requires status='error' AND consecutiveFailures>=2,
    // so a stale 'success' row is correctly ignored.
    const now = ctMs('2026-04-30', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '09:00')));
    const pipeline: CsvPipelineStatus = {
      morning: makePullStatus({
        pullType: 'morning',
        at: new Date(ctMs('2026-04-30', '09:25')),
        status: 'success',
        consecutiveFailures: 0,
      }),
      evening: makePullStatus({
        pullType: 'evening',
        at: new Date(ctMs('2026-04-29', '22:08')), // yesterday, pre-removal
        status: 'success',
        consecutiveFailures: 0,
      }),
    };
    const fr = csvFreshness(snap, pipeline, now);
    assert.equal(fr.state, 'fresh');
    assert.equal(fr.reason, 'fresh');
  });

  test('single failure (consecutiveFailures=1) does NOT trigger pipeline_error', () => {
    // Threshold is 2 — a single transient blip self-recovers next tick.
    const now = ctMs('2026-04-30', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '09:00')));
    const pipeline: CsvPipelineStatus = {
      morning: makePullStatus({
        pullType: 'morning',
        at: new Date(ctMs('2026-04-30', '09:25')),
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
    const now = ctMs('2026-04-30', '09:30');
    const snap = makeSnapshot(new Date(ctMs('2026-04-30', '09:00')));
    const pipeline: CsvPipelineStatus = {
      morning: makePullStatus({
        pullType: 'morning',
        at: new Date(ctMs('2026-04-30', '09:25')),
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
