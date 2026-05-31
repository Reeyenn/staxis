/**
 * Unit tests for the compliance cadence / period math (src/lib/compliance/
 * periods.ts) — the most bug-prone logic in feature #19, and where the
 * calendar-based PM-overdue rule lives. Dates are passed explicitly with
 * tz='UTC' so the assertions are deterministic regardless of the runner's
 * local zone.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentReadingPeriodKey,
  currentPmPeriodKey,
  previousPmPeriodKey,
  pmNextDueISO,
  ratioToStatus,
} from '@/lib/compliance/periods';
import type { PmCadence } from '@/lib/compliance/types';

const d = (s: string) => new Date(s);

describe('compliance reading period keys', () => {
  test('daily', () => {
    assert.equal(currentReadingPeriodKey('daily', d('2026-05-30T12:00:00Z'), 'UTC'), '2026-05-30');
  });
  test('per_shift splits at local noon', () => {
    assert.equal(currentReadingPeriodKey('per_shift', d('2026-05-30T09:00:00Z'), 'UTC'), '2026-05-30:AM');
    assert.equal(currentReadingPeriodKey('per_shift', d('2026-05-30T12:00:00Z'), 'UTC'), '2026-05-30:PM');
    assert.equal(currentReadingPeriodKey('per_shift', d('2026-05-30T23:00:00Z'), 'UTC'), '2026-05-30:PM');
  });
  test('weekly ISO week, including year boundaries', () => {
    assert.equal(currentReadingPeriodKey('weekly', d('2026-01-01T12:00:00Z'), 'UTC'), '2026-W01');
    assert.equal(currentReadingPeriodKey('weekly', d('2021-01-01T12:00:00Z'), 'UTC'), '2020-W53');
    assert.equal(currentReadingPeriodKey('weekly', d('2026-03-09T12:00:00Z'), 'UTC'), '2026-W11');
  });
  test('monthly', () => {
    assert.equal(currentReadingPeriodKey('monthly', d('2026-05-30T12:00:00Z'), 'UTC'), '2026-05');
  });
});

describe('compliance PM period keys', () => {
  test('current keys', () => {
    assert.equal(currentPmPeriodKey('monthly', d('2026-05-30T12:00:00Z'), 'UTC'), '2026-05');
    assert.equal(currentPmPeriodKey('quarterly', d('2026-01-15T12:00:00Z'), 'UTC'), '2026-Q1');
    assert.equal(currentPmPeriodKey('quarterly', d('2026-05-15T12:00:00Z'), 'UTC'), '2026-Q2');
    assert.equal(currentPmPeriodKey('quarterly', d('2026-12-15T12:00:00Z'), 'UTC'), '2026-Q4');
    assert.equal(currentPmPeriodKey('annual', d('2026-05-30T12:00:00Z'), 'UTC'), '2026');
  });
  test('previous keys roll over correctly', () => {
    assert.equal(previousPmPeriodKey('monthly', d('2026-01-15T12:00:00Z'), 'UTC'), '2025-12');
    assert.equal(previousPmPeriodKey('monthly', d('2026-05-15T12:00:00Z'), 'UTC'), '2026-04');
    assert.equal(previousPmPeriodKey('quarterly', d('2026-01-15T12:00:00Z'), 'UTC'), '2025-Q4');
    assert.equal(previousPmPeriodKey('quarterly', d('2026-05-15T12:00:00Z'), 'UTC'), '2026-Q1');
    assert.equal(previousPmPeriodKey('annual', d('2026-05-15T12:00:00Z'), 'UTC'), '2025');
  });
  test('next-due ISO is the next period start', () => {
    assert.equal(pmNextDueISO('monthly', d('2026-05-15T12:00:00Z'), 'UTC'), '2026-06-01T00:00:00Z');
    assert.equal(pmNextDueISO('monthly', d('2026-12-15T12:00:00Z'), 'UTC'), '2027-01-01T00:00:00Z');
    assert.equal(pmNextDueISO('quarterly', d('2026-05-15T12:00:00Z'), 'UTC'), '2026-07-01T00:00:00Z');
    assert.equal(pmNextDueISO('quarterly', d('2026-12-15T12:00:00Z'), 'UTC'), '2027-01-01T00:00:00Z');
    assert.equal(pmNextDueISO('annual', d('2026-05-15T12:00:00Z'), 'UTC'), '2027-01-01T00:00:00Z');
  });
});

describe('calendar-based PM overdue (mirrors getOverview logic)', () => {
  // Same rule store.ts applies: overdue when the current period has no pass AND
  // (never checked OR the previous period was also missed).
  const overdue = (cadence: PmCadence, passKeys: Set<string>, now: Date): boolean => {
    const cur = currentPmPeriodKey(cadence, now, 'UTC');
    const prev = previousPmPeriodKey(cadence, now, 'UTC');
    const done = passKeys.has(cur);
    return !done && (passKeys.size === 0 || !passKeys.has(prev));
  };

  test('checked previous period → due, NOT overdue', () => {
    assert.equal(overdue('monthly', new Set(['2026-01']), d('2026-02-15T12:00:00Z')), false);
  });
  test('one full period skipped → overdue at rollover', () => {
    assert.equal(overdue('monthly', new Set(['2026-01']), d('2026-03-15T12:00:00Z')), true);
  });
  test('never checked → overdue immediately', () => {
    assert.equal(overdue('monthly', new Set(), d('2026-03-15T12:00:00Z')), true);
  });
  test('checked this period → not overdue', () => {
    assert.equal(overdue('monthly', new Set(['2026-03']), d('2026-03-15T12:00:00Z')), false);
  });
  test('quarterly: checked Q1, now Q3 → overdue (Q2 missed)', () => {
    assert.equal(overdue('quarterly', new Set(['2026-Q1']), d('2026-08-15T12:00:00Z')), true);
    assert.equal(overdue('quarterly', new Set(['2026-Q1']), d('2026-05-15T12:00:00Z')), false);
  });
});

describe('70/30 status thresholds', () => {
  test('boundaries', () => {
    assert.equal(ratioToStatus(0.9), 'good');
    assert.equal(ratioToStatus(0.7), 'good');
    assert.equal(ratioToStatus(0.69), 'low');
    assert.equal(ratioToStatus(0.3), 'low');
    assert.equal(ratioToStatus(0.29), 'critical');
    assert.equal(ratioToStatus(0), 'critical');
  });
});
