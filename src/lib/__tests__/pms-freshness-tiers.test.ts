/**
 * The pure data-age classifier (src/lib/pms/feed-status.ts).
 *
 * Every honesty claim the copilot makes about how old the hotel's numbers are
 * reduces to these three functions, so the boundaries are pinned here rather
 * than discovered in production. The case that matters most is the NEGATIVE
 * age: a capture time in the future would otherwise make every tier read
 * 'fresh' and turn the honesty layer into a confident liar.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  freshnessTier,
  freshnessAgeMinutes,
  formatAge,
  formatAsOfClock,
  PMS_FRESH_MAX_MINUTES,
  PMS_STALE_MAX_MINUTES,
} from '@/lib/pms/feed-status';

const NOW = new Date('2026-07-24T19:40:00.000Z'); // 2:40 PM America/Chicago

/** An ISO capture time `minutes` before NOW. */
function agedBy(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe('freshnessTier', () => {
  it('is fresh just inside the one-report-cycle window', () => {
    assert.equal(freshnessTier(agedBy(0), 'snapshot_capture', NOW), 'fresh');
    assert.equal(freshnessTier(agedBy(74), 'snapshot_capture', NOW), 'fresh');
    assert.equal(freshnessTier(agedBy(PMS_FRESH_MAX_MINUTES), 'snapshot_capture', NOW), 'fresh');
  });

  it('is stale once past a report cycle', () => {
    assert.equal(freshnessTier(agedBy(76), 'snapshot_capture', NOW), 'stale');
    assert.equal(freshnessTier(agedBy(PMS_STALE_MAX_MINUTES), 'session_read', NOW), 'stale');
  });

  it('is very_stale past the stuck-connection threshold', () => {
    assert.equal(freshnessTier(agedBy(361), 'snapshot_capture', NOW), 'very_stale');
    assert.equal(freshnessTier(agedBy(60 * 24), 'room_status_sync', NOW), 'very_stale');
  });

  it('never escalates a change-only stamp, at any age', () => {
    // Absence of change is not evidence of staleness — a change stamp cannot
    // distinguish "nothing happened" from "nothing arrived".
    assert.equal(freshnessTier(agedBy(1), 'row_change', NOW), 'change_only');
    assert.equal(freshnessTier(agedBy(400), 'row_change', NOW), 'change_only');
    assert.equal(freshnessTier(agedBy(60 * 24 * 3), 'row_change', NOW), 'change_only');
  });

  it('is unknown when there is no usable capture time', () => {
    assert.equal(freshnessTier(null, 'none', NOW), 'unknown');
    assert.equal(freshnessTier(undefined, 'snapshot_capture', NOW), 'unknown');
    assert.equal(freshnessTier('not-a-timestamp', 'snapshot_capture', NOW), 'unknown');
    // A change-only source with no timestamp is still just unknown.
    assert.equal(freshnessTier(null, 'row_change', NOW), 'unknown');
  });

  it('clamps a future capture time instead of reading it as extra-fresh', () => {
    const future = new Date(NOW.getTime() + 3 * 60 * 60_000).toISOString();
    const age = freshnessAgeMinutes(future, NOW);
    assert.equal(age, 0);
    assert.ok(age !== null && age >= 0, 'age must never be negative');
    assert.equal(freshnessTier(future, 'snapshot_capture', NOW), 'fresh');
  });
});

describe('freshnessAgeMinutes', () => {
  it('returns whole minutes elapsed', () => {
    assert.equal(freshnessAgeMinutes(agedBy(0), NOW), 0);
    assert.equal(freshnessAgeMinutes(agedBy(22), NOW), 22);
    assert.equal(freshnessAgeMinutes(agedBy(215), NOW), 215);
  });

  it('returns null (not 0) when there is nothing to measure', () => {
    // 0 would mean "captured this instant" — the opposite of "we don't know".
    assert.equal(freshnessAgeMinutes(null, NOW), null);
    assert.equal(freshnessAgeMinutes('', NOW), null);
    assert.equal(freshnessAgeMinutes('garbage', NOW), null);
  });
});

describe('formatAge', () => {
  it('reads the way a manager would say it', () => {
    assert.equal(formatAge(0), 'just now');
    assert.equal(formatAge(1), '1 min ago');
    assert.equal(formatAge(59), '59 min ago');
    assert.equal(formatAge(60), '1 hr ago');
    assert.equal(formatAge(215), '3 hr 35 min ago');
    assert.equal(formatAge(1440), '1 day ago');
    assert.equal(formatAge(2880), '2 days ago');
  });
});

describe('formatAsOfClock', () => {
  it('gives a 12-hour local clock with no date on the property\'s today', () => {
    const clock = formatAsOfClock(agedBy(22), 'America/Chicago', NOW);
    assert.deepEqual(clock, { time: '2:18 PM', zone: 'America/Chicago', age: '22 min ago' });
  });

  it('adds a date prefix once the capture is not on the local today', () => {
    // 8 hr 12 min before 2:40 PM local is 6:28 AM the SAME local day…
    assert.equal(formatAsOfClock(agedBy(492), 'America/Chicago', NOW)?.time, '6:28 AM');
    // …but 16 hours back crosses into yesterday, which must be labelled.
    const yesterday = formatAsOfClock(agedBy(16 * 60), 'America/Chicago', NOW);
    assert.equal(yesterday?.time, 'Jul 23, 10:40 PM');
    assert.equal(yesterday?.age, '16 hr ago');
  });

  it('falls back to UTC rather than throwing on a missing/invalid timezone', () => {
    assert.equal(formatAsOfClock(agedBy(22), null, NOW)?.zone, 'UTC');
    assert.equal(formatAsOfClock(agedBy(22), 'Mars/Olympus_Mons', NOW)?.zone, 'UTC');
    assert.equal(formatAsOfClock(agedBy(22), null, NOW)?.time, '7:18 PM');
  });

  it('returns null for an unusable timestamp', () => {
    assert.equal(formatAsOfClock('nonsense', 'America/Chicago', NOW), null);
  });
});
