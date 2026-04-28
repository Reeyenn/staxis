-- ═══════════════════════════════════════════════════════════════════════════
-- 0014 — Allow hk_center_on_demand pull_type in pull_metrics
--
-- Surfaced during the 2026-04-28 end-to-end smoke test: the Railway scraper
-- writes a pull_metrics row after every /scrape/hk-center HTTP call (so the
-- doctor's pull-latency check sees the new pull type), but the existing
-- CHECK constraint on pull_metrics.pull_type only allowed
-- ('csv_morning','csv_evening','dashboard','ooo'). Every HK Center pull
-- failed its metric write with:
--
--   pull_metrics write failed (non-fatal): new row for relation "pull_metrics"
--   violates check constraint "pull_metrics_pull_type_check"
--
-- Non-fatal because writePullMetric is wrapped in `.catch(() => {})` — the
-- pull itself still succeeded — but it means no latency data accumulates
-- for the on-demand pulls and the doctor's future pull-latency-spike check
-- has nothing to compare against.
--
-- Fix: drop the old constraint, recreate it with hk_center_on_demand added.
-- Idempotent for re-runs (constraint name is stable across Postgres versions).
-- ═══════════════════════════════════════════════════════════════════════════

alter table pull_metrics
  drop constraint if exists pull_metrics_pull_type_check;

alter table pull_metrics
  add constraint pull_metrics_pull_type_check
  check (pull_type in (
    'csv_morning',
    'csv_evening',
    'dashboard',
    'ooo',
    'hk_center_on_demand'
  ));

comment on column pull_metrics.pull_type is
  'Which scraper pull this row records. csv_morning/csv_evening = hourly CSV; dashboard = totals (in-house/arrivals/departures); ooo = out-of-order work orders; hk_center_on_demand = Mario clicking "Load Rooms from CSV" (route /api/refresh-from-pms → Railway /scrape/hk-center).';
