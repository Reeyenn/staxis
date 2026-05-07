/**
 * Unit tests for the cleaning_events.started_at derivation logic.
 *
 * These tests exist because the derivation is the load-bearing part of
 * the day-2-blank fix Maria reported. Getting it wrong breaks Maria's
 * Performance tab in subtle, silent ways. Don't loosen any of these
 * without thinking carefully about what symptom would re-appear.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  deriveStartedAtPure,
  DEFAULT_DURATION_MIN,
  MAX_GAP_BETWEEN_CLEANINGS_MS,
  MIN_PLAUSIBLE_GAP_MS,
  MIN_DURATION_MS,
} from '../cleaning-event-derivation';

const ISO = (ms: number) => new Date(ms).toISOString();

describe('deriveStartedAtPure', () => {

  // ─── First room of the day ──────────────────────────────────────────

  describe('first room of day (no prior cleaning)', () => {
    test('uses shift anchor when present and within window', () => {
      const completedAt = Date.parse('2026-05-07T16:00:00.000Z');
      const shift = Date.parse('2026-05-07T14:00:00.000Z'); // 2h ago
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: ISO(shift),
        roomType: 'checkout',
      });
      assert.equal(out, ISO(shift), 'should use shift anchor exactly');
    });

    test('falls back to synthetic when no shift anchor', () => {
      const completedAt = Date.parse('2026-05-07T16:00:00.000Z');
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: null,
        roomType: 'checkout',
      });
      const expected = completedAt - DEFAULT_DURATION_MIN.checkout * 60_000;
      assert.equal(out, ISO(expected), 'checkout → 30 min synthetic');
    });

    test('synthetic for stayover is shorter than for checkout', () => {
      const completedAt = Date.parse('2026-05-07T16:00:00.000Z');
      const checkoutOut = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: null,
        roomType: 'checkout',
      });
      const stayoverOut = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: null,
        roomType: 'stayover',
      });
      assert.ok(checkoutOut < stayoverOut, 'checkout fallback older than stayover fallback');
    });
  });

  // ─── Sequential clean-and-Done — the typical case ───────────────────

  describe('typical sequential cleaning', () => {
    test('uses prior completedAt when gap is plausible', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const prior = Date.parse('2026-05-07T16:30:00.000Z'); // 30 min ago
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: ISO(prior),
        shiftStartedAt: ISO(Date.parse('2026-05-07T14:00:00.000Z')),
        roomType: 'checkout',
      });
      assert.equal(out, ISO(prior), 'sequential clean anchors to prior Done');
    });

    test('a one-hour gap is still inside the trust window', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const prior = completedAt - 60 * 60 * 1000; // 1h ago
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: ISO(prior),
        shiftStartedAt: null,
        roomType: 'checkout',
      });
      assert.equal(out, ISO(prior));
    });
  });

  // ─── The rapid-Done bug — primary correctness test ─────────────────

  describe('rapid-Done batch (the bug fix this whole module exists for)', () => {
    test('gap < 3 minutes does NOT anchor to prior, AND skips shift anchor too', () => {
      // Housekeeper finished cleaning rooms 101, 102, 103 at 09:30, 10:00,
      // 10:25 in actual wall-clock. They batched the Dones at 10:25:00,
      // 10:25:01, 10:25:02. The first Done has a real prior anchor; the
      // 2nd and 3rd Done's prior is essentially "now".
      //
      // Critically, falling back to the shift anchor here would produce
      // a multi-hour duration that the classifier marks as flagged or
      // discarded. The right answer is the synthetic per-type fallback,
      // which lands inside the 'recorded' band.
      const completedAt = Date.parse('2026-05-07T15:25:01.000Z');
      const prior = Date.parse('2026-05-07T15:25:00.000Z'); // 1 SECOND ago
      const shift = Date.parse('2026-05-07T13:00:00.000Z'); // 2h25m ago

      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: ISO(prior),
        shiftStartedAt: ISO(shift),
        roomType: 'stayover',
      });

      // Should NOT use the 1-second-ago prior AND must skip the stale
      // shift anchor. Synthetic 20-min fallback for stayover.
      const expectedSynthetic = completedAt - 20 * 60_000;
      assert.equal(
        out,
        ISO(expectedSynthetic),
        'batched Done with shift present must still use synthetic fallback (not shift)',
      );
      const durationMin = (completedAt - new Date(out).getTime()) / 60_000;
      assert.ok(durationMin >= 3 && durationMin <= 60, `duration ${durationMin}min in 'recorded' band`);
    });

    test('gap < 3 minutes with no shift anchor → synthetic fallback', () => {
      const completedAt = Date.parse('2026-05-07T15:25:01.000Z');
      const prior = Date.parse('2026-05-07T15:25:00.000Z'); // 1s ago

      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: ISO(prior),
        shiftStartedAt: null,
        roomType: 'checkout',
      });
      const expected = completedAt - DEFAULT_DURATION_MIN.checkout * 60_000;
      assert.equal(out, ISO(expected), 'no shift anchor → 30-min synthetic');
    });

    test('batched Done MID-DAY does NOT use stale shift anchor', () => {
      // The mid-day batch case. HK started shift at 9am, did 5 rooms in
      // the morning (each got sequential anchor + recorded). At 3pm they
      // batch 3 more Dones within 1 second. The 2nd batched tap has:
      //   • prior = 1s ago → rejected
      //   • shift = 9am (6h ago) → if we used it, duration = 6h →
      //     classifier marks > 90min → DISCARDED. Same Performance-blank
      //     bug as the original day-2 issue.
      // Correct behavior: skip shift, fall to synthetic 30/20-min fallback.
      const completedAt = Date.parse('2026-05-07T20:00:00.000Z'); // 3pm Central
      const prior = completedAt - 1000;                            // 1s ago
      const shift = Date.parse('2026-05-07T14:00:00.000Z');        // 9am Central, 6h ago

      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: ISO(prior),
        shiftStartedAt: ISO(shift),
        roomType: 'checkout',
      });

      // Should be the synthetic fallback (30 min before completedAt for checkout).
      const expectedSynthetic = completedAt - DEFAULT_DURATION_MIN.checkout * 60_000;
      assert.equal(
        out,
        ISO(expectedSynthetic),
        'mid-day batched Done must not use the morning shift anchor',
      );

      const durationMs = completedAt - new Date(out).getTime();
      const durationMin = durationMs / 60_000;
      assert.ok(durationMin >= 3 && durationMin <= 60, `duration ${durationMin}min must be in 'recorded' band`);
    });

    test('gap exactly at MIN_PLAUSIBLE_GAP boundary IS accepted', () => {
      // We want the threshold to be inclusive. 3-min stayovers are real.
      const completedAt = Date.parse('2026-05-07T15:25:00.000Z');
      const prior = completedAt - MIN_PLAUSIBLE_GAP_MS; // exactly 3 min ago

      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: ISO(prior),
        shiftStartedAt: null,
        roomType: 'stayover',
      });
      assert.equal(out, ISO(prior), 'exactly-3-min gap should be trusted');
    });
  });

  // ─── Stale prior or stale shift ─────────────────────────────────────

  describe('stale anchors get rejected', () => {
    test('prior > 4 hours old is ignored — falls to shift anchor', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const prior = completedAt - (5 * 60 * 60 * 1000); // 5h ago
      const shift = completedAt - (2 * 60 * 60 * 1000); // 2h ago
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: ISO(prior),
        shiftStartedAt: ISO(shift),
        roomType: 'checkout',
      });
      assert.equal(out, ISO(shift));
    });

    test('shift > 4 hours old is ignored — falls to synthetic', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const shift = completedAt - (5 * 60 * 60 * 1000); // 5h ago
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: ISO(shift),
        roomType: 'checkout',
      });
      const expected = completedAt - DEFAULT_DURATION_MIN.checkout * 60_000;
      assert.equal(out, ISO(expected));
    });
  });

  // ─── Defensive bounds ───────────────────────────────────────────────

  describe('clamping and bounds', () => {
    test('output is always strictly before completedAt', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: null,
        roomType: 'checkout',
      });
      assert.ok(new Date(out).getTime() < completedAt, 'started_at < completed_at');
    });

    test('output is at least MIN_DURATION before completedAt', () => {
      // Even if the synthetic fallback math were misconfigured, we want a
      // floor on duration to keep cleaning_events CHECK constraints happy.
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: ISO(completedAt - 1000), // 1s ago — would clamp
        roomType: 'checkout',
      });
      const gapMs = completedAt - new Date(out).getTime();
      assert.ok(gapMs >= MIN_DURATION_MS, `gap ${gapMs}ms < MIN_DURATION_MS`);
    });

    test('output is never older than MAX_GAP', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: null,
        roomType: 'checkout',
      });
      const gapMs = completedAt - new Date(out).getTime();
      assert.ok(gapMs <= MAX_GAP_BETWEEN_CLEANINGS_MS, `gap ${gapMs}ms > MAX_GAP`);
    });

    test('throws on invalid completedAt', () => {
      assert.throws(() => {
        deriveStartedAtPure({
          completedAt: 'not-a-date',
          priorCompletedAt: null,
          shiftStartedAt: null,
          roomType: 'checkout',
        });
      });
    });
  });

  // ─── Resilience to corrupt anchor strings ──────────────────────────

  describe('corrupt anchor inputs', () => {
    test('garbage prior is ignored', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: 'not-a-date',
        shiftStartedAt: null,
        roomType: 'checkout',
      });
      const expected = completedAt - DEFAULT_DURATION_MIN.checkout * 60_000;
      assert.equal(out, ISO(expected), 'invalid prior → synthetic fallback');
    });

    test('garbage shift is ignored', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: 'not-a-date',
        roomType: 'checkout',
      });
      const expected = completedAt - DEFAULT_DURATION_MIN.checkout * 60_000;
      assert.equal(out, ISO(expected));
    });

    test('shift in the future is ignored', () => {
      const completedAt = Date.parse('2026-05-07T17:00:00.000Z');
      const futureShift = completedAt + 60_000; // future
      const out = deriveStartedAtPure({
        completedAt: ISO(completedAt),
        priorCompletedAt: null,
        shiftStartedAt: ISO(futureShift),
        roomType: 'checkout',
      });
      const expected = completedAt - DEFAULT_DURATION_MIN.checkout * 60_000;
      assert.equal(out, ISO(expected));
    });
  });
});
