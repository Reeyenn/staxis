-- ═══════════════════════════════════════════════════════════════════════════
-- 0344 — daily_logs becomes the hotel's daily closing photo.
--
-- daily_logs already IS the one-row-per-(property, business day) table. It is
-- read by src/lib/db/daily-logs.ts, db-mappers.ts, inventory-predictions.ts,
-- the inventory AI report, seal-daily and ml-service/src/training/_exposure.py.
-- It is NOT renamed and `date` is NOT renamed — _exposure.py depends on both,
-- and a rename buys nothing. Instead `date` is documented to BE the business
-- date, and the missing operational buckets are added around it.
--
-- THE RULE THAT MAKES THIS SAFE — every bucket is paired with a *_source
-- column, and a CHECK says the bucket must be entirely NULL when its source
-- is. A missing feed therefore reads as blank, and can never seal as a zero
-- nobody measured. That is the fabricated-zero-occupancy incident (which the
-- seal-daily comments describe twice) closed at the database instead of in a
-- code comment.
--
-- ADR / RevPAR / occupancy % / day-of-week are GENERATED ALWAYS ... STORED.
-- Postgres computes them and refuses any client that tries to write them
-- (errcode 428C9), so the derived number can never disagree with the counts
-- it claims to derive from.
--
-- TWO OCCUPANCY COLUMNS, ON PURPOSE — read this before using either:
--   occupied    (pre-existing, 87 live rows) = the LEGACY DERIVED count that
--                seal-daily computes from today_property_counts_v1. ml-service
--                _exposure.py and preserveSealedOccupancy() read it. Unchanged.
--   rooms_sold  (new)                        = what the PMS REPORT PRINTED.
--                NULL until report ingestion lands.
--   They will differ, and that difference is information (robot-derived vs
--   report-stated). Anything comparing the two must say which it is showing.
--   Same split for labor: labor_cost / actual_staff / hourly_wage are the
--   existing schedule-derived figures; labor_hours and
--   labor_cost_per_occupied_room_cents are the new report/derived bucket.
--
-- HONEST INVENTORY of what can actually arrive today:
--   HAS A SOURCE NOW — arrivals/departures/extended_stays (pms_reservations),
--     housekeeping minutes (cleaning_events), labor (attendance_marks +
--     labor_wage_settings), work orders (work_orders), inventory consumed/spend
--     (inventory_counts/orders/discards), complaints_count, day_of_week.
--   NO SOURCE YET, stays NULL — every revenue field, ADR/RevPAR,
--     rooms_available/sold/ooo, walk_ins/no_shows/cancellations, channel_mix,
--     inspections (table exists, 0 rows), reviews (NO table exists anywhere).
--   The five typed weather/holiday/local-event columns the first draft
--     specified are NOT here: no provider exists, and columns that cannot
--     receive data are how a schema starts lying. One nullable `context` jsonb
--     holds them if and when a provider is chosen.
--
-- Existing 87 rows get NULL for every new column INCLUDING the sources. That
-- is deliberate: they were sealed before source labels existed, and inventing
-- provenance for them would be the exact dishonesty this migration prevents.
--
-- APPLY ORDER: after 0343. Idempotent; safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

comment on column public.daily_logs.date is
  'THE BUSINESS DATE. By definition — this row is one hotel-day, closed at that hotel''s night-audit hour (properties.business_date_cutoff_hour). Named `date` and not business_date because it is also the app''s local operational day, matching cleaning_events.date and attendance_marks; ml-service _exposure.py reads it. Documented 0344.';

-- ─── Occupancy ─────────────────────────────────────────────────────────────
alter table public.daily_logs
  add column if not exists rooms_available   integer,
  add column if not exists rooms_sold        integer,
  add column if not exists rooms_ooo         integer,
  add column if not exists occupancy_source  text;

-- ─── Revenue (integer cents throughout) ────────────────────────────────────
alter table public.daily_logs
  add column if not exists rooms_revenue_cents bigint,
  add column if not exists fnb_revenue_cents   bigint,
  add column if not exists other_revenue_cents bigint,
  add column if not exists total_revenue_cents bigint,
  add column if not exists taxes_cents         bigint,
  add column if not exists refunds_cents       bigint,
  add column if not exists comps_cents         bigint,
  add column if not exists discounts_cents     bigint,
  add column if not exists revenue_source      text;

-- ─── Guest flow ────────────────────────────────────────────────────────────
alter table public.daily_logs
  add column if not exists arrivals       integer,
  add column if not exists departures     integer,
  add column if not exists walk_ins       integer,
  add column if not exists no_shows       integer,
  add column if not exists cancellations  integer,
  add column if not exists extended_stays integer,
  add column if not exists flow_source    text;

-- ─── Channel mix ───────────────────────────────────────────────────────────
alter table public.daily_logs
  add column if not exists channel_mix    jsonb,
  add column if not exists channel_source text;

-- ─── Housekeeping ──────────────────────────────────────────────────────────
alter table public.daily_logs
  add column if not exists minutes_per_occupied_room numeric,
  add column if not exists inspections_count         integer,
  add column if not exists inspections_passed        integer,
  add column if not exists hk_source                 text;

-- ─── Labor ─────────────────────────────────────────────────────────────────
alter table public.daily_logs
  add column if not exists labor_hours                          numeric,
  add column if not exists labor_cost_per_occupied_room_cents   bigint,
  add column if not exists labor_source                         text;

-- ─── Maintenance / inventory / guest experience ────────────────────────────
-- No paired source column: every one of these already has a first-party Staxis
-- table behind it (work_orders, inventory_*, complaints), so "who said this"
-- is not in question the way it is for a PMS-report figure. reviews_* is the
-- exception and is documented below.
alter table public.daily_logs
  add column if not exists work_orders_opened       integer,
  add column if not exists work_orders_closed       integer,
  add column if not exists work_orders_open_at_eod  integer,
  add column if not exists inventory_units_consumed integer,
  add column if not exists inventory_consumed_cents bigint,
  add column if not exists inventory_spend_cents    bigint,
  add column if not exists complaints_count         integer,
  add column if not exists reviews_count            integer,
  add column if not exists review_avg_score         numeric;

-- ─── Context + provenance ──────────────────────────────────────────────────
alter table public.daily_logs
  add column if not exists context             jsonb,
  add column if not exists sealed_at           timestamptz,
  add column if not exists seal_version        smallint not null default 1,
  add column if not exists source_completeness jsonb;

-- ─── Derived, and unwritable by any client ─────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'daily_logs' and column_name = 'occupancy_pct'
  ) then
    alter table public.daily_logs
      add column occupancy_pct numeric(5,2)
      generated always as (
        case when rooms_available > 0
             then round(rooms_sold::numeric * 100 / rooms_available, 2)
        end
      ) stored;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'daily_logs' and column_name = 'adr_cents'
  ) then
    alter table public.daily_logs
      add column adr_cents bigint
      generated always as (
        case when rooms_sold > 0 then rooms_revenue_cents / rooms_sold end
      ) stored;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'daily_logs' and column_name = 'revpar_cents'
  ) then
    alter table public.daily_logs
      add column revpar_cents bigint
      generated always as (
        case when rooms_available > 0 then rooms_revenue_cents / rooms_available end
      ) stored;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'daily_logs' and column_name = 'day_of_week'
  ) then
    alter table public.daily_logs
      add column day_of_week smallint
      generated always as (extract(dow from "date")::smallint) stored;
  end if;
end $$;

-- ─── The rule: a bucket is NULL or it carries a stated source ──────────────
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('occupancy_source', 'rooms_available is null and rooms_sold is null and rooms_ooo is null'),
      ('revenue_source',   'rooms_revenue_cents is null and fnb_revenue_cents is null and other_revenue_cents is null and total_revenue_cents is null and taxes_cents is null and refunds_cents is null and comps_cents is null and discounts_cents is null'),
      ('flow_source',      'arrivals is null and departures is null and walk_ins is null and no_shows is null and cancellations is null and extended_stays is null'),
      ('channel_source',   'channel_mix is null'),
      ('hk_source',        'minutes_per_occupied_room is null and inspections_count is null and inspections_passed is null'),
      ('labor_source',     'labor_hours is null and labor_cost_per_occupied_room_cents is null')
    ) as t(src, all_null)
  loop
    if not exists (select 1 from pg_constraint where conname = 'daily_logs_' || spec.src || '_domain') then
      execute format(
        'alter table public.daily_logs add constraint %I check (%I is null or %I in (%L, %L, %L))',
        'daily_logs_' || spec.src || '_domain', spec.src, spec.src, 'pms_report', 'operator', 'derived'
      );
    end if;
    -- The load-bearing half: values without a source cannot exist. A feed that
    -- went missing seals blank, not zero.
    if not exists (select 1 from pg_constraint where conname = 'daily_logs_' || spec.src || '_required') then
      execute format(
        'alter table public.daily_logs add constraint %I check (%I is not null or (%s))',
        'daily_logs_' || spec.src || '_required', spec.src, spec.all_null
      );
    end if;
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'daily_logs_seal_version_check') then
    alter table public.daily_logs
      add constraint daily_logs_seal_version_check check (seal_version >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'daily_logs_rooms_nonneg_check') then
    alter table public.daily_logs
      add constraint daily_logs_rooms_nonneg_check check (
        (rooms_available is null or rooms_available >= 0)
        and (rooms_sold is null or rooms_sold >= 0)
        and (rooms_ooo is null or rooms_ooo >= 0)
      );
  end if;
end $$;

-- ─── Comments: what each column means and where it can come from ───────────
comment on column public.daily_logs.rooms_sold is
  'Rooms sold as the PMS REPORT PRINTED IT. Not the same number as `occupied`, which is the legacy robot-derived count — see the migration header. NULL until report ingestion lands.';
comment on column public.daily_logs.occupied is
  'LEGACY derived occupancy: seal-daily computes it from today_property_counts_v1. Kept as-is (ml-service _exposure.py + preserveSealedOccupancy read it). The report-stated figure is rooms_sold.';
comment on column public.daily_logs.occupancy_pct is
  'GENERATED from rooms_sold / rooms_available. Postgres computes it; a client that tries to write it gets 428C9, so it can never disagree with the counts.';
comment on column public.daily_logs.adr_cents is
  'GENERATED: rooms_revenue_cents / rooms_sold, integer cents. Unwritable by any client.';
comment on column public.daily_logs.revpar_cents is
  'GENERATED: rooms_revenue_cents / rooms_available, integer cents. Unwritable by any client.';
comment on column public.daily_logs.day_of_week is
  'GENERATED from date (0=Sunday). The one context field that needs no provider.';
comment on column public.daily_logs.labor_hours is
  'Hours actually worked, from attendance_marks. Distinct from actual_staff (headcount) and labor_cost (the existing schedule-derived dollar figure).';
comment on column public.daily_logs.reviews_count is
  'Guest reviews for the day. NO SOURCE EXISTS ANYWHERE in the product today — no table, no API, no provider. Permanently NULL until a reputation source is chosen. Documented rather than quietly implied.';
comment on column public.daily_logs.review_avg_score is
  'See reviews_count: no source exists. Permanently NULL for now.';
comment on column public.daily_logs.context is
  'Free-form day context (weather, holiday, local event). One nullable jsonb instead of five typed columns, because no provider is wired for any of it and typed columns that cannot receive data are a schema that lies.';
comment on column public.daily_logs.source_completeness is
  'Per-bucket record of what the seal actually had: which feeds were live, which were skipped, and why. The receipt for the row as a whole.';
comment on column public.daily_logs.sealed_at is
  'When seal-daily last wrote this row. NULL on the 87 rows sealed before 0344.';
comment on column public.daily_logs.seal_version is
  'Which generation of the seal logic produced this row. Bump when the seal changes meaning, so old rows are not silently compared against new ones.';

-- ─── Bookkeeping + PostgREST schema reload ─────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0344',
  'daily_logs becomes the daily closing photo: occupancy / revenue / flow / channel / housekeeping / labor / maintenance / inventory / guest-experience buckets, each paired with a *_source column and a CHECK that a sourceless bucket must be entirely NULL; ADR, RevPAR, occupancy % and day-of-week as GENERATED ALWAYS STORED; sealed_at / seal_version / source_completeness provenance.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
