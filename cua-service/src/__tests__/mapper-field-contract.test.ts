/**
 * Mapper field-name contract + completeness gate (fix/mapper-field-contract).
 *
 * Proves the two halves of the fix offline (no DB, no Claude, no Playwright):
 *   1. A learned column map keyed by the EXACT descriptor snake_case names
 *      produces rows that PASS validateRows; the old camelCase map is rejected.
 *   2. A required feed whose learned columns are missing/blank does NOT
 *      auto-promote — it parks as a draft.
 *
 * Also documents the deliberately out-of-scope sibling bug (Wave-2): even with
 * names correct, raw enum/boolean VALUES (room-status `status`, work-order
 * `out_of_order`) still reject — that needs a value-normalization parser layer.
 */

// MUST be first: install the WebSocket shim before any supabase-importing
// module is evaluated (ESM evaluates imports in source order). generic-table-
// writer / mapping-driver build the Supabase client at module load.
import './ws-polyfill.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateRows, type TableSchemaDescriptor } from '../persistence/generic-table-writer.js';
import { recipeToTableTemplates } from '../recipe-adapter.js';
import { applyTemplateParsers } from '../extractors/template-runner.js';
import {
  CORE_TARGET_CONTRACTS,
  columnsFromAction,
  missingFromList,
  missingRequiredColumns,
  requiredLearnedFor,
  MAX_COMPLETENESS_REASKS,
} from '../target-contract.js';
import { evaluatePromotionGate } from '../mapping-driver.js';
import type { Recipe, ActionRecipe } from '../types.js';

const PID = '00000000-0000-0000-0000-000000000001';

// ─── Descriptor fixtures — verbatim from migration 0207 ──────────────────────

const RESERVATIONS_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_reservations',
  write_strategy: 'upsert',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'pms_reservation_id'],
  reconcile_key_field: null,
  columns: [
    { name: 'pms_reservation_id', type: 'text', required: true, nullable: false },
    { name: 'guest_name', type: 'text', required: true, nullable: false },
    { name: 'room_number', type: 'text', required: false, nullable: true },
    { name: 'arrival_date', type: 'date', required: true, nullable: false },
    { name: 'departure_date', type: 'date', required: true, nullable: false },
    { name: 'num_nights', type: 'integer', required: false, nullable: true, range_min: 0, range_max: 365 },
    { name: 'status', type: 'text', required: false, nullable: true },
    { name: 'channel_name', type: 'text', required: false, nullable: true },
    { name: 'rate_per_night_cents', type: 'bigint', required: false, nullable: true, range_min: 0 },
  ],
};

const ROOM_STATUS_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_room_status_log',
  write_strategy: 'append',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'room_number', 'changed_at'],
  reconcile_key_field: null,
  columns: [
    { name: 'room_number', type: 'text', required: true, nullable: false },
    {
      name: 'status', type: 'text', required: true, nullable: false,
      allowed_values: ['occupied', 'vacant_clean', 'vacant_dirty', 'inspected', 'out_of_order', 'unknown'],
    },
    { name: 'changed_at', type: 'timestamptz', required: true, nullable: false },
    { name: 'changed_by', type: 'text', required: false, nullable: true },
  ],
};

const WORK_ORDERS_DESCRIPTOR: TableSchemaDescriptor = {
  table_name: 'pms_work_orders_v2',
  write_strategy: 'reconcile',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'pms_work_order_id'],
  reconcile_key_field: 'pms_work_order_id',
  columns: [
    { name: 'pms_work_order_id', type: 'text', required: true, nullable: false },
    { name: 'room_number', type: 'text', required: false, nullable: true },
    { name: 'description', type: 'text', required: true, nullable: false },
    {
      name: 'priority', type: 'text', required: false, nullable: true,
      allowed_values: ['low', 'medium', 'high', 'critical', 'unknown'],
    },
    {
      name: 'status', type: 'text', required: true, nullable: false,
      allowed_values: ['open', 'in_progress', 'resolved', 'cancelled'],
    },
    { name: 'out_of_order', type: 'boolean', required: true, nullable: false },
    { name: 'assigned_to', type: 'text', required: false, nullable: true },
  ],
};

// ─── Test 1 — the contract fix flips reject → pass (hero) ─────────────────────

describe('validateRows: camelCase rejected, snake_case accepted (pms_reservations)', () => {
  test('OLD camelCase reservation row is REJECTED (the live bug)', () => {
    const camel = { guestName: 'Jane Doe', roomNumber: '204', arrivalDate: '2026-06-10', departureDate: '2026-06-12' };
    const { valid, rejected } = validateRows([camel], RESERVATIONS_DESCRIPTOR);
    assert.equal(valid.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!.reason, /required field "pms_reservation_id" missing/);
  });

  test('NEW snake_case reservation row PASSES both validation layers', () => {
    const snake = {
      property_id: PID,
      pms_reservation_id: 'CONF-1',
      guest_name: 'Jane Doe',
      room_number: '204',
      arrival_date: '2026-06-10',
      departure_date: '2026-06-12',
      num_nights: 2,
    };
    const { valid, rejected } = validateRows([snake], RESERVATIONS_DESCRIPTOR);
    assert.equal(rejected.length, 0, JSON.stringify(rejected));
    assert.equal(valid.length, 1);
  });
});

// ─── Test 2 — end-to-end transform: recipe → template → row → validate ────────

function arrivalsRecipe(columns: Record<string, string>): Recipe {
  return {
    schema: 1,
    login: { startUrl: 'https://pms.example.com/login', steps: [{ kind: 'click', selector: 'button' }], successSelectors: ['.dash'] },
    actions: {
      getArrivals: {
        steps: [{ kind: 'goto', url: 'https://pms.example.com/arrivals' }],
        parse: { mode: 'table', hint: { rowSelector: 'tr.res', columns } },
      },
    },
  };
}

describe('recipe → recipeToTableTemplates → applyTemplateParsers → validateRows', () => {
  test('snake_case recipe produces snake_case rows that PASS', () => {
    const recipe = arrivalsRecipe({
      pms_reservation_id: 'td.conf', guest_name: 'td.name',
      arrival_date: 'td.arr', departure_date: 'td.dep', room_number: 'td.room',
    });
    const tmpl = recipeToTableTemplates(recipe).templates.find((t) => t.tableName === 'pms_reservations');
    assert.ok(tmpl, 'expected a pms_reservations template');
    // Simulate a scraped raw row keyed by the learned selectors.
    const raw = { 'td.conf': 'CONF-9', 'td.name': 'Sam Lee', 'td.arr': '2026-06-10', 'td.dep': '2026-06-11', 'td.room': '101' };
    const row = applyTemplateParsers(raw, tmpl!, 'list_row');
    assert.deepEqual(
      Object.keys(row).sort(),
      ['arrival_date', 'departure_date', 'guest_name', 'pms_reservation_id', 'room_number'],
    );
    const v = validateRows([{ ...row, property_id: PID }], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('camelCase recipe produces camelCase rows that REJECT', () => {
    const recipe = arrivalsRecipe({ guestName: 'td.name', roomNumber: 'td.room', arrivalDate: 'td.arr', departureDate: 'td.dep' });
    const tmpl = recipeToTableTemplates(recipe).templates.find((t) => t.tableName === 'pms_reservations')!;
    const raw = { 'td.name': 'Sam', 'td.room': '101', 'td.arr': '2026-06-10', 'td.dep': '2026-06-11' };
    const row = applyTemplateParsers(raw, tmpl, 'list_row');
    const v = validateRows([{ ...row, property_id: PID }], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.valid.length, 0);
    assert.match(v.rejected[0]!.reason, /required field "pms_reservation_id" missing/);
  });
});

// ─── Test 3 — room status + work orders (+ documented value-normalization gap)

describe('room_status + work_orders snake_case rows pass; raw values document Wave-2 gap', () => {
  test('room_status row (stamped changed_at + enum status) PASSES', () => {
    const row = { property_id: PID, room_number: '204', status: 'occupied', changed_at: '2026-06-10T12:00:00.000Z' };
    const v = validateRows([row], ROOM_STATUS_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('GAP (Wave-2): a raw room status like "Clean" still rejects on the enum', () => {
    const row = { property_id: PID, room_number: '204', status: 'Clean', changed_at: '2026-06-10T12:00:00.000Z' };
    const v = validateRows([row], ROOM_STATUS_DESCRIPTOR);
    assert.equal(v.valid.length, 0);
    assert.match(v.rejected[0]!.reason, /status/);
  });

  test('work_orders row (boolean out_of_order + enum status) PASSES', () => {
    const row = { property_id: PID, pms_work_order_id: 'WO-9', description: 'Leaky faucet', status: 'open', out_of_order: false };
    const v = validateRows([row], WORK_ORDERS_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('GAP (Wave-2): a string out_of_order like "Yes" still rejects on type', () => {
    const row = { property_id: PID, pms_work_order_id: 'WO-9', description: 'Leak', status: 'open', out_of_order: 'Yes' };
    const v = validateRows([row], WORK_ORDERS_DESCRIPTOR);
    assert.equal(v.valid.length, 0);
    assert.match(v.rejected[0]!.reason, /out_of_order/);
  });

  test('GAP (Wave-2): a string num_nights rejects the WHOLE reservation row — why numeric optionals are not prompted', () => {
    // Raw DOM/CSV scrape gives "2" (string); descriptor num_nights is integer →
    // type mismatch rejects the entire row, not just the field. This is why
    // num_nights was removed from the arrivals/departures goal prose.
    const row = {
      property_id: PID, pms_reservation_id: 'CONF-2', guest_name: 'Jane Doe',
      arrival_date: '2026-06-10', departure_date: '2026-06-12', num_nights: '2',
    };
    const v = validateRows([row], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.valid.length, 0);
    assert.match(v.rejected[0]!.reason, /num_nights/);
  });
});

// ─── Test 4 — contract helper unit behavior ──────────────────────────────────

describe('target-contract helpers', () => {
  test('columnsFromAction reads table / csv / inline_text / drill-down shapes', () => {
    assert.deepEqual(columnsFromAction({ steps: [], parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { a: 'x' } } } } as ActionRecipe), { a: 'x' });
    assert.deepEqual(columnsFromAction({ steps: [], parse: { mode: 'csv', hint: { columns: { b: 'y' } } } } as ActionRecipe), { b: 'y' });
    assert.deepEqual(columnsFromAction({ steps: [], parse: { mode: 'inline_text', fields: { c: 'z' } } } as ActionRecipe), { c: 'z' });
    const dd = {
      steps: [], parse: { mode: 'table', hint: { rowSelector: 'tr', columns: { ignored: 'q' } } },
      drillDown: {
        listUrl: 'u', listRowSelector: 'tr', listColumns: { d: 'w' },
        detailUrlTemplate: '', detailUrlParams: {}, detailColumns: {}, fieldCoverage: {}, samplesDrilled: 4, templateVerified: true,
      },
    } as ActionRecipe;
    assert.deepEqual(columnsFromAction(dd), { d: 'w' }, 'drill-down list columns take precedence');
  });

  test('missingFromList flags absent, empty, and whitespace-only selectors', () => {
    assert.deepEqual(missingFromList(['a', 'b', 'c', 'd'], { a: 'sel', b: '', c: '   ' }), ['b', 'c', 'd']);
    assert.deepEqual(missingFromList(['a'], { a: 'sel' }), []);
  });

  test('missingRequiredColumns gates only core targets; non-core → []', () => {
    assert.deepEqual(
      missingRequiredColumns('getArrivals', { guest_name: 'x', arrival_date: 'y', departure_date: 'z' }),
      ['pms_reservation_id'],
    );
    assert.deepEqual(
      missingRequiredColumns('getArrivals', { pms_reservation_id: 'a', guest_name: 'b', arrival_date: 'c', departure_date: 'd' }),
      [],
    );
    assert.deepEqual(missingRequiredColumns('getRevenueDaily', {}), [], 'non-core target is never column-gated');
  });

  test('re-ask budget is a small bounded integer (cost safety)', () => {
    assert.ok(Number.isInteger(MAX_COMPLETENESS_REASKS));
    assert.ok(MAX_COMPLETENESS_REASKS >= 1 && MAX_COMPLETENESS_REASKS <= 3);
  });
});

// ─── Test 5 — drift guard: contract == 0207 descriptor required non-ts cols ───

describe('contract drift guard vs migration 0207', () => {
  test('each core requiredLearned == descriptor (required && type!=timestamptz)', () => {
    const cases: Array<[keyof Recipe['actions'], TableSchemaDescriptor]> = [
      ['getArrivals', RESERVATIONS_DESCRIPTOR],
      ['getDepartures', RESERVATIONS_DESCRIPTOR],
      ['getRoomStatus', ROOM_STATUS_DESCRIPTOR],
      ['getWorkOrders', WORK_ORDERS_DESCRIPTOR],
    ];
    for (const [key, desc] of cases) {
      const expected = desc.columns
        .filter((c) => c.required && c.type !== 'timestamptz')
        .map((c) => c.name)
        .sort();
      const actual = [...requiredLearnedFor(key)].sort();
      assert.deepEqual(actual, expected, `${key} requiredLearned drifted from descriptor`);
      assert.equal(CORE_TARGET_CONTRACTS[key]!.table, desc.table_name, `${key} table drifted`);
    }
  });
});

// ─── Test 6 — promotion gate column-completeness ─────────────────────────────

function tableAction(columns: Record<string, string>): ActionRecipe {
  return { steps: [{ kind: 'goto', url: 'https://pms.example.com/x' }], parse: { mode: 'table', hint: { rowSelector: 'tr', columns } } };
}

function fullRecipe(overrides: Partial<Recipe['actions']> = {}): Recipe {
  return {
    schema: 1,
    login: { startUrl: 'https://pms.example.com/login', steps: [{ kind: 'click', selector: 'b' }], successSelectors: ['.d'] },
    actions: {
      getRoomStatus: tableAction({ room_number: 'a', status: 'b' }),
      getArrivals: tableAction({ pms_reservation_id: 'a', guest_name: 'b', arrival_date: 'c', departure_date: 'd' }),
      getDepartures: tableAction({ pms_reservation_id: 'a', guest_name: 'b', arrival_date: 'c', departure_date: 'd' }),
      getWorkOrders: tableAction({ pms_work_order_id: 'a', description: 'b', status: 'c', out_of_order: 'd' }),
      // ≥3 business-critical (presence by KEY is all the existing gate needs).
      getGuests: tableAction({ pms_guest_id: 'a', name: 'b' }),
      getRevenueDaily: tableAction({ date: 'a' }),
      getRatesAndInventory: tableAction({ date: 'a' }),
      ...overrides,
    },
  };
}

describe('evaluatePromotionGate column-completeness', () => {
  test('complete required + 3 business-critical → auto_promote', () => {
    assert.equal(evaluatePromotionGate(fullRecipe()).decision, 'auto_promote');
  });

  test('required feed missing a required COLUMN → park_draft (the key fix)', () => {
    const g = evaluatePromotionGate(fullRecipe({
      getArrivals: tableAction({ guest_name: 'b', arrival_date: 'c', departure_date: 'd' }), // no pms_reservation_id
    }));
    assert.equal(g.decision, 'park_draft');
    assert.match(g.reason, /getArrivals/);
    assert.match(g.reason, /pms_reservation_id/);
  });

  test('required feed with a BLANK column selector → park_draft', () => {
    const g = evaluatePromotionGate(fullRecipe({ getRoomStatus: tableAction({ room_number: 'a', status: '' }) }));
    assert.equal(g.decision, 'park_draft');
    assert.match(g.reason, /getRoomStatus/);
  });

  test('missing required KEY still → quarantine (unchanged behavior)', () => {
    const r = fullRecipe();
    delete r.actions.getWorkOrders;
    const g = evaluatePromotionGate(r);
    assert.equal(g.decision, 'quarantine');
    assert.match(g.reason, /getWorkOrders/);
  });

  test('OPTIONAL/business-critical feed with blank columns does NOT block promotion', () => {
    // getRevenueDaily is not a REQUIRED_TARGET → never column-gated.
    const g = evaluatePromotionGate(fullRecipe({ getRevenueDaily: tableAction({ date: '' }) }));
    assert.equal(g.decision, 'auto_promote');
  });
});
