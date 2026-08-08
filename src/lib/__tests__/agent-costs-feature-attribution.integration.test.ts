/**
 * PROOF, against a real Postgres, that the AI cost ledger can now answer "what
 * was this money FOR" — and that the answer is arrived at honestly.
 *
 * Migration 0374 gives `agent_costs` a `feature` column so an AI employee's
 * card can quote its own bill. Four things have to be true for that number to
 * mean anything, and a stubbed client would fake all four:
 *
 *   • EVERY NEW ROW CARRIES THE LABEL. Both halves of the write path — the
 *     background insert and the chat turn's reserve→finalize RPC — actually
 *     land a feature in the column. The compile-time half of this guarantee is
 *     asserted below with `@ts-expect-error`, which fails `npm run typecheck`
 *     if the parameter is ever made optional again.
 *   • THE OLD SIGNATURE STILL WORKS. This migration is applied to production by
 *     hand, before the code that calls the 9-argument finalize deploys. In that
 *     window the running build calls with 8 arguments. If that stopped working,
 *     every chat turn's finalize would fail three times and land in
 *     agent_cost_finalize_failures. The shim is tested, not assumed.
 *   • THE SUM IS THE BOOKS, ONCE. The judge, the sweep and the brief each write
 *     to TWO ledgers: a worst-case hold in `findings_ai_spend` (the GATE) and a
 *     real row in `agent_costs` (the BOOKS). An employee figure that added them
 *     together would double-count every one of them, and one that read the gate
 *     would quote money that was never charged. Both mistakes are planted here
 *     and both must be rejected.
 *   • NO HOTEL CAN SEE ANOTHER'S. The roster read is fleet-wide ON PURPOSE —
 *     it is the founder's own bill for a named job across every hotel he runs.
 *     What makes that safe is that no hotel can reach it, and that the ledger's
 *     own RLS still refuses one account the other's rows at the browser role.
 *     Both are driven from real identities rather than read off the source.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-placeholder';
process.env.DISABLE_SERVER_2FA_ENFORCEMENT = 'true';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { GET as staffGET } from '@/app/api/admin/mission/ai-staff/route';
import { GET as metricsGET } from '@/app/api/agent/metrics/route';
import { recordNonRequestCost, finalizeCostReservation } from '@/lib/agent/cost-controls';
import { invalidateEmployeeSwitchCache } from '@/lib/ai/employee-switches';
import { MORNING_BRIEFER_ID } from '@/lib/ai/employee-ids';
import {
  billedBundleKeys,
  employeeSpend,
  spendAttributionNote,
  type SpendTotals,
} from '@/lib/ai/employee-spend';
import type { AiEmployee } from '@/lib/ai/employee-registry';
import { AI_COST_KINDS, type AiCostFeature } from '@/lib/ai/types';

import { setupRlsFixture } from '../../../tests/fixtures/pglite-bootstrap';
import { seedCanonicalTestAuthority } from '../../../tests/fixtures/pglite-migrate';
import {
  createPglitePostgrest,
  loadCatalog,
  type Catalog,
  type PglitePostgrest,
} from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A, PID_B } from '../../../tests/fixtures/pglite-two-hotel-seed';

// ═══════════════════════════════════════════════════════════════════════════
// THE COMPILE-TIME HALF
//
// The brief's requirement is that a NEW caller cannot forget the label. That is
// not a runtime property and no runtime assertion can prove it — a test that
// called the function without `feature` would simply not build. So the proof is
// the attempt itself: each `@ts-expect-error` below asserts that the line under
// it DOES fail to typecheck. If someone makes `feature` optional, or widens it
// to `string`, the expected error disappears and TypeScript reports the unused
// directive — `npm run typecheck` (the first thing `npm test` runs) fails.
//
// This block is deliberately not inside a test(): it is checked by the compiler
// on every build, including builds that never run this file.
// ═══════════════════════════════════════════════════════════════════════════

type NonRequestCostArgs = Parameters<typeof recordNonRequestCost>[0];

const _completeRowCompiles: NonRequestCostArgs = {
  userId: 'u', propertyId: 'p', conversationId: null,
  model: 'sonnet', modelId: null, tokensIn: 1, tokensOut: 1,
  costUsd: 0.01, kind: 'background', feature: 'findings.brief',
};

// @ts-expect-error — a background caller that omits `feature` must not compile.
const _omittingFeature: NonRequestCostArgs = {
  userId: 'u', propertyId: 'p', conversationId: null,
  model: 'sonnet', modelId: null, tokensIn: 1, tokensOut: 1,
  costUsd: 0.01, kind: 'background',
};

// @ts-expect-error — an invented or mistyped label must not compile either. A
// free `string` here would let a typo book spend to a feature no card reads.
const _typoedFeature: AiCostFeature = 'findings.breif';

// @ts-expect-error — and the chat turn's finalize is held to the same bar.
const _finalizeWithoutFeature: Parameters<typeof finalizeCostReservation>[0] = {
  reservationId: 'r', conversationId: null, actualUsd: 0.01,
  model: 'sonnet', modelId: null, tokensIn: 1, tokensOut: 1,
  userId: 'u', propertyId: 'p',
};

void _completeRowCompiles; void _omittingFeature; void _typoedFeature; void _finalizeWithoutFeature;

// ─── Identities ─────────────────────────────────────────────────────────────

const ADMIN_UID = 'aaaaaaaa-0000-4000-8000-00000000fe01';
const GM_UID = 'bbbbbbbb-0000-4000-8000-00000000fe02';

let currentUser: string | null = ADMIN_UID;
let accountA = '';
let accountB = '';

let pg: PGlite;
let catalog: Catalog;
let shim: PglitePostgrest;
let runAsUser: (userId: string, sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalGetUser = supabaseAdmin.auth.getUser.bind(supabaseAdmin.auth);

function authed(url: string): NextRequest {
  return new NextRequest(url, {
    headers: { authorization: 'Bearer feature-ledger-test-token' },
  } as ConstructorParameters<typeof NextRequest>[1]);
}

interface Envelope<T> { ok: boolean; error?: string; data?: T }

interface RosterEmployee {
  id: string;
  spend: { known: boolean; usd: number | null; todayUsd: number | null; untracked: string[] } | null;
}
interface RosterPayload {
  employees: RosterEmployee[];
  attributedSince: string | null;
  attributionReadable: boolean;
}

async function readRoster(): Promise<{ status: number; body: Envelope<RosterPayload> }> {
  const res = await staffGET(authed('https://staxis.test/api/admin/mission/ai-staff'));
  return { status: res.status, body: (await res.json()) as Envelope<RosterPayload> };
}

async function brieferSpend(): Promise<number | null> {
  const { body } = await readRoster();
  return body.data!.employees.find((e) => e.id === MORNING_BRIEFER_ID)!.spend!.usd;
}

async function brieferSpendToday(): Promise<number | null> {
  const { body } = await readRoster();
  return body.data!.employees.find((e) => e.id === MORNING_BRIEFER_ID)!.spend!.todayUsd;
}

/** One finalized, unswept row in THE BOOKS. Defaults land it inside the read's
 *  window and today, so a test only states what it is actually varying. */
async function book(row: {
  feature: string | null;
  usd: number;
  propertyId?: string;
  accountId?: string;
  kind?: string;
  state?: string;
  sweptAt?: string | null;
  daysAgo?: number;
}) {
  await pg.query(
    `insert into public.agent_costs
       (user_id, property_id, conversation_id, model, model_id, tokens_in, tokens_out,
        cached_input_tokens, cost_usd, kind, state, swept_at, feature, created_at)
     values ($1,$2,null,'sonnet','claude-sonnet-4-6',100,50,0,$3,$4,$5,$6,$7, now() - make_interval(days => $8))`,
    [
      row.accountId ?? accountA,
      row.propertyId ?? PID_A,
      row.usd,
      row.kind ?? 'background',
      row.state ?? 'finalized',
      row.sweptAt ?? null,
      row.feature,
      row.daysAgo ?? 0,
    ],
  );
}

/** One finalized hold in THE GATE — the ledger that must never be added in. */
async function gate(feature: string, usd: number, propertyId = PID_A) {
  await pg.query(
    `insert into public.findings_ai_spend (property_id, feature, state, cost_usd)
     values ($1,$2,'finalized',$3)`,
    [propertyId, feature, usd],
  );
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('agent_costs.feature — the ledger learns which job spent the money', () => {
  before(async () => {
    const fixture = await setupRlsFixture();
    pg = fixture.pg;
    runAsUser = fixture.runAsUser;
    catalog = await loadCatalog(pg);
    await seedTwoHotels(pg, catalog);
    shim = createPglitePostgrest(pg, catalog);
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.from = shim.from;
    // @ts-expect-error installing the pglite-backed client on the singleton
    supabaseAdmin.rpc = shim.rpc;
    supabaseAdmin.auth.getUser = (async () =>
      currentUser
        ? { data: { user: { id: currentUser, email: `${currentUser}@staff.test` } }, error: null }
        : { data: { user: null }, error: { message: 'invalid token', status: 401, name: 'AuthApiError' } }
    ) as unknown as typeof supabaseAdmin.auth.getUser;

    for (const [uid, email] of [[ADMIN_UID, 'reeyen@staff.test'], [GM_UID, 'gm@staff.test']] as const) {
      await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [uid, email]);
    }
    const inserted = await pg.query<{ id: string }>(
      `insert into public.accounts (username, display_name, role, data_user_id, password_hash, active)
       values ('cost.admin','Reeyen','admin',$1,'x',true),
              ('cost.gm','Maria (GM)','general_manager',$2,'x',true)
       returning id`,
      [ADMIN_UID, GM_UID],
    );
    accountA = inserted.rows[0].id;
    accountB = inserted.rows[1].id;
    await seedCanonicalTestAuthority(pg, { username: 'cost.admin', propertyIds: [] });
    await seedCanonicalTestAuthority(pg, { username: 'cost.gm', propertyIds: [PID_B] });
  });

  after(async () => {
    supabaseAdmin.from = originalFrom;
    supabaseAdmin.rpc = originalRpc;
    supabaseAdmin.auth.getUser = originalGetUser;
    invalidateEmployeeSwitchCache();
    await pg?.close();
  });

  beforeEach(async () => {
    currentUser = ADMIN_UID;
    await pg.query('delete from public.agent_costs');
    // The monthly summary (0375) is part of the attribution answer now:
    // `staxis_agent_costs_attribution_start()` takes the earliest label across
    // BOTH the surviving raw rows and the summary, so that pruning old raw rows
    // cannot make the page claim attribution started later than it did. The
    // shared fixture seeds tenant-leak canary rows into every table, so a test
    // asserting "nothing is labelled yet" has to clear this one too.
    await pg.query('delete from public.agent_costs_monthly');
    await pg.query('delete from public.findings_ai_spend');
    await pg.query('delete from public.ai_employee_switches');
    invalidateEmployeeSwitchCache();
  });

  // ── 1. The write path ────────────────────────────────────────────────────

  test('a background call books its job onto the row, not just its cost', async () => {
    await recordNonRequestCost({
      userId: accountA,
      propertyId: PID_A,
      conversationId: null,
      model: 'sonnet',
      modelId: 'claude-sonnet-4-6',
      tokensIn: 900,
      tokensOut: 120,
      costUsd: 0.042,
      kind: 'background',
      feature: 'findings.brief',
    });

    const rows = await pg.query<{ feature: string | null; cost_usd: string; kind: string; state: string }>(
      'select feature, cost_usd, kind, state from public.agent_costs',
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(
      rows.rows[0].feature, 'findings.brief',
      'the label is the only thing on this row that says what the money was for',
    );
    assert.equal(rows.rows[0].state, 'finalized');
  });

  test('a chat turn carries its job through the reserve → finalize protocol', async () => {
    // The hold, exactly as reserveCostBudget's RPC creates it. A hold is not
    // spend, so it starts unlabelled on purpose.
    const held = await pg.query<{ id: string; feature: string | null }>(
      `insert into public.agent_costs
         (user_id, property_id, model, tokens_in, tokens_out, cost_usd, kind, state)
       values ($1,$2,'pending',0,0,1.99,'request','reserved')
       returning id, feature`,
      [accountA, PID_A],
    );
    assert.equal(held.rows[0].feature, null, 'a hold has nothing to say about a call that has not happened');

    await finalizeCostReservation({
      reservationId: held.rows[0].id,
      conversationId: null,
      actualUsd: 0.031,
      model: 'sonnet',
      modelId: 'claude-sonnet-4-6',
      tokensIn: 1200,
      tokensOut: 300,
      userId: accountA,
      propertyId: PID_A,
      feature: 'agent.ask_staxis',
    });

    const after = await pg.query<{ feature: string | null; state: string; cost_usd: string }>(
      'select feature, state, cost_usd from public.agent_costs where id = $1',
      [held.rows[0].id],
    );
    assert.equal(after.rows[0].state, 'finalized');
    assert.equal(after.rows[0].feature, 'agent.ask_staxis');
    assert.equal(Number(after.rows[0].cost_usd), 0.031);
  });

  // The deploy-order safety net. This migration goes onto production by hand,
  // before the build that calls the 9-argument form ships; in that window every
  // chat turn still finalizes with 8 arguments. 0374 replaces that signature's
  // body with a delegate rather than dropping it — so this test drives the
  // legacy call and asserts BOTH halves of what the delegate must preserve:
  // it reconciles the hold, and it still carries 0098's guard.
  const legacyFinalize = (id: string, usd: number) => pg.query(
    `select public.staxis_finalize_agent_spend($1::uuid, null::uuid, $2::numeric,
       'sonnet'::text, 'claude-sonnet-4-6'::text, 10::integer, 5::integer, 0::integer)`,
    [id, usd],
  );

  test('a build that predates 0374 still finalizes — it simply says nothing about the job', async () => {
    const held = await pg.query<{ id: string }>(
      `insert into public.agent_costs
         (user_id, property_id, model, tokens_in, tokens_out, cost_usd, kind, state)
       values ($1,$2,'pending',0,0,1.99,'request','reserved') returning id`,
      [accountA, PID_A],
    );

    await legacyFinalize(held.rows[0].id, 0.02);

    const after = await pg.query<{ feature: string | null; state: string; cost_usd: string }>(
      'select feature, state, cost_usd from public.agent_costs where id = $1',
      [held.rows[0].id],
    );
    assert.equal(after.rows[0].state, 'finalized', 'the legacy signature must still reconcile the hold');
    assert.equal(Number(after.rows[0].cost_usd), 0.02);
    assert.equal(after.rows[0].feature, null, 'and it must not invent a label it does not have');

    // 0098's guard, inherited rather than re-implemented. A second finalize on
    // the same row must raise, so the JS retry ladder writes an audit row
    // instead of quietly overwriting reconciled spend.
    await assert.rejects(
      () => legacyFinalize(held.rows[0].id, 0.99),
      /finalize_target_unavailable/,
      'the delegate must keep the state guard it delegates through',
    );
  });

  test('the legacy signature cannot blank a label a newer caller already wrote', async () => {
    // A row that has been labelled and then, somehow, re-finalized by an old
    // caller. COALESCE is what stops the label being erased; plain assignment
    // would silently un-attribute money that was correctly attributed.
    const row = await pg.query<{ id: string }>(
      `insert into public.agent_costs
         (user_id, property_id, model, tokens_in, tokens_out, cost_usd, kind, state, feature)
       values ($1,$2,'pending',0,0,1.99,'request','reserved','agent.ask_staxis') returning id`,
      [accountA, PID_A],
    );
    await pg.query(
      `select public.staxis_finalize_agent_spend($1::uuid, null::uuid, 0.02::numeric,
         'sonnet'::text, null::text, 10::integer, 5::integer, 0::integer)`,
      [row.rows[0].id],
    );
    const after = await pg.query<{ feature: string | null }>(
      'select feature from public.agent_costs where id = $1', [row.rows[0].id],
    );
    assert.equal(after.rows[0].feature, 'agent.ask_staxis');
  });

  // ── 2. The employee figure ───────────────────────────────────────────────

  test('an employee is billed for its own features and nothing else', async () => {
    await book({ feature: 'findings.brief', usd: 0.20 });
    await book({ feature: 'findings.brief', usd: 0.05 });
    // The nightly judge is a DIFFERENT employee's work (nobody's, today) and
    // must not land on the Morning Briefer's card.
    await book({ feature: 'findings.judge', usd: 5.00 });
    await book({ feature: 'agent.ask_staxis', usd: 3.00 });

    assert.equal(await brieferSpend(), 0.25);
  });

  test('the figure is the books, once — a hold in the gate is not money', async () => {
    await book({ feature: 'findings.brief', usd: 0.25 });
    // The SAME call, as the findings cap saw it: a worst-case hold, reconciled.
    // Both ledgers legitimately hold a row for it. Adding them would report
    // $0.65 for one $0.25 call, and reading the gate alone would report $0.40.
    await gate('findings.brief', 0.40);
    await gate('findings.judge', 9.99);

    assert.equal(
      await brieferSpend(), 0.25,
      'agent_costs is the books; findings_ai_spend is the cap gate and must never be summed in',
    );
  });

  test('holds, swept holds and unattributed history stay out of the figure', async () => {
    await book({ feature: 'findings.brief', usd: 0.25 });
    // A hold on a call still in flight, priced at the worst case.
    await book({ feature: 'findings.brief', usd: 9.99, state: 'reserved' });
    // A hold the sweeper gave up on. It is state='finalized' but it is not a
    // call that happened.
    await book({ feature: 'findings.brief', usd: 1.50, sweptAt: new Date().toISOString() });
    // Real money from before 0374. Honest, unattributable, and excluded — the
    // page states the date attribution started rather than guessing this one.
    await book({ feature: null, usd: 7.00 });
    // Real, labelled, and outside the 30-day window.
    await book({ feature: 'findings.brief', usd: 4.00, daysAgo: 45 });

    assert.equal(await brieferSpend(), 0.25);
  });

  test('the page is told when attribution started, so a small figure is not read as a cheap one', async () => {
    const fresh = await readRoster();
    assert.equal(fresh.body.data!.attributionReadable, true);
    assert.equal(
      fresh.body.data!.attributedSince, null,
      'with nothing labelled, the honest answer is "not yet" — not a date',
    );

    // THREE labelled rows at different ages. The claim is "attribution started
    // on…", so the answer is the OLDEST of them — quoting the newest would
    // shrink the measured window every time a call is made, which is the
    // opposite of what the caveat is for. Two of the three exist purely so the
    // oldest and the newest are different dates.
    await book({ feature: 'findings.brief', usd: 0.05, daysAgo: 1 });
    await book({ feature: 'findings.brief', usd: 0.10, daysAgo: 12 });
    await book({ feature: 'agent.ask_staxis', usd: 0.30, daysAgo: 6 });
    // Real money from before the column existed. It must not become the date —
    // the ledger was not attributing anything then.
    await book({ feature: null, usd: 9.00, daysAgo: 25 });

    const seeded = await readRoster();
    const since = seeded.body.data!.attributedSince;
    assert.ok(since, 'once a row carries a label there is a date to quote');
    const ageDays = (Date.now() - Date.parse(since!)) / 86_400_000;
    assert.ok(
      ageDays > 11.5 && ageDays < 12.5,
      `the date must be the OLDEST labelled row (~12 days), got ${ageDays.toFixed(2)} days`,
    );
  });

  // Mission Control quotes "spent today" beside the copilot's figure. That
  // number used to come from the findings GATE, because it was the only ledger
  // with a feature column; it now comes from the same books-only read as the
  // thirty-day one. The two windows are one query, so the rule that governs one
  // governs the other — this drives that end to end rather than assuming it.
  test('today\'s figure is the same books-only read, narrowed to the day', async () => {
    await book({ feature: 'findings.brief', usd: 0.12 });               // today
    await book({ feature: 'findings.brief', usd: 0.60, daysAgo: 10 });  // this month, not today
    // Every exclusion the month figure makes, the day figure must make too.
    await book({ feature: 'findings.brief', usd: 9.99, state: 'reserved' });
    await book({ feature: 'findings.brief', usd: 1.50, sweptAt: new Date().toISOString() });
    await book({ feature: null, usd: 7.00 });
    await book({ feature: 'findings.judge', usd: 5.00 });
    // And the GATE's own copy of today's call must stay out of both.
    await gate('findings.brief', 0.40);

    assert.equal(await brieferSpend(), 0.72, 'the month is today plus the rest of the window');
    assert.equal(await brieferSpendToday(), 0.12, 'the day is the books, today, and nothing else');
  });

  // ── 2b. The card's own arithmetic, for the employee who does not exist yet ─
  //
  // Through the route there is exactly ONE hired employee with exactly ONE
  // feature, so "sums this employee's features" and "sums everything the read
  // returned" are the same number and no route-level test can separate them.
  // Employee #2 is where they diverge — which is the whole reason 0374 exists —
  // so the sum is exercised directly against a synthetic roster.

  const synthetic = (features: readonly string[], hired = true): AiEmployee => ({
    id: 'test_employee',
    name: { en: 'Test', es: 'Prueba' },
    job: { en: 'x', es: 'x' },
    hired,
    bundle: {
      features: features as readonly never[],
      detectors: [], crons: [],
      surfaces: [{ en: 'nowhere', es: 'ningún sitio' }],
    },
  });

  const totalsOf = (window: Array<[string, number]>, today: Array<[string, number]> = []): SpendTotals =>
    ({ window: new Map(window), today: new Map(today) });

  test('an employee with several features is billed for those, not for the whole read', () => {
    // One read serves the whole roster, so the maps legitimately carry keys
    // belonging to other employees.
    const totals = totalsOf(
      [['findings.brief', 0.20], ['findings.judge', 0.05], ['agent.ask_staxis', 9.00], ['inventory.invoice_scan', 4.00]],
      [['findings.brief', 0.02], ['findings.judge', 0.01], ['agent.ask_staxis', 6.00]],
    );
    const spend = employeeSpend(synthetic(['findings.brief', 'findings.judge']), totals);
    assert.equal(spend!.known, true);
    assert.equal(spend!.usd, 0.25, 'the other employees\' features must stay on the other cards');
    // Mission Control quotes the day figure beside the copilot's. It is scoped
    // by the same bundle — a today total that leaked the whole read would be
    // the same bug on a smaller number, and harder to notice.
    assert.equal(spend!.todayUsd, 0.03);
  });

  test('today and the month come from one read, so today can never exceed it', () => {
    const spend = employeeSpend(
      synthetic(['findings.brief']),
      totalsOf([['findings.brief', 1.40]], [['findings.brief', 0.35]]),
    );
    assert.equal(spend!.usd, 1.40);
    assert.equal(spend!.todayUsd, 0.35);
    assert.ok(spend!.todayUsd! <= spend!.usd!, 'the day is a subset of the month by construction');
  });

  test('a feature with no rows in the window is zero, not missing', () => {
    const spend = employeeSpend(synthetic(['findings.brief', 'findings.sweep']), totalsOf([['findings.brief', 0.20]]));
    assert.equal(spend!.usd, 0.20);
    assert.equal(spend!.todayUsd, 0, 'nothing today on a ledger that would have caught it IS zero');
    assert.deepEqual(spend!.untracked, [], 'both bill per call; neither is untracked');
  });

  test('an employee whose work never produces a bill reports no figure, not $0.00', () => {
    // `$0.00` would read as "this one is free" about the ML service, which
    // costs hosting; it simply is not billed per call. Mission Control draws
    // nothing at all for this case rather than a zero.
    const spend = employeeSpend(synthetic(['ml.housekeeping_optimizer']), totalsOf([]));
    assert.equal(spend!.known, false);
    assert.equal(spend!.usd, null);
    assert.equal(spend!.todayUsd, null);
    assert.deepEqual(spend!.untracked, ['ml.housekeeping_optimizer']);
  });

  test('a failed ledger read is reported as unknown, never as zero', () => {
    const spend = employeeSpend(synthetic(['findings.brief']), null);
    assert.equal(spend!.known, false);
    assert.equal(spend!.usd, null);
    assert.equal(spend!.todayUsd, null, 'both windows fail together — they are one read');
  });

  test('the ledger is only asked for keys a hired employee actually bills for', () => {
    const keys = billedBundleKeys([
      synthetic(['findings.brief', 'ml.housekeeping_optimizer']),
      { ...synthetic(['findings.judge'], false), bundle: { features: [], detectors: [], crons: [], surfaces: [] } },
    ]);
    assert.deepEqual(keys.sort(), ['findings.brief']);
  });

  // The caveat the page prints above the cards. Pure, and worth guarding: its
  // failure mode is that the honest sentence silently stops appearing, which
  // looks exactly like everything being fine.
  const NOW = Date.parse('2026-07-26T12:00:00.000Z');
  const note = (attributedSince: string | null, attributionReadable = true) =>
    spendAttributionNote({ attributedSince, attributionReadable, windowDays: 30, now: NOW });

  test('nothing attributed yet says so, rather than showing nothing', () => {
    assert.deepEqual(note(null), { kind: 'none' });
  });

  test('a start date inside the window is quoted, so a part-window figure is not read as a full one', () => {
    const since = '2026-07-20T00:00:00.000Z';
    assert.deepEqual(note(since), { kind: 'partial', since });
  });

  test('the caveat retires itself once attribution covers the whole window', () => {
    // 40 days back, window is 30 — every figure on the page is now complete and
    // a standing caveat would just be furniture.
    assert.equal(note('2026-06-16T00:00:00.000Z'), null);
  });

  test('an unreadable start date says nothing rather than implying one', () => {
    assert.equal(note(null, false), null);
    assert.equal(note('2026-07-20T00:00:00.000Z', false), null);
    assert.equal(note('not-a-date'), null);
  });

  // ── 3. Who the figure belongs to ─────────────────────────────────────────

  test('the founder\'s figure spans every hotel — it is his bill, not one hotel\'s', async () => {
    await book({ feature: 'findings.brief', usd: 0.10, propertyId: PID_A, accountId: accountA });
    await book({ feature: 'findings.brief', usd: 0.30, propertyId: PID_B, accountId: accountB });
    assert.equal(
      await brieferSpend(), 0.40,
      'a per-hotel figure would answer a question this page does not ask',
    );
  });

  test('a general manager cannot read the fleet-wide figure at all', async () => {
    await book({ feature: 'findings.brief', usd: 0.10, propertyId: PID_A });
    currentUser = GM_UID;
    const roster = await readRoster();
    assert.equal(roster.status, 403, 'the wall around a fleet-wide number is that no hotel reaches it');
  });

  test('at the browser role, one account still cannot read another\'s spend rows', async () => {
    await book({ feature: 'findings.brief', usd: 0.10, propertyId: PID_A, accountId: accountA });
    await book({ feature: 'agent.ask_staxis', usd: 0.70, propertyId: PID_B, accountId: accountB });

    const mine = await runAsUser(GM_UID, 'select feature, cost_usd from public.agent_costs');
    assert.equal(mine.rows.length, 1, 'RLS must still hand back only the caller\'s own rows');
    assert.equal(mine.rows[0].feature, 'agent.ask_staxis');

    const theirs = await runAsUser(ADMIN_UID, 'select feature from public.agent_costs');
    assert.equal(theirs.rows.length, 1);
    assert.equal(
      theirs.rows[0].feature, 'findings.brief',
      'the new column must not become a window into the other hotel\'s ledger',
    );
  });

  // ── 4. The screen that already existed ───────────────────────────────────

  test('the AI-spend screen counts the same money it always did, labelled or not', async () => {
    // One day's traffic, half of it labelled by the new write path and half
    // still unattributed. The monitoring screen predates 0374 and must not have
    // learned about the column: its totals are over ALL rows of a kind.
    await book({ feature: 'agent.ask_staxis', usd: 0.40, kind: 'request' });
    await book({ feature: null, usd: 0.60, kind: 'request' });
    await book({ feature: 'findings.brief', usd: 0.25, kind: 'background' });
    await book({ feature: null, usd: 0.15, kind: 'background' });
    await book({ feature: 'agent.eval_suite', usd: 0.05, kind: 'eval' });
    // Neither bucket may pick these up.
    await book({ feature: 'agent.ask_staxis', usd: 9.99, kind: 'request', state: 'reserved' });

    const res = await metricsGET(authed('https://staxis.test/api/agent/metrics'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{
      today: { totalCostUsd: number; backgroundCostUsd: number; evalCostUsd: number };
    }>;
    const today = body.data!.today;
    assert.equal(round6(today.totalCostUsd), 1.00, 'user-facing spend is every request row, labelled or not');
    assert.equal(round6(today.backgroundCostUsd), 0.40);
    assert.equal(round6(today.evalCostUsd), 0.05);
  });

  /**
   * THE HOLE THE TEST ABOVE COULD NOT SEE.
   *
   * That test books three kinds and checks three buckets, which is exactly the
   * shape the bug had: migration 0117 added `audio` to the ledger and 0145 added
   * `vision`, both of them taught the WRITERS and neither taught the readers. So
   * voice notes and every photo, PDF and scanned page — the priciest calls the
   * product makes — were recorded, capped, and then left out of every spend
   * figure on the founder's dashboard.
   *
   * This drives one finalized row of EVERY kind the ledger permits, so the sum
   * the screen quotes has to equal the sum of the rows. It is written over
   * `AI_COST_KINDS` rather than over five literals for the same reason: a sixth
   * kind should break this, not slip past it.
   */
  test('every kind of spending reaches the founder\'s figure, not just the three that existed first', async () => {
    const perKindUsd = 0.11;
    for (const kind of AI_COST_KINDS) {
      await book({ feature: 'agent.ask_staxis', usd: perKindUsd, kind });
    }
    // Neither a hold nor a swept hold is money that was charged.
    await book({ feature: 'agent.ask_staxis', usd: 9.99, kind: 'vision', state: 'reserved' });
    await book({ feature: 'agent.ask_staxis', usd: 5.55, kind: 'audio', sweptAt: new Date().toISOString() });

    const res = await metricsGET(authed('https://staxis.test/api/agent/metrics'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Envelope<{
      today: {
        totalCostUsd: number; backgroundCostUsd: number; evalCostUsd: number;
        visionCostUsd: number; audioCostUsd: number;
        allKindsCostUsd: number; unbucketedKinds: string[];
      };
    }>;
    const today = body.data!.today;

    assert.equal(
      round6(today.allKindsCostUsd),
      round6(perKindUsd * AI_COST_KINDS.length),
      'the figure Mission Control draws must be every finalized row today, whatever kind it is',
    );
    assert.deepEqual(today.unbucketedKinds, [], 'every permitted kind must have a bucket');

    // And the breakdown adds back up to it, so the headline can be checked
    // against its own parts rather than trusted.
    const parts = today.totalCostUsd + today.backgroundCostUsd + today.evalCostUsd
      + today.visionCostUsd + today.audioCostUsd;
    assert.equal(round6(parts), round6(today.allKindsCostUsd));
    for (const [label, usd] of [
      ['vision', today.visionCostUsd],
      ['audio', today.audioCostUsd],
    ] as const) {
      assert.equal(round6(usd), perKindUsd, `${label} spend must be reported, not dropped`);
    }
  });

  /**
   * The other half of the same screen: the number beside "Copilot" and the
   * number on the Morning Briefer's card were BOTH counting background work, so
   * the nightly wording pass appeared twice on one page. The light at the top is
   * where the whole bill belongs; the copilot's line is the copilot's turns.
   */
  test('the copilot\'s line does not also bill it for the Morning Briefer\'s nightly pass', async () => {
    await book({ feature: 'agent.ask_staxis', usd: 0.20, kind: 'request' });
    await book({ feature: 'findings.brief', usd: 0.30, kind: 'background' });

    const res = await metricsGET(authed('https://staxis.test/api/agent/metrics'));
    const body = (await res.json()) as Envelope<{
      today: { totalCostUsd: number; backgroundCostUsd: number; allKindsCostUsd: number };
    }>;
    const today = body.data!.today;

    assert.equal(round6(today.allKindsCostUsd), 0.50, 'the light shows the whole day');
    assert.equal(
      round6(today.totalCostUsd), 0.20,
      'the copilot\'s own line is its own turns; the Briefer\'s card already quotes the other row',
    );
  });
});

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
