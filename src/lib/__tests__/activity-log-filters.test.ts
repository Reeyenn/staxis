/**
 * Activity log — filter parsing + query helpers.
 *
 * Validates the URLSearchParams → ActivityQueryFilters mapping that the
 * Settings page + API routes use. Specifically:
 *   - propertyId required + UUID-shaped
 *   - from/to validate as parseable timestamps
 *   - multi-valued category/source via repeat OR comma list
 *   - unknown enum values silently dropped
 *   - clampPage / clampPageSize behave at edges
 *   - escapeIlike neutralizes wildcard chars
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseActivityFilters } from '../activity-log/filters';
import { clampPage, clampPageSize, escapeIlike } from '../activity-log/pure';

const PID = '11111111-2222-3333-4444-555555555555';

function parse(s: string) {
  return parseActivityFilters(new URLSearchParams(s));
}

describe('parseActivityFilters', () => {
  test('requires a UUID-shaped propertyId', () => {
    assert.equal(parse('').ok, false);
    assert.equal(parse('propertyId=not-a-uuid').ok, false);
    const ok = parse(`propertyId=${PID}`);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.filters.propertyId, PID);
  });

  test('rejects an unparseable from/to', () => {
    const bad = parse(`propertyId=${PID}&from=tomorrow-ish`);
    assert.equal(bad.ok, false);
  });

  test('accepts ISO from/to', () => {
    const r = parse(`propertyId=${PID}&from=2026-05-01T00:00:00Z&to=2026-05-25T00:00:00Z`);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.filters.from, '2026-05-01T00:00:00Z');
      assert.equal(r.filters.to, '2026-05-25T00:00:00Z');
    }
  });

  test('reads multi-valued category via repeat OR comma list', () => {
    const r1 = parse(`propertyId=${PID}&category=housekeeping&category=staff`);
    const r2 = parse(`propertyId=${PID}&categories=housekeeping,staff`);
    assert.equal(r1.ok, true); assert.equal(r2.ok, true);
    if (r1.ok && r2.ok) {
      assert.deepEqual([...new Set(r1.filters.categories!)].sort(), ['housekeeping', 'staff']);
      assert.deepEqual([...new Set(r2.filters.categories!)].sort(), ['housekeeping', 'staff']);
    }
  });

  test('silently drops unknown enum values', () => {
    const r = parse(`propertyId=${PID}&categories=housekeeping,bogus,staff`);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual([...new Set(r.filters.categories!)].sort(), ['housekeeping', 'staff']);
    }
  });

  test('rejects an invalid actorAccountId', () => {
    const r = parse(`propertyId=${PID}&actorAccountId=not-a-uuid`);
    assert.equal(r.ok, false);
  });

  test('trims search and drops empty', () => {
    const r1 = parse(`propertyId=${PID}&search=%20%20`);
    const r2 = parse(`propertyId=${PID}&search=room+305`);
    assert.equal(r1.ok, true); assert.equal(r2.ok, true);
    if (r1.ok && r2.ok) {
      assert.equal(r1.filters.search, undefined);
      assert.equal(r2.filters.search, 'room 305');
    }
  });

  test('passes through page + pageSize numbers', () => {
    const r = parse(`propertyId=${PID}&page=4&pageSize=25`);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.filters.page, 4);
      assert.equal(r.filters.pageSize, 25);
    }
  });
});

describe('clampPage / clampPageSize', () => {
  test('clampPage defaults non-positive to 1', () => {
    assert.equal(clampPage(undefined), 1);
    assert.equal(clampPage(0), 1);
    assert.equal(clampPage(-5), 1);
    assert.equal(clampPage(Number.NaN), 1);
    assert.equal(clampPage(7), 7);
  });

  test('clampPageSize defaults to 50 and caps at 200', () => {
    assert.equal(clampPageSize(undefined), 50);
    assert.equal(clampPageSize(0), 50);
    assert.equal(clampPageSize(25), 25);
    assert.equal(clampPageSize(999), 200);
  });
});

describe('escapeIlike', () => {
  test('escapes wildcard metacharacters', () => {
    assert.equal(escapeIlike('room 305'), 'room 305');
    assert.equal(escapeIlike('100%'), '100\\%');
    assert.equal(escapeIlike('a_b'), 'a\\_b');
    assert.equal(escapeIlike('back\\slash'), 'back\\\\slash');
  });
});
