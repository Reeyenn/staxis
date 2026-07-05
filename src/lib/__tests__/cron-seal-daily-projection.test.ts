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

import { localDatesForProjection } from '@/app/api/cron/seal-daily/route';

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
