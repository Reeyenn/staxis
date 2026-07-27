/**
 * PROOF, against a real Postgres, that the AI-books rollup is safe to prune behind.
 *
 * The TypeScript twin (agent-costs-rollup.test.ts) proves the fold's ARITHMETIC.
 * This proves the thing that actually runs: `staxis_rollup_agent_costs_month`
 * from migration 0375, executed by PGlite with the real schema applied.
 *
 * Four claims, each of which a stub would happily fake:
 *
 *   • THE FOLD REPRODUCES THE RAW SUM EXACTLY, so `verified_at` gets stamped.
 *     That stamp is the only thing standing between the pruner and the books.
 *   • A MONTH THAT IS NOT OVER IS NEVER STAMPED (Guard 2). The current month is
 *     still growing; freezing it would orphan every row that lands after. Its
 *     fold is still arithmetically correct — correct and final are different
 *     things, and only the durable stamp authorises a prune.
 *   • A VERIFIED MONTH IS FROZEN (Guard 1). This is the one that would have
 *     destroyed the ledger: re-folding a month whose raw rows were already
 *     pruned finds zero rows, and without the guard the function would delete
 *     the real summary and replace it with nothing — silently, and agreeing
 *     with itself, because 0 = 0.
 *   • THE ATTRIBUTION DATE SPANS BOTH TABLES, so /admin/ai-staff keeps telling
 *     the truth after a prune instead of quietly claiming attribution started
 *     later than it did.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'placeholder-service-role-key-min-20-chars';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'placeholder-anon-key-min-20-chars';
process.env.CRON_SECRET ??= 'placeholder-cron-secret-min-16';

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';

import { setupRlsFixture } from '../../../tests/fixtures/pglite-bootstrap';
import { loadCatalog, type Catalog } from '../../../tests/fixtures/postgrest-pglite';
import { seedTwoHotels, PID_A } from '../../../tests/fixtures/pglite-two-hotel-seed';

let pg: PGlite;
let catalog: Catalog;
let accountId: string;

const USER_UID = '00000000-0000-4000-8000-0000000ac001';

interface RollupResult {
  month: string;
  grains: string;
  rows_folded: string;
  raw_cost_usd: string;
  rolled_cost_usd: string;
  verified: boolean;
}

/** Run the real function for one month. */
async function rollup(month: string): Promise<RollupResult> {
  const r = await pg.query<RollupResult>(
    'select * from public.staxis_rollup_agent_costs_month($1::date)', [month],
  );
  return r.rows[0];
}

/** Book a raw row. `costUsd` is a decimal string so nothing goes near a float. */
async function book(costUsd: string, createdAt: string, feature: string | null = 'agent.ask_staxis'): Promise<void> {
  await pg.query(
    `insert into public.agent_costs
       (user_id, property_id, model, tokens_in, tokens_out, cost_usd, kind, state, feature, created_at)
     values ($1, $2, 'claude-opus-5', 10, 20, $3::numeric, 'request', 'finalized', $4, $5::timestamptz)`,
    [accountId, PID_A, costUsd, feature, createdAt],
  );
}

async function rawSum(): Promise<string> {
  const r = await pg.query<{ s: string }>('select coalesce(sum(cost_usd),0)::text as s from public.agent_costs');
  return r.rows[0].s;
}

async function rolledSum(): Promise<string> {
  const r = await pg.query<{ s: string }>('select coalesce(sum(cost_usd),0)::text as s from public.agent_costs_monthly');
  return r.rows[0].s;
}

/** A month that is safely in the past, so Guard 2 permits verification. */
const PAST = '2026-01-01';
const PAST_ROWS = ['2026-01-05T10:00:00Z', '2026-01-06T10:00:00Z', '2026-01-07T10:00:00Z'];

describe('staxis_rollup_agent_costs_month — the interlock, against a real Postgres', () => {
  before(async () => {
    const fixture = await setupRlsFixture();
    pg = fixture.pg;
    catalog = await loadCatalog(pg);
    await seedTwoHotels(pg, catalog);
    await pg.query('insert into auth.users (id, email) values ($1,$2) on conflict do nothing', [USER_UID, 'rollup@staff.test']);
    const inserted = await pg.query<{ id: string }>(
      `insert into public.accounts (username, display_name, role, property_access, data_user_id, password_hash, active)
       values ('rollup.admin','Rollup','admin',array[$1::uuid],$2,'x',true)
       returning id`,
      [PID_A, USER_UID],
    );
    accountId = inserted.rows[0].id;
  });

  after(async () => { await pg?.close(); });

  beforeEach(async () => {
    await pg.query('delete from public.agent_costs');
    await pg.query('delete from public.agent_costs_monthly');
  });

  test('folds a closed month, reproduces the sum exactly, and stamps verified_at', async () => {
    // Six-decimal values that do not survive float arithmetic intact.
    await book('0.100000', PAST_ROWS[0]);
    await book('0.200000', PAST_ROWS[1]);
    await book('0.000007', PAST_ROWS[2]);

    const res = await rollup(PAST);

    assert.equal(res.verified, true, 'an exact fold must verify');
    assert.equal(Number(res.rows_folded), 3);
    assert.equal(
      new Date(res.month).toISOString().slice(0, 10), PAST,
      'the bucket must be labelled with the month it was asked for, in UTC — not shifted by the session timezone',
    );
    assert.equal(res.raw_cost_usd, res.rolled_cost_usd);
    assert.equal(await rolledSum(), await rawSum(), 'the summary must equal the books');

    const stamped = await pg.query<{ n: string }>(
      `select count(*)::text as n from public.agent_costs_monthly
        where month = $1::date and verified_at is not null`, [PAST],
    );
    // All three rows share every grain dimension, so they fold to ONE grain —
    // and the month label must be the month asked for. It was not: casting the
    // timestamptz month-start to date resolved it in the session timezone and
    // stored 2025-12-31. Asserting the label here is what caught that.
    assert.equal(stamped.rows[0].n, '1', 'the verified month must carry the stamp, under the right month label');
  });

  test('the total is unchanged after the raw rows are pruned', async () => {
    await book('1.234567', PAST_ROWS[0]);
    await book('2.765433', PAST_ROWS[1]);
    const before = await rawSum();

    const res = await rollup(PAST);
    assert.equal(res.verified, true);

    // The prune the cron performs, once the month is verified.
    await pg.query('delete from public.agent_costs');

    assert.equal(
      await rolledSum(), before,
      'pruning a verified month changed the books — money vanished',
    );
  });

  test('refuses to STAMP a month that is not over yet (Guard 2)', async () => {
    // The current month is still growing. Stamping it would freeze it by
    // Guard 1, and every row that landed afterwards would be summarised
    // nowhere — and, worse, the month would become prunable.
    //
    // Note the two are deliberately different things: the fold of an open month
    // is perfectly CORRECT (verified=true, the sums match), it is simply not
    // FINAL. Only the durable verified_at stamp authorises a prune, and that is
    // what must be absent here.
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    await book('0.500000', now.toISOString());

    const res = await rollup(thisMonth);

    assert.equal(res.verified, true, 'the fold of an open month is still arithmetically correct');
    const stamped = await pg.query<{ n: string }>(
      `select count(*)::text as n from public.agent_costs_monthly
        where month = $1::date and verified_at is not null`, [thisMonth],
    );
    assert.equal(stamped.rows[0].n, '0', 'no stamp, so the pruner cannot touch it');
  });

  test('an open month re-folds freely as rows arrive', async () => {
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

    await book('0.500000', now.toISOString());
    await rollup(thisMonth);
    await book('0.250000', now.toISOString());
    await rollup(thisMonth);

    assert.equal(await rolledSum(), await rawSum(), 'the open month must firm up, not double-count');
  });

  test('THE DANGEROUS ONE: a verified month is frozen, so re-folding after a prune cannot erase it (Guard 1)', async () => {
    await book('3.000000', PAST_ROWS[0]);
    await book('4.000000', PAST_ROWS[1]);
    const res = await rollup(PAST);
    assert.equal(res.verified, true);
    const summarised = await rolledSum();
    assert.equal(summarised, '7.000000');

    // Prune, exactly as the cron does once verified.
    await pg.query('delete from public.agent_costs');

    // Now the daily cron comes round again and folds the same month. Without
    // Guard 1 this deletes the month's grains, finds zero raw rows, inserts
    // nothing, and reports verified=true because 0 = 0 — the month's money
    // gone, with the function agreeing it was fine.
    const again = await rollup(PAST);

    assert.equal(
      await rolledSum(), summarised,
      're-folding a pruned month destroyed the summary — the whole month of spend would be gone',
    );
    assert.equal(again.verified, true, 'a frozen month still reports as verified');
    assert.equal(again.rolled_cost_usd, '7.000000', 'and reports the summary it kept');
  });

  test('keeps unattributed history separate from labelled spend', async () => {
    await book('1.000000', PAST_ROWS[0], 'findings.judge');
    await book('2.000000', PAST_ROWS[1], null); // pre-0374 money

    const res = await rollup(PAST);
    assert.equal(res.verified, true);
    assert.equal(await rolledSum(), '3.000000', 'unattributed money is still money');

    const nulls = await pg.query<{ n: string }>(
      `select count(*)::text as n from public.agent_costs_monthly where feature is null`,
    );
    assert.equal(nulls.rows[0].n, '1', 'the null label survives the fold rather than being bucketed');
  });

  test('the attribution date spans the summary, so a prune cannot move it', async () => {
    await book('1.000000', '2026-01-05T10:00:00Z', 'findings.judge');
    await book('1.000000', '2026-03-05T10:00:00Z', 'findings.judge');

    const beforePrune = await pg.query<{ t: string }>(
      'select public.staxis_agent_costs_attribution_start()::text as t',
    );

    await rollup(PAST);
    // Prune January's raw rows; March's remain.
    await pg.query(`delete from public.agent_costs where created_at < '2026-02-01'`);

    const afterPrune = await pg.query<{ t: string }>(
      'select public.staxis_agent_costs_attribution_start()::text as t',
    );

    assert.equal(
      afterPrune.rows[0].t, beforePrune.rows[0].t,
      'after pruning January the page would have claimed attribution began in March',
    );
  });
});
