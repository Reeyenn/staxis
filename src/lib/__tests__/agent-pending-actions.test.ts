/**
 * Lifecycle tests for the approval-gate persistence layer
 * (src/lib/agent/pending-actions.ts).
 *
 * Pins:
 *   - createPendingActions writes rows and reads them back in order
 *   - claimPendingAction is SINGLE-USE (a second claim returns null)
 *   - expireIfStale flips a past-TTL pending row to 'expired'
 *   - finalizePendingAction records the executed/failed outcome
 *   - allActionsResolved / getTurnActions grouping: a multi-action turn is
 *     only "resolved" when EVERY sibling reaches a terminal state
 *
 * Strategy: an in-memory stand-in for the agent_pending_actions table, swapped
 * onto supabaseAdmin.from for the duration — the same monkey-patch idiom other
 * tool tests use.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  createPendingActions,
  claimPendingAction,
  finalizePendingAction,
  expireIfStale,
  getTurnActions,
  allActionsResolved,
  claimTurnResume,
  releaseTurnResume,
  expiredWithoutResult,
  getPendingAction,
  sweepConversationPending,
  getLivePendingActions,
  type PendingActionRow,
} from '@/lib/agent/pending-actions';

const PID = '00000000-0000-0000-0000-0000000000a1';
const CONV = '00000000-0000-0000-0000-0000000000a2';
const ACCT = '00000000-0000-0000-0000-0000000000a3';

// ── In-memory agent_pending_actions store ──────────────────────────────────
interface Row {
  id: string; property_id: string; conversation_id: string; account_id: string;
  turn_key: string; tool_call_id: string; tool_name: string; tool_args: unknown;
  tier: string; status: string; result: unknown; error: string | null;
  resume_claimed_at: string | null;
  created_at: string; resolved_at: string | null; expires_at: string;
}
let store: Row[] = [];
let idSeq = 0;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

beforeEach(() => {
  store = [];
  idSeq = 0;
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    assert.equal(table, 'agent_pending_actions', `unexpected table ${table}`);
    return buildStub();
  };
});
afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

// A tiny query builder that supports the exact chains pending-actions.ts uses.
function buildStub() {
  let filters: Array<{ col: string; val: unknown }> = [];
  let pendingUpdate: Record<string, unknown> | null = null;
  // Rows freshly inserted by an upsert (excludes rows suppressed as duplicates
  // when ignoreDuplicates=true) — returned by a chained .select('*'), matching
  // PostgREST's real behaviour.
  let upsertedRows: Row[] | null = null;
  const api: Record<string, unknown> = {
    upsert: (rows: Row[] | Row, opts: { ignoreDuplicates?: boolean }) => {
      const list = Array.isArray(rows) ? rows : [rows];
      const inserted: Row[] = [];
      for (const r of list) {
        const dupe = store.find((s) => s.conversation_id === r.conversation_id && s.tool_call_id === r.tool_call_id);
        if (dupe) { if (!opts?.ignoreDuplicates) Object.assign(dupe, r); continue; }
        const row: Row = {
          id: `pa-${++idSeq}`,
          property_id: r.property_id, conversation_id: r.conversation_id, account_id: r.account_id,
          turn_key: r.turn_key, tool_call_id: r.tool_call_id, tool_name: r.tool_name,
          tool_args: r.tool_args ?? {}, tier: r.tier, status: r.status ?? 'pending',
          result: null, error: null, resume_claimed_at: null,
          created_at: new Date(Date.now() + idSeq).toISOString(), resolved_at: null,
          expires_at: r.expires_at ?? new Date(Date.now() + 600_000).toISOString(),
        };
        store.push(row);
        inserted.push(row);
      }
      upsertedRows = inserted;
      return api;
    },
    update: (patch: Record<string, unknown>) => { pendingUpdate = patch; return api; },
    select: () => api,
    eq: (col: string, val: unknown) => { filters.push({ col, val }); return api; },
    is: (col: string, val: unknown) => { filters.push({ col, val: { __is: val } }); return api; },
    in: (col: string, vals: unknown[]) => { filters.push({ col, val: { __in: vals } }); return api; },
    order: () => api,
    maybeSingle: async () => {
      const rows = applyUpdate();
      return { data: rows[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      // A chained upsert().select('*') resolves the freshly-inserted rows.
      if (upsertedRows !== null) {
        const rows = upsertedRows;
        upsertedRows = null;
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      }
      const rows = applyUpdate();
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };

  function match(r: Row): boolean {
    return filters.every((f) => {
      const v = (r as unknown as Record<string, unknown>)[f.col];
      if (f.val && typeof f.val === 'object' && '__in' in (f.val as object)) {
        return (f.val as { __in: unknown[] }).__in.includes(v);
      }
      if (f.val && typeof f.val === 'object' && '__is' in (f.val as object)) {
        return v === (f.val as { __is: unknown }).__is;
      }
      return v === f.val;
    });
  }
  function applyUpdate(): Row[] {
    let rows = store.filter(match);
    if (pendingUpdate) {
      rows.forEach((r) => Object.assign(r, pendingUpdate));
      // Re-filter: an UPDATE ... eq('status','pending') must only touch rows
      // that WERE pending. Our filters already captured that; the guarded
      // status change is applied above only to matched rows.
    }
    return rows;
  }
  return api;
}

async function seedThree(turnKey = 'tc-1'): Promise<PendingActionRow[]> {
  return createPendingActions({
    propertyId: PID, conversationId: CONV, accountId: ACCT, turnKey,
    actions: [
      { toolCallId: 'tc-1', toolName: 'send_message', toolArgs: { recipient: 'Maria', message: 'hi' }, tier: 'card' },
      { toolCallId: 'tc-2', toolName: 'create_todo', toolArgs: { title: 'x' }, tier: 'card' },
      { toolCallId: 'tc-3', toolName: 'mark_room_clean', toolArgs: { roomNumber: '101' }, tier: 'quick' },
    ],
  });
}

describe('pending-actions lifecycle', () => {
  test('createPendingActions persists rows in call order', async () => {
    const rows = await createPendingActions({
      propertyId: PID, conversationId: CONV, accountId: ACCT, turnKey: 'tc-1',
      actions: [
        { toolCallId: 'tc-1', toolName: 'send_message', toolArgs: { message: 'a' }, tier: 'card' },
        { toolCallId: 'tc-2', toolName: 'create_todo', toolArgs: { title: 'b' }, tier: 'card' },
      ],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].toolCallId, 'tc-1');
    assert.equal(rows[1].toolCallId, 'tc-2');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].turnKey, 'tc-1');
  });

  test('claimPendingAction is single-use', async () => {
    const [row] = await createPendingActions({
      propertyId: PID, conversationId: CONV, accountId: ACCT, turnKey: 'tc-1',
      actions: [{ toolCallId: 'tc-1', toolName: 'send_message', toolArgs: {}, tier: 'card' }],
    });
    const first = await claimPendingAction(row.id, 'approved');
    assert.ok(first, 'first claim should succeed');
    assert.equal(first!.status, 'approved');
    const second = await claimPendingAction(row.id, 'approved');
    assert.equal(second, null, 'second claim must return null (already resolved)');
  });

  test('expireIfStale expires a past-TTL pending row', async () => {
    const [row] = await createPendingActions({
      propertyId: PID, conversationId: CONV, accountId: ACCT, turnKey: 'tc-1',
      actions: [{ toolCallId: 'tc-1', toolName: 'send_message', toolArgs: {}, tier: 'card' }],
    });
    // Backdate expiry.
    const stored = store.find((r) => r.id === row.id)!;
    stored.expires_at = new Date(Date.now() - 1000).toISOString();
    const fresh = (await getPendingAction(row.id))!;
    const expired = await expireIfStale(fresh);
    assert.equal(expired, true);
    const after = (await getPendingAction(row.id))!;
    assert.equal(after.status, 'expired');
    // A row that has NOT expired stays pending.
    const [row2] = await createPendingActions({
      propertyId: PID, conversationId: CONV, accountId: ACCT, turnKey: 'tc-2',
      actions: [{ toolCallId: 'tc-9', toolName: 'send_message', toolArgs: {}, tier: 'card' }],
    });
    assert.equal(await expireIfStale((await getPendingAction(row2.id))!), false);
  });

  test('finalizePendingAction records executed + failed outcomes', async () => {
    const [row] = await createPendingActions({
      propertyId: PID, conversationId: CONV, accountId: ACCT, turnKey: 'tc-1',
      actions: [{ toolCallId: 'tc-1', toolName: 'send_message', toolArgs: {}, tier: 'card' }],
    });
    await claimPendingAction(row.id, 'approved');
    await finalizePendingAction({ id: row.id, status: 'executed', result: { messageId: 'm1' } });
    const done = (await getPendingAction(row.id))!;
    assert.equal(done.status, 'executed');
    assert.deepEqual(done.result, { messageId: 'm1' });
  });

  test('resume grouping: only resolved when ALL siblings terminal', async () => {
    const rows = await seedThree();
    // Initially all pending → not resolved.
    assert.equal(allActionsResolved(await getTurnActions(CONV, 'tc-1')), false);

    // Resolve two of three.
    await claimPendingAction(rows[0].id, 'approved');
    await finalizePendingAction({ id: rows[0].id, status: 'executed' });
    await claimPendingAction(rows[1].id, 'denied');
    await finalizePendingAction({ id: rows[1].id, status: 'failed', error: 'declined by user' });
    assert.equal(allActionsResolved(await getTurnActions(CONV, 'tc-1')), false, 'one still pending');

    // Resolve the third.
    await claimPendingAction(rows[2].id, 'approved');
    await finalizePendingAction({ id: rows[2].id, status: 'executed' });
    assert.equal(allActionsResolved(await getTurnActions(CONV, 'tc-1')), true, 'all terminal now');
  });

  test('an approved-but-not-yet-executed action blocks resume', async () => {
    const rows = await seedThree();
    await claimPendingAction(rows[0].id, 'approved'); // claimed, not finalized
    // status 'approved' is NOT terminal → resume must wait.
    assert.equal(allActionsResolved(await getTurnActions(CONV, 'tc-1')), false);
  });

  test('claimTurnResume is single-flight — only the first caller wins', async () => {
    await seedThree();
    const first = await claimTurnResume(CONV, 'tc-1');
    assert.ok(first, 'first claim should win');
    assert.equal(first!.length, 3, 'winner sees the whole turn');
    const second = await claimTurnResume(CONV, 'tc-1');
    assert.equal(second, null, 'second claim must get nothing (already claimed)');
  });

  test('expiredWithoutResult surfaces only expired siblings', async () => {
    const rows = await seedThree();
    // Expire one, execute another, leave the third pending.
    const stored = store.find((r) => r.id === rows[0].id)!;
    stored.expires_at = new Date(Date.now() - 1000).toISOString();
    await expireIfStale((await getPendingAction(rows[0].id))!);
    await claimPendingAction(rows[1].id, 'approved');
    await finalizePendingAction({ id: rows[1].id, status: 'executed' });

    const siblings = await getTurnActions(CONV, 'tc-1');
    const expired = expiredWithoutResult(siblings);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].id, rows[0].id);
    assert.equal(expired[0].status, 'expired');
  });

  test('deny finalizes as terminal "denied" (queryable, not masked as failed)', async () => {
    const [row] = await createPendingActions({
      propertyId: PID, conversationId: CONV, accountId: ACCT, turnKey: 'tc-1',
      actions: [{ toolCallId: 'tc-1', toolName: 'send_message', toolArgs: {}, tier: 'card' }],
    });
    await claimPendingAction(row.id, 'denied');
    await finalizePendingAction({ id: row.id, status: 'denied', error: 'declined by user' });
    const done = (await getPendingAction(row.id))!;
    assert.equal(done.status, 'denied');
    // 'denied' is terminal — a lone denied action counts as fully resolved.
    assert.equal(allActionsResolved([done]), true);
  });

  test('releaseTurnResume clears a resume claim so a later resolve can re-claim', async () => {
    await seedThree();
    const first = await claimTurnResume(CONV, 'tc-1');
    assert.ok(first, 'first claim wins');
    // A second claim before release gets nothing.
    assert.equal(await claimTurnResume(CONV, 'tc-1'), null);
    // Simulate a resume crash: release the claim.
    await releaseTurnResume(CONV, 'tc-1');
    // Now a later resolver can claim again.
    const retry = await claimTurnResume(CONV, 'tc-1');
    assert.ok(retry, 'claim succeeds again after release');
    assert.equal(retry!.length, 3);
  });

  test('sweepConversationPending expires only pending rows and returns them', async () => {
    const rows = await seedThree();
    // Approve one (mid-resolution) — it must NOT be swept.
    await claimPendingAction(rows[0].id, 'approved');
    const swept = await sweepConversationPending(CONV);
    const sweptIds = swept.map((r) => r.id).sort();
    assert.deepEqual(sweptIds, [rows[1].id, rows[2].id].sort(), 'only the two still-pending rows swept');
    for (const r of swept) assert.equal(r.status, 'expired');
    // The approved row is untouched.
    assert.equal((await getPendingAction(rows[0].id))!.status, 'approved');
  });

  test('getLivePendingActions returns only non-expired pending rows', async () => {
    const rows = await seedThree();
    // Backdate one past its TTL (still status='pending' in the store).
    store.find((r) => r.id === rows[0].id)!.expires_at = new Date(Date.now() - 1000).toISOString();
    // Resolve another so it's no longer pending.
    await claimPendingAction(rows[1].id, 'approved');
    await finalizePendingAction({ id: rows[1].id, status: 'executed' });
    const live = await getLivePendingActions(CONV);
    assert.deepEqual(live.map((r) => r.id), [rows[2].id], 'only the fresh pending row is live');
  });
});
