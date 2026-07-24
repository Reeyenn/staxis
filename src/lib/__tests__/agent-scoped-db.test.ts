/**
 * ScopedDb — the AI layer's one-hotel database door.
 *
 * These tests drive the accessor against a filter-recording fake so we can
 * assert the thing that actually matters: the hotel filter is applied (or the
 * hotel column injected) BEFORE the builder is handed back to the caller. That
 * pre-application is the precondition that makes PostgREST's AND-composition
 * of repeated query params load-bearing — a caller who chains another
 * `.eq()`/`.or()` narrows, it cannot widen (INV-26).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  scopedDb,
  unscopedBecause,
  scopeColumnFor,
  ScopedDbTenantMismatch,
  ScopedDbUnscopableTable,
} from '@/lib/agent/scoped-db';
import { supabaseAdmin } from '@/lib/supabase-admin';

const PID_A = '00000000-0000-0000-0000-0000000000a1';
const PID_B = '00000000-0000-0000-0000-0000000000b2';

type Filter = { op: string; column: string; value: unknown };
type Call = {
  table: string;
  verb: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  filters: Filter[];
  payload?: unknown;
  columns?: string;
};

let calls: Call[];
let rpcCalls: Array<{ fn: string; args: unknown }>;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

/** A chainable fake that records every filter applied to it. */
function builder(call: Call): Record<string, unknown> {
  const api: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  };
  for (const op of ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'ilike', 'or']) {
    api[op] = (column: string, value: unknown) => {
      call.filters.push({ op, column, value });
      return api;
    };
  }
  for (const passthrough of ['order', 'limit', 'select']) {
    api[passthrough] = () => api;
  }
  return api;
}

function installFake() {
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => ({
    select: (columns: string) => {
      const call: Call = { table, verb: 'select', filters: [], columns };
      calls.push(call);
      return builder(call);
    },
    insert: (payload: unknown) => {
      const call: Call = { table, verb: 'insert', filters: [], payload };
      calls.push(call);
      return builder(call);
    },
    upsert: (payload: unknown) => {
      const call: Call = { table, verb: 'upsert', filters: [], payload };
      calls.push(call);
      return builder(call);
    },
    update: (payload: unknown) => {
      const call: Call = { table, verb: 'update', filters: [], payload };
      calls.push(call);
      return builder(call);
    },
    delete: () => {
      const call: Call = { table, verb: 'delete', filters: [] };
      calls.push(call);
      return builder(call);
    },
  });
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.rpc = async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return { data: null, error: null };
  };
}

describe('scopedDb', () => {
  beforeEach(() => {
    calls = [];
    rpcCalls = [];
    installFake();
  });
  afterEach(() => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
  });

  const scopeFilters = (call: Call, column = 'property_id') =>
    call.filters.filter(f => f.op === 'eq' && f.column === column);

  test('select carries the hotel filter before the caller sees the builder', async () => {
    const db = scopedDb(PID_A);
    await db.from('inventory').select('name, current_stock');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].table, 'inventory');
    assert.deepEqual(scopeFilters(calls[0]), [{ op: 'eq', column: 'property_id', value: PID_A }]);
  });

  test('the scope filter is applied first, so later chaining can only narrow', async () => {
    const db = scopedDb(PID_A);
    await db.from('inventory').select('name').eq('category', 'housekeeping');
    const applied = calls[0].filters;
    assert.equal(applied[0].column, 'property_id', 'hotel filter must be filter #0');
    assert.equal(applied[1].column, 'category');
  });

  test('update and delete carry the hotel filter', async () => {
    const db = scopedDb(PID_A);
    await db.from('scheduled_shifts').update({ start_time: '08:00' }).eq('staff_id', 'x');
    await db.from('scheduled_shifts').delete().eq('staff_id', 'x');
    assert.deepEqual(scopeFilters(calls[0]), [{ op: 'eq', column: 'property_id', value: PID_A }]);
    assert.deepEqual(scopeFilters(calls[1]), [{ op: 'eq', column: 'property_id', value: PID_A }]);
  });

  test('insert injects the hotel column on a single row and on an array', async () => {
    const db = scopedDb(PID_A);
    await db.from('agent_nudges').insert({ user_id: 'u1' });
    await db.from('agent_nudges').insert([{ user_id: 'u1' }, { user_id: 'u2' }]);
    assert.deepEqual(calls[0].payload, { user_id: 'u1', property_id: PID_A });
    assert.deepEqual(calls[1].payload, [
      { user_id: 'u1', property_id: PID_A },
      { user_id: 'u2', property_id: PID_A },
    ]);
  });

  test('upsert injects the hotel column too', async () => {
    const db = scopedDb(PID_A);
    await db.from('inventory').upsert({ name: 'towels' }, { onConflict: 'id' });
    assert.deepEqual(calls[0].payload, { name: 'towels', property_id: PID_A });
  });

  test('a write that names a DIFFERENT hotel throws instead of landing', async () => {
    const db = scopedDb(PID_A);
    assert.throws(
      () => db.from('agent_nudges').insert({ user_id: 'u1', property_id: PID_B }),
      ScopedDbTenantMismatch,
    );
    assert.throws(
      () => db.from('agent_nudges').insert([{ user_id: 'u1' }, { user_id: 'u2', property_id: PID_B }]),
      ScopedDbTenantMismatch,
    );
    assert.equal(calls.length, 0, 'nothing may reach the client on a mismatch');
  });

  test('a write that restates its OWN hotel is allowed', async () => {
    const db = scopedDb(PID_A);
    await db.from('agent_nudges').insert({ user_id: 'u1', property_id: PID_A });
    assert.deepEqual(calls[0].payload, { user_id: 'u1', property_id: PID_A });
  });

  test('properties scopes on id, not property_id', async () => {
    assert.equal(scopeColumnFor('properties'), 'id');
    assert.equal(scopeColumnFor('inventory'), 'property_id');
    const db = scopedDb(PID_A);
    await db.from('properties').select('timezone');
    assert.deepEqual(scopeFilters(calls[0], 'id'), [{ op: 'eq', column: 'id', value: PID_A }]);
    assert.deepEqual(scopeFilters(calls[0]), [], 'must not also filter a non-existent property_id');
  });

  test('a table with no hotel column is refused by name', () => {
    const db = scopedDb(PID_A);
    for (const table of ['accounts', 'agent_prompts', 'agent_eval_baselines']) {
      assert.throws(
        () => db.from(table),
        (err: unknown) =>
          err instanceof ScopedDbUnscopableTable && err.message.includes(table),
        `${table} must be refused`,
      );
    }
    assert.equal(calls.length, 0);
  });

  test('agent_messages is scopable now that 0336 derives its property_id', async () => {
    const db = scopedDb(PID_A);
    await db.from('agent_messages').select('id');
    assert.deepEqual(scopeFilters(calls[0]), [{ op: 'eq', column: 'property_id', value: PID_A }]);
  });

  test('a hotel-scoped RPC must be called with THIS hotel', async () => {
    const db = scopedDb(PID_A);
    await db.rpc('staxis_store_memory', { p_property_id: PID_A, p_topic: 't' });
    assert.equal(rpcCalls.length, 1);
    assert.throws(
      () => db.rpc('staxis_store_memory', { p_property_id: PID_B, p_topic: 't' }),
      ScopedDbTenantMismatch,
    );
    assert.throws(
      () => db.rpc('staxis_store_memory', { p_topic: 't' }),
      ScopedDbTenantMismatch,
      'a missing hotel argument is a mismatch, not a pass',
    );
    assert.equal(rpcCalls.length, 1, 'no mismatched RPC may reach the client');
  });

  test('an undeclared RPC is refused rather than silently unscoped', () => {
    const db = scopedDb(PID_A);
    assert.throws(
      () => db.rpc('staxis_record_assistant_turn', { p_conversation_id: 'c1' }),
      ScopedDbTenantMismatch,
    );
    assert.equal(rpcCalls.length, 0);
  });

  test('the accessor refuses to exist without a real hotel id', () => {
    assert.throws(() => scopedDb(''), ScopedDbTenantMismatch);
    assert.throws(() => scopedDb('not-a-uuid'), ScopedDbTenantMismatch);
    assert.throws(() => scopedDb(undefined as unknown as string), ScopedDbTenantMismatch);
  });

  test('the client is resolved per call, not captured at construction', async () => {
    // Load-bearing: six existing test files monkey-patch the supabaseAdmin
    // singleton BETWEEN tests. An accessor that captured `.from` when it was
    // built would keep talking to the previous fake (or, worse, to the real
    // client) after the patch was swapped.
    const db = scopedDb(PID_A);
    await db.from('inventory').select('name');
    const seenByFirstFake = calls.length;

    const secondFake: Array<string> = [];
    // @ts-expect-error monkey-patch the singleton for the test
    supabaseAdmin.from = (table: string) => {
      secondFake.push(table);
      const call: Call = { table, verb: 'select', filters: [] };
      return { select: () => builder(call) };
    };
    await db.from('inventory').select('name');

    assert.equal(seenByFirstFake, 1);
    assert.equal(calls.length, 1, 'the second query must NOT reach the first fake');
    assert.deepEqual(secondFake, ['inventory']);
  });

  test('the escape hatch hands back the raw client', () => {
    assert.equal(unscopedBecause('global-identity-table'), supabaseAdmin);
  });
});
