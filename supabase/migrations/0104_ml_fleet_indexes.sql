-- Migration 0104: fleet-scale composite indexes.
-- (Renumbered from 0101 — agent-layer session shipped 0100–0102 first.)
--
-- Codex post-merge review (2026-05-13) Phase 3.7: four hot-path queries
-- lack the composite indexes they need at fleet scale. Today they
-- seq-scan small Beaumont tables in microseconds; at 50 hotels they'd
-- start to bite.
--
-- IMPORTANT — `create index concurrently` cannot run inside a
-- PL/pgSQL block or a transaction. The Supabase migration runner uses
-- statement-per-line mode (each top-level statement is its own
-- transaction), so each CREATE INDEX below stands alone. If you run
-- this file via `psql -1` you'll need to drop the `concurrently`
-- keyword. The earlier "do $$ ... CREATE INDEX CONCURRENTLY ... $$"
-- pattern errored at apply-time with "CREATE INDEX CONCURRENTLY cannot
-- be executed from a function."
--
-- The `if not exists` guard makes every statement idempotent. The
-- defensive table-exists check the prior version used was nice-to-have
-- but blocked the concurrent path; in practice all four tables exist
-- in every env that gets this migration (they're declared in 0001 +
-- 0021 + 0070).

-- 1. inventory_rate_predictions (property_id, predicted_at desc) — cockpit "current rate per item"
create index concurrently if not exists inv_rate_pred_prop_predicted_idx
  on public.inventory_rate_predictions (property_id, predicted_at desc)
  where is_shadow = false;

-- 2. model_runs (layer, shadow_started_at) — shadow queue scan (auto-rollback path)
create index concurrently if not exists model_runs_shadow_queue_idx
  on public.model_runs (layer, shadow_started_at)
  where is_shadow = true and shadow_promoted_at is null;

-- 3. prediction_log (property_id, layer, date desc) — Wilcoxon shadow MAE
--    The column is `date` (operational date the prediction was for), not
--    `prediction_date` — verified against migration 0021.
create index concurrently if not exists prediction_log_pld_idx
  on public.prediction_log (property_id, layer, date desc);

-- 4. inventory_counts (item_id, counted_at) — backs inventory_observed_rate_v
create index concurrently if not exists inventory_counts_item_counted_idx
  on public.inventory_counts (item_id, counted_at);

insert into public.applied_migrations (version, description)
values ('0104', 'Phase 3.7: fleet-scale composite indexes (non-blocking, idempotent)')
on conflict (version) do nothing;
