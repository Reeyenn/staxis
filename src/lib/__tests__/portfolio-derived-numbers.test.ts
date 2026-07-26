/**
 * EVERY DERIVED NUMBER A PORTFOLIO ANSWER QUOTES IS COMPUTED HERE, NOT IN PROSE.
 *
 * Two live defects on the cross-hotel ask line, 2026-07-26, both from a model
 * doing arithmetic on numbers the tools had already given it correctly:
 *
 *   • it reported "32.0 per 100 rooms" for 11 open items at a 50-room hotel.
 *     It is 22.0. No tool returned either figure — the model divided.
 *   • it concluded one hotel was "6x" another where the true multiple was ~8.
 *
 * The fix is that the tools now ship the worked-out forms, so these are the
 * functions standing between a VP and a made-up rate. Hermetic on purpose: no
 * model, no database, no network — pure arithmetic asserted against the exact
 * numbers that were got wrong.
 *
 * The severity half is the same doctrine one layer down: `work_orders.severity`
 * holds two vocabularies at once, so a reader that matches one string reports a
 * confident zero over five open tickets.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { per100Rooms, timesAsMuch } from '@/lib/agent/tools/portfolio';
import { normalizeWorkOrderSeverity } from '@/lib/db-mappers';

describe('per-100-rooms is computed, never narrated', () => {
  test('THE LIVE BUG: 11 open items at 50 rooms is 22.0, not 32.0', () => {
    assert.equal(per100Rooms(11, 50), 22);
  });

  test('rates are exact for the sizes real hotels actually are', () => {
    assert.equal(per100Rooms(2, 60), 3.33, 'two decimals, so 3.333… does not print as 3');
    assert.equal(per100Rooms(5, 60), 8.33);
    assert.equal(per100Rooms(7, 45), 15.56);
    assert.equal(per100Rooms(0, 60), 0, 'zero is a real rate, not a missing one');
  });

  test('a hotel with no room count gets no rate rather than a borrowed one', () => {
    // The failure this prevents is subtler than a wrong number: a hotel ranked
    // per-room on somebody else's room count looks like a real comparison.
    assert.equal(per100Rooms(11, null), null);
    assert.equal(per100Rooms(11, 0), null);
    assert.equal(per100Rooms(11, -5), null);
    assert.equal(per100Rooms(null, 50), null);
  });
});

describe('"how many times worse" is computed, never narrated', () => {
  test('THE LIVE BUG: the multiple is arithmetic, not an impression', () => {
    // 22.0 vs 2.75 per 100 rooms. The live answer said "6x".
    assert.equal(timesAsMuch(22, 2.75), 8);
  });

  test('equal hotels are 1x, and the direction is not swapped', () => {
    assert.equal(timesAsMuch(8.33, 8.33), 1);
    assert.equal(timesAsMuch(5, 2), 2.5);
    assert.equal(timesAsMuch(2, 5), 0.4, 'the caller decides which is the reference');
  });

  test('the ratio divides the EXACT values, never the rounded ones', () => {
    // Caught on the live exchange that proved this branch. 20 open items at 50
    // rooms is 0.4 per room; 3 at 74 rooms is 0.040540…, which the ranking
    // column shows as 0.04. Dividing the DISPLAYED figures gives a suspiciously
    // clean 10x; dividing the real ones gives 9.87. Rounding first is authoring
    // a number by tidying it.
    const worstExact = 20 / 50;
    const bestExact = 3 / 74;
    assert.equal(timesAsMuch(worstExact, bestExact), 9.87);
    assert.equal(
      timesAsMuch(Math.round(worstExact * 100) / 100, Math.round(bestExact * 100) / 100),
      10,
      'this is the wrong answer the wrong order produces — pinned so the fix cannot silently revert',
    );
  });

  test('nothing is "x times" zero', () => {
    // Infinity would serialise to null in JSON anyway; being deliberate means
    // the model is never handed a field it has to interpret.
    assert.equal(timesAsMuch(5, 0), null);
    assert.equal(timesAsMuch(5, null), null);
    assert.equal(timesAsMuch(null, 5), null);
  });
});

describe('work_orders.severity holds two vocabularies; readers see one', () => {
  test('the housekeeper app\'s words and the maintenance board\'s words agree', () => {
    // Both of these are live in the column on the same hotel.
    assert.equal(normalizeWorkOrderSeverity('MAJOR'), 'high');
    assert.equal(normalizeWorkOrderSeverity('MINOR'), 'low');
    assert.equal(normalizeWorkOrderSeverity('URGENT'), 'urgent');
    assert.equal(normalizeWorkOrderSeverity('urgent'), 'urgent');
    assert.equal(normalizeWorkOrderSeverity('medium'), 'normal');
    assert.equal(normalizeWorkOrderSeverity('low'), 'low');
  });

  test('case and padding are the writer\'s business, not the reader\'s', () => {
    assert.equal(normalizeWorkOrderSeverity('  Major '), 'high');
    assert.equal(normalizeWorkOrderSeverity('MeDiUm'), 'normal');
  });

  test('an ungraded ticket is ungraded, not normal', () => {
    // Folding the unknown into 'normal' is how a reader quietly grades a ticket
    // nobody graded — and how a third vocabulary would arrive unnoticed.
    for (const raw of [null, undefined, '', '   ', 'blocker', 'p1', 42, {}]) {
      assert.equal(normalizeWorkOrderSeverity(raw), 'unspecified', JSON.stringify(raw));
    }
  });

  test('THE LIVE BUG: five MAJOR tickets are not zero urgent tickets', () => {
    // The old read was `severity.toLowerCase() === 'urgent'`, so this whole
    // board counted as nothing at all.
    const board = ['MAJOR', 'MAJOR', 'MAJOR', 'MAJOR', 'MAJOR', 'medium', 'urgent', null];
    const buckets = board.map(normalizeWorkOrderSeverity);
    assert.equal(buckets.filter((b) => b === 'urgent').length, 1);
    assert.equal(buckets.filter((b) => b === 'high').length, 5, 'the five MAJOR tickets are visible');
    assert.equal(buckets.filter((b) => b === 'normal').length, 1);
    assert.equal(buckets.filter((b) => b === 'unspecified').length, 1);
    assert.equal(
      buckets.filter((b) => b === 'high' || b === 'urgent').length, 6,
      'a manager asking "what is serious" must be told six, not one',
    );
  });
});
