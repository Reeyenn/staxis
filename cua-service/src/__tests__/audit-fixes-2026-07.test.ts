/**
 * Pins the 2026-07 full-audit fixes (multi-agent adversarial review) so they
 * can't regress:
 *
 *   1. Layer-2 sanitize is APPLIED: the validators.ts `clean` row (inverted
 *      date pairs nulled, implausible counts dropped) reaches the written row
 *      instead of being discarded by the VALIDATOR_REGISTRY wrappers.
 *   2. A REQUIRED field the sanitizer drops rejects the row (never writes
 *      null into a NOT NULL column).
 *   3. pms_lost_and_found accepts 'open' (the normal active-item status, per
 *      the 0202 CHECK) — the stale 'unclaimed' enum rejected every open item.
 *   4. redactResponseBody masks arrays of scalars under mask/maskstring keys
 *      (phoneNumbers: […], guestNames: […] escaped redaction entirely).
 *   5. redactCsvText no longer promotes a headerless data row to header on a
 *      single shape mismatch (guest-name columns survived unmasked).
 *   6. enrichRowsWithDetail never CACHES an all-blank artifact result (a
 *      30s glitch became a 10-minute feed outage).
 */

// MUST be first: install the WebSocket shim before any supabase-importing
// module is evaluated (ESM evaluates imports in source order).
import './ws-polyfill.js';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { validateRows, type TableSchemaDescriptor } from '../persistence/generic-table-writer.js';
import { redactResponseBody, redactCsvText } from '../response-redaction.js';
import { enrichRowsWithDetail, __clearDetailCacheForTests } from '../extractors/template-runner.js';

const PID = '00000000-0000-0000-0000-000000000001';

// ─── Descriptor fixtures (minimal, from migrations 0207/0258) ───────────────

const RESERVATIONS_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_reservations',
  write_strategy: 'upsert',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'pms_reservation_id'],
  reconcile_key_field: null,
  columns: [
    { name: 'property_id', type: 'text', required: true, nullable: false },
    { name: 'pms_reservation_id', type: 'text', required: true, nullable: false },
    { name: 'guest_name', type: 'text', required: false, nullable: true },
    { name: 'arrival_date', type: 'date', required: false, nullable: true },
    { name: 'departure_date', type: 'date', required: false, nullable: true },
  ],
};

const ROOM_STATUS_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_room_status_log',
  write_strategy: 'append',
  snapshot_scope_default: 'full',
  natural_key: [],
  reconcile_key_field: null,
  columns: [
    { name: 'property_id', type: 'text', required: true, nullable: false },
    { name: 'room_number', type: 'text', required: true, nullable: false },
    { name: 'status', type: 'text', required: true, nullable: false },
  ],
};

const LOST_FOUND_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_lost_and_found',
  write_strategy: 'reconcile',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'pms_item_id'],
  reconcile_key_field: 'pms_item_id',
  columns: [
    { name: 'property_id', type: 'text', required: true, nullable: false },
    { name: 'pms_item_id', type: 'text', required: false, nullable: true },
    { name: 'item_description', type: 'text', required: true, nullable: false },
    { name: 'location_found', type: 'text', required: true, nullable: false },
    { name: 'found_at', type: 'date', required: true, nullable: false },
    // 0258: aligned to the authoritative 0202 CHECK constraint.
    { name: 'status', type: 'text', required: true, nullable: false,
      allowed_values: ['open', 'claimed', 'disposed', 'shipped', 'expired'] },
  ],
};

// ─── 1+2: layer-2 sanitize actually applies ─────────────────────────────────

describe('layer-2 sanitize (clean row) reaches the written row', () => {
  test('inverted arrival/departure pair is nulled, row still writes', () => {
    const row: Record<string, unknown> = {
      property_id: PID,
      pms_reservation_id: 'R-100',
      guest_name: 'X',
      arrival_date: '2026-07-10',
      departure_date: '2026-07-01', // ends before it begins
    };
    const { valid, rejected } = validateRows([row], RESERVATIONS_DESCRIPTOR);
    assert.equal(rejected.length, 0);
    assert.equal(valid.length, 1);
    // The old wrappers discarded `clean` — the inverted pair wrote as-is.
    assert.equal(valid[0]!.arrival_date, null);
    assert.equal(valid[0]!.departure_date, null);
  });

  test('a REQUIRED field the sanitizer drops rejects the row (no NOT NULL violation)', () => {
    const row: Record<string, unknown> = {
      property_id: PID,
      room_number: 'LOBBY-A', // fails validateRoomStatus's format → sanitize-dropped
      status: 'vacant_clean',
      changed_at: '2026-07-01T00:00:00Z',
    };
    const { valid, rejected } = validateRows([row], ROOM_STATUS_DESCRIPTOR);
    assert.equal(valid.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!.reason, /required field "room_number" failed sanitize/);
  });
});

// ─── 3: lost-and-found status enum matches the DB CHECK ─────────────────────

describe('pms_lost_and_found status enum matches the 0202 CHECK', () => {
  const item = (status: string): Record<string, unknown> => ({
    property_id: PID,
    pms_item_id: 'LF-1',
    item_description: 'Black umbrella',
    location_found: 'Room 204',
    found_at: '2026-06-30',
    status,
  });

  test("'open' (an active item) is accepted", () => {
    const { valid, rejected } = validateRows([item('open')], LOST_FOUND_DESCRIPTOR);
    assert.equal(rejected.length, 0, rejected[0]?.reason);
    assert.equal(valid.length, 1);
  });

  test("'shipped' and 'expired' are accepted", () => {
    for (const s of ['shipped', 'expired']) {
      const { valid } = validateRows([item(s)], LOST_FOUND_DESCRIPTOR);
      assert.equal(valid.length, 1, `status '${s}' should be accepted`);
    }
  });

  test("'unclaimed' (exists nowhere in the DB) is rejected", () => {
    const { valid, rejected } = validateRows([item('unclaimed')], LOST_FOUND_DESCRIPTOR);
    assert.equal(valid.length, 0);
    assert.equal(rejected.length, 1);
  });
});

// ─── 4: arrays of scalars under mask/maskstring keys ─────────────────────────

describe('redactResponseBody: masked-key arrays', () => {
  test('scalar arrays under PII keys are masked, structure preserved', () => {
    const out = redactResponseBody({
      guestName: ['SMITH, JOHN'],
      phoneNumbers: ['7135551234', '7135555678'],
      addressLines: ['123 Main St Apt 4'],
      roomNumber: '204',
    }) as Record<string, unknown>;
    assert.deepEqual(out.guestName, ['<redacted:field>']);
    assert.deepEqual(out.phoneNumbers, ['<redacted:field>', '<redacted:field>']);
    assert.deepEqual(out.addressLines, ['<redacted:field>']);
    assert.equal(out.roomNumber, '204'); // non-PII survives
  });

  test('maskstring arrays keep numbers (counts), mask strings (names)', () => {
    const out = redactResponseBody({ guests: [2, 'John Smith'] }) as Record<string, unknown>;
    assert.deepEqual(out.guests, [2, '<redacted:field>']);
  });

  test('objects inside a masked-key array re-classify by their own keys', () => {
    const out = redactResponseBody({
      guest: [{ roomNumber: '204', name: 'John Smith' }],
    }) as Record<string, unknown>;
    const inner = (out.guest as Array<Record<string, unknown>>)[0]!;
    assert.equal(inner.roomNumber, '204');
    assert.equal(inner.name, '<redacted:field>');
  });

  test('nested scalar arrays stay masked', () => {
    const out = redactResponseBody({ phoneNumbers: [['7135551234']] }) as Record<string, unknown>;
    assert.deepEqual(out.phoneNumbers, [['<redacted:field>']]);
  });
});

// ─── 5: CSV header promotion needs real evidence ─────────────────────────────

describe('redactCsvText: header detection', () => {
  test('headerless CSV with ONE shape diff no longer promotes data to header (names masked)', () => {
    const csv = 'John Smith,20B,DUE_IN\nJane Doe,204,DUE_IN\n';
    const out = redactCsvText(csv);
    assert.ok(!out.includes('John Smith'), `guest name leaked: ${out}`);
    assert.ok(!out.includes('Jane Doe'), `guest name leaked: ${out}`);
    assert.ok(out.includes('204'), 'numeric room should survive');
  });

  test('a real header with a sensitive column is still detected; statuses survive', () => {
    const csv = 'Guest Name,Room,Status\nJohn Smith,204,DUE_IN\n';
    const out = redactCsvText(csv);
    assert.ok(out.includes('Guest Name'), 'header row survives');
    assert.ok(!out.includes('John Smith'), 'name column masked');
    assert.ok(out.includes('DUE_IN'), 'status survives under a real header');
    assert.ok(out.includes('204'));
  });

  test('an all-text header over date/numeric data (≥2 shape diffs) is still a header', () => {
    const csv = 'Date,Occupancy,ADR\n2026-07-01,85,120.50\n';
    const out = redactCsvText(csv);
    assert.ok(out.includes('Date,Occupancy,ADR'), 'header survives');
    assert.ok(out.includes('2026-07-01'));
  });
});

// ─── 6: all-blank detail results are never cached ─────────────────────────────

describe('enrichRowsWithDetail: all-blank artifact is not cached', () => {
  beforeEach(() => __clearDetailCacheForTests());

  const rowDetail = {
    urlTemplate: 'https://pms.example.com/wo?id={pms_work_order_id}',
    urlParams: { pms_work_order_id: 'pms_work_order_id' },
    columns: { description: '#desc' },
  };

  test('a blank first fetch is re-fetched next poll; a good fetch is cached', async () => {
    let calls = 0;
    const fetcher = async (): Promise<Record<string, string>> => {
      calls++;
      // Poll 1: half-rendered page → all blank. Poll 2+: recovered.
      return calls === 1 ? { description: '' } : { description: 'Leaky faucet' };
    };

    // Poll 1 — blank artifact comes back but must NOT enter the cache.
    const rows1 = [{ pms_work_order_id: 'WO-1' }] as Array<Record<string, unknown>>;
    await enrichRowsWithDetail({ rows: rows1, rowDetail, fetcher, cacheScope: 'test:v1' });
    assert.equal(rows1[0]!.description, '');

    // Poll 2 — with the old behavior this was a cache hit serving blanks.
    const rows2 = [{ pms_work_order_id: 'WO-1' }] as Array<Record<string, unknown>>;
    await enrichRowsWithDetail({ rows: rows2, rowDetail, fetcher, cacheScope: 'test:v1' });
    assert.equal(calls, 2, 'blank result must not be served from cache');
    assert.equal(rows2[0]!.description, 'Leaky faucet');

    // Poll 3 — the GOOD result from poll 2 is served from cache.
    const rows3 = [{ pms_work_order_id: 'WO-1' }] as Array<Record<string, unknown>>;
    await enrichRowsWithDetail({ rows: rows3, rowDetail, fetcher, cacheScope: 'test:v1' });
    assert.equal(calls, 2, 'good result must be cached');
    assert.equal(rows3[0]!.description, 'Leaky faucet');
  });
});
