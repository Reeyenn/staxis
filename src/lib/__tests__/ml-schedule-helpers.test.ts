/**
 * Phase 1.3 (2026-05-22) — derivation of `modelKind` from the optimizer's
 * `inputs_snapshot`. Drives the Schedule tab's headline label branch
 * between "AI recommendation" (fitted) and "Industry estimate · learning"
 * (warming-up / capacity-unavailable).
 *
 * Three derivation cases + the backward-compat default for pre-Phase-1.2
 * rows that don't carry the new flags.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveModelKind, parseInputsSnapshot } from '../ml-schedule-helpers';

describe('deriveModelKind', () => {
  it('returns fitted when both layers are fitted AND L2 was used', () => {
    const { modelKind, warmupReason } = deriveModelKind({
      l1_is_cold_start: false,
      l2_any_cold_start: false,
      used_l2_supply: true,
      l2_prediction_count: 60,
    });
    assert.equal(modelKind, 'fitted');
    assert.equal(warmupReason, null);
  });

  it('returns warming-up when L1 is cold-start', () => {
    const { modelKind, warmupReason } = deriveModelKind({
      l1_is_cold_start: true,
      l2_any_cold_start: false,
      used_l2_supply: true,
      l2_prediction_count: 60,
    });
    assert.equal(modelKind, 'warming-up');
    assert.ok(warmupReason && warmupReason.includes('cold-start'));
  });

  it('returns warming-up when L2 is cold-start', () => {
    const { modelKind } = deriveModelKind({
      l1_is_cold_start: false,
      l2_any_cold_start: true,
      used_l2_supply: true,
      l2_prediction_count: 60,
    });
    assert.equal(modelKind, 'warming-up');
  });

  it('returns capacity-unavailable when used_l2_supply is false (even if L1 is fitted)', () => {
    const { modelKind, warmupReason } = deriveModelKind({
      l1_is_cold_start: false,
      l2_any_cold_start: false,
      used_l2_supply: false,
      l2_prediction_count: 5,
    });
    assert.equal(modelKind, 'capacity-unavailable');
    assert.ok(warmupReason && warmupReason.includes('capacity model unavailable'));
  });

  it('returns warming-up for pre-Phase-1.2 rows that lack the flags (fail-honest)', () => {
    const { modelKind, warmupReason } = deriveModelKind({});
    assert.equal(modelKind, 'warming-up');
    assert.ok(warmupReason && warmupReason.includes('pre-phase-1.2'));
  });

  it('treats truthy-but-not-true values as not cold-start (strict equality)', () => {
    // Defensive: a row that has the keys set to 0 / null / undefined
    // must classify as fitted, not warming-up, because the flags are
    // booleans on the writer side. The derivation must not be tricked
    // by JSON-roundtrip artifacts.
    const { modelKind } = deriveModelKind({
      l1_is_cold_start: 0 as unknown,
      l2_any_cold_start: null as unknown,
      used_l2_supply: true,
      l2_prediction_count: 30,
    });
    assert.equal(modelKind, 'fitted');
  });
});

describe('parseInputsSnapshot', () => {
  it('returns the object as-is when given an object', () => {
    const snap = parseInputsSnapshot({ l1_is_cold_start: true });
    assert.equal(snap.l1_is_cold_start, true);
  });

  it('parses a JSON string into an object', () => {
    const snap = parseInputsSnapshot('{"l1_is_cold_start":true}');
    assert.equal(snap.l1_is_cold_start, true);
  });

  it('returns empty object on malformed JSON', () => {
    const snap = parseInputsSnapshot('{not json');
    assert.deepEqual(snap, {});
  });

  it('returns empty object on null / undefined / array', () => {
    assert.deepEqual(parseInputsSnapshot(null), {});
    assert.deepEqual(parseInputsSnapshot(undefined), {});
    assert.deepEqual(parseInputsSnapshot([1, 2, 3]), {});
  });
});
