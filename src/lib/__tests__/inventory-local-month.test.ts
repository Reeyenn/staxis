// Regression tests for the inventory page's local-calendar month helpers
// (src/app/inventory/_components/month.ts).
//
// Bug fixed: "this month" spend and budget caps were computed on the UTC
// month, so on the evening of the last day of a month (US timezones) the
// sidebar spend reset to $0 and the caps flipped to next month hours early.

// Pin the process to a US timezone BEFORE any Date work so the regression
// case (evening of the month's last day, when UTC has already rolled over)
// is actually exercised. Node reads TZ lazily per Date call on macOS/Linux.
process.env.TZ = 'America/Chicago';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  startOfLocalMonth,
  addLocalMonths,
  isBudgetForLocalMonth,
} from '@/app/inventory/_components/month';

// July 31, 2026 7:30pm CDT — in UTC this is already Aug 1, 00:30.
const julyEvening = new Date('2026-08-01T00:30:00Z');

describe('startOfLocalMonth / addLocalMonths', () => {
  test('the evening of July 31 (CDT) is still JULY, not August', () => {
    assert.equal(julyEvening.getUTCMonth(), 7); // sanity: UTC says August
    const start = startOfLocalMonth(julyEvening);
    assert.equal(start.getFullYear(), 2026);
    assert.equal(start.getMonth(), 6); // July, local
    assert.equal(start.getDate(), 1);
    assert.equal(start.getHours(), 0);
  });

  test('month window is [local Jul 1, local Aug 1)', () => {
    const start = startOfLocalMonth(julyEvening);
    const end = addLocalMonths(julyEvening, 1);
    assert.equal(end.getMonth(), 7); // August, local
    assert.equal(end.getDate(), 1);
    // An order received that evening falls INSIDE the July window.
    assert.ok(julyEvening.getTime() >= start.getTime());
    assert.ok(julyEvening.getTime() < end.getTime());
  });

  test('addLocalMonths rolls the year across December', () => {
    const dec = new Date(2026, 11, 15);
    const next = addLocalMonths(dec, 1);
    assert.equal(next.getFullYear(), 2027);
    assert.equal(next.getMonth(), 0);
  });
});

describe('isBudgetForLocalMonth', () => {
  // Budget rows store month_start as a DATE ('2026-07-01') that the mappers
  // parse as a UTC-midnight instant — the stored side reads via getUTC*.
  const julyBudget = new Date(Date.UTC(2026, 6, 1));
  const augustBudget = new Date(Date.UTC(2026, 7, 1));

  test('on the evening of July 31 the JULY budget still applies', () => {
    assert.equal(isBudgetForLocalMonth(julyBudget, julyEvening), true);
  });

  test('the August budget does NOT flip in early', () => {
    assert.equal(isBudgetForLocalMonth(augustBudget, julyEvening), false);
  });

  test('mid-month match is unaffected', () => {
    const midJuly = new Date(2026, 6, 15, 12, 0);
    assert.equal(isBudgetForLocalMonth(julyBudget, midJuly), true);
    assert.equal(isBudgetForLocalMonth(augustBudget, midJuly), false);
  });
});
