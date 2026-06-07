-- ═══════════════════════════════════════════════════════════════════════════
-- 0205 — Post-cutover patches (self-review + Codex findings).
--
-- Why this exists:
--   Two issues surfaced during the v4 cutover:
--
--   A. The live web app (main branch) heavily queries the legacy PMS
--      tables we dropped in 0204. With those tables gone, every
--      housekeeper / dashboard / work-order page returns
--      "relation does not exist" 500s instead of empty results.
--      Codex's adversarial review flagged this as a blocker.
--      Reeyen accepted breaking the live site, but empty responses
--      are strictly better UX than 500s while the new web app is
--      being built. This migration recreates EMPTY stubs with the
--      original column shapes so:
--        - SELECTs return `[]` (web app shows empty state)
--        - INSERTs from any dead-code-path that's still wired up
--          go to the empty table and disappear into the ether
--          (not a regression — we want them to disappear)
--        - DROPs / TRUNCATEs / future migrations can target these
--          tables without `if exists` shenanigans
--      The CUA worker writes to the NEW pms_* schema; it never
--      touches these stubs.
--
--   B. cua-service/src/cost-cap.ts does a read-modify-write to
--      property_sessions.daily_claude_cost_micros. Two concurrent
--      recordSpend calls race and one increment is lost.
--      Migration 0201 created the column but no atomic increment
--      function. This migration adds it.
--
-- Idempotent: create table if not exists + create or replace function.
-- Safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Part A: empty stub tables (legacy schema, no data) ─────────────────

-- public.rooms stub is KEPT here (NOT neutralized): although 0272 drops the
-- table at merge, it must EXIST as an empty stub from 0205 through 0271 because
-- many later migrations alter it unconditionally (0222 `alter table
-- public.rooms ...`, 0224/0225/0227/0228 + the `'public.rooms'::regclass`
-- cast). Removing the create here breaks a from-scratch replay at 0222
-- ("relation public.rooms does not exist"). 0272's DROP TABLE drops it last.
create table if not exists public.rooms (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid references public.properties(id) on delete cascade,
  number            text,
  date              date,
  type              text,
  priority          text default 'standard',
  status            text default 'dirty',
  assigned_to       uuid,
  assigned_name     text,
  started_at        timestamptz,
  completed_at      timestamptz,
  issue_note        text,
  inspected_by      text,
  inspected_at      timestamptz,
  is_dnd            boolean default false,
  dnd_note          text,
  arrival           text,
  stayover_day      integer,
  stayover_minutes  integer,
  help_requested    boolean default false,
  checklist         jsonb,
  photo_url         text,
  last_synced_at    timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create table if not exists public.work_orders (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid references public.properties(id) on delete cascade,
  room_number            text,
  description            text,
  severity               text,
  status                 text,
  submitted_by           text,
  submitted_by_name      text,
  assigned_to            uuid,
  assigned_name          text,
  photo_url              text,
  notes                  text,
  blocked_room           boolean default false,
  source                 text,
  ca_work_order_number   text,
  ca_from_date           text,
  ca_to_date             text,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now(),
  resolved_at            timestamptz
);

-- public.plan_snapshots is KEPT (NOT dropped in 0272): the Python ML service
-- (ml-service/src/{inference,training}/*.py) still queries it directly, so the
-- empty stub must remain until that unit is migrated off it.
create table if not exists public.plan_snapshots (
  property_id                       uuid references public.properties(id) on delete cascade,
  date                              date,
  pulled_at                         timestamptz default now(),
  pull_type                         text,
  total_rooms                       integer default 0,
  checkouts                         integer default 0,
  stayovers                         integer default 0,
  stayover_day1                     integer default 0,
  stayover_day2                     integer default 0,
  stayover_arrival_day              integer default 0,
  stayover_unknown                  integer default 0,
  arrivals                          integer default 0,
  vacant_clean                      integer default 0,
  vacant_dirty                      integer default 0,
  ooo                               integer default 0,
  checkout_minutes                  integer default 0,
  stayover_day1_minutes             integer default 0,
  stayover_day2_minutes             integer default 0,
  vacant_dirty_minutes              integer default 0,
  total_cleaning_minutes            integer default 0,
  recommended_hks                   numeric default 0,
  checkout_room_numbers             text[] default '{}',
  stayover_day1_room_numbers        text[] default '{}',
  stayover_day2_room_numbers        text[] default '{}',
  stayover_arrival_room_numbers     text[] default '{}',
  arrival_room_numbers              text[] default '{}',
  vacant_clean_room_numbers         text[] default '{}',
  vacant_dirty_room_numbers         text[] default '{}',
  ooo_room_numbers                  text[] default '{}',
  rooms                             jsonb default '[]'::jsonb,
  primary key (property_id, date)
);

-- public.scraper_status stub NEUTRALIZED (feature/pms-rooms-retire) —
-- dropped in migration 0272 (no functional reader: the cua-service refs are
-- comments and the doctor's only reader was the obsolete Railway-CRON check).
-- CREATE + seed intentionally skipped on replay.

create table if not exists public.dashboard_by_date (
  date                 date,
  property_id          uuid references public.properties(id) on delete cascade,
  in_house             integer,
  arrivals             integer,
  departures           integer,
  in_house_guests      integer,
  arrivals_guests      integer,
  departures_guests    integer,
  pulled_at            timestamptz,
  error_code           text,
  error_message        text,
  error_page           text,
  errored_at           timestamptz,
  primary key (date, property_id)
);

create table if not exists public.pull_metrics (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid references public.properties(id) on delete cascade,
  pull_type       text,
  ok              boolean default true,
  error_code      text,
  total_ms        integer,
  login_ms        integer,
  navigate_ms     integer,
  download_ms     integer,
  parse_ms        integer,
  rows            integer,
  pulled_at       timestamptz default now(),
  created_at      timestamptz default now()
);

-- RLS deny-all-browser (service-role only) for the stubs. Web app
-- routes go through supabaseAdmin so they bypass RLS regardless.

do $$
declare
  tbl text;
begin
  -- scraper_status removed from this list — neutralized above (zero post-0205
  -- references) and dropped in 0272. rooms + plan_snapshots stay in the loop:
  -- rooms must exist as a stub through 0206-0271 (many migrations alter it) and
  -- is dropped in 0272; plan_snapshots is KEPT (ML-unit dependency).
  for tbl in select unnest(array[
    'rooms',
    'work_orders',
    'plan_snapshots',
    'dashboard_by_date',
    'pull_metrics'
  ])
  loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on public.%I from public, anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on public.%I to service_role', tbl);
    execute format('drop policy if exists %I on public.%I', tbl || '_deny_all_browser', tbl);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
      tbl || '_deny_all_browser',
      tbl
    );
  end loop;
end $$;

-- ─── Part B: atomic cost-cap increment RPC ──────────────────────────────

-- staxis_cua_increment_spend: increment property_sessions.daily_claude_cost_micros
-- atomically and return (new_total, resets_at, status). Replaces the
-- read-modify-write in cost-cap.ts that lost increments under concurrent
-- recordSpend calls.

create or replace function public.staxis_cua_increment_spend(
  p_property_id uuid,
  p_micros bigint
)
returns table (
  new_total_micros bigint,
  resets_at timestamptz,
  status text
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_now timestamptz := now();
  v_reset timestamptz;
  v_total bigint;
  v_status text;
begin
  -- Atomic increment. RETURNING gives us the new value in one round-trip,
  -- and Postgres serializes concurrent UPDATEs on the same row so no
  -- increment is lost.
  update public.property_sessions
     set daily_claude_cost_micros = daily_claude_cost_micros + p_micros
   where property_id = p_property_id
  returning daily_claude_cost_micros, daily_claude_cost_resets_at, status
    into v_total, v_reset, v_status;

  if not found then
    -- Caller is recording spend for a property with no session row yet.
    -- Return zeros so cost-cap reports ok=true and the supervisor's
    -- create-row path can populate the row separately.
    return query select 0::bigint, v_now, 'starting'::text;
    return;
  end if;

  return query select v_total, v_reset, v_status;
end;
$$;

revoke all on function public.staxis_cua_increment_spend(uuid, bigint) from public, anon, authenticated;
grant execute on function public.staxis_cua_increment_spend(uuid, bigint) to service_role;

comment on function public.staxis_cua_increment_spend(uuid, bigint) is
  'Atomic increment of property_sessions.daily_claude_cost_micros. Used by cua-service/src/cost-cap.ts to avoid the read-modify-write race in concurrent recordSpend calls. Returns new total + resets_at + status. Added 0205.';

-- ─── Track the migration ─────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values ('0205', 'Post-cutover patches: empty stub tables for dropped legacy PMS tables (web-app 500-state recovery) + atomic cost-cap increment RPC.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
