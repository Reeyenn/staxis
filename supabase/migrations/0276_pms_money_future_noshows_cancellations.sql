-- ═══════════════════════════════════════════════════════════════════════════
-- 0276 — feat/pms-universal-translate: 4 new universal PMS feeds
-- ═══════════════════════════════════════════════════════════════════════════
-- Adds money/payments, future bookings (pace), no-shows, and cancellations as
-- new pms_* tables, written by the universal CUA pipeline (generic-table-writer
-- + pms_table_schemas descriptors). Money split into two grains:
--   • pms_guest_balances  — per-folio outstanding balances (who owes) + deposits
--   • pms_payments_daily  — collected today (cash + card + deposits)
--   • pms_future_bookings — on-the-books reservations for UPCOMING dates (pace)
--   • pms_no_shows        — last night's no-show reservations
--   • pms_cancellations   — cancelled reservations
--
-- Design notes:
--   • Service-role-only, RLS deny-all-browser (same pattern as 0202). Web app
--     reads via /api/* with supabaseAdmin.
--   • Money is INTEGER CENTS (bigint). NO CHECK constraints on amounts: a weird
--     scraped value must never throw at insert and lose the whole write batch —
--     the per-field validators + descriptor ranges (none here, deliberately)
--     handle bad values by nulling the field / rejecting only its own row.
--   • balance_cents can be NEGATIVE (a credit balance), so it is unconstrained.
--   • Values translate via the UNIVERSAL generic parsers (no per-PMS code);
--     status fields are free text (no enum) so they need only format parsers.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── pms_guest_balances ──────────────────────────────────────────────────────
-- @rls: service-role-only — CUA worker writes; web app reads via /api/* with supabaseAdmin. RLS enabled + deny-all-browser applied in the DO-loop below.
create table if not exists public.pms_guest_balances (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  pms_folio_id          text not null,
  pms_reservation_id    text,
  guest_name            text,
  room_number           text,
  balance_cents         bigint,            -- amount owed now; may be negative (credit)
  deposit_cents         bigint,
  folio_status          text,
  last_payment_cents    bigint,
  last_payment_method   text,
  raw                   jsonb,
  captured_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint pms_guest_balances_natural_key unique (property_id, pms_folio_id)
);
comment on table public.pms_guest_balances is
  'Outstanding guest folio balances (who owes) + deposits. Service-role only. Created 0276.';
create index if not exists pms_guest_balances_owed_idx
  on public.pms_guest_balances (property_id, balance_cents desc);

-- ─── pms_payments_daily ──────────────────────────────────────────────────────
-- @rls: service-role-only — CUA worker writes; web app reads via /api/* with supabaseAdmin. RLS enabled + deny-all-browser applied in the DO-loop below.
create table if not exists public.pms_payments_daily (
  id                        uuid primary key default gen_random_uuid(),
  property_id               uuid not null references public.properties(id) on delete cascade,
  business_date             date not null,
  cash_collected_cents      bigint,
  card_collected_cents      bigint,
  deposits_collected_cents  bigint,
  total_collected_cents     bigint,
  raw                       jsonb,
  captured_at               timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint pms_payments_daily_natural_key unique (property_id, business_date)
);
comment on table public.pms_payments_daily is
  'Daily collected totals (cash + card + deposits). Service-role only. Created 0276.';
create index if not exists pms_payments_daily_date_idx
  on public.pms_payments_daily (property_id, business_date desc);

-- ─── pms_future_bookings ─────────────────────────────────────────────────────
-- @rls: service-role-only — CUA worker writes; web app reads via /api/* with supabaseAdmin. RLS enabled + deny-all-browser applied in the DO-loop below.
create table if not exists public.pms_future_bookings (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  pms_reservation_id    text not null,
  guest_name            text,
  room_number           text,
  room_type             text,
  arrival_date          date not null,
  departure_date        date,
  num_nights            integer,
  rate_per_night_cents  bigint,
  total_amount_cents    bigint,
  status                text,
  channel_name          text,
  raw                   jsonb,
  captured_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint pms_future_bookings_natural_key unique (property_id, pms_reservation_id)
);
comment on table public.pms_future_bookings is
  'On-the-books reservations for upcoming dates (booking pace). Service-role only. Created 0276.';
create index if not exists pms_future_bookings_arrival_idx
  on public.pms_future_bookings (property_id, arrival_date);

-- ─── pms_no_shows ────────────────────────────────────────────────────────────
-- @rls: service-role-only — CUA worker writes; web app reads via /api/* with supabaseAdmin. RLS enabled + deny-all-browser applied in the DO-loop below.
create table if not exists public.pms_no_shows (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  pms_reservation_id    text not null,
  guest_name            text,
  room_number           text,
  arrival_date          date not null,
  departure_date        date,
  rate_per_night_cents  bigint,
  total_amount_cents    bigint,
  channel_name          text,
  no_show_date          date,
  raw                   jsonb,
  captured_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint pms_no_shows_natural_key unique (property_id, pms_reservation_id)
);
comment on table public.pms_no_shows is
  'No-show reservations (last night). Service-role only. Created 0276.';
create index if not exists pms_no_shows_date_idx
  on public.pms_no_shows (property_id, no_show_date desc);
create index if not exists pms_no_shows_arrival_idx
  on public.pms_no_shows (property_id, arrival_date desc);

-- ─── pms_cancellations ───────────────────────────────────────────────────────
-- @rls: service-role-only — CUA worker writes; web app reads via /api/* with supabaseAdmin. RLS enabled + deny-all-browser applied in the DO-loop below.
create table if not exists public.pms_cancellations (
  id                      uuid primary key default gen_random_uuid(),
  property_id             uuid not null references public.properties(id) on delete cascade,
  pms_reservation_id      text not null,
  guest_name              text,
  room_number             text,
  arrival_date            date,
  departure_date          date,
  cancelled_date          date not null,
  cancellation_fee_cents  bigint,
  total_amount_cents      bigint,
  channel_name            text,
  reason                  text,
  raw                     jsonb,
  captured_at             timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint pms_cancellations_natural_key unique (property_id, pms_reservation_id)
);
comment on table public.pms_cancellations is
  'Cancelled reservations. Service-role only. Created 0276.';
create index if not exists pms_cancellations_date_idx
  on public.pms_cancellations (property_id, cancelled_date desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS + deny-all-browser (same pattern as 0202 / 0200)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  tbl text;
begin
  for tbl in select unnest(array[
    'pms_guest_balances',
    'pms_payments_daily',
    'pms_future_bookings',
    'pms_no_shows',
    'pms_cancellations'
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
    execute format(
      'comment on policy %I on public.%I is %L',
      tbl || '_deny_all_browser',
      tbl,
      'Service-role only. CUA worker writes; web app reads via /api/* with supabaseAdmin. Created 0276.'
    );
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- updated_at triggers (reuse the shared function from 0202)
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare
  tbl text;
begin
  for tbl in select unnest(array[
    'pms_guest_balances',
    'pms_payments_daily',
    'pms_future_bookings',
    'pms_no_shows',
    'pms_cancellations'
  ])
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', tbl);
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public._pms_set_updated_at()',
      tbl
    );
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- pms_table_schemas descriptor rows (drives generic-table-writer)
-- ═══════════════════════════════════════════════════════════════════════════
-- captured_at is listed as required timestamptz so the writer auto-stamps it
-- (it has no scraped source). Amount columns carry NO range_min/range_max so a
-- weird value nulls the field rather than rejecting the row. Status columns are
-- free text (no allowed_values) → only generic format parsers are needed.
insert into public.pms_table_schemas (table_name, write_strategy, snapshot_scope_default, natural_key, reconcile_key_field, columns, notes)
values
  ('pms_guest_balances', 'upsert', 'delta',
   array['property_id', 'pms_folio_id'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'pms_folio_id', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'pms_reservation_id', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'guest_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'balance_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'deposit_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'folio_status', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'last_payment_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'last_payment_method', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'captured_at', 'type', 'timestamptz', 'required', true, 'nullable', false)
   ),
   'Outstanding guest folio balances. Upsert on (property_id, pms_folio_id). delta scope (only folios with activity are listed).'),

  ('pms_payments_daily', 'upsert', 'delta',
   array['property_id', 'business_date'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'business_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'cash_collected_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'card_collected_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'deposits_collected_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'total_collected_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'captured_at', 'type', 'timestamptz', 'required', true, 'nullable', false)
   ),
   'Daily collected totals by tender. Upsert on (property_id, business_date).'),

  ('pms_future_bookings', 'upsert', 'delta',
   array['property_id', 'pms_reservation_id'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'pms_reservation_id', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'guest_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'room_type', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'arrival_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'departure_date', 'type', 'date', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'num_nights', 'type', 'integer', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'rate_per_night_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'total_amount_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'status', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'channel_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'captured_at', 'type', 'timestamptz', 'required', true, 'nullable', false)
   ),
   'On-the-books reservations for upcoming dates (booking pace). Upsert on (property_id, pms_reservation_id). delta scope.'),

  ('pms_no_shows', 'upsert', 'delta',
   array['property_id', 'pms_reservation_id'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'pms_reservation_id', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'guest_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'arrival_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'departure_date', 'type', 'date', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'rate_per_night_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'total_amount_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'channel_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'no_show_date', 'type', 'date', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'captured_at', 'type', 'timestamptz', 'required', true, 'nullable', false)
   ),
   'No-show reservations. Upsert on (property_id, pms_reservation_id). delta scope.'),

  ('pms_cancellations', 'upsert', 'delta',
   array['property_id', 'pms_reservation_id'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'pms_reservation_id', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'guest_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'arrival_date', 'type', 'date', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'departure_date', 'type', 'date', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'cancelled_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'cancellation_fee_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'total_amount_cents', 'type', 'bigint', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'channel_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'reason', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'captured_at', 'type', 'timestamptz', 'required', true, 'nullable', false)
   ),
   'Cancelled reservations. Upsert on (property_id, pms_reservation_id). delta scope.')
on conflict (table_name) do update set
  write_strategy         = excluded.write_strategy,
  snapshot_scope_default = excluded.snapshot_scope_default,
  natural_key            = excluded.natural_key,
  reconcile_key_field    = excluded.reconcile_key_field,
  columns                = excluded.columns,
  notes                  = excluded.notes,
  updated_at             = now();

-- ─── Track the migration ─────────────────────────────────────────────────
insert into public.applied_migrations (version, description)
values ('0276', 'feat/pms-universal-translate: 4 new universal feeds — pms_guest_balances, pms_payments_daily, pms_future_bookings, pms_no_shows, pms_cancellations (service-role RLS deny-all, money in cents) + their pms_table_schemas descriptors.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
