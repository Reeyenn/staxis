import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  inventoryReportMonthKey,
  propertyReportRange,
} from '../reports/property-report-range';

describe('property report ranges', () => {
  const instant = new Date('2026-08-01T00:30:00.000Z');

  it('uses the hotel date instead of the browser date', () => {
    assert.deepEqual(propertyReportRange('mtd', 'America/Los_Angeles', undefined, undefined, instant), {
      from: '2026-07-01',
      to: '2026-07-31',
    });
    assert.deepEqual(propertyReportRange('mtd', 'Pacific/Kiritimati', undefined, undefined, instant), {
      from: '2026-08-01',
      to: '2026-08-01',
    });
  });

  it('uses inclusive calendar-day windows', () => {
    assert.deepEqual(propertyReportRange('last7', 'America/Los_Angeles', undefined, undefined, instant), {
      from: '2026-07-25',
      to: '2026-07-31',
    });
    assert.deepEqual(propertyReportRange('last30', 'America/Los_Angeles', undefined, undefined, instant), {
      from: '2026-07-02',
      to: '2026-07-31',
    });
  });

  it('keeps supplied custom bounds and fills omitted bounds in hotel time', () => {
    assert.deepEqual(propertyReportRange('custom', 'America/Los_Angeles', '2026-07-10', '', instant), {
      from: '2026-07-10',
      to: '2026-07-31',
    });
  });
});

describe('inventory report month label', () => {
  it('prefers the server property-month key over the UTC month-start date', () => {
    assert.equal(
      inventoryReportMonthKey('2026-07', '2026-06-30T10:00:00.000Z', 'Pacific/Kiritimati'),
      '2026-07',
    );
  });

  it('derives a property-local key from legacy month-start responses', () => {
    assert.equal(
      inventoryReportMonthKey(undefined, '2026-06-30T10:00:00.000Z', 'Pacific/Kiritimati'),
      '2026-07',
    );
  });
});
