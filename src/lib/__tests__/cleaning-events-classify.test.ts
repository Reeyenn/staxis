/**
 * Boundary tests for the cleaning-event classifier. The 3 / 60 / 90 minute
 * thresholds drive every flag, discard, and "Done" tap in the housekeeping
 * analytics pipeline. A single off-by-one bug here would silently bury Maria
 * in pointless review work (lowering the under_3min cutoff) or hide real
 * 90+ minute outliers (raising the over_90min cutoff). These tests pin the
 * boundaries so any threshold change is caught at PR time.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCleaningEvent,
  bucketStayoverDay,
  CLEANING_DISCARD_UNDER_MIN,
  CLEANING_FLAG_OVER_MIN,
  CLEANING_DISCARD_OVER_MIN,
} from '@/lib/db/cleaning-events';

describe('classifyCleaningEvent — boundary classification', () => {
  test('0 minutes → discarded with under_3min reason', () => {
    const r = classifyCleaningEvent(0);
    assert.equal(r.status, 'discarded');
    assert.equal(r.flagReason, 'under_3min');
  });

  test('just below 3 min → discarded (under_3min)', () => {
    const r = classifyCleaningEvent(2.99);
    assert.equal(r.status, 'discarded');
    assert.equal(r.flagReason, 'under_3min');
  });

  test('exactly 3 min → recorded (boundary is strict <)', () => {
    const r = classifyCleaningEvent(3);
    assert.equal(r.status, 'recorded');
    assert.equal(r.flagReason, null);
  });

  test('30 min (typical clean) → recorded', () => {
    const r = classifyCleaningEvent(30);
    assert.equal(r.status, 'recorded');
    assert.equal(r.flagReason, null);
  });

  test('exactly 60 min → recorded (boundary is strict >)', () => {
    const r = classifyCleaningEvent(60);
    assert.equal(r.status, 'recorded');
    assert.equal(r.flagReason, null);
  });

  test('just above 60 min → flagged for Maria review', () => {
    const r = classifyCleaningEvent(60.01);
    assert.equal(r.status, 'flagged');
    assert.equal(r.flagReason, 'over_60min');
  });

  test('exactly 90 min → flagged (boundary is strict >)', () => {
    const r = classifyCleaningEvent(90);
    assert.equal(r.status, 'flagged');
    assert.equal(r.flagReason, 'over_60min');
  });

  test('just above 90 min → discarded (forgot-to-tap-Done)', () => {
    const r = classifyCleaningEvent(90.01);
    assert.equal(r.status, 'discarded');
    assert.equal(r.flagReason, 'over_90min');
  });

  test('extreme values (8 hours) → discarded over_90min', () => {
    const r = classifyCleaningEvent(480);
    assert.equal(r.status, 'discarded');
    assert.equal(r.flagReason, 'over_90min');
  });

  test('thresholds match exported constants (drift guard)', () => {
    // If someone changes a constant without re-running the migration, the
    // TS-side inserts will produce different status values than the DB
    // CASE expression for the same input — catastrophic for analytics.
    assert.equal(CLEANING_DISCARD_UNDER_MIN, 3);
    assert.equal(CLEANING_FLAG_OVER_MIN, 60);
    assert.equal(CLEANING_DISCARD_OVER_MIN, 90);
  });
});

describe('bucketStayoverDay — S1/S2 cycle bucketing', () => {
  test('returns null for non-stayover rooms', () => {
    assert.equal(bucketStayoverDay(1, 'checkout'), null);
    assert.equal(bucketStayoverDay(2, 'departure'), null);
    assert.equal(bucketStayoverDay(3, ''), null);
  });

  test('returns null for stayoverDay 0 (arrival day)', () => {
    assert.equal(bucketStayoverDay(0, 'stayover'), null);
  });

  test('returns null for negative or non-numeric stayoverDay', () => {
    assert.equal(bucketStayoverDay(-1, 'stayover'), null);
    assert.equal(bucketStayoverDay(null, 'stayover'), null);
    assert.equal(bucketStayoverDay(undefined, 'stayover'), null);
  });

  test('odd stayover days bucket to 1 (S1 light)', () => {
    assert.equal(bucketStayoverDay(1, 'stayover'), 1);
    assert.equal(bucketStayoverDay(3, 'stayover'), 1);
    assert.equal(bucketStayoverDay(5, 'stayover'), 1);
    assert.equal(bucketStayoverDay(7, 'stayover'), 1);
  });

  test('even stayover days bucket to 2 (S2 full)', () => {
    assert.equal(bucketStayoverDay(2, 'stayover'), 2);
    assert.equal(bucketStayoverDay(4, 'stayover'), 2);
    assert.equal(bucketStayoverDay(6, 'stayover'), 2);
  });
});
