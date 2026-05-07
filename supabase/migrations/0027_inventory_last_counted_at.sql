-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0027: inventory.last_counted_at
--
-- Why this exists
-- ─────────────────────────────────────────────────────────────────────────
-- The 0026 inventory intelligence rollout used `updated_at` as the
-- "last counted" timestamp. But `updated_at` is a Postgres-level touch
-- column — it bumps on EVERY update, including changes to vendor,
-- lead_days, usage rates, unit cost, etc. As soon as a user opens the
-- new "Configure Usage Rates" panel and saves, every touched item's
-- updated_at jumps to "Just now", which makes:
--
--   • the occupancy window for estimated stock collapse to 0 → estimates
--     flatten to "current stock unchanged"
--   • the "Last counted" UI lie: items show "Just now" even though no
--     human counted anything
--
-- Fix: track last_counted_at separately. Only stamp it when current_stock
-- actually changes (i.e., when the user runs Count Mode or types a new
-- "In stock" value in the edit modal). Everything else leaves it alone.
--
-- Backfill: set last_counted_at = updated_at for every existing row, so
-- pre-existing data keeps its timestamp signal.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Schema change ────────────────────────────────────────────────────────
alter table inventory
  add column if not exists last_counted_at timestamptz;

comment on column inventory.last_counted_at is
  'When current_stock was last manually changed by a count or stock entry. Stamped server-side from the data-access layer when current_stock is in the update payload. Used by the inventory page to show "Last counted" and as the start of the occupancy window for the estimated-stock calculation. Distinct from updated_at, which bumps on every column change.';

-- 2. Backfill ─────────────────────────────────────────────────────────────
-- Conservative: assume previous updated_at WAS the last count time
-- (for most rows that's true). Only fills nulls so re-running is safe.
update inventory
   set last_counted_at = updated_at
 where last_counted_at is null;

-- 3. Track migration ──────────────────────────────────────────────────────
insert into applied_migrations (version, description)
values ('0027', 'inventory.last_counted_at: separate "last counted" from "row updated"')
on conflict (version) do nothing;
