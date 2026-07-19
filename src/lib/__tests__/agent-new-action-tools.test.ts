/**
 * Tests for the five new AI-assistant abilities added on this branch:
 *   schedules  (get_schedule / remove_from_shift / assign_shift)
 *   inventory  (get_low_stock / adjust_stock)
 *   reminders  (create_reminder / cancel_reminder / list_reminders)
 *   recurring  (create_recurring_todo / stop_recurring_todo / list_recurring_todos)
 *   lost&found (search_lost_found)
 *
 * Strategy: monkey-patch supabaseAdmin.from with per-table stubs (the same idiom
 * as agent-comms-action-tools.test.ts). We assert the behaviours that matter for
 * correctness + the approval flow — role/identity refusals, name/date/count
 * validation, and that writes hit the right table with the right columns.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { executeTool, getTool, type ToolContext } from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import { supabaseAdmin } from '@/lib/supabase-admin';

const PID = '00000000-0000-0000-0000-0000000000c1';
const CALLER_STAFF = '00000000-0000-0000-0000-0000000000c2';
const ACCT = '00000000-0000-0000-0000-0000000000c3';
const MARIA = '00000000-0000-0000-0000-0000000000c4';
const MARIO = '00000000-0000-0000-0000-0000000000c5';

// ── Mutable per-test fixtures ──────────────────────────────────────────────
let staffRows: Array<{ id: string; property_id: string; name: string; department: string | null; is_active: boolean }>;
let shiftRows: Array<Record<string, unknown>>;
let inventoryRows: Array<Record<string, unknown>>;
let timeOffRows: Array<Record<string, unknown>>;
let lafRows: Array<Record<string, unknown>>;

const inserted: Record<string, Array<Record<string, unknown>>> = {};
const updated: Record<string, Array<Record<string, unknown>>> = {};
const deleted: Record<string, number> = {};
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

beforeEach(() => {
  staffRows = [
    { id: MARIA, property_id: PID, name: 'Maria Garcia', department: 'housekeeping', is_active: true },
    { id: CALLER_STAFF, property_id: PID, name: 'Reeyen Boss', department: 'front_desk', is_active: true },
  ];
  shiftRows = [];
  inventoryRows = [];
  timeOffRows = [];
  lafRows = [];
  for (const k of Object.keys(inserted)) delete inserted[k];
  for (const k of Object.keys(updated)) delete updated[k];
  for (const k of Object.keys(deleted)) delete deleted[k];
  rpcCalls.length = 0;
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => buildStub(table);
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return { data: { replayed: false, saved: 1 }, error: null };
  };
});
afterEach(() => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
});

function record(bucket: Record<string, Array<Record<string, unknown>>>, table: string, row: Record<string, unknown>) {
  (bucket[table] ??= []).push(row);
}

/** A permissive thenable/chain that returns `rows` for list reads and the first
 *  row for single reads, and records insert/update/delete side-effects. */
function chain(table: string, rows: Record<string, unknown>[]) {
  const res = { data: rows, error: null };
  const single = { data: rows[0] ?? null, error: null };
  const api: Record<string, unknown> = {
    select: () => api, eq: () => api, neq: () => api, is: () => api, in: () => api,
    ilike: () => api, lte: () => api, gte: () => api, order: () => api, limit: () => api,
    maybeSingle: async () => single, single: async () => single,
    insert: (row: Record<string, unknown> | Record<string, unknown>[]) => {
      const list = Array.isArray(row) ? row : [row];
      for (const r of list) record(inserted, table, r);
      return {
        select: () => ({
          single: async () => ({ data: { id: `${table}-new` }, error: null }),
          maybeSingle: async () => ({ data: { id: `${table}-new` }, error: null }),
        }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
    },
    update: (row: Record<string, unknown>) => {
      record(updated, table, row);
      return {
        eq: () => api2,
        is: () => api2,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
    },
    delete: () => {
      deleted[table] = (deleted[table] ?? 0) + 1;
      return {
        eq: () => apiDel,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(res).then(resolve, reject),
  };
  // update returns a row (so `.select().maybeSingle()` sees a hit).
  const api2: Record<string, unknown> = {
    eq: () => api2, is: () => api2,
    select: () => ({ maybeSingle: async () => ({ data: { id: `${table}-upd` }, error: null }), single: async () => ({ data: { id: `${table}-upd` }, error: null }) }),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
  };
  const apiDel: Record<string, unknown> = {
    eq: () => apiDel,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
  };
  return api;
}

function buildStub(table: string) {
  switch (table) {
    case 'staff': return chain('staff', staffRows.filter((s) => s.is_active));
    case 'scheduled_shifts': return chain('scheduled_shifts', shiftRows);
    case 'time_off_requests': return chain('time_off_requests', timeOffRows);
    case 'inventory': return chain('inventory', inventoryRows);
    case 'inventory_orders': return chain('inventory_orders', []);
    case 'agent_reminders': return chain('agent_reminders', []);
    case 'recurring_task_templates': return chain('recurring_task_templates', []);
    case 'lost_and_found_items': return chain('lost_and_found_items', lafRows);
    case 'pms_lost_and_found': return chain('pms_lost_and_found', []);
    default: return chain(table, []);
  }
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    user: {
      uid: 'uid-1', accountId: ACCT, username: 'reeyen', displayName: 'Reeyen Boss',
      role: 'general_manager', propertyAccess: [PID], dept: 'front_desk',
    },
    propertyId: PID, staffId: CALLER_STAFF, requestId: 'req-1', surface: 'chat',
    conversationId: 'conv-1',
    ...overrides,
  };
}

// ─── Schedules ─────────────────────────────────────────────────────────────

describe('get_schedule', () => {
  test('lists who is working on a date and excludes approved time-off', async () => {
    shiftRows = [
      { staff_id: MARIA, department: 'housekeeping', start_time: '08:00', end_time: '16:00', kind: 'shift', status: 'published' },
      { staff_id: MARIO, department: 'maintenance', start_time: '09:00', end_time: '17:00', kind: 'shift', status: 'published' },
      { staff_id: null, department: 'housekeeping', start_time: '08:00', end_time: '16:00', kind: 'open', status: 'published' },
    ];
    staffRows.push({ id: MARIO, property_id: PID, name: 'Mario Reyes', department: 'maintenance', is_active: true });
    timeOffRows = [{ staff_id: MARIO }]; // Mario has approved time off
    const res = await executeTool('get_schedule', { date: '2026-07-08' }, ctx());
    assert.equal(res.ok, true);
    const data = res.data as { working: { name: string }[]; workingCount: number; openSlots: number; timeOff: string[] };
    assert.deepEqual(data.working.map((w) => w.name), ['Maria Garcia']);
    assert.equal(data.workingCount, 1);
    assert.equal(data.openSlots, 1);
    assert.deepEqual(data.timeOff, ['Mario Reyes']);
  });

  test('rejects an unreadable date', async () => {
    const res = await executeTool('get_schedule', { date: 'someday' }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /date/i);
  });

  test('a housekeeper cannot read the schedule (manager-gated)', async () => {
    const res = await executeTool('get_schedule', { date: 'today' }, ctx({ user: { ...ctx().user, role: 'housekeeping' } }));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /role|allowed/i);
  });
});

describe('remove_from_shift', () => {
  test('refuses when the person has no shift that day (nothing to remove)', async () => {
    shiftRows = []; // no existing shift
    const res = await executeTool('remove_from_shift', { staffName: 'Maria', date: '2026-07-08' }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /nothing to remove|isn't scheduled/i);
    assert.equal(deleted['scheduled_shifts'] ?? 0, 0, 'no delete when there was no shift');
  });

  test('deletes the shift when one exists', async () => {
    shiftRows = [{ id: 'shift-1' }]; // existing-shift lookup returns a row
    const res = await executeTool('remove_from_shift', { staffName: 'Maria', date: '2026-07-08' }, ctx());
    assert.equal(res.ok, true);
    assert.equal((res.data as { staffName: string }).staffName, 'Maria Garcia');
    assert.equal(deleted['scheduled_shifts'], 1);
  });
});

describe('assign_shift', () => {
  test('inserts a shift with default hours and the staff department', async () => {
    const res = await executeTool('assign_shift', { staffName: 'Maria', date: '2026-07-08' }, ctx());
    assert.equal(res.ok, true);
    const rows = inserted['scheduled_shifts'] ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].staff_id, MARIA);
    assert.equal(rows[0].start_time, '08:00');
    assert.equal(rows[0].end_time, '16:00');
    assert.equal(rows[0].kind, 'shift');
    assert.equal(rows[0].department, 'housekeeping'); // Maria's own dept
  });

  test('honors explicit hours', async () => {
    const res = await executeTool('assign_shift', { staffName: 'Maria', date: '2026-07-08', startTime: '07:00', endTime: '15:00' }, ctx());
    assert.equal(res.ok, true);
    const rows = inserted['scheduled_shifts'] ?? [];
    assert.equal(rows[0].start_time, '07:00');
    assert.equal(rows[0].end_time, '15:00');
  });
});

// ─── Inventory ─────────────────────────────────────────────────────────────

describe('get_low_stock', () => {
  test('returns only low/critical by default, classified by the par ratio', async () => {
    inventoryRows = [
      { id: 'i1', name: 'Towels', category: 'housekeeping', current_stock: 30, par_level: 100, unit: 'ea' }, // 0.30 → critical
      { id: 'i2', name: 'Soap', category: 'housekeeping', current_stock: 70, par_level: 100, unit: 'ea' },   // 0.70 → low
      { id: 'i3', name: 'Coffee', category: 'breakfast', current_stock: 200, par_level: 100, unit: 'bag' },  // 2.0 → good (excluded)
    ];
    const res = await executeTool('get_low_stock', {}, ctx());
    assert.equal(res.ok, true);
    const data = res.data as { items: { name: string; status: string }[]; criticalCount: number; lowCount: number };
    assert.deepEqual(data.items.map((i) => i.name), ['Towels', 'Soap']); // critical first
    assert.equal(data.items[0].status, 'critical');
    assert.equal(data.items[1].status, 'low');
    assert.equal(data.criticalCount, 1);
    assert.equal(data.lowCount, 1);
  });

  test('front desk is allowed to read low stock', async () => {
    inventoryRows = [];
    const res = await executeTool('get_low_stock', {}, ctx({ user: { ...ctx().user, role: 'front_desk' } }));
    assert.equal(res.ok, true);
  });
});

describe('adjust_stock', () => {
  test('does not expose an order quantity because no purchase-order ledger exists', () => {
    const tool = getTool('adjust_stock');
    assert.ok(tool);
    assert.equal('orderQuantity' in (tool.inputSchema.properties ?? {}), false);
  });

  test('atomically saves the on-hand count and audit row with an idempotency UUID', async () => {
    inventoryRows = [{ id: 'i1', name: 'Towels', category: 'housekeeping', current_stock: 30, par_level: 100, unit: 'ea' }];
    const res = await executeTool('adjust_stock', { itemName: 'Towels', newCount: 120 }, ctx());
    assert.equal(res.ok, true);
    assert.deepEqual(res.data, {
      itemName: 'Towels',
      category: 'housekeeping',
      newCount: 120,
      unit: 'ea',
      orderIntentRecorded: false,
      deliveryLogged: false,
      purchaseLogged: false,
      note: null,
    });
    assert.equal(updated.inventory?.length ?? 0, 0, 'count must not use a standalone inventory update');
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].fn, 'staxis_save_inventory_count');
    assert.equal(rpcCalls[0].args.p_property_id, PID);
    assert.match(String(rpcCalls[0].args.p_request_id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(rpcCalls[0].args.p_counted_by, 'Reeyen Boss');
    assert.deepEqual(rpcCalls[0].args.p_rows, [{
      item_id: 'i1',
      expected_stock: 30,
      counted_stock: 120,
      notes: 'Counted via Staxis assistant',
    }]);
  });

  test('marks order intent without writing the received-delivery ledger', async () => {
    inventoryRows = [{ id: 'i1', name: 'Soap', category: 'housekeeping', current_stock: 5, par_level: 50, unit: 'ea' }];
    const res = await executeTool('adjust_stock', { itemName: 'Soap', markOrdered: true }, ctx());
    assert.equal(res.ok, true);
    assert.equal(inserted.inventory_orders?.length ?? 0, 0, 'order intent must not create a received delivery');
    assert.equal(updated.inventory?.length, 1);
    assert.deepEqual(Object.keys(updated.inventory[0]), ['last_ordered_at']);
    assert.ok(!Number.isNaN(Date.parse(String(updated.inventory[0].last_ordered_at))));
    assert.deepEqual(res.data, {
      itemName: 'Soap',
      category: 'housekeeping',
      newCount: null,
      unit: 'ea',
      orderIntentRecorded: true,
      deliveryLogged: false,
      purchaseLogged: false,
      note: 'Order intent timestamp saved only. No delivery or purchase was logged.',
    });
    assert.equal(rpcCalls.length, 0, 'order-only actions do not create a count session');
  });

  test('refuses when neither a count nor an order is given', async () => {
    inventoryRows = [{ id: 'i1', name: 'Soap', category: 'housekeeping', current_stock: 5, par_level: 50, unit: 'ea' }];
    const res = await executeTool('adjust_stock', { itemName: 'Soap' }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /count|intent|nothing/i);
  });

  test('refuses an ambiguous item name', async () => {
    inventoryRows = [
      { id: 'i1', name: 'Bath Towels', category: 'housekeeping', current_stock: 5, par_level: 50, unit: 'ea' },
      { id: 'i2', name: 'Hand Towels', category: 'housekeeping', current_stock: 5, par_level: 50, unit: 'ea' },
    ];
    const res = await executeTool('adjust_stock', { itemName: 'Towels', newCount: 10 }, ctx());
    assert.equal(res.ok, false);
    assert.equal((res.data as { ambiguous?: boolean }).ambiguous, true);
  });
});

// ─── Reminders ─────────────────────────────────────────────────────────────

describe('create_reminder', () => {
  const future = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

  test('schedules a department reminder', async () => {
    const res = await executeTool('create_reminder', { body: 'check the pool', fireAt: future, department: 'housekeeping' }, ctx());
    assert.equal(res.ok, true);
    const row = (inserted['agent_reminders'] ?? [])[0];
    assert.equal(row.target_department, 'housekeeping');
    assert.equal(row.target_staff_id, null);
    assert.equal(row.created_by_staff_id, CALLER_STAFF);
    assert.equal(row.body, 'check the pool');
  });

  test('schedules a person reminder resolved by name', async () => {
    const res = await executeTool('create_reminder', { body: 'gym check', fireAt: future, recipient: 'Maria' }, ctx());
    assert.equal(res.ok, true);
    const row = (inserted['agent_reminders'] ?? [])[0];
    assert.equal(row.target_staff_id, MARIA);
    assert.equal(row.target_department, null);
  });

  test('refuses a past fire time', async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    const res = await executeTool('create_reminder', { body: 'x', fireAt: past, department: 'general' }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /past|future/i);
  });

  test('refuses both a person and a department', async () => {
    const res = await executeTool('create_reminder', { body: 'x', fireAt: future, recipient: 'Maria', department: 'housekeeping' }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /either|both|one/i);
  });

  test('refuses when the caller has no staff identity', async () => {
    const res = await executeTool('create_reminder', { body: 'x', fireAt: future, department: 'general' }, ctx({ staffId: null }));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /staff/i);
  });
});

// ─── Recurring to-dos ──────────────────────────────────────────────────────

describe('create_recurring_todo', () => {
  test('creates a weekly template with a weekday', async () => {
    const res = await executeTool('create_recurring_todo', { title: 'deep clean lobby', cadence: 'weekly', weekday: 'Monday' }, ctx());
    assert.equal(res.ok, true);
    const row = (inserted['recurring_task_templates'] ?? [])[0];
    assert.equal(row.title, 'deep clean lobby');
    assert.equal(row.cadence, 'weekly');
    assert.equal(row.weekday, 1); // Monday
  });

  test('refuses weekly without a weekday', async () => {
    const res = await executeTool('create_recurring_todo', { title: 'x', cadence: 'weekly' }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /day/i);
  });

  test('creates a daily template', async () => {
    const res = await executeTool('create_recurring_todo', { title: 'check pool chemicals', cadence: 'daily', department: 'maintenance' }, ctx());
    assert.equal(res.ok, true);
    const row = (inserted['recurring_task_templates'] ?? [])[0];
    assert.equal(row.cadence, 'daily');
    assert.equal(row.weekday, null);
    assert.equal(row.assigned_department, 'maintenance');
  });
});

// ─── Lost & Found lookup ─────────────────────────────────────────────────────

describe('search_lost_found', () => {
  beforeEach(() => {
    lafRows = [
      { id: 'l1', property_id: PID, type: 'found', item_description: 'black iPhone 15', category: 'electronics', location: 'lobby', room_number: null, status: 'open', found_by: 'Maria', created_at: '2026-07-04T10:00:00Z' },
      { id: 'l2', property_id: PID, type: 'found', item_description: 'brown leather wallet', category: 'bags', location: 'Room 214', room_number: '214', status: 'returned', found_by: 'Carlos', created_at: '2026-06-20T10:00:00Z' },
      { id: 'l3', property_id: PID, type: 'lost', item_description: 'silver watch', category: 'jewelry', location: null, room_number: null, status: 'open', reported_by: 'guest', created_at: '2026-07-05T10:00:00Z' },
    ];
  });

  test('finds a found item by free text (AND across tokens)', async () => {
    const res = await executeTool('search_lost_found', { query: 'black iphone' }, ctx());
    assert.equal(res.ok, true);
    const data = res.data as { items: { description: string }[]; totalMatches: number };
    assert.equal(data.totalMatches, 1);
    assert.match(data.items[0].description, /iPhone/);
  });

  test('defaults to FOUND items (excludes lost reports)', async () => {
    const res = await executeTool('search_lost_found', { query: 'watch' }, ctx());
    assert.equal(res.ok, true);
    // The only "watch" is a LOST report → excluded by the default found filter.
    assert.equal((res.data as { totalMatches: number }).totalMatches, 0);
  });

  test('honors a date range against when the item was logged', async () => {
    const res = await executeTool('search_lost_found', { query: 'wallet', from: '2026-07-01', to: '2026-07-31' }, ctx());
    assert.equal(res.ok, true);
    // The wallet was logged 2026-06-20 → outside the July range.
    assert.equal((res.data as { totalMatches: number }).totalMatches, 0);
  });

  test('a housekeeper can look up lost & found (guest-facing, no approval)', async () => {
    const res = await executeTool('search_lost_found', { query: 'iphone' }, ctx({ user: { ...ctx().user, role: 'housekeeping' } }));
    assert.equal(res.ok, true);
  });
});
