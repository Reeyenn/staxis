-- ═══════════════════════════════════════════════════════════════════════════
-- 0345 — One reservation, one row, for its whole life
-- ═══════════════════════════════════════════════════════════════════════════
-- 0276 created three satellite tables that each hold a *state* of a booking
-- rather than a different *fact* about it:
--   pms_future_bookings  — a reservation whose arrival_date is in the future
--   pms_no_shows         — a reservation that ended in status 'no_show'
--   pms_cancellations    — a reservation that ended in status 'cancelled'
--
-- All three are keyed (property_id, pms_reservation_id) — the SAME natural key
-- pms_reservations already carries — so the same booking can exist in two
-- tables at once and the two copies can silently disagree. "Future bookings"
-- is not a separate fact at all: it is `pms_reservations where arrival_date >
-- today`. Booking pace comes from a booking-creation date, which is why
-- booked_at is added here instead of a pace table.
--
-- This migration folds all three into pms_reservations and drops them.
-- Verified live before writing: pms_reservations 13 rows; the three satellites
-- 0 rows each. The backfill is therefore a formality today — but it must still
-- ship, because an unmerged branch could land rows in them before this is
-- applied, and a migration that silently discards data is worse than one that
-- is redundant.
--
-- DELIBERATELY NOT FOLDED: pms_guest_balances (per-folio grain) and
-- pms_payments_daily (property-day grain) are genuinely different grains and
-- stay exactly as 0276 created them.
--
-- The one new risk this creates: three report feeds now upsert the SAME row.
-- An arrivals report that re-lists a cancelled booking must not un-cancel it.
-- That reconciliation never existed in the four-table design; it is added
-- below as staxis_pms_reservation_status_guard().
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── 1. Lifecycle columns on pms_reservations ────────────────────────────────

alter table public.pms_reservations
  add column if not exists booked_at              date,
  add column if not exists first_seen_at          timestamptz not null default now(),
  add column if not exists no_show_date           date,
  add column if not exists cancelled_date         date,
  add column if not exists cancellation_fee_cents bigint,
  add column if not exists cancellation_reason    text;

comment on column public.pms_reservations.booked_at is
  'Date the booking was created in the PMS, when the report prints one. Booking pace = count by booked_at. Falls back to first_seen_at when the PMS report has no creation-date column. Added 0345.';
comment on column public.pms_reservations.first_seen_at is
  'When Staxis first ingested this reservation. The floor for booking-pace analysis when booked_at is absent — only meaningful from the day ingest goes live. Added 0345.';
comment on column public.pms_reservations.no_show_date is
  'Set if and only if status = ''no_show'' (CHECK pms_res_noshow_coherent). Folded in from pms_no_shows. Added 0345.';
comment on column public.pms_reservations.cancelled_date is
  'Set if and only if status = ''cancelled'' (CHECK pms_res_cancel_coherent). Folded in from pms_cancellations. Added 0345.';
comment on column public.pms_reservations.cancellation_fee_cents is
  'Integer cents. Only allowed on a cancelled reservation (CHECK pms_res_fee_requires_cancel). Folded in from pms_cancellations. Added 0345.';
comment on column public.pms_reservations.cancellation_reason is
  'Free text as printed by the PMS. Folded in from pms_cancellations.reason (renamed for clarity on the merged row). Added 0345.';

-- nights_derived: the nights this reservation actually spans, computed from
-- its own dates. Deliberately NOT a CHECK against the PMS-reported num_nights:
-- a PMS that counts day-use stays differently would fail the CHECK and — since
-- the writer sends one .upsert() per batch — lose the WHOLE batch. The
-- disagreement is surfaced as a doctor warning instead of an insert failure.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'pms_reservations'
      and column_name = 'nights_derived'
  ) then
    alter table public.pms_reservations
      add column nights_derived integer
        generated always as (departure_date - arrival_date) stored;
  end if;
end $$;

comment on column public.pms_reservations.nights_derived is
  'GENERATED from (departure_date - arrival_date). The nights a reservation actually spans; num_nights is what the PMS claimed. Never treat num_nights as truth. Added 0345.';

-- ─── 2. Backfill from the three satellites, then drop them ───────────────────
-- Verified 0 rows in all three at authoring time. Written to be correct if
-- that is no longer true when this is applied.
--
-- Order matters: reservations that exist ONLY in a satellite must be INSERTed
-- before the UPDATEs, or their lifecycle data is dropped on the floor.

do $$
declare
  v_future    bigint := 0;
  v_noshow    bigint := 0;
  v_cancel    bigint := 0;
  v_inserted  bigint := 0;
  v_merged    bigint := 0;
begin
  select count(*) into v_future from public.pms_future_bookings;
  select count(*) into v_noshow from public.pms_no_shows;
  select count(*) into v_cancel from public.pms_cancellations;
  raise notice '0345 backfill: pms_future_bookings=% pms_no_shows=% pms_cancellations=%',
    v_future, v_noshow, v_cancel;

  -- 2a. Reservations that exist only in a satellite → insert the skeleton.
  with candidates as (
    select property_id, pms_reservation_id, guest_name, room_number, room_type,
           arrival_date, departure_date, num_nights, rate_per_night_cents,
           total_amount_cents, channel_name, status, captured_at
      from public.pms_future_bookings
    union all
    select property_id, pms_reservation_id, guest_name, room_number, null::text,
           arrival_date, departure_date, null::integer, rate_per_night_cents,
           total_amount_cents, channel_name, 'no_show'::text, captured_at
      from public.pms_no_shows
    union all
    select property_id, pms_reservation_id, guest_name, room_number, null::text,
           arrival_date, departure_date, null::integer, null::bigint,
           total_amount_cents, channel_name, 'cancelled'::text, captured_at
      from public.pms_cancellations
  ),
  -- One row per natural key; a cancelled/no_show sighting outranks a plain
  -- future-booking sighting for the skeleton's status.
  deduped as (
    select distinct on (property_id, pms_reservation_id)
           property_id, pms_reservation_id, guest_name, room_number, room_type,
           arrival_date, departure_date, num_nights, rate_per_night_cents,
           total_amount_cents, channel_name, status, captured_at
      from candidates
     order by property_id, pms_reservation_id,
              (case status when 'cancelled' then 0 when 'no_show' then 1 else 2 end),
              captured_at desc
  )
  insert into public.pms_reservations (
    property_id, pms_reservation_id, guest_name, room_number, room_type,
    arrival_date, departure_date, num_nights, rate_per_night_cents,
    total_amount_cents, channel_name, status, first_seen_at
  )
  select d.property_id, d.pms_reservation_id, d.guest_name, d.room_number, d.room_type,
         d.arrival_date, d.departure_date, d.num_nights, d.rate_per_night_cents,
         d.total_amount_cents, d.channel_name, d.status, coalesce(d.captured_at, now())
    from deduped d
   where not exists (
     select 1 from public.pms_reservations r
      where r.property_id = d.property_id
        and r.pms_reservation_id = d.pms_reservation_id
   );
  get diagnostics v_inserted = row_count;

  -- 2b. No-show lifecycle onto the (now guaranteed to exist) reservation row.
  update public.pms_reservations r
     set status            = 'no_show',
         no_show_date      = coalesce(n.no_show_date, n.arrival_date),
         status_changed_at = coalesce(r.status_changed_at, n.captured_at, now()),
         first_seen_at     = least(r.first_seen_at, coalesce(n.captured_at, r.first_seen_at))
    from public.pms_no_shows n
   where r.property_id = n.property_id
     and r.pms_reservation_id = n.pms_reservation_id;
  get diagnostics v_merged = row_count;
  raise notice '0345 backfill: inserted % skeleton reservations, merged % no-shows', v_inserted, v_merged;

  -- 2c. Cancellation lifecycle. Applied after no-shows so a booking recorded
  -- as both lands on 'cancelled' (an explicit cancellation outranks a
  -- no-show — the guest told us, the clock did not).
  update public.pms_reservations r
     set status                 = 'cancelled',
         cancelled_date         = c.cancelled_date,
         cancellation_fee_cents = c.cancellation_fee_cents,
         cancellation_reason    = c.reason,
         no_show_date           = null,
         status_changed_at      = coalesce(r.status_changed_at, c.captured_at, now()),
         first_seen_at          = least(r.first_seen_at, coalesce(c.captured_at, r.first_seen_at))
    from public.pms_cancellations c
   where r.property_id = c.property_id
     and r.pms_reservation_id = c.pms_reservation_id;
  get diagnostics v_merged = row_count;
  raise notice '0345 backfill: merged % cancellations', v_merged;
end $$;

drop table if exists public.pms_future_bookings;
drop table if exists public.pms_no_shows;
drop table if exists public.pms_cancellations;

delete from public.pms_table_schemas
 where table_name in ('pms_future_bookings', 'pms_no_shows', 'pms_cancellations');

-- ─── 3. Make the lifecycle self-consistent in the database ───────────────────
-- Each added NOT VALID then VALIDATEd separately, so if live data ever does
-- violate one, the failure names the exact constraint instead of aborting an
-- opaque ALTER. Verified: 0 live rows violate any of these today.
--
-- `is not distinct from` (not `=`) so a NULL status is treated as "not
-- cancelled" rather than making the whole comparison NULL — a plain `=`
-- silently passes the CHECK for every row whose status is NULL, which is the
-- exact case a half-parsed report produces.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pms_res_cancel_coherent') then
    alter table public.pms_reservations
      add constraint pms_res_cancel_coherent
      check ((status is not distinct from 'cancelled') = (cancelled_date is not null)) not valid;
    alter table public.pms_reservations validate constraint pms_res_cancel_coherent;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_res_noshow_coherent') then
    alter table public.pms_reservations
      add constraint pms_res_noshow_coherent
      check ((status is not distinct from 'no_show') = (no_show_date is not null)) not valid;
    alter table public.pms_reservations validate constraint pms_res_noshow_coherent;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'pms_res_fee_requires_cancel') then
    alter table public.pms_reservations
      add constraint pms_res_fee_requires_cancel
      check (cancellation_fee_cents is null or status is not distinct from 'cancelled') not valid;
    alter table public.pms_reservations validate constraint pms_res_fee_requires_cancel;
  end if;

  -- Does not exist today at all: pms_reservations has eight CHECKs and none of
  -- them orders the dates, so a report that swapped two columns would land a
  -- reservation that departs before it arrives.
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

-- ─── 4. Terminal-state guard ─────────────────────────────────────────────────
-- THE reconciliation the four-table design never needed and the consolidation
-- now requires. Three feeds upsert the same row; an arrivals report listing
-- yesterday's booking must not resurrect a cancellation.
--
-- Rule: a reservation never moves backwards out of a terminal state
-- (cancelled / no_show / checked_out) into booked / checked_in unless the
-- incoming row carries a STRICTLY LATER status_changed_at. When it is
-- reverted, the terminal-state date columns are restored too — otherwise the
-- reverted status and the incoming NULL cancelled_date would violate
-- pms_res_cancel_coherent and kill the entire batch.
--
-- Everything except status stays last-write-wins. That is a deliberate,
-- documented limit: a stale report can still overwrite a fresher guest_name.

create or replace function public.staxis_pms_reservation_status_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
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
  -- A genuinely newer report wins: the PMS really did reinstate the booking.
  if new.status_changed_at is not null
     and old.status_changed_at is not null
     and new.status_changed_at > old.status_changed_at then
    return new;
  end if;

  -- Otherwise this is a stale/full-scope report re-listing a terminal row.
  -- Restore the terminal state AND its coherent date columns.
  new.status                 := old.status;
  new.status_changed_at      := old.status_changed_at;
  new.cancelled_date         := old.cancelled_date;
  new.no_show_date           := old.no_show_date;
  new.cancellation_fee_cents := old.cancellation_fee_cents;
  new.cancellation_reason    := old.cancellation_reason;
  return new;
end $$;

comment on function public.staxis_pms_reservation_status_guard() is
  'BEFORE UPDATE on pms_reservations. Blocks a terminal status (cancelled/no_show/checked_out) from being reverted to booked/checked_in by a stale full-scope report. Restores the terminal date columns with it so the coherence CHECKs cannot fire mid-batch. Added 0345.';

drop trigger if exists pms_reservations_status_guard on public.pms_reservations;
create trigger pms_reservations_status_guard
  before update on public.pms_reservations
  for each row
  execute function public.staxis_pms_reservation_status_guard();

-- ─── 5. Extend the writer descriptor ─────────────────────────────────────────
-- The generic writer validates every incoming row against
-- pms_table_schemas.columns. The three folded feeds now target
-- pms_reservations, so the columns they contribute have to be declared or
-- validateRows drops them.

update public.pms_table_schemas
   set columns = columns
     || jsonb_build_array(
          jsonb_build_object('name', 'booked_at',              'type', 'date',    'required', false, 'nullable', true),
          jsonb_build_object('name', 'no_show_date',           'type', 'date',    'required', false, 'nullable', true),
          jsonb_build_object('name', 'cancelled_date',         'type', 'date',    'required', false, 'nullable', true),
          jsonb_build_object('name', 'cancellation_fee_cents', 'type', 'bigint',  'required', false, 'nullable', true),
          jsonb_build_object('name', 'cancellation_reason',    'type', 'text',    'required', false, 'nullable', true)
        ),
       notes = coalesce(notes, '')
         || ' 0345: absorbed pms_future_bookings / pms_no_shows / pms_cancellations. One row per reservation for its whole life.'
 where table_name = 'pms_reservations'
   and not (columns @> jsonb_build_array(jsonb_build_object('name', 'cancelled_date')));

-- ─── 6. Indexes ──────────────────────────────────────────────────────────────
-- @query: src/lib/agent/tools/pms-feeds.ts get_recent_cancellations — status='cancelled' and cancelled_date >= cutoff
create index if not exists pms_reservations_cancelled_idx
  on public.pms_reservations (property_id, cancelled_date desc)
  where cancelled_date is not null;

-- @query: src/lib/agent/tools/pms-feeds.ts get_recent_no_shows — status='no_show' and no_show_date >= cutoff
create index if not exists pms_reservations_no_show_idx
  on public.pms_reservations (property_id, no_show_date desc)
  where no_show_date is not null;

-- pms_reservations_status_idx (property_id, status) has never been scanned
-- since the 2026-04-08 stats reset and is superseded by the two partial
-- indexes above for the only two status queries that exist.
drop index if exists public.pms_reservations_status_idx;

insert into public.applied_migrations (version, description)
values (
  '0345',
  'Fold pms_future_bookings / pms_no_shows / pms_cancellations into pms_reservations; lifecycle coherence CHECKs, terminal-state guard trigger, nights_derived generated column'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
