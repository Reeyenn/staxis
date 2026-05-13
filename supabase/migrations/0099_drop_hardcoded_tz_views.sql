-- Migration 0098: drop the hardcoded-timezone predictions_active_* views
--
-- Codex post-merge review (2026-05-13) Phase 2.5: the three views in
-- migration 0021 (predictions_active_demand, predictions_active_supply,
-- predictions_active_optimizer) hardcode `WHERE date = (CURRENT_DATE
-- AT TIME ZONE 'America/Chicago')` and return empty for any property
-- in a different timezone. They were also load-bearing dead code:
-- `grep -r 'predictions_active_'` across `src/` returns zero hits.
--
-- The right pattern (already in use by the active code paths) is to
-- compute the property's tomorrow date in TS via Intl.DateTimeFormat
-- with the property's timezone, then query the underlying tables with
-- a parameterized `date = $1` filter. See `getActiveOptimizerForTomorrow`
-- in src/lib/ml-schedule-helpers.ts and `tomorrowInTz` helper in
-- src/app/api/cron/ml-run-inference/route.ts for the canonical pattern.
--
-- Anyone needing to revive these views should re-introduce them as
-- per-property variants (function returning a row set) that take a
-- property_id arg and use that property's timezone.

drop view if exists public.predictions_active_demand;
drop view if exists public.predictions_active_supply;
drop view if exists public.predictions_active_optimizer;

insert into public.applied_migrations (version, description)
values ('0099', 'Codex post-merge review: drop hardcoded America/Chicago predictions_active_* views (Phase 2.5)')
on conflict (version) do nothing;
