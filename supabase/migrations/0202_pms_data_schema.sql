-- ═══════════════════════════════════════════════════════════════════════════
-- 0202 — Universal PMS data schema (15 tables).
--
-- Why this exists:
--   Plan v4 (mission-plan-a-optimized-torvalds.md) extracts data from each
--   hotel's PMS via a persistent Claude-vision browser and writes the
--   normalized output into these 15 tables. The schema is the SUPERSET of
--   what any PMS might expose — each hotel's actual data depends on what
--   their PMS shows. Fields a PMS doesn't expose stay NULL for that hotel.
--
--   This migration ALONE does not extract any data — it only creates the
--   tables and access controls. Extraction wires up in the CUA worker
--   (cua-service) per the plan.
--
-- Active vs empty (Phase 1 scope):
--   ACTIVE (populated by the 5 ported scraper feeds):
--     - pms_reservations           (arrivals + departures)
--     - pms_rooms_inventory        (room metadata from room layout)
--     - pms_room_status_log        (room status changes)
--     - pms_housekeeping_assignments (HK Center daily plan)
--     - pms_work_orders_v2         (OOO + maintenance with reconciliation)
--     - pms_in_house_snapshot      (live dashboard counts)
--
--   EMPTY (created but not populated until a later separate project
--          wires up comprehensive extraction via the mapper):
--     - pms_guests                 (guest profiles, loyalty)
--     - pms_revenue_daily          (financial summaries)
--     - pms_forecast_daily         (forward projections)
--     - pms_channel_performance    (OTA breakdowns)
--     - pms_reports_cache          (cached pre-built PMS reports)
--     - pms_activity_log           (PMS user activity audit)
--     - pms_lost_and_found         (lost items)
--     - pms_groups_and_blocks      (group reservations)
--     - pms_rates_and_inventory    (rate snapshots)
--
-- Tenant scoping:
--   Every table has property_id (FK to properties.id, on delete cascade).
--   All tables are SERVICE-ROLE-ONLY at this stage — the new Staxis web
--   app (Reeyen's separate effort) will add per-role RLS policies when it
--   needs read access. Until then, /api/* routes mediate via supabaseAdmin.
--
-- PII note:
--   pms_guests includes name/email/phone/address/id_number_last4. When the
--   new web app reads guest data, it needs column-level access controls
--   and audit logging — flagged here as a follow-up. Today the table is
--   empty so no PII is at risk.
--
-- Idempotent: create table if not exists + drop policy if exists. Safe to
-- re-run.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 1 — pms_reservations
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per reservation. Active feed: arrivals + departures from CA's
-- Housekeeping Check-off List CSV. Most fields NULL for CA (no rate, no
-- OTA channel detail visible at franchise level).

create table if not exists public.pms_reservations (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  pms_reservation_id       text not null,
  pms_guest_id             text,
  guest_name               text,
  room_number              text,
  room_type                text,
  arrival_date             date,
  arrival_time             time,
  departure_date           date,
  departure_time           time,
  num_nights               integer check (num_nights is null or num_nights >= 0),
  adults                   integer check (adults is null or adults >= 0),
  children                 integer check (children is null or children >= 0),
  infants                  integer check (infants is null or infants >= 0),
  rate_per_night_cents     bigint check (rate_per_night_cents is null or rate_per_night_cents >= 0),
  total_amount_cents       bigint check (total_amount_cents is null or total_amount_cents >= 0),
  currency                 text default 'USD',
  source                   text,
  channel_name             text,
  payment_method           text,
  deposit_status           text,
  deposit_amount_cents     bigint check (deposit_amount_cents is null or deposit_amount_cents >= 0),
  cancellation_policy      text,
  status                   text check (status is null or status in (
                             'booked','checked_in','checked_out','cancelled','no_show'
                           )),
  status_changed_at        timestamptz,
  notes                    text,
  special_requests         text,
  dietary_needs            text,
  accessibility_needs      text,
  group_block_id           text,
  corporate_account        text,
  package_name             text,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pms_reservations_pms_id_unique unique (property_id, pms_reservation_id)
);

comment on table public.pms_reservations is
  'One row per reservation. Active feed: arrivals + departures. Created 0202.';
comment on column public.pms_reservations.raw is
  'Raw PMS row preserved for forensics when normalized columns can''t capture everything.';

create index if not exists pms_reservations_arrival_date_idx
  on public.pms_reservations (property_id, arrival_date desc);
create index if not exists pms_reservations_departure_date_idx
  on public.pms_reservations (property_id, departure_date desc);
create index if not exists pms_reservations_status_idx
  on public.pms_reservations (property_id, status)
  where status is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 2 — pms_guests (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_guests (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  pms_guest_id             text not null,
  name                     text,
  email                    text,
  phone                    text,
  address                  text,
  city                     text,
  state                    text,
  country                  text,
  postal_code              text,
  id_type                  text,
  id_number_last4          text,
  date_of_birth            date,
  nationality              text,
  loyalty_program          text,
  loyalty_tier             text,
  loyalty_points           integer check (loyalty_points is null or loyalty_points >= 0),
  loyalty_member_since     date,
  lifetime_stays           integer check (lifetime_stays is null or lifetime_stays >= 0),
  lifetime_value_cents     bigint check (lifetime_value_cents is null or lifetime_value_cents >= 0),
  last_stay_date           date,
  last_room_number         text,
  average_stay_length      numeric(5,2),
  preferences              jsonb,
  notes                    text,
  special_status           text,
  birthday                 date,
  anniversary              date,
  group_affiliation        text,
  corporate_affiliation    text,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pms_guests_pms_id_unique unique (property_id, pms_guest_id)
);

comment on table public.pms_guests is
  'One row per guest. Empty in Phase 1 — populated when comprehensive extraction wires up. PII fields (name/email/phone/etc.) — needs RLS + audit when web app reads. Created 0202.';

create index if not exists pms_guests_loyalty_idx
  on public.pms_guests (property_id, loyalty_tier)
  where loyalty_tier is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 3 — pms_rooms_inventory
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per room. Active feed: derived from CSV room list + HK Center
-- room metadata.

create table if not exists public.pms_rooms_inventory (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  room_number              text not null,
  room_type                text,
  bed_config               text,
  max_occupancy            integer check (max_occupancy is null or max_occupancy >= 0),
  view_type                text,
  floor                    text,
  connecting_to            text,
  adjoining_to             text,
  pet_friendly             boolean,
  smoking_allowed          boolean,
  accessible               boolean,
  is_suite                 boolean,
  square_footage           integer check (square_footage is null or square_footage >= 0),
  last_renovated           date,
  amenities                jsonb,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pms_rooms_inventory_room_unique unique (property_id, room_number)
);

comment on table public.pms_rooms_inventory is
  'One row per room. Active feed: derived from CSV room list. Created 0202.';

create index if not exists pms_rooms_inventory_room_type_idx
  on public.pms_rooms_inventory (property_id, room_type)
  where room_type is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 4 — pms_room_status_log
-- ═══════════════════════════════════════════════════════════════════════════
-- Append-only log of room status changes. ACTIVE FEED.
-- "Current" status for a room = most recent row per (property_id, room_number).
-- Volume estimate: ~60 rooms * 2880 polls/day * 30 days = ~5M rows/month/hotel
-- at maximum churn. Realistic churn (status only writes on change): ~10-100
-- rows/day per hotel. Index lets us answer "current status of room X" fast.

create table if not exists public.pms_room_status_log (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  room_number              text not null,
  status                   text not null
                           check (status in (
                             'vacant_clean',
                             'vacant_dirty',
                             'occupied',
                             'occupied_clean',
                             'occupied_dirty',
                             'out_of_order',
                             'out_of_inventory',
                             'inspected',
                             'unknown'
                           )),
  changed_at               timestamptz not null default now(),
  changed_by               text,
  source                   text not null default 'cua'
                           check (source in ('cua','manual','scheduled','workflow')),
  notes                    text,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now()
);

comment on table public.pms_room_status_log is
  'Append-only log of room status changes. Latest row per (property_id, room_number) is the current status. Active feed. Created 0202.';

-- Critical index for "current status of room X" queries.
create index if not exists pms_room_status_log_current_idx
  on public.pms_room_status_log (property_id, room_number, changed_at desc);
create index if not exists pms_room_status_log_changed_at_idx
  on public.pms_room_status_log (property_id, changed_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 5 — pms_housekeeping_assignments
-- ═══════════════════════════════════════════════════════════════════════════
-- Daily HK plan. ACTIVE FEED. One row per (property_id, date, room_number).
-- Overwritten on each pull within the same day — the latest PMS state is
-- the truth.

create table if not exists public.pms_housekeeping_assignments (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  date                     date not null,
  room_number              text not null,
  housekeeper_name         text,
  cleaning_type            text check (cleaning_type is null or cleaning_type in (
                             'departure','stayover','deep','refresh','inspection','arrival'
                           )),
  scheduled_time           timestamptz,
  started_at               timestamptz,
  completed_at             timestamptz,
  time_spent_minutes       integer check (time_spent_minutes is null or time_spent_minutes >= 0),
  status                   text default 'not_started'
                           check (status in (
                             'not_started','in_progress','completed','refused','skipped'
                           )),
  refused_reason           text,
  late_checkout_approved   boolean,
  late_checkout_until      time,
  early_checkin_approved   boolean,
  early_checkin_from       time,
  dnd_active               boolean,
  dnd_until                time,
  service_requested        text,
  notes                    text,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pms_hk_assignments_unique unique (property_id, date, room_number)
);

comment on table public.pms_housekeeping_assignments is
  'Daily HK plan per room. Active feed: HK Center page extraction. Created 0202.';

create index if not exists pms_hk_assignments_date_idx
  on public.pms_housekeeping_assignments (property_id, date desc);
create index if not exists pms_hk_assignments_housekeeper_idx
  on public.pms_housekeeping_assignments (property_id, date desc, housekeeper_name)
  where housekeeper_name is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 6 — pms_work_orders_v2
-- ═══════════════════════════════════════════════════════════════════════════
-- ACTIVE FEED. Preserves the reconciliation semantics from
-- scraper/ooo-pull.js — three-way: new/update-existing/resolve-disappeared.

create table if not exists public.pms_work_orders_v2 (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  pms_work_order_id        text not null,
  room_number              text,
  area                     text,
  description              text,
  category                 text check (category is null or category in (
                             'plumbing','electrical','hvac','cosmetic','safety','appliance','other'
                           )),
  priority                 text default 'medium'
                           check (priority in ('urgent','high','medium','low')),
  status                   text not null default 'open'
                           check (status in ('open','in_progress','closed','deferred','resolved')),
  assigned_to              text,
  reported_at              timestamptz,
  reported_by              text,
  started_at               timestamptz,
  completed_at             timestamptz,
  resolved_at              timestamptz,
  out_of_order             boolean default false,
  eta_back_in_service      timestamptz,
  recurring_room           boolean default false,
  estimated_cost_cents     bigint check (estimated_cost_cents is null or estimated_cost_cents >= 0),
  actual_cost_cents        bigint check (actual_cost_cents is null or actual_cost_cents >= 0),
  parts_needed             text,
  notes                    text,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pms_work_orders_v2_pms_id_unique unique (property_id, pms_work_order_id)
);

comment on table public.pms_work_orders_v2 is
  'Maintenance + OOO work orders. Active feed with reconciliation: new/update-existing/auto-resolve-disappeared. Replaces 0001 work_orders. Created 0202.';

create index if not exists pms_work_orders_v2_status_idx
  on public.pms_work_orders_v2 (property_id, status);
create index if not exists pms_work_orders_v2_room_idx
  on public.pms_work_orders_v2 (property_id, room_number)
  where room_number is not null;
create index if not exists pms_work_orders_v2_ooo_idx
  on public.pms_work_orders_v2 (property_id, out_of_order, status)
  where out_of_order = true;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 7 — pms_revenue_daily (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_revenue_daily (
  id                            uuid primary key default gen_random_uuid(),
  property_id                   uuid not null references public.properties(id) on delete cascade,
  date                          date not null,
  rooms_revenue_cents           bigint,
  fnb_revenue_cents             bigint,
  ancillary_revenue_cents       bigint,
  total_revenue_cents           bigint,
  refunds_cents                 bigint,
  comps_cents                   bigint,
  discounts_cents               bigint,
  adjustments_cents             bigint,
  occupied_rooms                integer,
  available_rooms               integer,
  ooo_rooms                     integer,
  occupancy_pct                 numeric(5,2),
  adr_cents                     bigint,
  revpar_cents                  bigint,
  goppar_cents                  bigint,
  gross_operating_profit_cents  bigint,
  ota_commission_paid_cents     bigint,
  channel_commission_breakdown  jsonb,
  taxes_collected               jsonb,
  walk_in_revenue_cents         bigint,
  group_revenue_cents           bigint,
  transient_revenue_cents       bigint,
  raw                           jsonb,
  last_synced_at                timestamptz not null default now(),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint pms_revenue_daily_unique unique (property_id, date)
);

comment on table public.pms_revenue_daily is
  'Daily revenue summary. Empty in Phase 1 (CA franchise PMS does not expose financials). Created 0202.';

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 8 — pms_forecast_daily (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_forecast_daily (
  id                            uuid primary key default gen_random_uuid(),
  property_id                   uuid not null references public.properties(id) on delete cascade,
  forecast_date                 date not null,
  snapshot_date                 date not null,
  projected_occupancy_pct       numeric(5,2),
  projected_adr_cents           bigint,
  projected_revenue_cents       bigint,
  projected_revpar_cents        bigint,
  projected_arrivals            integer,
  projected_departures          integer,
  projected_in_house            integer,
  booking_pace_indicator        text,
  vs_same_day_last_year_pct     numeric(5,2),
  raw                           jsonb,
  last_synced_at                timestamptz not null default now(),
  created_at                    timestamptz not null default now(),
  constraint pms_forecast_daily_unique unique (property_id, forecast_date, snapshot_date)
);

comment on table public.pms_forecast_daily is
  'Forward-looking forecast snapshots. Empty in Phase 1. Created 0202.';

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 9 — pms_channel_performance (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_channel_performance (
  id                            uuid primary key default gen_random_uuid(),
  property_id                   uuid not null references public.properties(id) on delete cascade,
  date                          date not null,
  channel                       text not null,
  bookings_count                integer check (bookings_count is null or bookings_count >= 0),
  rooms_sold                    integer check (rooms_sold is null or rooms_sold >= 0),
  revenue_cents                 bigint,
  commission_paid_cents         bigint,
  commission_rate_pct           numeric(5,2),
  average_lead_time_days        numeric(5,2),
  average_length_of_stay        numeric(5,2),
  cancellation_rate_pct         numeric(5,2),
  raw                           jsonb,
  last_synced_at                timestamptz not null default now(),
  created_at                    timestamptz not null default now(),
  constraint pms_channel_performance_unique unique (property_id, date, channel)
);

comment on table public.pms_channel_performance is
  'OTA / source breakdown per day. Empty in Phase 1. Created 0202.';

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 10 — pms_reports_cache (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_reports_cache (
  id                            uuid primary key default gen_random_uuid(),
  property_id                   uuid not null references public.properties(id) on delete cascade,
  report_type                   text not null,
  report_date                   date not null,
  raw_content                   jsonb,
  parsed_summary                jsonb,
  fetched_at                    timestamptz not null default now(),
  constraint pms_reports_cache_unique unique (property_id, report_type, report_date)
);

comment on table public.pms_reports_cache is
  'Cached pre-built PMS reports. Empty in Phase 1. Created 0202.';

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 11 — pms_in_house_snapshot
-- ═══════════════════════════════════════════════════════════════════════════
-- ACTIVE FEED. One row per property (UPSERTED on every poll, ~30s cadence).
-- Latest snapshot of dashboard counts. Preserves atomic-write semantics
-- from scraper/dashboard-pull.js (all-3-counts-or-none) via the
-- last_good_at + has_error fields — when an extraction fails, we keep
-- the previous good values and flag the error.

create table if not exists public.pms_in_house_snapshot (
  property_id                   uuid primary key references public.properties(id) on delete cascade,
  total_guests_in_house         integer,
  total_occupied_rooms          integer,
  total_vacant_clean            integer,
  total_vacant_dirty            integer,
  total_ooo                     integer,
  arrivals_remaining_today      integer,
  departures_remaining_today    integer,
  walk_ins_today                integer,
  vip_guests_in_house           integer,
  special_needs_guests_in_house integer,
  checked_in_today_count        integer,
  checked_out_today_count       integer,
  no_shows_today                integer,
  cancellations_today           integer,
  revenue_today_so_far_cents    bigint,
  captured_at                   timestamptz not null default now(),
  last_good_at                  timestamptz,
  has_error                     boolean not null default false,
  last_error                    text,
  last_error_at                 timestamptz,
  raw                           jsonb,
  last_synced_at                timestamptz not null default now()
);

comment on table public.pms_in_house_snapshot is
  'Live "right now" counts per property. Upserted every poll. Active feed: dashboard counts. Atomic semantics: when extraction fails, keep last-good values and flag has_error. Created 0202.';
comment on column public.pms_in_house_snapshot.last_good_at is
  'When the count fields were last refreshed with a known-good extraction. Stale-but-true preserved when has_error=true.';

create index if not exists pms_in_house_snapshot_captured_at_idx
  on public.pms_in_house_snapshot (captured_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 12 — pms_activity_log (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_activity_log (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  captured_at              timestamptz not null default now(),
  pms_user                 text,
  action                   text,
  target                   text,
  details                  jsonb,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now()
);

comment on table public.pms_activity_log is
  'PMS user activity audit trail. Empty in Phase 1. Created 0202.';

create index if not exists pms_activity_log_captured_at_idx
  on public.pms_activity_log (property_id, captured_at desc);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 13 — pms_lost_and_found (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_lost_and_found (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  pms_item_id              text,
  item_description         text,
  location_found           text,
  room_number              text,
  found_at                 timestamptz,
  found_by                 text,
  status                   text check (status is null or status in (
                             'open','claimed','disposed','shipped','expired'
                           )),
  claimed_by_guest         text,
  claimed_at               timestamptz,
  shipping_info            jsonb,
  notes                    text,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pms_lost_and_found_pms_id_unique unique (property_id, pms_item_id)
);

comment on table public.pms_lost_and_found is
  'Lost items. Empty in Phase 1. Created 0202.';

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 14 — pms_groups_and_blocks (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_groups_and_blocks (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  pms_group_id             text not null,
  group_name               text,
  contact_name             text,
  contact_email            text,
  contact_phone            text,
  block_start_date         date,
  block_end_date           date,
  rooms_blocked            integer check (rooms_blocked is null or rooms_blocked >= 0),
  rooms_picked_up          integer check (rooms_picked_up is null or rooms_picked_up >= 0),
  pickup_pct               numeric(5,2),
  cutoff_date              date,
  rate_cents               bigint,
  package_details          jsonb,
  status                   text,
  notes                    text,
  raw                      jsonb,
  last_synced_at           timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint pms_groups_pms_id_unique unique (property_id, pms_group_id)
);

comment on table public.pms_groups_and_blocks is
  'Group reservations (weddings, sports teams, corporate). Empty in Phase 1. Created 0202.';

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE 15 — pms_rates_and_inventory (empty in Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pms_rates_and_inventory (
  id                            uuid primary key default gen_random_uuid(),
  property_id                   uuid not null references public.properties(id) on delete cascade,
  captured_at                   timestamptz not null default now(),
  room_type                     text not null,
  date                          date not null,
  rate_plan                     text,
  rate_amount_cents             bigint,
  available_rooms               integer check (available_rooms is null or available_rooms >= 0),
  rate_loaded_in_channel_manager boolean,
  rate_parity_status            jsonb,
  raw                           jsonb,
  last_synced_at                timestamptz not null default now()
);

comment on table public.pms_rates_and_inventory is
  'Current rate / availability snapshots. Empty in Phase 1. Created 0202.';

create index if not exists pms_rates_inventory_date_idx
  on public.pms_rates_and_inventory (property_id, date, room_type);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS + deny-all-browser for all 15 tables
-- ═══════════════════════════════════════════════════════════════════════════
-- Pattern matches 0200 (scraper_session, pull_metrics) and is the default
-- for all CUA-written tables. When the new Staxis web app needs to read,
-- it adds per-role policies in a follow-up migration.

do $$
declare
  tbl text;
begin
  for tbl in select unnest(array[
    'pms_reservations',
    'pms_guests',
    'pms_rooms_inventory',
    'pms_room_status_log',
    'pms_housekeeping_assignments',
    'pms_work_orders_v2',
    'pms_revenue_daily',
    'pms_forecast_daily',
    'pms_channel_performance',
    'pms_reports_cache',
    'pms_in_house_snapshot',
    'pms_activity_log',
    'pms_lost_and_found',
    'pms_groups_and_blocks',
    'pms_rates_and_inventory'
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
      'Service-role only. CUA worker writes; web app reads via /api/* with supabaseAdmin. Created 0202.'
    );
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- updated_at triggers on tables that have an updated_at column
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._pms_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
declare
  tbl text;
begin
  for tbl in select unnest(array[
    'pms_reservations',
    'pms_guests',
    'pms_rooms_inventory',
    'pms_housekeeping_assignments',
    'pms_work_orders_v2',
    'pms_revenue_daily',
    'pms_lost_and_found',
    'pms_groups_and_blocks'
  ])
  loop
    execute format(
      'drop trigger if exists set_updated_at on public.%I', tbl
    );
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function public._pms_set_updated_at()',
      tbl
    );
  end loop;
end $$;

-- ─── Track the migration ─────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values (
  '0202',
  'Universal PMS data schema: 15 tables. 6 active (reservations, rooms_inventory, room_status_log, housekeeping_assignments, work_orders_v2, in_house_snapshot); 9 empty until comprehensive extraction wires up.'
)
on conflict (version) do nothing;

-- ─── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';
