/**
 * Tests for cua-service/src/commit-signal.ts.
 *
 * Pin the decision core of the deterministic commit-nudge (fix/cua-mapper-commit):
 *   - a repeating, multi-column structure counts as committable EVEN WITH ZERO
 *     data rows (an empty-but-structured feed is a complete, valid capture);
 *   - a single-column structure (a nav menu / list) does NOT;
 *   - the nudge fires only after the dither threshold AND only once per page;
 *   - the reminder text lists the feed's required fields, says empty-is-valid
 *     when the table is empty, preserves the sibling/heading distinction, and
 *     rejects committing a dashboard summary tile.
 *
 * Pure-function tests — no Playwright, no Anthropic, no DB, no env.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasCommittableStructure,
  shouldNudgeCommit,
  buildCommitNudge,
  COMMIT_DITHER_TURNS,
  COMMIT_MIN_COLUMNS,
  type TabularSummary,
} from '../commit-signal.js';
// target-contract.ts is a pure runtime leaf (type-only imports), so this needs
// no supabase/ws shim — it gates the commit-nudge's schema-sibling exclusion.
import { coreTargetSharesRequiredSchema } from '../target-contract.js';

const summary = (over: Partial<TabularSummary> = {}): TabularSummary => ({
  tableCount: 0,
  maxColumns: 0,
  maxDataRows: 0,
  ...over,
});

describe('hasCommittableStructure — structure, not row count, meets the floor', () => {
  test('a >=2-column table with rows is committable', () => {
    assert.equal(hasCommittableStructure(summary({ tableCount: 1, maxColumns: 4, maxDataRows: 9 })), true);
  });

  test('a >=2-column table with ZERO data rows is STILL committable (empty feed is valid)', () => {
    assert.equal(hasCommittableStructure(summary({ tableCount: 1, maxColumns: 3, maxDataRows: 0 })), true);
  });

  test('exactly COMMIT_MIN_COLUMNS columns qualifies', () => {
    assert.equal(
      hasCommittableStructure(summary({ tableCount: 1, maxColumns: COMMIT_MIN_COLUMNS, maxDataRows: 0 })),
      true,
    );
  });

  test('a single-column structure (nav menu / list) does NOT qualify', () => {
    assert.equal(hasCommittableStructure(summary({ tableCount: 1, maxColumns: 1, maxDataRows: 20 })), false);
  });

  test('no table at all does NOT qualify', () => {
    assert.equal(hasCommittableStructure(summary({ tableCount: 0, maxColumns: 0, maxDataRows: 0 })), false);
  });
});

describe('shouldNudgeCommit — dither + structure + not-yet-nudged', () => {
  const struct = summary({ tableCount: 1, maxColumns: 4, maxDataRows: 0 });

  test('fires once the dither threshold is met on a committable page', () => {
    assert.equal(
      shouldNudgeCommit({ samePageStreak: COMMIT_DITHER_TURNS, structure: struct, alreadyNudgedThisPage: false }),
      true,
    );
  });

  test('does NOT fire below the dither threshold', () => {
    assert.equal(
      shouldNudgeCommit({ samePageStreak: COMMIT_DITHER_TURNS - 1, structure: struct, alreadyNudgedThisPage: false }),
      false,
    );
  });

  test('does NOT fire when already nudged this page (fires at most once)', () => {
    assert.equal(
      shouldNudgeCommit({ samePageStreak: COMMIT_DITHER_TURNS + 5, structure: struct, alreadyNudgedThisPage: true }),
      false,
    );
  });

  test('does NOT fire without a committable structure even when dithering hard', () => {
    assert.equal(
      shouldNudgeCommit({
        samePageStreak: COMMIT_DITHER_TURNS + 5,
        structure: summary({ tableCount: 1, maxColumns: 1, maxDataRows: 30 }),
        alreadyNudgedThisPage: false,
      }),
      false,
    );
  });
});

describe('buildCommitNudge — safe, universal reminder text', () => {
  test('lists the feed required fields and preserves the sibling/heading + anti-widget guards', () => {
    const text = buildCommitNudge({
      actionName: 'getDepartures',
      requiredFields: ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date'],
      structure: summary({ tableCount: 1, maxColumns: 5, maxDataRows: 0 }),
    });
    assert.match(text, /pms_reservation_id/);
    assert.match(text, /guest_name/);
    // empty-is-valid language present when there are zero data rows
    assert.match(text, /ZERO data rows/);
    assert.match(text, /valid/i);
    // sibling / identity guard
    assert.match(text, /heading/i);
    assert.match(text, /different feed/i);
    // anti-widget guard
    assert.match(text, /summary/i);
    // universality: no PMS name leaks into the supervisor instruction
    assert.doesNotMatch(text, /choice advantage|opera|cloudbeds|roomkey|\.jx/i);
  });

  test('omits the empty-row language when the table already has rows', () => {
    const text = buildCommitNudge({
      actionName: 'getRoomStatus',
      requiredFields: ['room_number', 'status'],
      structure: summary({ tableCount: 1, maxColumns: 3, maxDataRows: 42 }),
    });
    assert.doesNotMatch(text, /ZERO data rows/);
    assert.match(text, /room_number/);
  });

  test('degrades gracefully when no required fields are supplied', () => {
    const text = buildCommitNudge({
      actionName: 'getWorkOrders',
      requiredFields: [],
      structure: summary({ tableCount: 1, maxColumns: 4, maxDataRows: 3 }),
    });
    assert.match(text, /required fields/i);
  });
});

describe('coreTargetSharesRequiredSchema — schema-sibling exclusion (false-capture guard)', () => {
  test('arrivals and departures ARE schema siblings (excluded from the nudge)', () => {
    // Identical required columns → the audit cannot tell an Arrivals page from a
    // Departures page → the deterministic nudge must NOT fire for either.
    assert.equal(coreTargetSharesRequiredSchema('getArrivals'), true);
    assert.equal(coreTargetSharesRequiredSchema('getDepartures'), true);
  });

  test('room status and work orders have UNIQUE schemas (nudge-eligible)', () => {
    assert.equal(coreTargetSharesRequiredSchema('getRoomStatus'), false);
    assert.equal(coreTargetSharesRequiredSchema('getWorkOrders'), false);
  });

  test('a non-core target is never a sibling (and is never nudged anyway)', () => {
    assert.equal(coreTargetSharesRequiredSchema('getGuests'), false);
  });
});
