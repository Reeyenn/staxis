-- ═══════════════════════════════════════════════════════════════════════════
-- 0354 — One reservation, one row, for its whole life.
--
-- THE PROBLEM
-- A booking can currently exist three times. pms_reservations, pms_no_shows
-- and pms_cancellations are three separate tables all keyed on the same
-- (property_id, pms_reservation_id), with no reconciliation between them.
-- Nothing stops pms_reservations saying status='booked' while a row in
-- pms_cancellations says the same booking was cancelled last Tuesday. Nothing
-- decides which one the dashboard should believe. The report-email ingest is
-- about to start writing all three from three different reports, which is the
-- moment that latent disagreement becomes a daily one.
--
-- THE FIX
-- Cancellation and no-show are STATES of a reservation, not separate facts
-- about separate objects. Fold them onto the row they describe, and add the
-- reconciliation the three-table shape never had:
--
--   • cancelled_date / cancellation_fee_cents / cancellation_reason and
--     no_show_date become columns on pms_reservations.
--   • CHECK constraints make status and the matching date move together, so
--     "cancelled with no cancellation date" cannot be stored at all.
--   • A BEFORE UPDATE trigger stops a stale report un-cancelling a booking.
--     This is the genuinely new risk consolidation creates: three feeds now
--     upsert the SAME row, and an arrivals report that still lists a
--     since-cancelled guest must not resurrect them.
--
-- pms_future_bookings is NOT resurrected. 0343 already replaced it with
-- pms_booking_pace (aggregate on-the-books curve); individual future stays are
-- just pms_reservations WHERE arrival_date > today. booked_at is added here so
-- pace can eventually be derived from the booking's own creation date rather
-- than from when we first happened to see it — see the caveat below.
--
-- WHY NOW
-- Verified in production on 2026-07-25: pms_reservations 13 rows,
-- pms_no_shows 0 rows, pms_cancellations 0 rows. The backfill below is a
-- formality today and a multi-hour data migration once a real hotel's history
-- is in there. It still ships, in full, because an unmerged branch could land
-- rows before this is applied — and because a backfill that has never been
-- exercised is not a backfill.
--
-- CAVEAT ON booked_at — no PMS report has been read yet, so nobody knows
-- whether the scheduled report even prints a booking-creation date. The column
-- is nullable and first_seen_at is the honest fallback. Do NOT build a pickup
-- or pace feature on booked_at until a real report confirms it exists.
--
-- APPLY ORDER: after 0353. Idempotent; safe to re-run.
-- DESTRUCTIVE: drops pms_no_shows and pms_cancellations. The preflight aborts
-- the whole transaction if either holds a single row.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Preflight — abort unless reality still matches what this was designed
-- against. Everything below is destructive or constraint-adding; a surprise
-- here must stop the migration, not be worked around by it.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare
  n bigint;
begin
  -- 1. The target must exist and still be keyed the way the fold assumes.
  if to_regclass('public.pms_reservations') is null then
    raise exception '0354 preflight: public.pms_reservations does not exist';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.pms_reservations'::regclass
       and contype  = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (property_id, pms_reservation_id)'
  ) then
    raise exception
      '0354 preflight: pms_reservations has no UNIQUE (property_id, pms_reservation_id) — the fold would create duplicate lifecycles';
  end if;

  -- 2. The satellites must be empty. Not "mostly empty" — empty. Folding a
  --    populated satellite needs a conflict policy this migration does not
  --    have, so the correct outcome is a loud stop.
  if to_regclass('public.pms_no_shows') is not null then
    execute 'select count(*) from public.pms_no_shows' into n;
    if n > 0 then
      raise exception
        '0354 preflight: pms_no_shows holds % row(s). Fold them by hand and decide the conflict policy before re-running.', n;
    end if;
  end if;

  if to_regclass('public.pms_cancellations') is not null then
    execute 'select count(*) from public.pms_cancellations' into n;
    if n > 0 then
      raise exception
        '0354 preflight: pms_cancellations holds % row(s). Fold them by hand and decide the conflict policy before re-running.', n;
    end if;
  end if;

  -- 3. Nothing else may still point at the descriptor rows being deleted.
  if to_regclass('public.pms_feed_catalog') is not null then
    execute $q$select count(*) from public.pms_feed_catalog
              where target_table in ('pms_no_shows', 'pms_cancellations')$q$ into n;
    if n > 0 then
      raise exception '0354 preflight: % pms_feed_catalog row(s) still target the satellite tables', n;
    end if;
  end if;

  if to_regclass('public.pms_unmapped_columns') is not null then
    execute $q$select count(*) from public.pms_unmapped_columns
              where target_table in ('pms_no_shows', 'pms_cancellations')$q$ into n;
    if n > 0 then
      raise exception '0354 preflight: % pms_unmapped_columns row(s) still target the satellite tables', n;
    end if;
  end if;

  if to_regclass('public.pms_ingest_quarantine') is not null then
    execute $q$select count(*) from public.pms_ingest_quarantine
              where target_table in ('pms_no_shows', 'pms_cancellations')$q$ into n;
    if n > 0 then
      raise exception '0354 preflight: % pms_ingest_quarantine row(s) still target the satellite tables', n;
    end if;
  end if;

  -- 4. The CHECKs added below must already hold, or VALIDATE fails after the
  --    table has been altered. Check first, fail cheap.
  select count(*) into n from public.pms_reservations
   where arrival_date is not null
     and departure_date is not null
     and departure_date < arrival_date;
  if n > 0 then
    raise exception '0354 preflight: % reservation(s) depart before they arrive — fix the data first', n;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Part A — the lifecycle columns.
-- ─────────────────────────────────────────────────────────────────────────
alter table public.pms_reservations
  add column if not exists booked_at              date,
  add column if not exists first_seen_at          timestamptz not null default now(),
  add column if not exists no_show_date           date,
  add column if not exists cancelled_date         date,
  add column if not exists cancellation_fee_cents bigint,
  add column if not exists cancellation_reason    text;

-- num_nights is what the PMS printed. nights_derived is what the reservation's
-- own dates say. Deliberately NOT a CHECK that the two agree: a PMS that
-- counts day-use stays differently would fail an entire upsert batch, and the
-- writer sends one batch per report. Disagreement is a reporting signal, not a
-- reason to reject the night's data.
alter table public.pms_reservations
  add column if not exists nights_derived integer
    generated always as (departure_date - arrival_date) stored;

comment on column public.pms_reservations.booked_at is
  'Date the booking was created, when the PMS report prints it. NULL is normal. Falls back to first_seen_at for pace. Added 0354.';
comment on column public.pms_reservations.first_seen_at is
  'When Staxis first saw this reservation. The honest floor for booking pace when the PMS does not report booked_at. Added 0354.';
comment on column public.pms_reservations.no_show_date is
  'Set if and only if status = no_show. Folded in from the dropped pms_no_shows. Added 0354.';
comment on column public.pms_reservations.cancelled_date is
  'Set if and only if status = cancelled. Folded in from the dropped pms_cancellations. Added 0354.';
comment on column public.pms_reservations.cancellation_fee_cents is
  'Fee charged on cancellation. Only meaningful on a cancelled reservation. Added 0354.';
comment on column public.pms_reservations.cancellation_reason is
  'Free text reason as printed by the PMS (was pms_cancellations.reason). Added 0354.';
comment on column public.pms_reservations.nights_derived is
  'departure_date - arrival_date. The nights the reservation actually spans, computed rather than trusted. num_nights is what the PMS claimed. Added 0354.';

-- ─────────────────────────────────────────────────────────────────────────
-- Part B — backfill from the satellites, then drop them.
--
-- Zero rows today, so this is a formality — which is exactly why it must be
-- written correctly rather than skipped. If a branch lands rows between now
-- and apply time, the preflight stops the migration instead.
-- ─────────────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.pms_no_shows') is not null then
    execute $q$
      update public.pms_reservations r
         set no_show_date   = coalesce(r.no_show_date, s.no_show_date),
             status         = 'no_show',
             guest_name     = coalesce(r.guest_name, s.guest_name),
             room_number    = coalesce(r.room_number, s.room_number),
             arrival_date   = coalesce(r.arrival_date, s.arrival_date),
             departure_date = coalesce(r.departure_date, s.departure_date),
             channel_name   = coalesce(r.channel_name, s.channel_name)
        from public.pms_no_shows s
       where s.property_id = r.property_id
         and s.pms_reservation_id = r.pms_reservation_id
    $q$;

    -- No-shows for reservations we never saw: create the lifecycle row.
    execute $q$
      insert into public.pms_reservations
        (property_id, pms_reservation_id, guest_name, room_number, arrival_date,
         departure_date, rate_per_night_cents, total_amount_cents, channel_name,
         status, no_show_date, raw, ingest_run_id)
      select s.property_id, s.pms_reservation_id, s.guest_name, s.room_number,
             s.arrival_date, s.departure_date, s.rate_per_night_cents,
             s.total_amount_cents, s.channel_name, 'no_show', s.no_show_date,
             s.raw, s.ingest_run_id
        from public.pms_no_shows s
       where not exists (
         select 1 from public.pms_reservations r
          where r.property_id = s.property_id
            and r.pms_reservation_id = s.pms_reservation_id
       )
      on conflict (property_id, pms_reservation_id) do nothing
    $q$;
  end if;

  if to_regclass('public.pms_cancellations') is not null then
    execute $q$
      update public.pms_reservations r
         set cancelled_date         = coalesce(r.cancelled_date, c.cancelled_date),
             cancellation_fee_cents = coalesce(r.cancellation_fee_cents, c.cancellation_fee_cents),
             cancellation_reason    = coalesce(r.cancellation_reason, c.reason),
             status                 = 'cancelled',
             guest_name             = coalesce(r.guest_name, c.guest_name),
             room_number            = coalesce(r.room_number, c.room_number),
             arrival_date           = coalesce(r.arrival_date, c.arrival_date),
             departure_date         = coalesce(r.departure_date, c.departure_date),
             channel_name           = coalesce(r.channel_name, c.channel_name)
        from public.pms_cancellations c
       where c.property_id = r.property_id
         and c.pms_reservation_id = r.pms_reservation_id
    $q$;

    execute $q$
      insert into public.pms_reservations
        (property_id, pms_reservation_id, guest_name, room_number, arrival_date,
         departure_date, total_amount_cents, channel_name, status,
         cancelled_date, cancellation_fee_cents, cancellation_reason, raw, ingest_run_id)
      select c.property_id, c.pms_reservation_id, c.guest_name, c.room_number,
             c.arrival_date, c.departure_date, c.total_amount_cents, c.channel_name,
             'cancelled', c.cancelled_date, c.cancellation_fee_cents, c.reason,
             c.raw, c.ingest_run_id
        from public.pms_cancellations c
       where not exists (
         select 1 from public.pms_reservations r
          where r.property_id = c.property_id
            and r.pms_reservation_id = c.pms_reservation_id
       )
      on conflict (property_id, pms_reservation_id) do nothing
    $q$;
  end if;
end $$;

-- The descriptor rows must go before the tables, or the FKs from
-- pms_feed_catalog / pms_unmapped_columns / pms_ingest_quarantine block the
-- drop. Preflight already proved nothing points at them.
delete from public.pms_table_schemas
 where table_name in ('pms_no_shows', 'pms_cancellations');

drop table if exists public.pms_no_shows;
drop table if exists public.pms_cancellations;

-- The lineage registry from 0341 still names all three folded tables. It is
-- only read at migration time, but a list that names dropped tables is a lie
-- the next migration would trip over.
create or replace function public._pms_lineage_tables()
returns text[]
language sql
immutable
set search_path = pg_catalog, public
as $$
  select array[
    'pms_activity_log',
    'pms_channel_performance',
    'pms_feed_values',
    'pms_forecast_daily',
    'pms_groups_and_blocks',
    'pms_guest_balances',
    'pms_guests',
    'pms_housekeeping_assignments',
    'pms_in_house_snapshot',
    'pms_lost_and_found',
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
  'The pms_* write targets that must carry a NOT NULL ingest_run_id. Created 0341; pms_future_bookings / pms_no_shows / pms_cancellations removed 0354 when they were folded into pms_reservations.';

-- ─────────────────────────────────────────────────────────────────────────
-- Part C — the lifecycle can no longer contradict itself.
--
-- NOT VALID then VALIDATE so the table is not exclusively locked while every
-- existing row is re-checked. Verified: zero live rows violate any of these.
-- ─────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pms_res_cancel_coherent') then
    alter table public.pms_reservations
      add constraint pms_res_cancel_coherent
      check ((status = 'cancelled') = (cancelled_date is not null)) not valid;
    alter table public.pms_reservations validate constraint pms_res_cancel_coherent;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_res_noshow_coherent') then
    alter table public.pms_reservations
      add constraint pms_res_noshow_coherent
      check ((status = 'no_show') = (no_show_date is not null)) not valid;
    alter table public.pms_reservations validate constraint pms_res_noshow_coherent;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_res_fee_requires_cancel') then
    alter table public.pms_reservations
      add constraint pms_res_fee_requires_cancel
      check (cancellation_fee_cents is null or status = 'cancelled') not valid;
    alter table public.pms_reservations validate constraint pms_res_fee_requires_cancel;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_res_date_order') then
    alter table public.pms_reservations
      add constraint pms_res_date_order
      check (arrival_date is null or departure_date is null or departure_date >= arrival_date) not valid;
    alter table public.pms_reservations validate constraint pms_res_date_order;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_res_booked_before_arrival') then
    alter table public.pms_reservations
      add constraint pms_res_booked_before_arrival
      check (booked_at is null or arrival_date is null or booked_at <= arrival_date) not valid;
    alter table public.pms_reservations validate constraint pms_res_booked_before_arrival;
  end if;
end $$;

-- NOTE on `(status = 'x') = (date is not null)`: status is nullable, so for a
-- NULL status the left side is NULL and the whole expression is NULL, which a
-- CHECK accepts. That is deliberate — "the PMS did not print a status" must
-- stay storable. What the constraint forbids is the contradiction: a status of
-- 'cancelled' without a date, or a cancellation date on a live booking.

-- ─────────────────────────────────────────────────────────────────────────
-- Part D — a reservation never comes back from the dead.
--
-- Three report feeds now upsert one row. An arrivals report generated at 11am
-- and delivered at 2pm still lists the guest who cancelled at noon. Without
-- this trigger, that late arrival report silently un-cancels the booking and
-- the hotel prepares a room for someone who is not coming.
--
-- 0341's pms_reject_stale_ingest already blocks an older report of the SAME
-- kind from overwriting a newer one. It does not help here, because the
-- arrivals report and the cancellations report are different kinds and are
-- never compared. This trigger is the cross-kind rule, and it is narrow: it
-- protects the status field only, and lets a genuinely newer status change
-- (strictly later status_changed_at) through.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.staxis_pms_reservation_status_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.status is null or new.status is null then
    return new;
  end if;

  if old.status not in ('cancelled', 'no_show', 'checked_out') then
    return new;
  end if;

  if new.status not in ('booked', 'checked_in') then
    return new;
  end if;

  -- A strictly newer status change is real news: the guest rebooked, or the
  -- front desk reversed a mistaken cancellation. Let it through.
  if new.status_changed_at is not null
     and old.status_changed_at is not null
     and new.status_changed_at > old.status_changed_at then
    return new;
  end if;

  -- Otherwise this is a stale feed re-listing a finished reservation. Keep the
  -- terminal state and its evidence; let every other column update normally,
  -- because the newer report may still carry a corrected guest name or rate.
  new.status                 := old.status;
  new.status_changed_at      := old.status_changed_at;
  new.cancelled_date         := old.cancelled_date;
  new.no_show_date           := old.no_show_date;
  new.cancellation_fee_cents := old.cancellation_fee_cents;
  new.cancellation_reason    := old.cancellation_reason;
  return new;
end;
$$;

comment on function public.staxis_pms_reservation_status_guard() is
  'BEFORE UPDATE on pms_reservations: a reservation never moves from cancelled / no_show / checked_out back to booked / checked_in unless the incoming row carries a strictly later status_changed_at. The reconciliation the three-table shape never had. Created 0354.';

drop trigger if exists reservation_status_guard on public.pms_reservations;
create trigger reservation_status_guard
  before update on public.pms_reservations
  for each row execute function public.staxis_pms_reservation_status_guard();

-- ─────────────────────────────────────────────────────────────────────────
-- Part E — teach the writer registry about the folded columns.
--
-- The descriptor drives every PMS write: a column the descriptor does not
-- declare is a column the cancellations report cannot land. 0343's
-- registry_matches_reality trigger re-validates the row on update, so this
-- also proves the descriptor still matches the physical table.
-- ─────────────────────────────────────────────────────────────────────────
update public.pms_table_schemas
   set columns = columns
       || jsonb_build_array(
            jsonb_build_object('name', 'cancelled_date',         'type', 'date',    'nullable', true, 'required', false),
            jsonb_build_object('name', 'cancellation_fee_cents', 'type', 'bigint',  'nullable', true, 'required', false, 'range_min', 0),
            jsonb_build_object('name', 'cancellation_reason',    'type', 'text',    'nullable', true, 'required', false),
            jsonb_build_object('name', 'no_show_date',           'type', 'date',    'nullable', true, 'required', false),
            jsonb_build_object('name', 'booked_at',              'type', 'date',    'nullable', true, 'required', false)
          ),
       notes = 'One row per reservation for its whole life. Cancellations and no-shows are states on this row, not separate tables (0354). Shared by the arrivals, departures, cancellations and no-show reports.',
       updated_at = now()
 where table_name = 'pms_reservations'
   and not (columns @> '[{"name": "cancelled_date"}]'::jsonb);

-- ─────────────────────────────────────────────────────────────────────────
-- Part F — indexes for the reads this reshape creates, and only those.
-- get_recent_cancellations and get_recent_no_shows both filter
-- (property_id, status) and range-scan the matching date.
-- ─────────────────────────────────────────────────────────────────────────
-- @query: src/lib/agent/tools/pms-feeds.ts get_recent_cancellations
create index if not exists pms_reservations_cancelled_idx
  on public.pms_reservations (property_id, cancelled_date desc)
  where cancelled_date is not null;

-- @query: src/lib/agent/tools/pms-feeds.ts get_recent_no_shows
create index if not exists pms_reservations_no_show_idx
  on public.pms_reservations (property_id, no_show_date desc)
  where no_show_date is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- Postflight — prove the end state, or roll the whole thing back.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  if to_regclass('public.pms_no_shows') is not null
     or to_regclass('public.pms_cancellations') is not null then
    raise exception '0354 postflight: a satellite table survived the drop';
  end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'pms_reservations'
     and column_name in ('booked_at', 'first_seen_at', 'no_show_date', 'cancelled_date',
                         'cancellation_fee_cents', 'cancellation_reason', 'nights_derived');
  if n <> 7 then
    raise exception '0354 postflight: expected 7 lifecycle columns on pms_reservations, found %', n;
  end if;

  select count(*) into n from pg_constraint
   where conrelid = 'public.pms_reservations'::regclass
     and conname in ('pms_res_cancel_coherent', 'pms_res_noshow_coherent',
                     'pms_res_fee_requires_cancel', 'pms_res_date_order',
                     'pms_res_booked_before_arrival')
     and convalidated;
  if n <> 5 then
    raise exception '0354 postflight: expected 5 validated lifecycle CHECKs, found %', n;
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.pms_reservations'::regclass
       and tgname = 'reservation_status_guard'
  ) then
    raise exception '0354 postflight: reservation_status_guard trigger is missing';
  end if;

  -- The registry must not still name a table that no longer exists.
  if exists (select 1 from public.staxis_pms_registry_violations()) then
    raise exception '0354 postflight: pms_table_schemas disagrees with the physical schema';
  end if;
end $$;

insert into public.applied_migrations (version, description)
values (
  '0354',
  'One reservation, one row: pms_no_shows + pms_cancellations folded onto pms_reservations as no_show_date / cancelled_date / cancellation_fee_cents / cancellation_reason, plus booked_at, first_seen_at and a generated nights_derived. Five coherence CHECKs and a BEFORE UPDATE terminal-state guard so a stale report cannot un-cancel a booking. Both satellite tables dropped behind an abort-on-rows preflight.'
)
on conflict (version) do nothing;

commit;

-- PostgREST caches the schema; reload it so the dropped relations disappear
-- and the new columns become selectable.
notify pgrst, 'reload schema';
