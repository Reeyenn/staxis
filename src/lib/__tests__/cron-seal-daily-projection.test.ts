/**
 * Tests for the seal-daily cron's plan_snapshots-projection date helper.
 *
 * The seal-daily cron now also projects tomorrow's occupancy into
 * plan_snapshots (via the 0292 bridge RPC) so the Python inventory ML reads
 * real projected occupancy instead of the 14-day-mean fallback. The write is
 * keyed on the property's LOCAL today + tomorrow; localDatesForProjection is
 * the date arithmetic behind that keying and the most bug-prone piece
 * (timezone offset + tomorrow rollover across month/year/DST boundaries).
 *
 * The gate logic (only write when the property has a live pms_in_house_snapshot
 * row + trusted reservation feeds) is exercised in prod through the seal-daily
 * GET path; there is no full-route stub harness for seal-daily today, so this
 * file covers the pure, deterministic date helper. If a broad seal-daily stub
 * harness is added later, extend it with the two-gate assertions.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { localDatesForProjection, hasFreshPmsEvidence } from '@/app/api/cron/seal-daily/route';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Add one calendar day to a YYYY-MM-DD string (UTC-anchored, reference impl). */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('seal-daily plan_snapshots projection — localDatesForProjection', () => {
  test('returns two ISO dates, tomorrow exactly one day after today', () => {
    for (const tz of ['America/Chicago', 'America/New_York', 'America/Los_Angeles', 'UTC', 'Pacific/Honolulu']) {
      const { today, tomorrow } = localDatesForProjection(tz);
      assert.match(today, ISO, `today for ${tz} should be YYYY-MM-DD`);
      assert.match(tomorrow, ISO, `tomorrow for ${tz} should be YYYY-MM-DD`);
      assert.equal(tomorrow, nextDay(today), `tomorrow must be exactly today+1 for ${tz}`);
    }
  });

  test('today matches the timezone-local calendar day', () => {
    // Independently compute the local day via Intl and assert agreement — this
    // guards against an accidental UTC-only implementation that would be wrong
    // for hotels west of UTC late in the evening / early morning.
    for (const tz of ['America/Chicago', 'America/New_York', 'Asia/Tokyo']) {
      const expectedToday = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const { today } = localDatesForProjection(tz);
      assert.equal(today, expectedToday, `today should equal the ${tz}-local calendar day`);
    }
  });

  test('nextDay reference arithmetic rolls over month/year/leap boundaries', () => {
    // The helper's tomorrow = nextDay(today); verify nextDay itself (the exact
    // noon-UTC-anchor arithmetic the helper uses) across the boundaries most
    // likely to break a naive "+1 to the day field" implementation.
    assert.equal(nextDay('2026-12-31'), '2027-01-01', 'year rollover');
    assert.equal(nextDay('2026-01-31'), '2026-02-01', 'month rollover (31-day)');
    assert.equal(nextDay('2028-02-28'), '2028-02-29', 'leap-year Feb 28 → 29');
    assert.equal(nextDay('2026-02-28'), '2026-03-01', 'non-leap Feb 28 → Mar 1');
    assert.equal(nextDay('2026-03-07'), '2026-03-08', 'ordinary day (US DST-change weekend)');
  });
});

describe('seal-daily positive-evidence gate — hasFreshPmsEvidence', () => {
  // Fixed "now" so the freshness window is deterministic. 24h max age.
  const now = new Date('2026-07-05T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

  test('missing snapshot (dead-robot / manual no-PMS hotel) → no evidence', () => {
    // The exact incident this gate closes: no pms_in_house_snapshot row at all
    // must NOT let the sealer write fabricated 0s.
    assert.equal(hasFreshPmsEvidence(null, now), false);
  });

  test('healthy + fresh snapshot (live robot) → evidence', () => {
    assert.equal(
      hasFreshPmsEvidence(
        { has_error: false, last_good_at: hoursAgo(2), captured_at: hoursAgo(1) },
        now,
      ),
      true,
    );
  });

  test('healthy but STALE snapshot (dead robot, last good > 24h) → no evidence', () => {
    assert.equal(
      hasFreshPmsEvidence(
        { has_error: false, last_good_at: hoursAgo(30), captured_at: hoursAgo(30) },
        now,
      ),
      false,
    );
  });

  test('errored snapshot within 24h → no evidence (untrusted even if recent)', () => {
    assert.equal(
      hasFreshPmsEvidence(
        { has_error: true, last_good_at: hoursAgo(1), captured_at: hoursAgo(1) },
        now,
      ),
      false,
    );
  });

  test('falls back to captured_at when last_good_at is null', () => {
    assert.equal(
      hasFreshPmsEvidence({ has_error: false, last_good_at: null, captured_at: hoursAgo(3) }, now),
      true,
    );
    assert.equal(
      hasFreshPmsEvidence({ has_error: false, last_good_at: null, captured_at: hoursAgo(48) }, now),
      false,
    );
  });

  test('no usable timestamp → no evidence', () => {
    assert.equal(
      hasFreshPmsEvidence({ has_error: false, last_good_at: null, captured_at: null }, now),
      false,
    );
    assert.equal(
      hasFreshPmsEvidence({ has_error: false, last_good_at: 'not-a-date', captured_at: null }, now),
      false,
    );
  });

  test('exactly at the 24h boundary is still fresh', () => {
    assert.equal(
      hasFreshPmsEvidence({ has_error: false, last_good_at: hoursAgo(24), captured_at: null }, now),
      true,
    );
  });
});
