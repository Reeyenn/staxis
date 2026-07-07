/**
 * Tests for the cron-side pieces of the reminders + recurring-todo systems:
 *   fireDueReminders()        — claims a due row, delivers it, stamps fired_at.
 *   spawnDueRecurringTodos()  — spawns today's instances per cadence, idempotent.
 *
 * These run on the process-sms-jobs tick, so their correctness isn't exercised
 * by the tool tests. We monkey-patch supabaseAdmin.from with table stubs and the
 * comms core delivery is exercised through the real ensure-conversation +
 * postMessage path.
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
import { fireDueReminders } from '@/lib/reminders/store';
import { spawnDueRecurringTodos } from '@/lib/recurring-tasks/store';

const PID = '00000000-0000-0000-0000-0000000000d1';
const CREATOR = '00000000-0000-0000-0000-0000000000d2';
const TARGET = '00000000-0000-0000-0000-0000000000d3';

let reminderRows: Array<Record<string, unknown>>;
let templateRows: Array<Record<string, unknown>>;
const postedMessages: Array<Record<string, unknown>> = [];
const spawnedTasks: Array<Record<string, unknown>> = [];
const reminderUpdates: Array<Record<string, unknown>> = [];
const templateUpdates: Array<Record<string, unknown>> = [];

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

beforeEach(() => {
  reminderRows = [];
  templateRows = [];
  postedMessages.length = 0;
  spawnedTasks.length = 0;
  reminderUpdates.length = 0;
  templateUpdates.length = 0;
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => buildStub(table);
});
afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

function buildStub(table: string) {
  if (table === 'agent_reminders') {
    const api: Record<string, unknown> = {
      select: () => api, eq: () => api, lte: () => api, is: () => api, order: () => api, limit: () => api,
      // Two shapes hang off update():
      //   claim:    .update({fired_at}).eq(id).is(fired_at,null).is(canceled_at,null).select(id).maybeSingle()
      //   rollback: .update({fired_at:null}).eq(id) → awaited (thenable)
      update: (row: Record<string, unknown>) => {
        reminderUpdates.push(row);
        const eqResult: Record<string, unknown> = {
          is: () => ({
            is: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'claimed' }, error: null }) }) }),
          }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
        return { eq: () => eqResult };
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: reminderRows, error: null }).then(resolve),
    };
    return api;
  }
  if (table === 'comms_conversations') {
    return {
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'convo-1' }, error: null }) }) }) }),
      insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'convo-1' }, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    };
  }
  if (table === 'comms_members') {
    return {
      upsert: async () => ({ error: null }),
      // markConversationRead: update().eq().eq().select().maybeSingle()
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
  if (table === 'recurring_task_templates') {
    const api: Record<string, unknown> = {
      select: () => api, eq: () => api,
      update: (row: Record<string, unknown>) => { templateUpdates.push(row); return { eq: async () => ({ error: null }) }; },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: templateRows, error: null }).then(resolve),
    };
    return api;
  }
  if (table === 'comms_tasks') {
    return {
      insert: (row: Record<string, unknown>) => {
        spawnedTasks.push(row);
        return { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) };
      },
    };
  }
  throw new Error(`unexpected table in stub: ${table}`);
}

describe('fireDueReminders', () => {
  test('delivers a department reminder as a channel/announcement post and stamps fired_at', async () => {
    reminderRows = [{
      id: 'r1', property_id: PID, created_by_staff_id: CREATOR,
      target_staff_id: null, target_department: 'housekeeping',
      body: 'check the pool', fire_at: new Date(Date.now() - 60000).toISOString(),
      fired_at: null, canceled_at: null, created_at: new Date().toISOString(),
    }];
    const res = await fireDueReminders(new Date());
    assert.equal(res.due, 1);
    assert.equal(res.fired, 1);
    assert.equal(res.failed, 0);
    assert.equal(postedMessages.length, 1);
    assert.match(String(postedMessages[0].body), /check the pool/);
    // The claim + no rollback: one update carrying fired_at, none nulling it.
    assert.ok(reminderUpdates.some((u) => u.fired_at), 'fired_at was stamped on claim');
    assert.ok(!reminderUpdates.some((u) => u.fired_at === null), 'no rollback on a successful delivery');
  });

  test('delivers a person reminder as a DM from the creator', async () => {
    reminderRows = [{
      id: 'r2', property_id: PID, created_by_staff_id: CREATOR,
      target_staff_id: TARGET, target_department: null,
      body: 'gym check', fire_at: new Date(Date.now() - 60000).toISOString(),
      fired_at: null, canceled_at: null, created_at: new Date().toISOString(),
    }];
    const res = await fireDueReminders(new Date());
    assert.equal(res.fired, 1);
    assert.equal(postedMessages.length, 1);
    assert.equal(postedMessages[0].sender_staff_id, CREATOR); // AS the creator
  });
});

describe('spawnDueRecurringTodos', () => {
  test('spawns a daily template as a stamped comms_tasks row', async () => {
    templateRows = [{
      id: 't1', property_id: PID, title: 'check pool chemicals',
      assigned_staff_id: null, assigned_department: 'maintenance', priority: 'high',
      cadence: 'daily', weekday: null, active: true, last_spawned_on: null,
      created_at: new Date().toISOString(), properties: { timezone: 'America/Chicago' },
    }];
    const res = await spawnDueRecurringTodos(new Date());
    assert.equal(res.spawned, 1);
    assert.equal(spawnedTasks.length, 1);
    assert.equal(spawnedTasks[0].title, 'check pool chemicals');
    assert.equal(spawnedTasks[0].recurring_template_id, 't1');
    assert.ok(spawnedTasks[0].recurring_instance_date, 'stamped with the instance date');
    // Bookkeeping advanced so the every-5-min cron won't re-spawn today.
    assert.ok(templateUpdates.some((u) => u.last_spawned_on), 'last_spawned_on advanced');
  });

  test('is idempotent within a day (already spawned today → skipped)', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    templateRows = [{
      id: 't1', property_id: PID, title: 'x',
      assigned_staff_id: null, assigned_department: null, priority: 'normal',
      cadence: 'daily', weekday: null, active: true, last_spawned_on: today,
      created_at: new Date().toISOString(), properties: { timezone: 'America/Chicago' },
    }];
    const res = await spawnDueRecurringTodos(new Date());
    assert.equal(res.spawned, 0);
    assert.equal(res.skipped, 1);
    assert.equal(spawnedTasks.length, 0);
  });

  test('a weekly template only spawns on its weekday', async () => {
    // Pick a fixed date: 2026-07-06 is a Monday (weekday 1). Use noon UTC-ish.
    const monday = new Date('2026-07-06T18:00:00Z'); // afternoon CST → still Mon local
    templateRows = [
      { id: 'mon', property_id: PID, title: 'monday task', assigned_staff_id: null, assigned_department: null, priority: 'normal', cadence: 'weekly', weekday: 1, active: true, last_spawned_on: null, created_at: '2026-07-01T00:00:00Z', properties: { timezone: 'America/Chicago' } },
      { id: 'fri', property_id: PID, title: 'friday task', assigned_staff_id: null, assigned_department: null, priority: 'normal', cadence: 'weekly', weekday: 5, active: true, last_spawned_on: null, created_at: '2026-07-01T00:00:00Z', properties: { timezone: 'America/Chicago' } },
    ];
    const res = await spawnDueRecurringTodos(monday);
    assert.equal(res.spawned, 1, 'only the Monday template spawns on a Monday');
    assert.equal(spawnedTasks.length, 1);
    assert.equal(spawnedTasks[0].title, 'monday task');
  });
});
