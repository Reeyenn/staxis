/**
 * Tests for parseRoomList + validateRoomNumbers in src/lib/api-validate.ts.
 *
 * Round 15 follow-up (2026-05-14). Adds optional `roomNumbers` capture to
 * the admin Create Hotel form so phantom-seed can populate every room
 * from day 1 instead of waiting for a PMS sync that may never come.
 *
 * The parser accepts comma + whitespace separated tokens with optional
 * "N-M" numeric ranges. The validator catches dupes, empties, whitespace,
 * and length caps after the parser produces the array.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRoomList, validateRoomNumbers } from '@/lib/api-validate';

describe('parseRoomList', () => {
  it('parses a single number', () => {
    assert.deepEqual(parseRoomList('101').value, ['101']);
  });

  it('parses a comma-separated list', () => {
    assert.deepEqual(parseRoomList('101, 102, 103').value, ['101', '102', '103']);
  });

  it('expands a numeric range', () => {
    assert.deepEqual(parseRoomList('101-103').value, ['101', '102', '103']);
  });

  it('mixes single + range + single', () => {
    assert.deepEqual(
      parseRoomList('101-103, 200, 300-302').value,
      ['101', '102', '103', '200', '300', '301', '302'],
    );
  });

  it('handles the US "skip 13s" common pattern', () => {
    // 101-112, 114-122 — 21 rooms total (skipping 113)
    const r = parseRoomList('101-112, 114-122').value!;
    assert.equal(r.length, 21);
    assert.equal(r.includes('113'), false);
    assert.equal(r[0], '101');
    assert.equal(r[r.length - 1], '122');
  });

  it('treats newlines and semicolons as separators', () => {
    assert.deepEqual(parseRoomList('401\n402\n403').value, ['401', '402', '403']);
    assert.deepEqual(parseRoomList('501; 502; 503').value, ['501', '502', '503']);
  });

  it('empty input returns empty array (no error)', () => {
    assert.deepEqual(parseRoomList('').value, []);
    assert.deepEqual(parseRoomList('   ').value, []);
    assert.deepEqual(parseRoomList(',  ,  ,').value, []);
  });

  it('preserves alphanumeric room numbers', () => {
    assert.deepEqual(parseRoomList('Suite-A, Suite-B, L1-301').value, ['Suite-A', 'Suite-B', 'L1-301']);
  });

  it('rejects a range where start > end', () => {
    const r = parseRoomList('110-101');
    assert.ok(r.error);
    assert.match(r.error!, /backwards/i);
  });

  it('rejects an oversized range (> 5000)', () => {
    const r = parseRoomList('1-10000');
    assert.ok(r.error);
    assert.match(r.error!, /too large/i);
  });

  it('rejects whitespace inside a token', () => {
    // "101 102" without a separator — should error rather than silently
    // join. The split handles whitespace so this case actually splits
    // into two tokens; the invalid-char test fires when chars like
    // ! or @ leak in.
    const r = parseRoomList('101@102');
    assert.ok(r.error);
    assert.match(r.error!, /invalid characters/i);
  });

  it('range form must be digit-digit (alphanumeric ranges rejected)', () => {
    // "A1-A5" gets parsed as a single token (no whitespace) but the
    // char-class regex /^[A-Za-z0-9_-]+$/ accepts it, so it becomes
    // ['A1-A5'] not a range expansion. This is the documented limit.
    assert.deepEqual(parseRoomList('A1-A5').value, ['A1-A5']);
  });
});

describe('validateRoomNumbers', () => {
  it('accepts a clean string array', () => {
    const r = validateRoomNumbers(['101', '102', '103']);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.value, ['101', '102', '103']);
  });

  it('trims each entry', () => {
    const r = validateRoomNumbers(['  101  ', '102']);
    assert.deepEqual(r.value, ['101', '102']);
  });

  it('rejects non-arrays', () => {
    const r = validateRoomNumbers('101,102');
    assert.ok(r.error);
    assert.match(r.error!, /must be an array/i);
  });

  it('rejects empty entries', () => {
    const r = validateRoomNumbers(['101', '', '103']);
    assert.ok(r.error);
    assert.match(r.error!, /empty/i);
  });

  it('rejects entries with whitespace inside', () => {
    const r = validateRoomNumbers(['101', 'Suite A', '103']);
    assert.ok(r.error);
    assert.match(r.error!, /whitespace/i);
  });

  it('rejects duplicates', () => {
    const r = validateRoomNumbers(['101', '102', '101']);
    assert.ok(r.error);
    assert.match(r.error!, /duplicate/i);
    assert.match(r.error!, /101/);
  });

  it('rejects non-string entries', () => {
    const r = validateRoomNumbers(['101', 102 as unknown as string, '103']);
    assert.ok(r.error);
    assert.match(r.error!, /must be a string/i);
  });

  it('rejects entries over 10 chars', () => {
    const r = validateRoomNumbers(['101', '12345678901']);
    assert.ok(r.error);
    assert.match(r.error!, /too long/i);
  });

  it('rejects arrays over 2000 entries', () => {
    const tooMany = Array.from({ length: 2001 }, (_, i) => String(i + 1));
    const r = validateRoomNumbers(tooMany);
    assert.ok(r.error);
    assert.match(r.error!, /too long/i);
  });

  it('accepts an empty array', () => {
    const r = validateRoomNumbers([]);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.value, []);
  });

  it('accepts exactly 2000 entries (boundary)', () => {
    const exact = Array.from({ length: 2000 }, (_, i) => String(i + 1));
    const r = validateRoomNumbers(exact);
    assert.equal(r.error, undefined);
    assert.equal(r.value!.length, 2000);
  });
});

describe('parseRoomList + validateRoomNumbers integration', () => {
  it('parse then validate the Comfort Suites Beaumont room list', () => {
    // Floor 1: 9 rooms (skip 107, 109, 111)
    // Floor 2: 21 rooms (skip 213)
    // Floor 3: 22 rooms (skip 313)
    // Floor 4: 22 rooms (skip 413)
    // Total: 74 rooms — matches migration 0025 backfill
    const input = `
      101, 102, 103, 104, 105, 106, 108, 110, 112,
      201-212, 214-222,
      300-312, 314-322,
      400-412, 414-422
    `;
    const parsed = parseRoomList(input);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.value!.length, 74);

    const validated = validateRoomNumbers(parsed.value);
    assert.equal(validated.error, undefined);
    assert.equal(validated.value!.length, 74);
  });

  it('overlapping ranges produce dupes that the validator catches', () => {
    // "101-103, 102-104" expands to ["101","102","103","102","103","104"]
    // — the parser allows the dupes; validator rejects them.
    const parsed = parseRoomList('101-103, 102-104');
    assert.deepEqual(parsed.value, ['101', '102', '103', '102', '103', '104']);
    const validated = validateRoomNumbers(parsed.value);
    assert.ok(validated.error);
    assert.match(validated.error!, /duplicate/i);
  });
});
