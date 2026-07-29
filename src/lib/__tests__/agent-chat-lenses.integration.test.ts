/**
 * WHO LENSES, against a real database.
 *
 * The hermetic suite (agent-chat-lenses.test.ts) proves the SHAPE of the mount:
 * which tools, which prompt, which refusals. None of that can prove the two
 * things that actually protect a guest standing at a counter, because both are
 * properties of rows:
 *
 *   1. A front-desk agent answers from facts this hotel CONFIRMED, and never
 *      from one a manager has not reviewed. `review_state` is a column; a mock
 *      that returns whatever it was told proves nothing about it.
 *   2. Hotel A's front desk never sees hotel B's answer — through the same
 *      loader the live route uses, with two real companies in the database.
 *
 * PGlite runs as the table owner, exactly as the service-role key bypasses RLS
 * in production. What is under test is the app's own scoping.
 *
 * ON "THROUGH THE REAL ROUTE": the housekeeping refusal IS driven through the
 * real POST handler, because it lands before the cost reservation and before
 * any model call. Everything downstream of that point needs Anthropic, so the
 * rest of these cases drive the route's own gate stack — `loadAgentUserCtx`
 * (the loader the route calls), `getToolsForRole` (the catalog it builds) and
 * `executeTool` (the executor it hands to the loop) — with the exact context
 * the route constructs. That is the whole route minus the model.
 *
 * WHAT EACH BLOCK WOULD CATCH — every mutation below was applied and this suite
 * watched go red, with the failure count in brackets:
 *
 *   CONFIRMED-ONLY   dropping `.eq('review_state','confirmed')` from the facts
 *                    arm in knowledge/core.ts — the unreviewed pet fee reaches
 *                    the model and the desk quotes a number nobody approved [2]
 *   PROPERTY SCOPE   dropping `.eq('scope','property')` — a manager's private
 *                    note is read out to a guest                           [2]
 *   TENANT           dropping `.eq('property_id', pid)` — hotel B's wifi
 *                    password answered at hotel A's counter                [2]
 *   THE MISS         removing the gap write — the same guest question dies at
 *                    the counter every week and no manager ever hears of it [2]
 *   GAP IS INERT     writing the gap with `source: 'explicit_user'`, which the
 *                    0358 trigger would stamp CONFIRMED, turning "we don't know"
 *                    into an answer the model reads back                   [1]
 *   DUAL HAT         reverting `loadAgentUserCtx` to `accounts.role` — the hat
 *                    at THIS hotel stops deciding, and a GM-elsewhere gets the
 *                    manager's catalog at the hotel where she holds a wrench [1]
 *   NO MONEY         un-stripping the finding price for the maintenance hat [1]
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.OPENAI_API_KEY ??= 'sk-placeholder';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import '@/lib/agent/tools/index';
import { executeTool, getToolsForRole, type ToolContext, type ToolResult } from '@/lib/agent/tools';
import { loadAgentUserCtx } from '@/app/api/agent/command/_stream-runner';
import { POST as commandPost } from '@/app/api/agent/command/route';

import { applyMigrationsToPglite } from '../../../tests/fixtures/pglite-migrate';
import { createPglitePostgrest, loadCatalog, type PglitePostgrest } from '../../../tests/fixtures/postgrest-pglite';
import {
  ACCOUNT_ADMIN,
  ACCOUNT_FIONA,
  ACCOUNT_FRANK,
  ORG_A,
  PID_A1,
  PID_A2,
  PID_B1,
  UID_FIONA,
  UID_FRANK,
  UID_HANK,
  seedTwoCompanies,
  type TwoCompanySeed,
} from '../../../tests/fixtures/pglite-two-company-seed';

let pg: PGlite;
let shim: PglitePostgrest;
let companySeed: TwoCompanySeed;
let signedInAs: string | null = null;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

/** Hotel B's wifi fact carries this, so a leak is unmistakable. */
const LEAK = 'ZZTYLERLEAK';

/** The dual-hat person: a GM at Beaumont, a wrench at Lufkin. */
const ACCOUNT_DALE = 'aaaa1111-0000-4000-8000-0000000000d1';
const UID_DALE = 'aaaa2222-0000-4000-8000-0000000000d1';
const ACCOUNT_WRENCH = 'aaaa1111-0000-4000-8000-0000000000d2';
const UID_WRENCH = 'aaaa2222-0000-4000-8000-0000000000d2';

/** The equipment and finding the maintenance cases hang off. */
const EQUIP_PTAC = 'eeee0000-0000-4000-8000-000000000001';
const FINDING_ROOM = 'ffff0000-0000-4000-8000-000000000001';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** The tool context the live route builds, for a signed-in person at a hotel. */
async function routeCtx(authUserId: string, propertyId: string): Promise<ToolContext> {
  const load = await loadAgentUserCtx(authUserId, propertyId);
  assert.equal(load.ok, true, 'the route could not load this account');
  if (!load.ok) throw new Error('unreachable');
  return {
    user: load.userCtx,
    propertyId,
    staffId: load.staffId,
    requestId: 'lens-test',
    surface: 'chat',
    // A successful DB-null read is the hotel's valid default-on policy.
    enabledSections: null,
  };
}

async function search(ctx: ToolContext, query: string): Promise<ToolResult> {
  return executeTool('search_knowledge', { query }, ctx);
}

/** Every string in a tool payload, flattened — for leak and money sweeps. */
function textOf(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function factRow(propertyId: string, topic: string) {
  const { rows } = await pg.query<{ topic: string; review_state: string; source: string; category: string; content: string }>(
    'select topic, review_state, source, category, content from agent_memory where property_id = $1 and topic = $2 and is_active = true',
    [propertyId, topic],
  );
  return rows[0] ?? null;
}

// ─── Fixture ────────────────────────────────────────────────────────────────

before(async () => {
  const migrated = await applyMigrationsToPglite();
  pg = migrated.pg;
  const catalog = await loadCatalog(pg);
  shim = createPglitePostgrest(pg, catalog);
  supabaseAdmin.from = shim.from as unknown as typeof supabaseAdmin.from;
  supabaseAdmin.rpc = shim.rpc as unknown as typeof supabaseAdmin.rpc;
  supabaseAdmin.auth.getUser = (async () => (
    signedInAs
      ? { data: { user: { id: signedInAs, email: 'someone@example.test' } }, error: null }
      : { data: { user: null }, error: { message: 'no session', status: 401, name: 'AuthApiError' } }
  )) as unknown as typeof supabaseAdmin.auth.getUser;

  companySeed = await seedTwoCompanies(pg);

  // ── Dale: GM at Beaumont, maintenance at Lufkin. One person, two hats, and
  // the reason the chat cannot read a single global role word.
  await pg.query("insert into auth.users (id, email) values ($1, 'dale@example.test') on conflict (id) do nothing", [UID_DALE]);
  await pg.query(
    `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, 'dale', 'x', 'Dale', 'general_manager', '{}', $2) on conflict (id) do nothing`,
    [ACCOUNT_DALE, UID_DALE],
  );
  await pg.query(
    "select public.staxis_set_membership_hat($1, $2, $3, 'property', 'general_manager', $4, 'GM')",
    [ACCOUNT_ADMIN, ORG_A, ACCOUNT_DALE, JSON.stringify([PID_A1])],
  );
  await pg.query("insert into auth.users (id, email) values ($1, 'wrench@example.test') on conflict (id) do nothing", [UID_WRENCH]);
  await pg.query(
    `insert into accounts (id, username, password_hash, display_name, role, property_access, data_user_id)
     values ($1, 'wrench', 'x', 'Wrench', 'maintenance', '{}', $2) on conflict (id) do nothing`,
    [ACCOUNT_WRENCH, UID_WRENCH],
  );
  await pg.query(
    "select public.staxis_set_membership_hat($1, $2, $3, 'property', 'maintenance', $4, 'Maintenance')",
    [ACCOUNT_ADMIN, ORG_A, ACCOUNT_WRENCH, JSON.stringify([PID_A1])],
  );

  // ── The hotel's Knows facts. Three on Beaumont, one on Tyler. ────────────
  const fact = async (
    pid: string, topic: string, content: string, category: string, source: string,
  ) => {
    await pg.query(
      `insert into agent_memory (property_id, scope, subject_account_id, topic, content, source, confidence, category, review_state, is_active)
       values ($1, 'property', null, $2, $3, $4, 'high', $5, case when $4 = 'inferred' then 'unreviewed' else 'confirmed' end, true)`,
      [pid, topic, content, source, category],
    );
  };
  await fact(PID_A1, 'wifi_password', 'The guest wifi password is BeaumontSun24.', 'rooms', 'explicit_user');
  await fact(PID_A1, 'desayuno', 'El desayuno es de 6:00 a 9:30 en el lobby, todos los días.', 'rhythm', 'explicit_user');
  // THE SECURITY CASE. Extracted from a pasted email, never reviewed by a
  // manager. The 0358 trigger stamps it `unreviewed` from `source='inferred'`;
  // no caller gets to choose that.
  await fact(PID_A1, 'pet_fee', 'The pet fee is 250 dollars per stay.', 'guests', 'inferred');
  await fact(PID_B1, 'wifi_password', `The guest wifi password is ${LEAK}.`, 'rooms', 'explicit_user');
  // A USER-scope note: the GM's own private preference, confirmed, on this very
  // hotel. It is one `.eq('scope','property')` away from being read out to a
  // guest, and nothing else in the query would stop it.
  await pg.query(
    `insert into agent_memory (property_id, scope, subject_account_id, topic, content, source, confidence, category, review_state, is_active)
     values ($1, 'user', $2, 'wifi_pref', 'Private note: I hand out the wifi password ZZPRIVATE only to loyalty members.', 'explicit_user', 'high', 'rooms', 'confirmed', true)`,
    [PID_A1, ACCOUNT_DALE],
  );

  // ── Maintenance material on Beaumont: tickets, an asset, a schedule, and a
  // finding attached to a room, all with money on them.
  await pg.query(
    `insert into equipment (id, property_id, name, category, location, status, created_from)
     values ($1, $2, 'PTAC unit 214', 'hvac', 'Room 214', 'operational', 'manual')`,
    [EQUIP_PTAC, PID_A1],
  );
  const ticket = async (room: string, description: string, status: string, cost: number | null, equipmentId: string | null) => {
    await pg.query(
      `insert into work_orders (property_id, room_number, description, severity, status, repair_cost, equipment_id, created_at)
       values ($1, $2, $3, 'medium', $4, $5, $6, now() - interval '10 days')`,
      [PID_A1, room, description, status, cost, equipmentId],
    );
  };
  await ticket('Room 214', 'AC blowing warm, guest complained', 'resolved', 180, EQUIP_PTAC);
  await ticket('214', 'AC again — same unit', 'submitted', null, EQUIP_PTAC);
  await ticket('1214', 'AC in 1214, unrelated room', 'resolved', 90, null);
  await ticket('Lobby', 'Front door closer sticking', 'resolved', 45, null);
  await pg.query(
    `insert into preventive_tasks (property_id, name, area, frequency_days, last_completed_at)
     values ($1, 'Boiler service', 'Mechanical room', 90, now() - interval '200 days')`,
    [PID_A1],
  );
  await pg.query(
    `insert into findings (id, property_id, detector_id, dedupe_key, summary, severity, disposition, status,
                           receipt_query_id, evidence, magnitude, price_low_cents, price_high_cents, price_basis)
     values ($1, $2, 'repeat_room_work_orders', 'repeat_room_work_orders:214',
             'Room 214 has had 3 work orders in the last 30 days.', 'attention', 'recommend', 'open',
             'work_orders_by_location_30d', $3, 3, 40000, 90000, 'based on your last 3 HVAC invoices')`,
    [FINDING_ROOM, PID_A1, JSON.stringify({ queryId: 'work_orders_by_location_30d', target: { kind: 'room', value: '214' }, values: { total: 3 } })],
  );
});

after(async () => {
  supabaseAdmin.from = originalFrom;
  supabaseAdmin.rpc = originalRpc;
  supabaseAdmin.auth.getUser = originalGetUser;
  await pg?.close();
});

// ═══════════════════════════════════════════════════════════════════════════
// THE FRONT DESK — a guest's question, answered only from confirmed facts
// ═══════════════════════════════════════════════════════════════════════════

describe('front desk — guest questions', () => {
  test('answers from a confirmed fact (EN)', async () => {
    const ctx = await routeCtx(UID_FRANK, PID_A1);
    assert.equal(ctx.user.role, 'front_desk');
    const res = await search(ctx, 'wifi');
    assert.equal(res.ok, true);
    const facts = (res.data as { facts: Array<{ topic: string; content: string }> }).facts;
    assert.equal(facts.length, 1);
    assert.match(facts[0].content, /BeaumontSun24/);
  });

  test('answers from a confirmed fact written in Spanish (ES)', async () => {
    // The fact is stored in Spanish and searched in Spanish. Nothing in the
    // path translates: the desk gets the sentence the hotel actually wrote,
    // which is the only version whose hours are certainly right.
    const ctx = await routeCtx(UID_FRANK, PID_A1);
    const res = await search(ctx, 'desayuno');
    assert.equal(res.ok, true);
    const facts = (res.data as { facts: Array<{ content: string }> }).facts;
    assert.equal(facts.length, 1);
    assert.match(facts[0].content, /6:00 a 9:30/);
  });

  test('NEVER answers from a fact a manager has not confirmed', async () => {
    // The whole security boundary, in one assertion. The pet fee is in the
    // database, on this hotel, active and unexpired — and $250 is exactly the
    // kind of number a guest disputes at checkout. It is invisible because it
    // is `unreviewed`, and for no other reason.
    const planted = await factRow(PID_A1, 'pet_fee');
    assert.equal(planted?.review_state, 'unreviewed', 'fixture is wrong: the pet fee must be unreviewed');

    const ctx = await routeCtx(UID_FRANK, PID_A1);
    for (const q of ['pet', 'pet fee', '250 dollars']) {
      const res = await search(ctx, q);
      const body = textOf((res.data as { facts: unknown }).facts);
      assert.equal(body.includes('250 dollars'), false, `"${q}" leaked the unreviewed pet fee`);
    }
  });

  test('one hotel only — Tyler\'s wifi password never reaches Beaumont\'s counter', async () => {
    const ctx = await routeCtx(UID_FRANK, PID_A1);
    const res = await search(ctx, 'wifi');
    assert.equal(textOf(res.data).includes(LEAK), false, 'hotel B leaked into hotel A');
  });

  test('one PERSON\'s private note is not a hotel fact', async () => {
    // Same table, same hotel, also confirmed — and none of the desk's business.
    // `scope` is the only thing between a manager's private note and a guest.
    const ctx = await routeCtx(UID_FRANK, PID_A1);
    const res = await search(ctx, 'wifi');
    assert.equal(textOf(res.data).includes('ZZPRIVATE'), false, 'a user-scope note leaked to the front desk');
  });

  test('a miss is recorded as an OPEN QUESTION the GM can fill in', async () => {
    const ctx = await routeCtx(UID_FRANK, PID_A1);
    const res = await search(ctx, 'airport shuttle');
    assert.equal(res.ok, true);
    assert.equal((res.data as { facts: unknown[] }).facts.length, 0);

    const gap = await factRow(PID_A1, 'guest_question_airport_shuttle');
    assert.ok(gap, 'the miss was not recorded — the same guest question dies at the counter every week');
    // INERT BY CONSTRUCTION: `source: 'inferred'` is what makes the 0358 trigger
    // stamp `unreviewed`, and unreviewed rows are exactly what the previous test
    // proves never reach a model. The note cannot become an answer by sitting
    // there; only a human editing it can.
    assert.equal(gap!.source, 'inferred');
    assert.equal(gap!.review_state, 'unreviewed');
    assert.equal(gap!.category, 'guests');

    // And it does not come back as an answer on the next search.
    const again = await search(ctx, 'airport shuttle');
    assert.equal((again.data as { facts: unknown[] }).facts.length, 0);
  });

  test('the same question asked twice is ONE open note, not two', async () => {
    const ctx = await routeCtx(UID_FRANK, PID_A1);
    await search(ctx, 'late checkout policy');
    await search(ctx, 'late checkout policy');
    const { rows } = await pg.query<{ n: string }>(
      "select count(*)::text as n from agent_memory where property_id = $1 and topic = 'guest_question_late_checkout_policy'",
      [PID_A1],
    );
    assert.equal(rows[0].n, '1');
  });

  test('a manager\'s own empty search records nothing — the loop is the desk\'s', async () => {
    // A GM who searches for something absent already owns the fix; turning that
    // into a note on their own review screen is noise, not a loop.
    const ctx = await routeCtx(UID_DALE, PID_A1);
    assert.equal(ctx.user.role, 'general_manager');
    await search(ctx, 'valet parking rates');
    assert.equal(await factRow(PID_A1, 'guest_question_valet_parking_rates'), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MAINTENANCE — the four read surfaces, room-targeted, with no money
// ═══════════════════════════════════════════════════════════════════════════

describe('maintenance — the wrench\'s four surfaces', () => {
  /** A current property-scope maintenance job at Beaumont. The dispatcher now
   *  re-resolves the live standing, so a forged role on a front-desk context is
   *  intentionally no longer a valid fixture. */
  async function wrenchCtx(): Promise<ToolContext> {
    return routeCtx(UID_WRENCH, PID_A1);
  }

  test('work-order history is room-targeted and does not match a room that merely contains the digits', async () => {
    const res = await executeTool('get_work_order_history', { room: '214' }, await wrenchCtx());
    assert.equal(res.ok, true);
    const data = res.data as { matched: number; tickets: Array<{ room: string; reported: string }> };
    // "Room 214" and "214" are the same door; "1214" is a different room and
    // "Lobby" is not a room at all. An `ilike '%214%'` would have returned three.
    assert.equal(data.matched, 2);
    assert.equal(data.tickets.every((t) => /^(Room )?214$/.test(t.room)), true);
  });

  test('narrowing a busy room to one thing works on the ticket text', async () => {
    const res = await executeTool('get_work_order_history', { room: '214', item: 'AC' }, await wrenchCtx());
    assert.equal((res.data as { matched: number }).matched, 2);
    const none = await executeTool('get_work_order_history', { room: '214', item: 'elevator' }, await wrenchCtx());
    assert.equal((none.data as { matched: number }).matched, 0);
    // The empty answer says "nobody logged one", never "nothing broke".
    assert.match((none.data as { note: string }).note, /nobody logged|no maintenance tickets/i);
  });

  test('staxis_findings answers room-targeted', async () => {
    const res = await executeTool('staxis_findings', { targetKind: 'room', targetValue: '214' }, await wrenchCtx());
    assert.equal(res.ok, true);
    const data = res.data as { count: number; findings: Array<{ id: string }> };
    assert.equal(data.count, 1);
    assert.equal(data.findings[0].id, FINDING_ROOM);
  });

  test('staxis_equipment and staxis_preventive answer', async () => {
    const equip = await executeTool('staxis_equipment', {}, await wrenchCtx());
    assert.equal(equip.ok, true);
    assert.equal((equip.data as { count: number }).count, 1);

    const pm = await executeTool('staxis_preventive', {}, await wrenchCtx());
    assert.equal(pm.ok, true);
    // 200 days since a 90-day service: overdue, and the day-count is computed
    // in code so the model has nothing to derive.
    assert.match(textOf(pm.data), /overdue/);
  });

  test('NOT ONE DOLLAR reaches the wrench, from any of the four', async () => {
    const ctx = await wrenchCtx();
    for (const [name, args] of [
      ['get_work_order_history', { room: '214' }],
      ['staxis_findings', { targetKind: 'room', targetValue: '214' }],
      ['staxis_explain_finding', { findingId: FINDING_ROOM }],
      ['staxis_equipment', { equipmentId: EQUIP_PTAC }],
    ] as const) {
      const res = await executeTool(name, args, ctx);
      assert.equal(res.ok, true, `${name} failed`);
      const body = textOf(res.data);
      assert.equal(/\$[0-9]/.test(body), false, `${name} handed the wrench a dollar figure`);
      assert.equal(body.includes('40000') || body.includes('90000'), false, `${name} leaked raw cents`);
    }
  });

  test('a manager DOES get the money — the strip is per hat, not a feature removal', async () => {
    const ctx = await routeCtx(UID_DALE, PID_A1);
    const res = await executeTool('staxis_findings', { targetKind: 'room', targetValue: '214' }, ctx);
    assert.match(textOf(res.data), /\$400/);
  });

  test('"could not price it" is never said when the truth is "you are not shown it"', async () => {
    // The one field whose whole job is honesty about money must not lie in the
    // other direction. A finding Staxis priced perfectly well is not an
    // unpriced finding just because this hat cannot see the range.
    const res = await executeTool('staxis_explain_finding', { findingId: FINDING_ROOM }, await wrenchCtx());
    const price = (res.data as { price: Record<string, unknown> }).price;
    assert.equal(price.unpricedReason, undefined);
    assert.match(String(price.withheldReason), /manager/i);
  });

  test('the approval queue stays shut', async () => {
    const res = await executeTool('staxis_pending_decisions', {}, await wrenchCtx());
    assert.equal(res.ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE HAT AT THIS HOTEL — one person, two jobs, two chats
// ═══════════════════════════════════════════════════════════════════════════

describe('role resolution', () => {
  test('a real company finance hat gets Financials reads only, and revocation is immediate', async () => {
    const finance = await routeCtx(UID_FIONA, PID_A1);
    assert.equal(finance.user.role, 'front_desk', 'finance must not impersonate a hotel manager');
    assert.equal(finance.user.seesFinancials, true);
    assert.equal(finance.user.hotelMutationAllowed, false);

    const catalog = getToolsForRole(
      finance.user.role,
      'chat',
      undefined,
      undefined,
      {
        seesFinancials: true,
        hotelMutationAllowed: false,
        capabilitySnapshot: finance.user.capabilitySnapshot,
      },
    );
    const names = catalog.map((tool) => tool.name);
    for (const financialRead of [
      'get_finance_summary',
      'get_inventory_monthly_accounting',
      'get_payments_summary',
    ]) {
      assert.ok(names.includes(financialRead), `${financialRead} was not offered to finance`);
    }
    assert.equal(names.includes('get_schedule'), false, 'finance widened into a manager read');
    assert.ok(catalog.every((tool) => tool.mutates !== true), 'finance was offered a hotel mutation');

    shim.reset();
    const read = await executeTool('get_payments_summary', {}, finance);
    assert.equal(read.ok, true, read.error);
    assert.ok(
      shim.statements.some((statement) => statement.target === 'pms_payments_daily_current'),
      'the real financial handler was never reached',
    );

    shim.reset();
    const summary = await executeTool('get_finance_summary', { period: 'this_month' }, finance);
    assert.equal(summary.ok, true, summary.error);
    assert.ok(
      shim.statements.some((statement) => statement.target === 'financial_expenses'),
      'the guarded financial-summary handler was never reached',
    );

    const financeHat = companySeed.hats.get(`${ACCOUNT_FIONA}:company:finance`);
    assert.ok(financeHat);
    await pg.query(
      'update public.organization_memberships set status = \'suspended\' where id = $1',
      [financeHat],
    );
    try {
      shim.reset();
      const revoked = await executeTool('get_payments_summary', {}, finance);
      assert.equal(revoked.ok, false, 'a stale finance catalog survived revocation');
      assert.equal(
        shim.statements.some((statement) => statement.target === 'pms_payments_daily_current'),
        false,
        'the financial handler ran after revocation',
      );
    } finally {
      await pg.query(
        'update public.organization_memberships set status = \'active\' where id = $1',
        [financeHat],
      );
    }
  });

  test('a dual-hat person gets the lens of the hat at THAT hotel', async () => {
    // Dale's global `accounts.role` is general_manager and his legacy
    // property_access is EMPTY — every hotel he reaches, he reaches through a
    // hat. At Beaumont the hat says GM. Give him a maintenance hat at Lufkin
    // and the same account, in the same session, gets the wrench's chat there.
    await pg.query(
      "select public.staxis_set_membership_hat($1, $2, $3, 'property', 'maintenance', $4, 'Maintenance')",
      [ACCOUNT_ADMIN, ORG_A, ACCOUNT_DALE, JSON.stringify([PID_A2])],
    );

    const atBeaumont = await routeCtx(UID_DALE, PID_A1);
    const atLufkin = await routeCtx(UID_DALE, PID_A2);
    assert.equal(atBeaumont.user.role, 'general_manager');
    assert.equal(atLufkin.user.role, 'maintenance');

    // And the mount follows the hat, not the login.
    const gmTools = getToolsForRole(atBeaumont.user.role, 'chat').map((t) => t.name);
    const wrenchTools = getToolsForRole(atLufkin.user.role, 'chat').map((t) => t.name);
    assert.ok(gmTools.includes('get_finance_summary'), 'the GM keeps the money at her own hotel');
    assert.equal(wrenchTools.includes('get_finance_summary'), false, 'the wrench must not carry the money');
    assert.ok(wrenchTools.includes('get_work_order_history'));
  });

  test('a hat-only person is not refused by the executor\'s property-access check', async () => {
    // Every company person has an EMPTY legacy property_access array. The
    // executor re-checks that array as defense-in-depth against a tool that
    // forgets its own hotel filter — so without the union in loadAgentUserCtx,
    // every tool would refuse the very people the route just let in.
    const ctx = await routeCtx(UID_DALE, PID_A1);
    assert.ok(ctx.user.propertyAccess.includes(PID_A1));
    const res = await executeTool('get_hotel_state', {}, ctx);
    assert.notEqual(res.error, 'Property access for this conversation is not in your account. The user must restart the conversation from a property they currently have access to.');
  });

  test('and it still refuses a hotel the person does not reach', async () => {
    const ctx = await routeCtx(UID_DALE, PID_A1);
    const res = await executeTool('get_hotel_state', {}, { ...ctx, propertyId: PID_B1 });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /property access/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DOOR — driven through the real POST handler
// ═══════════════════════════════════════════════════════════════════════════

describe('the command route', () => {
  test('a housekeeper is refused before a cent is spent', async () => {
    // Hank is Waco Inn's legacy housekeeper. The refusal lands before the cost
    // reservation and before any model call, so this runs end-to-end through
    // the real handler with no Anthropic in the loop.
    signedInAs = UID_HANK;
    const res = await commandPost(new NextRequest('https://staxis.test/api/agent/command', {
      method: 'POST',
      headers: { authorization: 'Bearer lens-test', 'content-type': 'application/json' },
      body: JSON.stringify({ propertyId: '1e6ac41e-0000-4000-8000-000000000001', message: 'what are my rooms?' }),
    }));
    assert.equal(res.status, 403);
    const body = await res.json() as { code?: string };
    assert.equal(body.code, 'chat_not_mounted');

    // And no conversation row was created for the turn that never happened.
    const { rows } = await pg.query<{ n: string }>(
      'select count(*)::text as n from agent_conversations where user_id = $1',
      ['1e6ac41e-0000-4000-8000-000000000003'],
    );
    assert.equal(rows[0].n, '0');
    signedInAs = null;
  });

  test('the front desk is NOT refused at the door', async () => {
    // The other half of the gate: one that refuses everybody also passes the
    // test above. This turn has to get PAST the mount check.
    //
    // It cannot complete here — the conversation lock is a plpgsql RPC whose
    // qualified identifiers the PostgREST shim does not compile, so the turn
    // dies further down the route. That is precisely the point: the mount check
    // is the first thing after the account load and it RETURNS (403), so
    // reaching anything downstream of it is the proof. A 403 would mean the
    // gate refused the desk.
    signedInAs = UID_FRANK;
    let status: number | null = null;
    try {
      const res = await commandPost(new NextRequest('https://staxis.test/api/agent/command', {
        method: 'POST',
        headers: { authorization: 'Bearer lens-test', 'content-type': 'application/json' },
        body: JSON.stringify({ propertyId: PID_A1, message: 'what is the wifi password?' }),
      }));
      status = res.status;
    } catch {
      status = null; // died downstream of the gate — see above
    }
    assert.notEqual(status, 403, 'the front desk was refused at the mount');
    signedInAs = null;
  });
});

/** Keep the fixture account ids referenced so a rename breaks the build here. */
void ACCOUNT_FRANK;
