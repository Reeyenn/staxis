/**
 * New contract (migration 0305): a property with NO per-property checklist
 * gets an EMPTY effective checklist — the global Staxis default is no longer a
 * fallback. A property WITH a per-property override still gets exactly its own
 * items. This pins both directions so a future refactor can't quietly
 * reintroduce the "new hotels inherit the built-in default" behavior that the
 * 2026-07-09 product decision deliberately removed.
 *
 * Strategy: monkey-patch supabaseAdmin.from with a chainable, awaitable mock
 * (same approach as api-auth-property-access.test.ts) so the db-layer resolvers
 * run their real logic against canned query results. We also assert the
 * queries stay property-scoped and never re-add a `property_id IS NULL` /
 * `.or(...)` default lookup.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getEffectiveCleaningChecklist,
  getEffectiveInspectionChecklist,
} from '@/lib/db/checklists';
import { supabaseAdmin } from '@/lib/supabase-admin';

// ─── Mock infrastructure ─────────────────────────────────────────────────

interface QueryResult { data: unknown; error: unknown }

type FromFn = typeof supabaseAdmin.from;
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

// One FIFO queue of results per table — a resolver that reads a table twice
// (e.g. templates then items) pulls them in order.
let resultsByTable: Record<string, QueryResult[]>;
// Every filter method invoked, per table, for asserting query shape.
let methodCalls: { table: string; method: string; args: unknown[] }[];

function makeBuilder(table: string): any {
  const record = (method: string, args: unknown[]) => methodCalls.push({ table, method, args });
  const take = (): QueryResult => (resultsByTable[table] ?? []).shift() ?? { data: null, error: null };
  const builder: any = {
    select: (...a: unknown[]) => { record('select', a); return builder; },
    eq: (...a: unknown[]) => { record('eq', a); return builder; },
    is: (...a: unknown[]) => { record('is', a); return builder; },
    or: (...a: unknown[]) => { record('or', a); return builder; },
    order: (...a: unknown[]) => { record('order', a); return builder; },
    limit: (...a: unknown[]) => { record('limit', a); return builder; },
    maybeSingle: async () => take(),
    // Thenable: `await builder` (chains that don't end in maybeSingle) resolves here.
    then: (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(take()).then(resolve, reject),
  };
  return builder;
}

beforeEach(() => {
  resultsByTable = {};
  methodCalls = [];
  // makeBuilder returns `any`, so this assignment is structurally compatible.
  supabaseAdmin.from = (table: string) => makeBuilder(table);
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

const PID = '00000000-0000-0000-0000-0000000000aa';

const calledNullDefaultLookup = (table: string) =>
  methodCalls.some((c) => c.table === table && (c.method === 'or' || c.method === 'is'));
const calledEq = (table: string, col: string, val: unknown) =>
  methodCalls.some((c) => c.table === table && c.method === 'eq' && c.args[0] === col && c.args[1] === val);

// ─── Cleaning ─────────────────────────────────────────────────────────────

describe('getEffectiveCleaningChecklist — no global-default fallback (0305)', () => {
  test('no per-property template ⇒ empty checklist (does NOT fall back to the global default)', async () => {
    resultsByTable = { cleaning_checklist_templates: [{ data: null, error: null }] };

    const eff = await getEffectiveCleaningChecklist(PID, 'departure');

    assert.equal(eff.isOverride, false);
    assert.equal(eff.hasDefault, false);
    assert.equal(eff.nameEn, '');
    assert.deepEqual(eff.items, []);
    // The query must be scoped to this property and must NOT look up the
    // property_id IS NULL default (no `.or(...)` / `.is(...)`).
    assert.ok(calledEq('cleaning_checklist_templates', 'property_id', PID), 'query scoped to property_id');
    assert.equal(calledNullDefaultLookup('cleaning_checklist_templates'), false, 'no null-default fallback query');
  });

  test('per-property override ⇒ exactly its own items', async () => {
    resultsByTable = {
      cleaning_checklist_templates: [{
        data: { id: 't1', property_id: PID, cleaning_type: 'departure', name_en: 'House rules', name_es: 'Reglas', is_default: false, is_active: true },
        error: null,
      }],
      cleaning_checklist_items: [{
        data: [{ id: 'i1', area: 'bedroom', item_en: 'Make the bed', item_es: 'Hacer la cama', sort_order: 10, is_critical: true }],
        error: null,
      }],
    };

    const eff = await getEffectiveCleaningChecklist(PID, 'departure');

    assert.equal(eff.isOverride, true);
    assert.equal(eff.hasDefault, false);
    assert.equal(eff.nameEn, 'House rules');
    assert.equal(eff.items.length, 1);
    assert.equal(eff.items[0].itemEn, 'Make the bed');
    assert.equal(eff.items[0].isCritical, true);
  });
});

// ─── Inspection ─────────────────────────────────────────────────────────────

describe('getEffectiveInspectionChecklist — no global-default fallback (0305)', () => {
  test('no per-property checklist ⇒ empty (does NOT fall back to the global default)', async () => {
    resultsByTable = { inspection_checklists: [{ data: [], error: null }] };

    const eff = await getEffectiveInspectionChecklist(PID);

    assert.equal(eff.checklistId, null);
    assert.equal(eff.isOverride, false);
    assert.equal(eff.hasDefault, false);
    assert.equal(eff.otherCount, 0);
    assert.deepEqual(eff.items, []);
    assert.ok(calledEq('inspection_checklists', 'property_id', PID), 'query scoped to property_id');
    assert.equal(calledNullDefaultLookup('inspection_checklists'), false, 'no null-default fallback query');
  });

  test('per-property checklist ⇒ exactly its own items', async () => {
    resultsByTable = {
      inspection_checklists: [{
        data: [{ id: 'c1', property_id: PID, name: 'My QA', applies_to_cleaning_types: ['departure'], applies_to_room_types: [], is_active: true, version: 1, created_at: '', updated_at: '' }],
        error: null,
      }],
      inspection_checklist_items: [{
        data: [{ id: 'ii1', category: 'bedroom', label: 'Bed made', label_es: 'Cama hecha', severity_default: 'major', requires_photo_on_fail: false, order_index: 10 }],
        error: null,
      }],
    };

    const eff = await getEffectiveInspectionChecklist(PID);

    assert.equal(eff.checklistId, 'c1');
    assert.equal(eff.isOverride, true);
    assert.equal(eff.hasDefault, false);
    assert.equal(eff.name, 'My QA');
    assert.deepEqual(eff.appliesToCleaningTypes, ['departure']);
    assert.equal(eff.items.length, 1);
    assert.equal(eff.items[0].label, 'Bed made');
  });
});
