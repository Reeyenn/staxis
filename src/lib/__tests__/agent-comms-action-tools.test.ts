/**
 * Tests for the 4 new comms action tools (src/lib/agent/tools/comms-actions.ts):
 * send_message, create_todo, add_logbook_entry, post_announcement.
 *
 * Pins the behaviours that matter for the approval flow:
 *   - send_message posts AS THE CALLER (senderStaffId = caller), resolves a
 *     recipient by name, and returns the candidate list on ambiguity.
 *   - send_message refuses when the caller has no staff identity.
 *   - create_todo / add_logbook_entry write through the comms store as the caller.
 *   - post_announcement is role-gated (a housekeeper is refused by executeTool).
 *
 * Strategy: monkey-patch supabaseAdmin.from with per-table stubs, matching the
 * idiom used by voice-issue-tool.test.ts.
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

const PID = '00000000-0000-0000-0000-0000000000b1';
const CALLER_STAFF = '00000000-0000-0000-0000-0000000000b2';
const ACCT = '00000000-0000-0000-0000-0000000000b3';
const MARIA = '00000000-0000-0000-0000-0000000000b4';
const MARIO = '00000000-0000-0000-0000-0000000000b5';

let staffRows: Array<{ id: string; name: string; department: string | null; is_active: boolean }>;
const postedMessages: Array<Record<string, unknown>> = [];
const createdTasks: Array<Record<string, unknown>> = [];
const createdLogs: Array<Record<string, unknown>> = [];

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

beforeEach(() => {
  staffRows = [
    { id: MARIA, name: 'Maria Garcia', department: 'housekeeping', is_active: true },
    { id: CALLER_STAFF, name: 'Reeyen Boss', department: 'front_desk', is_active: true },
  ];
  postedMessages.length = 0;
  createdTasks.length = 0;
  createdLogs.length = 0;
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => buildStub(table);
});
afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

function chain(rows: Record<string, unknown>[]) {
  const res = { data: rows, error: null };
  const single = { data: rows[0] ?? null, error: null };
  const api: Record<string, unknown> = {
    select: () => api, eq: () => api, neq: () => api, is: () => api, in: () => api,
    ilike: () => api, order: () => api, limit: () => api,
    maybeSingle: async () => single, single: async () => single,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(res).then(resolve, reject),
  };
  return api;
}

function buildStub(table: string) {
  if (table === 'staff') {
    // resolveRecipient reads active staff for this property. The .eq('id',…)
    // direct-lookup path also lands here; return the full set and let the tool
    // filter (our chain ignores eq predicates, which is fine for these cases).
    return chain(staffRows.filter((s) => s.is_active));
  }
  if (table === 'comms_conversations') {
    return {
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'dm-convo' }, error: null }) }) }) }),
      insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'dm-convo' }, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  }
  if (table === 'comms_members') {
    return {
      upsert: async () => ({ error: null }),
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'm1' }, error: null }) }) }) }),
      update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'm1' }, error: null }) }) }) }) }),
    };
  }
  if (table === 'comms_messages') {
    return {
      insert: (row: Record<string, unknown>) => ({
        select: () => ({ single: async () => { postedMessages.push(row); return { data: { id: 'msg-1', created_at: new Date().toISOString() }, error: null }; } }),
      }),
    };
  }
  if (table === 'comms_tasks') {
    return {
      insert: (row: Record<string, unknown>) => ({
        select: () => ({ single: async () => { createdTasks.push(row); return { data: { id: 'task-1' }, error: null }; } }),
      }),
    };
  }
  if (table === 'comms_log_entries') {
    return {
      insert: (row: Record<string, unknown>) => ({
        select: () => ({ single: async () => { createdLogs.push(row); return { data: { id: 'log-1' }, error: null }; } }),
      }),
    };
  }
  throw new Error(`unexpected table in stub: ${table}`);
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

describe('send_message', () => {
  test('posts as the caller and resolves recipient by name', async () => {
    const res = await executeTool('send_message', { recipient: 'Maria', message: 'lobby needs a mop' }, ctx());
    assert.equal(res.ok, true);
    assert.equal((res.data as { recipient: string }).recipient, 'Maria Garcia');
    assert.equal(postedMessages.length, 1);
    // FROM the caller — not from Staxis.
    assert.equal(postedMessages[0].sender_staff_id, CALLER_STAFF);
    assert.equal(postedMessages[0].sender_kind, 'staff');
    assert.equal(postedMessages[0].body, 'lobby needs a mop');
  });

  test('returns the candidate list on an ambiguous name', async () => {
    staffRows.push({ id: MARIO, name: 'Mario Reyes', department: 'maintenance', is_active: true });
    const res = await executeTool('send_message', { recipient: 'Mar', message: 'hi' }, ctx());
    assert.equal(res.ok, false);
    const data = res.data as { ambiguous?: boolean; candidates?: { name: string }[] };
    assert.equal(data.ambiguous, true);
    const names = (data.candidates ?? []).map((c) => c.name).sort();
    assert.deepEqual(names, ['Maria Garcia', 'Mario Reyes']);
    assert.equal(postedMessages.length, 0, 'no message sent on ambiguity');
  });

  test('refuses when the caller has no staff identity', async () => {
    const res = await executeTool('send_message', { recipient: 'Maria', message: 'hi' }, ctx({ staffId: null }));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /staff/i);
    assert.equal(postedMessages.length, 0);
  });

  test('refuses messaging yourself', async () => {
    const res = await executeTool('send_message', { recipient: 'Reeyen', message: 'note to self' }, ctx());
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /yourself/i);
  });
});

describe('create_todo + add_logbook_entry', () => {
  test('create_todo writes a task created by the caller', async () => {
    const res = await executeTool('create_todo', { title: 'restock linen closet', priority: 'high' }, ctx());
    assert.equal(res.ok, true);
    assert.equal(createdTasks.length, 1);
    assert.equal(createdTasks[0].title, 'restock linen closet');
    assert.equal(createdTasks[0].priority, 'high');
    assert.equal(createdTasks[0].created_by_staff_id, CALLER_STAFF);
  });

  test('create_todo assigns to a resolved staff member', async () => {
    const res = await executeTool('create_todo', { title: 'check pool', assignee: 'Maria' }, ctx());
    assert.equal(res.ok, true);
    assert.equal(createdTasks[0].assigned_staff_id, MARIA);
  });

  test('add_logbook_entry writes an entry as the caller', async () => {
    const res = await executeTool('add_logbook_entry', { title: 'elevator 2 down 2-4pm', category: 'maintenance' }, ctx());
    assert.equal(res.ok, true);
    assert.equal(createdLogs.length, 1);
    assert.equal(createdLogs[0].author_staff_id, CALLER_STAFF);
    assert.equal(createdLogs[0].category, 'maintenance');
  });
});

describe('post_announcement role gate', () => {
  test('a housekeeper is refused before the handler runs', async () => {
    const res = await executeTool(
      'post_announcement',
      { message: 'pool closed' },
      ctx({ user: { ...ctx().user, role: 'housekeeping' } }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /role|allowed/i);
  });
});
