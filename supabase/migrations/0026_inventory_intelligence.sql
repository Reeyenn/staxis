-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0026: Inventory Intelligence
--
-- Why this exists
-- ─────────────────────────────────────────────────────────────────────────
-- The inventory module shipped as a digital count tracker. After 40+ ops/GM
-- conversations, what hotels actually need is closer to a shrinkage detector
-- with auto-deduct math, dollar tracking, push alerts, and an order log.
--
-- This migration adds the data foundation:
--
--   1. inventory.unit_cost          — dollars per unit, drives variance $$
--      inventory.last_alerted_at    — used to dedupe SMS alerts (24h window)
--   2. properties.alert_phone       — per-property GM phone for SMS alerts.
--                                     Falls back to MANAGER_PHONE env var
--                                     when null (solo-operator case).
--   3. inventory_counts             — every count event is logged. The
--                                     historical record powers month-over-
--                                     month shrinkage trends and lets us
--                                     show "system estimated X, you counted
--                                     Y, variance Z" reconciliation.
--   4. inventory_orders             — every restock is logged: quantity,
--                                     vendor, cost, when received. Powers
--                                     "you spent $X on towels this month".
--
-- All new tables follow the existing RLS pattern (user_owns_property).
-- Idempotent: every column add is "if not exists", every table create is
-- "if not exists", every policy is "drop … if exists" then create. Safe
-- to re-run on a project that's been hand-applied piecemeal.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. inventory.unit_cost + last_alerted_at ────────────────────────────────
alter table inventory
  add column if not exists unit_cost numeric;

alter table inventory
  add column if not exists last_alerted_at timestamptz;

comment on column inventory.unit_cost is
  'Dollars per unit. Powers Total Inventory Value in the hero strip and the dollar variance shown in count reconciliation. Null = unknown cost; UI hides the dollar fields rather than showing $0.';

comment on column inventory.last_alerted_at is
  'When this item last triggered a critical SMS alert. /api/inventory/check-alerts skips items alerted within the last 24h to prevent SMS spam during a long shortage.';

-- 2. properties.alert_phone ───────────────────────────────────────────────
alter table properties
  add column if not exists alert_phone text;

comment on column properties.alert_phone is
  'E.164 phone number that receives critical inventory SMS alerts for this property. Null = falls back to MANAGER_PHONE env var (solo-operator case). Format: +12815550123.';

-- 3. inventory_counts ─────────────────────────────────────────────────────
-- One row per item per count event. When the user runs Count Mode and
-- saves, we write one row per item that had usage rates configured (so
-- we have an estimate to compare against). This is the historical ledger
-- that makes "your March shrinkage on bath towels was $148" possible.
create table if not exists inventory_counts (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  item_id           uuid not null references inventory(id) on delete cascade,
  item_name         text not null,                       -- snapshotted so deletes don't break history
  counted_stock     numeric not null,                    -- what the user typed
  estimated_stock   numeric,                             -- null when no usage rates configured
  variance          numeric,                             -- counted - estimated; null when estimate is null
  variance_value    numeric,                             -- variance * unit_cost; null when unit_cost is null
  unit_cost         numeric,                             -- snapshotted at count time
  counted_at        timestamptz not null default now(),
  counted_by        text,                                -- staff name or username
  notes             text,
  created_at        timestamptz not null default now()
);

create index if not exists inventory_counts_property_date_idx
  on inventory_counts (property_id, counted_at desc);

create index if not exists inventory_counts_item_idx
  on inventory_counts (item_id, counted_at desc);

comment on table inventory_counts is
  'Append-only log of every inventory count event. Snapshots both the count and the system-estimated stock so we can compute variance ("shrinkage") trends without re-deriving from current state.';

-- 4. inventory_orders ─────────────────────────────────────────────────────
-- One row per restock event. Triggered when the user counts and stock went
-- UP, or when they manually log an order. Drives "you spent $X on towels
-- this month" and average reorder cadence per item.
create table if not exists inventory_orders (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  item_id           uuid not null references inventory(id) on delete cascade,
  item_name         text not null,                       -- snapshotted
  quantity          numeric not null check (quantity >= 0),
  unit_cost         numeric,                             -- per-unit cost at time of order
  total_cost        numeric,                             -- quantity * unit_cost (denormalized for fast sum)
  vendor_name       text,
  ordered_at        timestamptz,                         -- when PO was placed (often unknown — null OK)
  received_at       timestamptz not null default now(),  -- when stock went up in Staxis
  notes             text,
  created_at        timestamptz not null default now()
);

create index if not exists inventory_orders_property_received_idx
  on inventory_orders (property_id, received_at desc);

create index if not exists inventory_orders_item_idx
  on inventory_orders (item_id, received_at desc);

comment on table inventory_orders is
  'Restock log. Each row = one delivery received. total_cost is denormalized so the spend-this-month query is a one-liner SUM.';

-- 5. RLS — owner read/write following user_owns_property pattern ──────────
alter table inventory_counts enable row level security;
drop policy if exists "owner rw inventory_counts" on inventory_counts;
create policy "owner rw inventory_counts"
  on inventory_counts
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

alter table inventory_orders enable row level security;
drop policy if exists "owner rw inventory_orders" on inventory_orders;
create policy "owner rw inventory_orders"
  on inventory_orders
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

-- 6. Track migration so the doctor's EXPECTED_MIGRATIONS check stays green ─
insert into applied_migrations (version, description)
values ('0026', 'inventory_intelligence: unit_cost, alert_phone, inventory_counts, inventory_orders')
on conflict (version) do nothing;
