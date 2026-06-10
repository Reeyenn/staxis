/**
 * Non-empty-required-column guard (Chat 1 plumbing) — offline, no DB.
 *
 * The hole: validateRows treated "" as PRESENT for required text columns, so
 * a feed whose required column extracted blank on every row (broken column
 * mapping, drifted selector, wrong jsonPath) would "successfully" upsert
 * garbage keys and look healthy. Pins:
 *
 *   1. validateRows now rejects required-but-blank values per row.
 *   2. findAllBlankRequiredColumns flags a column blank across ALL rows
 *      (the saveGenericTable early feed-failure), and CANNOT fire on
 *      legitimately-empty feeds (0 rows) or on optional columns.
 *   3. The descriptor's required set lines up with target-contract's
 *      CORE_TARGET_CONTRACTS (read-only reuse — same source of truth).
 */

// MUST be first: generic-table-writer transitively builds the Supabase client.
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateRows,
  findAllBlankRequiredColumns,
  type TableSchemaDescriptor,
} from '../persistence/generic-table-writer.js';
import { requiredLearnedFor } from '../target-contract.js';

const PID = '00000000-0000-0000-0000-000000000001';

// Verbatim from migration 0207 (same fixture as mapper-field-contract.test.ts).
const RESERVATIONS_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_reservations',
  write_strategy: 'upsert',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'pms_reservation_id'],
  reconcile_key_field: null,
  columns: [
    { name: 'pms_reservation_id', type: 'text', required: true, nullable: false },
    { name: 'guest_name', type: 'text', required: true, nullable: false },
    { name: 'room_number', type: 'text', required: false, nullable: true },
    { name: 'arrival_date', type: 'date', required: true, nullable: false },
    { name: 'departure_date', type: 'date', required: true, nullable: false },
    { name: 'num_nights', type: 'integer', required: false, nullable: true, range_min: 0, range_max: 365 },
    { name: 'status', type: 'text', required: false, nullable: true },
    { name: 'channel_name', type: 'text', required: false, nullable: true },
    { name: 'rate_per_night_cents', type: 'bigint', required: false, nullable: true, range_min: 0 },
  ],
};

const goodRow = (over: Record<string, unknown> = {}) => ({
  property_id: PID,
  pms_reservation_id: 'CONF-1',
  guest_name: 'Jane Doe',
  arrival_date: '2026-06-10',
  departure_date: '2026-06-12',
  ...over,
});

describe('fixture stays aligned with target-contract (read-only reuse)', () => {
  test('descriptor required columns ⊇ CORE getArrivals required-learned set', () => {
    const requiredInDescriptor = new Set(
      RESERVATIONS_DESCRIPTOR.columns.filter((c) => c.required).map((c) => c.name),
    );
    for (const col of requiredLearnedFor('getArrivals')) {
      assert.ok(requiredInDescriptor.has(col), `descriptor missing required core column ${col}`);
    }
  });
});

describe('validateRows: blank required values reject per-row', () => {
  test('required "" rejects with a distinct "blank" reason', () => {
    const v = validateRows([goodRow({ pms_reservation_id: '' })], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.valid.length, 0);
    assert.match(v.rejected[0]!.reason, /required field "pms_reservation_id" blank/);
  });

  test('required whitespace-only rejects too', () => {
    const v = validateRows([goodRow({ guest_name: '   ' })], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.valid.length, 0);
    assert.match(v.rejected[0]!.reason, /required field "guest_name" blank/);
  });

  test('OPTIONAL blank values still pass (no behavior change)', () => {
    const v = validateRows([goodRow({ room_number: '' })], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('mixed batch: only the blank rows reject', () => {
    const v = validateRows(
      [goodRow(), goodRow({ pms_reservation_id: '', guest_name: 'Sam' })],
      RESERVATIONS_DESCRIPTOR,
    );
    assert.equal(v.valid.length, 1);
    assert.equal(v.rejected.length, 1);
  });
});

describe('findAllBlankRequiredColumns: the all-rows feed-failure detector', () => {
  test('required column blank across ALL rows is flagged (mix of "" / null / whitespace)', () => {
    const rows = [
      goodRow({ pms_reservation_id: '' }),
      goodRow({ pms_reservation_id: null }),
      goodRow({ pms_reservation_id: '  ' }),
    ];
    assert.deepEqual(findAllBlankRequiredColumns(rows, RESERVATIONS_DESCRIPTOR), ['pms_reservation_id']);
  });

  test('undefined (column never extracted) counts as blank', () => {
    const rows = [goodRow(), goodRow()].map((r) => {
      const { guest_name: _drop, ...rest } = r;
      return rest;
    });
    assert.deepEqual(findAllBlankRequiredColumns(rows, RESERVATIONS_DESCRIPTOR), ['guest_name']);
  });

  test('ONE good value clears the column (per-row validation handles the rest)', () => {
    const rows = [goodRow({ pms_reservation_id: '' }), goodRow()];
    assert.deepEqual(findAllBlankRequiredColumns(rows, RESERVATIONS_DESCRIPTOR), []);
  });

  test('ZERO rows never trigger the guard — an empty feed is a healthy no-op', () => {
    assert.deepEqual(findAllBlankRequiredColumns([], RESERVATIONS_DESCRIPTOR), []);
  });

  test('an all-blank OPTIONAL column never triggers the guard', () => {
    const rows = [goodRow({ room_number: '' }), goodRow({ room_number: null })];
    assert.deepEqual(findAllBlankRequiredColumns(rows, RESERVATIONS_DESCRIPTOR), []);
  });

  test('multiple broken required columns are all reported', () => {
    const rows = [
      goodRow({ pms_reservation_id: '', guest_name: null }),
      goodRow({ pms_reservation_id: null, guest_name: '' }),
    ];
    assert.deepEqual(
      findAllBlankRequiredColumns(rows, RESERVATIONS_DESCRIPTOR),
      ['pms_reservation_id', 'guest_name'],
    );
  });
});
