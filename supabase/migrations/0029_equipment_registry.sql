-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0029: Equipment Registry
--
-- Foundation for the maintenance ML pipeline. You can't predict failure
-- without knowing what equipment exists, how old it is, what it cost, what
-- its expected lifespan is, and what's happened to it.
--
-- This migration adds the `equipment` table. A follow-up (0030) links
-- work_orders + preventive_tasks back to equipment rows so the prediction
-- engine can compute time-between-failures, cumulative repair cost, and
-- repair-vs-replace economics per asset.
--
-- Categories were picked to match what hotel ops actually inventory:
-- HVAC (the #1 failure source), plumbing, electrical, appliances (ice
-- machines, microwaves, coffee makers), structural (roofing, pavement,
-- doors), elevator, pool, laundry (industrial washers/dryers), kitchen,
-- and a catch-all 'other' for everything else.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists equipment (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references properties(id) on delete cascade,
  name                     text not null,
  category                 text not null check (category in
                             ('hvac','plumbing','electrical','appliance','structural','elevator','pool','laundry','kitchen','other')),
  location                 text,
  model_number             text,
  manufacturer             text,
  install_date             date,
  expected_lifetime_years  numeric,
  purchase_cost            numeric,
  replacement_cost         numeric,
  status                   text not null default 'operational' check (status in
                             ('operational','degraded','failed','replaced','decommissioned')),
  pm_interval_days         integer,
  last_pm_at               timestamptz,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists equipment_property_idx on equipment (property_id, category);
create index if not exists equipment_status_idx   on equipment (property_id, status);

drop trigger if exists equipment_touch on equipment;
create trigger equipment_touch before update on equipment
  for each row execute function touch_updated_at();

-- RLS — owner read/write following the existing pattern
alter table equipment enable row level security;
drop policy if exists "owner rw equipment" on equipment;
create policy "owner rw equipment"
  on equipment
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

-- Realtime — the equipment tab subscribes via the standard subscribeTable
-- helper so an Add/Edit on one device shows up on another instantly.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'equipment'
  ) then
    alter publication supabase_realtime add table equipment;
  end if;
end $$;

-- Track migration
insert into applied_migrations (version, description)
values ('0029', 'equipment_registry: assets table for ML failure prediction + repair-vs-replace')
on conflict (version) do nothing;
