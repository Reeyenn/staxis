/**
 * Tests for src/lib/db-mappers.ts.
 *
 * Run via: npx tsx --test src/lib/__tests__/db-mappers.test.ts
 * Or all of them: npx tsx --test "src/**\/__tests__/*.test.ts"
 *
 * The mappers are pure functions, which makes them the cheapest place to
 * catch a typo when adding a new column. Every column mismatch between
 * the SQL migrations and the TypeScript types eventually shows up here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  toDate,
  toISO,
  dropUndefined,
  toPropertyRow,
  fromPropertyRow,
  toStaffRow,
  fromStaffRow,
  toRoomRow,
  fromRoomRow,
  fromInventoryRow,
  fromInventoryCountRow,
  toInventoryCountRow,
} from '../db-mappers';

describe('toDate', () => {
  test('returns null for null/undefined', () => {
    assert.equal(toDate(null), null);
    assert.equal(toDate(undefined), null);
  });

  test('passes through Date objects', () => {
    const d = new Date('2026-04-27T12:00:00Z');
    assert.equal(toDate(d), d);
  });

  test('parses ISO strings', () => {
    const d = toDate('2026-04-27T12:00:00Z');
    assert.ok(d instanceof Date);
    assert.equal(d!.toISOString(), '2026-04-27T12:00:00.000Z');
  });

  test('returns null for invalid date strings', () => {
    assert.equal(toDate('not a date'), null);
    assert.equal(toDate({}), null);
  });
});

describe('toISO', () => {
  test('returns ISO string for valid input', () => {
    assert.equal(toISO('2026-04-27T12:00:00Z'), '2026-04-27T12:00:00.000Z');
  });

  test('returns null for invalid input', () => {
    assert.equal(toISO('garbage'), null);
    assert.equal(toISO(null), null);
  });
});

describe('dropUndefined', () => {
  test('removes undefined keys but keeps null and falsy values', () => {
    const result = dropUndefined({ a: 1, b: undefined, c: null, d: 0, e: '' });
    assert.deepEqual(result, { a: 1, c: null, d: 0, e: '' });
  });

  test('returns an empty object for an all-undefined input', () => {
    assert.deepEqual(dropUndefined({ a: undefined }), {});
  });
});

describe('Property mapper round-trip', () => {
  test('to → from preserves field values', () => {
    const original = {
      id: 'p1',
      name: 'Comfort Suites',
      totalRooms: 74,
      avgOccupancy: 0.85,
      hourlyWage: 17,
      checkoutMinutes: 30,
      stayoverMinutes: 20,
      prepMinutesPerActivity: 5,
      shiftMinutes: 480,
      totalStaffOnRoster: 8,
      timezone: 'America/Los_Angeles',
      lastSyncedAt: new Date('2026-04-27T12:00:00Z'),
      createdAt: new Date('2026-04-27T12:00:00Z'),
    };
    const row = toPropertyRow(original);
    // Manually inject id + created_at because to* mappers don't emit them
    // (those columns are managed by Postgres).
    const reread = fromPropertyRow({ ...row, id: 'p1', created_at: original.createdAt.toISOString() });
    assert.equal(reread.name, original.name);
    assert.equal(reread.totalRooms, original.totalRooms);
    assert.equal(reread.avgOccupancy, original.avgOccupancy);
    assert.equal(reread.hourlyWage, original.hourlyWage);
    assert.equal(reread.timezone, original.timezone);
  });
});

describe('Staff mapper — phone_lookup derivation', () => {
  test('derives phone_lookup from phone (last 10 digits)', () => {
    const row = toStaffRow({ phone: '+1 (281) 555-1234' });
    assert.equal(row.phone_lookup, '2815551234');
  });

  test('clears phone_lookup when phone is empty', () => {
    const row = toStaffRow({ phone: '' });
    assert.equal(row.phone_lookup, null);
  });

  test('leaves phone_lookup undefined (untouched) when phone is undefined', () => {
    const row = toStaffRow({ name: 'Maria' });
    assert.equal('phone_lookup' in row, false);
  });
});

describe('Staff mapper — last_paired_at round-trip', () => {
  test('reads last_paired_at from row into lastPairedAt domain field', () => {
    const row = {
      id: 's1',
      name: 'Maria',
      language: 'es',
      last_paired_at: '2026-04-27T15:30:00Z',
    };
    const staff = fromStaffRow(row);
    assert.ok(staff.lastPairedAt instanceof Date);
    assert.equal(staff.lastPairedAt!.toISOString(), '2026-04-27T15:30:00.000Z');
  });

  test('null last_paired_at → null lastPairedAt', () => {
    const staff = fromStaffRow({ id: 's1', name: 'Maria', last_paired_at: null });
    assert.equal(staff.lastPairedAt, null);
  });
});

describe('Room mapper round-trip', () => {
  test('preserves status, type, priority, and dates', () => {
    const original = {
      number: '305',
      type: 'checkout' as const,
      priority: 'vip' as const,
      status: 'dirty' as const,
      date: '2026-04-27',
      propertyId: 'p1',
      assignedTo: 's2',
      assignedName: 'Maria',
      startedAt: new Date('2026-04-27T15:00:00Z'),
      completedAt: null,
    };
    const row = toRoomRow(original);
    const reread = fromRoomRow({ ...row, id: 'r1' });
    assert.equal(reread.number, '305');
    assert.equal(reread.type, 'checkout');
    assert.equal(reread.priority, 'vip');
    assert.equal(reread.status, 'dirty');
    assert.equal(reread.assignedName, 'Maria');
    assert.equal(reread.startedAt!.toISOString(), '2026-04-27T15:00:00.000Z');
    assert.equal(reread.completedAt, null);
  });
});

describe('Inventory mapper — retention provenance', () => {
  test('maps creation and archive provenance without losing timestamps', () => {
    const item = fromInventoryRow({
      id: 'item-1',
      property_id: 'property-1',
      name: 'Bath towels',
      category: 'housekeeping',
      unit: 'each',
      created_at: '2026-07-15T14:00:00Z',
      created_by: 'user-created',
      archived_at: '2026-07-16T15:30:00Z',
      archived_by: 'user-archived',
    });

    assert.equal(item.createdAt?.toISOString(), '2026-07-15T14:00:00.000Z');
    assert.equal(item.createdBy, 'user-created');
    assert.equal(item.archivedAt?.toISOString(), '2026-07-16T15:30:00.000Z');
    assert.equal(item.archivedBy, 'user-archived');
  });

  test('maps legacy rows with no provenance to null', () => {
    const item = fromInventoryRow({
      id: 'legacy-item',
      property_id: 'property-1',
      name: 'Legacy towels',
      category: 'housekeeping',
      unit: 'each',
    });

    assert.equal(item.createdAt, null);
    assert.equal(item.createdBy, null);
    assert.equal(item.archivedAt, null);
    assert.equal(item.archivedBy, null);
  });
});

describe('Inventory count mapper — atomic session provenance', () => {
  test('round-trips count_session_id', () => {
    const row = toInventoryCountRow({
      propertyId: 'property-1',
      countSessionId: 'f7a70f69-232b-471b-8895-608ce88a421c',
      itemId: 'item-1',
      itemName: 'Bath towels',
      countedStock: 24,
    });
    assert.equal(row.count_session_id, 'f7a70f69-232b-471b-8895-608ce88a421c');
    const count = fromInventoryCountRow({ id: 'count-1', ...row });
    assert.equal(count.countSessionId, 'f7a70f69-232b-471b-8895-608ce88a421c');
  });
});
