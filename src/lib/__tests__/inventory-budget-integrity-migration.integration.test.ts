/**
 * Executable regression coverage for migration 0323.
 *
 * This deliberately starts from a small 0322-shaped schema, seeds a legacy
 * closed row, and then executes the real migration file.  That makes the
 * otherwise one-time legacy-row classification and close backfill testable.
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const PROPERTY_ID = '61000000-0000-4000-8000-000000000001';
const ACTIVE_SECTION_ID = '62000000-0000-4000-8000-000000000001';
const ORPHAN_SECTION_ID = '62000000-0000-4000-8000-000000000002';

let pg: PGlite;

async function row<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const result = await pg.query(sql, params) as { rows: T[] };
  assert.ok(result.rows[0], `expected one row for: ${sql}`);
  return result.rows[0];
}

describe('inventory budget integrity migration 0323', () => {
  before(async () => {
    pg = new PGlite();
    await pg.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;

      create table public.properties (
        id uuid primary key,
        inventory_budget_mode text not null default 'sections'
          check (inventory_budget_mode in ('total', 'sections'))
      );

      create table public.inventory_budgets (
        property_id uuid not null references public.properties(id) on delete cascade,
        category text not null check (
          category in ('housekeeping', 'maintenance', 'breakfast', 'total')
          or category ~ '^section:[0-9a-fA-F-]{36}$'
        ),
        month_start date not null,
        budget_cents integer not null check (budget_cents >= 0),
        notes text,
        updated_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        primary key (property_id, category, month_start)
      );

      create table public.inventory_budget_sections (
        id uuid primary key,
        property_id uuid not null references public.properties(id) on delete cascade,
        name text not null,
        item_ids uuid[] not null default '{}',
        sort integer not null default 0
      );

      create table public.inventory_month_closes (
        id uuid primary key,
        property_id uuid not null references public.properties(id) on delete cascade,
        month_start date not null,
        status text not null check (status in ('open', 'closed')),
        unique (property_id, month_start)
      );

      create or replace function public.staxis_enforce_inventory_month_close_header()
      returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' or old.status = 'closed' then
          raise exception 'closed inventory months are immutable' using errcode = '23514';
        end if;
        if new.status <> 'closed' then
          raise exception 'an open inventory month may only transition to closed' using errcode = '23514';
        end if;
        return new;
      end
      $$;

      create trigger inventory_month_close_header_guard
        before update or delete on public.inventory_month_closes
        for each row execute function public.staxis_enforce_inventory_month_close_header();

      create or replace function public.staxis_inventory_close_property_lock()
      returns trigger language plpgsql as $$
      declare
        v_property_id uuid;
      begin
        v_property_id := case when tg_op = 'DELETE' then old.property_id else new.property_id end;
        perform 1 from public.properties p where p.id = v_property_id for update;
        if tg_op = 'DELETE' then return old; end if;
        return new;
      end
      $$;

      create table public.applied_migrations (
        version text primary key,
        description text not null
      );
    `);

    // This is the exact ambiguity 0323 resolves: the legacy row has no basis,
    // and a month was already closed before close-time cap columns existed.
    await pg.query(
      `insert into public.properties(id, inventory_budget_mode) values ($1, 'sections')`,
      [PROPERTY_ID],
    );
    await pg.query(
      `insert into public.inventory_budgets(property_id, category, month_start, budget_cents)
       values ($1, 'housekeeping', date '2026-01-01', 1234)`,
      [PROPERTY_ID],
    );
    await pg.query(
      `insert into public.inventory_month_closes(id, property_id, month_start, status)
       values ('63000000-0000-4000-8000-000000000001', $1, date '2026-01-01', 'closed')`,
      [PROPERTY_ID],
    );

    const migration = readFileSync(
      join(__dirname, '..', '..', '..', 'supabase', 'migrations', '0323_inventory_budget_integrity.sql'),
      'utf8',
    );
    await pg.exec(migration);
  });

  after(async () => {
    await pg.close();
  });

  test('separates bases, backfills legacy closes, and freezes exact applicable caps', async () => {
    const legacyBudget = await row<{ basis: string }>(
      `select basis from public.inventory_budgets
       where property_id = $1 and category = 'housekeeping' and month_start = date '2026-01-01'`,
      [PROPERTY_ID],
    );
    assert.equal(legacyBudget.basis, 'purchases');

    const primaryKey = await row<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.inventory_budgets'::regclass and contype = 'p'
    `);
    assert.match(
      primaryKey.definition.replaceAll('"', ''),
      /PRIMARY KEY \(property_id, category, month_start, basis\)/i,
    );

    const legacyClose = await row<{
      usage_budget_mode: string;
      usage_budget_total_cents: number | null;
      usage_budget_by_key: Record<string, number>;
    }>(
      `select usage_budget_mode, usage_budget_total_cents, usage_budget_by_key
       from public.inventory_month_closes where month_start = date '2026-01-01'`,
    );
    assert.equal(legacyClose.usage_budget_mode, 'sections');
    assert.equal(legacyClose.usage_budget_total_cents, null);
    assert.deepEqual(legacyClose.usage_budget_by_key, {});

    await pg.query(
      `insert into public.inventory_budget_sections(id, property_id, name)
       values ($1, $2, 'Pool supplies')`,
      [ACTIVE_SECTION_ID, PROPERTY_ID],
    );

    // A purchase plan and a usage cap for the same month/key must coexist.
    await pg.query(
      `insert into public.inventory_budgets(property_id, category, month_start, budget_cents)
       values ($1, 'housekeeping', date '2026-02-01', 1500)`,
      [PROPERTY_ID],
    );
    await pg.query(
      `insert into public.inventory_budgets(property_id, category, month_start, budget_cents, basis)
       values
         ($1, 'housekeeping', date '2026-02-01', 5000, 'usage'),
         ($1, 'breakfast', date '2026-02-01', 0, 'usage'),
         ($1, 'total', date '2026-02-01', 9999, 'usage'),
         ($1, $2, date '2026-02-01', 2500, 'usage'),
         ($1, $3, date '2026-02-01', 3000, 'usage')`,
      [
        PROPERTY_ID,
        `section:${ACTIVE_SECTION_ID}`,
        `section:${ORPHAN_SECTION_ID}`,
      ],
    );

    const coexisting = await row<{ count: number }>(
      `select count(*)::integer as count
       from public.inventory_budgets
       where property_id = $1 and category = 'housekeeping' and month_start = date '2026-02-01'`,
      [PROPERTY_ID],
    );
    assert.equal(coexisting.count, 2);

    await pg.query(
      `insert into public.inventory_month_closes(id, property_id, month_start, status)
       values ('63000000-0000-4000-8000-000000000002', $1, date '2026-02-01', 'open')`,
      [PROPERTY_ID],
    );
    await pg.query(
      `update public.inventory_month_closes set status = 'closed'
       where property_id = $1 and month_start = date '2026-02-01'`,
      [PROPERTY_ID],
    );

    const sectionsClose = await row<{
      usage_budget_mode: string;
      usage_budget_total_cents: number;
      usage_budget_by_key: Record<string, number>;
    }>(
      `select usage_budget_mode, usage_budget_total_cents, usage_budget_by_key
       from public.inventory_month_closes where month_start = date '2026-02-01'`,
    );
    assert.equal(sectionsClose.usage_budget_mode, 'sections');
    assert.equal(sectionsClose.usage_budget_total_cents, 7500);
    assert.deepEqual(sectionsClose.usage_budget_by_key, {
      housekeeping: 5000,
      [`section:${ACTIVE_SECTION_ID}`]: 2500,
    });

    // Configuration cleanup leaves both the row and the already-closed cap
    // evidence intact. The orphan key is excluded from future section-mode
    // snapshots, but is never cascade-deleted from inventory_budgets.
    await pg.query(
      `delete from public.inventory_budget_sections where id = $1 and property_id = $2`,
      [ACTIVE_SECTION_ID, PROPERTY_ID],
    );
    await pg.query(
      `update public.inventory_budgets set budget_cents = 8000
       where property_id = $1 and month_start = date '2026-02-01'
         and category = 'housekeeping' and basis = 'usage'`,
      [PROPERTY_ID],
    );
    await pg.query(
      `update public.properties set inventory_budget_mode = 'total' where id = $1`,
      [PROPERTY_ID],
    );

    const preservedRows = await row<{ count: number }>(
      `select count(*)::integer as count from public.inventory_budgets
       where property_id = $1 and category = $2`,
      [PROPERTY_ID, `section:${ACTIVE_SECTION_ID}`],
    );
    assert.equal(preservedRows.count, 1);
    assert.deepEqual(
      await row(
        `select usage_budget_mode, usage_budget_total_cents, usage_budget_by_key
         from public.inventory_month_closes where month_start = date '2026-02-01'`,
      ),
      sectionsClose,
    );

    await pg.query(
      `insert into public.inventory_budgets(property_id, category, month_start, budget_cents, basis)
       values
         ($1, 'total', date '2026-03-01', 12000, 'usage'),
         ($1, 'housekeeping', date '2026-03-01', 6000, 'usage')`,
      [PROPERTY_ID],
    );
    await pg.query(
      `insert into public.inventory_month_closes(
         id, property_id, month_start, status,
         usage_budget_mode, usage_budget_total_cents, usage_budget_by_key
       ) values (
         '63000000-0000-4000-8000-000000000003', $1, date '2026-03-01', 'open',
         'sections', 1, '{"bogus": 1}'::jsonb
       )`,
      [PROPERTY_ID],
    );

    const openClose = await row<{
      usage_budget_mode: null;
      usage_budget_total_cents: null;
      usage_budget_by_key: null;
    }>(
      `select usage_budget_mode, usage_budget_total_cents, usage_budget_by_key
       from public.inventory_month_closes where month_start = date '2026-03-01'`,
    );
    assert.deepEqual(openClose, {
      usage_budget_mode: null,
      usage_budget_total_cents: null,
      usage_budget_by_key: null,
    });

    // Bogus values supplied by the caller during the close transition are
    // overwritten by the trigger's authoritative snapshot.
    await pg.query(
      `update public.inventory_month_closes
       set status = 'closed',
           usage_budget_mode = 'sections',
           usage_budget_total_cents = 1,
           usage_budget_by_key = '{"bogus": 1}'::jsonb
       where property_id = $1 and month_start = date '2026-03-01'`,
      [PROPERTY_ID],
    );

    const totalClose = await row<{
      usage_budget_mode: string;
      usage_budget_total_cents: number;
      usage_budget_by_key: Record<string, number>;
    }>(
      `select usage_budget_mode, usage_budget_total_cents, usage_budget_by_key
       from public.inventory_month_closes where month_start = date '2026-03-01'`,
    );
    assert.deepEqual(totalClose, {
      usage_budget_mode: 'total',
      usage_budget_total_cents: 12000,
      usage_budget_by_key: { total: 12000 },
    });

    const trigger = await row<{ tgenabled: string }>(`
      select tgenabled
      from pg_trigger
      where tgrelid = 'public.inventory_month_closes'::regclass
        and tgname = 'inventory_month_close_usage_budget_snapshot'
    `);
    assert.equal(trigger.tgenabled, 'A');

    await assert.rejects(
      pg.query(
        `update public.inventory_month_closes set usage_budget_total_cents = 1
         where property_id = $1 and month_start = date '2026-03-01'`,
        [PROPERTY_ID],
      ),
      /closed inventory months are immutable|23514/i,
    );
  });
});
