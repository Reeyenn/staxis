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
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { validateRows, type TableSchemaDescriptor } from '../persistence/generic-table-writer.js';
import { recipeToTableTemplates } from '../recipe-adapter.js';
import { applyTemplateParsers } from '../extractors/template-runner.js';
import {
  CORE_TARGET_CONTRACTS,
  columnsFromAction,
  missingFromList,
  missingRequiredColumns,
  requiredLearnedFor,
  parserForColumn,
  parserForLearnedColumn,
  MAX_COMPLETENESS_REASKS,
} from '../target-contract.js';
import { evaluatePromotionGate } from '../mapping-driver.js';
import { getParser } from '../parsers/registry.js';
import '../parsers/ca.js'; // side-effect: registers ca_date/ca_currency/ca_status/ca_integer/ca_boolean_yn
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

// ─── Test 3 — validateRows is STRICT on raw values (motivates the parser layer)
// These call validateRows DIRECTLY (no parser). They prove that a raw scraped
// string for a typed/enum column rejects the WHOLE row — which is exactly why
// recipe-adapter attaches value parsers. The end-to-end tests further below
// prove the parser layer bridges this.

describe('validateRows is strict on raw values (well-typed rows pass, raw strings reject)', () => {
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

  test('a RAW string num_nights rejects the whole reservation row (→ ca_integer parser needed)', () => {
    // Raw DOM/CSV scrape gives "2" (string); descriptor num_nights is integer →
    // type mismatch rejects the ENTIRE row, not just the field. recipe-adapter
    // now attaches ca_integer so the end-to-end path normalizes "2"→2 (proven
    // in the value-normalization tests below).
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
  const CORE_CASES: Array<[keyof Recipe['actions'], TableSchemaDescriptor]> = [
    ['getArrivals', RESERVATIONS_DESCRIPTOR],
    ['getDepartures', RESERVATIONS_DESCRIPTOR],
    ['getRoomStatus', ROOM_STATUS_DESCRIPTOR],
    ['getWorkOrders', WORK_ORDERS_DESCRIPTOR],
  ];

  test('contract columns (name+type+required) == descriptor, minus writer-stamped timestamptz', () => {
    const norm = (cols: Array<{ name: string; type: string; required: boolean }>) =>
      cols.map((c) => `${c.name}:${c.type}:${c.required}`).sort();
    for (const [key, desc] of CORE_CASES) {
      // Learnable descriptor columns = all columns minus required timestamptz
      // (changed_at etc., which the writer auto-stamps and the model never learns).
      const expected = norm(desc.columns.filter((c) => c.type !== 'timestamptz'));
      const actual = norm(CORE_TARGET_CONTRACTS[key]!.columns);
      assert.deepEqual(actual, expected, `${key} columns/types drifted from descriptor`);
      assert.equal(CORE_TARGET_CONTRACTS[key]!.table, desc.table_name, `${key} table drifted`);
    }
  });

  test('requiredLearned == descriptor (required && type!=timestamptz)', () => {
    for (const [key, desc] of CORE_CASES) {
      const expected = desc.columns
        .filter((c) => c.required && c.type !== 'timestamptz')
        .map((c) => c.name)
        .sort();
      assert.deepEqual([...requiredLearnedFor(key)].sort(), expected, `${key} requiredLearned drifted`);
    }
  });

  // Tie the guard to the REAL migration so it can't pass when BOTH the local
  // fixtures AND the contract drift from 0207 together (Codex review #6).
  // Located relative to cwd (npm test runs from cua-service/; repo root is the
  // fallback) — avoids import.meta, which this CommonJS-target package forbids.
  const MIGRATION_REL = path.join('supabase', 'migrations', '0207_pms_table_schemas_and_shadow.sql');
  const MIGRATION_PATH = [
    path.resolve(process.cwd(), '..', MIGRATION_REL),
    path.resolve(process.cwd(), MIGRATION_REL),
  ].find((p) => existsSync(p));
  assert.ok(MIGRATION_PATH, `0207 migration not found relative to ${process.cwd()}`);
  const MIGRATION_0207 = readFileSync(MIGRATION_PATH, 'utf8');
  const columnsFromMigration = (table: string): Array<{ name: string; type: string; required: boolean }> => {
    const start = MIGRATION_0207.indexOf(`('${table}'`);
    assert.ok(start >= 0, `table ${table} not found in 0207`);
    const after = MIGRATION_0207.slice(start + 1);
    const next = after.search(/\('pms_/);            // boundary = next table's literal
    const block = next >= 0 ? after.slice(0, next) : after;
    const re = /jsonb_build_object\(\s*'name',\s*'([^']+)',\s*'type',\s*'([^']+)',\s*'required',\s*(true|false)/g;
    const cols: Array<{ name: string; type: string; required: boolean }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) cols.push({ name: m[1]!, type: m[2]!, required: m[3] === 'true' });
    return cols;
  };

  test('local fixtures AND the contract match the REAL 0207 migration file', () => {
    const norm = (cols: Array<{ name: string; type: string; required: boolean }>) =>
      cols.map((c) => `${c.name}:${c.type}:${c.required}`).sort();
    const TABLE_CASES: Array<[keyof Recipe['actions'], TableSchemaDescriptor]> = [
      ['getArrivals', RESERVATIONS_DESCRIPTOR],
      ['getRoomStatus', ROOM_STATUS_DESCRIPTOR],
      ['getWorkOrders', WORK_ORDERS_DESCRIPTOR],
    ];
    for (const [key, desc] of TABLE_CASES) {
      const mig = columnsFromMigration(desc.table_name);
      assert.ok(mig.length >= 3, `parsed too few columns for ${desc.table_name} (${mig.length})`);
      // The local descriptor fixture (used by every validateRows test) must match 0207.
      assert.deepEqual(norm(desc.columns), norm(mig), `${desc.table_name} fixture drifted from 0207`);
      // The contract must match 0207's learnable (non-timestamptz) columns.
      assert.deepEqual(
        norm(CORE_TARGET_CONTRACTS[key]!.columns),
        norm(mig.filter((c) => c.type !== 'timestamptz')),
        `${key} contract drifted from 0207`,
      );
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

// ─── Test 7 — END-TO-END value normalization (the deliverable) ───────────────
// Realistic CA DOM strings flow recipe → recipe-adapter (attaches parsers) →
// template-runner (applies them) → validateRows and PASS, producing a valid row
// for each core table. Without the wired parsers these raw strings would reject.

/** Build a 1-action recipe so recipe-adapter sees the action key (and so
 *  attaches the descriptor-driven parsers for that target). */
function recipeFor(actionKey: keyof Recipe['actions'], columns: Record<string, string>): Recipe {
  const action: ActionRecipe = {
    steps: [{ kind: 'goto', url: 'https://pms.example.com/x' }],
    parse: { mode: 'table', hint: { rowSelector: 'tr', columns } },
  };
  const actions = {} as Recipe['actions'];
  actions[actionKey] = action;
  return {
    schema: 1,
    login: { startUrl: 'https://pms.example.com/login', steps: [{ kind: 'click', selector: 'b' }], successSelectors: ['.d'] },
    actions,
  };
}

/** Run columns (key→selector) + a raw scraped row (selector→string) through the
 *  full adapter+runner pipeline and return the parsed row. */
function pipelineRow(
  actionKey: keyof Recipe['actions'],
  table: string,
  columns: Record<string, string>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const tmpl = recipeToTableTemplates(recipeFor(actionKey, columns)).templates.find((t) => t.tableName === table);
  assert.ok(tmpl, `expected a ${table} template`);
  return applyTemplateParsers(raw, tmpl!, 'list_row');
}

describe('end-to-end: CA DOM strings → parsers → validateRows PASS', () => {
  test('pms_reservations: "6/10/2026" / nights "2" normalize and write a valid row', () => {
    const cols = {
      pms_reservation_id: 's.conf', guest_name: 's.name', arrival_date: 's.arr',
      departure_date: 's.dep', room_number: 's.room', num_nights: 's.nights',
    };
    const raw = {
      's.conf': 'CA-100245', 's.name': 'Jane Doe', 's.arr': '6/10/2026',
      's.dep': '6/12/2026', 's.room': '204', 's.nights': '2',
    };
    const row = pipelineRow('getArrivals', 'pms_reservations', cols, raw);
    assert.equal(row.arrival_date, '2026-06-10');   // ca_date normalized the slash date
    assert.equal(row.departure_date, '2026-06-12');
    assert.equal(row.num_nights, 2);                // ca_integer "2" → number (was the regression)
    const v = validateRows([{ ...row, property_id: PID }], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('pms_room_status_log: status "OCC" normalizes to the enum and writes', () => {
    const cols = { room_number: 's.room', status: 's.status' };
    const raw = { 's.room': '204', 's.status': 'OCC' };
    const row = pipelineRow('getRoomStatus', 'pms_room_status_log', cols, raw);
    assert.equal(row.status, 'occupied'); // ca_status
    // changed_at is writer-stamped (required timestamptz) — mirror that here.
    const v = validateRows([{ ...row, property_id: PID, changed_at: '2026-06-10T12:00:00.000Z' }], ROOM_STATUS_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('pms_work_orders_v2: "In Progress" / "High" / "N" normalize to the enums + boolean and write', () => {
    const cols = { pms_work_order_id: 's.id', description: 's.desc', status: 's.status', out_of_order: 's.ooo', priority: 's.prio' };
    const raw = { 's.id': 'WO-42', 's.desc': 'Leaky faucet', 's.status': 'In Progress', 's.ooo': 'N', 's.prio': 'High' };
    const row = pipelineRow('getWorkOrders', 'pms_work_orders_v2', cols, raw);
    assert.equal(row.out_of_order, false);  // ca_boolean_yn
    assert.equal(row.status, 'in_progress'); // ca_work_order_status (was "In Progress")
    assert.equal(row.priority, 'high');      // ca_priority (was "High")
    const v = validateRows([{ ...row, property_id: PID }], WORK_ORDERS_DESCRIPTOR);
    assert.equal(v.rejected.length, 0, JSON.stringify(v.rejected));
    assert.equal(v.valid.length, 1);
  });

  test('contrast: the SAME raw reservation row WITHOUT parsers rejects', () => {
    // Prove the parsers are load-bearing: feed validateRows the raw strings
    // directly (no template-runner) and it rejects on the date type check.
    const v = validateRows([{
      property_id: PID, pms_reservation_id: 'CA-100245', guest_name: 'Jane Doe',
      arrival_date: '6/10/2026', departure_date: '6/12/2026',
    }], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.valid.length, 0);
    assert.match(v.rejected[0]!.reason, /arrival_date/);
  });

  test('a malformed date rejects only its OWN row — the batch survives (no Postgres throw)', () => {
    // The BLOCKER: pre-fix, ca_date turned "13/40/2026" into "2026-13-40", which
    // passed validateRows' shape regex and then threw at the Postgres `date`
    // column, losing the whole batch. ca_date now calendar-validates → null →
    // the bad row rejects locally while a good row in the same batch still writes.
    const cols = { pms_reservation_id: 's.conf', guest_name: 's.name', arrival_date: 's.arr', departure_date: 's.dep' };
    const goodRow = pipelineRow('getArrivals', 'pms_reservations', cols, { 's.conf': 'OK-1', 's.name': 'A', 's.arr': '6/10/2026', 's.dep': '6/12/2026' });
    const badRow = pipelineRow('getArrivals', 'pms_reservations', cols, { 's.conf': 'BAD-1', 's.name': 'B', 's.arr': '13/40/2026', 's.dep': '6/12/2026' });
    assert.equal(badRow.arrival_date, null); // ca_date rejected the fake calendar date
    const v = validateRows([{ ...goodRow, property_id: PID }, { ...badRow, property_id: PID }], RESERVATIONS_DESCRIPTOR);
    assert.equal(v.valid.length, 1);         // good row survives
    assert.equal(v.rejected.length, 1);      // bad row rejected (missing required arrival_date), no DB-bound garbage
    assert.match(v.rejected[0]!.reason, /arrival_date/);
  });
});

// ─── Test 8 — parser selection (driven by descriptor type) ───────────────────

describe('parser selection', () => {
  test('parserForColumn maps by type, with the room-status enum override', () => {
    assert.equal(parserForColumn('pms_reservations', { name: 'arrival_date', type: 'date' }), 'ca_date');
    assert.equal(parserForColumn('pms_reservations', { name: 'num_nights', type: 'integer' }), 'ca_integer');
    assert.equal(parserForColumn('pms_reservations', { name: 'rate_per_night_cents', type: 'bigint' }), 'ca_currency');
    assert.equal(parserForColumn('pms_x', { name: 'big_count', type: 'bigint' }), 'ca_integer'); // bigint not *_cents
    assert.equal(parserForColumn('pms_work_orders_v2', { name: 'out_of_order', type: 'boolean' }), 'ca_boolean_yn');
    assert.equal(parserForColumn('pms_reservations', { name: 'guest_name', type: 'text' }), undefined);
    assert.equal(parserForColumn('pms_room_status_log', { name: 'status', type: 'text' }), 'ca_status'); // enum override
    assert.equal(parserForColumn('pms_reservations', { name: 'status', type: 'text' }), undefined); // no override → text
    // work-order enum overrides (required status + optional priority)
    assert.equal(parserForColumn('pms_work_orders_v2', { name: 'status', type: 'text' }), 'ca_work_order_status');
    assert.equal(parserForColumn('pms_work_orders_v2', { name: 'priority', type: 'text' }), 'ca_priority');
  });

  test('parserForLearnedColumn resolves via contract; undefined for non-core / extra fields', () => {
    assert.equal(parserForLearnedColumn('getArrivals', 'arrival_date'), 'ca_date');
    assert.equal(parserForLearnedColumn('getArrivals', 'num_nights'), 'ca_integer');
    assert.equal(parserForLearnedColumn('getRoomStatus', 'status'), 'ca_status');
    assert.equal(parserForLearnedColumn('getWorkOrders', 'out_of_order'), 'ca_boolean_yn');
    assert.equal(parserForLearnedColumn('getWorkOrders', 'status'), 'ca_work_order_status');
    assert.equal(parserForLearnedColumn('getWorkOrders', 'priority'), 'ca_priority');
    assert.equal(parserForLearnedColumn('getArrivals', 'guest_name'), undefined); // text
    assert.equal(parserForLearnedColumn('getArrivals', 'adults'), undefined);     // extra field not in descriptor
    assert.equal(parserForLearnedColumn('getRevenueDaily', 'date'), undefined);   // non-core target
  });

  test('every parser the contract derives is actually registered', () => {
    for (const contract of Object.values(CORE_TARGET_CONTRACTS)) {
      for (const col of contract!.columns) {
        const name = parserForColumn(contract!.table, col);
        if (name) assert.ok(getParser(name), `parser "${name}" for ${contract!.table}.${col.name} is not registered`);
      }
    }
  });
});

// ─── Test 9 — ca.ts parser robustness ────────────────────────────────────────

describe('ca parsers — robustness fixes', () => {
  const date = getParser('ca_date')!;
  const cur = getParser('ca_currency')!;
  const int = getParser('ca_integer')!;
  const status = getParser('ca_status')!;
  const bool = getParser('ca_boolean_yn')!;

  test('ca_date: ISO / 4-digit slash + dash', () => {
    assert.equal(date('2026-06-10'), '2026-06-10');
    assert.equal(date('6/10/2026'), '2026-06-10');
    assert.equal(date('06-10-2026'), '2026-06-10');
  });
  test('ca_date: 2-digit year (M/D/YY and M-D-YY)', () => {
    assert.equal(date('6/10/26'), '2026-06-10');
    assert.equal(date('6-10-26'), '2026-06-10');
  });
  test('ca_date: textual months, month-first and day-first', () => {
    assert.equal(date('Jun 10, 2026'), '2026-06-10');
    assert.equal(date('June 10 2026'), '2026-06-10');
    assert.equal(date('10 Jun 2026'), '2026-06-10');
  });
  test('ca_date: unrecognized → null', () => {
    assert.equal(date('not a date'), null);
    assert.equal(date(''), null);
    assert.equal(date('Smarch 10 2026'), null); // unknown month name → null
    assert.equal(date('Junuary 10 2026'), null); // looks month-ish but isn't a real month
  });
  test('ca_date: calendar-invalid dates → null (the BLOCKER — never a fake ISO string)', () => {
    assert.equal(date('13/40/2026'), null);        // month 13, day 40
    assert.equal(date('0/10/2026'), null);         // month 0
    assert.equal(date('2/29/2025'), null);         // 2025 is not a leap year
    assert.equal(date('2/29/2024'), '2024-02-29'); // 2024 IS a leap year → valid
    assert.equal(date('2026-13-40'), null);        // a fake ISO input must not pass straight through
  });

  test('ca_currency: lowercase "n/a" sentinel caught after trim+uppercase', () => {
    assert.equal(cur('$1,234.56'), 123456);
    assert.equal(cur('  n/a '), null);
    assert.equal(cur('--'), null);
  });
  test('ca_integer: lowercase "n/a" sentinel caught after trim+uppercase', () => {
    assert.equal(int('12,345'), 12345);
    assert.equal(int(' n/a'), null);
    assert.equal(int('2'), 2);
  });

  test('ca_status: known codes incl. vacant_dirty; unrecognized → unknown', () => {
    assert.equal(status('OCC'), 'occupied');
    assert.equal(status('Occupied'), 'occupied');
    assert.equal(status('VAC'), 'vacant_clean');
    assert.equal(status('VC'), 'vacant_clean');
    assert.equal(status('VD'), 'vacant_dirty');
    assert.equal(status('Vacant Dirty'), 'vacant_dirty');  // not mislabeled vacant_clean
    assert.equal(status('VACANTDIRTY'), 'vacant_dirty');   // no separator
    assert.equal(status('VAC/DIRTY'), 'vacant_dirty');     // slash separator
    assert.equal(status('OOO'), 'out_of_order');
    assert.equal(status('Out of Order'), 'out_of_order');
    assert.equal(status('Inspected'), 'inspected');
    assert.equal(status('ZZZ'), 'unknown'); // unrecognized → 'unknown' (also log.warns)
    // Negations must NOT positively match (no broad includes()).
    assert.equal(status('Uninspected'), 'unknown');
    assert.equal(status('Not Inspected'), 'unknown');
    assert.equal(status('Needs Cleaning'), 'unknown');
  });

  test('ca_boolean_yn: Y/N/true/false/booleans', () => {
    assert.equal(bool('N'), false);
    assert.equal(bool('Y'), true);
    assert.equal(bool('yes'), true);
    assert.equal(bool(false), false);
    assert.equal(bool('maybe'), null);
  });

  const wos = getParser('ca_work_order_status')!;
  test('ca_work_order_status: normalizes to the enum; unrecognized → open', () => {
    assert.equal(wos('Open'), 'open');
    assert.equal(wos('In Progress'), 'in_progress');
    assert.equal(wos('in_progress'), 'in_progress');
    assert.equal(wos('Closed'), 'resolved');
    assert.equal(wos('Completed'), 'resolved');
    assert.equal(wos('Cancelled'), 'cancelled');
    assert.equal(wos('Pending'), 'open');
    assert.equal(wos('Weird State'), 'open'); // unrecognized → 'open' (also log.warns)
    assert.equal(wos(''), null);
  });

  const prio = getParser('ca_priority')!;
  test('ca_priority: normalizes to the enum; blank → null; unrecognized → unknown', () => {
    assert.equal(prio('Low'), 'low');
    assert.equal(prio('High'), 'high');
    assert.equal(prio('Urgent'), 'critical');
    assert.equal(prio('Critical'), 'critical');
    assert.equal(prio('Normal'), 'medium');
    assert.equal(prio(''), null);              // optional → null skips the field, row survives
    assert.equal(prio('Whatever'), 'unknown'); // unrecognized → 'unknown' (also log.warns)
  });
});
