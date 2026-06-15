/**
 * reanchor.ts — rung-2 cheap re-anchor DECISION CORE (feature/cua-self-heal-reach).
 *
 * Pure, offline. Drives the real safety core (certifyColumns) with hand-built
 * value evidence to prove:
 *   - the transient-health check certifies a recovered feed,
 *   - a moved required column re-anchors to its header,
 *   - and EVERY ambiguity / wrong candidate ABSTAINS (the caller then pays for
 *     the $3 re-learn — a wrong re-anchor is worse than a blank).
 */

import './ws-polyfill.js';
import './_bootstrap-env.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkFeedHealth,
  decideColumnReanchor,
  buildCandidateSelectors,
  applyColumnReanchor,
  requiredColumnsForTarget,
  MIN_REANCHOR_ROWS,
  type ReanchorCandidate,
} from '../reanchor.js';
import type { Recipe } from '../types.js';

const TODAY = '2026-06-15';

// getArrivals required columns: pms_reservation_id (key), guest_name,
// arrival_date, departure_date. These value vectors all certify (verified
// empirically against certifyColumns).
const ID = ['R1001', 'R1002', 'R1003', 'R1004', 'R1005', 'R1006'];
const GUEST = ['Smith, John', 'Doe, Jane', 'Lee, Sam', 'Park, Ann', 'Cruz, Bo', 'Vo, Kim'];
const ARRIVAL = ['2026-06-15', '2026-06-15', '2026-06-15', '2026-06-15', '2026-06-15', '2026-06-15'];
const DEPART = ['2026-06-17', '2026-06-18', '2026-06-16', '2026-06-19', '2026-06-17', '2026-06-18'];
const ROOM = ['101', '102', '103', '104', '105', '106'];

const HEALTHY_VALUES: Record<string, string[]> = {
  pms_reservation_id: ID, guest_name: GUEST, arrival_date: ARRIVAL, departure_date: DEPART,
};
const SELECTORS: Record<string, string> = {
  pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)',
  arrival_date: 'td:nth-child(3)', departure_date: 'td:nth-child(4)',
};
const REQUIRED = ['pms_reservation_id', 'guest_name', 'arrival_date', 'departure_date'];

describe('requiredColumnsForTarget', () => {
  test('core target returns its contract-required columns', () => {
    const req = requiredColumnsForTarget('getArrivals');
    assert.deepEqual(new Set(req), new Set(REQUIRED));
  });
  test('non-core target → no required columns (re-anchor abstains on it)', () => {
    assert.deepEqual(requiredColumnsForTarget('getPaymentsDaily'), []);
  });
});

describe('checkFeedHealth (CASE A — transient recovery)', () => {
  test('all required columns certify → healthy (skip the paid re-learn)', () => {
    const v = checkFeedHealth({
      actionKey: 'getArrivals', requiredColumns: REQUIRED, allValues: HEALTHY_VALUES,
      allSelectors: SELECTORS, rowCount: ID.length, learned: {}, todayIso: TODAY,
    });
    assert.equal(v.healthy, true);
  });

  test('a required column that FAILS certification → not healthy', () => {
    // arrival_date selector actually reads the departure column (date swap).
    const v = checkFeedHealth({
      actionKey: 'getArrivals', requiredColumns: REQUIRED,
      allValues: { ...HEALTHY_VALUES, arrival_date: DEPART },
      allSelectors: SELECTORS, rowCount: ID.length, learned: {}, todayIso: TODAY,
    });
    assert.equal(v.healthy, false);
  });

  test('too few rows → not healthy (defer rather than trust a fluke)', () => {
    const v = checkFeedHealth({
      actionKey: 'getArrivals', requiredColumns: REQUIRED,
      allValues: Object.fromEntries(Object.entries(HEALTHY_VALUES).map(([k, a]) => [k, a.slice(0, MIN_REANCHOR_ROWS - 1)])),
      allSelectors: SELECTORS, rowCount: MIN_REANCHOR_ROWS - 1, learned: {}, todayIso: TODAY,
    });
    assert.equal(v.healthy, false);
  });

  test('no required columns to certify → not healthy (cannot positively confirm)', () => {
    const v = checkFeedHealth({
      actionKey: 'getArrivals', requiredColumns: [], allValues: HEALTHY_VALUES,
      allSelectors: SELECTORS, rowCount: ID.length, learned: {}, todayIso: TODAY,
    });
    assert.equal(v.healthy, false);
  });
});

describe('buildCandidateSelectors', () => {
  const headers = [
    { index: 1, text: 'conf' }, { index: 2, text: 'guest' }, { index: 3, text: 'room' },
    { index: 4, text: 'departure' }, { index: 5, text: 'arrival' },
  ];
  test('rebases the first :nth-child onto every live header index', () => {
    const cands = buildCandidateSelectors({ oldSelector: 'td:nth-child(3)', headers });
    assert.equal(cands.length, 5);
    assert.deepEqual(cands.map((c) => c.selector), [
      'td:nth-child(1)', 'td:nth-child(2)', 'td:nth-child(3)', 'td:nth-child(4)', 'td:nth-child(5)',
    ]);
    assert.equal(cands[4]!.headerText, 'arrival');
  });
  test('a selector with NO :nth-child is not positionally rebaseable → no candidates', () => {
    assert.deepEqual(buildCandidateSelectors({ oldSelector: 'td.arrival', headers }), []);
  });
});

describe('decideColumnReanchor (CASE B)', () => {
  // arrival_date drifted: the recipe still says td:nth-child(3) but that cell now
  // holds the ROOM number; the real arrival date moved to header index 5.
  const otherValues = { pms_reservation_id: ID, guest_name: GUEST, departure_date: DEPART };
  const otherSelectors = { pms_reservation_id: 'td:nth-child(1)', guest_name: 'td:nth-child(2)', departure_date: 'td:nth-child(4)' };
  const cand = (headerIndex: number, selector: string, values: string[], headerText: string): ReanchorCandidate =>
    ({ headerIndex, selector, values, headerText });

  test('heals a moved column to the unique value-certifying header (anchor-text match)', () => {
    const d = decideColumnReanchor({
      actionKey: 'getArrivals', column: 'arrival_date', oldSelector: 'td:nth-child(3)',
      anchorHeaderText: 'Arrival',
      candidates: [
        cand(3, 'td:nth-child(3)', ROOM, 'room'),          // wrong — not dates
        cand(4, 'td:nth-child(4)', DEPART, 'departure'),   // wrong — mirrors departure_date
        cand(5, 'td:nth-child(5)', ARRIVAL, 'arrival'),    // correct
      ],
      otherValues, otherSelectors, learned: {}, todayIso: TODAY,
    });
    assert.equal(d.action, 'reanchor');
    if (d.action === 'reanchor') {
      assert.equal(d.newSelector, 'td:nth-child(5)');
      assert.equal(d.column, 'arrival_date');
    }
  });

  test('prefers the anchor-text-matching header even when another also value-certifies', () => {
    const d = decideColumnReanchor({
      actionKey: 'getArrivals', column: 'arrival_date', oldSelector: 'td:nth-child(3)',
      anchorHeaderText: 'Arrival',
      candidates: [
        cand(5, 'td:nth-child(5)', ARRIVAL, 'arrival'),    // anchor-text match
        cand(6, 'td:nth-child(6)', ARRIVAL, 'check in'),   // value-certifies too, wrong meaning
      ],
      otherValues, otherSelectors, learned: {}, todayIso: TODAY,
    });
    assert.equal(d.action, 'reanchor');
    if (d.action === 'reanchor') assert.equal(d.newSelector, 'td:nth-child(5)');
  });

  test('ABSTAINS when ≥2 headers value-certify and none matches the anchor text', () => {
    const d = decideColumnReanchor({
      actionKey: 'getArrivals', column: 'arrival_date', oldSelector: 'td:nth-child(3)',
      anchorHeaderText: 'NoSuchHeaderAnymore',
      candidates: [
        cand(5, 'td:nth-child(5)', ARRIVAL, 'date a'),
        cand(6, 'td:nth-child(6)', ARRIVAL, 'date b'),
      ],
      otherValues, otherSelectors, learned: {}, todayIso: TODAY,
    });
    assert.equal(d.action, 'abstain');
  });

  test('ABSTAINS when no candidate value-certifies', () => {
    const d = decideColumnReanchor({
      actionKey: 'getArrivals', column: 'arrival_date', oldSelector: 'td:nth-child(3)',
      anchorHeaderText: 'Arrival',
      candidates: [cand(3, 'td:nth-child(3)', ROOM, 'room'), cand(4, 'td:nth-child(4)', ['x', 'y', 'z', 'p', 'q', 'r'], 'misc')],
      otherValues, otherSelectors, learned: {}, todayIso: TODAY,
    });
    assert.equal(d.action, 'abstain');
  });

  test('a candidate equal to the OLD selector is not a change (skipped) → abstain if it is the only certifier', () => {
    const d = decideColumnReanchor({
      actionKey: 'getArrivals', column: 'arrival_date', oldSelector: 'td:nth-child(5)',
      anchorHeaderText: 'Arrival',
      candidates: [cand(5, 'td:nth-child(5)', ARRIVAL, 'arrival')], // == oldSelector → no heal
      otherValues, otherSelectors, learned: {}, todayIso: TODAY,
    });
    assert.equal(d.action, 'abstain');
  });

  test('no candidates → abstain', () => {
    const d = decideColumnReanchor({
      actionKey: 'getArrivals', column: 'arrival_date', oldSelector: 'td:nth-child(3)',
      candidates: [], otherValues, otherSelectors, learned: {}, todayIso: TODAY,
    });
    assert.equal(d.action, 'abstain');
  });
});

describe('applyColumnReanchor', () => {
  function recipe(): Recipe {
    return {
      schema: 1,
      login: { startUrl: 'https://pms.example/login', steps: [], successSelectors: ['.d'] },
      actions: {
        getArrivals: {
          steps: [{ kind: 'goto', url: 'https://pms.example/arrivals' }],
          parse: {
            mode: 'table',
            hint: {
              rowSelector: 'tr.res',
              columns: { pms_reservation_id: 'td:nth-child(1)', arrival_date: 'td:nth-child(3)' },
              columnsTiered: {
                arrival_date: { roleName: { role: 'cell', name: 'Arrival' }, css: 'td:nth-child(3)' },
              },
            },
          },
        },
      },
    };
  }

  test('patches the flat columns AND columnsTiered.css, preserving the roleName anchor', () => {
    const base = recipe();
    const out = applyColumnReanchor(base, 'getArrivals', [{ column: 'arrival_date', newSelector: 'td:nth-child(5)' }]);
    const hint = (out.actions.getArrivals!.parse as { mode: 'table'; hint: { columns: Record<string, string>; columnsTiered?: Record<string, { roleName?: { name: string }; css?: string }> } }).hint;
    assert.equal(hint.columns.arrival_date, 'td:nth-child(5)');
    assert.equal(hint.columnsTiered!.arrival_date!.css, 'td:nth-child(5)');
    assert.equal(hint.columnsTiered!.arrival_date!.roleName!.name, 'Arrival'); // meaning anchor preserved
  });

  test('does not mutate the input recipe (deep clone)', () => {
    const base = recipe();
    applyColumnReanchor(base, 'getArrivals', [{ column: 'arrival_date', newSelector: 'td:nth-child(5)' }]);
    const hint = (base.actions.getArrivals!.parse as { hint: { columns: Record<string, string> } }).hint;
    assert.equal(hint.columns.arrival_date, 'td:nth-child(3)'); // original untouched
  });

  test('throws on a non-table target (re-anchor is table-only)', () => {
    const r = recipe();
    (r.actions.getArrivals!.parse as unknown) = { mode: 'inline_text', fields: { x: '#x' } };
    assert.throws(() => applyColumnReanchor(r, 'getArrivals', [{ column: 'x', newSelector: '#y' }]));
  });
});
