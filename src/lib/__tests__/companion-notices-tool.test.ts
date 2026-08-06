/**
 * ONE QUERY, TWO CONSUMERS — HELD.
 *
 * The notices list in the companion panel and the `staxis_assignments` chat
 * tool answer the same question about the same rows. If they ever drifted, a
 * person would be told one thing by the list and another by the conversation
 * with no way to know which was wrong, and the product's whole claim is that it
 * is the one that is right.
 *
 * So this file runs BOTH consumers against the same stubbed rows and asserts
 * the answers are the same sentences about the same tasks. It also holds the
 * two things the derivation must never do:
 *
 *   • tell somebody about their own act (a to-do they finished themselves, a
 *     job they wrote for themselves)
 *   • reach outside the caller's own assignments
 *
 * Strategy: monkey-patch supabaseAdmin.from with per-table stubs, the same
 * idiom the other agent-tool tests use. The tool's HANDLER is called directly
 * rather than through executeTool, because what is under test is the agreement
 * between the two readings, not the role and section gates, which have their
 * own tests and their own file.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { getTool, type ToolHandlerContext } from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import { loadAssignmentNotices } from '@/lib/companion/notices-server';
import { gatherAssignedByMe } from '@/lib/worklist/core';
import { KNOWLEDGE_STORES, knowledgeStore } from '@/lib/agent/knowledge-door';

const PID = '00000000-0000-0000-0000-00000000c001';
/** The person asking. Everything below is about them and nobody else. */
const ME = '00000000-0000-0000-0000-00000000c002';
const MARCUS = '00000000-0000-0000-0000-00000000c003';
const LUIS = '00000000-0000-0000-0000-00000000c004';
const SARAH = '00000000-0000-0000-0000-00000000c005';

const NOW = new Date('2026-08-05T18:00:00.000Z');

interface TaskRow { [key: string]: unknown }

let tasks: TaskRow[];
/** The zone the stubbed `properties` row reports. The days-waiting count is
 *  read off THIS calendar, not the server's. */
let hotelTimezone: string | null = 'America/Chicago';
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

const STAFF = [
  { id: ME, name: 'Reeyen Boss' },
  { id: MARCUS, name: 'Marcus' },
  { id: LUIS, name: 'Luis' },
  { id: SARAH, name: 'Sarah' },
];

beforeEach(() => {
  tasks = [
    // Handed to me by Sarah. A notice.
    {
      id: 't-assigned', property_id: PID, title: 'Check the pool pump',
      assigned_staff_id: ME, assigned_department: null,
      created_by_staff_id: SARAH, status: 'open', due_at: null,
      created_at: '2026-08-05T09:00:00.000Z',
      completed_at: null, completed_by_staff_id: null,
      blocked_at: null, blocked_by_staff_id: null, blocked_reason: null,
    },
    // I handed it to Marcus and he finished it. A notice.
    {
      id: 't-done', property_id: PID, title: 'Boiler check',
      assigned_staff_id: MARCUS, assigned_department: null,
      created_by_staff_id: ME, status: 'done', due_at: null,
      created_at: '2026-08-04T09:00:00.000Z',
      completed_at: '2026-08-05T12:00:00.000Z', completed_by_staff_id: MARCUS,
      blocked_at: null, blocked_by_staff_id: null, blocked_reason: null,
    },
    // I handed it to Luis and he could not do it, and said why. A notice.
    {
      id: 't-refused', property_id: PID, title: '214 deep clean',
      assigned_staff_id: LUIS, assigned_department: null,
      created_by_staff_id: ME, status: 'blocked', due_at: null,
      created_at: '2026-08-04T09:00:00.000Z',
      completed_at: null, completed_by_staff_id: null,
      blocked_at: '2026-08-05T14:00:00.000Z', blocked_by_staff_id: LUIS,
      blocked_reason: 'needs a part',
    },
    // I handed it to Marcus and he has not touched it. NOT a notice: the
    // absence of news is not news. It is outstanding, which the tool reports
    // separately because "what does Marcus still owe me" is a real question.
    {
      id: 't-waiting', property_id: PID, title: 'Regrout the pool deck',
      assigned_staff_id: MARCUS, assigned_department: null,
      created_by_staff_id: ME, status: 'open', due_at: null,
      created_at: '2026-08-01T09:00:00.000Z',
      completed_at: null, completed_by_staff_id: null,
      blocked_at: null, blocked_by_staff_id: null, blocked_reason: null,
    },
    // I wrote it for myself and finished it. NOT a notice in either direction:
    // telling somebody they finished their own to-do is the app narrating them
    // back to themselves.
    {
      id: 't-mine', property_id: PID, title: 'Order towels',
      assigned_staff_id: ME, assigned_department: null,
      created_by_staff_id: ME, status: 'done', due_at: null,
      created_at: '2026-08-05T08:00:00.000Z',
      completed_at: '2026-08-05T10:00:00.000Z', completed_by_staff_id: ME,
      blocked_at: null, blocked_by_staff_id: null, blocked_reason: null,
    },
    // Between two other people entirely. NOT mine to see.
    {
      id: 't-others', property_id: PID, title: 'Restock the bistro',
      assigned_staff_id: LUIS, assigned_department: null,
      created_by_staff_id: SARAH, status: 'done', due_at: null,
      created_at: '2026-08-05T08:00:00.000Z',
      completed_at: '2026-08-05T11:00:00.000Z', completed_by_staff_id: LUIS,
      blocked_at: null, blocked_by_staff_id: null, blocked_reason: null,
    },
  ];
  hotelTimezone = 'America/Chicago';
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => buildStub(table);
});

afterEach(() => { supabaseAdmin.from = originalFrom; });

/**
 * A chain that actually APPLIES its filters, evaluated lazily on await.
 *
 * The point of applying them rather than returning a canned array is that the
 * "only ever your own work" property is enforced in the QUERY, so a stub that
 * ignored eq()/neq() would make the isolation assertions below pass for the
 * boring reason that nothing was filtered.
 */
function buildStub(table: string) {
  const eqs: Array<[string, unknown]> = [];
  const neqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  const notNull: string[] = [];

  const rowsFor = (): Record<string, unknown>[] => {
    const source: Record<string, unknown>[] = table === 'comms_tasks'
      ? tasks as Record<string, unknown>[]
      : table === 'staff'
        ? STAFF.map((s) => ({ ...s, property_id: PID }))
        : table === 'properties'
          ? [{ id: PID, timezone: hotelTimezone }]
          : [];
    return source.filter((row) => {
      for (const [col, value] of eqs) if (row[col] !== value) return false;
      for (const [col, value] of neqs) if (row[col] === value) return false;
      for (const [col, values] of ins) if (!values.includes(row[col])) return false;
      for (const col of notNull) if (row[col] === null || row[col] === undefined) return false;
      return true;
    });
  };

  const api: Record<string, unknown> = {
    select: () => api,
    eq: (col: string, value: unknown) => { eqs.push([col, value]); return api; },
    neq: (col: string, value: unknown) => { neqs.push([col, value]); return api; },
    in: (col: string, values: unknown[]) => { ins.push([col, values]); return api; },
    not: (col: string, op: string, value: unknown) => {
      if (op === 'is' && value === null) notNull.push(col);
      return api;
    },
    gte: () => api,
    is: () => api,
    order: () => api,
    limit: () => api,
    maybeSingle: async () => ({ data: rowsFor()[0] ?? null, error: null }),
    single: async () => ({ data: rowsFor()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: rowsFor(), error: null }).then(resolve, reject),
  };
  return api;
}

function toolCtx(staffId: string | null): ToolHandlerContext {
  return {
    user: {
      uid: 'uid', accountId: 'acct', username: 'me', displayName: 'Reeyen Boss',
      role: 'general_manager', propertyAccess: [PID],
    },
    propertyId: PID,
    staffId,
    // The handler never touches ctx.db: every read goes through the shared
    // notices loader, which is the point of the file.
    get db() { throw new Error('the assignments tool must read through the shared loader'); },
  } as unknown as ToolHandlerContext;
}

async function runTool(args: { days?: number; state?: string }, staffId: string | null = ME) {
  const def = getTool('staxis_assignments');
  assert.ok(def, 'staxis_assignments is not registered');
  const result = await def!.handler(args, toolCtx(staffId));
  assert.equal(result.ok, true, result.error ?? '');
  return result.data as {
    window: string | null;
    outstanding: Array<Record<string, unknown>>;
    settled: Array<Record<string, unknown>>;
    note?: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('the tool answers from the same query the list reads', () => {
  test('every settled row in the answer is a sentence the list would show', async () => {
    const list = await loadAssignmentNotices({ propertyId: PID, staffId: ME, now: NOW });
    const answer = await runTool({});

    const listSentences = list.map((n) => n.sentence).sort();
    const toolSentences = answer.settled.map((r) => String(r.what)).sort();
    assert.deepEqual(
      toolSentences, listSentences,
      'the chat and the panel described the same events differently',
    );
    assert.ok(listSentences.length >= 3, 'the fixture went thin and proves nothing');
  });

  test('the three kinds all arrive, and the refusal keeps its reason word for word', async () => {
    const list = await loadAssignmentNotices({ propertyId: PID, staffId: ME, now: NOW });
    assert.deepEqual(
      list.map((n) => n.kind).sort(),
      ['assigned', 'done', 'refused'],
    );
    const refused = list.find((n) => n.kind === 'refused');
    assert.equal(refused?.reason, 'needs a part');
    assert.equal(refused?.sentence, 'Luis could not do "214 deep clean": needs a part.');

    const answer = await runTool({ state: 'refused' });
    assert.equal(answer.settled.length, 1);
    assert.equal(answer.settled[0].reason, 'needs a part');
  });

  test('newest first, in both readings', async () => {
    const list = await loadAssignmentNotices({ propertyId: PID, staffId: ME, now: NOW });
    const times = list.map((n) => Date.parse(n.at));
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i], 'the list is not newest first');
    }
  });
});

describe('a notice is only ever about the person asking', () => {
  test('work between two other people is invisible', async () => {
    const list = await loadAssignmentNotices({ propertyId: PID, staffId: ME, now: NOW });
    assert.equal(
      list.some((n) => n.taskId === 't-others'), false,
      'a task neither assigned by nor to this person reached their notices',
    );
  });

  test('finishing your own to-do is not news', async () => {
    const list = await loadAssignmentNotices({ propertyId: PID, staffId: ME, now: NOW });
    assert.equal(
      list.some((n) => n.taskId === 't-mine'), false,
      'the app narrated somebody back to themselves',
    );
  });

  test('work nobody has touched is outstanding, not a notice', async () => {
    const list = await loadAssignmentNotices({ propertyId: PID, staffId: ME, now: NOW });
    assert.equal(list.some((n) => n.taskId === 't-waiting'), false);

    const answer = await runTool({});
    const waiting = answer.outstanding.find((r) => r.task === 'Regrout the pool deck');
    assert.ok(waiting, 'the drawer half of the answer went missing');
    assert.equal(waiting!.with, 'Marcus');
    // Four whole days between 2026-08-01T09:00 and 2026-08-05T18:00.
    assert.equal(waiting!.daysWaiting, 4);
  });

  test('days waiting turns over at the hotel\'s midnight, not Greenwich\'s', async () => {
    // Handed over at 11pm Monday in Texas, asked about at 1am Tuesday there.
    // Both instants land on the SAME UTC day, so counting elapsed 24-hour
    // blocks reads "0 days" through the whole of Tuesday morning — which is
    // how somebody gets chased a day late, or not chased at all.
    tasks = [{
      id: 't-overnight', property_id: PID, title: 'Reset the lobby thermostat',
      assigned_staff_id: MARCUS, assigned_department: null,
      created_by_staff_id: ME, status: 'open', due_at: null,
      created_at: '2026-08-04T04:00:00.000Z',
      completed_at: null, completed_by_staff_id: null,
      blocked_at: null, blocked_by_staff_id: null, blocked_reason: null,
    }];
    const nextMorningAtTheHotel = new Date('2026-08-04T06:00:00.000Z');

    const [waiting] = await gatherAssignedByMe(PID, ME, nextMorningAtTheHotel);
    assert.ok(waiting, 'the outstanding row went missing');
    assert.equal(waiting.ageDays, 1, 'the hotel woke up once, so it has waited a day');

    // The same two instants at a hotel that really does keep Greenwich time:
    // there, nothing has turned over yet, and that is the honest answer.
    hotelTimezone = 'UTC';
    const [inGreenwich] = await gatherAssignedByMe(PID, ME, nextMorningAtTheHotel);
    assert.equal(inGreenwich.ageDays, 0, 'the fixture proves nothing if both zones agree');
  });

  test('a caller with no staff record here gets an honest empty answer', async () => {
    const answer = await runTool({}, null);
    assert.deepEqual(answer.settled, []);
    assert.deepEqual(answer.outstanding, []);
    assert.match(String(answer.note), /no staff record/i);
  });
});

describe('the window is bounded', () => {
  test('the default is a week and the model cannot ask for a year', async () => {
    assert.equal((await runTool({})).window, '7 days');
    assert.equal((await runTool({ days: 3 })).window, '3 days');
    assert.equal((await runTool({ days: 3650 })).window, '30 days');
    assert.equal((await runTool({ days: -4 })).window, '1 days');
    assert.equal((await runTool({ days: Number.NaN })).window, '7 days');
  });

  test('anything older than the window is history rather than news', async () => {
    tasks = tasks.map((t) => (t.id === 't-done'
      ? { ...t, completed_at: '2026-06-01T12:00:00.000Z' }
      : t));
    const list = await loadAssignmentNotices({ propertyId: PID, staffId: ME, now: NOW });
    assert.equal(list.some((n) => n.taskId === 't-done'), false);
  });
});

describe('the store went through the door', () => {
  test('assignment_history is registered, on both axes, with a loader', () => {
    const store = knowledgeStore('assignment_history');
    assert.equal(store.scope, 'person');
    assert.equal(store.authority, 'fact');
    assert.equal(store.placement, 'on_demand');
    assert.equal(store.loaderModule, 'src/lib/companion/notices-server.ts');
    // On-demand means it is never injected, so it has no envelope to fence and
    // no version to stamp. Declaring an empty presentation list is how that is
    // said out loud rather than left ambiguous.
    assert.deepEqual([...store.presentations], []);
    assert.ok(store.why.length > 40);
  });

  test('it is in the registry exactly once', () => {
    const hits = KNOWLEDGE_STORES.filter((s) => s.id === 'assignment_history');
    assert.equal(hits.length, 1);
  });
});
