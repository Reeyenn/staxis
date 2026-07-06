/**
 * Voice control tools — confirm_pending_action / cancel_pending_action
 * (feature/voice-approval).
 *
 * Covers:
 *   (c) confirm_pending_action claims the newest pending row, executes the held
 *       tool, and finalizes the row 'executed'; cancel_pending_action marks it
 *       'denied'.
 *   (e) with NO pending row, both are a friendly no-op (ok:true, nothing_pending).
 *
 * Strategy: monkey-patch supabaseAdmin.from('agent_pending_actions') with a
 * stateful stub that models getLivePendingActions / claimPendingAction /
 * finalizePendingAction. The HELD tool executed by confirm is log_complaint run
 * in dryRun mode, so executeTool exercises the real dispatch path (surface/role
 * gates) without touching the complaints DB.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { executeTool, type ToolContext } from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reapStaleApprovedActions } from '@/lib/agent/pending-actions';

const PID = '00000000-0000-0000-0000-0000000000c1';
const CONV = '00000000-0000-0000-0000-0000000000c2';
const ACCT = '00000000-0000-0000-0000-0000000000c3';
const ROW_ID = '00000000-0000-0000-0000-0000000000c9';

interface Row {
  id: string;
  property_id: string;
  conversation_id: string;
  account_id: string;
  turn_key: string;
  tool_call_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  tier: string;
  status: string;
  result: unknown;
  error: string | null;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
  resume_claimed_at: string | null;
}

let store: Row[] = [];

function makeRow(over: Partial<Row> = {}): Row {
  return {
    id: ROW_ID,
    property_id: PID,
    conversation_id: CONV,
    account_id: ACCT,
    turn_key: 'tk1',
    tool_call_id: 'call_1',
    tool_name: 'log_complaint',
    tool_args: { description: 'no hot water in 305', roomNumber: '305' },
    tier: 'card',
    status: 'pending',
    result: null,
    error: null,
    created_at: new Date(Date.now() - 1000).toISOString(),
    resolved_at: null,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    resume_claimed_at: null,
    ...over,
  };
}

// Minimal stub of the agent_pending_actions table modelling the three query
// shapes the confirm/cancel handlers use.
function pendingTableStub() {
  const filters: { col: string; val: unknown }[] = [];
  const api: Record<string, unknown> = {};
  api.select = () => api;
  api.eq = (col: string, val: unknown) => { filters.push({ col, val }); return api; };
  api.order = () => api;
  // getLivePendingActions terminates in a thenable after .order()
  api.then = (resolve: (v: unknown) => unknown) => {
    const rows = store.filter((r) =>
      filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.val),
    );
    return Promise.resolve({ data: rows, error: null }).then(resolve);
  };
  // update(...).eq(...).eq(...).select().maybeSingle()  (claim)
  // update(...).eq('id', …)                             (finalize)
  api.update = (patch: Record<string, unknown>) => {
    const upFilters: { col: string; val: unknown }[] = [];
    const upApi: Record<string, unknown> = {};
    let applied = false;
    const rowMatches = (r: Row) =>
      upFilters.every((f) => {
        const rv = (r as unknown as Record<string, unknown>)[f.col];
        if (typeof f.val === 'string' && f.val.startsWith('__lt__')) {
          return String(rv) < f.val.slice('__lt__'.length);
        }
        return rv === f.val;
      });
    const apply = () => {
      const matched = store.filter(rowMatches);
      if (applied) return matched;
      applied = true;
      for (const r of matched) Object.assign(r, patch);
      return matched;
    };
    upApi.eq = (col: string, val: unknown) => { upFilters.push({ col, val }); return upApi; };
    // reapStaleApprovedActions uses .lt('resolved_at', cutoff) — model it as a
    // predicate so only rows resolved before the cutoff match.
    upApi.lt = (col: string, val: unknown) => {
      upFilters.push({ col, val: `__lt__${val}` });
      return upApi;
    };
    upApi.select = () => upApi;
    upApi.maybeSingle = async () => {
      const matched = apply();
      return { data: matched[0] ?? null, error: null };
    };
    // finalize: update(...).eq('id', …) awaited directly; reap: ...select('*') awaited
    upApi.then = (resolve: (v: unknown) => unknown) => {
      const matched = apply();
      return Promise.resolve({ data: matched, error: null }).then(resolve);
    };
    return upApi;
  };
  return api;
}

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

beforeEach(() => {
  store = [];
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    if (table === 'agent_pending_actions') return pendingTableStub();
    // The confirm test runs the held tool in dryRun, so no other table is hit.
    return originalFrom(table);
  };
});
afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    user: {
      uid: 'auth-user-1', accountId: ACCT, username: 'reeyen', displayName: 'Reeyen',
      role: 'general_manager', propertyAccess: [PID], dept: 'front_desk',
    },
    propertyId: PID,
    staffId: 'staff-1',
    requestId: 'req-1',
    surface: 'voice',
    voiceMode: 'general',
    conversationId: CONV,
    voiceLang: 'en',
    // Held tool executes in dryRun so it never touches the complaints DB.
    dryRun: true,
    ...over,
  };
}

describe('confirm_pending_action', () => {
  test('claims the newest pending row, executes the held tool, finalizes executed', async () => {
    store = [makeRow()];
    const res = await executeTool('confirm_pending_action', {}, ctx());
    assert.equal(res.ok, true, res.error);
    const data = res.data as Record<string, unknown>;
    assert.equal(data.executed, true);
    assert.equal(data.toolName, 'log_complaint');
    assert.match(String(data.spoken), /^Done — /);
    // The row was claimed then finalized: status ends 'executed'.
    assert.equal(store[0].status, 'executed');
    assert.ok(store[0].resolved_at, 'resolved_at should be stamped');
  });

  test('Spanish read-back uses ES copy', async () => {
    store = [makeRow()];
    const res = await executeTool('confirm_pending_action', {}, ctx({ voiceLang: 'es' }));
    assert.equal(res.ok, true, res.error);
    assert.match(String((res.data as Record<string, unknown>).spoken), /^Listo — /);
  });

  test('no pending row → friendly no-op (does not throw)', async () => {
    store = [];
    const res = await executeTool('confirm_pending_action', {}, ctx());
    assert.equal(res.ok, true);
    assert.equal((res.data as Record<string, unknown>).nothing_pending, true);
  });

  test('a row for a DIFFERENT account is not confirmed (scope guard)', async () => {
    store = [makeRow({ account_id: 'someone-else' })];
    const res = await executeTool('confirm_pending_action', {}, ctx());
    assert.equal(res.ok, true);
    assert.equal((res.data as Record<string, unknown>).nothing_pending, true);
    assert.equal(store[0].status, 'pending', 'other account row must stay untouched');
  });

  test('a row older than the confirmation window is NOT confirmed (abandoned proposal)', async () => {
    // created 5 minutes ago — beyond the 3-min confirmation window.
    store = [makeRow({ created_at: new Date(Date.now() - 5 * 60_000).toISOString() })];
    const res = await executeTool('confirm_pending_action', {}, ctx());
    assert.equal(res.ok, true);
    assert.equal((res.data as Record<string, unknown>).nothing_pending, true);
    assert.equal(store[0].status, 'pending', 'stale row must not be executed against a later yes');
  });
});

describe('cancel_pending_action', () => {
  test('marks the newest pending row denied', async () => {
    store = [makeRow()];
    const res = await executeTool('cancel_pending_action', {}, ctx());
    assert.equal(res.ok, true, res.error);
    const data = res.data as Record<string, unknown>;
    assert.equal(data.cancelled, true);
    assert.match(String(data.spoken), /^Okay, cancelled — /);
    assert.equal(store[0].status, 'denied');
  });

  test('no pending row → friendly no-op', async () => {
    store = [];
    const res = await executeTool('cancel_pending_action', {}, ctx());
    assert.equal(res.ok, true);
    assert.equal((res.data as Record<string, unknown>).nothing_pending, true);
  });
});

describe('reapStaleApprovedActions', () => {
  test('flips a long-claimed approved row to failed (terminal)', async () => {
    store = [makeRow({
      status: 'approved',
      resolved_at: new Date(Date.now() - 5 * 60_000).toISOString(), // claimed 5m ago
    })];
    const reaped = await reapStaleApprovedActions(CONV);
    assert.equal(reaped.length, 1);
    assert.equal(store[0].status, 'failed', 'stuck approved row must become terminal');
    assert.ok(store[0].error, 'reaped row records why');
  });

  test('leaves a freshly-claimed approved row alone (within grace)', async () => {
    store = [makeRow({
      status: 'approved',
      resolved_at: new Date(Date.now() - 5_000).toISOString(), // 5s ago
    })];
    const reaped = await reapStaleApprovedActions(CONV);
    assert.equal(reaped.length, 0);
    assert.equal(store[0].status, 'approved', 'a confirm still in flight must not be reaped');
  });

  test('never touches a pending row', async () => {
    store = [makeRow({ status: 'pending' })];
    const reaped = await reapStaleApprovedActions(CONV);
    assert.equal(reaped.length, 0);
    assert.equal(store[0].status, 'pending');
  });
});
