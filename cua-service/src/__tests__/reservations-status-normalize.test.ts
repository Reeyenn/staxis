// Regression fix: pms_reservations.status has a LIVE DB CHECK
// (booked/checked_in/checked_out/cancelled/no_show or null) but an empty 0207
// descriptor allowed_values, so a raw learned status used to write straight
// through and the CHECK rejected the WHOLE arrivals/departures reservation row
// (batch loss). Giving the column its canonical enumValues routes it through
// generic_enum: known/learned → canonical, anything else → null (status is
// optional, so the reservation still writes). These pin that behavior.

import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveColumnParser } from '../target-contract.js';
import { getParser } from '../parsers/registry.js';
import '../parsers/generic.js';

const CANON = ['booked', 'checked_in', 'checked_out', 'cancelled', 'no_show'];

describe('pms_reservations.status is normalized, never raw (no batch loss)', () => {
  for (const action of ['getArrivals', 'getDepartures'] as const) {
    test(`${action}.status routes through generic_enum with null-on-unknown`, () => {
      // Legacy / unlearned recipe (no learned mapping): still an enum parser,
      // and 'unknown' is NOT a CHECK value so onUnknown must be null.
      const r = resolveColumnParser(action, 'status', { valueTranslations: {} });
      assert.equal(r?.parser, 'generic_enum');
      assert.equal(r?.config?.onUnknown ?? null, null);
    });

    test(`${action}.status uses the self-learned mapping when present`, () => {
      const r = resolveColumnParser(action, 'status', {
        valueTranslations: { 'pms_reservations.status': { 'Due In': 'checked_in', 'Due Out': 'checked_out' } },
      });
      assert.equal(r?.parser, 'generic_enum');
      assert.deepEqual(r?.config?.mapping, { 'Due In': 'checked_in', 'Due Out': 'checked_out' });
    });
  }

  test('generic_enum never emits a non-canonical raw value', () => {
    const ge = getParser('generic_enum')!;
    // Unknown raw, no mapping → null (not the raw string) → passes the CHECK.
    assert.equal(ge('Reserved', { onUnknown: null }), null);
    assert.equal(ge('Due In', { onUnknown: null }), null);
    // With a learned mapping the PMS word maps to a canonical value.
    assert.equal(ge('Due In', { mapping: { 'Due In': 'checked_in' }, onUnknown: null }), 'checked_in');
    // An unmapped value alongside a mapping still nulls (never raw).
    assert.equal(ge('Weird', { mapping: { 'Due In': 'checked_in' }, onUnknown: null }), null);
    // Whatever it returns is canonical or null — never a CHECK violation.
    for (const v of ['Reserved', 'In House', 'CHECKED IN', 'no-show', '']) {
      const out = ge(v, { mapping: { 'CHECKED IN': 'checked_in' }, onUnknown: null });
      assert.ok(out === null || CANON.includes(out as string), `got non-canonical: ${out}`);
    }
  });
});
