-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0061: Inventory Hotel-Operator-Reality Layer
--
-- Why this exists
-- ─────────────────────────────────────────────────────────────────────────
-- Two May 2026 customer-research conversations (Tara at Home2 Suites; a
-- regional director over a ~10-hotel portfolio) confirmed inventory is the
-- #1 ask after housekeeping is in its sweet spot. The existing inventory
-- module covers the digital-tracking primitives but misses the
-- hotel-operator-reality layer:
--
--   1. Cases ↔ units math: hotels receive in cases of N (e.g. 3 boxes of 36
--      towels = 108 units). Today GMs do this multiplication by hand.
--   2. Stained / discarded linen as a first-class shrinkage category — Tara
--      tracks this on a separate spreadsheet, with $ loss reported monthly
--      to accounting. The regional director flagged anomaly detection
--      ("hotels claim no losses, then suddenly need a big order").
--   3. Periodic spot-check reconciliation: physical recount vs AI estimate,
--      with $-denominated unaccounted variance. The regional director won't
--      trust pure AI counting without this.
--   4. Per-category monthly budgets: Tara orders against a budget tracked
--      in M3 ("I only have $500 left in linen this month"). Reorder
--      suggestions need to respect that.
--
-- This migration adds the data foundation:
--
--   1. inventory.pack_size       — units per case (null = sold individually)
--      inventory.case_unit       — display label ("case" / "box" / "dozen")
--      inventory_orders.quantity_cases — what was received in case form
--   2. inventory_discards        — stained / damaged / lost / theft / other
--   3. inventory_reconciliations — physical-recount events with variance $
--   4. inventory_budgets         — per-property, per-category, per-month $
--
-- All new tables use the existing user_owns_property RLS pattern.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. inventory pack-size columns ──────────────────────────────────────────
alter table inventory
  add column if not exists pack_size integer;

alter table inventory
  add column if not exists case_unit text;

comment on column inventory.pack_size is
  'Units per case/box. Null = sold individually (no case math). When set, the receiving UI lets the user enter "N cases" and resolves to N * pack_size units.';

comment on column inventory.case_unit is
  'Display label for the pack unit ("case", "box", "dozen", "pack"). Null falls back to "case". Purely cosmetic — pack_size drives the math.';

alter table inventory_orders
  add column if not exists quantity_cases integer;

comment on column inventory_orders.quantity_cases is
  'When the order was placed in case form, the case count is recorded here. inventory_orders.quantity always stores resolved units (cases * pack_size); this column lets us display "received 3 cases (108 units)" later.';

-- 2. inventory_discards ──────────────────────────────────────────────────
-- One row per discard event. Drives shrinkage tracking that's separate from
-- "used through normal consumption" — Tara tracks stained linen on its own
-- spreadsheet today; this is the digital equivalent. Reasons let us bucket:
-- expected loss (stained, damaged) vs unexpected (lost, theft, other).
create table if not exists inventory_discards (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  item_id           uuid not null references inventory(id) on delete cascade,
  item_name         text not null,                       -- snapshotted (survives item delete)
  quantity          integer not null check (quantity > 0),
  reason            text not null check (reason in ('stained','damaged','lost','theft','other')),
  cost_value        numeric,                             -- quantity * unit_cost at discard time
  unit_cost         numeric,                             -- snapshotted unit_cost
  discarded_at      timestamptz not null default now(),
  discarded_by      text,                                -- staff name (optional)
  notes             text,
  created_at        timestamptz not null default now()
);

create index if not exists inventory_discards_property_date_idx
  on inventory_discards (property_id, discarded_at desc);

create index if not exists inventory_discards_item_idx
  on inventory_discards (item_id, discarded_at desc);

comment on table inventory_discards is
  'Append-only log of items removed from inventory outside normal consumption (stained linen, damaged goods, theft, loss). Powers shrinkage tracking and anomaly detection ("you replaced 152 washcloths last month, only 18 this month — investigate?").';

-- 3. inventory_reconciliations ───────────────────────────────────────────
-- One row per reconciliation event. The user enters a physical count, the
-- system snapshots its estimate at that moment, and we compute unaccounted
-- variance:
--   unaccounted_variance = physical_count - (system_estimate - discards_since_last)
-- A negative number means stock vanished without being logged as discard or
-- consumption. The $-impact is what GMs and regional directors care about.
create table if not exists inventory_reconciliations (
  id                          uuid primary key default gen_random_uuid(),
  property_id                 uuid not null references properties(id) on delete cascade,
  item_id                     uuid not null references inventory(id) on delete cascade,
  item_name                   text not null,
  reconciled_at               timestamptz not null default now(),
  physical_count              integer not null check (physical_count >= 0),
  system_estimate             integer not null,
  discards_since_last         integer not null default 0,
  unaccounted_variance        integer not null,          -- physical - (estimate - discards_since_last); negative = unexplained loss
  unaccounted_variance_value  numeric,                   -- variance * unit_cost; null when unit_cost null
  unit_cost                   numeric,                   -- snapshotted
  reconciled_by               text,
  notes                       text,
  created_at                  timestamptz not null default now()
);

create index if not exists inventory_reconciliations_property_date_idx
  on inventory_reconciliations (property_id, reconciled_at desc);

create index if not exists inventory_reconciliations_item_idx
  on inventory_reconciliations (item_id, reconciled_at desc);

comment on table inventory_reconciliations is
  'Periodic physical-count events used to validate the AI estimate and surface unaccounted shrinkage. Powers the trust layer the regional director asked for ("if I count and it''s a couple hundred dollars off, fine; if it''s far apart, find out why").';

-- 4. inventory_budgets ───────────────────────────────────────────────────
-- One row per (property, category, month). Drives the budget headroom badge
-- on Smart Reorder List and the Budget vs Actual block in the accounting
-- view. month_start is always the first of the month for clean aggregation.
create table if not exists inventory_budgets (
  property_id       uuid not null references properties(id) on delete cascade,
  category          text not null check (category in ('housekeeping','maintenance','breakfast')),
  month_start       date not null,                       -- first day of the budget month
  budget_cents      integer not null check (budget_cents >= 0),
  notes             text,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  primary key (property_id, category, month_start)
);

create index if not exists inventory_budgets_property_month_idx
  on inventory_budgets (property_id, month_start desc);

comment on table inventory_budgets is
  'Per-property, per-category, per-month spend budget. Reorder suggestions show remaining budget; the accounting view shows budget vs actual. Editable via the inventory settings UI.';

-- Touch updated_at on edits so the UI shows "last edited 5 minutes ago"
drop trigger if exists inventory_budgets_touch on inventory_budgets;
create trigger inventory_budgets_touch
  before update on inventory_budgets
  for each row execute function touch_updated_at();

-- 5. RLS — owner read/write following the inventory_counts pattern ───────
alter table inventory_discards enable row level security;
drop policy if exists "owner rw inventory_discards" on inventory_discards;
create policy "owner rw inventory_discards"
  on inventory_discards
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

alter table inventory_reconciliations enable row level security;
drop policy if exists "owner rw inventory_reconciliations" on inventory_reconciliations;
create policy "owner rw inventory_reconciliations"
  on inventory_reconciliations
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

alter table inventory_budgets enable row level security;
drop policy if exists "owner rw inventory_budgets" on inventory_budgets;
create policy "owner rw inventory_budgets"
  on inventory_budgets
  for all
  using (user_owns_property(property_id))
  with check (user_owns_property(property_id));

-- 6. Track migration so the doctor stays green ────────────────────────────
insert into applied_migrations (version, description)
values ('0061', 'inventory_packs: pack_size + case_unit + quantity_cases, inventory_discards, inventory_reconciliations, inventory_budgets')
on conflict (version) do nothing;

-- 7. Reload PostgREST schema cache so the new columns/tables are visible
notify pgrst, 'reload schema';
