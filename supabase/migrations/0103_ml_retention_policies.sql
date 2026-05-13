-- Migration 0103: retention policies for high-volume ML observation tables.
-- (Renumbered from 0100 because the parallel agent-layer Claude session
--  shipped 0100–0102 first. Migration numbers are first-write-wins
--  against applied_migrations.)
--
-- Codex post-merge review (2026-05-13) Phase 3.6: at fleet scale
-- (50 hotels × 50 items × daily predictions × 5 years) prediction_log
-- alone is ~4.5M rows. None of these tables had retention. Auto-rollback
-- (Wilcoxon) only needs the last 14 days; cockpit MAE charts need ~1
-- year. agent_costs is captured in the monthly Anthropic invoice for
-- billing audit, so 90 days locally is plenty.
--
-- Behavioral migration: doesn't add columns or indexes. The actual deletes
-- run from /api/cron/ml-retention-purge (lands in the same PR). The
-- comments below are the contract — if you change retention, update both
-- here AND the RETENTION array in the route.

comment on table public.prediction_log is
  'Prediction-vs-actual log. Retention: 1 year (last 14d for Wilcoxon, '
  'last year for cockpit MAE charts). Daily purge by /api/cron/ml-retention-purge.';

comment on table public.inventory_rate_prediction_history is
  'Historical inventory_rate predictions (pre-decay snapshots). '
  'Retention: 1 year. Daily purge by /api/cron/ml-retention-purge.';

comment on table public.app_events is
  'App events (anomalies, nudges, debug, property_misconfigured). '
  'Retention: 90 days. Daily purge by /api/cron/ml-retention-purge.';

comment on table public.agent_costs is
  'Per-conversation cost ledger. Retention: 90 days. '
  'Source-of-truth for billing reconciliation is the Anthropic invoice; '
  'this table is for in-product cost dashboards only. Daily purge by '
  '/api/cron/ml-retention-purge.';

insert into public.applied_migrations (version, description)
values ('0103', 'Phase 3.6: retention policy contract for prediction_log/app_events/agent_costs (purge cron in /api/cron/ml-retention-purge)')
on conflict (version) do nothing;
