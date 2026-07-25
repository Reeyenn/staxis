-- ═══════════════════════════════════════════════════════════════════════════
-- 0348 — Subtraction: drop what is verified dead, and nothing else
-- ═══════════════════════════════════════════════════════════════════════════
-- A wrong drop is destructive and unrecoverable, so the bar for inclusion here
-- is BOTH conditions, checked individually against the live database and the
-- whole repository:
--
--   • zero rows in production, AND
--   • zero live code references (a comment or an allowlist entry that this
--     migration also removes does not count as a live reference)
--
-- Anything that failed either test is listed at the bottom with the reason,
-- rather than being quietly included.
--
-- The preflight below re-asserts emptiness at APPLY time and refuses to
-- continue otherwise. This plan was written on 2026-07-24; if the world has
-- changed by the time it is applied, the migration must fail loudly rather
-- than destroy whatever arrived in the meantime.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ─── Preflight: nothing in this migration destroys data ──────────────────────
-- Every table in the drop list must still be empty. No exemptions — a table
-- that holds even one row does not belong in this list (see the bottom of the
-- file for the one candidate that was excluded for exactly this reason).

do $$
declare
  tbl   text;
  n     bigint;
  total bigint := 0;
begin
  for tbl in select unnest(array[
    'compliance_anomaly_alerts',
    'compliance_readings',
    'compliance_pm_checks',
    'compliance_pm_tasks',
    'compliance_reading_types',
    'mapping_takeover_steps',
    'sms_jobs',
    'processed_twilio_webhooks',
    'pull_metrics',
    'pms_sync_alert_state',
    'pms_work_orders_v2'   -- not dropped; its voice columns are
  ])
  loop
    if to_regclass('public.' || tbl) is null then
      raise notice '0348 preflight: public.% already absent', tbl;
      continue;
    end if;
    execute format('select count(*) from public.%I', tbl) into n;
    total := total + n;
    if n > 0 then
      raise exception
        '0348 preflight ABORT: public.% holds % row(s). This migration only drops verified-empty tables. Export or re-verify before applying.',
        tbl, n
        using errcode = 'raise_exception';
    end if;
  end loop;
  raise notice '0348 preflight: all drop candidates empty (% rows total)', total;
end $$;

-- ─── The last voice remnants on the pms_* schema ─────────────────────────────
-- The voice feature was removed in a500fa02 / migration 0314. These four
-- objects on pms_work_orders_v2 outlived it. The table is empty and both
-- columns are 100% NULL, verified live.
drop index if exists public.pms_work_orders_v2_voice_session_unique;
drop index if exists public.pms_work_orders_v2_voice_recent_idx;
alter table public.pms_work_orders_v2
  drop column if exists voice_session_id,
  drop column if exists voice_metadata;

-- ─── Drop, in dependency order ───────────────────────────────────────────────
-- Compliance (0229 / 0236). The whole section was deleted from the product in
-- the July reports removal; the only surviving mention anywhere in the repo is
-- one comment in src/lib/reports/catalog/definitions.ts, updated in this change.
drop table if exists public.compliance_anomaly_alerts;
drop table if exists public.compliance_readings;
drop table if exists public.compliance_pm_checks;
drop table if exists public.compliance_pm_tasks;
drop table if exists public.compliance_reading_types;

-- Mapper takeover steps: 0 rows, and zero references of any kind in the repo.
drop table if exists public.mapping_takeover_steps;

-- Twilio leftovers. All texting was removed (the "Twilio FULL removal" change,
-- −9,837 lines). sms_jobs' only mentions are two doctor allowlists; the webhook
-- dedupe table also had a nightly purge cron pointed at it, which this change
-- removes — it has been purging an empty table for a table nothing writes.
drop table if exists public.sms_jobs;
drop table if exists public.processed_twilio_webhooks;

-- Railway-scraper pull metrics (0011). The scraper is gone; the route that read
-- this was already changed to stop querying it because it logged an error every
-- time. Only a stale comment and two migration-source assertions remain.
drop table if exists public.pull_metrics;

-- Dedupe state for a stuck-sync Twilio watchdog that no longer exists (0253).
-- 0 rows and zero references outside its own migration.
drop table if exists public.pms_sync_alert_state;

-- ═══════════════════════════════════════════════════════════════════════════
-- DELIBERATELY NOT DROPPED — each was checked and each failed a test
-- ═══════════════════════════════════════════════════════════════════════════
--
-- agent_voice_sessions — HOLDS 1 ROW. The voice feature is gone, so the row is
--   almost certainly worthless, but "almost certainly" is not a licence to
--   destroy it, and a preflight that refuses to drop non-empty tables cannot
--   make an exception for the one table it wants to drop. It needs a yes/no
--   from the founder, then a two-line migration. Its pms_work_orders_v2
--   columns are dropped above, so nothing on the pms_* schema depends on it.
--
-- Alive-but-pointed-at-a-dead-robot (verified live callers, in 30+ files):
--   property_sessions, workflow_jobs, scraper_session, scraper_credentials,
--   pms_sync_echo, pms_writeback_recipes, mapping_notes, mapping_feed_captures,
--   mapping_help_requests, pull_jobs.
--   Dropping these breaks the live /admin mapper and onboarding surfaces.
--   Retiring them is a code-deletion project — the CUA retirement workstream —
--   not a schema reshape.
--
-- Live product path with no data yet (0 rows, real writers):
--   hk_assignments and cleaning_tasks are written by
--   src/lib/auto-assign-runner.ts and read by /api/housekeeping/*;
--   plan_snapshots is written by the seal-daily cron and read by the ML
--   service. Empty because the feature is new, not because it is dead. Whether
--   to keep them is a product decision, not a cleanup.
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.applied_migrations (version, description)
values (
  '0348',
  'Drop 10 verified-dead tables (compliance x5, mapping_takeover_steps, sms_jobs, processed_twilio_webhooks, pull_metrics, pms_sync_alert_state) and the last voice remnants on pms_work_orders_v2, behind a preflight that refuses to drop a table holding rows'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
