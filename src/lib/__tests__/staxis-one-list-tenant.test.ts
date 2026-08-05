/**
 * THE TENANT WALL ON THE ONE LIST'S READS AND WRITES.
 *
 * Every route here goes through `commsContext`, which proves a session and
 * `userHasPropertyAccess(pid)` before a handler runs — that boundary is tested
 * where it lives. What is NOT covered by it, and is what this file exists for,
 * is the second half of the same rule:
 *
 *   a query scoped ONLY by id is a cross-tenant read waiting to happen.
 *
 * A caller with a legitimate session at Hotel A, passing Hotel A's pid, holding
 * a row id belonging to Hotel B, must get nothing and must change nothing. The
 * plausible bug is not malice and not a missing session check; it is a
 * `.eq('id', x)` that nobody paired with `.eq('property_id', pid)`, which works
 * perfectly for one hotel and leaks the moment there are two.
 *
 * Driven against a recording stub of supabaseAdmin, so what is asserted is the
 * FILTERS the code actually sent, not a comment claiming it sends them.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { gatherAssignedByMe, listAssignees } from '@/lib/worklist/core';
import { readFeedPrefs, writeFeedPrefs } from '@/lib/feed/prefs';

const HOTEL_A = '11111111-1111-1111-1111-111111111111';
const HOTEL_B = '22222222-2222-2222-2222-222222222222';
const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ACCOUNT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface Recorded {
  table: string;
  filters: Array<[string, string, unknown]>;
  payload?: Record<string, unknown>;
}

let calls: Recorded[] = [];
/** table → the rows the stub will hand back, AFTER the recorded filters run. */
let tables: Record<string, Array<Record<string, unknown>>> = {};

/** A chainable stub that records every filter and then applies eq/neq itself. */
function makeQuery(table: string, payload?: Record<string, unknown>) {
  const record: Recorded = { table, filters: [], payload };
  calls.push(record);

  const rows = () => {
    let out = tables[table] ?? [];
    for (const [op, column, value] of record.filters) {
      if (op === 'eq') out = out.filter((r) => r[column] === value);
      if (op === 'neq') out = out.filter((r) => r[column] !== value);
      if (op === 'is' && value === null) out = out.filter((r) => r[column] == null);
      if (op === 'not') out = out.filter((r) => r[column] != null);
    }
    return out;
  };

  const chain: Record<string, unknown> = {
    then: undefined,
    select: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows(), error: null }),
    eq: (column: string, value: unknown) => { record.filters.push(['eq', column, value]); return chain; },
    neq: (column: string, value: unknown) => { record.filters.push(['neq', column, value]); return chain; },
    is: (column: string, value: unknown) => { record.filters.push(['is', column, value]); return chain; },
    not: (column: string, _op: string, _value: unknown) => { record.filters.push(['not', column, null]); return chain; },
    in: () => chain,
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
  };
  return chain;
}

beforeEach(() => {
  calls = [];
  tables = {};
  (supabaseAdmin as unknown as { from: unknown }).from = (table: string) => {
    const q = makeQuery(table);
    return {
      ...q,
      upsert: (payload: Record<string, unknown>) => {
        calls.push({ table, filters: [], payload });
        return Promise.resolve({ data: null, error: null });
      },
    };
  };
});

/** Was every read of this table scoped to the hotel that was asked for? */
function scopedTo(table: string, pid: string): boolean {
  const forTable = calls.filter((c) => c.table === table && c.filters.length > 0);
  if (forTable.length === 0) return false;
  return forTable.every((c) => c.filters.some(([op, col, val]) => op === 'eq' && col === 'property_id' && val === pid));
}

describe('the assigned-by-me drawer cannot see another hotel', () => {
  test('the query is scoped by property AND by the assigner', async () => {
    tables.comms_tasks = [];
    tables.staff = [];
    await gatherAssignedByMe(HOTEL_A, ME);
    assert.ok(scopedTo('comms_tasks', HOTEL_A), 'every comms_tasks read must name the hotel');
    const tasks = calls.find((c) => c.table === 'comms_tasks')!;
    assert.ok(
      tasks.filters.some(([op, col, val]) => op === 'eq' && col === 'created_by_staff_id' && val === ME),
      'a drawer is one person’s, not the hotel’s',
    );
  });

  test('another hotel’s task is not returned even when everything else matches', async () => {
    // Same assigner id, same shape, different hotel. A query missing the
    // property filter returns this row and the leak is invisible.
    tables.comms_tasks = [
      { id: 'mine', property_id: HOTEL_A, title: 'ours', assigned_staff_id: 'x', created_by_staff_id: ME, status: 'open', created_at: '2026-07-29T00:00:00.000Z' },
      { id: 'theirs', property_id: HOTEL_B, title: 'not ours', assigned_staff_id: 'x', created_by_staff_id: ME, status: 'open', created_at: '2026-07-29T00:00:00.000Z' },
    ];
    tables.staff = [];
    const out = await gatherAssignedByMe(HOTEL_A, ME);
    assert.deepEqual(out.map((r) => r.taskId), ['mine']);
  });

  test('a task you assigned to YOURSELF is not in the drawer', async () => {
    // It is on your own list. Showing it in both places would double-count
    // every to-do a manager writes for themselves.
    tables.comms_tasks = [
      { id: 'self', property_id: HOTEL_A, title: 'x', assigned_staff_id: ME, created_by_staff_id: ME, status: 'open', created_at: '2026-07-29T00:00:00.000Z' },
    ];
    tables.staff = [];
    assert.deepEqual((await gatherAssignedByMe(HOTEL_A, ME)).map((r) => r.taskId), []);
  });
});

describe('who a to-do can be handed to', () => {
  test('the roster is scoped to the hotel', async () => {
    tables.staff = [
      { id: 's1', property_id: HOTEL_A, name: 'Ana', department: 'front_desk', is_active: true },
      { id: 's2', property_id: HOTEL_B, name: 'Someone Else', department: 'front_desk', is_active: true },
    ];
    const out = await listAssignees(HOTEL_A);
    assert.deepEqual(out.map((p) => p.name), ['Ana']);
    assert.ok(scopedTo('staff', HOTEL_A));
  });

  test('housekeepers are excluded at the SERVER, not only in the dropdown', async () => {
    // The founder's standing rule: nothing may add a step to a housekeeper's
    // job. A to-do handed to one would sit on a page they never open, so the
    // option must not exist however the list is reached.
    tables.staff = [
      { id: 's1', property_id: HOTEL_A, name: 'Ana', department: 'front_desk', is_active: true },
      { id: 's2', property_id: HOTEL_A, name: 'Rosa', department: 'housekeeping', is_active: true },
    ];
    assert.deepEqual((await listAssignees(HOTEL_A)).map((p) => p.name), ['Ana']);
  });

  test('inactive staff are not offered work', async () => {
    tables.staff = [
      { id: 's1', property_id: HOTEL_A, name: 'Ana', department: 'front_desk', is_active: true },
      { id: 's3', property_id: HOTEL_A, name: 'Gone', department: 'front_desk', is_active: false },
    ];
    assert.deepEqual((await listAssignees(HOTEL_A)).map((p) => p.name), ['Ana']);
  });
});

describe('one person’s list preferences', () => {
  test('a preference is read for one person at one hotel', async () => {
    tables.staxis_user_prefs = [
      { account_id: ACCOUNT, property_id: HOTEL_A, logbook_in_list: true, assigned_seen_at: '2026-07-30T08:00:00.000Z' },
      { account_id: ACCOUNT, property_id: HOTEL_B, logbook_in_list: false, assigned_seen_at: null },
    ];
    assert.deepEqual(
      await readFeedPrefs(ACCOUNT, HOTEL_A),
      { logbookInList: true, assignedSeenAt: '2026-07-30T08:00:00.000Z', listSeenAt: null, companionMemory: null },
    );
    assert.deepEqual(
      await readFeedPrefs(ACCOUNT, HOTEL_B),
      { logbookInList: false, assignedSeenAt: null, listSeenAt: null, companionMemory: null },
    );
  });

  test('no stored row is the default, not an error and not "on"', async () => {
    // The log book is a place you go. A hotel that never opened the switch must
    // not find its shift notes interleaved with its money.
    tables.staxis_user_prefs = [];
    assert.deepEqual(await readFeedPrefs(ACCOUNT, HOTEL_A), { logbookInList: false, assignedSeenAt: null, listSeenAt: null, companionMemory: null });
  });

  test('a write always carries both keys', async () => {
    tables.staxis_user_prefs = [];
    await writeFeedPrefs(ACCOUNT, HOTEL_A, { logbookInList: true });
    const write = calls.find((c) => c.table === 'staxis_user_prefs' && c.payload);
    assert.ok(write, 'expected an upsert');
    assert.equal(write.payload!.account_id, ACCOUNT);
    assert.equal(write.payload!.property_id, HOTEL_A);
    assert.equal(write.payload!.logbook_in_list, true);
  });

  test('a companion memory write does not clobber the list preferences', async () => {
    // The companion shares this row (0417). A write of its memory that dropped
    // the other two columns would switch somebody's log book off as a side
    // effect of being greeted, which is the exact failure the degraded-read
    // guard in writeFeedPrefs exists to prevent.
    tables.staxis_user_prefs = [{
      account_id: ACCOUNT, property_id: HOTEL_A,
      logbook_in_list: true, assigned_seen_at: '2026-07-30T08:00:00.000Z', companion_memory: {},
    }];
    await writeFeedPrefs(ACCOUNT, HOTEL_A, { companionMemory: { welcomedAt: '2026-08-01T00:00:00.000Z' } });
    const write = calls.find((c) => c.table === 'staxis_user_prefs' && c.payload);
    assert.equal(write!.payload!.logbook_in_list, true, 'the switch survived');
    assert.equal(write!.payload!.assigned_seen_at, '2026-07-30T08:00:00.000Z', 'the stamp survived');
    assert.deepEqual(write!.payload!.companion_memory, { welcomedAt: '2026-08-01T00:00:00.000Z' });
  });

  test('a partial write does not clobber the other field', () => {
    // writeFeedPrefs reads-then-merges, so stamping the drawer as seen must not
    // silently turn somebody's log book switch back off.
    tables.staxis_user_prefs = [{ account_id: ACCOUNT, property_id: HOTEL_A, logbook_in_list: true, assigned_seen_at: null }];
    return writeFeedPrefs(ACCOUNT, HOTEL_A, { assignedSeenAt: '2026-07-30T12:00:00.000Z' }).then(() => {
      const write = calls.find((c) => c.table === 'staxis_user_prefs' && c.payload);
      assert.equal(write!.payload!.logbook_in_list, true, 'the switch survived');
      assert.equal(write!.payload!.assigned_seen_at, '2026-07-30T12:00:00.000Z');
    });
  });
});
