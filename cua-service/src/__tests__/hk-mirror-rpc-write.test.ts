/**
 * Migration 0346 — the ingest writes the housekeeping mirror through an RPC.
 *
 * The Staxis app and this worker authenticate as the SAME Postgres role
 * (service_role), so GRANTs cannot tell them apart. 0346 therefore REVOKEd
 * INSERT/UPDATE/DELETE on pms_housekeeping_assignments from service_role and
 * made SECURITY DEFINER public.staxis_apply_hk_mirror() the only write path.
 * The descriptor carries the function name in `write_via_rpc`.
 *
 * The failure this pins, named in the plan review: if the RPC and the writer
 * drift — wrong parameter names, a direct upsert sneaking back in — the feed
 * writes ZERO rows and looks exactly like a healthy quiet poll. That is the
 * same silent-success failure mode the feed-integrity guard exists for, so it
 * gets a test that exercises the real dispatch path.
 */

// MUST be first: generic-table-writer transitively builds the Supabase client.
import './ws-polyfill.js';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { saveGenericTable } from '../persistence/generic-table-writer.js';
import { supabase } from '../supabase.js';

const PID = '00000000-0000-0000-0000-000000000001';

// The descriptor exactly as migration 0346 leaves it: the five PMS-reported
// columns, plus write_via_rpc naming the SECURITY DEFINER function.
const MIRROR_DESCRIPTOR = {
  table_name: 'pms_housekeeping_assignments',
  write_strategy: 'upsert',
  snapshot_scope_default: 'full',
  natural_key: ['property_id', 'date', 'room_number'],
  reconcile_key_field: null,
  columns: [
    { name: 'date', type: 'date', required: true, nullable: false },
    { name: 'room_number', type: 'text', required: true, nullable: false },
    { name: 'housekeeper_name', type: 'text', required: false, nullable: true },
    { name: 'cleaning_type', type: 'text', required: false, nullable: true },
    { name: 'dnd_active', type: 'boolean', required: false, nullable: true },
  ],
  write_via_rpc: 'staxis_apply_hk_mirror',
};

type AnyFn = (...args: unknown[]) => unknown;
const originalFrom = supabase.from.bind(supabase) as AnyFn;
const originalRpc = supabase.rpc.bind(supabase) as AnyFn;

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
let directUpserts: string[];

beforeEach(() => {
  rpcCalls = [];
  directUpserts = [];

  (supabase as unknown as { from: AnyFn }).from = ((table: string) => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      insert: () => builder,
      upsert: () => {
        directUpserts.push(table);
        return builder;
      },
      maybeSingle: async () =>
        table === 'pms_table_schemas'
          ? { data: MIRROR_DESCRIPTOR, error: null }
          : { data: null, error: null },
      then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
    };
    return builder;
  }) as AnyFn;

  (supabase as unknown as { rpc: AnyFn }).rpc = (async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    // The real function returns the number of rows it actually wrote.
    const rows = (args?.p_rows as unknown[]) ?? [];
    return { data: rows.length, error: null };
  }) as AnyFn;
});

afterEach(() => {
  (supabase as unknown as { from: AnyFn }).from = originalFrom;
  (supabase as unknown as { rpc: AnyFn }).rpc = originalRpc;
});

describe('write_via_rpc dispatch (0346)', () => {
  test('the housekeeping mirror is written through the RPC, never upserted directly', async () => {
    const result = await saveGenericTable(PID, 'pms_housekeeping_assignments', [
      { date: '2026-07-24', room_number: '214', housekeeper_name: 'Maria Garcia', cleaning_type: 'departure' },
      { date: '2026-07-24', room_number: '215', housekeeper_name: 'Ana Lopez', dnd_active: true },
    ]);

    assert.equal(result.ok, true, `write failed: ${JSON.stringify(result.errors)}`);
    assert.ok(
      !directUpserts.includes('pms_housekeeping_assignments'),
      'service_role has no INSERT/UPDATE on the mirror — a direct upsert is permission-denied in production',
    );
    assert.equal(rpcCalls.length, 1, 'exactly one RPC call for the batch');
    assert.equal(rpcCalls[0]!.fn, 'staxis_apply_hk_mirror');
  });

  test('the argument names match the function signature exactly', async () => {
    await saveGenericTable(PID, 'pms_housekeeping_assignments', [
      { date: '2026-07-24', room_number: '214' },
    ]);
    // staxis_apply_hk_mirror(p_property_id uuid, p_rows jsonb). Postgres
    // resolves named arguments by name — a rename on either side is a
    // "function does not exist" error at runtime, not a type error at build.
    assert.deepEqual(Object.keys(rpcCalls[0]!.args).sort(), ['p_property_id', 'p_rows']);
    assert.equal(rpcCalls[0]!.args.p_property_id, PID);
    assert.ok(Array.isArray(rpcCalls[0]!.args.p_rows));
  });

  test('the reported row count comes from the function, not from optimism', async () => {
    (supabase as unknown as { rpc: AnyFn }).rpc = (async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: 1, error: null };  // the function declined one row
    }) as AnyFn;

    const result = await saveGenericTable(PID, 'pms_housekeeping_assignments', [
      { date: '2026-07-24', room_number: '214' },
      { date: '2026-07-24', room_number: '215' },
    ]);
    assert.equal(
      result.inserted, 1,
      'a row the function declined must not be reported as written — that is how a half-failing feed looks healthy',
    );
  });

  test('an RPC failure surfaces as a failed write, not a quiet success', async () => {
    (supabase as unknown as { rpc: AnyFn }).rpc = (async () =>
      ({ data: null, error: { message: 'permission denied for table pms_housekeeping_assignments' } })) as AnyFn;

    const result = await saveGenericTable(PID, 'pms_housekeeping_assignments', [
      { date: '2026-07-24', room_number: '214' },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.inserted, 0);
    assert.ok(result.errors.join(' ').includes('permission denied'));
  });

  test('a table with no write_via_rpc still upserts directly', async () => {
    (supabase as unknown as { from: AnyFn }).from = ((table: string) => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        insert: () => builder,
        upsert: () => { directUpserts.push(table); return builder; },
        maybeSingle: async () =>
          table === 'pms_table_schemas'
            ? { data: { ...MIRROR_DESCRIPTOR, table_name: 'pms_rooms_inventory', write_via_rpc: null,
                        natural_key: ['property_id', 'room_number'],
                        columns: [{ name: 'room_number', type: 'text', required: true, nullable: false }] },
                error: null }
            : { data: null, error: null },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return builder;
    }) as AnyFn;

    const result = await saveGenericTable(PID, 'pms_rooms_inventory', [{ room_number: '101' }]);
    assert.equal(result.ok, true);
    assert.equal(rpcCalls.length, 0, 'no RPC for a normally-writable table');
    assert.deepEqual(directUpserts, ['pms_rooms_inventory']);
  });
});
