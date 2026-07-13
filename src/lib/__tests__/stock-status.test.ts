// Boundary tests for the shared 70/30 stock status rule.
// Boundary semantics follow compliance/periods.ts ratioToStatus (the
// dominant, tested implementation): >= 0.7 good, >= 0.3 low, else critical.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stockStatus } from '@/lib/stock-status';

describe('stockStatus 70/30 boundaries', () => {
  test('exactly 70% of par is good (>= boundary, matches ratioToStatus)', () => {
    assert.equal(stockStatus(70, 100), 'good');
    assert.equal(stockStatus(7, 10), 'good');
  });

  test('just under 70% is low', () => {
    assert.equal(stockStatus(69, 100), 'low');
    assert.equal(stockStatus(0.6999, 1), 'low');
  });

  test('exactly 30% of par is low (>= boundary, matches ratioToStatus)', () => {
    assert.equal(stockStatus(30, 100), 'low');
    assert.equal(stockStatus(3, 10), 'low');
  });

  test('just under 30% is critical', () => {
    assert.equal(stockStatus(29, 100), 'critical');
    assert.equal(stockStatus(0.2999, 1), 'critical');
  });

  test('zero on hand is critical', () => {
    assert.equal(stockStatus(0, 100), 'critical');
  });

  test('at or above par is good', () => {
    assert.equal(stockStatus(100, 100), 'good');
    assert.equal(stockStatus(250, 100), 'good');
  });

  test('unjudgeable par (0, negative, NaN) returns good', () => {
    assert.equal(stockStatus(5, 0), 'good');
    assert.equal(stockStatus(5, -10), 'good');
    assert.equal(stockStatus(5, NaN), 'good');
  });

  test('invalid onHand is treated as 0 (critical)', () => {
    assert.equal(stockStatus(NaN, 100), 'critical');
  });

  test('negative onHand is critical', () => {
    assert.equal(stockStatus(-3, 100), 'critical');
  });
});
