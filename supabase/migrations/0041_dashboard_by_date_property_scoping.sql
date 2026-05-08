-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0041: scope dashboard_by_date by property_id
--
-- Bug found in audit pass on 2026-05-08:
--   dashboard_by_date is a daily-snapshot table left over from when Staxis
--   was a single-tenant Firebase app. It has no property_id column, and the
--   RLS policy added in 0001 reads:
--     using (auth.role() = 'authenticated')
--   meaning any logged-in user could read every other tenant's daily
--   numbers (in_house, arrivals, departures, guest counts) once we add a
--   second hotel customer. For Mario alone today this is a non-issue, but
--   it's a guaranteed leak the moment client #2 signs.
--
-- Fix:
--   1. Add property_id column referencing properties(id)
--   2. Backfill existing rows from the single existing property (Mario's
--      Comfort Suites Beaumont) — no ambiguity since there's only one
--   3. Make property_id NOT NULL
--   4. Replace primary key (date) with composite (date, property_id) so
--      each property gets one row per local date
--   5. Drop the broad authenticated-can-read policy
--   6. Add an "owner rw" policy scoped via user_owns_property — same
--      pattern used by every other per-property table in 0001
--
-- Order of operations is important: code that writes property_id has
-- already been deployed (commit lands on main before this migration is
-- applied). The new code uses { onConflict: 'date,property_id' }, so the
-- new composite PK matches.
--
-- Safe on a live DB: no data loss, no truncation; the backfill assigns
-- existing rows to the single property and the schema change is a PK
-- swap that completes in milliseconds for this small table.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Add the column (nullable for the backfill step) ─────────────────────────
alter table public.dashboard_by_date
  add column if not exists property_id uuid
    references public.properties(id) on delete cascade;

-- 2. Backfill from the single existing property ──────────────────────────────
-- This is safe because the table has been single-tenant since inception.
-- A LIMIT 1 / oldest-first pick is deterministic for the only row that
-- exists today. If somehow this migration runs in an env with multiple
-- properties already present, the migration aborts via the assertion below
-- rather than silently mis-attributing rows.
do $$
declare
  v_property_count integer;
  v_property_id    uuid;
begin
  select count(*) into v_property_count from public.properties;
  if v_property_count = 0 then
    -- No properties yet — empty dashboard_by_date is the only valid state.
    if exists (select 1 from public.dashboard_by_date where property_id is null) then
      raise exception 'dashboard_by_date has rows but no properties exist to attribute them to';
    end if;
  elsif v_property_count = 1 then
    select id into v_property_id from public.properties limit 1;
    update public.dashboard_by_date
      set property_id = v_property_id
      where property_id is null;
  else
    -- Multi-property env reached this migration somehow. Bail loudly.
    raise exception 'dashboard_by_date backfill: % properties exist, cannot pick one automatically. Backfill manually before applying this migration.', v_property_count;
  end if;
end $$;

-- 3. Lock the column down ────────────────────────────────────────────────────
alter table public.dashboard_by_date
  alter column property_id set not null;

-- 4. Swap the primary key from (date) to (date, property_id) ─────────────────
alter table public.dashboard_by_date
  drop constraint if exists dashboard_by_date_pkey;
alter table public.dashboard_by_date
  add primary key (date, property_id);

-- 5. Drop the over-broad read policy ─────────────────────────────────────────
drop policy if exists "authenticated can read dashboard_by_date"
  on public.dashboard_by_date;

-- 6. Add a per-property policy in line with every other per-property table ───
drop policy if exists "owner rw dashboard_by_date" on public.dashboard_by_date;
create policy "owner rw dashboard_by_date"
  on public.dashboard_by_date
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

comment on column public.dashboard_by_date.property_id is
  'Multi-tenant scoping (added in 0041). Each property gets its own row per local date; RLS enforces that only owners of the property can read or write.';

insert into public.applied_migrations (version, description)
values ('0041', 'Scope dashboard_by_date by property_id (close multi-tenant leak)')
on conflict (version) do nothing;
