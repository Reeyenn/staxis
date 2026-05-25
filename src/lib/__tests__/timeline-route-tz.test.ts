/**
 * Tests for localDateTimeToUtcIso — the helper that turns a property
 * timezone + business date + local hour into the UTC ISO the timeline
 * route emits as `shift.start_iso`.
 *
 * Why this is locked down separately from the layout tests: getting
 * "7am local on 2026-05-24 in America/Chicago" wrong would shift the
 * entire timeline by an hour relative to the hour labels. The layout
 * math itself is sound — but if start_iso is wrong, every card lands
 * an hour off.
 *
 * Run via: npx tsx --test src/lib/__tests__/timeline-route-tz.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { localDateTimeToUtcIso } from '../timeline-layout';

describe('localDateTimeToUtcIso', () => {
  test('America/Chicago 7am on a CDT (summer) day → 12:00 UTC', () => {
    // 2026-05-24 is in Daylight Time (CDT, UTC-5). 7am CDT = 12:00 UTC.
    const iso = localDateTimeToUtcIso('2026-05-24', 7, 'America/Chicago');
    assert.equal(iso, '2026-05-24T12:00:00.000Z');
  });

  test('America/Chicago 7am on a CST (winter) day → 13:00 UTC', () => {
    // 2026-01-15 is in Standard Time (CST, UTC-6). 7am CST = 13:00 UTC.
    const iso = localDateTimeToUtcIso('2026-01-15', 7, 'America/Chicago');
    assert.equal(iso, '2026-01-15T13:00:00.000Z');
  });

  test('America/New_York 7am on a EDT day → 11:00 UTC', () => {
    // 2026-06-15 is EDT (UTC-4). 7am EDT = 11:00 UTC.
    const iso = localDateTimeToUtcIso('2026-06-15', 7, 'America/New_York');
    assert.equal(iso, '2026-06-15T11:00:00.000Z');
  });

  test('America/Los_Angeles 8am on a PDT day → 15:00 UTC', () => {
    // 2026-08-01 is PDT (UTC-7). 8am PDT = 15:00 UTC.
    const iso = localDateTimeToUtcIso('2026-08-01', 8, 'America/Los_Angeles');
    assert.equal(iso, '2026-08-01T15:00:00.000Z');
  });

  test('UTC zone passes through unchanged', () => {
    const iso = localDateTimeToUtcIso('2026-05-24', 7, 'UTC');
    assert.equal(iso, '2026-05-24T07:00:00.000Z');
  });

  test('DST spring-forward day in Chicago — 7am local lands on the correct UTC instant', () => {
    // 2026-03-08 is the DST transition day in the US: at 2am local the
    // clock jumps to 3am. 7am CDT (UTC-5) = 12:00 UTC.
    // A naive one-pass conversion using the offset BEFORE the transition
    // (-6h) emits 13:00 UTC, off by an hour. The iterative refinement
    // walks back the candidate until the displayed wall-clock matches.
    const iso = localDateTimeToUtcIso('2026-03-08', 7, 'America/Chicago');
    assert.equal(iso, '2026-03-08T12:00:00.000Z');
  });

  test('DST fall-back day in Chicago — 7am local resolves to CST UTC instant', () => {
    // 2026-11-01 is the fall-back day. At 2am local the clock rewinds to
    // 1am. 7am happens well after the rewind, in CST (UTC-6) → 13:00 UTC.
    const iso = localDateTimeToUtcIso('2026-11-01', 7, 'America/Chicago');
    assert.equal(iso, '2026-11-01T13:00:00.000Z');
  });

  test('throws on malformed date string', () => {
    assert.throws(() => localDateTimeToUtcIso('not-a-date', 7, 'UTC'));
  });
});
