import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const PROPERTY = '40200000-0000-4000-8000-000000000001';
const OTHER_PROPERTY = '40200000-0000-4000-8000-000000000003';
const ACTOR = '40200000-0000-4000-8000-000000000002';
const OTHER_ACTOR = '40200000-0000-4000-8000-000000000004';
const OP_A = '40200000-0000-4000-8000-00000000000a';
const OP_B = '40200000-0000-4000-8000-00000000000b';
const OP_C = '40200000-0000-4000-8000-00000000000c';

const A = { order: ['general', 'breakfast'], hidden: [] };
const B = { order: ['breakfast', 'general'], hidden: [] };
const C = { order: ['general'], hidden: ['breakfast'] };

interface RpcResult {
  status: string;
  revision?: number;
  operationRevision?: number;
  tabLayout?: { order: string[]; hidden: string[] };
}

let pg: PGlite;

async function write(
  operationId: string,
  expectedRevision: number,
  layout: { order: string[]; hidden: string[] },
  propertyId = PROPERTY,
  budgetMode: 'total' | 'sections' | null = null,
  actorId = ACTOR,
): Promise<RpcResult> {
  const result = await pg.query<{ result: RpcResult }>(
    `select public.staxis_write_inventory_tab_layout_ordered(
       $1::uuid, $2::jsonb, $3::bigint, $4::uuid, $5::text, $6::uuid, 'Test Manager'
     ) as result`,
    [propertyId, JSON.stringify(layout), expectedRevision, operationId, budgetMode, actorId],
  );
  return result.rows[0].result;
}

async function storedLayout(): Promise<Record<string, unknown>> {
  const result = await pg.query<{ inventory_tab_layout: Record<string, unknown> }>(
    'select inventory_tab_layout from public.properties where id=$1',
    [PROPERTY],
  );
  return result.rows[0].inventory_tab_layout;
}

describe('0404 ordered inventory tab-layout RPC — real Postgres behavior', () => {
  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      create role anon;
      create role authenticated;
      create role service_role;
      create schema auth;
      create or replace function auth.role() returns text
      language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
      create table public.properties (
        id uuid primary key,
        inventory_tab_layout jsonb,
        inventory_budget_mode text not null default 'sections'
      );
      create table public.applied_migrations (
        version text primary key,
        description text not null
      );
      insert into public.properties(id) values ('${PROPERTY}'), ('${OTHER_PROPERTY}');
      select set_config('request.jwt.claim.role', 'service_role', false);
    `);
    await pg.exec(readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '0404_inventory_tab_layout_ordered_writes.sql'),
      'utf8',
    ));
  });

  afterEach(async () => {
    await pg.close();
  });

  test('late stale A cannot clobber B after B wins revision zero', async () => {
    const b = await write(OP_B, 0, B);
    assert.equal(b.status, 'applied');
    assert.equal(b.revision, 1);

    // This is the dangerous production ordering: A was initiated first but
    // reaches the database only after newer user intent B has committed.
    const lateA = await write(OP_A, 0, A);
    assert.equal(lateA.status, 'revision_conflict');
    assert.equal(lateA.revision, 1);
    assert.deepEqual(lateA.tabLayout, B);

    const stored = await storedLayout();
    assert.deepEqual({ order: stored.order, hidden: stored.hidden }, B);
    assert.deepEqual(stored._staxis, { revision: 1, operationId: OP_B });
  });

  test('an exact operation retry replays once without advancing revision', async () => {
    const first = await write(OP_A, 0, A);
    const retry = await write(OP_A, 0, A);
    assert.equal(first.status, 'applied');
    assert.equal(retry.status, 'replayed');
    assert.equal(retry.operationRevision, 1);
    assert.equal(retry.revision, 1);
    assert.deepEqual(retry.tabLayout, A);

    const receipts = await pg.query<{ count: number }>(
      'select count(*)::int as count from public.inventory_tab_layout_operations',
    );
    assert.equal(receipts.rows[0].count, 1);
  });

  test('operation reuse and stale CAS both return authoritative state', async () => {
    await write(OP_A, 0, A);

    const reused = await write(OP_A, 0, B);
    assert.equal(reused.status, 'operation_conflict');
    assert.equal(reused.revision, 1);
    assert.deepEqual(reused.tabLayout, A);

    const staleCas = await write(OP_B, 0, B);
    assert.equal(staleCas.status, 'revision_conflict');
    assert.equal(staleCas.revision, 1);
    assert.deepEqual(staleCas.tabLayout, A);
  });

  test('exact replay freezes optional budget input and actor identity too', async () => {
    const first = await write(OP_A, 0, A, PROPERTY, 'total', ACTOR);
    assert.equal(first.status, 'applied');

    const changedBudget = await write(OP_A, 0, A, PROPERTY, 'sections', ACTOR);
    assert.equal(changedBudget.status, 'operation_conflict');
    assert.equal(changedBudget.revision, 1);
    assert.deepEqual(changedBudget.tabLayout, A);

    const changedActor = await write(OP_A, 0, A, PROPERTY, 'total', OTHER_ACTOR);
    assert.equal(changedActor.status, 'operation_conflict');
    assert.equal(changedActor.revision, 1);
    assert.deepEqual(changedActor.tabLayout, A);

    const property = await pg.query<{ inventory_budget_mode: string }>(
      'select inventory_budget_mode from public.properties where id=$1',
      [PROPERTY],
    );
    assert.equal(property.rows[0].inventory_budget_mode, 'total');
  });

  test('retrying an older applied operation after C returns current C, never rewrites it', async () => {
    await write(OP_A, 0, A);
    await write(OP_C, 1, C);

    const oldRetry = await write(OP_A, 0, A);
    assert.equal(oldRetry.status, 'replayed');
    assert.equal(oldRetry.operationRevision, 1);
    assert.equal(oldRetry.revision, 2);
    assert.deepEqual(oldRetry.tabLayout, C);
    const stored = await storedLayout();
    assert.deepEqual({ order: stored.order, hidden: stored.hidden }, C);
  });

  test('cross-property operation reuse conflicts without leaking the first hotel receipt', async () => {
    await write(OP_A, 0, A, PROPERTY);
    const crossProperty = await write(OP_A, 0, B, OTHER_PROPERTY);
    assert.equal(crossProperty.status, 'operation_conflict');
    assert.equal(crossProperty.revision, 0);
    assert.deepEqual(crossProperty.tabLayout, { order: [], hidden: [] });
    assert.notDeepEqual(crossProperty.tabLayout, A);

    const other = await pg.query<{ inventory_tab_layout: unknown }>(
      'select inventory_tab_layout from public.properties where id=$1',
      [OTHER_PROPERTY],
    );
    assert.equal(other.rows[0].inventory_tab_layout, null);
  });

  test('operation receipts are not browser-readable', async () => {
    await write(OP_A, 0, A);
    await pg.exec('begin');
    await pg.exec('set local role authenticated');
    await assert.rejects(
      pg.query('select * from public.inventory_tab_layout_operations'),
      /permission denied/i,
    );
    await pg.exec('rollback');
  });

  test('the legacy RPC refuses layout bypasses but preserves budget-only saves', async () => {
    await assert.rejects(
      pg.query(
        `select public.staxis_update_inventory_property_config(
           $1::uuid, $2::jsonb, null, $3::uuid, 'Test Manager'
         )`,
        [PROPERTY, JSON.stringify(A), ACTOR],
      ),
      /requires ordered operation contract/i,
    );

    const saved = await pg.query<{ saved: boolean }>(
      `select public.staxis_update_inventory_property_config(
         $1::uuid, null, 'total', $2::uuid, 'Test Manager'
       ) as saved`,
      [PROPERTY, ACTOR],
    );
    assert.equal(saved.rows[0].saved, true);
    const property = await pg.query<{
      inventory_budget_mode: string;
      inventory_tab_layout: unknown;
    }>(
      'select inventory_budget_mode, inventory_tab_layout from public.properties where id=$1',
      [PROPERTY],
    );
    assert.equal(property.rows[0].inventory_budget_mode, 'total');
    assert.equal(property.rows[0].inventory_tab_layout, null);
  });

  test('PostgREST can discover the hoisted statement bound from pg_proc', async () => {
    const result = await pg.query<{ proconfig: string[] }>(
      `select proconfig
         from pg_proc
        where oid = 'public.staxis_write_inventory_tab_layout_ordered(uuid,jsonb,bigint,uuid,text,uuid,text)'::regprocedure`,
    );
    assert.ok(result.rows[0].proconfig.includes('statement_timeout=8s'));
    assert.ok(result.rows[0].proconfig.includes('lock_timeout=4s'));
    assert.ok(result.rows[0].proconfig.some((value) => value.startsWith('search_path=')));
  });
});
