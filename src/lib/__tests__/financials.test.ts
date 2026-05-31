// Unit tests for the Financials pure-math core: money conversion (no float
// drift), budget status thresholds, overspend forecasting (incl. cold-start
// confidence gate), spend-anomaly detection, and month helpers. These are the
// functions the API routes, the cron sweep, and the agent tools all rely on, so
// pinning them here catches a money-rounding or threshold regression before it
// ships. Pure functions only — no DB, no clock (dates are passed in).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDollarsToCents,
  formatCents,
  budgetStatus,
  pctUsed,
  daysInMonth,
  priorMonthKey,
  nextMonthStartISO,
  monthStartISO,
  daysElapsedInMonth,
  isMonthKey,
  isDepartment,
} from '@/lib/financials/shared';
import { projectMonthEndSpend, forecastDepartmentOverspend } from '@/lib/financials/forecast';
import { detectDepartmentSpikes, detectInvoiceOutlier } from '@/lib/financials/anomaly';

test('parseDollarsToCents — formats, commas, and no float drift', () => {
  assert.equal(parseDollarsToCents('1,234.56'), 123456);
  assert.equal(parseDollarsToCents('$1,000'), 100000);
  assert.equal(parseDollarsToCents('10.10'), 1010);
  assert.equal(parseDollarsToCents('19.99'), 1999);
  assert.equal(parseDollarsToCents(0), 0);
  assert.equal(parseDollarsToCents(''), null);
  assert.equal(parseDollarsToCents('abc'), null);
  assert.equal(parseDollarsToCents(null), null);
  // The classic 0.1 + 0.2 float trap must NOT corrupt integer-cent math.
  assert.equal(parseDollarsToCents('0.10')! + parseDollarsToCents('0.20')!, 30);
});

test('formatCents — currency, negatives, nullish', () => {
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(-5000), '-$50.00');
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(null), '—');
  assert.equal(formatCents(123456, { showCents: false }), '$1,235');
});

test('budgetStatus + pctUsed — 70/100 thresholds (spend, inverted)', () => {
  assert.equal(budgetStatus(7000, 10000), 'good'); // exactly 70% → good
  assert.equal(budgetStatus(7001, 10000), 'warn'); // just over 70% → warn
  assert.equal(budgetStatus(10000, 10000), 'warn'); // at 100% → warn (not over)
  assert.equal(budgetStatus(10001, 10000), 'over'); // over 100% → over
  assert.equal(budgetStatus(5000, 0), 'none'); // no budget
  assert.equal(pctUsed(5000, 10000), 50);
  assert.equal(pctUsed(5000, 0), null);
});

test('projectMonthEndSpend — linear pacing + occupancy factor', () => {
  // $1,000 spent in 10 of 30 days → $3,000 projected at flat pace.
  assert.equal(projectMonthEndSpend(100000, 10, 30, 1), 300000);
  // Busier back half (factor 1.5): remaining 20 days pace up.
  assert.equal(projectMonthEndSpend(100000, 10, 30, 1.5), 100000 + 10000 * 20 * 1.5);
  // Complete month → projection equals spend-to-date.
  assert.equal(projectMonthEndSpend(100000, 30, 30, 1), 100000);
  assert.equal(projectMonthEndSpend(0, 0, 30, 1), 0);
});

test('forecastDepartmentOverspend — flags over, respects cold-start confidence', () => {
  const over = forecastDepartmentOverspend('utilities', 200000, 100000, 10, 30, 1);
  assert.equal(over.projectedCents, 300000);
  assert.equal(over.trendingOver, true);
  assert.equal(over.confidence, 'ok');
  assert.equal(Math.round(over.pctOverBudget!), 50);

  // Day 3 of the month → too early, never alerts even if pacing looks high.
  const early = forecastDepartmentOverspend('utilities', 200000, 100000, 3, 30, 1);
  assert.equal(early.confidence, 'low');
  assert.equal(early.trendingOver, false);

  // On track → no alert.
  const ok = forecastDepartmentOverspend('housekeeping', 200000, 50000, 10, 30, 1);
  assert.equal(ok.trendingOver, false);
});

test('detectDepartmentSpikes — 30% over baseline, with a floor', () => {
  const spikes = detectDepartmentSpikes({ maintenance: 130000 }, { maintenance: 100000 });
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].department, 'maintenance');

  // 20% over → below the 30% threshold.
  assert.equal(detectDepartmentSpikes({ maintenance: 120000 }, { maintenance: 100000 }).length, 0);
  // Baseline below the $500 floor → ignored (no noise on tiny numbers).
  assert.equal(detectDepartmentSpikes({ rooms: 100000 }, { rooms: 40000 }).length, 0);
});

test('detectInvoiceOutlier — 2× the vendor median, needs history', () => {
  const hit = detectInvoiceOutlier(200000, 'Acme', [100000, 100000, 100000]);
  assert.ok(hit);
  assert.equal(hit!.kind, 'invoice_outlier');

  // Within normal range.
  assert.equal(detectInvoiceOutlier(150000, 'Acme', [100000, 100000, 100000]), null);
  // Not enough history.
  assert.equal(detectInvoiceOutlier(999999, 'New Vendor', [100000]), null);
});

test('month helpers', () => {
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2024-02'), 29); // leap year
  assert.equal(daysInMonth('2026-04'), 30);
  assert.equal(daysInMonth('2026-01'), 31);
  assert.equal(priorMonthKey('2026-01'), '2025-12');
  assert.equal(priorMonthKey('2026-05'), '2026-04');
  assert.equal(nextMonthStartISO('2026-12'), '2027-01-01');
  assert.equal(monthStartISO('2026-05'), '2026-05-01');

  const may15 = new Date(Date.UTC(2026, 4, 15));
  assert.equal(daysElapsedInMonth('2026-05', may15), 15); // current month → day-of-month
  assert.equal(daysElapsedInMonth('2026-04', may15), 30); // past month → full
  assert.equal(daysElapsedInMonth('2026-06', may15), 0); // future month → 0

  assert.equal(isMonthKey('2026-05'), true);
  assert.equal(isMonthKey('2026-13'), false);
  assert.equal(isDepartment('maintenance'), true);
  assert.equal(isDepartment('nope'), false);
});
