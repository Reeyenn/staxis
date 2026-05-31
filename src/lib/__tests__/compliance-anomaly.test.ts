/**
 * Unit tests for the v2 leak/spike anomaly math (src/lib/compliance/anomaly.ts).
 * The cold-start gate (no false alarms on day 1) and the spike/flatline/drift
 * detectors are the highest-risk logic in the feature.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeReading, type AnomalyTypeInfo, type HistoryPoint } from '@/lib/compliance/anomaly';

const POOL: AnomalyTypeInfo = { category: 'pool', name: 'Pool — pH', unit: 'pH', minValue: 7.2, maxValue: 7.8 };
const WATER: AnomalyTypeInfo = { category: 'utility_meter', name: 'Water meter', unit: 'gal', minValue: null, maxValue: null };

// Build history points with increasing timestamps (1 day apart).
const h = (vals: number[]): HistoryPoint[] => vals.map((value, i) => ({ value, at: i * 86_400_000 }));
const after = (n: number, value: number): HistoryPoint => ({ value, at: n * 86_400_000 });

describe('cold-start (no false alarms before a stable baseline)', () => {
  test('point: too little history → learning', () => {
    const out = analyzeReading(POOL, h([7.5, 7.4, 7.6, 7.5]), after(4, 7.5));
    assert.equal(out.state, 'learning');
  });
  test('meter: too few intervals → learning', () => {
    const out = analyzeReading(WATER, h([0, 10, 20]), after(3, 30));
    assert.equal(out.state, 'learning');
  });
});

describe('point readings', () => {
  test('stable value → normal', () => {
    const out = analyzeReading(POOL, h([7.5, 7.48, 7.52, 7.5, 7.49, 7.51, 7.5, 7.48, 7.52, 7.5]), after(10, 7.51));
    assert.equal(out.state, 'normal');
  });
  test('big jump vs baseline → spike', () => {
    const out = analyzeReading(POOL, h([7.5, 7.48, 7.52, 7.5, 7.49, 7.51, 7.5, 7.48, 7.52, 7.5]), after(10, 9.0));
    assert.equal(out.state, 'anomaly');
    if (out.state === 'anomaly') assert.equal(out.result.kind, 'spike');
  });
  test('stuck sensor (recent run identical, history normally varies) → flatline', () => {
    // 5 older varied reads, then 5 recent identical 7.5; current also 7.5.
    const out = analyzeReading(POOL, h([7.2, 7.8, 7.3, 7.7, 7.4, 7.5, 7.5, 7.5, 7.5, 7.5]), after(10, 7.5));
    assert.equal(out.state, 'anomaly');
    if (out.state === 'anomaly') assert.equal(out.result.kind, 'flatline');
  });
  test('monotonic climb toward the max limit → drift', () => {
    const prior = h([7.25, 7.3, 7.35, 7.4, 7.45, 7.5, 7.55, 7.6, 7.65, 7.7]);
    const out = analyzeReading(POOL, prior, after(10, 7.75));
    assert.equal(out.state, 'anomaly');
    if (out.state === 'anomaly') assert.equal(out.result.kind, 'drift');
  });
});

describe('cumulative meter readings', () => {
  test('normal consumption → normal', () => {
    const out = analyzeReading(WATER, h([0, 10, 20, 30, 40, 50, 60]), after(7, 70));
    assert.equal(out.state, 'normal');
  });
  test('consumption spike (4× normal) → spike + high-confidence leak', () => {
    const out = analyzeReading(WATER, h([0, 10, 20, 30, 40, 50, 60]), after(7, 100));
    assert.equal(out.state, 'anomaly');
    if (out.state === 'anomaly') {
      assert.equal(out.result.kind, 'spike');
      assert.equal(out.result.highConfidenceLeak, true);
      assert.equal(out.result.severity, 'critical');
    }
  });
  test('meter stopped moving (deltas ≈ 0) → flatline', () => {
    const out = analyzeReading(WATER, h([0, 10, 20, 30, 40, 50, 60, 60, 60]), after(9, 60));
    assert.equal(out.state, 'anomaly');
    if (out.state === 'anomaly') assert.equal(out.result.kind, 'flatline');
  });

  // Codex review/adversarial regressions:
  test('uneven spacing (3-day gap, same daily RATE) → normal, NOT a false leak', () => {
    // 50/day baseline, then a reading 3 days late with delta 150 → rate still 50/day.
    const out = analyzeReading(WATER, h([0, 50, 100, 150, 200, 250, 300]), after(9, 450));
    assert.equal(out.state, 'normal');
  });
  test('meter reset/rollover → learning (baseline rebuilds; no bogus leak/work order)', () => {
    // Steady 50/day, then a reset to 10, then 110 — must NOT fire a leak.
    const out = analyzeReading(WATER, h([1000, 1050, 1100, 1150, 1200, 1250, 1300, 10]), after(8, 110));
    assert.equal(out.state, 'learning');
  });
});
