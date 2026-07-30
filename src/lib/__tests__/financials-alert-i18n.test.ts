/**
 * Financials bug-fix regression tests (staff-pages overhaul, wave-1 fixes).
 *
 * Run via: npx tsx --test src/lib/__tests__/financials-alert-i18n.test.ts
 *
 * Covers the extractable pure logic behind three verified bugs:
 *
 * 1. Forecast/anomaly APIs return English `message` strings. BudgetTab
 *    rebuilds them client-side from structured fields; the rebuild must stay
 *    byte-identical to the server sentences.
 *
 * 2. Scan error mapping — ScanButton collapsed every failure into "try a
 *    clearer photo"; scanErrorLabel now routes rate-limit (429), the daily
 *    AI budget cap (user_cap/property_cap/global_cap), and vision-service
 *    outages (503 / vision_unavailable / vision_failed) to honest messages.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { forecastDepartmentOverspend } from '../financials/forecast';
import { detectDepartmentSpikes } from '../financials/anomaly';
import { forecastTrendingMsg, anomalySpikeMsg, scanErrorLabel, ft } from '../../app/financials/_components/fin-i18n';

describe('forecastTrendingMsg', () => {
  test('EN rebuild is byte-identical to the server-built sentence', () => {
    // Server side: 10 days elapsed of 30, $2,000 spent, $3,200 budget → trending over.
    const f = forecastDepartmentOverspend('housekeeping', 320_000, 200_000, 10, 30, null);
    assert.equal(f.trendingOver, true);
    assert.ok(f.pctOverBudget != null);
    const rebuilt = forecastTrendingMsg('en', f.department, f.pctOverBudget!, f.projectedCents, f.budgetCents);
    assert.equal(rebuilt, f.message);
  });

});

describe('anomalySpikeMsg', () => {
  test('EN rebuild is byte-identical to the server-built sentence', () => {
    const spikes = detectDepartmentSpikes({ utilities: 70_000 }, { utilities: 50_000 });
    assert.equal(spikes.length, 1);
    const a = spikes[0];
    assert.ok(a.department != null);
    const rebuilt = anomalySpikeMsg('en', a.department!, a.ratio, a.currentCents, a.baselineCents);
    assert.equal(rebuilt, a.message);
  });

});

describe('scanErrorLabel', () => {
  const S = ft('en');

  test('daily AI budget cap codes → budget message (all three cap scopes)', () => {
    for (const code of ['user_cap', 'property_cap', 'global_cap']) {
      assert.equal(scanErrorLabel(S, 'fallback', code, 429, 'Daily cap reached'), S.scanBudgetCap);
    }
  });

  test('rate limiting → rate-limit message (via code, raw error text, or bare 429)', () => {
    assert.equal(scanErrorLabel(S, 'fallback', 'rate_limited', 429, 'rate_limited'), S.scanRateLimited);
    // rateLimitedResponse() does not use the standard envelope: no code field,
    // the error text itself is 'rate_limited'.
    assert.equal(scanErrorLabel(S, 'fallback', undefined, 429, 'rate_limited'), S.scanRateLimited);
    assert.equal(scanErrorLabel(S, 'fallback', undefined, 429, undefined), S.scanRateLimited);
  });

  test('vision service down → service message', () => {
    assert.equal(scanErrorLabel(S, 'fallback', 'vision_unavailable', 503, 'vision_unavailable'), S.scanServiceDown);
    assert.equal(scanErrorLabel(S, 'fallback', 'vision_failed', 500, 'vision_failed'), S.scanServiceDown);
    assert.equal(scanErrorLabel(S, 'fallback', undefined, 503, undefined), S.scanServiceDown);
  });

  test('anything else (bad image, network) keeps the clearer-photo fallback', () => {
    assert.equal(scanErrorLabel(S, 'fallback', 'invalid_image', 400, 'invalid_image'), 'fallback');
    assert.equal(scanErrorLabel(S, 'fallback', undefined, undefined, 'network'), 'fallback');
  });

});
