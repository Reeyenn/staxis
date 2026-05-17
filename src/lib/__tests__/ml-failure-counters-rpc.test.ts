/**
 * Tests for src/lib/ml-failure-counters.ts after audit/concurrency #5
 * moved the JSON read-modify-write into the staxis_record_ml_failure
 * Postgres function.
 *
 * What we pin:
 *   - The RPC is called with (p_pid, p_kind, p_err) — args wired right.
 *   - Error messages are stringified (Error.message preferred).
 *   - There is NO `.from('scraper_status').select(...)` — that's what
 *     used to be the read step. If anyone reintroduces it, this test
 *     fires.
 *   - RPC errors are swallowed (the counter is best-effort by design).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { incrementMLFailureCounter } from '@/lib/ml-failure-counters';
import { supabaseAdmin } from '@/lib/supabase-admin';

type RpcFn = typeof supabaseAdmin.rpc;
type FromFn = typeof supabaseAdmin.from;

const originalRpc: RpcFn = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFrom: FromFn = supabaseAdmin.from.bind(supabaseAdmin);

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcReturn: { error: { message: string } | null } = { error: null };
let fromCalls: string[] = [];

beforeEach(() => {
  rpcCalls = [];
  rpcReturn = { error: null };
  fromCalls = [];

  // @ts-expect-error monkey-patch singleton
  supabaseAdmin.rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push({ fn, args });
    return { data: null, error: rpcReturn.error };
  };
  // monkey-patch singleton — supabaseAdmin.from is typed loosely enough
  // here, but this assignment is still a code smell outside of tests.
  supabaseAdmin.from = ((table: string) => {
    fromCalls.push(table);
    throw new Error(`scraper_status SELECT/UPSERT is forbidden after #5 — table=${table}`);
  }) as FromFn;
});

afterEach(() => {
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.from = originalFrom;
});

describe('incrementMLFailureCounter — atomic RPC path', () => {
  test('calls staxis_record_ml_failure with the right args', async () => {
    await incrementMLFailureCounter(
      '11111111-1111-1111-1111-111111111111',
      'feature_derivation',
      new Error('derive bombed'),
    );
    assert.equal(rpcCalls.length, 1);
    const call = rpcCalls[0];
    assert.equal(call.fn, 'staxis_record_ml_failure');
    assert.deepEqual(call.args, {
      p_pid: '11111111-1111-1111-1111-111111111111',
      p_kind: 'feature_derivation',
      p_err: 'derive bombed',
    });
    assert.equal(fromCalls.length, 0, 'should not touch scraper_status table directly');
  });

  test('stringifies non-Error inputs', async () => {
    await incrementMLFailureCounter(
      '22222222-2222-2222-2222-222222222222',
      'occupancy_capture',
      'string error',
    );
    assert.equal(rpcCalls[0].args.p_err, 'string error');
  });

  test('passes through RPC errors as warnings (does not throw)', async () => {
    rpcReturn = { error: { message: 'rpc unreachable' } };
    // Must not throw — parent room-action must never fail because of this.
    await assert.doesNotReject(
      incrementMLFailureCounter('33333333-3333-3333-3333-333333333333', 'feature_derivation', 'boom'),
    );
  });
});
