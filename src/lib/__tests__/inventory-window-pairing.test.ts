/**
 * Tests for the window-integrated prediction↔actual pairing (2026-07-05
 * accuracy pass). The old pairing compared ONE day's forecast against a whole
 * window's average rate — these tests pin the replacement: mean of the daily
 * predictions over the window's own days, coverage-gated, tz-correct.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWindowPairs,
  localDateOf,
  windowDates,
  MIN_WINDOW_COVERAGE,
  type CountWindow,
  type DailyPrediction,
} from '@/lib/inventory-window-pairing';

const win = (over: Partial<CountWindow> = {}): CountWindow => ({
  itemId: 'item-1',
  itemName: 'Bath Towels',
  newerCountId: 'count-9',
  olderLocalDate: '2026-07-01',
  newerLocalDate: '2026-07-08',
  observedRate: 70,
  ...over,
});

const pred = (date: string, rate: number, over: Partial<DailyPrediction> = {}): DailyPrediction => ({
  id: `pred-${date}`,
  itemId: 'item-1',
  date,
  rate,
  modelRunId: 'run-A',
  predictedAt: `${date}T11:00:00Z`,
  ...over,
});

describe('windowDates — half-open (older, newer] day enumeration', () => {
  test('a weekly window yields exactly 7 days, excluding the opening day', () => {
    const days = windowDates('2026-07-01', '2026-07-08');
    assert.equal(days.length, 7);
    assert.equal(days[0], '2026-07-02');
    assert.equal(days[6], '2026-07-08');
  });

  test('sub-day / inverted windows yield nothing', () => {
    assert.deepEqual(windowDates('2026-07-08', '2026-07-08'), []);
    assert.deepEqual(windowDates('2026-07-09', '2026-07-08'), []);
  });

  test('month rollover enumerates correctly', () => {
    assert.deepEqual(windowDates('2026-06-29', '2026-07-02'), ['2026-06-30', '2026-07-01', '2026-07-02']);
  });
});

describe('localDateOf — property-local calendar day', () => {
  test('an evening Central count stays on its local day (UTC would roll over)', () => {
    // 7pm CDT on July 7 = 00:00 UTC July 8. The window must key on July 7.
    assert.equal(localDateOf('2026-07-08T00:00:00Z', 'America/Chicago'), '2026-07-07');
    // The naive UTC slice this replaces would say July 8:
    assert.equal('2026-07-08T00:00:00Z'.slice(0, 10), '2026-07-08');
  });

  test('garbage in → null, never a fabricated date', () => {
    assert.equal(localDateOf('not-a-time', 'America/Chicago'), null);
    assert.equal(localDateOf('2026-07-08T00:00:00Z', 'Not/AZone'), null);
  });
});

describe('buildWindowPairs — window-integrated scoring', () => {
  test('averages the daily predictions over the window days (the core fix)', () => {
    // Daily forecasts swing with day-of-week: Sunday spike at 100, weekdays 60.
    // The realized window rate is the AVERAGE — the pair must compare against
    // the same average (≈65.7), not whichever single day was predicted last.
    const preds = [
      pred('2026-07-02', 60), pred('2026-07-03', 60), pred('2026-07-04', 60),
      pred('2026-07-05', 100), // Sunday
      pred('2026-07-06', 60), pred('2026-07-07', 60), pred('2026-07-08', 60),
    ];
    const { pairs, skippedLowCoverage } = buildWindowPairs([win()], preds);
    assert.equal(skippedLowCoverage, 0);
    assert.equal(pairs.length, 1);
    const expected = (60 * 6 + 100) / 7;
    assert.ok(Math.abs(pairs[0].predictedRate - expected) < 1e-9,
      `predictedRate should be the window mean (${expected}), got ${pairs[0].predictedRate}`);
    // Under the OLD pairing the pair would have been 60 (latest single day) vs
    // observed 65.7 — an 8.7% phantom error on a perfect forecast.
  });

  test('insufficient coverage → no pair, never a distorted one', () => {
    // Predict cron was down most of the week: only 2 of 7 days covered.
    const preds = [pred('2026-07-02', 60), pred('2026-07-03', 60)];
    const { pairs, skippedLowCoverage } = buildWindowPairs([win()], preds);
    assert.equal(pairs.length, 0);
    assert.equal(skippedLowCoverage, 1);
  });

  test('coverage right at the threshold passes', () => {
    // 5 of 7 days = 0.714 ≥ 0.7 → pair forms.
    const preds = ['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06']
      .map((d) => pred(d, 60));
    assert.ok(5 / 7 >= MIN_WINDOW_COVERAGE);
    const { pairs } = buildWindowPairs([win()], preds);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].coveredDays, 5);
    assert.equal(pairs[0].windowDays, 7);
  });

  test('pair is labeled with the NEWEST contributing prediction/model run', () => {
    const preds = [
      pred('2026-07-02', 60, { modelRunId: 'run-OLD', predictedAt: '2026-07-01T11:00:00Z' }),
      pred('2026-07-03', 60, { modelRunId: 'run-OLD', predictedAt: '2026-07-02T11:00:00Z' }),
      pred('2026-07-04', 60, { modelRunId: 'run-OLD', predictedAt: '2026-07-03T11:00:00Z' }),
      pred('2026-07-05', 60, { modelRunId: 'run-OLD', predictedAt: '2026-07-04T11:00:00Z' }),
      pred('2026-07-06', 60, { modelRunId: 'run-NEW', predictedAt: '2026-07-05T11:00:00Z' }),
    ];
    const { pairs } = buildWindowPairs([win()], preds);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].modelRunId, 'run-NEW');
    assert.equal(pairs[0].predictionId, 'pred-2026-07-06');
  });

  test('duplicate predictions for one day keep the newest, not double-weight', () => {
    const preds = [
      ...['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06'].map((d) => pred(d, 60)),
      pred('2026-07-06', 999, { id: 'pred-stale', predictedAt: '2026-07-04T09:00:00Z' }), // older duplicate
    ];
    const { pairs } = buildWindowPairs([win()], preds);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].coveredDays, 5);
    // Mean uses 60 for 07-06 (newest), not 999 (stale duplicate).
    assert.ok(Math.abs(pairs[0].predictedRate - 60) < 1e-9);
  });

  test('predictions for OTHER items never leak into a window', () => {
    const preds = ['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08']
      .map((d) => pred(d, 60, { itemId: 'item-OTHER' }));
    const { pairs, skippedLowCoverage } = buildWindowPairs([win()], preds);
    assert.equal(pairs.length, 0);
    assert.equal(skippedLowCoverage, 1);
  });

  test('non-finite prediction rates are ignored', () => {
    const preds = [
      ...['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06'].map((d) => pred(d, 60)),
      pred('2026-07-07', Number.NaN),
    ];
    const { pairs } = buildWindowPairs([win()], preds);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].coveredDays, 5);
  });

  test('malformed window (inverted dates) is counted, not thrown', () => {
    const bad = win({ olderLocalDate: '2026-07-09', newerLocalDate: '2026-07-08' });
    const { pairs, skippedInvalidWindow } = buildWindowPairs([bad], []);
    assert.equal(pairs.length, 0);
    assert.equal(skippedInvalidWindow, 1);
  });

  test('two items pair independently in one call', () => {
    const w1 = win();
    const w2 = win({ itemId: 'item-2', itemName: 'Coffee Pods', newerCountId: 'count-77', observedRate: 110 });
    const preds = [
      ...windowDates('2026-07-01', '2026-07-08').map((d) => pred(d, 70)),
      ...windowDates('2026-07-01', '2026-07-08').map((d) => pred(d, 108, { itemId: 'item-2', id: `p2-${d}` })),
    ];
    const { pairs } = buildWindowPairs([w1, w2], preds);
    assert.equal(pairs.length, 2);
    const byItem = new Map(pairs.map((p) => [p.itemId, p]));
    assert.ok(Math.abs((byItem.get('item-1')?.predictedRate ?? 0) - 70) < 1e-9);
    assert.ok(Math.abs((byItem.get('item-2')?.predictedRate ?? 0) - 108) < 1e-9);
  });
});
