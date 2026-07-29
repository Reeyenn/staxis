import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stampRowsForWrite,
  validateRows,
  type TableSchemaDescriptor,
} from '../persistence/generic-table-writer.js';

const DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_lineage_test',
  write_strategy: 'append',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'room_number', 'changed_at'],
  reconcile_key_field: null,
  columns: [
    { name: 'room_number', type: 'text', required: true, nullable: false },
    { name: 'status', type: 'text', required: true, nullable: false },
    { name: 'changed_at', type: 'timestamptz', required: true, nullable: false },
  ],
};

const PROPERTY_ID = '00000000-0000-4000-8000-000000000001';
const INGEST_RUN_ID = '00000000-0000-4000-8000-000000000002';
const SOURCE_CAPTURED_AT = '2026-07-27T20:15:00.000Z';

test('stampRowsForWrite owns tenant/receipt fields and deterministically stamps missing event time', () => {
  const source = [{
    property_id: 'untrusted-property',
    ingest_run_id: 'untrusted-run',
    room_number: 208,
    status: true,
  }];

  const first = stampRowsForWrite(
    source,
    PROPERTY_ID,
    INGEST_RUN_ID,
    SOURCE_CAPTURED_AT,
    DESCRIPTOR,
  );
  const replay = stampRowsForWrite(
    source,
    PROPERTY_ID,
    INGEST_RUN_ID,
    SOURCE_CAPTURED_AT,
    DESCRIPTOR,
  );

  assert.deepEqual(first, replay, 'replaying the same observation produces the same append key');
  assert.deepEqual(first[0], {
    property_id: PROPERTY_ID,
    ingest_run_id: INGEST_RUN_ID,
    room_number: '208',
    status: 'true',
    changed_at: SOURCE_CAPTURED_AT,
  });
  assert.deepEqual(source[0], {
    property_id: 'untrusted-property',
    ingest_run_id: 'untrusted-run',
    room_number: 208,
    status: true,
  }, 'stamping does not mutate extractor-owned input');
});

test('stampRowsForWrite preserves explicit source timestamps and does not hide an explicit null', () => {
  const extractedTime = '2026-07-27T19:00:00.000Z';
  const stamped = stampRowsForWrite(
    [
      { room_number: '101', status: 'dirty', changed_at: extractedTime },
      { room_number: '102', status: 'clean', changed_at: null },
    ],
    PROPERTY_ID,
    INGEST_RUN_ID,
    SOURCE_CAPTURED_AT,
    DESCRIPTOR,
  );

  assert.equal(stamped[0]!.changed_at, extractedTime);
  assert.equal(stamped[1]!.changed_at, null);

  const outcome = validateRows(stamped, DESCRIPTOR);
  assert.equal(outcome.valid.length, 1);
  assert.equal(outcome.rejected.length, 1);
  assert.match(outcome.rejected[0]!.reason, /required field "changed_at" missing/);
});
