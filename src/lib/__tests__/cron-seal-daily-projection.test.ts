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

import {
  localDatesForProjection,
  hasFreshPmsEvidence,
  preserveSealedOccupancy,
  datesNeedingOccupancyBackfill,
  sealCleaningMinutes,
  type SealedOccupancyFields,
} from '@/lib/seal-daily';
import {
  DEFAULT_CHECKOUT_MINUTES,
  DEFAULT_STAYOVER_DAY1_MINUTES,
  DEFAULT_STAYOVER_DAY2_MINUTES,
  DEFAULT_SHIFT_MINUTES,
} from '@/lib/forecast';

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

describe('seal-daily last-good preservation — preserveSealedOccupancy', () => {
  const real: SealedOccupancyFields = { occupied: 48, checkouts: 21, stayovers: 27, recommended_staff: 4 };
  const allNull: SealedOccupancyFields = { occupied: null, checkouts: null, stayovers: null, recommended_staff: null };

  test('a later NULL tick never erases sealed real values (the boundary-day bug)', () => {
    // Tick 1 sealed real data; tick 2 runs after evidence crossed the 24h
    // staleness line and computes all-NULL. The real values must survive.
    assert.deepEqual(preserveSealedOccupancy(allNull, real), real);
  });

  test('fresh real values overwrite an earlier NULL seal', () => {
    assert.deepEqual(preserveSealedOccupancy(real, allNull), real);
  });

  test('no existing row → computed values pass through unchanged', () => {
    assert.deepEqual(preserveSealedOccupancy(allNull, null), allNull);
    assert.deepEqual(preserveSealedOccupancy(real, null), real);
  });

  test('zero is a real value, not a gap — 0 wins over an existing non-zero', () => {
    // An empty hotel sealing 0 checkouts from live data is truth; NULL is the
    // only "no evidence" marker. ?? (not ||) is load-bearing here.
    const zero: SealedOccupancyFields = { occupied: 0, checkouts: 0, stayovers: 0, recommended_staff: 0 };
    assert.deepEqual(preserveSealedOccupancy(zero, real), zero);
  });

  test('per-field merge — each field preserves independently', () => {
    const partial: SealedOccupancyFields = { occupied: 50, checkouts: null, stayovers: 30, recommended_staff: null };
    assert.deepEqual(
      preserveSealedOccupancy(partial, real),
      { occupied: 50, checkouts: 21, stayovers: 30, recommended_staff: 4 },
    );
  });
});

describe('seal-daily outage repair — datesNeedingOccupancyBackfill', () => {
  const target = '2026-07-10';
  const row = (date: string, co: number | null, so: number | null) => ({ date, checkouts: co, stayovers: so });

  test('no reservation history at all → nothing to backfill (never-connected hotel)', () => {
    assert.deepEqual(
      datesNeedingOccupancyBackfill({ targetDate: target, existing: [], historyFloor: null }),
      [],
    );
  });

  test('missing rows and NULL-checkout rows qualify; sealed rows do not', () => {
    const existing = [
      row('2026-07-09', 20, 30),   // sealed fine
      row('2026-07-08', null, null), // outage day, sealed NULL
      // 2026-07-07 has no row at all (seal never ran)
      row('2026-07-06', 18, 25),   // sealed fine
    ];
    const got = datesNeedingOccupancyBackfill({
      targetDate: target, existing, historyFloor: '2026-07-05', lookbackDays: 5,
    });
    assert.deepEqual(got, ['2026-07-05', '2026-07-07', '2026-07-08']);
  });

  test('dates before the reservation-history floor are excluded (pre-go-live)', () => {
    const got = datesNeedingOccupancyBackfill({
      targetDate: target, existing: [], historyFloor: '2026-07-08', lookbackDays: 14,
    });
    // Only the floor day and later qualify — never a date the robot can't know.
    assert.deepEqual(got, ['2026-07-08', '2026-07-09']);
  });

  test('a row with one NULL of the pair still qualifies for repair', () => {
    const got = datesNeedingOccupancyBackfill({
      targetDate: target, existing: [row('2026-07-09', 20, null)], historyFloor: '2026-07-09', lookbackDays: 3,
    });
    assert.deepEqual(got, ['2026-07-09']);
  });

  test('the target date itself is never a candidate (main seal owns it)', () => {
    const got = datesNeedingOccupancyBackfill({
      targetDate: target, existing: [], historyFloor: '2026-01-01', lookbackDays: 2,
    });
    assert.deepEqual(got, ['2026-07-08', '2026-07-09']);
    assert.ok(!got.includes(target));
  });

  test('fully healed window → empty candidate list (steady-state cheapness)', () => {
    const existing = Array.from({ length: 14 }, (_, i) => {
      const d = new Date('2026-07-10T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - (i + 1));
      return row(d.toISOString().slice(0, 10), 10, 10);
    });
    assert.deepEqual(
      datesNeedingOccupancyBackfill({ targetDate: target, existing, historyFloor: '2026-01-01' }),
      [],
    );
  });
});

describe('seal-daily clean times — sealCleaningMinutes', () => {
  // The bug this covers: the seal read `properties.config.cleaningMinutes`, a
  // column that has never existed, so a hotel's own Settings → Clean Times
  // values NEVER reached the sealed row. Every assertion here is "the hotel's
  // number wins", which is precisely what was broken.
  test("the hotel's own clean times win over the fallbacks", () => {
    const cm = sealCleaningMinutes({
      checkout_minutes: 45,
      stayover_day1_minutes: 18,
      stayover_day2_minutes: 22,
      shift_minutes: 480,
    });
    assert.equal(cm.checkout, 45);
    assert.equal(cm.stayoverDay1, 18);
    assert.equal(cm.stayoverDay2, 22);
    assert.equal(cm.shift, 480);
  });

  test('a vacant-dirty room costs what a checkout costs', () => {
    // Full clean either way, and there is no column for it. If this ever gains
    // its own column, it is a second place to keep right — decide deliberately.
    assert.equal(sealCleaningMinutes({ checkout_minutes: 45 }).vacantDirty, 45);
    assert.equal(sealCleaningMinutes({}).vacantDirty, DEFAULT_CHECKOUT_MINUTES);
  });

  test('a null column falls back to the shared forecast default', () => {
    const cm = sealCleaningMinutes({
      checkout_minutes: null,
      stayover_day1_minutes: null,
      stayover_day2_minutes: null,
      shift_minutes: null,
    });
    assert.equal(cm.checkout, DEFAULT_CHECKOUT_MINUTES);
    assert.equal(cm.stayoverDay1, DEFAULT_STAYOVER_DAY1_MINUTES);
    assert.equal(cm.stayoverDay2, DEFAULT_STAYOVER_DAY2_MINUTES);
    assert.equal(cm.shift, DEFAULT_SHIFT_MINUTES);
  });

  test('a missing row falls back rather than throwing', () => {
    // The read can legitimately come back null (a hotel deleted mid-run).
    // Sealing the fallbacks beats crashing the whole cron for every hotel.
    for (const input of [null, undefined, {}]) {
      const cm = sealCleaningMinutes(input);
      assert.equal(cm.checkout, DEFAULT_CHECKOUT_MINUTES);
      assert.equal(cm.shift, DEFAULT_SHIFT_MINUTES);
    }
  });

  test('a zero or negative shift never reaches the divisor', () => {
    // recommendedHKs divides by cm.shift. A stored 0 is a broken setting, not
    // "a shift takes no time", and dividing by it would seal Infinity.
    assert.equal(sealCleaningMinutes({ shift_minutes: 0 }).shift, DEFAULT_SHIFT_MINUTES);
    assert.equal(sealCleaningMinutes({ shift_minutes: -60 }).shift, DEFAULT_SHIFT_MINUTES);
    assert.equal(sealCleaningMinutes({ checkout_minutes: 0 }).checkout, DEFAULT_CHECKOUT_MINUTES);
  });

  test('NaN in the column does not poison the arithmetic', () => {
    const cm = sealCleaningMinutes({ checkout_minutes: NaN, shift_minutes: NaN });
    assert.equal(cm.checkout, DEFAULT_CHECKOUT_MINUTES);
    assert.equal(cm.shift, DEFAULT_SHIFT_MINUTES);
  });
});
