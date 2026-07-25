-- ═══════════════════════════════════════════════════════════════════════════
-- 0343 — Business date, observations-vs-state, and as-of history.
--
-- THE PROBLEM THIS CLOSES
--   pms_in_house_snapshot's PRIMARY KEY is (property_id). One row per hotel,
--   forever. Every poll overwrites it, so "what was our occupancy at 4pm last
--   Tuesday" has no answer and never will. pms_future_bookings is keyed on
--   (property_id, pms_reservation_id), so a booking-pace curve — the same stay
--   date seen from thirty different vantage points — collapses into one row.
--   Neither loss can be backfilled later.
--
--   Every table reshaped here is at 0 rows TODAY (verified against prod
--   2026-07-24). This is pure DDL now and a data migration forever after.
--
-- WHAT LANDS
--   A. properties.business_date_cutoff_hour + staxis_business_date() — one
--      sanctioned definition of "which business day is this instant in",
--      in SQL and (mirrored) in src/lib/business-date.ts.
--   B. pms_table_schemas.time_grain — the writer registry now declares what
--      KIND of time each table carries, and a trigger makes the registry
--      unable to lie about the physical schema.
--   C. pms_in_house_snapshot → pms_occupancy_observation (append-only, one row
--      per reading) + a compat VIEW at the old name so all six readers and
--      today_property_counts_v1 keep their exact column contract.
--   D. pms_future_bookings (0 rows, duplicates pms_reservations) → dropped, and
--      pms_booking_pace created with the as-of grain a pickup curve needs.
--   E. as_of generations on the daily facts, so a corrected report never
--      destroys the earlier one — plus a _current view per fact table, which
--      is what every reader must use so a restatement counts ONCE.
--   F. pms_entity_change_log — change history for the tables that upsert in
--      place, via one trigger that no writer can bypass.
--   G. Append-only enforcement on every observation table.
--
-- WHAT IS DELIBERATELY NOT HERE
--   * source_report_id columns. 0341 already made ingest_run_id NOT NULL on
--     every pms_* write target and states the reason: a denormalized second
--     receipt is exactly the "two receipts that disagree" failure. The report
--     file is one join away (pms_ingest_runs.report_file_id).
--   * A rename of pms_rates_and_inventory.date to business_date. Its date is
--     the FUTURE STAY date of a rate/availability grid (0202), not an
--     accounting day — it gets the as_of grain, not the daily-fact grain, and
--     the column is renamed to stay_date to stop the confusion at the source.
--     pms_forecast_daily already IS the as-of pattern (forecast_date +
--     snapshot_date); it is classified, not reshaped.
--   * Retention crons for the observation tables. At one hotel and 42 MB that
--     is years away; the sanctioned purge function exists so the decision can
--     be made later without reopening the append-only guarantee.
--
-- LOUD ON PURPOSE — business_date_source is NOT NULL with NO DEFAULT on the
--   three daily-fact tables. A writer that does not state where the business
--   date came from cannot insert. A default would fabricate provenance for
--   every writer that forgot, which is the whole failure this workstream
--   exists to kill. All three tables are empty, so nothing breaks today; the
--   report-ingest writer must stamp it.
--
-- APPLY ORDER: after 0342. Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ Part A — the business date ════════════════════════════════════════════
-- Cutoff 0 = "the calendar day in the hotel's own timezone", which is exactly
-- today's behavior everywhere. Comfort Suites ships with 0, so this migration
-- changes no number for the live hotel. A hotel whose night audit runs at 3am
-- sets 3 and the 02:15 transaction lands on the previous business day.

alter table public.properties
  add column if not exists business_date_cutoff_hour smallint not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'properties_business_date_cutoff_hour_check') then
    alter table public.properties
      add constraint properties_business_date_cutoff_hour_check
      check (business_date_cutoff_hour between 0 and 6);
  end if;
end $$;

comment on column public.properties.business_date_cutoff_hour is
  'Hour (0-6, local) at which this hotel''s business day rolls over — its night-audit hour. 0 = plain calendar day (the default and today''s behavior). Added 0343.';

-- The single sanctioned SQL definition. Mirrors src/lib/business-date.ts, and
-- deliberately does the shift in LOCAL wall-clock time: `at time zone tz`
-- converts the instant to the hotel's wall clock, the cutoff is subtracted
-- there, and only then is it truncated to a date. No UTC round-trip, so the
-- UTC+14 skip-a-day bug that src/lib/schedule/local-date.ts exists to prevent
-- cannot occur here either.
create or replace function public.staxis_business_date(
  p_property_id uuid,
  p_instant     timestamptz
) returns date
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tz     text;
  v_cutoff smallint;
begin
  select coalesce(nullif(btrim(p.timezone), ''), 'UTC'), coalesce(p.business_date_cutoff_hour, 0)
    into v_tz, v_cutoff
    from public.properties p
   where p.id = p_property_id;

  if v_tz is null then
    v_tz := 'UTC';
    v_cutoff := 0;
  end if;

  begin
    return ((p_instant at time zone v_tz) - make_interval(hours => v_cutoff))::date;
  exception when others then
    -- An unparseable timezone must not take the write down. UTC is the honest
    -- fallback and matches propertyLocalToday()'s behavior in the app.
    return ((p_instant at time zone 'UTC') - make_interval(hours => v_cutoff))::date;
  end;
end;
$$;

revoke all on function public.staxis_business_date(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.staxis_business_date(uuid, timestamptz) to service_role;

comment on function public.staxis_business_date(uuid, timestamptz) is
  'Which business day an instant falls in for one property: local wall clock in properties.timezone, shifted back by business_date_cutoff_hour. The only sanctioned SQL definition. Created 0343.';

-- ═══ Part B — the registry declares its time grain ═════════════════════════
-- Four grains, because three would force business_date onto tables where it
-- does not exist (the review caught this: pms_forecast_daily is daily-shaped
-- but keyed on snapshot_date, and pms_rates_and_inventory's date is a stay
-- date):
--
--   observation — a reading taken at a moment. Append-only, never updated.
--   daily_fact  — an accounting figure FOR a business day, restatable.
--   as_of_grid  — a forward-looking grid (stay date x as-of), restatable.
--   entity      — a thing whose current state is upserted in place.
--
-- The trigger that enforces consistency is created in Part I, AFTER the
-- reshapes and the registry updates. Creating it here would make the very
-- next statement raise against a schema it is describing mid-flight.

alter table public.pms_table_schemas
  add column if not exists time_grain text not null default 'entity';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pms_table_schemas_time_grain_check') then
    alter table public.pms_table_schemas
      add constraint pms_table_schemas_time_grain_check
      check (time_grain in ('observation', 'daily_fact', 'as_of_grid', 'entity'));
  end if;
end $$;

comment on column public.pms_table_schemas.time_grain is
  'What kind of time this table carries: observation (a reading at a moment, append-only), daily_fact (an accounting figure for a business day, restatable), as_of_grid (forward-looking grid keyed by when it was seen), entity (current state, upserted). Enforced against the physical schema by staxis_pms_registry_matches_reality(). Added 0343.';

-- ═══ Part C — occupancy stops being overwritten ════════════════════════════

do $$
begin
  if to_regclass('public.pms_in_house_snapshot') is not null
     and (select relkind from pg_class where oid = to_regclass('public.pms_in_house_snapshot')) = 'r' then
    alter table public.pms_in_house_snapshot rename to pms_occupancy_observation;
  end if;
end $$;

-- 0341 attached its stale-ingest BEFORE UPDATE guard here. The table is
-- append-only from now on (Part G blocks UPDATE outright), so the guard is
-- unreachable — drop it rather than leave a trigger that can never fire.
drop trigger if exists reject_stale_ingest on public.pms_occupancy_observation;

alter table public.pms_occupancy_observation
  add column if not exists id                 uuid not null default gen_random_uuid(),
  add column if not exists observed_at        timestamptz,
  add column if not exists observed_at_source text,
  add column if not exists business_date      date;

-- Backfill from what the old shape recorded, then harden. captured_at is the
-- writer-stamped read time — the honest observed_at for every CUA-era row.
update public.pms_occupancy_observation
   set observed_at = coalesce(observed_at, captured_at, last_synced_at, now())
 where observed_at is null;

update public.pms_occupancy_observation
   set observed_at_source = coalesce(observed_at_source, 'robot_capture')
 where observed_at_source is null;

update public.pms_occupancy_observation o
   set business_date = public.staxis_business_date(o.property_id, o.observed_at)
 where o.business_date is null;

do $$
begin
  -- PK (property_id) is the whole bug: it is what makes the table hold one row.
  if exists (select 1 from pg_constraint where conname = 'pms_in_house_snapshot_pkey') then
    alter table public.pms_occupancy_observation drop constraint pms_in_house_snapshot_pkey;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pms_occupancy_observation_pkey') then
    alter table public.pms_occupancy_observation add constraint pms_occupancy_observation_pkey primary key (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pms_occupancy_observation_natural_key') then
    alter table public.pms_occupancy_observation
      add constraint pms_occupancy_observation_natural_key unique (property_id, observed_at);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pms_occupancy_observation_observed_source_check') then
    alter table public.pms_occupancy_observation
      add constraint pms_occupancy_observation_observed_source_check
      check (observed_at_source in ('report_printed', 'email_received', 'robot_capture'));
  end if;
end $$;

-- Feed health lives on pms_feed_values, keyed (property_id, feed_key), and has
-- carried has_error / last_error / last_good_at since 0291. Two copies of "is
-- this feed healthy" is one copy too many, and the stale one wins arguments.
alter table public.pms_occupancy_observation
  drop column if exists has_error,
  drop column if exists last_error,
  drop column if exists last_error_at,
  drop column if exists last_good_at;

alter table public.pms_occupancy_observation
  alter column observed_at        set not null,
  alter column observed_at_source set not null,
  alter column business_date      set not null;

create index if not exists pms_occupancy_observation_pid_observed_idx
  on public.pms_occupancy_observation (property_id, observed_at desc);
create index if not exists pms_occupancy_observation_pid_bdate_idx
  on public.pms_occupancy_observation (property_id, business_date);

comment on table public.pms_occupancy_observation is
  'Every reading of a hotel''s live in-house counts, one row per observation. Was pms_in_house_snapshot, whose PK (property_id) overwrote the only row 48 times a day and kept nothing. Append-only. Renamed/reshaped 0343.';
comment on column public.pms_occupancy_observation.observed_at is
  'When the counts were TRUE, not when we stored them. From the report''s printed time where the report states one, else the time the mail arrived.';
comment on column public.pms_occupancy_observation.observed_at_source is
  'How honest observed_at is: report_printed (the report says so), email_received (we only know when it arrived), robot_capture (a CUA screen read).';
comment on column public.pms_occupancy_observation.business_date is
  'Which business day the observation falls in — DERIVED from observed_at by staxis_business_date(). Legitimate for an observation (it is a fact about a moment); NOT legitimate for a daily accounting fact, which must carry the date the report printed.';

-- ─── Compat view at the old name ───────────────────────────────────────────
-- Six readers plus SECURITY DEFINER today_property_counts_v1 select from
-- pms_in_house_snapshot with .maybeSingle() semantics. DISTINCT ON gives them
-- exactly one row per property — the newest — with the identical column set.
--
-- Health columns are derived from the observation itself, NOT joined from
-- pms_feed_values. Two reasons: live feed_key values are getter names
-- ('getDashboardCounts'), so the obvious join would silently never match; and
-- a stale CUA-era has_error=true would permanently fail seal-daily's
-- positive-evidence gate in the report era — the NULL-forever inverse of the
-- fabricated-zero-occupancy incident. An observation row exists only because a
-- good reading landed, so last_good_at = observed_at is the truth.

drop view if exists public.pms_in_house_snapshot;
create view public.pms_in_house_snapshot
with (security_invoker = true) as
select distinct on (o.property_id)
  o.property_id,
  o.total_guests_in_house,
  o.total_occupied_rooms,
  o.total_vacant_clean,
  o.total_vacant_dirty,
  o.total_ooo,
  o.arrivals_remaining_today,
  o.departures_remaining_today,
  o.walk_ins_today,
  o.vip_guests_in_house,
  o.special_needs_guests_in_house,
  o.checked_in_today_count,
  o.checked_out_today_count,
  o.no_shows_today,
  o.cancellations_today,
  o.revenue_today_so_far_cents,
  o.observed_at as captured_at,
  o.observed_at as last_synced_at,
  o.observed_at as last_good_at,
  false         as has_error,
  null::text    as last_error,
  o.raw,
  o.ingest_run_id
from public.pms_occupancy_observation o
order by o.property_id, o.observed_at desc;

revoke all on public.pms_in_house_snapshot from public, anon, authenticated;
grant select on public.pms_in_house_snapshot to service_role;

comment on view public.pms_in_house_snapshot is
  'Compat shim: the NEWEST occupancy observation per property, in the exact column shape the old one-row-per-hotel table had. Readers that want history select from pms_occupancy_observation directly. Created 0343.';

-- ─── Stamp trigger: observed_at and business_date fill themselves ──────────
-- observed_at comes from the receipt 0341 already made mandatory, so it cannot
-- disagree with the ingest run that produced the row.

create or replace function public.staxis_pms_stamp_observation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.observed_at is null then
    select r.source_captured_at into new.observed_at
      from public.pms_ingest_runs r
     where r.id = new.ingest_run_id;
    if new.observed_at is null then
      new.observed_at := now();
    end if;
  end if;
  if new.observed_at_source is null then
    new.observed_at_source := 'email_received';
  end if;
  if new.business_date is null then
    new.business_date := public.staxis_business_date(new.property_id, new.observed_at);
  end if;
  return new;
end;
$$;

comment on function public.staxis_pms_stamp_observation() is
  'BEFORE INSERT on pms_occupancy_observation: fills observed_at from the row''s ingest run (never a second, disagreeing clock) and derives business_date via staxis_business_date(). Created 0343.';

drop trigger if exists stamp_observation on public.pms_occupancy_observation;
create trigger stamp_observation
  before insert on public.pms_occupancy_observation
  for each row execute function public.staxis_pms_stamp_observation();

-- ═══ Part D — booking pace gets the grain a pickup curve needs ═════════════
-- pms_future_bookings held individual future reservations keyed on
-- (property_id, pms_reservation_id) — which is what pms_reservations already
-- is, down to arrival_date / departure_date / status / rate_per_night_cents /
-- channel_name. It is at 0 rows and buys nothing. Individual future stays go
-- to pms_reservations; the aggregate on-the-books curve goes here.

drop table if exists public.pms_future_bookings;

-- @rls: service-role-only
create table if not exists public.pms_booking_pace (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  -- The vantage point: the business day this reading of the books was taken.
  as_of_date            date not null,
  -- The night being sold.
  stay_date             date not null,
  rooms_otb             integer,
  revenue_otb_cents     bigint,
  adr_otb_cents         bigint,
  transient_rooms_otb   integer,
  group_rooms_otb       integer,
  rooms_available       integer,
  cancellations_to_date integer,
  raw                   jsonb,
  observed_at           timestamptz,
  ingest_run_id         uuid not null references public.pms_ingest_runs(id) on delete cascade,
  created_at            timestamptz not null default now(),
  constraint pms_booking_pace_natural_key unique (property_id, as_of_date, stay_date),
  -- A pace report printed just after night audit can legitimately still carry
  -- the day that just closed, so the window is as_of - 1, not as_of. Tightening
  -- this before a real report is in hand would refuse real data.
  constraint pms_booking_pace_stay_after_as_of check (stay_date >= as_of_date - 1),
  constraint pms_booking_pace_rooms_otb_check check (rooms_otb is null or rooms_otb >= 0),
  constraint pms_booking_pace_rooms_available_check check (rooms_available is null or rooms_available >= 0)
);

alter table public.pms_booking_pace enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'pms_booking_pace'
       and policyname = 'pms_booking_pace_deny_all_browser'
  ) then
    create policy pms_booking_pace_deny_all_browser on public.pms_booking_pace
      as permissive for all to anon, authenticated
      using (false) with check (false);
  end if;
end $$;

revoke all on public.pms_booking_pace from public, anon, authenticated;
grant select, insert on public.pms_booking_pace to service_role;

create index if not exists pms_booking_pace_stay_idx
  on public.pms_booking_pace (property_id, stay_date, as_of_date);
create index if not exists pms_booking_pace_ingest_run_idx
  on public.pms_booking_pace (ingest_run_id);

comment on table public.pms_booking_pace is
  'On-the-books rooms/revenue for a future stay date, as seen on a given day. Thirty rows for one stay_date IS the pickup curve. Replaces pms_future_bookings, whose key (property_id, pms_reservation_id) made the curve permanently unqueryable. Created 0343.';

create or replace function public.staxis_pms_stamp_pace()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.observed_at is null then
    select r.source_captured_at into new.observed_at
      from public.pms_ingest_runs r
     where r.id = new.ingest_run_id;
    if new.observed_at is null then
      new.observed_at := now();
    end if;
  end if;
  return new;
end;
$$;

comment on function public.staxis_pms_stamp_pace() is
  'BEFORE INSERT on pms_booking_pace: fills observed_at from the row''s ingest run. as_of_date stays writer-supplied — it is the business day the report states, never a clock guess. Created 0343.';

drop trigger if exists stamp_pace on public.pms_booking_pace;
create trigger stamp_pace
  before insert on public.pms_booking_pace
  for each row execute function public.staxis_pms_stamp_pace();

-- ═══ Part E — restatable daily facts ═══════════════════════════════════════
-- A corrected report lands as a NEW as_of generation. Nothing is deleted; the
-- earlier truth stays queryable; the _current view is what "now" means.
--
-- READERS MUST USE THE _current VIEWS. Summing the base table over a range
-- double-counts every restated day. That is enforced socially here and by
-- src/lib/__tests__/pms-as-of-readers.test.ts in the app.

alter table public.pms_revenue_daily
  add column if not exists as_of                timestamptz,
  add column if not exists business_date_source text;
alter table public.pms_payments_daily
  add column if not exists as_of                timestamptz,
  add column if not exists business_date_source text;
alter table public.pms_channel_performance
  add column if not exists as_of                timestamptz,
  add column if not exists business_date_source text;
alter table public.pms_rates_and_inventory
  add column if not exists as_of                timestamptz;

do $$
begin
  -- `date` is an accounting day on these two. Renaming it to business_date is
  -- the point: the column name now says which of the two date meanings it is.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'pms_revenue_daily' and column_name = 'date'
  ) then
    alter table public.pms_revenue_daily rename column "date" to business_date;
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'pms_channel_performance' and column_name = 'date'
  ) then
    alter table public.pms_channel_performance rename column "date" to business_date;
  end if;
  -- pms_rates_and_inventory's `date` is the FUTURE STAY date of a rate grid
  -- (0202: "per room_type x date x rate_plan"), not an accounting day.
  -- Renaming it business_date would have been a lie; stay_date is what it is.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'pms_rates_and_inventory' and column_name = 'date'
  ) then
    alter table public.pms_rates_and_inventory rename column "date" to stay_date;
  end if;
end $$;

-- Both tables are empty (verified against prod), so NOT NULL needs no default —
-- and a default is exactly what must not exist for business_date_source.
do $$
begin
  if (select count(*) from public.pms_revenue_daily) = 0 then
    alter table public.pms_revenue_daily alter column business_date_source set not null;
  end if;
  if (select count(*) from public.pms_payments_daily) = 0 then
    alter table public.pms_payments_daily alter column business_date_source set not null;
  end if;
  if (select count(*) from public.pms_channel_performance) = 0 then
    alter table public.pms_channel_performance alter column business_date_source set not null;
  end if;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['pms_revenue_daily', 'pms_payments_daily', 'pms_channel_performance']
  loop
    if not exists (select 1 from pg_constraint where conname = t || '_business_date_source_check') then
      execute format(
        'alter table public.%I add constraint %I check (business_date_source in (%L, %L))',
        t, t || '_business_date_source_check', 'report_printed', 'operator_entered'
      );
    end if;
  end loop;
end $$;

-- ─── as_of stamping, from the receipt ──────────────────────────────────────
create or replace function public.staxis_pms_stamp_as_of()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.as_of is null then
    select r.source_captured_at into new.as_of
      from public.pms_ingest_runs r
     where r.id = new.ingest_run_id;
    if new.as_of is null then
      new.as_of := now();
    end if;
  end if;
  return new;
end;
$$;

comment on function public.staxis_pms_stamp_as_of() is
  'BEFORE INSERT on the restatable fact tables: fills as_of from the row''s ingest run so the generation stamp and the receipt can never disagree. Created 0343.';

do $$
declare
  t text;
begin
  foreach t in array array['pms_revenue_daily', 'pms_payments_daily', 'pms_channel_performance', 'pms_rates_and_inventory']
  loop
    execute format('drop trigger if exists stamp_as_of on public.%I', t);
    execute format(
      'create trigger stamp_as_of before insert on public.%I for each row execute function public.staxis_pms_stamp_as_of()', t
    );
  end loop;
end $$;

do $$
begin
  if (select count(*) from public.pms_revenue_daily) = 0 then
    alter table public.pms_revenue_daily alter column as_of set not null;
  end if;
  if (select count(*) from public.pms_payments_daily) = 0 then
    alter table public.pms_payments_daily alter column as_of set not null;
  end if;
  if (select count(*) from public.pms_channel_performance) = 0 then
    alter table public.pms_channel_performance alter column as_of set not null;
  end if;
  if (select count(*) from public.pms_rates_and_inventory) = 0 then
    alter table public.pms_rates_and_inventory alter column as_of set not null;
  end if;
end $$;

-- ─── Unique keys gain the generation ───────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'pms_revenue_daily_unique') then
    alter table public.pms_revenue_daily drop constraint pms_revenue_daily_unique;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pms_revenue_daily_natural_key') then
    alter table public.pms_revenue_daily
      add constraint pms_revenue_daily_natural_key unique (property_id, business_date, as_of);
  end if;

  -- pms_payments_daily already had business_date; only the generation is new.
  -- Drop the 2-column key, keep the 3-column one on a re-run.
  if exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.pms_payments_daily'::regclass
       and c.conname = 'pms_payments_daily_natural_key'
       and coalesce(array_length(c.conkey, 1), 0) < 3
  ) then
    alter table public.pms_payments_daily drop constraint pms_payments_daily_natural_key;
  end if;
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.pms_payments_daily'::regclass
       and c.conname = 'pms_payments_daily_natural_key'
  ) then
    alter table public.pms_payments_daily
      add constraint pms_payments_daily_natural_key unique (property_id, business_date, as_of);
  end if;

  if exists (select 1 from pg_constraint where conname = 'pms_channel_performance_unique') then
    alter table public.pms_channel_performance drop constraint pms_channel_performance_unique;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pms_channel_performance_natural_key') then
    alter table public.pms_channel_performance
      add constraint pms_channel_performance_natural_key unique (property_id, business_date, as_of, channel);
  end if;
end $$;

-- rate_plan is nullable and Postgres treats NULLs as distinct, so the 0202
-- index used COALESCE(rate_plan, ''). Keep that shape and add the generation.
drop index if exists public.pms_rates_inventory_unique_idx;
create unique index if not exists pms_rates_and_inventory_natural_uidx
  on public.pms_rates_and_inventory (property_id, as_of, stay_date, room_type, coalesce(rate_plan, ''));

create index if not exists pms_revenue_daily_bdate_idx
  on public.pms_revenue_daily (property_id, business_date, as_of desc);
create index if not exists pms_channel_performance_bdate_idx
  on public.pms_channel_performance (property_id, business_date, as_of desc);
create index if not exists pms_payments_daily_bdate_as_of_idx
  on public.pms_payments_daily (property_id, business_date, as_of desc);

comment on column public.pms_revenue_daily.business_date is
  'The accounting day this revenue belongs to — the date the REPORT PRINTED, never derived from a timestamp. Renamed from `date` in 0343.';
comment on column public.pms_revenue_daily.as_of is
  'Which generation of the truth this row is. A corrected report lands as a new as_of; the old row survives. Read pms_revenue_daily_current unless you specifically want history.';
comment on column public.pms_revenue_daily.business_date_source is
  'report_printed = the report stated the date on its face. operator_entered = a human said so. There is no third value, so a derived date cannot be recorded as anything else.';
comment on column public.pms_rates_and_inventory.stay_date is
  'The FUTURE NIGHT this rate/availability applies to. Renamed from `date` in 0343 because it was being read as an accounting day, which it never was.';

-- ─── _current views: "what we believe now", one row per business day ───────
create or replace view public.pms_revenue_daily_current
with (security_invoker = true) as
select distinct on (property_id, business_date) *
  from public.pms_revenue_daily
 order by property_id, business_date, as_of desc;

create or replace view public.pms_payments_daily_current
with (security_invoker = true) as
select distinct on (property_id, business_date) *
  from public.pms_payments_daily
 order by property_id, business_date, as_of desc;

create or replace view public.pms_channel_performance_current
with (security_invoker = true) as
select distinct on (property_id, business_date, channel) *
  from public.pms_channel_performance
 order by property_id, business_date, channel, as_of desc;

create or replace view public.pms_rates_and_inventory_current
with (security_invoker = true) as
select distinct on (property_id, stay_date, room_type, coalesce(rate_plan, '')) *
  from public.pms_rates_and_inventory
 order by property_id, stay_date, room_type, coalesce(rate_plan, ''), as_of desc;

-- pms_forecast_daily already had this grain under different column names
-- (forecast_date x snapshot_date). It gets the view, not a reshape.
create or replace view public.pms_forecast_daily_current
with (security_invoker = true) as
select distinct on (property_id, forecast_date) *
  from public.pms_forecast_daily
 order by property_id, forecast_date, snapshot_date desc;

do $$
declare
  v text;
begin
  foreach v in array array[
    'pms_revenue_daily_current', 'pms_payments_daily_current', 'pms_channel_performance_current',
    'pms_rates_and_inventory_current', 'pms_forecast_daily_current'
  ]
  loop
    execute format('revoke all on public.%I from public, anon, authenticated', v);
    execute format('grant select on public.%I to service_role', v);
    execute format(
      'comment on view public.%I is %L', v,
      'Newest generation only, one row per business day / stay night. Range aggregates MUST read this, not the base table, or a restated day is counted twice. Created 0343.'
    );
  end loop;
end $$;

-- ═══ Part F — change history for the tables that upsert in place ═══════════

-- @rls: service-role-only
create table if not exists public.pms_entity_change_log (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null references public.properties(id) on delete cascade,
  table_name     text not null,
  entity_key     text not null,
  changed_at     timestamptz not null default now(),
  changed_fields text[] not null,
  before         jsonb not null,
  after          jsonb not null,
  ingest_run_id  uuid references public.pms_ingest_runs(id) on delete set null
);

alter table public.pms_entity_change_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'pms_entity_change_log'
       and policyname = 'pms_entity_change_log_deny_all_browser'
  ) then
    create policy pms_entity_change_log_deny_all_browser on public.pms_entity_change_log
      as permissive for all to anon, authenticated
      using (false) with check (false);
  end if;
end $$;

revoke all on public.pms_entity_change_log from public, anon, authenticated;
grant select, insert on public.pms_entity_change_log to service_role;

create index if not exists pms_entity_change_log_lookup_idx
  on public.pms_entity_change_log (property_id, table_name, entity_key, changed_at desc);

comment on table public.pms_entity_change_log is
  'Before/after of every meaningful change to an upsert-in-place PMS entity (rate moved, dates moved, status changed, room reassigned). One generic trigger, so no writer — not the CUA, not an API route, not hand-run SQL — can change one of those rows without leaving a trace. Created 0343.';

-- The ignore list is what keeps this free: the CUA re-upserts unchanged rows on
-- every poll, and last_synced_at/updated_at move every time. Without the early
-- return that is one log row per row per poll, forever.
create or replace function public.staxis_pms_log_entity_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_ignore  text[] := coalesce(tg_argv[0], '')::text[];
  v_key_col text := tg_argv[1];
  v_before  jsonb;
  v_after   jsonb;
  v_changed text[];
  v_ign     text;
begin
  v_before := to_jsonb(old);
  v_after  := to_jsonb(new);

  foreach v_ign in array v_ignore loop
    v_before := v_before - v_ign;
    v_after  := v_after  - v_ign;
  end loop;

  if v_before = v_after then
    return null; -- AFTER trigger: return value ignored, but cheap and explicit
  end if;

  select coalesce(array_agg(ok.col order by ok.col), '{}'::text[])
    into v_changed
    from jsonb_object_keys(v_before || v_after) as ok(col)
   where (v_before -> ok.col) is distinct from (v_after -> ok.col);

  if v_changed = '{}'::text[] then
    return null;
  end if;

  insert into public.pms_entity_change_log
    (property_id, table_name, entity_key, changed_fields, before, after, ingest_run_id)
  values (
    new.property_id,
    tg_table_name,
    coalesce(v_after ->> v_key_col, v_before ->> v_key_col, '(unkeyed)'),
    v_changed,
    v_before,
    v_after,
    new.ingest_run_id
  );

  return null;
end;
$$;

comment on function public.staxis_pms_log_entity_change() is
  'AFTER UPDATE on the upsert-in-place pms_* tables. TG_ARGV[0] = ignore list (bookkeeping columns), TG_ARGV[1] = the column that names the entity. Returns early when the meaningful columns are unchanged, which is the common case on every poll. Created 0343.';

do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('pms_reservations',    'pms_reservation_id'),
      ('pms_guests',          'pms_guest_id'),
      ('pms_guest_balances',  'pms_folio_id'),
      ('pms_work_orders_v2',  'pms_work_order_id'),
      ('pms_rooms_inventory', 'room_number')
    ) as t(tbl, key_col)
  loop
    execute format('drop trigger if exists log_entity_change on public.%I', spec.tbl);
    execute format(
      'create trigger log_entity_change after update on public.%I for each row execute function public.staxis_pms_log_entity_change(%L, %L)',
      spec.tbl,
      '{last_synced_at,updated_at,created_at,raw,captured_at,ingest_run_id}',
      spec.key_col
    );
  end loop;
end $$;

-- ═══ Part G — append-only means append-only ════════════════════════════════
-- Same belt-and-braces shape as the property-immutability triggers in 0312:
-- REVOKE for the ordinary path, a trigger for everything else (including a
-- superuser at psql).

create or replace function public.staxis_pms_observation_immutable()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    -- Two sanctioned deletions, and only two:
    --   1. staxis_pms_purge_observations() sets the session flag.
    --   2. The property itself is being deleted. RI cascade removes the parent
    --      row first, so "no parent" IS the cascade, and delete-hotel (a
    --      129-FK cascade off one properties DELETE) must not be blocked.
    if coalesce(current_setting('staxis.allow_observation_purge', true), '') = 'on' then
      return old;
    end if;
    if not exists (select 1 from public.properties p where p.id = old.property_id) then
      return old;
    end if;
    raise exception
      '% is append-only: rows are never deleted outside staxis_pms_purge_observations()', tg_table_name
      using errcode = '23514';
  end if;

  raise exception
    '% is append-only: an observation records what was true at a moment and cannot be edited', tg_table_name
    using errcode = '23514';
end;
$$;

comment on function public.staxis_pms_observation_immutable() is
  'BEFORE UPDATE OR DELETE on the observation tables. Blocks both; allows DELETE only under the purge flag or during a property cascade. Created 0343.';

do $$
declare
  t text;
begin
  foreach t in array array[
    'pms_room_status_log', 'pms_activity_log', 'pms_occupancy_observation',
    'pms_booking_pace', 'pms_entity_change_log'
  ]
  loop
    execute format('revoke update, delete on public.%I from service_role', t);
    execute format('drop trigger if exists observation_immutable on public.%I', t);
    execute format(
      'create trigger observation_immutable before update or delete on public.%I for each row execute function public.staxis_pms_observation_immutable()', t
    );
  end loop;
end $$;

create or replace function public.staxis_pms_purge_observations(
  p_table  text,
  p_before date
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_ts_col text;
  v_n      bigint;
begin
  if p_table not in ('pms_room_status_log', 'pms_activity_log', 'pms_occupancy_observation',
                     'pms_booking_pace', 'pms_entity_change_log') then
    raise exception 'staxis_pms_purge_observations: % is not an observation table', p_table
      using errcode = 'invalid_parameter_value';
  end if;

  v_ts_col := case p_table
    when 'pms_room_status_log'        then 'changed_at'
    when 'pms_activity_log'           then 'captured_at'
    when 'pms_occupancy_observation'  then 'observed_at'
    when 'pms_booking_pace'           then 'created_at'
    else 'changed_at'
  end;

  perform set_config('staxis.allow_observation_purge', 'on', true);
  execute format('delete from public.%I where %I < %L::date', p_table, v_ts_col, p_before);
  get diagnostics v_n = row_count;
  perform set_config('staxis.allow_observation_purge', 'off', true);
  return v_n;
end;
$$;

revoke all on function public.staxis_pms_purge_observations(text, date) from public, anon, authenticated;
grant execute on function public.staxis_pms_purge_observations(text, date) to service_role;

comment on function public.staxis_pms_purge_observations(text, date) is
  'The ONE sanctioned way to delete observation rows — a retention sweep, nothing else. Sets a transaction-local flag the immutability trigger honors. No retention cron calls it yet; it exists so that decision can be made later without reopening the append-only guarantee. Created 0343.';

-- ═══ Part H — the registry catches up with the schema ══════════════════════
-- ORDER MATTERS. Every natural_key below must already match a real unique
-- index (built above), because Part I's trigger checks exactly that and is
-- created immediately after. Doing this the other way round makes the
-- migration raise on its own backfill.

update public.pms_table_schemas
   set table_name     = 'pms_occupancy_observation',
       write_strategy = 'append',
       natural_key    = array['property_id', 'observed_at']::text[],
       time_grain     = 'observation',
       notes          = 'Every reading of the live in-house counts. Was pms_in_house_snapshot with PK (property_id), which kept exactly one row per hotel. Reshaped 0343.',
       updated_at     = now()
 where table_name = 'pms_in_house_snapshot';

update public.pms_table_schemas
   set table_name     = 'pms_booking_pace',
       write_strategy = 'append',
       snapshot_scope_default = 'full',
       natural_key    = array['property_id', 'as_of_date', 'stay_date']::text[],
       time_grain     = 'observation',
       reconcile_key_field = null,
       notes          = 'On-the-books rooms/revenue for a future stay date, as of one day. Replaces pms_future_bookings (individual reservations now live in pms_reservations). Reshaped 0343.',
       columns        = '[
         {"name": "as_of_date",            "type": "date",    "nullable": false, "required": true},
         {"name": "stay_date",             "type": "date",    "nullable": false, "required": true},
         {"name": "rooms_otb",             "type": "integer", "nullable": true,  "required": false, "range_min": 0},
         {"name": "revenue_otb_cents",     "type": "bigint",  "nullable": true,  "required": false, "range_min": 0},
         {"name": "adr_otb_cents",         "type": "bigint",  "nullable": true,  "required": false, "range_min": 0},
         {"name": "transient_rooms_otb",   "type": "integer", "nullable": true,  "required": false, "range_min": 0},
         {"name": "group_rooms_otb",       "type": "integer", "nullable": true,  "required": false, "range_min": 0},
         {"name": "rooms_available",       "type": "integer", "nullable": true,  "required": false, "range_min": 0},
         {"name": "cancellations_to_date", "type": "integer", "nullable": true,  "required": false, "range_min": 0}
       ]'::jsonb,
       updated_at     = now()
 where table_name = 'pms_future_bookings';

-- The descriptor's `columns` names the columns the writer targets. A rename
-- that skipped this would leave the writer aiming at a column that no longer
-- exists — a silent no-op feed, which is the failure mode this whole
-- workstream is about.
update public.pms_table_schemas
   set natural_key = array['property_id', 'business_date', 'as_of']::text[],
       time_grain  = 'daily_fact',
       columns     = (
         select jsonb_agg(
                  case when c ->> 'name' = 'date'
                       then jsonb_set(c, '{name}', '"business_date"'::jsonb)
                       else c end
                  order by ord
                )
           from jsonb_array_elements(columns) with ordinality as e(c, ord)
       ),
       updated_at  = now()
 where table_name = 'pms_revenue_daily';

update public.pms_table_schemas
   set natural_key = array['property_id', 'business_date', 'as_of']::text[],
       time_grain  = 'daily_fact',
       updated_at  = now()
 where table_name = 'pms_payments_daily';

update public.pms_table_schemas
   set natural_key = array['property_id', 'business_date', 'as_of', 'channel']::text[],
       time_grain  = 'daily_fact',
       columns     = (
         select jsonb_agg(
                  case when c ->> 'name' = 'date'
                       then jsonb_set(c, '{name}', '"business_date"'::jsonb)
                       else c end
                  order by ord
                )
           from jsonb_array_elements(columns) with ordinality as e(c, ord)
       ),
       updated_at  = now()
 where table_name = 'pms_channel_performance';

update public.pms_table_schemas
   set natural_key = array['property_id', 'as_of', 'stay_date', 'room_type', 'rate_plan']::text[],
       time_grain  = 'as_of_grid',
       columns     = (
         select jsonb_agg(
                  case when c ->> 'name' = 'date'
                       then jsonb_set(c, '{name}', '"stay_date"'::jsonb)
                       else c end
                  order by ord
                )
           from jsonb_array_elements(columns) with ordinality as e(c, ord)
       ),
       updated_at  = now()
 where table_name = 'pms_rates_and_inventory';

-- Already the as-of pattern since 0202, under different column names.
update public.pms_table_schemas
   set time_grain = 'as_of_grid', updated_at = now()
 where table_name = 'pms_forecast_daily';

update public.pms_table_schemas
   set time_grain = 'observation', updated_at = now()
 where table_name in ('pms_room_status_log', 'pms_activity_log');

update public.pms_table_schemas
   set time_grain = 'entity', updated_at = now()
 where time_grain is null
    or table_name in (
      'pms_cancellations', 'pms_groups_and_blocks', 'pms_guest_balances', 'pms_guests',
      'pms_housekeeping_assignments', 'pms_lost_and_found', 'pms_no_shows',
      'pms_reservations', 'pms_rooms_inventory', 'pms_work_orders_v2'
    );

-- ═══ Part I — the registry can no longer lie ═══════════════════════════════
-- Today nothing forces pms_table_schemas — the descriptor table every writer
-- reads before it writes — to match the physical schema. A natural_key with no
-- unique index behind it produces silent duplicate rows on every poll; a
-- table_name typo produces a feed that has simply never worked.

create or replace function public._staxis_unique_index_columns(p_rel oid)
returns setof text[]
language sql
stable
set search_path = pg_catalog, public
as $$
  select (
    select array_agg(distinct nm order by nm)::text[]
      from (
        -- Plain indexed columns.
        select a.attname::text as nm
          from unnest(i.indkey::int2[]) k
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k
         where k > 0
        union
        -- Columns referenced from inside an index EXPRESSION, e.g.
        -- coalesce(rate_plan, ''). pg_depend records these; indkey does not.
        select a2.attname::text
          from pg_depend d
          join pg_attribute a2 on a2.attrelid = d.refobjid and a2.attnum = d.refobjsubid
         where d.classid = 'pg_class'::regclass
           and d.objid = i.indexrelid
           and d.refclassid = 'pg_class'::regclass
           and d.refobjsubid > 0
      ) s
  )
  from pg_index i
  -- Partial indexes guarantee nothing globally, so they cannot back a natural
  -- key. Invalid ones (a failed CONCURRENTLY build) enforce nothing at all.
  where i.indrelid = p_rel and i.indisunique and i.indisvalid and i.indpred is null;
$$;

comment on function public._staxis_unique_index_columns(oid) is
  'Every UNIQUE index on a relation, as its set of referenced column names (expression indexes included, via pg_depend). Helper for staxis_pms_registry_matches_reality(). Created 0343.';

create or replace function public.staxis_pms_registry_violations()
returns table (table_name text, violation text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select t.table_name::text, v.violation
    from public.pms_table_schemas t
    cross join lateral (
      select case
        when to_regclass('public.' || quote_ident(t.table_name)) is null
          then 'names a relation that does not exist'
        when (select c.relkind from pg_class c where c.oid = to_regclass('public.' || quote_ident(t.table_name))) <> 'r'
          then 'names something that is not a base table (a view cannot be written to)'
        when not exists (
          select 1 from public._staxis_unique_index_columns(to_regclass('public.' || quote_ident(t.table_name))) cols
           where cols @> t.natural_key and cols <@ t.natural_key
        ) then 'natural_key has no matching UNIQUE index — every write duplicates instead of upserting'
        when t.time_grain = 'observation' and t.write_strategy <> 'append'
          then 'observation grain must use write_strategy=append; anything else overwrites history'
        when t.time_grain = 'daily_fact' and not exists (
          select 1 from information_schema.columns c
           where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'business_date'
        ) then 'daily_fact grain requires a business_date column'
        when t.time_grain = 'daily_fact' and not ('business_date' = any (t.natural_key))
          then 'daily_fact grain requires business_date in natural_key'
        when t.time_grain = 'daily_fact' and not ('as_of' = any (t.natural_key))
          then 'daily_fact grain requires as_of in natural_key, or a restatement overwrites the day it corrects'
        when t.time_grain = 'as_of_grid' and not (t.natural_key && array['as_of', 'snapshot_date']::text[])
          then 'as_of_grid grain requires as_of or snapshot_date in natural_key'
        else null
      end as violation
    ) v
   where v.violation is not null;
$$;

revoke all on function public.staxis_pms_registry_violations() from public, anon, authenticated;
grant execute on function public.staxis_pms_registry_violations() to service_role;

comment on function public.staxis_pms_registry_violations() is
  'Every way pms_table_schemas currently disagrees with the physical schema. Empty = the invariant holds. Polled by /api/admin/doctor as pms_time_model_ok. Created 0343.';

create or replace function public.staxis_pms_registry_matches_reality()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_rel     oid;
  v_relkind "char";
begin
  v_rel := to_regclass('public.' || quote_ident(new.table_name));
  if v_rel is null then
    raise exception 'pms_table_schemas.% names a relation that does not exist', new.table_name
      using errcode = '23514';
  end if;

  select c.relkind into v_relkind from pg_class c where c.oid = v_rel;
  if v_relkind <> 'r' then
    raise exception 'pms_table_schemas.% is not a base table (relkind %) — a writer cannot target it',
      new.table_name, v_relkind using errcode = '23514';
  end if;

  if not exists (
    select 1 from public._staxis_unique_index_columns(v_rel) cols
     where cols @> new.natural_key and cols <@ new.natural_key
  ) then
    raise exception 'pms_table_schemas.%: natural_key % has no matching UNIQUE index — every write would duplicate instead of upserting',
      new.table_name, new.natural_key using errcode = '23514';
  end if;

  if new.time_grain = 'observation' and new.write_strategy <> 'append' then
    raise exception 'pms_table_schemas.%: observation grain requires write_strategy=append, got %',
      new.table_name, new.write_strategy using errcode = '23514';
  end if;

  if new.time_grain = 'daily_fact' then
    if not exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = new.table_name and c.column_name = 'business_date'
    ) then
      raise exception 'pms_table_schemas.%: daily_fact grain requires a business_date column', new.table_name
        using errcode = '23514';
    end if;
    if not ('business_date' = any (new.natural_key)) then
      raise exception 'pms_table_schemas.%: daily_fact grain requires business_date in natural_key', new.table_name
        using errcode = '23514';
    end if;
    if not ('as_of' = any (new.natural_key)) then
      raise exception 'pms_table_schemas.%: daily_fact grain requires as_of in natural_key, or a restatement destroys the day it corrects', new.table_name
        using errcode = '23514';
    end if;
  end if;

  if new.time_grain = 'as_of_grid'
     and not (new.natural_key && array['as_of', 'snapshot_date']::text[]) then
    raise exception 'pms_table_schemas.%: as_of_grid grain requires as_of or snapshot_date in natural_key', new.table_name
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.staxis_pms_registry_matches_reality() is
  'BEFORE INSERT OR UPDATE on pms_table_schemas: the descriptor that drives every PMS write cannot claim a key, a grain or a table the database does not actually have. Created 0343.';

drop trigger if exists registry_matches_reality on public.pms_table_schemas;
create trigger registry_matches_reality
  before insert or update on public.pms_table_schemas
  for each row execute function public.staxis_pms_registry_matches_reality();

-- Prove it holds for every existing row, right now, by running them all
-- through the trigger. If Part H got anything wrong this migration stops here
-- rather than shipping a registry that lies.
update public.pms_table_schemas set updated_at = now();

do $$
declare
  v_bad int;
begin
  select count(*) into v_bad from public.staxis_pms_registry_violations();
  if v_bad > 0 then
    raise exception '0343: % pms_table_schemas row(s) still disagree with the schema after the backfill', v_bad;
  end if;
end $$;

-- ═══ Part J — 0341's lineage list follows the renames ══════════════════════
-- pms_lineage_gaps() drives the doctor off pms_table_schemas, so it already
-- follows. This function is the human-readable list; leaving the dead names in
-- it would send the next reader to two tables that no longer exist.

create or replace function public._pms_lineage_tables()
returns text[]
language sql
immutable
set search_path = pg_catalog, public
as $$
  select array[
    'pms_activity_log',
    'pms_booking_pace',
    'pms_cancellations',
    'pms_channel_performance',
    'pms_feed_values',
    'pms_forecast_daily',
    'pms_groups_and_blocks',
    'pms_guest_balances',
    'pms_guests',
    'pms_housekeeping_assignments',
    'pms_lost_and_found',
    'pms_no_shows',
    'pms_occupancy_observation',
    'pms_payments_daily',
    'pms_rates_and_inventory',
    'pms_reservations',
    'pms_revenue_daily',
    'pms_room_status_log',
    'pms_rooms_inventory',
    'pms_work_orders_v2'
  ]::text[];
$$;

comment on function public._pms_lineage_tables() is
  'The pms_* write targets that must carry a NOT NULL ingest_run_id. 19 descriptor tables (pms_table_schemas) + pms_feed_values. Created 0341; renames followed in 0343.';

-- ─── Bookkeeping + PostgREST schema reload ─────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0343',
  'Time model: business_date_cutoff_hour + staxis_business_date(); pms_table_schemas.time_grain with a registry-matches-reality trigger; pms_in_house_snapshot -> append-only pms_occupancy_observation behind a compat view; pms_future_bookings -> pms_booking_pace (as-of pickup curve); as_of generations + _current views on the daily facts; pms_entity_change_log; append-only enforcement + sanctioned purge.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
