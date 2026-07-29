/**
 * THE CHAT'S HANDS, AGAINST A REAL POSTGRES.
 *
 * The five DO tools let a manager set the hotel up and answer Staxis by talking
 * to it. Every one of them can write to a real hotel, so the question this file
 * exists to answer is not "does it work" but "can the MODEL do it on its own".
 *
 * The whole safety argument rests on one claim: a write only happens after the
 * ROUTE has recorded a message from the human since the read-back. So the
 * fixture does not simulate that — it drives the real persistence functions the
 * chat route drives (`recordUserTurn`, `recordAssistantTurn`, `recordToolResult`)
 * in the same order, against a real database, and then asks the tools to write.
 * A test that stubbed the transcript would be testing its own stub, and the
 * transcript IS the gate.
 *
 * WHAT IS PROVED HERE
 *   1. a proposal writes NOTHING, and says so;
 *   2. a model that proposes and confirms inside one turn writes nothing —
 *      the mutation this whole design exists to stop;
 *   3. the person's next message is what makes it real, and what lands is
 *      correct and attributed;
 *   4. a token cannot be invented, reused, carried to another tool, carried to
 *      another conversation, or carried to another hotel;
 *   5. the company rulebook is refused to a GM by NAME, written by an editor,
 *      and stores NOTHING when the sentence names two approvers;
 *   6. approving runs the frozen action exactly once — a second approval is the
 *      database's `already_executed`, with one work order on the board;
 *   7. a sign-off lock refuses in chat exactly as it does on the card, and an
 *      unreadable rulebook refuses rather than guessing;
 *   8. declining writes the same verdict the card's own button writes;
 *   9. a drip answer goes through the drip module, so one-a-day and never-twice
 *      still hold when the question is asked in the chat;
 *  10. role and hotel walls hold on every one of the five.
 *
 * NOTE ON RLS: PGlite runs as the table owner, exactly as the service-role key
 * bypasses policies in production. What is under test is app-level scoping.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { executeTool, listAllTools, type ToolContext } from '@/lib/agent/tools';
import '@/lib/agent/tools/index';
import {
  createConversation,
  recordAssistantTurn,
  recordToolResult,
  recordUserTurn,
} from '@/lib/agent/memory';
import { PROMPT_VERSION } from '@/lib/agent/prompts';
import { isAwaitingConfirmation } from '@/lib/agent/llm';
import { proposeAction } from '@/lib/findings/actions/store';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_ANA,
  ACCOUNT_GIL,
  ACCOUNT_VERA,
  ORG_A,
  ORG_B,
  PID_A1,
  PID_B1,
  UID_ANA,
  UID_GIL,
  UID_VERA,
  seedTwoCompanies,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

// ─── The conversation, driven exactly as the route drives it ────────────────

interface Call { name: string; args: Record<string, unknown> }
interface Ran { name: string; ok: boolean; data: Record<string, unknown>; error: string | null }

let callSeq = 0;

/**
 * One assistant turn: the person types, the model calls tools, the route
 * persists each result. The ORDER is the route's order — the user row lands
 * before the model runs, and each tool result lands before the next tool runs —
 * because that ordering is precisely what the confirm gate reads.
 */
async function turn(ctx: ToolContext, said: string, calls: Call[]): Promise<Ran[]> {
  await recordUserTurn(ctx.conversationId!, said);
  return sameTurn(ctx, calls);
}

/**
 * ANOTHER ITERATION OF THE TURN ALREADY IN PROGRESS — no new message from the
 * person. This is what the tool loop does when the model, having read a tool
 * result, calls another tool before answering: the assistant turn is persisted
 * and the tools run, and nobody has typed anything.
 */
async function sameTurn(ctx: ToolContext, calls: Call[]): Promise<Ran[]> {
  const withIds = calls.map((c) => ({ id: `call-${++callSeq}`, name: c.name, args: c.args }));
  await recordAssistantTurn(ctx.conversationId!, '', withIds, {
    tokensIn: 1, tokensOut: 1, modelUsed: 'sonnet', modelId: null, costUsd: 0,
    promptVersion: PROMPT_VERSION,
  });
  const out: Ran[] = [];
  for (const call of withIds) {
    const result = await executeTool(call.name, call.args, ctx);
    await recordToolResult(ctx.conversationId!, call.id, result.data ?? result.error, !result.ok);
    out.push({
      name: call.name,
      ok: result.ok,
      data: (result.data ?? {}) as Record<string, unknown>,
      error: result.error ?? null,
    });
  }
  return out;
}

/** The token a propose call handed back, or null when it refused. */
function tokenOf(ran: Ran): string | null {
  const confirm = (ran.data as { confirm?: { token?: string } }).confirm;
  return confirm?.token ?? null;
}

function readBack(ran: Ran): { en: string; es: string } {
  return (ran.data as { readBack?: { en: string; es: string } }).readBack ?? { en: '', es: '' };
}

async function chatCtx(opts: {
  accountId: string;
  uid: string;
  propertyId: string;
  role?: ToolContext['user']['role'];
  displayName?: string;
  conversationId?: string;
}): Promise<ToolContext> {
  const conversationId = opts.conversationId ?? await createConversation({
    userAccountId: opts.accountId,
    propertyId: opts.propertyId,
    role: opts.role ?? 'general_manager',
    promptVersion: PROMPT_VERSION,
    title: 'do-wires',
  });
  return {
    user: {
      uid: opts.uid,
      accountId: opts.accountId,
      username: 'probe',
      displayName: opts.displayName ?? 'Maria Garcia',
      role: opts.role ?? 'general_manager',
      propertyAccess: [opts.propertyId],
      hotelMutationAllowed: true,
      seesFinancials: true,
      capabilitySnapshot: {
        view_financials: true,
        view_wages: true,
        manage_inventory_orders: true,
      },
    },
    propertyId: opts.propertyId,
    staffId: null,
    requestId: 'do-wires-test',
    surface: 'chat',
    conversationId,
    enabledSections: null,
  };
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const r = await pg.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.from = shim.from;
  // @ts-expect-error installing the pglite-backed client on the singleton
  supabaseAdmin.rpc = shim.rpc;
  await seedTwoCompanies(pg);
  // Ana's company-owner job grants company reach, not hotel mutation. Pair it
  // with an explicit property operational job so these DO-tool fixtures test a
  // person who genuinely has both the company role and hotel write standing.
  await pg.query(
    "select public.staxis_set_membership_hat($1, $2, $3, 'property', 'general_manager', $4, 'General Manager')",
    [ACCOUNT_ADMIN, ORG_A, ACCOUNT_ANA, JSON.stringify([PID_A1])],
  );
  // Company-level VP reach is intentionally read-only at a hotel. Vera needs
  // a real property-scoped operational job for the hotel mutation half of the
  // rulebook tests; the company VP hat still decides whether she may edit the
  // company rulebook itself.
  await pg.query(
    "select public.staxis_set_membership_hat($1, $2, $3, 'property', 'general_manager', $4, 'General Manager')",
    [ACCOUNT_ADMIN, ORG_B, ACCOUNT_VERA, JSON.stringify([PID_B1])],
  );
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  await pg?.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The two-phase confirm
// ═══════════════════════════════════════════════════════════════════════════

describe('a DO tool cannot write without the person\'s own next message', () => {
  test('the proposal writes nothing, and both languages carry every number', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [proposed] = await turn(ctx, 'water heaters every six months, last done in March 2026', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Water heater flush', everyDays: 180, lastDone: '2026-03-15', area: 'Boiler room' } },
    ]);

    assert.equal(proposed.ok, true, proposed.error ?? '');
    assert.equal(proposed.data.awaitingConfirmation, true);
    assert.equal(proposed.data.nothingWrittenYet, true);
    assert.ok(tokenOf(proposed), 'a proposal must hand back a token');

    const back = readBack(proposed);
    // The numbers are the point: an interval and a next-due date a manager can
    // catch, in the language they are speaking.
    for (const sentence of [back.en, back.es]) {
      assert.match(sentence, /180/);
      assert.match(sentence, /2026/);
    }
    assert.notEqual(back.en, back.es, 'the Spanish read-back is English wearing a label');
    assert.match(back.es, /cada 180 días/);

    assert.equal(
      await count('select count(*)::text as n from preventive_tasks where property_id = $1', [PID_A1]),
      0,
      'a proposal wrote a row',
    );

    // The fake-success guard reads the same flag. Without this, a turn that only
    // PROPOSED would count as a mutation having run, and "Done — I've set that
    // up" would come out unchallenged on a turn where nothing was written.
    assert.equal(isAwaitingConfirmation(proposed.data), true);
  });

  test('THE MUTATION: a model that confirms itself inside one turn writes nothing', async () => {
    // This is the whole design in one test. The model proposes and, in the same
    // assistant turn — with the token it was just handed, which is as good as a
    // token ever gets — confirms. The person has not spoken since the read-back,
    // so nothing may happen.
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const before = await count('select count(*)::text as n from preventive_tasks where property_id = $1', [PID_A1]);

    const [proposed] = await turn(ctx, 'elevator service quarterly', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Elevator service', everyDays: 90 } },
    ]);
    const token = tokenOf(proposed)!;
    // The SAME turn, one iteration later: the model has read the read-back and
    // goes straight on to the write. Nobody has typed anything.
    const [selfConfirmed] = await sameTurn(ctx, [
      { name: 'staxis_set_up_preventive_task', args: { confirmToken: token } },
    ]);

    assert.equal(selfConfirmed.ok, false, 'the model confirmed itself and the tool allowed it');
    assert.match(selfConfirmed.error ?? '', /not been answered yet|your own agreement/i);
    assert.equal(
      await count('select count(*)::text as n from preventive_tasks where property_id = $1', [PID_A1]),
      before,
      'a self-confirmed proposal reached the database',
    );
  });

  test('a made-up token confirms nothing', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [ran] = await turn(ctx, 'yes do it', [
      { name: 'staxis_set_up_preventive_task', args: { confirmToken: '11111111-2222-4333-8444-555555555555' } },
    ]);
    assert.equal(ran.ok, false);
    assert.match(ran.error ?? '', /no proposal waiting/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Preventive maintenance, end to end
// ═══════════════════════════════════════════════════════════════════════════

describe('setting up preventive maintenance by talking', () => {
  test('the person says yes in a new message, and the schedule lands attributed', async () => {
    const ctx = await chatCtx({
      accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner', displayName: 'Stale Alias',
    });
    const [proposed] = await turn(ctx, 'flush the water heaters every 180 days, last done 15 March 2026', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Water heater flush', everyDays: 180, lastDone: '2026-03-15', area: 'Boiler room' } },
    ]);
    const token = tokenOf(proposed)!;

    // A NEW message from the person. This is the only thing that changed.
    const [confirmed] = await turn(ctx, "yes, that's right", [
      { name: 'staxis_set_up_preventive_task', args: { confirmToken: token } },
    ]);
    assert.equal(confirmed.ok, true, confirmed.error ?? '');
    // …and the write half is NOT a proposal, so the guard stays armed correctly.
    assert.equal(isAwaitingConfirmation(confirmed.data), false);

    const row = (await pg.query<{
      name: string; area: string | null; frequency_days: number;
      last_completed_at: string | null; last_completed_by: string | null; notes: string | null;
    }>(
      `select name, area, frequency_days, last_completed_at, last_completed_by, notes
         from preventive_tasks where property_id = $1 and name = 'Water heater flush'`,
      [PID_A1],
    )).rows[0];
    assert.ok(row, 'the schedule was not created');
    assert.equal(row.frequency_days, 180);
    assert.equal(row.area, 'Boiler room');
    assert.match(new Date(row.last_completed_at!).toISOString(), /^2026-03-15/);
    // Who SET IT UP is recorded; who DID the work is not invented.
    assert.match(String(row.notes), /Ana/);
    assert.doesNotMatch(String(row.notes), /Stale Alias/);
    assert.equal(row.last_completed_by, null);
  });

  test('a second yes on the same proposal does not make a second schedule', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [proposed] = await turn(ctx, 'add a monthly roof check', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Roof check', everyDays: 30 } },
    ]);
    const token = tokenOf(proposed)!;
    const [first] = await turn(ctx, 'yes', [{ name: 'staxis_set_up_preventive_task', args: { confirmToken: token } }]);
    assert.equal(first.ok, true, first.error ?? '');
    const [second] = await turn(ctx, 'yes, go ahead', [{ name: 'staxis_set_up_preventive_task', args: { confirmToken: token } }]);
    assert.equal(second.ok, false);
    assert.match(second.error ?? '', /already done/i);
    assert.equal(
      await count(`select count(*)::text as n from preventive_tasks where property_id = $1 and name = 'Roof check'`, [PID_A1]),
      1,
    );
  });

  test('what gets written is what was read back, not what the second call says', async () => {
    // The person agreed to a sentence. If the confirming call could carry new
    // values, the read-back would be theatre: the model could show one thing and
    // write another, and every guarantee above it would be worth nothing.
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [proposed] = await turn(ctx, 'boiler check every 90 days', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Boiler check', everyDays: 90, area: 'Boiler room' } },
    ]);
    const [confirmed] = await turn(ctx, 'yes', [
      {
        name: 'staxis_set_up_preventive_task',
        args: { confirmToken: tokenOf(proposed)!, name: 'Something else entirely', everyDays: 1, area: 'Roof' },
      },
    ]);
    assert.equal(confirmed.ok, true, confirmed.error ?? '');

    const rows = (await pg.query<{ name: string; frequency_days: number; area: string | null }>(
      `select name, frequency_days, area from preventive_tasks
        where property_id = $1 and name in ('Boiler check', 'Something else entirely')`,
      [PID_A1],
    )).rows;
    assert.equal(rows.length, 1, 'the confirming call created something nobody agreed to');
    assert.equal(rows[0].name, 'Boiler check');
    assert.equal(rows[0].frequency_days, 90);
    assert.equal(rows[0].area, 'Boiler room');
  });

  test('a name the hotel already uses is refused rather than duplicated', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [again] = await turn(ctx, 'set up the roof check monthly', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'roof  CHECK', everyDays: 30 } },
    ]);
    assert.equal(again.ok, false);
    assert.match(again.error ?? '', /already has/i);
  });

  test('an interval nobody could have meant is refused, and a future last-done too', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [bad] = await turn(ctx, 'every 0 days', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Nonsense', everyDays: 0 } },
    ]);
    assert.equal(bad.ok, false);
    const [future] = await turn(ctx, 'last done next year', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Time travel', everyDays: 30, lastDone: '2099-01-01' } },
    ]);
    assert.equal(future.ok, false);
    assert.match(future.error ?? '', /future/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Equipment
// ═══════════════════════════════════════════════════════════════════════════

describe('putting equipment on the register by talking', () => {
  test('a room range becomes one asset per room, named and placed and attributed', async () => {
    const ctx = await chatCtx({
      accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner', displayName: 'Stale Alias',
    });
    const [proposed] = await turn(ctx, 'track our PTAC units, rooms 201 to 203, installed 2019', [
      { name: 'staxis_set_up_equipment', args: { name: 'PTAC', category: 'hvac', rooms: '201-203', installDate: '2019' } },
    ]);
    assert.equal(proposed.ok, true, proposed.error ?? '');
    assert.equal(proposed.data.willCreate, 3, 'the COUNT is what a manager checks');
    // The year they gave was widened to a date, and the tool says so rather than
    // letting the assumption pass as something they told us.
    assert.ok(proposed.data.assumption, 'a year was turned into a date with no note');
    assert.equal(
      await count('select count(*)::text as n from equipment where property_id = $1', [PID_A1]),
      0,
      'a proposal wrote to the register',
    );

    const [confirmed] = await turn(ctx, 'yes', [
      { name: 'staxis_set_up_equipment', args: { confirmToken: tokenOf(proposed)! } },
    ]);
    assert.equal(confirmed.ok, true, confirmed.error ?? '');
    assert.equal(confirmed.data.created, 3);

    const rows = (await pg.query<{
      name: string; category: string; location: string | null; install_date: string | null;
      created_by_name: string | null; created_from: string;
    }>(
      `select name, category, location, install_date, created_by_name, created_from
         from equipment where property_id = $1 order by name`,
      [PID_A1],
    )).rows;
    assert.deepEqual(rows.map((r) => r.name), ['PTAC 201', 'PTAC 202', 'PTAC 203']);
    assert.deepEqual(rows.map((r) => r.location), ['Room 201', 'Room 202', 'Room 203']);
    assert.ok(rows.every((r) => r.category === 'hvac'));
    assert.ok(rows.every((r) => new Date(r.install_date!).toISOString().startsWith('2019-01-01')));
    assert.ok(rows.every((r) => r.created_by_name === 'Ana'));
    assert.ok(rows.every((r) => r.created_from === 'manual'));
  });

  test('saying it again adds nothing — the register is not duplicated', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [proposed] = await turn(ctx, 'add the PTACs in 201 to 203', [
      { name: 'staxis_set_up_equipment', args: { name: 'PTAC', category: 'hvac', rooms: '201-203' } },
    ]);
    const [confirmed] = await turn(ctx, 'yes please', [
      { name: 'staxis_set_up_equipment', args: { confirmToken: tokenOf(proposed)! } },
    ]);
    assert.equal(confirmed.ok, true, confirmed.error ?? '');
    assert.equal(confirmed.data.created, 0);
    assert.equal(
      await count('select count(*)::text as n from equipment where property_id = $1', [PID_A1]),
      3,
    );
  });

  test('a range bigger than one sentence should carry is refused, not truncated', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [ran] = await turn(ctx, 'track every room', [
      { name: 'staxis_set_up_equipment', args: { name: 'PTAC', category: 'hvac', rooms: '100-400' } },
    ]);
    assert.equal(ran.ok, false);
    assert.match(ran.error ?? '', /smaller batches/i);
  });

  test('a token minted for a schedule cannot create equipment', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [proposed] = await turn(ctx, 'pool filter every 60 days', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Pool filter', everyDays: 60 } },
    ]);
    const [crossed] = await turn(ctx, 'yes', [
      { name: 'staxis_set_up_equipment', args: { confirmToken: tokenOf(proposed)! } },
    ]);
    assert.equal(crossed.ok, false);
    assert.match(crossed.error ?? '', /no proposal waiting/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The company rulebook
// ═══════════════════════════════════════════════════════════════════════════

describe('writing a company rule by talking', () => {
  test('a GM is told who can, by name, and nothing is stored', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_GIL, uid: UID_GIL, propertyId: PID_B1 });
    const [ran] = await turn(ctx, 'orders over $500 need VP approval', [
      { name: 'staxis_write_company_rule', args: { rule: 'Orders over $500 need VP approval.', topic: 'purchase_approval_threshold', category: 'money' } },
    ]);
    assert.equal(ran.ok, false, 'a GM wrote the company rulebook');
    // The refusal is useful: it names the people who can.
    assert.match(ran.error ?? '', /Bo|Vera/);
    assert.equal(
      await count('select count(*)::text as n from company_knowledge where organization_id = $1', [ORG_B]),
      0,
    );
  });

  test('an editor sees the rule Staxis will enforce before it is enforced', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_VERA, uid: UID_VERA, propertyId: PID_B1, displayName: 'Stale Alias' });
    const [proposed] = await turn(ctx, 'orders over $500 need VP approval', [
      { name: 'staxis_write_company_rule', args: { rule: 'Orders over $500 need VP approval.', topic: 'purchase_approval_threshold', category: 'money' } },
    ]);
    assert.equal(proposed.ok, true, proposed.error ?? '');
    const enforce = proposed.data.willEnforce as { en: string; es: string } | null;
    assert.ok(enforce, 'the money rule was proposed without saying what it will enforce');
    assert.match(enforce.en, /\$500/);
    assert.notEqual(enforce.en, enforce.es);
    assert.equal(
      await count('select count(*)::text as n from company_authority_rules where organization_id = $1', [ORG_B]),
      0,
      'a proposal froze an approval rule',
    );

    const [confirmed] = await turn(ctx, 'yes, exactly', [
      { name: 'staxis_write_company_rule', args: { confirmToken: tokenOf(proposed)! } },
    ]);
    assert.equal(confirmed.ok, true, confirmed.error ?? '');

    const fact = (await pg.query<{ content: string; review_state: string; source: string; created_by_name: string | null }>(
      `select content, review_state, source, created_by_name from company_knowledge
        where organization_id = $1 and topic = 'purchase_approval_threshold' and is_active`,
      [ORG_B],
    )).rows[0];
    assert.ok(fact, 'the rule was not written');
    assert.equal(fact.review_state, 'confirmed');
    assert.equal(fact.source, 'explicit_user');
    assert.equal(fact.created_by_name, 'Vera');

    const rule = (await pg.query<{ threshold_cents: string; approver_role: string; action_kind: string }>(
      `select threshold_cents, approver_role, action_kind from company_authority_rules
        where organization_id = $1 and is_active`,
      [ORG_B],
    )).rows[0];
    assert.ok(rule, 'the approval rule was not frozen');
    assert.equal(Number(rule.threshold_cents), 50_000);
    assert.equal(rule.approver_role, 'vp');
  });

  test('standing is re-checked at the write, not read off the proposal', async () => {
    // The company can change who may edit the book between the read-back and
    // the yes. The answer that governs the WRITE is the one that is true now —
    // a proposal is not a permission slip that outlives the rule it was made
    // under. (Found by mutation: deleting the confirm-half check left every
    // other test in this file green.)
    const ctx = await chatCtx({ accountId: ACCOUNT_VERA, uid: UID_VERA, propertyId: PID_B1 });
    const [proposed] = await turn(ctx, 'all our hotels use Ecolab', [
      { name: 'staxis_write_company_rule', args: { rule: 'All our hotels use Ecolab for chemicals.', topic: 'chemical_vendor', category: 'vendors' } },
    ]);
    assert.equal(proposed.ok, true, proposed.error ?? '');

    await pg.query(
      `insert into company_access_settings (organization_id, setting_key, setting_value)
       values ($1, 'rulebook_editors', 'owner_only')
       on conflict (organization_id, setting_key) do update set setting_value = 'owner_only'`,
      [ORG_B],
    );
    try {
      const [confirmed] = await turn(ctx, 'yes', [
        { name: 'staxis_write_company_rule', args: { confirmToken: tokenOf(proposed)! } },
      ]);
      assert.equal(confirmed.ok, false, 'a proposal outlived the rule that allowed it');
      assert.equal(
        await count(`select count(*)::text as n from company_knowledge where organization_id = $1 and topic = 'chemical_vendor'`, [ORG_B]),
        0,
      );
    } finally {
      await pg.query(
        `update company_access_settings set setting_value = 'owner_and_vp'
          where organization_id = $1 and setting_key = 'rulebook_editors'`,
        [ORG_B],
      );
    }
  });

  test('a confirmation token cannot overwrite a line created after the read-back', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_VERA, uid: UID_VERA, propertyId: PID_B1 });
    const [proposed] = await turn(ctx, 'all our hotels use Vendor A', [
      {
        name: 'staxis_write_company_rule',
        args: {
          rule: 'All our hotels use Vendor A.',
          topic: 'confirmation_race_vendor',
          category: 'vendors',
        },
      },
    ]);
    assert.equal(proposed.ok, true, proposed.error ?? '');
    await pg.query(
      `insert into company_knowledge (
         organization_id, topic, content, category, source, review_state
       ) values ($1, 'confirmation_race_vendor', 'An owner added Vendor B first.',
                 'vendors', 'explicit_user', 'confirmed')`,
      [ORG_B],
    );

    const [confirmed] = await turn(ctx, 'yes', [
      { name: 'staxis_write_company_rule', args: { confirmToken: tokenOf(proposed)! } },
    ]);
    assert.equal(confirmed.ok, false);
    assert.match(confirmed.error ?? '', /changed after the read-back|did not overwrite/i);
    assert.equal(
      (await pg.query<{ content: string }>(
        `select content from company_knowledge
         where organization_id = $1 and topic = 'confirmation_race_vendor' and is_active`,
        [ORG_B],
      )).rows[0].content,
      'An owner added Vendor B first.',
    );
  });

  test('a sentence naming two approvers stores NOTHING and asks', async () => {
    const before = await count('select count(*)::text as n from company_knowledge where organization_id = $1', [ORG_B]);
    const ctx = await chatCtx({ accountId: ACCOUNT_VERA, uid: UID_VERA, propertyId: PID_B1 });
    const [ran] = await turn(ctx, 'anything over $500 needs the owner or the VP', [
      { name: 'staxis_write_company_rule', args: { rule: 'Orders over $500 need owner or VP approval.', topic: 'big_orders', category: 'money' } },
    ]);
    assert.equal(ran.ok, false, 'an ambiguous money rule was accepted');
    assert.match(ran.error ?? '', /more than one approver/i);
    assert.match(ran.error ?? '', /NOTHING has been stored/);
    assert.equal(
      await count('select count(*)::text as n from company_knowledge where organization_id = $1', [ORG_B]),
      before,
      'an ambiguous rule left a row behind',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Approving, declining and undoing what Staxis proposes
// ═══════════════════════════════════════════════════════════════════════════

async function seedFinding(propertyId: string, opts: {
  dedupeKey: string;
  summary?: string;
  detectorId?: string;
  disposition?: string;
  priceCents?: [number, number] | null;
  judged?: { en: string; es: string } | null;
  judgedDisposition?: string | null;
}): Promise<string> {
  const r = await pg.query<{ id: string }>(
    `insert into public.findings
       (property_id, detector_id, dedupe_key, summary, severity, disposition, status,
        receipt_query_id, evidence, magnitude, price_low_cents, price_high_cents, price_basis,
        judged_summary_en, judged_summary_es, judged_disposition)
     values ($1,$2,$3,$4,'attention',$5,'open','probe_receipt',
             '{"queryId":"probe_receipt","params":{},"values":{},"basis":"basis"}'::jsonb,
             1,$6,$7,$8,$9,$10,$11)
     returning id`,
    [
      propertyId,
      opts.detectorId ?? 'probe_det',
      opts.dedupeKey,
      opts.summary ?? 'Room 214 keeps producing faults',
      opts.disposition ?? 'propose',
      opts.priceCents?.[0] ?? null,
      opts.priceCents?.[1] ?? null,
      opts.priceCents ? 'probe pricing' : null,
      opts.judged?.en ?? null,
      opts.judged?.es ?? null,
      opts.judgedDisposition ?? null,
    ],
  );
  return r.rows[0].id;
}

/** A confirmed company line plus the rule frozen from it — the state the
 *  rulebook screen (and the chat tool above) leaves behind. */
async function seedAuthorityRule(organizationId: string, rule: {
  actionKind: string;
  thresholdCents: number;
  approverRole: string;
}): Promise<void> {
  const fact = await pg.query<{ id: string }>(
    `insert into company_knowledge (organization_id, topic, content, category, source, review_state)
     values ($1, $2, $3, 'money', 'explicit_user', 'confirmed') returning id`,
    [organizationId, `fixture_${rule.actionKind}_${rule.thresholdCents}`, 'fixture rule'],
  );
  await pg.query(
    `insert into company_authority_rules
       (organization_id, action_kind, threshold_cents, threshold_inclusive, approver_role, source_fact_id)
     values ($1, $2, $3, false, $4, $5)`,
    [organizationId, rule.actionKind, rule.thresholdCents, rule.approverRole, fact.rows[0].id],
  );
}

/** The same draft a detector freezes: a work order for a location, resting on
 *  the number of open tickets there when the offer was made. */
async function attachWorkOrderOffer(propertyId: string, findingId: string, location: string): Promise<void> {
  const outcome = await proposeAction(propertyId, findingId, {
    kind: 'create_work_order',
    params: {
      location,
      description: `Full inspection of ${location} — repeated faults.`,
      severity: 'medium',
      submitted_by_name: 'Staxis',
      submitter_role: 'Staxis',
      outcome_check_days: 14,
    },
    verify: { location, window_days: 30, open_work_orders: 0 },
  });
  assert.equal(outcome, 'proposed', `fixture: the offer did not attach (${outcome})`);
}

describe('approving what Staxis proposed, in the conversation', () => {
  test('the read-back is Staxis\'s own offer, and approving runs it exactly once', async () => {
    const findingId = await seedFinding(PID_A1, { dedupeKey: 'approve:once', priceCents: [10_000, 20_000] });
    await attachWorkOrderOffer(PID_A1, findingId, 'Room 214');

    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [proposed] = await turn(ctx, 'what needs my decision?', [
      { name: 'staxis_decide_pending_action', args: { findingId, decision: 'approve' } },
    ]);
    assert.equal(proposed.ok, true, proposed.error ?? '');
    // The sentence is the catalog's, built from the frozen params — not the
    // model's reading of the finding.
    const offered = readBack(proposed);
    assert.match(offered.en, /Room 214/);
    assert.match(offered.es, /Room 214/);
    // The catalog writes the offer in BOTH languages, and the Spanish read-back
    // has to quote the Spanish one. A wrapper that differs only in its own
    // prefix ("Adelante con: Create a work order…") reads as Spanish and is not.
    assert.match(offered.en, /work order/i);
    assert.match(offered.es, /orden de trabajo/i);
    assert.doesNotMatch(offered.es, /work order/i, 'the Spanish read-back quoted the English offer');
    // The catalog's offer is itself a question, and dropping it whole into a
    // sentence that asks its own produced "…Room 214?. Right?" in the first live
    // conversation. One question mark per sentence.
    for (const sentence of [offered.en, offered.es]) {
      assert.doesNotMatch(sentence, /\?\s*\./, `double punctuation in: ${sentence}`);
    }
    assert.equal(
      await count('select count(*)::text as n from work_orders where property_id = $1', [PID_A1]),
      0,
      'listing a decision performed it',
    );

    const [approved] = await turn(ctx, 'yes, raise the work order', [
      { name: 'staxis_decide_pending_action', args: { confirmToken: tokenOf(proposed)! } },
    ]);
    assert.equal(approved.ok, true, approved.error ?? '');
    assert.equal(approved.data.code, 'executed');
    assert.equal(
      await count('select count(*)::text as n from work_orders where property_id = $1', [PID_A1]),
      1,
    );

    // A SECOND, INDEPENDENT yes — a fresh proposal, a fresh token, the same
    // offer. The database makes it one action; the tool reports what the
    // database said rather than claiming a second one.
    const [again] = await turn(ctx, 'actually do that one too', [
      { name: 'staxis_decide_pending_action', args: { findingId, decision: 'approve' } },
    ]);
    // The offer is no longer live, so the tool refuses at the proposal — the
    // strongest form of "once". If a future change lets it re-propose, the
    // execute call below is the second net.
    if (again.ok) {
      const [twice] = await turn(ctx, 'yes', [
        { name: 'staxis_decide_pending_action', args: { confirmToken: tokenOf(again)! } },
      ]);
      assert.equal(twice.data.code, 'already_executed', 'a second approval created a second action');
    } else {
      assert.match(again.error ?? '', /already been run|no longer live/i);
    }
    assert.equal(
      await count('select count(*)::text as n from work_orders where property_id = $1', [PID_A1]),
      1,
      'the hotel got two work orders from one offer',
    );
  });

  test('a rule-gated approval refuses in chat exactly as the card would, and names who signs', async () => {
    // Company B's rulebook, as it would be after somebody confirmed the line.
    // Written as SQL rather than through the chat because the RULE is the
    // fixture here and the GATE is what is under test; `create_work_order`
    // routes to the 'expense' kind (signoff.ts), which is what a repair is.
    await seedAuthorityRule(ORG_B, { actionKind: 'expense', thresholdCents: 50_000, approverRole: 'vp' });

    const findingId = await seedFinding(PID_B1, { dedupeKey: 'approve:locked', priceCents: [90_000, 120_000] });
    await attachWorkOrderOffer(PID_B1, findingId, 'Room 300');

    const ctx = await chatCtx({ accountId: ACCOUNT_GIL, uid: UID_GIL, propertyId: PID_B1 });
    const [ran] = await turn(ctx, 'go ahead and raise that', [
      { name: 'staxis_decide_pending_action', args: { findingId, decision: 'approve' } },
    ]);
    assert.equal(ran.ok, false, 'a GM approved past their company\'s sign-off rule');
    assert.match(ran.error ?? '', /Vera/, 'the refusal did not say who it is waiting on');
    assert.equal(
      await count('select count(*)::text as n from work_orders where property_id = $1', [PID_B1]),
      0,
    );
  });

  test('an unreadable rulebook refuses rather than guessing that nothing governs it', async () => {
    const findingId = await seedFinding(PID_B1, { dedupeKey: 'approve:unreadable', priceCents: [90_000, 120_000] });
    await attachWorkOrderOffer(PID_B1, findingId, 'Room 301');

    // The real fault this guards against: a stale PostgREST schema cache makes
    // one table unreadable, and a fail-open gate reads that as "no rule".
    // @ts-expect-error temporarily faulting one table on the singleton
    supabaseAdmin.from = (table: string) => (table === 'company_authority_rules'
      ? {
        select: () => {
          const builder: Record<string, unknown> = {
            then: (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'schema cache is stale' } }).then(res),
          };
          for (const op of ['eq', 'neq', 'in', 'is', 'gt', 'gte', 'lt', 'lte', 'not', 'order', 'limit', 'select']) {
            builder[op] = () => builder;
          }
          builder.maybeSingle = async () => ({ data: null, error: { message: 'schema cache is stale' } });
          return builder;
        },
      }
      : shim.from(table));
    try {
      const ctx = await chatCtx({ accountId: ACCOUNT_VERA, uid: UID_VERA, propertyId: PID_B1 });
      const [ran] = await turn(ctx, 'approve that one', [
        { name: 'staxis_decide_pending_action', args: { findingId, decision: 'approve' } },
      ]);
      assert.equal(ran.ok, false, 'an unreadable rulebook was treated as no rulebook');
      assert.match(ran.error ?? '', /could not read|try again/i);
    } finally {
      // @ts-expect-error restoring the pglite-backed client
      supabaseAdmin.from = shim.from;
    }
    assert.equal(
      await count('select count(*)::text as n from work_orders where property_id = $1 and room_number = $2', [PID_B1, 'Room 301']),
      0,
    );
  });

  test('declining and the other verdicts write exactly what the card\'s buttons write', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const cases: Array<[string, string]> = [
      ['not_doing_it', 'muted'],
      ['seen', 'known_problem'],
      ['handled', 'resolved'],
    ];
    for (const [decision, expected] of cases) {
      const findingId = await seedFinding(PID_A1, { dedupeKey: `verdict:${decision}`, disposition: 'recommend' });
      const [proposed] = await turn(ctx, `about that one — ${decision}`, [
        { name: 'staxis_decide_pending_action', args: { findingId, decision } },
      ]);
      assert.equal(proposed.ok, true, proposed.error ?? '');
      const stillOpen = (await pg.query<{ status: string }>('select status from findings where id = $1', [findingId])).rows[0];
      assert.equal(stillOpen.status, 'open', 'the proposal decided it');

      const [done] = await turn(ctx, 'yes', [
        { name: 'staxis_decide_pending_action', args: { confirmToken: tokenOf(proposed)! } },
      ]);
      assert.equal(done.ok, true, done.error ?? '');
      const row = (await pg.query<{ status: string; acted_count: string; resolved_at: string | null; status_changed_by: string | null }>(
        'select status, acted_count, resolved_at, status_changed_by from findings where id = $1',
        [findingId],
      )).rows[0];
      assert.equal(row.status, expected, `${decision} wrote ${row.status}`);
      assert.ok(Number(row.acted_count) > 0, 'a chat verdict did not count as engagement');
      assert.equal(row.status_changed_by, ACCOUNT_ANA);
      // Seen is not handled, in the data as well as on the screen.
      if (expected === 'known_problem') assert.equal(row.resolved_at, null);
      if (expected === 'resolved') assert.ok(row.resolved_at);
    }
  });

  test('undo reverses a fix that was run', async () => {
    const findingId = await seedFinding(PID_A1, { dedupeKey: 'approve:undo' });
    await attachWorkOrderOffer(PID_A1, findingId, 'Room 402');
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });

    const [proposed] = await turn(ctx, 'raise that one', [
      { name: 'staxis_decide_pending_action', args: { findingId, decision: 'approve' } },
    ]);
    await turn(ctx, 'yes', [{ name: 'staxis_decide_pending_action', args: { confirmToken: tokenOf(proposed)! } }]);
    assert.equal(
      await count('select count(*)::text as n from work_orders where property_id = $1 and room_number = $2', [PID_A1, 'Room 402']),
      1,
    );

    const [undoProposed] = await turn(ctx, 'actually, undo that', [
      { name: 'staxis_decide_pending_action', args: { findingId, decision: 'undo' } },
    ]);
    assert.equal(undoProposed.ok, true, undoProposed.error ?? '');
    // This finding carries no price, so the quoted offer sits directly against
    // the read-back's own question — which is where "…Room 402?. Right?" showed
    // up in the first live conversation.
    for (const sentence of [readBack(undoProposed).en, readBack(undoProposed).es]) {
      assert.doesNotMatch(sentence, /\?\s*\./, `double punctuation in: ${sentence}`);
    }
    const [undone] = await turn(ctx, 'yes please', [
      { name: 'staxis_decide_pending_action', args: { confirmToken: tokenOf(undoProposed)! } },
    ]);
    assert.equal(undone.ok, true, undone.error ?? '');
    assert.equal(
      await count('select count(*)::text as n from work_orders where property_id = $1 and room_number = $2', [PID_A1, 'Room 402']),
      0,
      'undo left the work order on the board',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The one question a day
// ═══════════════════════════════════════════════════════════════════════════

describe('answering Staxis\'s question in the chat', () => {
  test('the question is served once, answered once, and never asked again', async () => {
    await seedFinding(PID_A1, {
      dedupeKey: 'ask:room214',
      detectorId: 'probe_ask_det',
      judgedDisposition: 'ask',
      judged: {
        en: 'Room 214 has had four HVAC tickets in 30 days — known problem room?',
        es: 'La habitación 214 tuvo cuatro órdenes de climatización en 30 días — ¿es un problema conocido?',
      },
    });

    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [asked] = await turn(ctx, 'anything you need from me?', [
      { name: 'staxis_todays_question', args: {} },
    ]);
    assert.equal(asked.ok, true, asked.error ?? '');
    const back = readBack(asked);
    assert.match(back.en, /Room 214/);
    assert.notEqual(back.en, back.es);
    const token = tokenOf(asked)!;

    // Serving RECORDS the ask — which is what makes "one a day" true, and it
    // has to be true across surfaces or the card would ask it again tonight.
    assert.equal(
      await count(`select count(*)::text as n from agent_knowledge_questions where property_id = $1 and status = 'asked'`, [PID_A1]),
      1,
    );

    // Asked again the same day: nothing. The drip module owns that rule and the
    // chat inherits it rather than re-implementing it.
    const [twice] = await turn(ctx, 'anything else?', [{ name: 'staxis_todays_question', args: {} }]);
    assert.equal(twice.ok, true);
    assert.equal(twice.data.question, null, 'the chat asked a second question the same day');

    const [answered] = await turn(ctx, 'yes, that room is a known problem', [
      { name: 'staxis_todays_question', args: { answer: 'yes', confirmToken: token } },
    ]);
    assert.equal(answered.ok, true, answered.error ?? '');
    assert.equal(answered.data.recorded, true);
    assert.equal(answered.data.storedFact, true);

    const ledger = (await pg.query<{ status: string; answered_by_account_id: string | null }>(
      'select status, answered_by_account_id from agent_knowledge_questions where property_id = $1',
      [PID_A1],
    )).rows[0];
    assert.equal(ledger.status, 'answered_yes');
    assert.equal(ledger.answered_by_account_id, ACCOUNT_ANA);

    // The yes became a human-authored fact — the whole point of asking.
    const fact = (await pg.query<{ source: string; confidence: string; created_by_name: string | null }>(
      `select source, confidence, created_by_name from agent_memory where property_id = $1 and is_active`,
      [PID_A1],
    )).rows[0];
    assert.ok(fact, 'a yes stored no fact');
    assert.equal(fact.source, 'explicit_user');
    assert.equal(fact.confidence, 'high');
  });

  test('an answer with no question behind it records nothing', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [ran] = await turn(ctx, 'yes', [
      { name: 'staxis_todays_question', args: { answer: 'yes', confirmToken: '99999999-8888-4777-8666-555555555555' } },
    ]);
    assert.equal(ran.ok, false);
    assert.match(ran.error ?? '', /no proposal waiting/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. The walls
// ═══════════════════════════════════════════════════════════════════════════

/** Every tool that confirms in the conversation — from the registry, never a
 *  hand-kept list, so a sixth one is walled the day it is registered. */
function doToolNames(): string[] {
  return listAllTools().filter((t) => t.confirmInChat === true).map((t) => t.name).sort();
}

describe('the walls hold on every DO tool', () => {
  test('there are DO tools to test, and they all declare themselves mutations', () => {
    const names = doToolNames();
    assert.ok(names.length >= 5, `only ${names.length} DO tools found`);
    for (const name of names) {
      const tool = listAllTools().find((t) => t.name === name)!;
      assert.equal(tool.mutates, true);
      assert.deepEqual(tool.surfaces ?? ['chat'], ['chat'], `${name} is reachable from another surface`);
    }
  });

  test('a housekeeper cannot reach any of them', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'housekeeping' });
    for (const name of doToolNames()) {
      const result = await executeTool(name, {}, ctx);
      assert.equal(result.ok, false, `${name} ran for a housekeeper`);
      assert.match(result.error ?? '', /not allowed to use/);
    }
  });

  test('a proposal made at one hotel cannot be confirmed at another', async () => {
    const ctxA = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [proposed] = await turn(ctxA, 'add a lobby light check every 90 days', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Lobby light check', everyDays: 90 } },
    ]);
    const token = tokenOf(proposed)!;

    // The SAME conversation id, carried to hotel B. The transcript read is
    // hotel-scoped, so the proposal is not there to be found.
    const ctxB: ToolContext = {
      ...ctxA,
      propertyId: PID_B1,
      user: { ...ctxA.user, accountId: ACCOUNT_ANA, propertyAccess: [PID_B1] },
    };
    const stolen = await executeTool('staxis_set_up_preventive_task', { confirmToken: token }, ctxB);
    assert.equal(stolen.ok, false, 'hotel A\'s proposal was confirmed at hotel B');
    assert.equal(
      await count('select count(*)::text as n from preventive_tasks where property_id = $1', [PID_B1]),
      0,
    );
  });

  test('a proposal cannot be confirmed from a different conversation', async () => {
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [proposed] = await turn(ctx, 'add a generator test every 30 days', [
      { name: 'staxis_set_up_preventive_task', args: { name: 'Generator test', everyDays: 30 } },
    ]);
    const other = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [elsewhere] = await turn(other, 'yes', [
      { name: 'staxis_set_up_preventive_task', args: { confirmToken: tokenOf(proposed)! } },
    ]);
    assert.equal(elsewhere.ok, false);
    assert.equal(
      await count(`select count(*)::text as n from preventive_tasks where property_id = $1 and name = 'Generator test'`, [PID_A1]),
      0,
    );
  });

  test('a decision cannot be taken about another hotel\'s finding', async () => {
    const bId = await seedFinding(PID_B1, { dedupeKey: 'wall:cross-hotel' });
    const ctx = await chatCtx({ accountId: ACCOUNT_ANA, uid: UID_ANA, propertyId: PID_A1, role: 'owner' });
    const [ran] = await turn(ctx, 'mute that one', [
      { name: 'staxis_decide_pending_action', args: { findingId: bId, decision: 'not_doing_it' } },
    ]);
    assert.equal(ran.ok, false, 'hotel A decided hotel B\'s finding');
    const row = (await pg.query<{ status: string }>('select status from findings where id = $1', [bId])).rows[0];
    assert.equal(row.status, 'open');
  });
});
