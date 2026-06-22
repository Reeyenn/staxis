/**
 * Tolerant + maximal mapper (feature/cua-tolerant-mapper).
 *
 * Proves Part A offline (no DB, no Claude, no Playwright):
 *   (a) getArrivals with a blank arrival_date reports NO essential gap, derives
 *       arrival_date = run date, and is promote-eligible (parked for the founder,
 *       never auto-activated, never called "dead").
 *   (b) getDepartures is symmetric (departure_date is its contextual date).
 *   (c) the sibling commit-nudge guard (coreTargetSharesRequiredSchema) still
 *       trips for arrivals/departures (they share {pms_reservation_id, guest_name})
 *       and still does NOT trip for room status / work orders (unique shapes).
 *   (d) a row carrying a derived date passes validateRows against the relaxed
 *       (0284) reservations descriptor.
 *
 * Plus adversarial guards: tolerance is ESSENTIALS-tight (a feed missing an
 * essential is STILL gapped), and derivation never overwrites a real per-row date
 * nor fills the NON-contextual date (so it can never write a wrong date).
 */

// MUST be first: install the WebSocket shim before any supabase-importing module
// is evaluated — mapping-driver builds the Supabase client at module load.
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  requiredLearnedFor,
  contextualColumnsFor,
  optionalColumnsFor,
  deriveContextColumns,
  missingRequiredColumns,
  coreTargetSharesRequiredSchema,
} from '../target-contract.js';
import { evaluatePromotionGate, computeFeedGaps } from '../mapping-driver.js';
import { applyDerivedContextColumns, defaultRunDateIso } from '../extractors/template-runner.js';
import { validateRows, type TableSchemaDescriptor } from '../persistence/generic-table-writer.js';
import type { Recipe, ActionRecipe, TableTemplate } from '../types.js';

const PID = '00000000-0000-0000-0000-000000000001';
const RUN_DATE = '2026-06-16';

// Choice-Advantage-shaped arrivals: useful columns captured, dates blank per-row
// (the "View Arrivals" page IS today's arrivals → the date is page context).
const ARRIVALS_BLANK_DATES = {
  pms_reservation_id: 'td:nth-child(1)',
  guest_name: 'td:nth-child(2)',
  room_number: 'td:nth-child(3)',
  arrival_date: '',
  departure_date: '',
};

const tableAction = (columns: Record<string, string>): ActionRecipe => ({
  steps: [],
  parse: { mode: 'table', hint: { rowSelector: 'tr', columns } },
});

const recipeOf = (actions: Recipe['actions']): Recipe => ({
  schema: 1,
  login: { startUrl: 'https://pms.example.com', steps: [], successSelectors: [] },
  actions,
  valueTranslations: {},
});

// Only the bits applyDerivedContextColumns reads (sourceActionKey).
const tmplFor = (actionKey: keyof Recipe['actions']): TableTemplate =>
  ({ sourceActionKey: actionKey } as unknown as TableTemplate);

// Relaxed reservations descriptor (mirrors migration 0284: dates required:false,
// nullable:true). Only the columns this test exercises.
const RELAXED_RESERVATIONS: TableSchemaDescriptor = {
  table_name: 'pms_reservations',
  write_strategy: 'upsert',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'pms_reservation_id'],
  reconcile_key_field: null,
  columns: [
    { name: 'pms_reservation_id', type: 'text', required: true, nullable: false },
    { name: 'guest_name', type: 'text', required: true, nullable: false },
    { name: 'room_number', type: 'text', required: false, nullable: true },
    { name: 'arrival_date', type: 'date', required: false, nullable: true },
    { name: 'departure_date', type: 'date', required: false, nullable: true },
  ],
};

describe('tier assignments (A1)', () => {
  test('essentials reduce to {pms_reservation_id, guest_name} for arrivals + departures', () => {
    assert.deepEqual([...requiredLearnedFor('getArrivals')].sort(), ['guest_name', 'pms_reservation_id']);
    assert.deepEqual([...requiredLearnedFor('getDepartures')].sort(), ['guest_name', 'pms_reservation_id']);
  });
  test('room status + work orders keep their essentials (no regression)', () => {
    assert.deepEqual([...requiredLearnedFor('getRoomStatus')].sort(), ['room_number', 'status']);
    assert.deepEqual([...requiredLearnedFor('getWorkOrders')].sort(), ['description', 'pms_work_order_id']);
  });
  test('contextual = the page-context date; optional = the rest', () => {
    assert.deepEqual(contextualColumnsFor('getArrivals'), ['arrival_date']);
    assert.deepEqual(contextualColumnsFor('getDepartures'), ['departure_date']);
    assert.deepEqual(contextualColumnsFor('getRoomStatus'), []);
    assert.deepEqual(contextualColumnsFor('getWorkOrders'), []);
    assert.ok(optionalColumnsFor('getArrivals').includes('departure_date'));
    assert.ok(optionalColumnsFor('getDepartures').includes('arrival_date'));
    assert.ok(optionalColumnsFor('getWorkOrders').includes('status'));
    assert.ok(optionalColumnsFor('getWorkOrders').includes('out_of_order'));
  });
});

describe('(a) getArrivals: blank arrival_date → no essential gap + promote-eligible', () => {
  test('no essential gap is reported for a blank contextual date', () => {
    assert.deepEqual(missingRequiredColumns('getArrivals', ARRIVALS_BLANK_DATES), []);
    const gaps = computeFeedGaps({ getArrivals: tableAction(ARRIVALS_BLANK_DATES) });
    assert.deepEqual(gaps.missingRequired.filter((g) => g.target === 'getArrivals'), []);
  });

  test('derives arrival_date = run date, leaving the non-contextual date untouched', () => {
    assert.deepEqual(deriveContextColumns('getArrivals', RUN_DATE), { arrival_date: RUN_DATE });
    const rows: Array<Record<string, unknown>> = [
      { pms_reservation_id: 'R1', guest_name: 'A', arrival_date: '', departure_date: '' },
    ];
    applyDerivedContextColumns(tmplFor('getArrivals'), rows, RUN_DATE);
    assert.equal(rows[0]!.arrival_date, RUN_DATE);
    assert.equal(rows[0]!.departure_date, ''); // optional, NOT derived — never a wrong date
  });

  test('the feed is promote-eligible (park_partial, founder-gated) — never "dead", never auto', () => {
    const g = evaluatePromotionGate(recipeOf({
      getArrivals: tableAction(ARRIVALS_BLANK_DATES),
      getDepartures: tableAction(ARRIVALS_BLANK_DATES),
    }));
    // Parked for the founder's Promote click — never auto-activated, never quarantined.
    assert.equal(g.decision, 'park_partial');
    // arrivals + departures land in trustworthyRequired (the partial bar) — no gap.
    assert.deepEqual(
      g.feedGaps.missingRequired.filter((x) => x.target === 'getArrivals' || x.target === 'getDepartures'),
      [],
    );
    // The "dead — missing columns: arrival_date" wording is gone for a feed with
    // its essentials; gap language is reserved for the genuinely-absent feeds.
    assert.doesNotMatch(g.reason, /dead/);
    assert.doesNotMatch(g.reason, /arrival_date|departure_date/);
    assert.match(g.reason, /trustworthy: .*getArrivals/);
  });
});

describe('(b) getDepartures: symmetric', () => {
  test('departure_date is the contextual date; arrival_date is optional', () => {
    assert.deepEqual(deriveContextColumns('getDepartures', RUN_DATE), { departure_date: RUN_DATE });
    const rows: Array<Record<string, unknown>> = [
      { pms_reservation_id: 'R1', guest_name: 'A', arrival_date: '', departure_date: '' },
    ];
    applyDerivedContextColumns(tmplFor('getDepartures'), rows, RUN_DATE);
    assert.equal(rows[0]!.departure_date, RUN_DATE);
    assert.equal(rows[0]!.arrival_date, ''); // optional, NOT derived
  });

  test('no essential gap for a blank departure_date', () => {
    assert.deepEqual(missingRequiredColumns('getDepartures', ARRIVALS_BLANK_DATES), []);
  });
});

describe('(c) A5 — sibling commit-nudge guard still trips correctly', () => {
  test('arrivals/departures remain schema siblings ({pms_reservation_id, guest_name})', () => {
    assert.equal(coreTargetSharesRequiredSchema('getArrivals'), true);
    assert.equal(coreTargetSharesRequiredSchema('getDepartures'), true);
  });
  test('room status / work orders stay UNIQUE (the nudge still fires for them)', () => {
    assert.equal(coreTargetSharesRequiredSchema('getRoomStatus'), false);
    assert.equal(coreTargetSharesRequiredSchema('getWorkOrders'), false);
  });
  test('non-core targets are never siblings', () => {
    assert.equal(coreTargetSharesRequiredSchema('getGuests'), false);
  });
});

describe('(d) a row with a derived date passes validateRows (0284-relaxed descriptor)', () => {
  test('derived arrival_date + absent departure_date → row is valid', () => {
    const row = { property_id: PID, pms_reservation_id: 'R1', guest_name: 'A', arrival_date: RUN_DATE };
    const v = validateRows([row], RELAXED_RESERVATIONS);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('full path: blank dates → derive → validateRows passes', () => {
    const rows: Array<Record<string, unknown>> = [
      { pms_reservation_id: 'R1', guest_name: 'A', arrival_date: '', departure_date: '' },
    ];
    applyDerivedContextColumns(tmplFor('getArrivals'), rows, RUN_DATE);
    const v = validateRows([{ ...rows[0], property_id: PID }], RELAXED_RESERVATIONS);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
    assert.equal(v.valid[0]!.arrival_date, RUN_DATE);
  });

  test('a NULL departure_date is allowed (nullable) — no whole-row rejection', () => {
    const row = { property_id: PID, pms_reservation_id: 'R1', guest_name: 'A', arrival_date: RUN_DATE, departure_date: null };
    const v = validateRows([row], RELAXED_RESERVATIONS);
    assert.equal(v.valid.length, 1);
  });
});

describe('adversarial — tolerance is essentials-tight; derivation cannot write a wrong date', () => {
  test('a feed missing an ESSENTIAL is still gapped (a genuinely broken map does NOT slip through)', () => {
    const brokenCols = { pms_reservation_id: 'td:nth-child(1)', guest_name: '', arrival_date: '', departure_date: '' };
    assert.deepEqual(missingRequiredColumns('getArrivals', brokenCols), ['guest_name']);
    const gaps = computeFeedGaps({ getArrivals: tableAction(brokenCols) });
    assert.ok(gaps.missingRequired.some((g) => g.target === 'getArrivals' && g.reason === 'incomplete_columns'));
  });

  test('a near-empty recipe (only a gapped arrivals) still quarantines (bar not met)', () => {
    const g = evaluatePromotionGate(recipeOf({
      getArrivals: tableAction({ pms_reservation_id: 'td', guest_name: '', arrival_date: '', departure_date: '' }),
    }));
    assert.equal(g.decision, 'quarantine');
  });

  test('derivation never overwrites a real extracted per-row date (fill-when-blank only)', () => {
    const rows: Array<Record<string, unknown>> = [
      { pms_reservation_id: 'R1', guest_name: 'A', arrival_date: '2026-06-10', departure_date: '' },
    ];
    applyDerivedContextColumns(tmplFor('getArrivals'), rows, RUN_DATE);
    assert.equal(rows[0]!.arrival_date, '2026-06-10'); // kept — a real per-row date wins over the run date
  });

  test('non-core / non-date feeds derive nothing (no spurious values)', () => {
    assert.deepEqual(deriveContextColumns('getRoomStatus', RUN_DATE), {});
    assert.deepEqual(deriveContextColumns('getWorkOrders', RUN_DATE), {});
    assert.deepEqual(deriveContextColumns('getGuests', RUN_DATE), {});
    // applyDerivedContextColumns is a no-op for them.
    const rows: Array<Record<string, unknown>> = [{ room_number: '101', status: '' }];
    applyDerivedContextColumns(tmplFor('getRoomStatus'), rows, RUN_DATE);
    assert.equal(rows[0]!.status, '');
  });

  test('defaultRunDateIso returns an ISO yyyy-mm-dd', () => {
    assert.match(defaultRunDateIso(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
