-- ═══════════════════════════════════════════════════════════════════════════
-- 0249 — Equipment (asset) registry — REVIVAL
--
-- An asset registry for limited-service hotels: every serviceable piece of
-- equipment (HVAC, water heater, ice machine, elevator, pool pump, laundry
-- washer …) as a first-class row with warranty, purchase/replacement cost,
-- expected lifetime, PM interval, and a full repair/PM history derived from
-- the work_orders + preventive_tasks that link back to it.
--
-- HISTORY: this table first shipped as 0029 and was dropped in 0141 (the
-- May-2026 dead-schema cleanup) because nothing read or wrote it. It is now
-- revived with a real UI (a button at the top of the Maintenance → Preventive
-- tab) + warranty fields. The original equipment_id / repair_cost columns on
-- work_orders + preventive_tasks (added 0030, dropped 0141) are re-added here
-- so an asset's repair/PM history + cumulative spend can be computed.
--
-- Shape = 0029 + three new columns: serial_number, warranty_provider,
-- warranty_expires_at.
--
-- RLS posture — SERVICE-ROLE ONLY (mirrors compliance 0229 / inspections /
-- activity_log). Every read/write goes through /api/maintenance/equipment/*
-- using supabaseAdmin: the registry is an authenticated manager/staff surface,
-- never a public SMS-link page, so anon + authenticated are deny-all and the
-- routes enforce requireSession + userHasPropertyAccess (reads) + manager-role
-- (writes). This is intentionally stricter than 0029's owner-rw policy — the
-- 2026 convention is "service-role + API gate", not direct anon-client access.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. equipment — the asset registry ──────────────────────────────────────
-- @rls: service-role-only — all UI access mediated by /api/maintenance/equipment/* via supabaseAdmin (authenticated manager/staff surface; matches compliance 0229).
create table if not exists public.equipment (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,

  name                     text not null,
  category                 text not null default 'other'
                           check (category in
                             ('hvac','plumbing','electrical','appliance','structural','elevator','pool','laundry','kitchen','other')),
  location                 text,
  manufacturer             text,
  model_number             text,
  serial_number            text,                 -- NEW (0249)

  status                   text not null default 'operational'
                           check (status in
                             ('operational','degraded','failed','replaced','decommissioned')),

  install_date             date,
  expected_lifetime_years  numeric,
  purchase_cost            numeric,
  replacement_cost         numeric,

  pm_interval_days         integer,
  last_pm_at               timestamptz,

  warranty_provider        text,                 -- NEW (0249)
  warranty_expires_at      date,                 -- NEW (0249)

  notes                    text,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.equipment is
  'Hotel asset registry: one row per serviceable piece of equipment. Warranty + cost + lifetime + PM cadence. Repair/PM history derived from work_orders.equipment_id + preventive_tasks.equipment_id. property_id scoped, service-role-only. Revived 0249 (orig 0029, dropped 0141).';
comment on column public.equipment.warranty_expires_at is
  'Warranty end date (date-only). Drives the "under warranty / expires in N days / out of warranty" badge in the registry. Visual only — no cron/SMS in 0249.';

create index if not exists equipment_property_category_idx on public.equipment (property_id, category);
create index if not exists equipment_property_status_idx   on public.equipment (property_id, status);

-- ── 2. re-link work_orders + preventive_tasks to equipment ─────────────────
-- equipment_id is OPTIONAL (existing reactive/PM flows keep working with no
-- asset). ON DELETE SET NULL: deleting an asset must NEVER delete its work
-- orders / PM tasks — it just unlinks them (the history disappears from the
-- asset view, the work order itself survives).
alter table public.work_orders
  add column if not exists equipment_id uuid references public.equipment(id) on delete set null,
  add column if not exists repair_cost  numeric;

comment on column public.work_orders.equipment_id is
  'Optional link to the equipment asset this work order is against. Powers per-asset repair history + failure count. Re-added 0249 (orig 0030, dropped 0141).';
comment on column public.work_orders.repair_cost is
  'Optional dollars spent resolving this work order. Summed per-asset for "total repair spend" in the equipment registry. Re-added 0249.';

create index if not exists work_orders_equipment_idx
  on public.work_orders (equipment_id)
  where equipment_id is not null;

alter table public.preventive_tasks
  add column if not exists equipment_id uuid references public.equipment(id) on delete set null;

comment on column public.preventive_tasks.equipment_id is
  'Optional link to the equipment asset this preventive task applies to. Shows in the asset PM history. Re-added 0249 (orig 0030, dropped 0141).';

create index if not exists preventive_tasks_equipment_idx
  on public.preventive_tasks (equipment_id)
  where equipment_id is not null;

-- ── 3. RLS — service-role only; anon + authenticated deny-all ──────────────
alter table public.equipment enable row level security;

revoke all on public.equipment from public, anon, authenticated;
grant select, insert, update, delete on public.equipment to service_role;

drop policy if exists equipment_deny_all on public.equipment;
create policy equipment_deny_all on public.equipment
  for all to anon, authenticated using (false) with check (false);

-- ── 4. updated_at trigger (shared function from 0202/0211) ─────────────────
drop trigger if exists set_updated_at on public.equipment;
create trigger set_updated_at before update on public.equipment
  for each row execute function public._pms_set_updated_at();

-- ── 5. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0249',
  'Equipment (asset) registry REVIVAL: equipment table (0029 shape + serial_number + warranty_provider + warranty_expires_at), service-role-only RLS, re-added work_orders.equipment_id + work_orders.repair_cost + preventive_tasks.equipment_id (on delete set null) with partial indexes. UI = button at top of Maintenance → Preventive tab; reads/writes via /api/maintenance/equipment/*.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
