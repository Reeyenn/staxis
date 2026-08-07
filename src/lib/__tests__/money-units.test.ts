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
  dollarsToFractionalCents,
  formatMoney,
  moneyFromCents,
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

describe('dollarsToFractionalCents', () => {
  test('keeps sub-cent precision that whole-centing would destroy', () => {
    // A per-unit weighted-average cost comes from total / quantity, so more
    // than two decimals is normal rather than a data error.
    assert.equal(dollarsToFractionalCents(4.455), 445.5);
    assert.equal(dollarsToFractionalCents(13.365), 1336.5);
    assert.equal(dollarsToFractionalCents(0.005), 0.5);
  });

  test('matches the six-decimal precision the month-close SQL uses', () => {
    // 0322:1225 is round(unit_cost * 100, 6). Preview and committed close must
    // agree, so this must round exactly the same way.
    assert.equal(dollarsToFractionalCents(10 / 3), 333.333333);
    assert.equal(dollarsToFractionalCents(1 / 7), 14.285714);
  });

  test('agrees with dollarsToCents whenever the value IS whole cents', () => {
    for (const dollars of [0, 0.01, 8.35, 19.99, 1234.56]) {
      assert.equal(dollarsToFractionalCents(dollars), dollarsToCents(dollars));
    }
  });

  test('valuing a quantity does not multiply a rounding error', () => {
    // The regression this guards: whole-centing $13.365 to 1337c and then
    // valuing 200 units gives $2674.00 instead of the correct $2673.00.
    const unitCost = 13.365;
    const quantity = 200;
    assert.equal(Math.round(quantity * dollarsToFractionalCents(unitCost)), 267300);
    assert.notEqual(Math.round(quantity * dollarsToCents(unitCost)), 267300);
  });

  test('non-finite input degrades to 0', () => {
    assert.equal(dollarsToFractionalCents(NaN), 0);
    assert.equal(dollarsToFractionalCents(Infinity), 0);
  });
});
