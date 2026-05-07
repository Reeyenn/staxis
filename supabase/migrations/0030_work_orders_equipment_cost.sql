-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0030: Link work orders + preventive tasks to equipment
--                 + add repair cost tracking
--
-- Why this is separate from 0029: we want equipment to exist as a registry
-- BEFORE we start linking historical work_orders rows to it. Apply 0029
-- first, seed your equipment list, THEN apply 0030. Re-running both is
-- safe (idempotent column adds).
--
-- Three things added:
--   1. work_orders.equipment_id   — the asset that broke (optional FK)
--      work_orders.repair_cost    — what fixing it cost
--      work_orders.parts_used     — text[] of parts/supplies consumed
--   2. preventive_tasks.equipment_id — the asset the PM applies to
--   3. nothing else — keep the surface tight
--
-- The repair_cost + cumulative spend by equipment_id is what powers the
-- repair-vs-replace recommendation in maintenance-ml.ts. parts_used is
-- the audit trail when work-order resolution deducts from inventory.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. work_orders columns ──────────────────────────────────────────────────
alter table work_orders
  add column if not exists equipment_id uuid references equipment(id) on delete set null,
  add column if not exists repair_cost  numeric,
  add column if not exists parts_used   text[] not null default '{}';

create index if not exists work_orders_equipment_idx
  on work_orders (equipment_id)
  where equipment_id is not null;

comment on column work_orders.equipment_id is
  'Optional link to the equipment asset that broke. Powers cumulative-repair-cost-per-asset and time-between-failures-per-asset metrics.';
comment on column work_orders.repair_cost is
  'Dollars spent fixing this issue (parts + labor + outside vendor). Drives repair-vs-replace logic in maintenance-ml.ts.';
comment on column work_orders.parts_used is
  'Free-text list of parts/supplies consumed. Populated automatically when the resolve flow deducts from inventory.';

-- 2. preventive_tasks.equipment_id ────────────────────────────────────────
alter table preventive_tasks
  add column if not exists equipment_id uuid references equipment(id) on delete set null;

create index if not exists preventive_tasks_equipment_idx
  on preventive_tasks (equipment_id)
  where equipment_id is not null;

comment on column preventive_tasks.equipment_id is
  'Optional link to the equipment asset this PM applies to. Lets the AI suggest an optimal pm_interval_days based on the asset''s failure history.';

-- 3. Track migration
insert into applied_migrations (version, description)
values ('0030', 'work_orders + preventive_tasks linked to equipment; work_orders repair_cost + parts_used')
on conflict (version) do nothing;
