/**
 * Date-placeholder rendering (Chat 1 plumbing) — the stale-date guard's core.
 *
 * Proves offline that {today}/{date} placeholders render to the CURRENT date
 * at CALL time (injectable clock), in the hotel's timezone (not UTC), in the
 * PMS's learned format (ISO fallback), with context-correct percent-encoding.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderDatePlaceholders,
  renderBodyDatePlaceholders,
  hasDatePlaceholder,
  todayParts,
} from '../extractors/date-template.js';
import type { LearnedDateFormat } from '../types.js';

// 2026-06-10 12:00 UTC = 2026-06-10 07:00 in America/Chicago (same date).
const NOON_UTC = new Date('2026-06-10T12:00:00Z');
// 2026-06-11 03:00 UTC = 2026-06-10 22:00 in America/Chicago — the UTC date
// has already flipped to tomorrow; the hotel's business date has not.
const LATE_EVENING = new Date('2026-06-11T03:00:00Z');

const MDY: LearnedDateFormat = { order: 'MDY', separator: '/', confidence: 'high' };
const DMY_LOW: LearnedDateFormat = { order: 'DMY', separator: '/', confidence: 'low' };

describe('renderDatePlaceholders', () => {
  test('bare {today} with no learned format renders ISO', () => {
    const out = renderDatePlaceholders('https://pms.example/api?start={today}', {
      context: 'url', now: NOON_UTC,
    });
    assert.equal(out, 'https://pms.example/api?start=2026-06-10');
  });

  test('{date} is an alias of {today}', () => {
    const a = renderDatePlaceholders('x={date}', { context: 'url', now: NOON_UTC });
    const b = renderDatePlaceholders('x={today}', { context: 'url', now: NOON_UTC });
    assert.equal(a, b);
  });

  test('learned high-confidence MDY renders the PMS format (url-encoded in URLs)', () => {
    const out = renderDatePlaceholders('https://pms.example/api?d={today}', {
      context: 'url', learnedFormat: MDY, now: NOON_UTC,
    });
    assert.equal(out, 'https://pms.example/api?d=06%2F10%2F2026');
  });

  test('learned LOW-confidence format is NOT trusted — ISO fallback', () => {
    const out = renderDatePlaceholders('d={today}', {
      context: 'json', learnedFormat: DMY_LOW, now: NOON_UTC,
    });
    assert.equal(out, 'd=2026-06-10');
  });

  test('explicit token format beats the learned format', () => {
    const out = renderDatePlaceholders('d={today:DD.MM.YYYY}', {
      context: 'json', learnedFormat: MDY, now: NOON_UTC,
    });
    assert.equal(out, 'd=10.06.2026');
  });

  test('unpadded tokens M/D render without leading zeros', () => {
    const out = renderDatePlaceholders('d={today:M/D/YYYY}', {
      context: 'json', now: NOON_UTC,
    });
    assert.equal(out, 'd=6/10/2026');
  });

  test('timezone, not UTC: late evening in Chicago is still TODAY', () => {
    const out = renderDatePlaceholders('d={today}', { context: 'json', now: LATE_EVENING });
    // UTC date at this instant is 2026-06-11; the hotel's business date is 06-10.
    assert.equal(out, 'd=2026-06-10');
  });

  test('explicit timezone option is honored', () => {
    // 03:00 UTC = 12:00 in Tokyo on the 11th.
    const out = renderDatePlaceholders('d={today}', {
      context: 'json', timezone: 'Asia/Tokyo', now: LATE_EVENING,
    });
    assert.equal(out, 'd=2026-06-11');
  });

  test('multiple placeholders all render', () => {
    const out = renderDatePlaceholders('s={today}&e={date}', { context: 'json', now: NOON_UTC });
    assert.equal(out, 's=2026-06-10&e=2026-06-10');
  });

  test('strings without placeholders pass through untouched (idempotent layering)', () => {
    const input = 'https://pms.example/api?start=2026-06-09';
    assert.equal(renderDatePlaceholders(input, { context: 'url', now: NOON_UTC }), input);
    // Double-render is a no-op: once rendered, no placeholders remain.
    const once = renderDatePlaceholders('d={today}', { context: 'url', now: NOON_UTC });
    assert.equal(renderDatePlaceholders(once, { context: 'url', now: NOON_UTC }), once);
  });

  test('call-time evaluation: two different clocks produce two different dates', () => {
    const a = renderDatePlaceholders('d={today}', { context: 'json', now: new Date('2026-06-09T12:00:00Z') });
    const b = renderDatePlaceholders('d={today}', { context: 'json', now: NOON_UTC });
    assert.equal(a, 'd=2026-06-09');
    assert.equal(b, 'd=2026-06-10');
  });
});

describe('renderBodyDatePlaceholders', () => {
  test('JSON string body renders RAW (no percent-encoding inside JSON)', () => {
    const out = renderBodyDatePlaceholders('{"start":"{today}"}', {
      learnedFormat: MDY, now: NOON_UTC,
    });
    assert.equal(out, '{"start":"06/10/2026"}');
  });

  test('form-encoded string body renders ENCODED', () => {
    const out = renderBodyDatePlaceholders('start={today}&rooms=all', {
      learnedFormat: MDY, now: NOON_UTC,
    });
    assert.equal(out, 'start=06%2F10%2F2026&rooms=all');
  });

  test('object body renders each string value raw, leaves non-strings alone', () => {
    const out = renderBodyDatePlaceholders(
      { start: '{today}', count: 5, nested: null },
      { learnedFormat: MDY, now: NOON_UTC },
    ) as Record<string, unknown>;
    assert.equal(out.start, '06/10/2026');
    assert.equal(out.count, 5);
    assert.equal(out.nested, null);
  });

  test('undefined body stays undefined', () => {
    assert.equal(renderBodyDatePlaceholders(undefined, { now: NOON_UTC }), undefined);
  });
});

describe('helpers', () => {
  test('hasDatePlaceholder detects bare + formatted forms only', () => {
    assert.equal(hasDatePlaceholder('a={today}'), true);
    assert.equal(hasDatePlaceholder('a={date:MM/DD/YYYY}'), true);
    assert.equal(hasDatePlaceholder('a={tomorrow}'), false);
    assert.equal(hasDatePlaceholder('plain'), false);
  });

  test('todayParts formats per-timezone calendar date', () => {
    const p = todayParts('America/Chicago', LATE_EVENING);
    assert.deepEqual(p, { year: '2026', month: '06', day: '10' });
  });
});
