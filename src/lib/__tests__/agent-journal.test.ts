/**
 * THE COMPANION'S LIFE RECORD.
 *
 * The feature it covers: until 2026-08-06 the companion had no record of its
 * own existence. `activity_log` had zero application-code writers, the
 * `ai_autonomous` decision kind had been declared since migration 0350 and
 * never written, and asking a live hotel "what have you been doing?" rendered
 * nothing at all.
 *
 * The bar from CLAUDE.md is "would this fail if I introduced a plausible bug
 * here", and the plausible bugs in a journal are all quiet ones:
 *
 *   • A journal write throws and takes down the action it was recording. This
 *     is the one that matters most, and it has an explicit case per call site.
 *   • The write lands with the wrong `source`, so the read that filters on
 *     'staxis_agent' finds nothing and the feed silently goes back to saying
 *     two canned things.
 *   • A row gets journaled for a read-only tool, and every chat turn writes
 *     four copies of the same 3 KB state snapshot.
 *   • The recall of a forgotten question ignores a No, or brings back one that
 *     expired ten minutes ago, and the companion becomes the thing the whole
 *     manners layer exists to prevent.
 *   • A refresh of the bootstrap carries the server's older memory and greets
 *     somebody a second time in one page load.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_JOURNAL_SOURCE,
  JOURNAL_DESCRIPTION_MAX,
  journalActedLine,
  journalBriefedLine,
  journalExpiredLine,
  journalLearnedLine,
  journalResolutionLine,
  journalSaidLine,
  journalText,
  readAgentJournal,
  recordAgentJournalEntry,
} from '@/lib/agent/journal';
import { expireIfStale, unfinishedTopic, type PendingActionRow } from '@/lib/agent/pending-actions';
import { getMorningBrief } from '@/lib/findings/brief-server';
import { runAgentStream } from '@/app/api/agent/command/_stream-runner';
import { hermeticSnapshot } from '@/lib/agent/evals/hermetic-runner';
import { isMutationTool } from '@/lib/agent/tools';
// Side-effect import — registers every tool, which is what `isMutationTool`
// reads to decide whether a finished call was an ACT or a lookup.
import '@/lib/agent/tools/index';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  deliverableFingerprint,
  mergeDeliverable,
  type CompanionDeliverable,
} from '@/lib/companion/delivery';
import { subscribeByPolling } from '@/lib/db/_common';
import {
  unfinishedRecallSentence,
  UNFINISHED_RECALL_QUESTION,
} from '@/lib/companion/copy';
import {
  EMPTY_COMPANION_MEMORY,
  decideCompanionSpeech,
  type CompanionCandidate,
  type CompanionMemory,
  type MannersInput,
} from '@/lib/companion/manners';
import { COMPANION_DECLINES_BEFORE_DROP } from '@/lib/companion/charter';

const PROPERTY_ID = '00000000-0000-0000-0000-0000000000a1';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000b1';

// ═══════════════════════════════════════════════════════════════════════════
// The DB stub
// ═══════════════════════════════════════════════════════════════════════════
//
// `scopedDb` resolves `supabaseAdmin.from(...)` at CALL time, deliberately, so
// patching the singleton reaches every write in journal.ts. The stub RECORDS
// each insert so the assertions can be about what landed rather than about
// whether something was called.

interface RecordedInsert { table: string; rows: Record<string, unknown>[] }
interface RecordedSelect { table: string; filters: Array<[string, unknown]> }

let inserts: RecordedInsert[] = [];
let selects: RecordedSelect[] = [];
let selectRows: Record<string, unknown[]> = {};
/** Tables whose write should come back with a PostgREST error object. */
let erroringTables = new Set<string>();
/** Tables whose access should THROW, which is the nastier failure. */
let throwingTables = new Set<string>();

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

function installStub(): void {
  // @ts-expect-error monkey-patch the singleton for the test
  supabaseAdmin.from = (table: string) => {
    if (throwingTables.has(table)) {
      throw new Error(`stub: ${table} is unreachable`);
    }
    const select: RecordedSelect = { table, filters: [] };

    const settle = (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      if (erroringTables.has(table)) {
        return resolve({ data: null, error: { message: `stub: ${table} refused` } });
      }
      if (throwingTables.has(table)) {
        const err = new Error(`stub: ${table} exploded`);
        return reject ? reject(err) : Promise.reject(err);
      }
      return resolve({ data: selectRows[table] ?? [], error: null });
    };

    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { select.filters.push([col, val]); return chain; },
      gt: (col: string, val: unknown) => { select.filters.push([col, val]); return chain; },
      gte: (col: string, val: unknown) => { select.filters.push([col, val]); return chain; },
      lt: (col: string, val: unknown) => { select.filters.push([col, val]); return chain; },
      in: (col: string, val: unknown) => { select.filters.push([col, val]); return chain; },
      order: () => chain,
      limit: () => chain,
      update: () => chain,
      maybeSingle: () => ({
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
          if (erroringTables.has(table)) {
            return resolve({ data: null, error: { message: `stub: ${table} refused` } });
          }
          if (throwingTables.has(table)) {
            const err = new Error(`stub: ${table} exploded`);
            return reject ? reject(err) : Promise.reject(err);
          }
          return resolve({ data: (selectRows[table] ?? [])[0] ?? null, error: null });
        },
      }),
      insert: (rows: unknown) => {
        inserts.push({
          table,
          rows: (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[],
        });
        return chain;
      },
      then: settle,
    };
    selects.push(select);
    return chain;
  };
}

beforeEach(() => {
  inserts = [];
  selects = [];
  selectRows = {};
  erroringTables = new Set();
  throwingTables = new Set();
  installStub();
});

afterEach(() => {
  supabaseAdmin.from = originalFrom;
});

function journalRows(): Record<string, unknown>[] {
  return inserts.filter((i) => i.table === 'activity_log').flatMap((i) => i.rows);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The copy rules, by walking the producers
// ═══════════════════════════════════════════════════════════════════════════
//
// Not a grep over source. Every sentence the companion writes about itself is
// produced by one of these six functions, so the rules are checked by calling
// them and reading the answer — which is what survives a rename and catches a
// dash somebody interpolated in from a hotel's own task title.

const EVERY_PRODUCED_LINE: string[] = [
  journalActedLine({ summary: 'Add a to-do: replace the lobby bulb', ok: true }),
  journalActedLine({ summary: 'Add a to-do: replace the lobby bulb', ok: false }),
  journalResolutionLine({ summary: 'Message Maria Garcia', outcome: 'approved' }),
  journalResolutionLine({ summary: 'Message Maria Garcia', outcome: 'edited' }),
  journalResolutionLine({ summary: 'Message Maria Garcia', outcome: 'declined' }),
  journalResolutionLine({ summary: 'Message Maria Garcia', outcome: 'failed' }),
  journalExpiredLine({ summary: 'Message Maria Garcia' }),
  journalLearnedLine({ learned: 1, updated: 0, recap: 'Room 305 keeps losing its AC.' }),
  journalLearnedLine({ learned: 0, updated: 3, recap: null }),
  journalLearnedLine({ learned: 2, updated: 2, recap: 'Weekend checkouts run late.' }),
  journalSaidLine({ text: 'Three things slipped past their day.', personName: 'Maria' }),
  journalSaidLine({ text: 'Three things slipped past their day.', personName: null }),
  journalBriefedLine({ lines: 1 }),
  journalBriefedLine({ lines: 6 }),
];

describe('journal copy: the rules the whole product runs on', () => {
  it('never uses an em dash or an en dash', () => {
    for (const line of EVERY_PRODUCED_LINE) {
      assert.equal(/[—–]/.test(line), false, `dash in produced line: ${line}`);
    }
  });

  it('never calls the product "AI" in front of a person', () => {
    for (const line of EVERY_PRODUCED_LINE) {
      assert.equal(/\bAI\b/.test(line), false, `"AI" in produced line: ${line}`);
    }
  });

  it('every line is a bounded, non-empty sentence', () => {
    for (const line of EVERY_PRODUCED_LINE) {
      assert.ok(line.trim().length > 0);
      assert.ok(line.length <= JOURNAL_DESCRIPTION_MAX, `line over the cap: ${line.length}`);
    }
  });

  it('scrubs a dash that arrived inside somebody else\'s text', () => {
    // The half no producer owns: a task title a person typed. This is why the
    // scrub exists on top of the producers rather than instead of them.
    const line = journalActedLine({ summary: 'Add a to-do: lobby bulb — the tall one', ok: true });
    assert.equal(/[—–]/.test(line), false);
    assert.match(line, /lobby bulb, the tall one/);
  });

  it('clips a very long interpolation instead of storing it whole', () => {
    const line = journalSaidLine({ text: 'x'.repeat(1000), personName: null });
    assert.equal(line.length, JOURNAL_DESCRIPTION_MAX);
  });

  it('journalText leaves an ordinary sentence alone', () => {
    assert.equal(journalText('  Staxis  did this: a thing. '), 'Staxis did this: a thing.');
  });
});

describe('journal copy: the four card outcomes read differently', () => {
  it('says nothing changed for a no and for a timeout, and says so differently', () => {
    const declined = journalResolutionLine({ summary: 'X', outcome: 'declined' });
    const expired = journalExpiredLine({ summary: 'X' });
    assert.match(declined, /told no/);
    assert.match(expired, /never heard back/);
    assert.match(declined, /nothing changed/);
    assert.match(expired, /nothing changed/);
    // Silence is not a verdict. A timeout must never be written as a refusal.
    assert.equal(/told no|declined|refused/.test(expired), false);
  });

  it('an approval and an edited approval are distinguishable', () => {
    assert.notEqual(
      journalResolutionLine({ summary: 'X', outcome: 'approved' }),
      journalResolutionLine({ summary: 'X', outcome: 'edited' }),
    );
    assert.match(journalResolutionLine({ summary: 'X', outcome: 'edited' }), /details were changed/);
  });

  it('a failed act never reads as a completed one', () => {
    assert.match(journalActedLine({ summary: 'X', ok: false }), /did not go through/);
    assert.equal(/^Staxis did this/.test(journalActedLine({ summary: 'X', ok: false })), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The write itself
// ═══════════════════════════════════════════════════════════════════════════

describe('journal write: what actually lands', () => {
  it('writes one activity_log row carrying the source the reader filters on', async () => {
    await recordAgentJournalEntry({
      propertyId: PROPERTY_ID,
      eventType: 'agent_acted',
      description: journalActedLine({ summary: 'Add a to-do', ok: true }),
      actorAccountId: ACCOUNT_ID,
      metadata: { toolName: 'create_todo' },
    });
    const rows = journalRows();
    assert.equal(rows.length, 1);
    // If this drifts, every read that filters on it silently finds nothing and
    // the companion goes back to having no memory of its own day.
    assert.equal(rows[0].source, AGENT_JOURNAL_SOURCE);
    assert.equal(rows[0].event_type, 'agent_acted');
    assert.equal(rows[0].event_category, 'system');
    assert.equal(rows[0].actor_name, 'Staxis');
    assert.equal(rows[0].actor_account_id, ACCOUNT_ID);
    // scopedDb injects the hotel. A row without it is a row nobody can read
    // back and nobody can purge with the hotel.
    assert.equal(rows[0].property_id, PROPERTY_ID);
    assert.deepEqual(rows[0].metadata, { toolName: 'create_todo' });
  });

  it('records the companion as the actor when no person was involved', async () => {
    await recordAgentJournalEntry({
      propertyId: PROPERTY_ID,
      eventType: 'agent_learned',
      description: journalLearnedLine({ learned: 2, updated: 0, recap: null }),
    });
    // Nullable actor_account_id is documented for system actors since 0228.
    // Filling it in with somebody who did not do it would corrupt the
    // by-actor filter on the Activity Log page.
    assert.equal(journalRows()[0].actor_account_id, null);
  });

  it('refuses to write an empty sentence', async () => {
    await recordAgentJournalEntry({
      propertyId: PROPERTY_ID,
      eventType: 'agent_said',
      description: '   ',
    });
    assert.equal(journalRows().length, 0);
  });
});

describe('journal write: FAIL-SOFT, which is the whole bargain', () => {
  it('swallows a PostgREST error', async () => {
    erroringTables = new Set(['activity_log']);
    await recordAgentJournalEntry({
      propertyId: PROPERTY_ID,
      eventType: 'agent_acted',
      description: 'Staxis did this: a thing.',
    });
    // No throw is the assertion. The action being journaled is worth more than
    // the journal.
  });

  it('swallows a thrown client error', async () => {
    throwingTables = new Set(['activity_log']);
    await recordAgentJournalEntry({
      propertyId: PROPERTY_ID,
      eventType: 'agent_acted',
      description: 'Staxis did this: a thing.',
    });
  });

  it('swallows a bad hotel id rather than throwing a tenant mismatch', async () => {
    // scopedDb THROWS on a non-uuid, by design. A journal call site holding a
    // malformed id must not take the action down with it.
    await recordAgentJournalEntry({
      propertyId: 'not-a-uuid',
      eventType: 'agent_acted',
      description: 'Staxis did this: a thing.',
    });
    assert.equal(journalRows().length, 0);
  });

  it('the reader degrades to an empty list, never to a throw', async () => {
    erroringTables = new Set(['activity_log']);
    assert.deepEqual(await readAgentJournal(PROPERTY_ID, { sinceIso: '2026-08-01T00:00:00.000Z' }), []);
    throwingTables = new Set(['activity_log']);
    assert.deepEqual(await readAgentJournal(PROPERTY_ID, { sinceIso: '2026-08-01T00:00:00.000Z' }), []);
  });
});

describe('journal read: the filters that make it the COMPANION\'s record', () => {
  it('asks only for its own source, its own hotel and its own window', async () => {
    selectRows.activity_log = [{
      occurred_at: '2026-08-06T12:00:00.000Z',
      event_type: 'agent_acted',
      description: 'Staxis did this: a thing.',
      metadata: { toolName: 'create_todo' },
    }];
    const rows = await readAgentJournal(PROPERTY_ID, {
      sinceIso: '2026-08-06T05:00:00.000Z',
      eventTypes: ['agent_acted'],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, 'Staxis did this: a thing.');

    const read = selects.find((s) => s.table === 'activity_log');
    assert.ok(read);
    const cols = read.filters.map(([col]) => col);
    assert.ok(cols.includes('source'), 'a read without the source filter returns the trigger rows too');
    assert.ok(cols.includes('property_id'), 'a read without the hotel filter is a tenant leak');
    assert.ok(cols.includes('occurred_at'));
    assert.ok(cols.includes('event_type'));
  });

  it('drops a row it cannot honestly render', async () => {
    selectRows.activity_log = [
      { occurred_at: '2026-08-06T12:00:00.000Z', event_type: 'agent_acted', description: '' },
      { occurred_at: null, event_type: 'agent_acted', description: 'Staxis did this.' },
      { occurred_at: '2026-08-06T12:00:00.000Z', event_type: 'agent_acted', description: 'Staxis did this.' },
    ];
    const rows = await readAgentJournal(PROPERTY_ID, { sinceIso: '2026-08-06T05:00:00.000Z' });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].metadata, {});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The call sites
// ═══════════════════════════════════════════════════════════════════════════

function pendingRow(over: Partial<PendingActionRow> = {}): PendingActionRow {
  return {
    id: '00000000-0000-0000-0000-0000000000d1',
    propertyId: PROPERTY_ID,
    conversationId: '00000000-0000-0000-0000-0000000000e1',
    accountId: ACCOUNT_ID,
    turnKey: 'call_1',
    toolCallId: 'call_1',
    toolName: 'create_todo',
    toolArgs: { title: 'Replace the lobby bulb' },
    tier: 'card',
    status: 'pending',
    result: null,
    error: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    resolvedAt: null,
    expiresAt: '2026-08-05T12:10:00.000Z',
    ...over,
  };
}

describe('call site: a card that timed out unanswered', () => {
  it('journals the unanswered question with the topic a decline can attach to', async () => {
    selectRows.agent_pending_actions = [{ id: pendingRow().id }];
    const flipped = await expireIfStale(pendingRow());
    assert.equal(flipped, true);

    const rows = journalRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'agent_action_expired');
    assert.match(String(rows[0].description), /never heard back/);
    const metadata = rows[0].metadata as Record<string, unknown>;
    // The recall reads BOTH of these back. A row missing either is a question
    // the companion cannot honestly bring up again.
    assert.equal(metadata.topic, unfinishedTopic('create_todo'));
    assert.ok(typeof metadata.summary === 'string' && (metadata.summary as string).length > 0);
  });

  it('writes nothing when the row was already terminal', async () => {
    // The single-flight guard: only the request that actually flipped the row
    // may write a line, or two concurrent expiries say it twice.
    selectRows.agent_pending_actions = [];
    const flipped = await expireIfStale(pendingRow());
    assert.equal(flipped, false);
    assert.equal(journalRows().length, 0);
  });

  it('does not expire, or journal, a row that is still live', async () => {
    const flipped = await expireIfStale(pendingRow({ expiresAt: '2099-01-01T00:00:00.000Z' }));
    assert.equal(flipped, false);
    assert.equal(journalRows().length, 0);
  });
});

describe('call site: a tool that ran with no card in front of it', () => {
  function toolFinished(name: string, isError = false) {
    return {
      type: 'tool_call_finished' as const,
      call: { id: 'call_1', name, args: { title: 'Replace the lobby bulb' } },
      result: { ok: true },
      isError,
    };
  }

  async function* oneEvent(event: unknown) {
    yield event as never;
  }

  const corpus = {
    propertyId: PROPERTY_ID,
    snapshot: hermeticSnapshot(),
    accountId: ACCOUNT_ID,
    actorRole: 'general_manager',
    promptVersion: 'test-v1',
    surface: 'chat' as const,
  };

  const ctx = {
    conversationId: '00000000-0000-0000-0000-0000000000e1',
    requestId: 'req_1',
    promptVersion: 'test-v1',
    send: () => {},
  };

  it('writes an ai_autonomous decision AND a journal line for a mutation', async () => {
    await runAgentStream(oneEvent(toolFinished('create_todo')), ctx, { corpus });

    const decisions = inserts.filter((i) => i.table === 'agent_decisions').flatMap((i) => i.rows);
    assert.equal(decisions.length, 1, 'the corpus row nothing had ever written');
    // Declared in migration 0350 and written by no code path until now.
    assert.equal(decisions[0].actor_kind, 'ai_autonomous');
    assert.equal(decisions[0].tool_name, 'create_todo');
    // Proposal and execution are the same moment, so the DB's args_diff
    // trigger computes an empty diff, which is the truth: nobody corrected it.
    assert.deepEqual(decisions[0].executed_args, decisions[0].proposed_args);
    // No human took any time to decide, so zero would be a lie.
    assert.equal(decisions[0].decision_ms, null);
    // The state it was looking at is the only thing that makes "why did you do
    // that" answerable later.
    assert.ok(decisions[0].state_snapshot);
    assert.ok(typeof decisions[0].state_snapshot_hash === 'string');

    const rows = journalRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'agent_acted');
    assert.equal(rows[0].source, AGENT_JOURNAL_SOURCE);
  });

  it('writes NOTHING for a read, however many of them a turn makes', async () => {
    // The narrowing that keeps this affordable. A read changed nothing, the
    // conversation already holds what it returned, and one 2-4 KB snapshot per
    // lookup would put the same snapshot on disk four times a turn.
    //
    // Both tool names below are REAL registry entries, checked here so this
    // case cannot pass by naming a tool that does not exist (every unknown
    // name is non-mutating, which would make the assertion vacuous).
    assert.equal(isMutationTool('create_todo'), true);
    assert.equal(isMutationTool('get_hotel_state'), false);
    await runAgentStream(oneEvent(toolFinished('get_hotel_state')), ctx, { corpus });
    assert.equal(inserts.filter((i) => i.table === 'agent_decisions').length, 0);
    assert.equal(journalRows().length, 0);
  });

  it('records a failed act as failed rather than silently as done', async () => {
    await runAgentStream(oneEvent(toolFinished('create_todo', true)), ctx, { corpus });
    const decisions = inserts.filter((i) => i.table === 'agent_decisions').flatMap((i) => i.rows);
    assert.equal(decisions.length, 1);
    assert.ok(typeof decisions[0].error === 'string' && (decisions[0].error as string).length > 0);
    assert.equal(decisions[0].result, null);
    assert.match(String(journalRows()[0].description), /did not go through/);
  });

  it('records nothing at all when the caller supplied no snapshot', async () => {
    // A corpus row with a fabricated snapshot would be worse than no row: it
    // would answer "what was it looking at" with a guess.
    await runAgentStream(oneEvent(toolFinished('create_todo')), ctx, {});
    assert.equal(inserts.filter((i) => i.table === 'agent_decisions').length, 0);
    assert.equal(journalRows().length, 0);
  });

  it('a broken journal does not break the turn', async () => {
    throwingTables = new Set(['activity_log']);
    await runAgentStream(oneEvent(toolFinished('create_todo')), ctx, { corpus });
    // The tool result still persisted and the stream still completed. If the
    // journal could throw here, a Supabase hiccup would cost a hotel its reply.
    assert.equal(inserts.filter((i) => i.table === 'agent_decisions').length, 1);
  });
});

describe('call site: the morning brief', () => {
  const BRIEF = {
    propertyId: PROPERTY_ID,
    localDate: '2026-08-06',
    generatedAt: '2026-08-06T11:00:00.000Z',
    kind: 'report' as const,
    lines: [
      { key: 'a', text: 'Two rooms need a second look.' },
      { key: 'b', text: 'Towels are below par.' },
    ],
    focusIds: [],
    source: 'template' as const,
  };

  function deps(over: Record<string, unknown> = {}) {
    return {
      gather: async () => ({
        propertyId: PROPERTY_ID,
        localDate: '2026-08-06',
        // A hotel that HAS been checked. `buildBrief` returns null without a
        // run, which is the "never checked, so say nothing" rule, and a test
        // that left it null would pass while exercising nothing.
        run: {
          runAt: '2026-08-06T10:55:00.000Z',
          detectorsChecked: 12,
          detectorsSkipped: 0,
          detectorsFailed: 0,
        },
        cards: [],
        cleared: [],
        windowStart: new Date('2026-08-06T05:00:00.000Z'),
        now: new Date('2026-08-06T11:00:00.000Z'),
      }),
      readCache: async () => null,
      claim: async () => true,
      writeCache: async () => {},
      phrase: async () => BRIEF,
      ...over,
    } as never;
  }

  it('journals the brief on the ONE call that produced it', async () => {
    const result = await getMorningBrief({
      propertyId: PROPERTY_ID,
      now: new Date('2026-08-06T11:00:00.000Z'),
      deps: deps(),
      // Deps are injected wholesale, so the option bag is widened here.
    } as any);
    assert.equal(result.generated, true, 'the generated branch was never reached');
    const rows = journalRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'agent_briefed');
    assert.match(String(rows[0].description), /morning brief/);
    assert.equal((rows[0].metadata as Record<string, unknown>).localDate, '2026-08-06');
  });

  it('journals NOTHING when the day\'s brief came from cache', async () => {
    // The brief is read many times a day and written once. A line per read
    // would claim the same act eleven times.
    await getMorningBrief({
      propertyId: PROPERTY_ID,
      now: new Date('2026-08-06T11:00:00.000Z'),
      deps: deps({ readCache: async () => BRIEF }),
      // Deps are injected wholesale, so the option bag is widened here.
    } as any);
    assert.equal(journalRows().length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Unfinished business: the recall, and the manners it is bound by
// ═══════════════════════════════════════════════════════════════════════════

describe('unfinished business: the sentence', () => {
  it('names how long ago without ever calling it an accusation', () => {
    const yesterday = unfinishedRecallSentence({ summary: 'Message Maria Garcia', daysAgo: 1 });
    assert.match(yesterday, /^Yesterday I asked about this and never heard back/);
    assert.equal(/ignore|you did not|forgot/i.test(yesterday), false);

    const older = unfinishedRecallSentence({ summary: 'Message Maria Garcia', daysAgo: 3 });
    assert.match(older, /^3 days ago I asked/);
  });

  it('carries no dash and does not say "AI"', () => {
    for (const daysAgo of [1, 2, 3]) {
      const line = unfinishedRecallSentence({ summary: 'Do the thing — twice', daysAgo });
      assert.equal(/\bAI\b/.test(line), false);
    }
    assert.equal(/[—–]/.test(UNFINISHED_RECALL_QUESTION), false);
  });
});

describe('unfinished business: it is bound by the ordinary manners ledger', () => {
  const TODAY = '2026-08-06';
  const NOON = new Date('2026-08-06T17:00:00.000Z');
  const TOPIC = unfinishedTopic('create_todo');

  function recallCandidate(): CompanionCandidate {
    return {
      topic: TOPIC,
      text: unfinishedRecallSentence({ summary: 'Add a to-do: replace the lobby bulb', daysAgo: 1 }),
      sensitivity: 'operational',
      covers: [],
      destination: null,
      seed: 'Add a to-do: replace the lobby bulb',
      severity: 'ok',
    };
  }

  function input(memory: Partial<CompanionMemory> = {}): MannersInput {
    return {
      now: NOON,
      today: TODAY,
      person: { firstName: 'Maria', role: 'general_manager', sharedLogin: false },
      memory: {
        ...EMPTY_COMPANION_MEMORY,
        welcomedAt: '2026-07-01T00:00:00.000Z',
        tourDeclined: true,
        ...memory,
      },
      candidates: [recallCandidate()],
      onScreen: [],
      userIsBusy: false,
      quietThisSession: false,
      aiAwake: true,
      wizardAlreadyRan: true,
      multiHotel: false,
      hotelName: 'Comfort Suites',
    };
  }

  it('is offered once, and carries the sentence that reopens it', () => {
    const speech = decideCompanionSpeech(input());
    assert.equal(speech.kind, 'offer');
    if (speech.kind !== 'offer') return;
    assert.equal(speech.topic, TOPIC);
    assert.match(speech.sentence, /never heard back/);
    // Without this, the Yes button resolves to no destination and silently
    // does nothing, which is the one outcome this layer refuses to ship.
    assert.equal(speech.seed, 'Add a to-do: replace the lobby bulb');
  });

  it('is not raised twice in one day', () => {
    const speech = decideCompanionSpeech(input({
      topics: { [TOPIC]: { declines: 0, dropped: false, lastOfferedDay: TODAY } },
    }));
    assert.equal(speech.kind, 'silent');
  });

  it('RESPECTS A DECLINE: gone for good after the ledger drops the topic', () => {
    // One No is a No to the moment, so the topic stays live for tomorrow.
    const afterOne = decideCompanionSpeech(input({
      topics: { [TOPIC]: { declines: 1, dropped: false, lastOfferedDay: '2026-08-05' } },
    }));
    assert.equal(afterOne.kind, 'offer');

    // Two is a No to the subject, and the ledger's `dropped` is permanent.
    const afterTwo = decideCompanionSpeech(input({
      topics: {
        [TOPIC]: {
          declines: COMPANION_DECLINES_BEFORE_DROP,
          dropped: true,
          lastOfferedDay: '2026-08-05',
        },
      },
    }));
    assert.equal(afterTwo.kind, 'silent');
    if (afterTwo.kind !== 'silent') return;
    assert.equal(afterTwo.reason, 'nothing_to_say');
  });

  it('spends the ordinary daily budget rather than being exempt from it', () => {
    // The recall is not a fourth mouth. If it were, a person who had already
    // heard everything they were going to hear today would still get it.
    const speech = decideCompanionSpeech(input({
      spokenDay: TODAY,
      spokenCount: 99,
      lastSpokeAt: '2026-08-06T16:00:00.000Z',
    }));
    assert.equal(speech.kind, 'silent');
    if (speech.kind !== 'silent') return;
    assert.equal(speech.reason, 'daily_cap_reached');
  });

  it('the topic is keyed on the subject, not on the row', () => {
    // Two different forgotten to-dos are the same subject. Keying on the
    // pending-action id would let the same class of question come back every
    // day under a new name, which is the never-nag rule defeated by a uuid.
    assert.equal(unfinishedTopic('create_todo'), unfinishedTopic('create_todo'));
    assert.notEqual(unfinishedTopic('create_todo'), unfinishedTopic('send_message'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Live delivery
// ═══════════════════════════════════════════════════════════════════════════

describe('companion delivery: what a refresh may and may not replace', () => {
  /** A bootstrap, shaped like the hook's, with the two halves that matter. */
  interface FakeBoot {
    person: { firstName: string };
    memory: { welcomedAt: string | null; greetedDay: string | null };
    notices: CompanionDeliverable['notices'];
    candidates: CompanionDeliverable['candidates'];
  }

  const boot = (): FakeBoot => ({
    person: { firstName: 'Maria' },
    memory: { welcomedAt: '2026-08-06T09:00:00.000Z', greetedDay: '2026-08-06' },
    notices: [],
    candidates: [],
  });

  const notice: CompanionDeliverable['notices'][number] = {
    id: 'done:1',
    kind: 'done',
    taskId: 't1',
    at: '2026-08-06T10:00:00.000Z',
    personName: 'Maria',
    title: 'Replace the lobby bulb',
    reason: null,
    sentence: 'Maria finished replacing the lobby bulb.',
  };
  const cand: CompanionCandidate = {
    topic: 'finding:x',
    text: 'Three rooms have no clean bath towels.',
    sensitivity: 'operational',
    covers: [],
    destination: 'inventory',
  };

  it('replaces the work that landed', () => {
    const merged = mergeDeliverable(boot(), { notices: [notice], candidates: [cand] });
    assert.equal(merged.notices.length, 1);
    assert.equal(merged.candidates.length, 1);
  });

  it('NEVER replaces the memory, which is the double-greeting bug', () => {
    // The browser sets welcomedAt optimistically the instant the welcome
    // renders; the server does not know yet. A refresh that carried the
    // server's memory back would blank it and welcome the same person twice in
    // one page load. `mergeDeliverable` reads only two fields off `incoming`,
    // so a server snapshot that has not caught up cannot reach the memory
    // however much of one it carries.
    const stale = {
      person: { firstName: 'SOMEBODY ELSE' },
      memory: { welcomedAt: null, greetedDay: null },
      notices: [],
      candidates: [],
    };
    const merged = mergeDeliverable(boot(), stale as unknown as Parameters<typeof mergeDeliverable>[1]);
    assert.equal(merged.memory.welcomedAt, '2026-08-06T09:00:00.000Z');
    assert.equal(merged.memory.greetedDay, '2026-08-06');
    assert.equal(merged.person.firstName, 'Maria');
  });

  it('the fingerprint changes when a notice lands and not otherwise', () => {
    assert.equal(deliverableFingerprint(boot()), deliverableFingerprint(boot()));
    assert.notEqual(
      deliverableFingerprint(boot()),
      deliverableFingerprint({ ...boot(), notices: [notice] }),
    );
    // A memory stamp moving is not news to a screen, so it must not publish.
    const memoryMoved = { ...boot(), memory: { welcomedAt: 'later', greetedDay: 'later' } };
    assert.equal(deliverableFingerprint(boot()), deliverableFingerprint(memoryMoved));
  });

  it('a missing list reads as empty rather than as undefined', () => {
    assert.equal(deliverableFingerprint(undefined), JSON.stringify({ notices: [], candidates: [] }));
    assert.equal(deliverableFingerprint({}), JSON.stringify({ notices: [], candidates: [] }));
  });
});

describe('companion delivery: the refetch transport', () => {
  const freshNotice: CompanionDeliverable['notices'][number] = {
    id: 'done:1',
    kind: 'done',
    taskId: 't1',
    at: '2026-08-06T10:00:00.000Z',
    personName: 'Maria',
    title: 'Replace the lobby bulb',
    reason: null,
    sentence: 'Maria finished replacing the lobby bulb.',
  };

  it('publishes a fresh whole snapshot on refresh, never a diff', async () => {
    type Snapshot = {
      notices: CompanionDeliverable['notices'];
      candidates: CompanionDeliverable['candidates'];
    };
    let served: Snapshot[] = [{ notices: [], candidates: [] }];
    const seen: Snapshot[][] = [];
    const subscription = subscribeByPolling<Snapshot>(
      async () => served,
      (rows) => { seen.push(rows); },
      undefined,
      {
        pollIntervalMs: 60_000,
        isEqual: (a, b) => deliverableFingerprint(a[0]) === deliverableFingerprint(b[0]),
      },
    );
    try {
      // The transport fetches once on construction; join its chain.
      await subscription.refresh();
      const afterFirst = seen.length;
      assert.ok(afterFirst >= 1, 'the first snapshot never landed');

      // The same answer publishes nothing, so an idle screen never re-renders.
      await subscription.refresh();
      assert.equal(seen.length, afterFirst);

      // Work lands, and the WHOLE new snapshot arrives. Not a patch, not a
      // merge: the array the loader returned, which is the property the
      // subscribeTable contract is really about.
      served = [{ notices: [freshNotice], candidates: [] }];
      await subscription.refresh();
      assert.equal(seen.length, afterFirst + 1);
      assert.deepEqual(seen[seen.length - 1], served);
    } finally {
      subscription.unsubscribe();
    }
  });

  it('keeps serving the last good snapshot when a refresh fails', async () => {
    let fail = false;
    const good = [{ notices: [{ id: 'done:1' }], candidates: [] }];
    const seen: unknown[][] = [];
    const subscription = subscribeByPolling(
      async () => {
        if (fail) throw new Error('offline');
        return good;
      },
      (rows) => { seen.push(rows); },
      undefined,
      { pollIntervalMs: 60_000 },
    );
    try {
      await subscription.refresh();
      const afterGood = seen.length;
      assert.ok(afterGood >= 1);

      fail = true;
      await subscription.refresh().catch(() => {});
      // A failed refresh must not erase what is on screen. An empty publish
      // here would blank somebody's notice list because the wifi dropped.
      assert.equal(seen.length, afterGood);
    } finally {
      subscription.unsubscribe();
    }
  });
});
