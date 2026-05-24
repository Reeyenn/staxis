-- ═══════════════════════════════════════════════════════════════════════════
-- 0207 — Plan v7 Phase 2b: per-table descriptors + shadow tables +
--        missing unique constraints.
--
-- Why this exists:
--   Plan v7 introduces a generic-table-writer that drives table writes
--   from MAPPER OUTPUT instead of hand-coded per-table writers. To do
--   that safely it needs:
--
--   A. A machine-readable descriptor of each pms_* table (write
--      strategy, natural key, column types, range checks). Today this
--      lives implicitly in code; we centralize it in `pms_table_schemas`.
--
--   B. Shadow tables for the 6 currently-extracted pms_* tables so the
--      new generic-writer can run in parallel with the legacy writers
--      for 7 days. Diff cron compares; per-table cutover flag flips
--      when zero diff is seen for the full window. Codex v2 P0-SHADOW
--      finding — was hand-waved as "shadow set" in v6.
--
--   C. Add a missing unique constraint on pms_rates_and_inventory so
--      ON CONFLICT (property_id, date, room_type, rate_plan) works.
--      Uses CREATE UNIQUE INDEX CONCURRENTLY pattern + preflight
--      duplicate check (Codex v2 P2-MIGRATION-SAFETY finding — empty
--      today, but unsafe to re-run blindly after data lands).
--
-- D. New audit table `pms_parity_diffs` for the daily diff cron.
--
-- Idempotent: create table if not exists + DO blocks with existence
-- checks. Safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Part A: pms_table_schemas descriptor table ─────────────────────────

create table if not exists public.pms_table_schemas (
  table_name              text primary key,
  write_strategy          text not null
                          check (write_strategy in ('upsert', 'append', 'reconcile')),
  snapshot_scope_default  text not null
                          check (snapshot_scope_default in ('full', 'delta')),
  natural_key             text[] not null,
  /** For reconcile-strategy tables: the field whose absence-from-snapshot
   *  triggers auto-resolve. e.g. pms_work_orders_v2 uses 'pms_work_order_id'
   *  — rows in the DB with this id that DON'T appear in the latest poll
   *  get auto-resolved. Null for upsert/append strategies. */
  reconcile_key_field     text,
  /** jsonb array of {name, type, required, nullable, range_min?,
   *  range_max?, allowed_values?}. The generic writer uses this for the
   *  type-check layer; per-table validator functions (validators.ts)
   *  handle cross-field invariants on top. */
  columns                 jsonb not null,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.pms_table_schemas is
  'Plan v7 Phase 2b descriptor table. Per-pms_* table: write strategy + natural key + column types + range checks. Drives generic-table-writer dispatch.';

alter table public.pms_table_schemas enable row level security;
revoke all on public.pms_table_schemas from public, anon, authenticated;
grant select, insert, update, delete on public.pms_table_schemas to service_role;
drop policy if exists pms_table_schemas_deny_all_browser on public.pms_table_schemas;
create policy pms_table_schemas_deny_all_browser
  on public.pms_table_schemas
  for all to anon, authenticated
  using (false) with check (false);

-- Seed the 14 supported tables (pms_reports_cache deferred to Phase 3).
-- Each descriptor declares write strategy + natural key + column types.
-- ON CONFLICT (table_name) DO UPDATE so re-running the migration
-- refreshes descriptors without losing custom edits to non-seeded fields.

insert into public.pms_table_schemas (table_name, write_strategy, snapshot_scope_default, natural_key, reconcile_key_field, columns, notes)
values
  ('pms_reservations', 'upsert', 'full',
   array['property_id', 'pms_reservation_id'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'pms_reservation_id', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'guest_name', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'arrival_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'departure_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'num_nights', 'type', 'integer', 'required', false, 'nullable', true, 'range_min', 0, 'range_max', 365),
     jsonb_build_object('name', 'status', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'channel_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'rate_per_night_cents', 'type', 'bigint', 'required', false, 'nullable', true, 'range_min', 0)
   ),
   'Reservation records — arrivals + departures + stays. Upsert on (property_id, pms_reservation_id).'),

  ('pms_guests', 'upsert', 'delta',
   array['property_id', 'pms_guest_id'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'pms_guest_id', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'name', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'email', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'phone', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'loyalty_tier', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'loyalty_points', 'type', 'integer', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'lifetime_stays', 'type', 'integer', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'lifetime_value_cents', 'type', 'bigint', 'required', false, 'nullable', true, 'range_min', 0)
   ),
   'Guest profiles — drilled per-reservation, sampled at mapper time. snapshot_scope=delta because we never see every guest.'),

  ('pms_rooms_inventory', 'upsert', 'full',
   array['property_id', 'room_number'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'room_type', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'bed_config', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'max_occupancy', 'type', 'integer', 'required', false, 'nullable', true, 'range_min', 0, 'range_max', 20),
     jsonb_build_object('name', 'floor', 'type', 'text', 'required', false, 'nullable', true)
   ),
   'Room inventory — physical room descriptors. Upsert per (property_id, room_number).'),

  ('pms_room_status_log', 'append', 'full',
   array['property_id', 'room_number', 'changed_at'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'status', 'type', 'text', 'required', true, 'nullable', false,
                       'allowed_values', jsonb_build_array('occupied', 'vacant_clean', 'vacant_dirty', 'inspected', 'out_of_order', 'unknown')),
     jsonb_build_object('name', 'changed_at', 'type', 'timestamptz', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'changed_by', 'type', 'text', 'required', false, 'nullable', true)
   ),
   'Room status events — append-only log. New row per status change.'),

  ('pms_housekeeping_assignments', 'upsert', 'full',
   array['property_id', 'date', 'room_number'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'housekeeper_name', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'cleaning_type', 'type', 'text', 'required', false, 'nullable', true,
                       'allowed_values', jsonb_build_array('departure', 'stayover', 'refresh', 'deep_clean', 'unknown')),
     jsonb_build_object('name', 'status', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'dnd_active', 'type', 'boolean', 'required', false, 'nullable', true)
   ),
   'HK assignments — daily refresh. Upsert per (date, room).'),

  ('pms_work_orders_v2', 'reconcile', 'full',
   array['property_id', 'pms_work_order_id'], 'pms_work_order_id',
   jsonb_build_array(
     jsonb_build_object('name', 'pms_work_order_id', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'room_number', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'description', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'priority', 'type', 'text', 'required', false, 'nullable', true,
                       'allowed_values', jsonb_build_array('low', 'medium', 'high', 'critical', 'unknown')),
     jsonb_build_object('name', 'status', 'type', 'text', 'required', true, 'nullable', false,
                       'allowed_values', jsonb_build_array('open', 'in_progress', 'resolved', 'cancelled')),
     jsonb_build_object('name', 'out_of_order', 'type', 'boolean', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'assigned_to', 'type', 'text', 'required', false, 'nullable', true)
   ),
   'Work orders — RECONCILE strategy: full snapshot. Rows in DB but not in latest poll auto-resolve to "resolved". snapshot_scope must be full or auto-resolve is skipped.'),

  ('pms_revenue_daily', 'upsert', 'full',
   array['property_id', 'date'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'rooms_revenue_cents', 'type', 'bigint', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'fnb_revenue_cents', 'type', 'bigint', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'tax_cents', 'type', 'bigint', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'occupied_rooms', 'type', 'integer', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'occupancy_pct', 'type', 'numeric', 'required', true, 'nullable', false, 'range_min', 0, 'range_max', 100),
     jsonb_build_object('name', 'adr_cents', 'type', 'bigint', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'revpar_cents', 'type', 'bigint', 'required', true, 'nullable', false, 'range_min', 0)
   ),
   'Daily revenue summary. Often missing on franchise-tier PMSes.'),

  ('pms_forecast_daily', 'upsert', 'full',
   array['property_id', 'forecast_date', 'snapshot_date'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'forecast_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'snapshot_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'projected_occupancy_pct', 'type', 'numeric', 'required', true, 'nullable', false, 'range_min', 0, 'range_max', 100),
     jsonb_build_object('name', 'projected_adr_cents', 'type', 'bigint', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'projected_revenue_cents', 'type', 'bigint', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'vs_same_day_last_year_pct', 'type', 'numeric', 'required', false, 'nullable', true)
   ),
   'Occupancy + revenue forecast. Enterprise-tier PMS feature.'),

  ('pms_channel_performance', 'upsert', 'full',
   array['property_id', 'date', 'channel'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'channel', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'bookings_count', 'type', 'integer', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'rooms_sold', 'type', 'integer', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'revenue_cents', 'type', 'bigint', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'commission_rate_pct', 'type', 'numeric', 'required', false, 'nullable', true, 'range_min', 0, 'range_max', 100)
   ),
   'Per-OTA / per-channel performance. e.g. Expedia / Booking.com / Direct.'),

  ('pms_in_house_snapshot', 'upsert', 'full',
   array['property_id'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'total_guests_in_house', 'type', 'integer', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'total_occupied_rooms', 'type', 'integer', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'total_vacant_clean', 'type', 'integer', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'arrivals_remaining_today', 'type', 'integer', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'departures_remaining_today', 'type', 'integer', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'captured_at', 'type', 'timestamptz', 'required', true, 'nullable', false)
   ),
   'Live dashboard snapshot — one row per property, always overwritten.'),

  ('pms_activity_log', 'append', 'delta',
   array['property_id', 'captured_at', 'pms_user', 'action'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'captured_at', 'type', 'timestamptz', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'pms_user', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'action', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'target', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'details', 'type', 'jsonb', 'required', false, 'nullable', true)
   ),
   'PMS audit log — append-only. snapshot_scope=delta because we never see every event.'),

  ('pms_lost_and_found', 'reconcile', 'full',
   array['property_id', 'pms_item_id'], 'pms_item_id',
   jsonb_build_array(
     jsonb_build_object('name', 'pms_item_id', 'type', 'text', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'item_description', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'location_found', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'found_at', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'status', 'type', 'text', 'required', true, 'nullable', false,
                       'allowed_values', jsonb_build_array('unclaimed', 'claimed', 'disposed')),
     jsonb_build_object('name', 'claimed_by_guest', 'type', 'text', 'required', false, 'nullable', true)
   ),
   'Lost & found log. Reconcile so status changes (claimed/disposed) flow through cleanly.'),

  ('pms_groups_and_blocks', 'upsert', 'full',
   array['property_id', 'pms_group_id'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'pms_group_id', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'group_name', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'block_start_date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'block_end_date', 'type', 'date', 'required', false, 'nullable', true),
     jsonb_build_object('name', 'rooms_blocked', 'type', 'integer', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'rooms_picked_up', 'type', 'integer', 'required', false, 'nullable', true, 'range_min', 0),
     jsonb_build_object('name', 'pickup_pct', 'type', 'numeric', 'required', false, 'nullable', true, 'range_min', 0, 'range_max', 200),
     jsonb_build_object('name', 'cutoff_date', 'type', 'date', 'required', false, 'nullable', true)
   ),
   'Group bookings + room blocks.'),

  ('pms_rates_and_inventory', 'upsert', 'full',
   array['property_id', 'date', 'room_type', 'rate_plan'], null,
   jsonb_build_array(
     jsonb_build_object('name', 'date', 'type', 'date', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'room_type', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'rate_plan', 'type', 'text', 'required', true, 'nullable', false),
     jsonb_build_object('name', 'rate_amount_cents', 'type', 'bigint', 'required', true, 'nullable', false, 'range_min', 0),
     jsonb_build_object('name', 'available_rooms', 'type', 'integer', 'required', true, 'nullable', false, 'range_min', 0)
   ),
   'Rate grid — per room_type × date × rate_plan. Note: rate_plan is NOT NULL in the unique constraint we add in this migration.')
on conflict (table_name) do update set
  write_strategy         = excluded.write_strategy,
  snapshot_scope_default = excluded.snapshot_scope_default,
  natural_key            = excluded.natural_key,
  reconcile_key_field    = excluded.reconcile_key_field,
  columns                = excluded.columns,
  notes                  = excluded.notes,
  updated_at             = now();

-- ─── Part B: shadow tables for the 6 currently-extracted pms_* tables ─────
--
-- During the 7-day parity window, generic-table-writer (env
-- CUA_SHADOW_MODE=true) writes here instead of the authoritative
-- tables. Diff cron compares. Per-table cutover flag flips once each
-- table sees zero diff for the full window. After all 6 cut over,
-- a follow-up migration drops the shadow tables.

create table if not exists public.pms_reservations_shadow                (like public.pms_reservations                including all);
create table if not exists public.pms_rooms_inventory_shadow             (like public.pms_rooms_inventory             including all);
create table if not exists public.pms_room_status_log_shadow             (like public.pms_room_status_log             including all);
create table if not exists public.pms_housekeeping_assignments_shadow    (like public.pms_housekeeping_assignments    including all);
create table if not exists public.pms_work_orders_v2_shadow              (like public.pms_work_orders_v2              including all);
create table if not exists public.pms_in_house_snapshot_shadow           (like public.pms_in_house_snapshot           including all);

-- Same RLS posture as the authoritative tables.
do $$
declare
  tbl text;
begin
  for tbl in select unnest(array[
    'pms_reservations_shadow',
    'pms_rooms_inventory_shadow',
    'pms_room_status_log_shadow',
    'pms_housekeeping_assignments_shadow',
    'pms_work_orders_v2_shadow',
    'pms_in_house_snapshot_shadow'
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

-- ─── Part C: missing unique constraint on pms_rates_and_inventory ────────
--
-- 0202 created the index but no unique constraint. Generic writer's
-- upsert needs ON CONFLICT (property_id, date, room_type, rate_plan).
-- Strategy (Codex v2 P2-MIGRATION-SAFETY):
--   1. Preflight — fail loud if duplicates exist (empty today; safety
--      net for re-runs after data lands).
--   2. CREATE UNIQUE INDEX CONCURRENTLY (non-blocking on the rare
--      chance the table has rows).
--   3. ALTER TABLE ADD CONSTRAINT USING INDEX (cheap, takes the lock
--      for milliseconds since the index already exists).

do $$
declare
  v_dup_count integer;
begin
  -- COALESCE the nullable rate_plan to a sentinel so NULL rate_plans
  -- group together (Postgres treats NULLs as distinct by default in
  -- unique constraints; we want one row per (date, room_type, plan)
  -- where plan can be NULL).
  select count(*) into v_dup_count
  from (
    select property_id, date, room_type, coalesce(rate_plan, '__NULL__') as rp
    from public.pms_rates_and_inventory
    group by 1, 2, 3, 4
    having count(*) > 1
  ) dups;

  if v_dup_count > 0 then
    raise exception 'pms_rates_and_inventory has % duplicate (property_id, date, room_type, rate_plan) groups — clean up before re-running 0207', v_dup_count
      using errcode = 'integrity_constraint_violation';
  end if;
end $$;

-- Unique INDEX (not constraint — Postgres rejects ADD CONSTRAINT USING
-- INDEX when the index uses an expression like coalesce). ON CONFLICT
-- can target a unique INDEX directly via the conflict_target expression
-- form: `ON CONFLICT (property_id, date, room_type, coalesce(rate_plan, ''))
-- DO UPDATE SET ...`. Generic writer composes the conflict target from
-- the descriptor's natural_key + this expression where needed.
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'pms_rates_and_inventory'
      and indexname = 'pms_rates_inventory_unique_idx'
  ) then
    create unique index pms_rates_inventory_unique_idx
      on public.pms_rates_and_inventory (property_id, date, room_type, coalesce(rate_plan, ''));
  end if;
end $$;

-- ─── Part D: pms_parity_diffs audit table ────────────────────────────────
--
-- Daily diff cron writes one row per detected discrepancy between
-- authoritative and shadow tables. Sentry-alerts on non-zero rows.

create table if not exists public.pms_parity_diffs (
  id                  uuid primary key default gen_random_uuid(),
  table_name          text not null,
  natural_key         jsonb not null,
  authoritative_row   jsonb,
  shadow_row          jsonb,
  diff_kind           text not null
                      check (diff_kind in ('missing_in_shadow', 'missing_in_authoritative', 'value_mismatch')),
  run_id              uuid not null,
  observed_at         timestamptz not null default now()
);

comment on table public.pms_parity_diffs is
  'Plan v7 Phase 2b parity-gate audit. Daily diff cron writes here; Sentry alerts on non-zero. Empty rows for 7 consecutive days per table = generic writer becomes authoritative for that table.';

create index if not exists pms_parity_diffs_table_observed_idx
  on public.pms_parity_diffs (table_name, observed_at desc);
create index if not exists pms_parity_diffs_run_idx
  on public.pms_parity_diffs (run_id);

alter table public.pms_parity_diffs enable row level security;
revoke all on public.pms_parity_diffs from public, anon, authenticated;
grant select, insert, update, delete on public.pms_parity_diffs to service_role;
drop policy if exists pms_parity_diffs_deny_all_browser on public.pms_parity_diffs;
create policy pms_parity_diffs_deny_all_browser
  on public.pms_parity_diffs
  for all to anon, authenticated
  using (false) with check (false);

-- ─── Track the migration ─────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values ('0207', 'Plan v7 Phase 2b: pms_table_schemas descriptor table (14 tables) + 6 shadow tables for parity gate + missing unique constraint on pms_rates_and_inventory + pms_parity_diffs audit table.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
