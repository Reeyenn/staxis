/**
 * ONE BRAIN — the @Staxis thread assistant, after the fold.
 *
 * Until 2026-08-06 `src/lib/comms/assistant.ts` was a second brain: its own
 * system prompt, its own five-tool catalog declared outside the registry, its
 * own six-iteration Anthropic loop, and `create_work_order` / `create_complaint`
 * writing to the hotel INLINE the moment the model called them. The companion's
 * charter opens with "NEVER ACTS WITHOUT A YES"; that loop was where it didn't.
 *
 * The old test file over it (`comms-assistant-knowledge.test.ts`) asserted
 * things about that private catalog and that private prompt — both of which are
 * gone, so it went with them. These are the properties that replace it, and
 * every one of them is about BEHAVIOUR: what the model is offered, what it may
 * reach, and what happens when it proposes a write.
 *
 *   1. THE THREAD ANSWERS THROUGH THE MAIN PIPELINE. A turn runs through
 *      `streamAgent` with a prompt from `buildSystemPrompt` and a catalog from
 *      the one registry.
 *   2. ITS WRITES PRODUCE APPROVAL CARDS. A proposed work order is HELD and
 *      yielded as a pending approval; the handler never runs, so nothing is
 *      written before somebody says yes.
 *   3. ITS REACH DID NOT WIDEN. The catalog is exactly the five capabilities the
 *      private one had, for every hat, and the executor refuses anything else on
 *      this surface even if a tool list leaked or the model invented a name.
 *   4. ITS REACH DID NOT NARROW EITHER. Every hat that could ask before can ask
 *      now, housekeeping included, and can still get all five.
 *
 * Run: npx tsx --conditions=react-server --test src/lib/__tests__/comms-assistant-one-brain.test.ts
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder-test-key-min-20-chars';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type { AppRole } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { createFakeModel } from '@/lib/agent/evals/fake-model';
import {
  agentFeatureKeyForOrigin,
  agentOriginFromRequest,
  partitionGatedCalls,
  streamAgent,
  type AgentEvent,
} from '@/lib/agent/llm';
import {
  approvalSurfaceForTool,
  executeTool,
  getToolsForRole,
  SURFACE_SECTION,
  type ToolContext,
} from '@/lib/agent/tools';
import { MESSAGES_LENS_TOOLS, lensFor, moneyVisibleToRole, surfaceIsMountedForRole } from '@/lib/agent/lenses';
import { buildActionSummary } from '@/lib/agent/approval';
import { DECISION_CORPUS_SURFACES, decisionCorpusSurfaceOf, recordDecisionProposal } from '@/lib/agent/decisions';
import { AGENT_JOURNAL_SOURCE, recordAgentJournalEntry } from '@/lib/agent/journal';
import { buildSystemPrompt } from '@/lib/agent/prompts';
import type { HotelSnapshot } from '@/lib/agent/context';
import '@/lib/agent/tools/index';

const PID = '00000000-0000-4000-8000-00000000c001';
const UID = '00000000-0000-4000-8000-00000000c002';

/** Every hat that has ever been able to type "@Staxis" into a thread. */
const THREAD_ROLES: AppRole[] = [
  'admin', 'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance',
];

/**
 * The five capabilities the private catalog had, by the registry name that now
 * answers each one. This list is the CONTRACT of the fold: it is what "same
 * capabilities" means, written down, so a future edit that quietly drops one
 * fails here instead of in a hotel.
 */
const OLD_PRIVATE_CATALOG: Record<string, string> = {
  search_knowledge: 'search_knowledge',
  fetch_document_section: 'fetch_document_section',
  get_room_status: 'query_room_status',
  create_complaint: 'log_complaint',
  create_work_order: 'create_work_order',
};

const AUTHORIZATION = {
  seesFinancials: false,
  hotelMutationAllowed: true,
  capabilitySnapshot: {},
} as const;

function toolNamesFor(role: AppRole, surface: 'chat' | 'messages'): string[] {
  return getToolsForRole(role, surface, null, AUTHORIZATION).map((t) => t.name).sort();
}

function toolContext(role: AppRole, surface: 'chat' | 'messages'): ToolContext {
  return {
    user: {
      uid: UID,
      accountId: UID,
      username: 'asker',
      displayName: 'Asker',
      role,
      propertyAccess: [PID],
      hotelMutationAllowed: true,
    },
    propertyId: PID,
    staffId: null,
    requestId: 'one-brain-test',
    surface,
    enabledSections: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE REACH DID NOT MOVE
// ═══════════════════════════════════════════════════════════════════════════

describe('the thread assistant reaches exactly what it always reached', () => {
  test('every hat is offered the five capabilities the private catalog had', () => {
    const expected = [...new Set(Object.values(OLD_PRIVATE_CATALOG))].sort();
    for (const role of THREAD_ROLES) {
      assert.deepEqual(
        toolNamesFor(role, 'messages'),
        expected,
        `${role} lost or gained a capability in a thread. The five names are the fold's `
        + 'contract: they are what "same capabilities" means.',
      );
    }
  });

  test('housekeeping still has the thread, even though it has no chat bar', () => {
    // The sharpest asymmetry in the product, and it is deliberate. A housekeeper
    // has no Ask Staxis (the standing rule is that Staxis never adds a step to
    // that job) but has always had Messages, and typing a question into the
    // thread they are already in is not a new step. Narrowing it during a
    // consolidation would have been a capability removal in disguise.
    assert.equal(surfaceIsMountedForRole('housekeeping', 'chat'), false);
    assert.equal(surfaceIsMountedForRole('housekeeping', 'messages'), true);
    assert.equal(toolNamesFor('housekeeping', 'chat').length, 0);
    assert.equal(toolNamesFor('housekeeping', 'messages').length, 5);
  });

  test('a thread cannot reach a single tool the chat bar has and it did not', () => {
    // The adversarial half. Everything a manager can do in the chat bar that the
    // private catalog never had must be absent from a thread — a channel is read
    // by everyone in it, so a wage, a balance or a staffing figure answered there
    // is a different disclosure from the same figure in a private chat.
    const managerChat = toolNamesFor('general_manager', 'chat');
    const managerThread = toolNamesFor('general_manager', 'messages');
    assert.ok(managerChat.length > 20, 'the chat catalog should be the big one');
    for (const name of managerThread) {
      assert.ok(
        Object.values(OLD_PRIVATE_CATALOG).includes(name),
        `${name} is offered in a thread and was not one of the five`,
      );
    }
    for (const widened of ['get_staff_performance', 'get_outstanding_balances', 'send_message', 'post_announcement', 'assign_shift', 'staxis_pending_decisions']) {
      assert.ok(managerChat.includes(widened), `${widened} should exist in chat (test fixture drift)`);
      assert.ok(!managerThread.includes(widened), `${widened} leaked into the thread catalog`);
    }
  });

  test('the executor refuses a chat tool on the thread surface, catalog or no catalog', async () => {
    // Defense in depth, the way every other gate in the registry is enforced:
    // twice. Reaching here means a stale tool list, a replayed conversation, or
    // a hallucinated name — and the refusal must come BEFORE any read.
    for (const name of ['get_payments_summary', 'send_message', 'mark_room_clean']) {
      const result = await executeTool(name, {}, toolContext('general_manager', 'messages'));
      assert.equal(result.ok, false, `${name} executed on the thread surface`);
      assert.match(String(result.error), /not available on the messages surface/);
    }
  });

  test('folding the thread in did not hand the chat bar a new mutation', () => {
    // create_work_order is the one genuinely new registration, and it is
    // messages-only. A consolidation is not a licence to widen the surface it
    // was consolidating INTO.
    for (const role of THREAD_ROLES) {
      assert.ok(
        !toolNamesFor(role, 'chat').includes('create_work_order'),
        `${role}'s chat bar gained create_work_order`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. NOTHING IS WRITTEN WITHOUT A YES
// ═══════════════════════════════════════════════════════════════════════════

describe('the thread assistant proposes, it does not write', () => {
  test('both thread writes are mutations with an approval tier', () => {
    const writes = getToolsForRole('general_manager', 'messages', null, AUTHORIZATION)
      .filter((t) => t.mutates);
    assert.deepEqual(writes.map((t) => t.name).sort(), ['create_work_order', 'log_complaint']);
    for (const tool of writes) {
      assert.equal(tool.approval, 'card', `${tool.name} has no approval tier`);
      assert.notEqual(tool.confirmInChat, true, `${tool.name} opted out of the card gate`);
    }
  });

  test('the gate holds both of them rather than running them inline', () => {
    const held = partitionGatedCalls(
      [
        { id: 'a', name: 'create_work_order', args: { description: 'AC dead in 214' } },
        { id: 'b', name: 'log_complaint', args: { description: 'guest upset' } },
        { id: 'c', name: 'search_knowledge', args: { query: 'fire drill' } },
      ],
      'chat',
    );
    assert.deepEqual(held.held.map((c) => c.name).sort(), ['create_work_order', 'log_complaint']);
    assert.deepEqual(held.inline.map((c) => c.name), ['search_knowledge']);
  });

  test('a proposed work order becomes a pending approval and never touches the hotel', async () => {
    // The whole point of the change, end to end through the real loop. The
    // scripted model proposes; the runtime must yield the proposal and STOP.
    // `create_work_order`'s handler writes to `work_orders` — if the gate leaked,
    // this test would try to reach a database that is not there, so "no
    // tool_call_finished" is a claim with teeth.
    const fake = createFakeModel([
      {
        blocks: [
          { type: 'text', text: 'I can open a work order for 214.' },
          { type: 'tool_use', name: 'create_work_order', input: { description: 'AC dead in 214', roomNumber: '214' }, id: 'call-1' },
        ],
      },
    ]);
    const events: AgentEvent[] = [];
    for await (const ev of streamAgent({
      systemPrompt: { stable: 'test', dynamic: '', factual: '' },
      history: [],
      newUserMessage: '@Staxis the AC in 214 is dead',
      tools: getToolsForRole('housekeeping', 'messages', null, AUTHORIZATION),
      toolContext: toolContext('housekeeping', 'messages'),
      approvalMode: true,
      modelClient: fake.client,
    })) {
      events.push(ev);
    }
    const proposed = events.filter((e) => e.type === 'tool_call_pending_approval');
    assert.equal(proposed.length, 1, 'the work order was not proposed');
    assert.equal(proposed[0].type === 'tool_call_pending_approval' && proposed[0].call.name, 'create_work_order');
    assert.equal(
      events.some((e) => e.type === 'tool_call_finished'), false,
      'a write ran inline. This is the charter clause the whole fold exists for.',
    );
    assert.equal(
      events.some((e) => e.type === 'done'), false,
      'a turn that ends by proposing must not settle; the follow-up comes after the decision',
    );
  });

  test('the person who proposed a thread write can also approve it', () => {
    // A card nobody can resolve is a capability that quietly stopped working.
    // The approval route asks this same question to decide which surface, which
    // section gate and which cost row a decision runs under.
    assert.equal(approvalSurfaceForTool('housekeeping', 'create_work_order', null, AUTHORIZATION), 'messages');
    assert.equal(approvalSurfaceForTool('housekeeping', 'log_complaint', null, AUTHORIZATION), 'messages');
    // A hat with a chat bar resolves through it, exactly as every card minted
    // before this change already does.
    assert.equal(approvalSurfaceForTool('general_manager', 'log_complaint', null, AUTHORIZATION), 'chat');
    assert.equal(approvalSurfaceForTool('front_desk', 'send_message', null, AUTHORIZATION), 'chat');
    // And a tool this hat is offered on no surface is refused outright.
    assert.equal(approvalSurfaceForTool('housekeeping', 'mark_room_clean', null, AUTHORIZATION), null);
    assert.equal(approvalSurfaceForTool('maintenance', 'assign_shift', null, AUTHORIZATION), null);
  });

  test('each surface names the section that mounts it', () => {
    assert.equal(SURFACE_SECTION.chat, 'staxis');
    assert.equal(SURFACE_SECTION.messages, 'communications');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. IT IS THE MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

function snapshot(): HotelSnapshot {
  return {
    today: '2026-08-06',
    property: { id: PID, name: 'Comfort Suites', timezone: 'America/Chicago' },
    rooms: {
      total: 88, dirty: 4, in_progress: 0, clean: 10, dnd: 0, issuesFlagged: 0,
      helpRequested: 0, checkouts: 3, stayovers: 9, inHouse: 40, outOfOrder: 0,
      seedingGap: 0,
    },
    staff: { activeToday: 4, assignedHousekeepers: 3 },
    pmsDataSource: 'snapshot_capture',
    pmsDataCapturedAt: '2026-08-06T12:00:00.000Z',
  };
}

describe('a thread turn runs the one pipeline', () => {
  let restore: () => void;
  before(() => {
    // No `agent_prompts` rows: `resolvePrompts` falls back to the code
    // constants, which makes the assembled prompt deterministic without a DB.
    const original = supabaseAdmin.from.bind(supabaseAdmin);
    // @ts-expect-error monkey-patch the singleton for a deterministic assembly
    supabaseAdmin.from = () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return chain;
    };
    restore = () => { supabaseAdmin.from = original; };
  });
  after(() => { restore(); });

  test('the model is shown the thread job description, not the hat\'s chat one', async () => {
    for (const role of THREAD_ROLES) {
      const built = await buildSystemPrompt({
        role,
        surface: 'messages',
        snapshot: snapshot(),
        conversationId: 'conv-thread',
        now: new Date('2026-08-06T12:05:00.000Z'),
      });
      assert.ok(
        built.stable.includes('typed "@Staxis" in a team chat thread'),
        `${role} was given some other job description in a thread`,
      );
      assert.ok(built.versionLabel.includes('lens-messages-v1'),
        `${role}'s persisted stamp does not record which thread prompt ran`);
    }
  });

  test('the chat bar\'s own prompt is untouched by the new surface', async () => {
    const chat = await buildSystemPrompt({
      role: 'front_desk',
      snapshot: snapshot(),
      conversationId: 'conv-chat',
      now: new Date('2026-08-06T12:05:00.000Z'),
    });
    assert.ok(chat.versionLabel.includes('lens-front-desk-v1'));
    assert.ok(!chat.stable.includes('typed "@Staxis" in a team chat thread'));
  });

  test('a shared thread is never handed one person\'s notes or their plate', async () => {
    // Both blocks exist and both reach the chat bar. Neither belongs in an
    // answer that is POSTED INTO A CHANNEL: a note somebody taught the
    // assistant about themselves, or a line about what is waiting on them
    // today, is theirs. The route supplies neither, and this is the assertion
    // that a future edit has to argue with.
    const built = await buildSystemPrompt({
      role: 'general_manager',
      surface: 'messages',
      snapshot: snapshot(),
      conversationId: 'conv-thread',
      now: new Date('2026-08-06T12:05:00.000Z'),
    });
    assert.ok(!built.dynamic.includes('<staxis-memory'));
    assert.ok(!built.dynamic.includes('<staxis-awareness'));
  });

  test('the loop offers the model the thread catalog and answers from it', async () => {
    const fake = createFakeModel([
      { blocks: [{ type: 'text', text: 'Per the Fire Safety SOP, the drill is quarterly.' }] },
    ]);
    const events: AgentEvent[] = [];
    for await (const ev of streamAgent({
      systemPrompt: { stable: 'test', dynamic: '', factual: '' },
      history: [],
      newUserMessage: '@Staxis when is the fire drill',
      tools: getToolsForRole('front_desk', 'messages', null, AUTHORIZATION),
      toolContext: toolContext('front_desk', 'messages'),
      approvalMode: true,
      modelClient: fake.client,
    })) {
      events.push(ev);
    }
    assert.deepEqual(
      fake.requests[0].toolNames.sort(),
      [...new Set(Object.values(OLD_PRIVATE_CATALOG))].sort(),
      'the model was offered a different catalog than the lens allows',
    );
    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    assert.match(done.finalText, /Fire Safety SOP/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. THE LIFE RECORD, ON THIS SURFACE TOO
// ═══════════════════════════════════════════════════════════════════════════

describe('a thread act leaves the same record a chat act does', () => {
  test('the journal has no surface to get wrong, so a thread act lands in it', async () => {
    // The journal writes to activity_log and takes no surface at all, which is
    // why an approval resolved from a staff thread journals through the exact
    // same call the chat bar uses. Proved by watching the row it builds.
    const rows: Record<string, unknown>[] = [];
    const original = supabaseAdmin.from.bind(supabaseAdmin);
    // @ts-expect-error monkey-patch the singleton to capture the insert
    supabaseAdmin.from = (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        rows.push({ table, ...row });
        return Promise.resolve({ error: null });
      },
    });
    try {
      await recordAgentJournalEntry({
        propertyId: PID,
        eventType: 'agent_action_approved',
        description: 'Opened a work order for room 214.',
        actorAccountId: UID,
        actorRole: 'housekeeping',
        targetType: 'tool',
        targetId: 'create_work_order',
      });
    } finally {
      supabaseAdmin.from = original;
    }
    assert.equal(rows.length, 1, 'the thread act left no line in the hotel timeline');
    assert.equal(rows[0].table, 'activity_log');
    assert.equal(rows[0].source, AGENT_JOURNAL_SOURCE);
    assert.match(String(rows[0].description), /work order/i);
    assert.ok(!('surface' in rows[0]), 'the journal must not carry a surface it could get wrong');
  });

  test('the decision corpus refuses a surface it cannot store instead of mislabelling it', async () => {
    // The trap this closes: the corpus column's CHECK (migration 0350) admits
    // chat/voice/walkthrough/cron/api and has never been widened. The obvious
    // way to make a thread proposal land is to pass the nearest allowed value,
    // and 'chat' is a WRONG ANSWER in the one table whose job is recording where
    // an act happened. A missing row is a visible gap; a wrong row is not.
    assert.equal(decisionCorpusSurfaceOf('chat'), 'chat');
    assert.equal(decisionCorpusSurfaceOf('cron'), 'cron');
    assert.equal(decisionCorpusSurfaceOf('messages'), null);
    assert.equal(decisionCorpusSurfaceOf('portfolio'), null);
    assert.ok(!DECISION_CORPUS_SURFACES.includes('messages' as never));

    // And it must SKIP the write, not attempt one: a patched client that throws
    // on any use proves nothing reached the database.
    const original = supabaseAdmin.from.bind(supabaseAdmin);
    supabaseAdmin.from = (() => {
      throw new Error('the corpus tried to write an unstorable surface');
    }) as unknown as typeof supabaseAdmin.from;
    try {
      const id = await recordDecisionProposal({
        propertyId: PID,
        snapshot: snapshot(),
        surface: 'messages',
        actorKind: 'ai_proposed',
        actorAccountId: UID,
        actorRole: 'housekeeping',
        conversationId: null,
        pendingActionId: null,
        toolName: 'create_work_order',
        proposedArgs: { description: 'AC dead' },
      });
      assert.equal(id, null);
    } finally {
      supabaseAdmin.from = original;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. WHOSE LINE OF THE COST BOOK PAYS
// ═══════════════════════════════════════════════════════════════════════════

describe('the surface picks the Control Center row and nothing else', () => {
  test('each origin bills its own row', () => {
    assert.equal(agentFeatureKeyForOrigin('ask'), 'agent.ask_staxis');
    assert.equal(agentFeatureKeyForOrigin('companion'), 'companion.conversation');
    assert.equal(agentFeatureKeyForOrigin('messages'), 'communications.staxis_assistant');
  });

  test('an unknown or forged origin falls back to the chat bar\'s row', () => {
    // The value is untrusted on every route that reads it. The worst a forged
    // one can do is bill a turn to the wrong line of the owner's own book.
    assert.equal(agentOriginFromRequest(undefined), 'ask');
    assert.equal(agentOriginFromRequest('portfolio'), 'ask');
    assert.equal(agentOriginFromRequest('messages'), 'messages');
    assert.equal(agentOriginFromRequest('companion'), 'companion');
  });

  test('a shared thread never carries a dollar figure, whoever is asking', () => {
    // `moneyVisibleToRole` used to answer per HAT alone, which meant the
    // thread's own `money: false` was a comment rather than a rule: a manager
    // asking in a channel would have been handed the same figures they get in a
    // private chat. It now takes the surface too, so the tools that strip money
    // strip it for everybody in a thread.
    for (const role of THREAD_ROLES) {
      assert.equal(moneyVisibleToRole(role, 'messages'), false, `${role} sees money in a thread`);
    }
    // And the chat bar is untouched: managers keep every figure they had.
    assert.equal(moneyVisibleToRole('general_manager', 'chat'), true);
    assert.equal(moneyVisibleToRole('owner', 'chat'), true);
    assert.equal(moneyVisibleToRole('maintenance', 'chat'), false);
  });

  test('the work-order card reads as a sentence, not as a tool name', () => {
    // A card whose whole job is to get a yes has to say what it will do. The
    // fallback for an unknown tool is "Run <tool>", which is what a person would
    // have seen if create_work_order had been registered without a summary.
    const summary = buildActionSummary(
      'create_work_order',
      { description: 'AC dead', roomNumber: '214' },
      'en',
    );
    assert.match(summary, /work order/i);
    assert.match(summary, /214/);
    assert.match(summary, /AC dead/);
    assert.ok(!summary.startsWith('Run '), 'the card fell back to the generic tool-name summary');
  });

  test('the thread lens names the five, once', () => {
    // The lens list and the catalog it produces must agree; a name in the lens
    // that resolves to no registered tool is a silently missing capability.
    assert.equal(new Set(MESSAGES_LENS_TOOLS).size, MESSAGES_LENS_TOOLS.length);
    const lens = lensFor('housekeeping', 'messages');
    assert.ok(lens?.mounted);
    assert.equal(lens?.money, false, 'no dollar figure may reach a shared thread');
  });
});
