/**
 * Phase 2.2 (2026-05-22) — parseArtifact defensive shape narrowing.
 *
 * The backtest-status admin route reads a JSON artifact from Supabase
 * Storage. The artifact is written by ml-service/scripts/backtest_housekeeping.py
 * and follows the BacktestResult dataclass shape. If a future change to
 * the writer adds a new field, the reader must still produce a usable
 * response. If a malformed artifact lands, the reader must return null
 * rather than crash.
 *
 * The route itself (auth gate, storage list/download) is covered by
 * the generic admin-route auth tests; this file only pins the parser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArtifact } from '@/lib/housekeeping/backtest-artifact';

describe('parseArtifact', () => {
  it('returns null for non-object inputs', () => {
    assert.equal(parseArtifact(null), null);
    assert.equal(parseArtifact('not a json object'), null);
    assert.equal(parseArtifact(123), null);
    assert.equal(parseArtifact([1, 2, 3]), null);
  });

  it('returns null when run_date is missing', () => {
    assert.equal(parseArtifact({ layer: 'demand', weeks: 8 }), null);
  });

  it('returns null when layer is not demand or supply', () => {
    assert.equal(parseArtifact({
      run_date: '2026-05-22', layer: 'optimizer', weeks: 8,
    }), null);
  });

  it('returns null when weeks is non-numeric', () => {
    assert.equal(parseArtifact({
      run_date: '2026-05-22', layer: 'demand', weeks: 'eight',
    }), null);
  });

  it('parses a complete fitted-result artifact', () => {
    const raw = {
      run_date: '2026-05-22',
      layer: 'demand',
      weeks: 8,
      fitted_only_mae: 4.5,
      fitted_only_mae_ratio: 0.045,
      all_days_mae: 12.3,
      quantile_coverage_80: 0.82,
      beats_baseline_pct: 0.34,
      days_total: 56,
      days_fitted: 42,
      days_cold_start: 12,
      days_insufficient_data: 2,
      refusal_reason: null,
      summary: 'demand walk-forward MAE…',
    };
    const parsed = parseArtifact(raw);
    assert.ok(parsed);
    assert.equal(parsed.runDate, '2026-05-22');
    assert.equal(parsed.layer, 'demand');
    assert.equal(parsed.weeks, 8);
    assert.equal(parsed.fittedOnlyMae, 4.5);
    assert.equal(parsed.fittedOnlyMaeRatio, 0.045);
    assert.equal(parsed.daysFitted, 42);
    assert.equal(parsed.daysColdStart, 12);
    assert.equal(parsed.refusalReason, null);
  });

  it('parses a refused artifact (INSUFFICIENT_FITTED_DATA)', () => {
    const raw = {
      run_date: '2026-05-22',
      layer: 'supply',
      weeks: 8,
      all_days_mae: 380.2,
      fitted_only_mae: null,
      fitted_only_mae_ratio: null,
      quantile_coverage_80: null,
      beats_baseline_pct: null,
      days_total: 33,
      days_fitted: 5,
      days_cold_start: 28,
      days_insufficient_data: 0,
      refusal_reason: 'INSUFFICIENT_FITTED_DATA',
      summary: 'INSUFFICIENT_FITTED_DATA — only 5 fitted days…',
    };
    const parsed = parseArtifact(raw);
    assert.ok(parsed);
    assert.equal(parsed.refusalReason, 'INSUFFICIENT_FITTED_DATA');
    assert.equal(parsed.fittedOnlyMae, null);
    assert.equal(parsed.fittedOnlyMaeRatio, null);
    assert.equal(parsed.daysFitted, 5);
    assert.equal(parsed.daysColdStart, 28);
  });

  it('tolerates extra unknown fields (forward-compat)', () => {
    const raw = {
      run_date: '2026-05-22',
      layer: 'demand',
      weeks: 8,
      future_field: 'whatever',
      another_one: { nested: true },
    };
    const parsed = parseArtifact(raw);
    assert.ok(parsed);
    assert.equal(parsed.weeks, 8);
  });

  it('coerces non-finite numerics to null', () => {
    const raw = {
      run_date: '2026-05-22',
      layer: 'demand',
      weeks: 8,
      fitted_only_mae: NaN,
      fitted_only_mae_ratio: Infinity,
    };
    const parsed = parseArtifact(raw);
    assert.ok(parsed);
    assert.equal(parsed.fittedOnlyMae, null);
    assert.equal(parsed.fittedOnlyMaeRatio, null);
  });
});
