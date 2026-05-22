-- ═══════════════════════════════════════════════════════════════════════════
-- Staxis / HotelOps AI — prediction_log natural key + date index (Migration 0157)
--
-- Phase 7 v2 (2026-05-22). Enables the statistical auto-rollback pipeline by
-- making the prediction_log table support UPSERT-style rewriting of rows
-- when cleaning_events status flips (recorded → approved / flagged / discarded)
-- AFTER the initial backfill. Without these, the rolling-actual correction
-- window can't fix stale prediction_log rows, and the rollback math falsely
-- triggers on yesterday's pre-approval data.
--
-- TWO additions:
--   1. Natural unique key on (property_id, layer, prediction_id, model_run_id)
--      so the backfill writer can `INSERT ... ON CONFLICT (...) DO UPDATE SET
--      actual_value = EXCLUDED.actual_value`. The generated `abs_error` STORED
--      column (defined in migration 0021) recomputes automatically on UPDATE.
--   2. Date index on (property_id, layer, date) so the rolling 28-day window
--      query in compute_rolling_mae_vs_baseline (ml-service/src/monitoring/
--      shadow_mae.py) doesn't scan the logged_at index and filter in Python.
--      At ~3000 rows/day fleet-wide the index pays for itself within ~3 months.
--
-- RLS unchanged (existing "owner read prediction_log" policy from migration
-- 0021 is fully compatible — indexes don't affect row-level security). No
-- column changes, no table changes. Reversible via DROP INDEX.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Natural unique key — one row per (property, layer, original prediction,
-- model run). The backfill UPSERTs against this key so a re-run within the
-- 3-day correction window updates the existing row rather than duplicating.
create unique index if not exists prediction_log_natural_key_idx
  on prediction_log (property_id, layer, prediction_id, model_run_id);

-- 2. Date index. The rolling-MAE check filters by (property, layer, date)
-- in a 28-day window. Without this, supabase-py composes a query that
-- relies on the (property_id, layer, logged_at desc) index then filters
-- the date column in PostgREST.
create index if not exists prediction_log_property_layer_date_idx
  on prediction_log (property_id, layer, date);

insert into public.applied_migrations (version, description)
values ('0157', 'Phase 7 v2: prediction_log natural unique key + (property, layer, date) index for safe UPSERT and rolling-MAE queries')
on conflict (version) do nothing;
