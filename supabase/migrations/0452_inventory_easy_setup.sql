-- ═══════════════════════════════════════════════════════════════════════════
-- 0452 — INVENTORY EASY SETUP: import batches, row provenance, occupancy months
--
-- WHAT THIS IS FOR
-- A hotel arrives with years of inventory in spreadsheets and years of
-- occupancy in a different spreadsheet. Typing it in is why they never start.
-- This migration is the provenance spine under "paste the file you already
-- have": every import is ONE batch, every row it touched is recorded, and one
-- button takes the whole batch back out again.
--
-- WHAT IT DELIBERATELY DOES NOT CREATE
--   • No new "inventory history" table. Dated history already has a home:
--     public.inventory_counts (property_id, item_id, counted_at, counted_stock)
--     is append-only and is exactly what ml-service/src/training/inventory_rate.py
--     reads to build training windows. An imported May sheet becomes May-dated
--     inventory_counts rows and teaches the model for free.
--   • No new occupancy table for the model to read. daily_logs already IS the
--     per-day occupancy record the trainer reads, and 0344 gave it the
--     rooms_available / rooms_sold / occupancy_source triple. An imported month
--     is spread across its days there, sourced 'operator' — the manager told
--     us. The MONTH as the manager actually gave it is kept below, so the
--     derived daily rows are never mistaken for the source of record.
--   • No new ML tables. Training rows are built in memory, per run, in Python.
--     Undo therefore cascades by removing the inputs (counts, daily_logs
--     values) plus the one persisted derivative that points at a count row:
--     prediction_log.inventory_count_id, whose FK is ON DELETE NO ACTION and
--     will refuse the delete if a caller forgets. That refusal is the feature.
--
-- TENANCY: all three tables are deny-all to the browser. Reads and writes go
-- through /api/inventory/import/* with supabaseAdmin behind the same finance +
-- capability + section gates the invoice scanner uses.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── 1. inventory_import_batches — one row per "I pasted a file" ───────────
-- @rls: service-role-only
create table if not exists public.inventory_import_batches (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,
  -- 'inventory' = item list / counts. 'occupancy' = monthly rooms sold.
  kind               text not null check (kind in ('inventory', 'occupancy')),
  -- The file's own name, or 'Pasted text'. Shown verbatim on the undo row so
  -- a manager recognizes which of last week's four uploads this was.
  source_name        text not null check (char_length(btrim(source_name)) between 1 and 200),
  source_kind        text not null check (source_kind in ('xlsx', 'csv', 'text', 'pdf', 'photo')),
  -- The date the sheet was CURRENT. This is the field the whole feature hangs
  -- on: it is what decides whether the numbers may touch today's stock.
  as_of_date         date not null,
  as_of_mode         text not null check (as_of_mode in ('current', 'history_only')),
  -- Client-minted idempotency key, so a double-tapped Confirm imports once.
  request_id         text check (request_id is null or char_length(request_id) between 8 and 100),
  imported_at        timestamptz not null default now(),
  imported_by        uuid references public.accounts(id) on delete set null,
  imported_by_name   text,
  item_count         integer not null default 0 check (item_count >= 0),
  skipped_count      integer not null default 0 check (skipped_count >= 0),
  -- The honesty sentence exactly as the manager was shown it at confirm time.
  -- Stored rather than re-derived so the undo list cannot quietly disagree
  -- with what the person actually approved.
  skipped_summary    text,
  -- Supplier names seen in this file. Feeds the existing vendor SUGGESTED
  -- pool (0377) as a text[] rather than its own table: a suggestion is a
  -- read-model computed on the fly, and this is one more place to read from.
  vendor_names       text[] not null default '{}'::text[],
  -- False for is_test hotels and for anything that produced no dated history.
  -- A demo hotel's paperwork must never shape a real hotel's model.
  fed_training       boolean not null default false,
  undone_at          timestamptz,
  undone_by          uuid references public.accounts(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (id, property_id)
);

create index if not exists inventory_import_batches_property_idx
  on public.inventory_import_batches (property_id, imported_at desc);

create index if not exists inventory_import_batches_live_idx
  on public.inventory_import_batches (property_id, kind, as_of_date)
  where undone_at is null;

create unique index if not exists inventory_import_batches_request_idx
  on public.inventory_import_batches (property_id, request_id)
  where request_id is not null;

comment on table public.inventory_import_batches is
  'One row per inventory or occupancy file a manager imported. Carries the as-of date that decides whether the numbers could touch current stock, the honesty sentence they approved, and the undo stamp.';

-- ─── 2. inventory_import_rows — what each source row actually did ──────────
-- @rls: service-role-only
create table if not exists public.inventory_import_rows (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references public.properties(id) on delete cascade,
  batch_id          uuid not null,
  row_index         integer not null check (row_index >= 0),
  raw_name          text not null,
  outcome           text not null check (outcome in ('created', 'merged', 'history_only', 'skipped')),
  skip_reason       text,
  item_id           uuid,
  -- True only when THIS import brought the item into existence. Undo removes
  -- those and leaves items that already existed alone.
  created_item      boolean not null default false,
  count_id          uuid,
  quantity          numeric,
  unit              text,
  unit_cost_cents   integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  vendor_name       text,
  as_of_date        date,
  created_at        timestamptz not null default now(),
  foreign key (batch_id, property_id)
    references public.inventory_import_batches (id, property_id) on delete cascade
);

-- item_id and count_id carry NO foreign key on purpose, and the reason is the
-- undo path. A composite FK with ON DELETE SET NULL nulls EVERY referencing
-- column, property_id included, and property_id is NOT NULL — so removing an
-- imported count would fail on a constraint that exists to help us. A receipt
-- must also survive the thing it is a receipt for: after an undo these columns
-- are meant to still say which item and which count this row was. Tenancy is
-- enforced by the trigger below instead, which is the guarantee the FK was
-- actually there for.
create or replace function public.staxis_inventory_import_row_tenant_ck()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.item_id is not null and not exists (
    select 1 from public.inventory i
     where i.id = new.item_id and i.property_id = new.property_id
  ) then
    raise exception 'inventory_import_rows.item_id % is not an item of property %',
      new.item_id, new.property_id;
  end if;
  if new.count_id is not null and not exists (
    select 1 from public.inventory_counts c
     where c.id = new.count_id and c.property_id = new.property_id
  ) then
    raise exception 'inventory_import_rows.count_id % is not a count of property %',
      new.count_id, new.property_id;
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_import_rows_tenant_ck on public.inventory_import_rows;
create trigger inventory_import_rows_tenant_ck
  before insert or update of item_id, count_id, property_id
  on public.inventory_import_rows
  for each row execute function public.staxis_inventory_import_row_tenant_ck();

create index if not exists inventory_import_rows_batch_idx
  on public.inventory_import_rows (batch_id, row_index);

create index if not exists inventory_import_rows_item_idx
  on public.inventory_import_rows (property_id, item_id)
  where item_id is not null;

comment on table public.inventory_import_rows is
  'Per-source-row provenance for an inventory import: what it matched, whether it created the item, which dated count it wrote, and why it was skipped. This is what makes "remove this import" exact instead of approximate.';

-- ─── 3. inventory_import_occupancy_months — the month as it was given ──────
-- @rls: service-role-only
create table if not exists public.inventory_import_occupancy_months (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,
  batch_id           uuid not null,
  month_start        date not null,
  rooms_available    integer check (rooms_available is null or rooms_available >= 0),
  rooms_sold         integer check (rooms_sold is null or rooms_sold >= 0),
  occupancy_pct      numeric(5,2) check (occupancy_pct is null or (occupancy_pct >= 0 and occupancy_pct <= 100)),
  -- Every daily_logs date this month wrote, with the values that were there
  -- before, so undo restores rather than blanks:
  --   [{ "date": "2026-03-04", "prior": { "occupied": null, "rooms_sold": null,
  --      "rooms_available": null, "occupancy_source": null } }, ...]
  applied_days       jsonb not null default '[]'::jsonb,
  applied_day_count  integer not null default 0 check (applied_day_count >= 0),
  created_at         timestamptz not null default now(),
  -- A month with neither a percentage nor a room count says nothing; refuse it
  -- at the column rather than storing a row that means nothing.
  constraint inventory_import_occupancy_months_has_a_number_ck
    check (occupancy_pct is not null or rooms_sold is not null),
  constraint inventory_import_occupancy_months_month_start_ck
    check (month_start = date_trunc('month', month_start)::date),
  constraint inventory_import_occupancy_months_applied_days_ck
    check (jsonb_typeof(applied_days) = 'array' and pg_column_size(applied_days) <= 16384),
  foreign key (batch_id, property_id)
    references public.inventory_import_batches (id, property_id) on delete cascade
);

create index if not exists inventory_import_occupancy_months_property_idx
  on public.inventory_import_occupancy_months (property_id, month_start desc);

create index if not exists inventory_import_occupancy_months_batch_idx
  on public.inventory_import_occupancy_months (batch_id);

comment on table public.inventory_import_occupancy_months is
  'Monthly occupancy exactly as the manager''s sheet gave it. The per-day daily_logs rows derived from it are recorded in applied_days with their prior values, so removing the import puts the daily record back the way it was.';

-- ─── RLS: deny-all to the browser on all three ────────────────────────────
-- Every read and write goes through /api/inventory/import/* with supabaseAdmin
-- behind the finance gate. No anon or authenticated role has any business
-- reading another hotel's supplier names or a manager's undo history.
do $$
declare
  t text;
begin
  foreach t in array array[
    'inventory_import_batches',
    'inventory_import_rows',
    'inventory_import_occupancy_months'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_deny_all_browser', t);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
      t || '_deny_all_browser', t
    );
  end loop;
end $$;

insert into public.applied_migrations (version, description)
values (
  '0452',
  'Inventory easy setup: import batches, per-row provenance, and monthly occupancy imports with the daily rows derived from them.'
)
on conflict (version) do nothing;

-- ─── Reload PostgREST's cached schema ─────────────────────────────────────
notify pgrst, 'reload schema';

commit;
