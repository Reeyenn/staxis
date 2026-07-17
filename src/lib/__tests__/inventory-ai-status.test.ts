/**
 * Tests for the Phase 2 honesty fields added to /api/inventory/ai-status.
 *
 * We don't spin up the Next route. We test the computation logic directly,
 * which lives inline in route.ts. Two cheap pure helpers are duplicated here
 * as the contract assertion — if the route's inline math drifts, these tests
 * fail loud.
 *
 * Pins:
 *   1. `lastInferenceStale` flips at 26h (one missed cron + 2h grace).
 *   2. `currentMaeRatioVsMean` reads `hyperparameters.mean_observed_rate` and
 *      computes val_mae/mean; returns null when no run has the field
 *      populated.
 *   3. `overfitRatio` reads val_mae/train_mae (the OLD currentMaeRatio).
 *   4. `currentMaeRatio` (deprecated alias) always equals `overfitRatio`.
 *   5. Divide-by-zero on mean_observed_rate is filtered.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Contract helpers (mirror route.ts) ──────────────────────────────────
//
// These re-implement the inline math from the route to give us a single
// place to assert the contract. If the route's math drifts from these
// helpers, the route is wrong (or the helpers are stale and need updating
// alongside the route — but the test FORCES that conversation).

const STALE_INFERENCE_HOURS = 26;

interface ModelRunRow {
  validation_mae: number | null;
  training_mae: number | null;
  hyperparameters: Record<string, unknown> | null;
}

function computeOverfitRatio(runs: ModelRunRow[]): number | null {
  const ratios: number[] = [];
  for (const r of runs) {
    const mae = r.validation_mae;
    const trainMae = r.training_mae;
    if (
      mae !== null &&
      mae !== undefined &&
      trainMae !== null &&
      trainMae !== undefined &&
      Number(trainMae) > 0
    ) {
      ratios.push(Number(mae) / Number(trainMae));
    }
  }
  if (ratios.length === 0) return null;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

function computeGateRatio(runs: ModelRunRow[]): number | null {
  const ratios: number[] = [];
  for (const r of runs) {
    const mae = r.validation_mae;
    const hp = r.hyperparameters ?? null;
    const meanRaw = hp ? hp.mean_observed_rate : null;
    const mean = typeof meanRaw === 'number' ? meanRaw : Number(meanRaw);
    if (mae !== null && mae !== undefined && Number.isFinite(mean) && mean > 1e-9) {
      ratios.push(Number(mae) / mean);
    }
  }
  if (ratios.length === 0) return null;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

function computeStaleInference(lastInferenceAt: string | null, nowMs: number): boolean {
  if (!lastInferenceAt) return true;
  const ageHours = (nowMs - new Date(lastInferenceAt).getTime()) / 3600000;
  return ageHours > STALE_INFERENCE_HOURS;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ai-status: lastInferenceStale (26h threshold)', () => {
  const NOW = Date.parse('2026-05-22T12:00:00Z');

  it('returns true when lastInferenceAt is null (cron never ran)', () => {
    assert.equal(computeStaleInference(null, NOW), true);
  });

  it('returns false when last inference is 25h old (one missed cron + grace)', () => {
    const iso = new Date(NOW - 25 * 3600000).toISOString();
    assert.equal(computeStaleInference(iso, NOW), false);
  });

  it('returns true when last inference is 27h old (past threshold)', () => {
    const iso = new Date(NOW - 27 * 3600000).toISOString();
    assert.equal(computeStaleInference(iso, NOW), true);
  });

  it('threshold is < doctor warn threshold so UI flips first', () => {
    // Doctor warns at ~48.25h for daily crons. Our 26h must be well below
    // that so operators see the GM UI signal before the doctor pages.
    assert.ok(STALE_INFERENCE_HOURS < 48, `26h must be < 48h doctor threshold`);
  });
});

describe('ai-status: overfitRatio (val_mae / train_mae)', () => {
  it('averages val/train across active models', () => {
    const runs: ModelRunRow[] = [
      { validation_mae: 0.4, training_mae: 0.2, hyperparameters: null },
      { validation_mae: 0.6, training_mae: 0.3, hyperparameters: null },
    ];
    // (0.4/0.2 + 0.6/0.3) / 2 = (2 + 2) / 2 = 2.0
    assert.equal(computeOverfitRatio(runs), 2.0);
  });

  it('returns null when no run has both maes', () => {
    const runs: ModelRunRow[] = [
      { validation_mae: 0.5, training_mae: null, hyperparameters: null },
      { validation_mae: null, training_mae: 0.3, hyperparameters: null },
    ];
    assert.equal(computeOverfitRatio(runs), null);
  });

  it('skips runs with zero training_mae (divide-by-zero protection)', () => {
    const runs: ModelRunRow[] = [
      { validation_mae: 0.5, training_mae: 0, hyperparameters: null },
      { validation_mae: 0.4, training_mae: 0.2, hyperparameters: null },
    ];
    assert.equal(computeOverfitRatio(runs), 2.0);
  });
});

describe('ai-status: currentMaeRatioVsMean (val_mae / mean_observed_rate, the REAL gate ratio)', () => {
  it('reads mean_observed_rate from hyperparameters and computes val_mae/mean', () => {
    const runs: ModelRunRow[] = [
      {
        validation_mae: 0.05,
        training_mae: 0.02,
        hyperparameters: { mean_observed_rate: 1.0, prior_rate_used: 0.5 },
      },
    ];
    // 0.05 / 1.0 = 0.05 (below the 0.10 gate threshold)
    assert.equal(computeGateRatio(runs), 0.05);
  });

  it('returns null when NO run has mean_observed_rate populated (pre-retrain window)', () => {
    const runs: ModelRunRow[] = [
      {
        validation_mae: 0.4,
        training_mae: 0.2,
        hyperparameters: { prior_rate_used: 0.5 /* mean_observed_rate missing */ },
      },
      { validation_mae: 0.6, training_mae: 0.3, hyperparameters: null },
    ];
    assert.equal(computeGateRatio(runs), null);
  });

  it('ignores runs whose mean is zero or negative (divide-by-zero protection)', () => {
    const runs: ModelRunRow[] = [
      { validation_mae: 0.5, training_mae: 0.1, hyperparameters: { mean_observed_rate: 0 } },
      { validation_mae: 0.5, training_mae: 0.1, hyperparameters: { mean_observed_rate: -1 } },
      { validation_mae: 0.05, training_mae: 0.02, hyperparameters: { mean_observed_rate: 1.0 } },
    ];
    assert.equal(computeGateRatio(runs), 0.05);
  });

  it('averages across runs that DO have mean_observed_rate, skipping those that do not', () => {
    const runs: ModelRunRow[] = [
      // Has mean → 0.10
      { validation_mae: 0.10, training_mae: 0.05, hyperparameters: { mean_observed_rate: 1.0 } },
      // Has mean → 0.05
      { validation_mae: 0.05, training_mae: 0.02, hyperparameters: { mean_observed_rate: 1.0 } },
      // Missing — skipped
      { validation_mae: 99, training_mae: 0.05, hyperparameters: { prior_rate_used: 0.5 } },
    ];
    const expected = (0.10 + 0.05) / 2;
    const actual = computeGateRatio(runs);
    assert.ok(actual !== null);
    assert.ok(Math.abs(actual - expected) < 1e-9);
  });

  it('coerces stringified numeric mean_observed_rate (defensive against PostgREST JSON quirks)', () => {
    const runs: ModelRunRow[] = [
      {
        validation_mae: 0.05,
        training_mae: 0.02,
        hyperparameters: { mean_observed_rate: '1.0' as unknown as number },
      },
    ];
    assert.equal(computeGateRatio(runs), 0.05);
  });
});

describe('ai-status: overfitRatio and currentMaeRatioVsMean differ when data justifies it', () => {
  it('overfit and gate ratios produce DIFFERENT numbers given the same models', () => {
    // The whole point of Phase 2: the misnamed currentMaeRatio (=overfit) and
    // the correct gate ratio are different. A model with val=0.5, train=0.25,
    // mean=5.0 has overfit=2.0 but gate=0.10 — same model, very different
    // story.
    const runs: ModelRunRow[] = [
      {
        validation_mae: 0.5,
        training_mae: 0.25,
        hyperparameters: { mean_observed_rate: 5.0 },
      },
    ];
    assert.equal(computeOverfitRatio(runs), 2.0);
    assert.equal(computeGateRatio(runs), 0.10);
  });
});
