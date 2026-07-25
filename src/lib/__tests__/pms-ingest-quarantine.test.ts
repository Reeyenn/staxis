/**
 * Quarantine identity and unmapped-column capture (src/lib/pms/quarantine.ts).
 *
 * Two invariants live or die on this file:
 *
 *   1. "Every row a report delivers is either written or quarantined."
 *      The per-DELIVERY dedupe is what makes that arithmetic satisfiable. The
 *      original design used a GLOBAL dedupe on fingerprint, which meant the
 *      second delivery carrying the same persistent bad row inserted nothing,
 *      reported zero rejects, and could never balance rows_parsed against
 *      rows_written + rows_quarantined. The pipeline would have wedged on the
 *      second occurrence of any recurring bad row.
 *
 *   2. "A column we do not recognise is captured and surfaced, never ignored."
 *      The value has to land somewhere even if nobody ever opens the review
 *      queue — that somewhere is raw->_unmapped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildQuarantineItems,
  canonicalizeRow,
  classifyRejectReason,
  collectUnmappedColumns,
  quarantineFingerprint,
  redactSample,
  UNMAPPED_RAW_KEY,
  UNMAPPED_SAMPLE_LIMIT,
  withUnmappedValues,
} from '@/lib/pms/quarantine';

const HOTEL_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const HOTEL_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const BAD_ROW = { room_number: '204', status: 'sparkling', occupancy: 240 };

// ─── Fingerprint composition ───────────────────────────────────────────────

describe('quarantineFingerprint — identity of "this same bad row, again"', () => {
  it('is stable for the same row, hotel, table and reason', () => {
    const a = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 'pms_room_status_log', reasonCode: 'enum', rawRow: BAD_ROW });
    const b = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 'pms_room_status_log', reasonCode: 'enum', rawRow: { ...BAD_ROW } });
    assert.equal(a, b);
  });

  it('SEPARATES two hotels with the identical bad row', () => {
    // Without property_id in the hash, fixing hotel A's parser would appear to
    // resolve hotel B's problem and hotel B's rows would vanish from the queue.
    const a = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 'pms_room_status_log', reasonCode: 'enum', rawRow: BAD_ROW });
    const b = quarantineFingerprint({ propertyId: HOTEL_B, targetTable: 'pms_room_status_log', reasonCode: 'enum', rawRow: BAD_ROW });
    assert.notEqual(a, b);
  });

  it('SEPARATES the same row failing in two different tables', () => {
    const a = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 'pms_room_status_log', reasonCode: 'enum', rawRow: BAD_ROW });
    const b = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 'pms_work_orders_v2', reasonCode: 'enum', rawRow: BAD_ROW });
    assert.notEqual(a, b);
  });

  it('SEPARATES the same row failing for a NEW reason after a parser change', () => {
    const a = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 'pms_room_status_log', reasonCode: 'enum', rawRow: BAD_ROW });
    const b = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 'pms_room_status_log', reasonCode: 'range', rawRow: BAD_ROW });
    assert.notEqual(a, b);
  });

  it('ignores cosmetic churn: column order, surrounding whitespace, letter case', () => {
    const a = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 't', reasonCode: 'enum', rawRow: { room_number: '204', status: 'Sparkling' } });
    const b = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 't', reasonCode: 'enum', rawRow: { status: '  sparkling ', room_number: '204' } });
    assert.equal(a, b);
  });

  it('with a natural key, an unrelated column churning does NOT manufacture a new item', () => {
    // Otherwise every delivery invents a fresh "problem" because the report
    // stamps a new generated-at value on each row, and the queue becomes
    // unreadable within a day.
    const key = ['property_id', 'room_number'] as const;
    const a = quarantineFingerprint({
      propertyId: HOTEL_A, targetTable: 'pms_room_status_log', reasonCode: 'enum',
      rawRow: { property_id: HOTEL_A, room_number: '204', generated_at: '06:40' }, naturalKey: key,
    });
    const b = quarantineFingerprint({
      propertyId: HOTEL_A, targetTable: 'pms_room_status_log', reasonCode: 'enum',
      rawRow: { property_id: HOTEL_A, room_number: '204', generated_at: '07:10' }, naturalKey: key,
    });
    assert.equal(a, b);
  });

  it('with a natural key, a DIFFERENT key value is a different item', () => {
    const key = ['room_number'] as const;
    const a = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 't', reasonCode: 'enum', rawRow: { room_number: '204', x: 1 }, naturalKey: key });
    const b = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 't', reasonCode: 'enum', rawRow: { room_number: '205', x: 1 }, naturalKey: key });
    assert.notEqual(a, b);
  });

  it('falls back to the whole row when the declared natural key is absent from it', () => {
    const withKey = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 't', reasonCode: 'parse', rawRow: { a: 1 }, naturalKey: ['room_number'] });
    const without = quarantineFingerprint({ propertyId: HOTEL_A, targetTable: 't', reasonCode: 'parse', rawRow: { a: 1 } });
    assert.equal(withKey, without);
  });

  it('canonicalizeRow is order-independent', () => {
    assert.equal(canonicalizeRow({ b: 2, a: 1 }), canonicalizeRow({ a: 1, b: 2 }));
    assert.notEqual(canonicalizeRow({ a: 1 }), canonicalizeRow({ a: 2 }));
  });
});

// ─── Reason classification ─────────────────────────────────────────────────

describe('classifyRejectReason — the validator sentence becomes something groupable', () => {
  const cases: Array<[string, string]> = [
    ['missing required field room_number', 'missing_required'],
    ['occupancy "240" out of range 0..100', 'range'],
    ['status "sparkling" is not an allowed value', 'enum'],
    ['expected a number for rate_per_night_cents', 'type_mismatch'],
    ['cross-field check failed: parts do not sum to total_rooms', 'cross_field'],
    ['malformed CSV row — unterminated quote', 'parse'],
    ['duplicate key for (property_id, room_number)', 'duplicate_key'],
  ];
  for (const [sentence, code] of cases) {
    it(`"${sentence}" → ${code}`, () => {
      assert.equal(classifyRejectReason(sentence), code);
    });
  }

  it('an unrecognised sentence is "unknown", never a dropped row', () => {
    assert.equal(classifyRejectReason('the gremlins got it'), 'unknown');
    assert.equal(classifyRejectReason(null), 'unknown');
    assert.equal(classifyRejectReason(''), 'unknown');
  });
});

// ─── The per-delivery accounting fix ───────────────────────────────────────

describe('buildQuarantineItems — every rejected row is accounted for', () => {
  const rejected = [
    { rowIndex: 2, row: { room_number: '204', status: 'sparkling' }, reason: 'status "sparkling" is not an allowed value' },
    { rowIndex: 5, row: { room_number: '311', occupancy: 240 }, reason: 'occupancy "240" out of range 0..100' },
    { rowIndex: 9, row: { room_number: '' }, reason: 'missing required field room_number' },
  ];

  it('produces one item per rejected row, none dropped', () => {
    const items = buildQuarantineItems({
      propertyId: HOTEL_A, deliveryId: 'd1', targetTable: 'pms_room_status_log', rejected,
    });
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.reasonCode).sort(), ['enum', 'missing_required', 'range']);
    assert.deepEqual(items.map((i) => i.rowIndex).sort((a, b) => (a ?? 0) - (b ?? 0)), [2, 5, 9]);
  });

  it('keeps the raw row so a parser fix can replay it', () => {
    const items = buildQuarantineItems({ propertyId: HOTEL_A, targetTable: 't', rejected });
    assert.deepEqual(items[0]!.rawRow, rejected[0]!.row);
  });

  it('collapses the SAME problem row appearing twice WITHIN one delivery', () => {
    const items = buildQuarantineItems({
      propertyId: HOTEL_A, deliveryId: 'd1', targetTable: 't',
      rejected: [rejected[0]!, { ...rejected[0]!, rowIndex: 40 }],
    });
    assert.equal(items.length, 1);
  });

  it('does NOT collapse across deliveries — this is the wedge fix', () => {
    // The original design deduped globally on fingerprint, so delivery #2
    // carrying the same 3 persistent bad rows produced ZERO quarantine rows,
    // reported rows_quarantined = 0 against a short rows_written, and could
    // never be marked 'parsed'. Each delivery must own its rejects.
    const d1 = buildQuarantineItems({ propertyId: HOTEL_A, deliveryId: 'delivery-1', targetTable: 't', rejected });
    const d2 = buildQuarantineItems({ propertyId: HOTEL_A, deliveryId: 'delivery-2', targetTable: 't', rejected });
    assert.equal(d1.length, 3);
    assert.equal(d2.length, 3);
    assert.deepEqual(d1.map((i) => i.fingerprint).sort(), d2.map((i) => i.fingerprint).sort());
    assert.deepEqual([...new Set(d1.map((i) => i.deliveryId))], ['delivery-1']);
    assert.deepEqual([...new Set(d2.map((i) => i.deliveryId))], ['delivery-2']);
  });

  it('works with no delivery id at all — a reject is worth keeping either way', () => {
    const items = buildQuarantineItems({ propertyId: HOTEL_A, targetTable: 't', rejected });
    assert.equal(items.length, 3);
    assert.deepEqual([...new Set(items.map((i) => i.deliveryId))], [null]);
  });

  it('truncates a runaway reason_detail rather than storing an essay', () => {
    const items = buildQuarantineItems({
      propertyId: HOTEL_A, targetTable: 't',
      rejected: [{ rowIndex: 1, row: { a: 1 }, reason: 'x'.repeat(5000) }],
    });
    assert.equal(items[0]!.reasonDetail!.length, 500);
  });
});

// ─── Unmapped columns ──────────────────────────────────────────────────────

describe('collectUnmappedColumns — a column we do not recognise is captured', () => {
  const known = ['room_number', 'status'];

  it('reports a column absent from the descriptor', () => {
    const found = collectUnmappedColumns({
      propertyId: HOTEL_A, reportType: 'Housekeeping Status', targetTable: 'pms_room_status_log',
      knownColumns: known,
      rows: [{ room_number: '204', status: 'clean', 'Loyalty Tier': 'Diamond' }],
    });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.columnLabel, 'Loyalty Tier');
    assert.equal(found[0]!.occurrences, 1);
  });

  it('does NOT report `raw` — the founder-custom bucket is not a PMS column', () => {
    const found = collectUnmappedColumns({
      propertyId: HOTEL_A, reportType: 'r', targetTable: 't', knownColumns: known,
      rows: [{ room_number: '204', raw: { anything: 1 }, [UNMAPPED_RAW_KEY]: { x: 1 } }],
    });
    assert.deepEqual(found, []);
  });

  it('counts occurrences across rows and matches case-insensitively', () => {
    const found = collectUnmappedColumns({
      propertyId: HOTEL_A, reportType: 'r', targetTable: 't', knownColumns: ['Room_Number'],
      rows: [
        { room_number: '204', 'Loyalty Tier': 'Diamond' },
        { room_number: '205', 'loyalty tier': 'Gold' },
      ],
    });
    assert.equal(found.length, 1);
    assert.equal(found[0]!.occurrences, 2);
  });

  it('keeps at most three distinct sample values', () => {
    const found = collectUnmappedColumns({
      propertyId: HOTEL_A, reportType: 'r', targetTable: 't', knownColumns: [],
      rows: [1, 2, 3, 4, 5].map((n) => ({ tier: `t${n}` })),
    });
    assert.equal(found[0]!.sampleValues.length, UNMAPPED_SAMPLE_LIMIT);
  });

  it('redacts guest PII on the way IN — an unknown column is exactly where it shows up', () => {
    const found = collectUnmappedColumns({
      propertyId: HOTEL_A, reportType: 'r', targetTable: 't', knownColumns: [],
      rows: [{ contact: 'jane.doe@example.com' }, { contact: '(409) 555-0134' }],
    });
    assert.deepEqual(found[0]!.sampleValues, ['<email>', '<phone>']);
  });

  it('redactSample handles card-shaped digit runs and caps length', () => {
    assert.equal(redactSample('4111 1111 1111 1111'), '<card>');
    assert.equal(redactSample('x'.repeat(500)).length, 120);
  });
});

describe('withUnmappedValues — the value lands even if nobody opens the queue', () => {
  it('parks unknown values under the reserved key without touching the rest of raw', () => {
    const raw = withUnmappedValues({ founder_note: 'keep me' }, { 'Loyalty Tier': 'Diamond' });
    assert.equal(raw.founder_note, 'keep me');
    assert.deepEqual(raw[UNMAPPED_RAW_KEY], { 'Loyalty Tier': 'Diamond' });
  });

  it('merges with an existing _unmapped bucket rather than replacing it', () => {
    const raw = withUnmappedValues({ [UNMAPPED_RAW_KEY]: { A: 1 } }, { B: 2 });
    assert.deepEqual(raw[UNMAPPED_RAW_KEY], { A: 1, B: 2 });
  });

  it('does not mutate the caller\'s raw object', () => {
    const original: Record<string, unknown> = { a: 1 };
    withUnmappedValues(original, { B: 2 });
    assert.deepEqual(original, { a: 1 });
  });

  it('is a no-op when there is nothing unmapped', () => {
    assert.deepEqual(withUnmappedValues({ a: 1 }, {}), { a: 1 });
  });

  it('survives a corrupt existing _unmapped value instead of throwing', () => {
    const raw = withUnmappedValues({ [UNMAPPED_RAW_KEY]: 'not an object' }, { B: 2 });
    assert.deepEqual(raw[UNMAPPED_RAW_KEY], { B: 2 });
  });
});
