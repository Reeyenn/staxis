-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0043: Vendors + equipment warranty + service contracts
-- (Originally written as 0036 but renumbered after discovering 0036 was
--  taken by the 2026-04 search-path hardening migration.)
--
-- Three things land together because they're one product wedge — Maintenance
-- V6, motivated by two operator interviews (Tara at Home2 + a regional
-- director with ~10 properties across Hilton/Marriott/IHG).
--
--   1. `vendors` table — per-property contact list (HVAC techs, pool service,
--      pest control, fire-suppression vendor, etc). Foundation for the
--      "is this still under warranty?" surfacing on Work Orders.
--
--   2. `equipment.vendor_id` + `equipment.warranty_end_date` — links an
--      asset to who installed/services it and when its manufacturer
--      warranty ends. Drives the green "Under warranty until X — call
--      Vendor before paying" banner on Work Order create/edit.
--
--   3. `work_orders.vendor_id` — who actually performed the repair. Enables
--      vendor spend reporting later.
--
--   4. `service_contracts` table — recurring outsourced services that you
--      pay a vendor for on a schedule (pool company every Monday, fire
--      inspection every six months, etc). Same alert thresholds as PM —
--      30/14/7 days before next_due_at, then again when overdue.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. vendors ────────────────────────────────────────────────────────────────
create table if not exists vendors (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references properties(id) on delete cascade,
  name          text not null,
  category      text not null check (category in
                  ('hvac','plumbing','electrical','appliance','pool',
                   'landscaping','pest','fire','elevator','laundry',
                   'kitchen','structural','other')),
  contact_name  text,
  contact_email text,
  contact_phone text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists vendors_property_idx on vendors (property_id, category);

drop trigger if exists vendors_touch on vendors;
create trigger vendors_touch before update on vendors
  for each row execute function touch_updated_at();

alter table vendors enable row level security;
drop policy if exists "owner rw vendors" on vendors;
create policy "owner rw vendors"
  on vendors
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'vendors'
  ) then
    alter publication supabase_realtime add table vendors;
  end if;
end $$;

-- 2. equipment: vendor + warranty ───────────────────────────────────────────
alter table equipment
  add column if not exists vendor_id          uuid references vendors(id) on delete set null,
  add column if not exists warranty_end_date  date;

create index if not exists equipment_vendor_idx
  on equipment (vendor_id) where vendor_id is not null;

create index if not exists equipment_warranty_idx
  on equipment (property_id, warranty_end_date)
  where warranty_end_date is not null;

comment on column equipment.vendor_id is
  'Optional link to the vendor who installed/services this asset. Powers the "still under warranty? call vendor first" banner on Work Order create.';
comment on column equipment.warranty_end_date is
  'Manufacturer / installer warranty end date. NULL = no warranty tracked.';

-- 3. work_orders: who did the repair ────────────────────────────────────────
alter table work_orders
  add column if not exists vendor_id uuid references vendors(id) on delete set null;

create index if not exists work_orders_vendor_idx
  on work_orders (vendor_id) where vendor_id is not null;

comment on column work_orders.vendor_id is
  'Optional link to the vendor who performed the repair. Enables per-vendor spend reporting.';

-- 4. service_contracts ─────────────────────────────────────────────────────
create table if not exists service_contracts (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null references properties(id) on delete cascade,
  vendor_id        uuid references vendors(id) on delete set null,
  name             text not null,
  category         text not null check (category in
                     ('hvac','plumbing','electrical','appliance','pool',
                      'landscaping','pest','fire','elevator','laundry',
                      'kitchen','structural','other')),
  cadence          text not null check (cadence in
                     ('weekly','biweekly','monthly','quarterly','annual')),
  last_serviced_at date,
  next_due_at      date,
  monthly_cost     numeric,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists service_contracts_property_idx
  on service_contracts (property_id, next_due_at);

drop trigger if exists service_contracts_touch on service_contracts;
create trigger service_contracts_touch before update on service_contracts
  for each row execute function touch_updated_at();

alter table service_contracts enable row level security;
drop policy if exists "owner rw service contracts" on service_contracts;
create policy "owner rw service contracts"
  on service_contracts
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'service_contracts'
  ) then
    alter publication supabase_realtime add table service_contracts;
  end if;
end $$;

-- Track migration
insert into applied_migrations (version, description)
values ('0043', 'vendors + equipment.warranty + work_orders.vendor_id + service_contracts')
on conflict (version) do nothing;

-- Force PostgREST to refresh its schema cache so REST + Realtime see the
-- new tables/columns immediately. CLAUDE.md flags this as a load-bearing
-- step after every DDL.
notify pgrst, 'reload schema';
