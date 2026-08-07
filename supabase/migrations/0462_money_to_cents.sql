-- ════════════════════════════════════════════════════════════════════════
-- 0462_money_to_cents.sql — one canonical cents surface for legacy dollar money
-- ════════════════════════════════════════════════════════════════════════
-- Closes the split-brain the 2026-07-22 audit flagged: the legacy inventory
-- ledger (0026/0061-era) plus the labor and asset columns store DOLLARS as
-- `numeric`, while everything built since 0237/0246 stores INTEGER CENTS. The
-- boundary between the two was ~94 hand-coded `* 100` / `/ 100` seams in app
-- code, each an independent chance to miss or double a conversion. That is not
-- theoretical: an unrounded `unit_cost * 100` was live in
-- src/lib/db/inventory-month-closes.ts (fixed in the same change as this
-- migration) and produced fractional "integer cents" for ~9% of real prices,
-- and a shipped 100x display bug once showed 1% of true inventory spend.
--
-- Founder decision (2026-07-22, stands): money is integer cents INTERNALLY;
-- every user-facing display stays dollars.
--
-- ── WHY THESE ARE GENERATED COLUMNS, NOT PLAIN BACKFILLED ONES ───────────
-- The obvious shape is: add `<col>_cents`, backfill `round(<col> * 100)`, then
-- point application writes at the new column. That shape is UNSAFE here, and
-- would have made the split-brain worse rather than better.
--
-- The dollar columns are not written only by TypeScript. Postgres itself
-- writes them, from plpgsql in 0312, 0322, 0324 and 0326 — 191 references in
-- total, including `insert into public.inventory_orders` (0312:952, 0312:1044,
-- 0324:1544, 0324:1558), `insert into public.inventory_discards` (0324:726)
-- and a dozen `update public.inventory` statements. Those are the canonical
-- delivery, correction and month-close write paths.
--
-- So if TypeScript wrote `<col>_cents` while those functions kept writing
-- `<col>`, the two columns would disagree the first time any RPC fired, and
-- nothing would detect it. We would have replaced "~94 places that might
-- convert wrong" with "two columns that silently disagree" — strictly worse.
--
-- Rewriting all 191 plpgsql references is the real fix, but it is a large,
-- separately-reviewable change that has to move with the invariants and
-- constraints those functions enforce.
--
-- `generated always as (round(<col> * 100))::bigint stored` gets the safety
-- benefit now, with no drift possible by construction:
--   • Postgres derives cents on EVERY write, whoever writes it — TypeScript,
--     plpgsql, a trigger, or a manual psql fix. The two can never disagree.
--   • The backfill is the column definition, so it is exact and automatic.
--   • Re-running is a no-op (`add column if not exists`), and there is no
--     separate backfill statement that could double-apply.
--   • Rounding happens in ONE place, in the database, at the one precision
--     that matters. Every read seam now gets the same number.
--   • Old columns are untouched, as required — nothing is dropped or renamed,
--     and every existing constraint, trigger and function keeps working.
--
-- Follow-up (NOT in this migration, deliberately): rewrite the 0312/0322/0324/
-- 0326 plpgsql to write cents directly, then swap these to plain columns and
-- retire the dollar originals. Tracked in the branch summary; do not attempt
-- it in the same change as the read-path cutover.
--
-- ── WHAT IS DELIBERATELY NOT CONVERTED ───────────────────────────────────
-- The AI-spend columns (`agent_messages.cost_usd`, `agent_costs.cost_usd`,
-- `agent_costs_monthly.cost_usd`, `findings_ai_spend.cost_usd` and the rest of
-- the `numeric(10,6)` USD family) are NOT given cents mirrors. They carry
-- SUB-CENT precision on purpose: a single Claude call can cost $0.000123, and
-- rounding that to integer cents would store 0 and silently erase the entire
-- per-call cost ledger. Those columns already have a correct integer
-- convention available (`*_micros`, 1e-6 USD, used by claude_usage_log and
-- property_sessions). Converting them is a different decision with a different
-- unit, and forcing them into cents here would be data loss, not a fix.
--
-- Also untouched: the `_cents` columns that are deliberately `numeric` rather
-- than integer (inventory_opening_adjustments.unit_cost_cents and the
-- month-close snapshot per-unit costs). 0322 documents that a weighted-average
-- per-unit cost legitimately carries fractional cents at 6 dp. Those are
-- already cents and already correct.
--
-- RLS: this migration adds NO policy and changes NO policy. New columns are
-- covered by each table's existing policies automatically.
--
-- Locking note: adding a STORED generated column rewrites the table under an
-- ACCESS EXCLUSIVE lock. At current scale (one live hotel; these tables are
-- thousands of rows at most) this is sub-second. Apply during a quiet window
-- anyway, and apply BEFORE pushing the code that reads the new columns.
-- ════════════════════════════════════════════════════════════════════════

-- ── Inventory item master ────────────────────────────────────────────────
alter table public.inventory
  add column if not exists unit_cost_cents bigint
    generated always as (round(unit_cost * 100)::bigint) stored,
  add column if not exists opening_adjustment_unit_cost_cents bigint
    generated always as (round(opening_adjustment_unit_cost * 100)::bigint) stored,
  add column if not exists delivery_baseline_unit_cost_cents bigint
    generated always as (round(delivery_baseline_unit_cost * 100)::bigint) stored;

comment on column public.inventory.unit_cost_cents is
  'Integer cents mirror of unit_cost, derived by Postgres. Canonical READ surface for money; unit_cost remains the write target until the 0312/0322/0324/0326 plpgsql write paths are converted.';

-- ── Inventory counts (variance valuation) ────────────────────────────────
alter table public.inventory_counts
  add column if not exists unit_cost_cents bigint
    generated always as (round(unit_cost * 100)::bigint) stored,
  add column if not exists variance_value_cents bigint
    generated always as (round(variance_value * 100)::bigint) stored;

-- ── Inventory restock ledger (the 0246 "stays DOLLARS" table) ────────────
alter table public.inventory_orders
  add column if not exists unit_cost_cents bigint
    generated always as (round(unit_cost * 100)::bigint) stored,
  add column if not exists total_cost_cents bigint
    generated always as (round(total_cost * 100)::bigint) stored;

comment on column public.inventory_orders.total_cost_cents is
  'Integer cents mirror of total_cost. "Spend this month" should sum THIS column, not total_cost, so the sum is exact rather than a float accumulation.';

-- ── Inventory discards (shrinkage valuation) ─────────────────────────────
alter table public.inventory_discards
  add column if not exists unit_cost_cents bigint
    generated always as (round(unit_cost * 100)::bigint) stored,
  add column if not exists cost_value_cents bigint
    generated always as (round(cost_value * 100)::bigint) stored;

-- ── Inventory reconciliations (unaccounted variance valuation) ───────────
alter table public.inventory_reconciliations
  add column if not exists unit_cost_cents bigint
    generated always as (round(unit_cost * 100)::bigint) stored,
  add column if not exists unaccounted_variance_value_cents bigint
    generated always as (round(unaccounted_variance_value * 100)::bigint) stored;

-- ── Inventory delivery corrections (before/after audit trail) ────────────
alter table public.inventory_delivery_corrections
  add column if not exists previous_unit_cost_cents bigint
    generated always as (round(previous_unit_cost * 100)::bigint) stored,
  add column if not exists previous_total_cost_cents bigint
    generated always as (round(previous_total_cost * 100)::bigint) stored,
  add column if not exists corrected_unit_cost_cents bigint
    generated always as (round(corrected_unit_cost * 100)::bigint) stored,
  add column if not exists corrected_total_cost_cents bigint
    generated always as (round(corrected_total_cost * 100)::bigint) stored;

-- ── Labor: property defaults ─────────────────────────────────────────────
-- staff.hourly_wage had THREE independent hand-coded dollars->cents boundaries
-- (labor-cost.ts:193, api/settings/wages/route.ts:161,
-- api/housekeeping/forecast/route.ts:379), one of which carried a comment
-- claiming to be the only one. They now all read the derived column instead.
alter table public.properties
  add column if not exists hourly_wage_cents bigint
    generated always as (round(hourly_wage * 100)::bigint) stored,
  add column if not exists weekly_budget_cents bigint
    generated always as (round(weekly_budget * 100)::bigint) stored;

alter table public.staff
  add column if not exists hourly_wage_cents bigint
    generated always as (round(hourly_wage * 100)::bigint) stored;

comment on column public.staff.hourly_wage_cents is
  'Integer cents mirror of hourly_wage. Third fallback in the 0245 wage chain (labor_wage_settings.hourly_wage_cents wins). Read this rather than multiplying hourly_wage by 100 at the call site.';

-- ── Labor: daily log rollups ─────────────────────────────────────────────
alter table public.daily_logs
  add column if not exists hourly_wage_cents bigint
    generated always as (round(hourly_wage * 100)::bigint) stored,
  add column if not exists labor_cost_cents bigint
    generated always as (round(labor_cost * 100)::bigint) stored,
  add column if not exists labor_saved_cents bigint
    generated always as (round(labor_saved * 100)::bigint) stored;

-- ── Assets: work orders and equipment ────────────────────────────────────
-- work_orders.repair_cost was read as raw DOLLARS by the agent query tools and
-- as cents-after-conversion by findings/feeds.ts. Both now read _cents.
alter table public.work_orders
  add column if not exists repair_cost_cents bigint
    generated always as (round(repair_cost * 100)::bigint) stored;

alter table public.equipment
  add column if not exists purchase_cost_cents bigint
    generated always as (round(purchase_cost * 100)::bigint) stored,
  add column if not exists replacement_cost_cents bigint
    generated always as (round(replacement_cost * 100)::bigint) stored;

-- PostgREST caches the schema; new columns are invisible to the API until it
-- reloads. Run after applying (or hit /api/admin/doctor with auth).
notify pgrst, 'reload schema';
