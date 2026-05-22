/**
 * Phase 7 v2 (2026-05-22) — TS cron route helpers for ml-auto-rollback.
 *
 * The route is mostly orchestration: auth → fetch ml-service → loop
 * over rolled-back pairs and write app_events + Sentry. The risky
 * logic worth pinning is:
 *
 *   1. The "fired" classification — a pair counts as a real fire iff
 *      pair.execute?.decision === 'rolled_back' (NOT 'would_fire').
 *      Dry-run events still write app_events but do NOT Sentry-capture.
 *
 *   2. The app_events payload shape — Phase 7.10's
 *      housekeeping-cockpit-rollback-fields test asserts that
 *      payload.dry_run distinguishes real vs would-fire counts.
 *      Here we pin the writer side: real fires write dry_run=false,
 *      would-fire events write dry_run=true.
 *
 * The route's network/auth concerns are covered by the generic
 * api-auth-cron-secret.test.ts. This file only pins the rollback-
 * specific derivation that's load-bearing for the cockpit display.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

interface PairResult {
  property_id: string;
  layer: 'demand' | 'supply';
  decision: string;
  active_mae: number | null;
  baseline_mae: number | null;
  pvalue: number | null;
  adjusted_pvalue: number | null;
  execute?: {
    decision?: string;
    deactivated_model_run_id?: string | null;
    active_model_run_id?: string | null;
    dry_run?: boolean;
    error?: string;
  };
}

// Pure helper mirroring the inline filter in the cron route.
function selectRolledBackPairs(pairs: PairResult[]): PairResult[] {
  return pairs.filter(
    (r) => r.execute?.decision === 'rolled_back' || r.execute?.decision === 'would_fire',
  );
}

function isReadFire(pair: PairResult): boolean {
  return pair.execute?.decision === 'rolled_back';
}

function buildAppEventPayload(pair: PairResult, fired: boolean, requestId: string) {
  return {
    layer: pair.layer,
    active_mae: pair.active_mae,
    baseline_mae: pair.baseline_mae,
    pvalue: pair.pvalue,
    adjusted_pvalue: pair.adjusted_pvalue,
    deactivated_model_run_id: pair.execute?.deactivated_model_run_id ?? null,
    active_model_run_id: pair.execute?.active_model_run_id ?? null,
    dry_run: pair.execute?.dry_run ?? !fired,
    request_id: requestId,
  };
}

describe('selectRolledBackPairs', () => {
  it('selects both rolled_back AND would_fire pairs', () => {
    const pairs: PairResult[] = [
      {
        property_id: 'a', layer: 'demand', decision: 'rollback_indicated',
        active_mae: 5, baseline_mae: 3, pvalue: 0.01, adjusted_pvalue: 0.02,
        execute: { decision: 'rolled_back', dry_run: false },
      },
      {
        property_id: 'b', layer: 'supply', decision: 'rollback_indicated',
        active_mae: 6, baseline_mae: 4, pvalue: 0.02, adjusted_pvalue: 0.04,
        execute: { decision: 'would_fire', dry_run: true },
      },
      {
        property_id: 'c', layer: 'demand', decision: 'no_data',
        active_mae: null, baseline_mae: null, pvalue: null, adjusted_pvalue: null,
      },
      {
        property_id: 'd', layer: 'supply', decision: 'evaluated',
        active_mae: 5, baseline_mae: 6, pvalue: 0.50, adjusted_pvalue: 0.80,
      },
    ];
    const selected = selectRolledBackPairs(pairs);
    assert.equal(selected.length, 2);
    assert.deepEqual(selected.map((p) => p.property_id), ['a', 'b']);
  });

  it('returns empty when no pairs rolled back', () => {
    const pairs: PairResult[] = [
      {
        property_id: 'a', layer: 'demand', decision: 'evaluated',
        active_mae: 5, baseline_mae: 6, pvalue: 0.50, adjusted_pvalue: 0.80,
      },
    ];
    assert.deepEqual(selectRolledBackPairs(pairs), []);
  });
});

describe('isReadFire', () => {
  it('returns true only for rolled_back decision (live mode)', () => {
    assert.equal(
      isReadFire({
        property_id: 'a', layer: 'demand', decision: 'rollback_indicated',
        active_mae: 5, baseline_mae: 3, pvalue: 0.01, adjusted_pvalue: 0.02,
        execute: { decision: 'rolled_back', dry_run: false },
      }),
      true,
    );
  });

  it('returns false for dry-run would_fire decisions', () => {
    assert.equal(
      isReadFire({
        property_id: 'b', layer: 'supply', decision: 'rollback_indicated',
        active_mae: 6, baseline_mae: 4, pvalue: 0.02, adjusted_pvalue: 0.04,
        execute: { decision: 'would_fire', dry_run: true },
      }),
      false,
    );
  });
});

describe('buildAppEventPayload', () => {
  it('marks dry_run=true for would-fire events', () => {
    const payload = buildAppEventPayload(
      {
        property_id: 'a', layer: 'demand', decision: 'rollback_indicated',
        active_mae: 5, baseline_mae: 3, pvalue: 0.01, adjusted_pvalue: 0.02,
        execute: { decision: 'would_fire', dry_run: true },
      },
      false, // not fired = dry-run
      'req-1',
    );
    assert.equal(payload.dry_run, true);
    assert.equal(payload.layer, 'demand');
    assert.equal(payload.request_id, 'req-1');
  });

  it('marks dry_run=false for real fires', () => {
    const payload = buildAppEventPayload(
      {
        property_id: 'a', layer: 'supply', decision: 'rollback_indicated',
        active_mae: 5, baseline_mae: 3, pvalue: 0.01, adjusted_pvalue: 0.02,
        execute: {
          decision: 'rolled_back',
          dry_run: false,
          deactivated_model_run_id: 'mr-1',
          active_model_run_id: 'mr-1',
        },
      },
      true,
      'req-2',
    );
    assert.equal(payload.dry_run, false);
    assert.equal(payload.deactivated_model_run_id, 'mr-1');
  });

  it('defaults dry_run to !fired when execute.dry_run is undefined', () => {
    const payload = buildAppEventPayload(
      {
        property_id: 'a', layer: 'demand', decision: 'rollback_indicated',
        active_mae: 5, baseline_mae: 3, pvalue: 0.01, adjusted_pvalue: 0.02,
        execute: { decision: 'rolled_back' }, // no dry_run field
      },
      true,
      'req-3',
    );
    // fired=true → !fired=false → dry_run defaults to false. Good: a
    // real fire never accidentally writes dry_run=true.
    assert.equal(payload.dry_run, false);
  });
});
