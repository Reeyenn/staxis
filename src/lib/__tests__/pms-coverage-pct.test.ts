/**
 * Regression test for the coveragePct bug in /api/admin/pms-coverage.
 *
 * THE BUG: the original logic counted the 5 LEGACY snake_case feed keys under
 * `knowledge.feeds`. Mapper-produced ("actions"-shaped) maps store feeds under
 * `knowledge.actions` (camelCase verbs) and have NO `knowledge.feeds`, so every
 * modern map read 0% coverage — including Choice Advantage once re-learned by
 * the vision mapper.
 *
 * THE FIX: computeFamilyCoverage() uses parseKnowledgeCoverage() (understands
 * both shapes) + knowledge.feedGaps to mark each feed live vs learning, and
 * computes the % over the LEARNABLE feeds present. This test asserts an
 * actions-shaped Choice Advantage map reports >0% (4-of-6 live), not 0%.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { computeFamilyCoverage } from '@/app/api/admin/pms-coverage/route';

/** An actions-shaped Choice Advantage map: 6 learnable feeds present, 4 live
 *  and 2 gap-listed (learning). Mirrors the mapper-produced envelope shape. */
function choiceAdvantageActionsMap() {
  const tableAction = (col: string) => ({
    parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { [col]: `td.${col}` } } },
  });
  return {
    actions: {
      getRoomStatus: tableAction('room'),
      getArrivals: tableAction('guest'),
      getDepartures: tableAction('guest'),
      getWorkOrders: tableAction('wo'),
      // Present but structurally dead → gap-listed below → learning.
      getRevenueDaily: tableAction('rev'),
      getRatesAndInventory: tableAction('rate'),
    },
    feedGaps: {
      computedAt: new Date().toISOString(),
      missingRequired: [],
      missingBusinessCritical: ['getRevenueDaily', 'getRatesAndInventory'],
    },
  };
}

describe('computeFamilyCoverage (pms-coverage coveragePct fix)', () => {
  test('actions-shaped Choice Advantage map reports >0% (the regression)', () => {
    const { coveragePct } = computeFamilyCoverage(choiceAdvantageActionsMap());
    assert.ok(coveragePct > 0, `expected >0% for an actions-shaped map, got ${coveragePct}%`);
  });

  test('coverage = live learnable / learnable present → 4 of 6 = 67%', () => {
    const { coveragePct, perFeed } = computeFamilyCoverage(choiceAdvantageActionsMap());
    assert.equal(coveragePct, Math.round((4 / 6) * 100)); // 67

    const live = perFeed.filter((f) => f.state === 'live').map((f) => f.key).sort();
    const learning = perFeed.filter((f) => f.state === 'learning').map((f) => f.key).sort();
    assert.deepEqual(live, ['getArrivals', 'getDepartures', 'getRoomStatus', 'getWorkOrders']);
    assert.deepEqual(learning, ['getRatesAndInventory', 'getRevenueDaily']);
    assert.equal(perFeed.length, 6);
  });

  test('a fully-live actions map reports 100%', () => {
    const tableAction = { parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { a: 'td.a' } } } };
    const { coveragePct } = computeFamilyCoverage({
      actions: {
        getRoomStatus: tableAction,
        getArrivals: tableAction,
        getDepartures: tableAction,
        getWorkOrders: tableAction,
      },
    });
    assert.equal(coveragePct, 100);
  });

  test('empty / unlearned knowledge reports 0% with no feeds', () => {
    const { coveragePct, perFeed } = computeFamilyCoverage({});
    assert.equal(coveragePct, 0);
    assert.deepEqual(perFeed, []);
  });

  test('a legacy feeds-shaped map still resolves its feeds (read-only, live)', () => {
    // Legacy snake_case map (migration 0203 shape). room_status/arrivals_departures/
    // work_orders map to learnable actions; housekeeping/dashboard_counts do not.
    const { coveragePct, perFeed } = computeFamilyCoverage({
      feeds: {
        room_status: {},
        arrivals_departures: {},
        work_orders: {},
        housekeeping: {},
        dashboard_counts: {},
      },
    });
    // 4 learnable feeds present (room_status→getRoomStatus, arrivals_departures→
    // getArrivals, work_orders→getWorkOrders), all live, none gapped → 100%.
    assert.ok(coveragePct > 0, `legacy map should report >0%, got ${coveragePct}%`);
    assert.ok(perFeed.length >= 5);
  });
});
