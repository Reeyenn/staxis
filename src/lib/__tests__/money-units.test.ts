/**
 * money-units.test.ts — behavior tests for the dollars↔cents helpers.
 *
 * Why this file exists: the 2026-07-22 audit found ~94 hand-coded `* 100` /
 * `/ 100` seams, and a real 100× display bug had already shipped from one of
 * them. These helpers are now the single conversion point, so a rounding
 * regression here would corrupt money everywhere at once. Each test below
 * fails if a plausible bug is introduced (plain `Math.round(d * 100)`,
 * `Math.trunc`, JS default half-up rounding on negatives, float summation).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  centsToDollars,
  dollarsToCents,
  formatMoney,
  moneyFromCents,
  parseDollarsToCents,
} from '../format';

describe('dollarsToCents', () => {
  test('converts everyday prices exactly', () => {
    assert.equal(dollarsToCents(0), 0);
    assert.equal(dollarsToCents(1), 100);
    assert.equal(dollarsToCents(19.99), 1999);
    assert.equal(dollarsToCents(0.01), 1);
    assert.equal(dollarsToCents(1234.56), 123456);
  });

  test('always returns a whole number of cents', () => {
    for (const dollars of [19.99, 0.005, 1.005, 33.333, 1 / 3, 2 / 3]) {
      const cents = dollarsToCents(dollars);
      assert.ok(Number.isInteger(cents), `${dollars} produced non-integer cents ${cents}`);
    }
  });

  test('rounds the half-cent boundary the way a human reads it', () => {
    // Plain `Math.round(1.005 * 100)` gives 100 because 1.005 * 100 is
    // 100.49999999999999 in binary floating point. The decimal-shift path
    // parses the literal 100.5 and rounds it to 101.
    assert.equal(dollarsToCents(1.005), 101);
    assert.equal(dollarsToCents(2.675), 268);
    assert.equal(dollarsToCents(8.165), 817);
  });

  test('rounds half away from zero on negatives (refunds and credits)', () => {
    // JS `Math.round(-100.5)` is -100 (half rounds toward +Infinity), which
    // would make a credit a cent cheaper than the matching charge.
    assert.equal(dollarsToCents(-1.005), -101);
    assert.equal(dollarsToCents(-19.99), -1999);
    assert.equal(dollarsToCents(-0.005), -1);
  });

  test('survives classic float-arithmetic inputs', () => {
    // 0.1 + 0.2 === 0.30000000000000004
    assert.equal(dollarsToCents(0.1 + 0.2), 30);
    // 1.1 * 3 === 3.3000000000000003
    assert.equal(dollarsToCents(1.1 * 3), 330);
    assert.equal(dollarsToCents(0.07 * 100), 700);
  });

  test('handles values JS prints in scientific notation', () => {
    // String(1e-7) is "1e-7"; a naive string concat would build "1e-7e2".
    assert.equal(dollarsToCents(1e-7), 0);
    assert.equal(dollarsToCents(1e-2), 1);
    assert.equal(dollarsToCents(1.5e3), 150000);
  });

  test('non-finite input degrades to 0 rather than NaN reaching storage', () => {
    assert.equal(dollarsToCents(NaN), 0);
    assert.equal(dollarsToCents(Infinity), 0);
    assert.equal(dollarsToCents(-Infinity), 0);
  });
});

describe('centsToDollars', () => {
  test('converts cents back to dollars exactly', () => {
    assert.equal(centsToDollars(0), 0);
    assert.equal(centsToDollars(1999), 19.99);
    assert.equal(centsToDollars(1), 0.01);
    assert.equal(centsToDollars(123456), 1234.56);
    assert.equal(centsToDollars(-1999), -19.99);
  });

  test('avoids the binary-division artifact of plain `cents / 100`', () => {
    // 1_000_000_07 / 100 is 1000000.07 but several values in this family come
    // back with a trailing ...0000001 through plain division. The decimal
    // shift keeps them exact, which matters because these numbers are written
    // straight back into the legacy dollar ledger columns.
    assert.equal(centsToDollars(1_00_00_00_07), 1000000.07);
    assert.equal(centsToDollars(835), 8.35);
    assert.equal(centsToDollars(1105), 11.05);
  });

  test('non-finite input degrades to 0', () => {
    assert.equal(centsToDollars(NaN), 0);
    assert.equal(centsToDollars(Infinity), 0);
  });
});

describe('round trip', () => {
  test('dollars → cents → dollars is lossless for 2-decimal money', () => {
    const values = [0, 0.01, 0.99, 1, 8.35, 11.05, 19.99, 100, 1234.56, 99999.99, -19.99];
    for (const dollars of values) {
      assert.equal(centsToDollars(dollarsToCents(dollars)), dollars, `round trip lost ${dollars}`);
    }
  });

  test('cents → dollars → cents is lossless across a wide sweep', () => {
    for (let cents = 0; cents <= 2000; cents++) {
      assert.equal(dollarsToCents(centsToDollars(cents)), cents, `round trip lost ${cents}c`);
    }
  });

  test('summing in cents beats summing in dollars', () => {
    const prices = [0.1, 0.2, 0.3, 19.99, 8.35];
    const centsTotal = prices.reduce((sum, p) => sum + dollarsToCents(p), 0);
    assert.equal(centsTotal, 2894);
    assert.equal(centsToDollars(centsTotal), 28.94);
    // The naive dollar sum does not equal the exact total, which is exactly
    // why totals are accumulated in cents.
    const dollarSum = prices.reduce((sum, p) => sum + p, 0);
    assert.notEqual(dollarSum, 28.94);
  });
});

describe('formatMoney', () => {
  test('renders cents as fixed 2-decimal dollars', () => {
    assert.equal(formatMoney(0), '$0.00');
    assert.equal(formatMoney(1999), '$19.99');
    assert.equal(formatMoney(5), '$0.05');
    assert.equal(formatMoney(123456), '$1234.56');
  });

  test('matches the older moneyFromCents alias exactly', () => {
    for (const cents of [0, 1, 99, 100, 1999, 123456]) {
      assert.equal(formatMoney(cents), moneyFromCents(cents));
    }
  });

  test('non-finite input renders $0.00 instead of "$NaN"', () => {
    assert.equal(formatMoney(NaN), '$0.00');
  });
});

describe('parseDollarsToCents', () => {
  test('parses typed dollar strings', () => {
    assert.equal(parseDollarsToCents('19.99'), 1999);
    assert.equal(parseDollarsToCents('$19.99'), 1999);
    assert.equal(parseDollarsToCents(' $1,234.56 '), 123456);
    assert.equal(parseDollarsToCents('0'), 0);
  });

  test('distinguishes "not provided" from "zero"', () => {
    // Unit cost null means unknown; 0 means free. Collapsing them would make
    // an unpriced item look like a free one in spend totals.
    assert.equal(parseDollarsToCents(''), null);
    assert.equal(parseDollarsToCents('   '), null);
    assert.equal(parseDollarsToCents(null), null);
    assert.equal(parseDollarsToCents(undefined), null);
    assert.equal(parseDollarsToCents('abc'), null);
    assert.equal(parseDollarsToCents(NaN), null);
    assert.equal(parseDollarsToCents('0'), 0);
    assert.equal(parseDollarsToCents(0), 0);
  });

  test('accepts numbers and applies the same rounding as dollarsToCents', () => {
    assert.equal(parseDollarsToCents(1.005), 101);
    assert.equal(parseDollarsToCents(0.1 + 0.2), 30);
  });
});
