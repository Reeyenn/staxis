/**
 * The AI books must survive being summarised.
 *
 * The headline test is `a spend total is identical before and after rollup +
 * prune` — if that ever fails, money has silently left the books, which is the
 * one outcome the whole rollup design exists to prevent.
 *
 * These drive the real fold (src/lib/ai/cost-rollup.ts), which is the twin of
 * the SQL in migration 0375. Behaviour, not source text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  foldRawRows,
  sumRawMicros,
  sumGrainMicros,
  verifyFold,
  usdToMicros,
  microsToUsd,
  monthKey,
  pruneCutoffMonth,
  checkRetentionCoversReadWindows,
  RAW_RETENTION_MONTHS,
  LONGEST_READER_WINDOW_DAYS,
  type RawCostRow,
} from '@/lib/ai/cost-rollup';

/** A fixture row with sensible defaults; override only what the test is about. */
function row(over: Partial<RawCostRow> & { cost_usd: string; created_at: string }): RawCostRow {
  return {
    property_id: 'prop-a',
    feature: 'agent.ask_staxis',
    model: 'claude-opus-5',
    kind: 'request',
    state: 'finalized',
    swept_at: null,
    tokens_in: 10,
    tokens_out: 20,
    cached_input_tokens: 0,
    ...over,
  };
}

/**
 * A deliberately awkward ledger: six-decimal values, repeated cents, several
 * properties/features/models, both states, a swept hold, and rows spread over
 * four months. Values chosen because they are exactly the ones that drift when
 * summed as floats (0.1 + 0.2 !== 0.3).
 */
function fixture(): RawCostRow[] {
  return [
    row({ cost_usd: '0.100000', created_at: '2026-01-05T10:00:00Z' }),
    row({ cost_usd: '0.200000', created_at: '2026-01-06T10:00:00Z' }),
    row({ cost_usd: '0.000007', created_at: '2026-01-07T10:00:00Z' }),
    row({ cost_usd: '0.000003', created_at: '2026-01-08T10:00:00Z' }),
    row({ cost_usd: '1.234567', created_at: '2026-02-01T00:00:00Z', feature: 'findings.judge' }),
    row({ cost_usd: '2.765433', created_at: '2026-02-14T23:59:59Z', feature: 'findings.judge' }),
    row({ cost_usd: '0.500000', created_at: '2026-02-20T10:00:00Z', property_id: 'prop-b' }),
    row({ cost_usd: '0.333333', created_at: '2026-03-02T10:00:00Z', model: 'gpt-5.4-mini' }),
    row({ cost_usd: '0.666667', created_at: '2026-03-03T10:00:00Z', model: 'gpt-5.4-mini', kind: 'background' }),
    // A hold that timed out and was zeroed — not money, but it must survive the
    // fold as its own grain because some readers count it and others don't.
    row({ cost_usd: '0.000000', created_at: '2026-03-04T10:00:00Z', state: 'finalized', swept_at: '2026-03-04T10:05:00Z' }),
    // A live reservation.
    row({ cost_usd: '0.050000', created_at: '2026-03-05T10:00:00Z', state: 'reserved' }),
    // Unattributed history — pre-0374 rows have no feature and must stay that way.
    row({ cost_usd: '0.010000', created_at: '2026-04-01T10:00:00Z', feature: null }),
  ];
}

describe('agent_costs monthly rollup', () => {
  describe('exact money arithmetic', () => {
    it('parses numeric(10,6) without float drift', () => {
      // The canonical float trap: as doubles these do not sum to 0.3.
      assert.equal(usdToMicros('0.1') + usdToMicros('0.2'), usdToMicros('0.3'));
      assert.equal(usdToMicros('0.000007'), 7);
      assert.equal(usdToMicros('1.234567'), 1_234_567);
      assert.equal(usdToMicros('0'), 0);
      assert.equal(usdToMicros(0.5), 500_000);
    });

    it('round-trips micros back to a decimal string', () => {
      assert.equal(microsToUsd(1_234_567), '1.234567');
      assert.equal(microsToUsd(7), '0.000007');
      assert.equal(microsToUsd(0), '0.000000');
    });

    it('refuses a malformed cost rather than silently booking zero', () => {
      assert.throws(() => usdToMicros('not-a-number'), /numeric/);
      assert.throws(() => usdToMicros(''), /numeric/);
    });
  });

  describe('the fold', () => {
    it('THE INVARIANT: a spend total is identical before and after rollup + prune', () => {
      const raw = fixture();
      const totalBefore = sumRawMicros(raw);

      // Roll every month up.
      const grains = foldRawRows(raw);

      // Now prune: throw away every raw row from the two oldest months, exactly
      // as the cron does once those months are verified.
      const prunedMonths = new Set(['2026-01-01', '2026-02-01']);
      const survivingRaw = raw.filter((r) => !prunedMonths.has(monthKey(r.created_at)));
      const grainsForPrunedMonths = grains.filter((g) => prunedMonths.has(g.month));

      // What any honest "total spend ever" answer is made of afterwards.
      const totalAfter =
        sumRawMicros(survivingRaw) + sumGrainMicros(grainsForPrunedMonths);

      assert.equal(
        totalAfter, totalBefore,
        'summarising and pruning changed the books — money appeared or vanished',
      );
      // And byte-identical as the rendered decimal a screen would print.
      assert.equal(microsToUsd(totalAfter), microsToUsd(totalBefore));
    });

    it('reproduces the raw sum and row count exactly, so verification passes', () => {
      const raw = fixture();
      const grains = foldRawRows(raw);
      const v = verifyFold(raw, grains);
      assert.equal(v.verified, true);
      assert.equal(v.grainMicros, v.rawMicros);
      assert.equal(v.grainRows, raw.length);
    });

    it('refuses to verify when a grain has been tampered with', () => {
      // The interlock must actually catch a mismatch — otherwise `verified_at`
      // would be stamped on a bad fold and the pruner would delete good rows.
      const raw = fixture();
      const grains = foldRawRows(raw);
      grains[0].cost_micros += 1; // one micro-dollar out
      const v = verifyFold(raw, grains);
      assert.equal(v.verified, false, 'a one-micro-dollar discrepancy must fail verification');
    });

    it('keeps every dimension a live reader groups or filters by', () => {
      const grains = foldRawRows(fixture());

      // Two different models in March must not collapse into one grain.
      const march = grains.filter((g) => g.month === '2026-03-01');
      assert.ok(march.length >= 3, 'March grains should split by model/kind/state');

      // A swept hold stays distinguishable from a real zero-cost row.
      assert.ok(grains.some((g) => g.swept === true), 'swept rows keep their own grain');
      // Reserved stays distinguishable from finalized.
      assert.ok(grains.some((g) => g.state === 'reserved'), 'reserved rows keep their own grain');
      // Per-property separation survives.
      assert.ok(grains.some((g) => g.property_id === 'prop-b'), 'per-hotel spend survives the fold');
    });

    it('keeps unattributed history unattributed rather than inventing a bucket', () => {
      const grains = foldRawRows(fixture());
      const unattributed = grains.filter((g) => g.feature === null);
      assert.equal(unattributed.length, 1);
      assert.equal(unattributed[0].month, '2026-04-01');
      // Pre-0374 money is real money and must still be counted.
      assert.equal(unattributed[0].cost_micros, 10_000);
    });

    it('buckets by UTC month, with month edges landing on the right side', () => {
      const grains = foldRawRows([
        row({ cost_usd: '1.000000', created_at: '2026-02-01T00:00:00Z' }),
        row({ cost_usd: '2.000000', created_at: '2026-01-31T23:59:59Z' }),
      ]);
      const byMonth = Object.fromEntries(grains.map((g) => [g.month, g.cost_micros]));
      assert.equal(byMonth['2026-02-01'], 1_000_000);
      assert.equal(byMonth['2026-01-01'], 2_000_000);
    });

    it('records the true span of each grain, which is what keeps "attributed since" honest', () => {
      const jan = foldRawRows(fixture()).filter((g) => g.month === '2026-01-01');
      const earliest = jan.map((g) => g.earliest_created_at).sort()[0];
      assert.equal(earliest, '2026-01-05T10:00:00Z');
    });

    it('folds an empty ledger to nothing, and verifies', () => {
      const grains = foldRawRows([]);
      assert.equal(grains.length, 0);
      assert.equal(verifyFold([], grains).verified, true);
    });
  });

  describe('the retention window', () => {
    it('covers the longest window any live spend screen reads', () => {
      // This is why /admin/ai-staff and Mission Control needed no changes: they
      // read 30 days, retention is 6 months, so they never cross the boundary.
      assert.doesNotThrow(() => checkRetentionCoversReadWindows());
      assert.ok(RAW_RETENTION_MONTHS * 28 > LONGEST_READER_WINDOW_DAYS);
    });

    it('throws if someone shortens retention below what a screen reads', () => {
      // The guard has to actually fire, or it is decoration.
      assert.throws(
        () => checkRetentionCoversReadWindows(1, 30),
        /does not cover the longest spend read window/,
      );
      assert.throws(() => checkRetentionCoversReadWindows(3, 90), /does not cover/);
    });

    it('never marks the current or recent months prunable', () => {
      const now = new Date('2026-07-27T00:00:00Z');
      const cutoff = pruneCutoffMonth(now, RAW_RETENTION_MONTHS);
      assert.equal(cutoff, '2026-01-01');
      // The current month is far above the cutoff, so it can never be pruned.
      assert.ok(monthKey(now.toISOString()) > cutoff);
      // A month inside the window is not prunable either.
      assert.ok('2026-06-01' > cutoff);
      // Something genuinely old is.
      assert.ok('2025-11-01' < cutoff);
    });

    it('handles a year boundary when computing the cutoff', () => {
      const cutoff = pruneCutoffMonth(new Date('2026-02-10T00:00:00Z'), 6);
      assert.equal(cutoff, '2025-08-01');
    });
  });
});
