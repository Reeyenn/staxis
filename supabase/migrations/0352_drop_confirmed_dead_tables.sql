-- 0352: drop the tables that are verifiably dead, and nothing else.
--
-- WHY
-- 295 migrations and ~240 live tables for a product with one test hotel is
-- what "each addition looked harmless" produces. Dead tables are not free:
-- every one is a surface that has to be RLS-reviewed, allowlisted in the
-- doctor, kept out of a leak, and understood by whoever reads the schema
-- next. Subtracting them is the cheapest permanent win available.
--
-- THE BAR FOR INCLUSION
-- A wrong drop is destructive and unrecoverable, so a table is only listed
-- here when BOTH were checked individually, by hand, against production and
-- against the whole repository:
--
--   1. zero rows in the live database, AND
--   2. zero live code references — nothing in src/, cua-service/,
--      scripts/, tests/ or ml-service/ reads or writes it. A historical
--      comment, a generated entry in src/types/database.types.ts, or an
--      allowlist entry that this same change removes does not count as a
--      live reference.
--
-- Every candidate that failed either test is named at the bottom with the
-- reason, rather than being quietly swept in.
--
-- WHY THE PREFLIGHT
-- This list was verified on 2026-07-25. Migrations are applied by hand, and
-- possibly weeks later. If anything has started writing to one of these
-- tables in the meantime, the correct outcome is a loud failure, not a
-- silent DELETE. The do-block below re-counts every table at APPLY time and
-- aborts the whole transaction if any of them is no longer empty.
--
-- NOT dropped, deliberately: the robot's tables. The PMS robot is being
-- switched OFF, not deleted, and the report pipeline reuses its email inbox.
-- property_sessions, scraper_session, scraper_credentials, pms_auth_codes
-- and pms_inbox_messages all stay.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Preflight A — every table below must still hold zero rows.
-- No exemptions. A table with even one row does not belong in this list.
-- pms_work_orders_v2 is NOT dropped; it appears here because two of its
-- columns are, and dropping a column on a populated table destroys data.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare
  tbl text;
  n   bigint;
begin
  foreach tbl in array array[
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
    'pms_work_orders_v2'
  ]
  loop
    if to_regclass('public.' || tbl) is null then
      raise notice '0352 preflight: public.% already absent — nothing to do', tbl;
      continue;
    end if;
    execute format('select count(*) from public.%I', tbl) into n;
    if n > 0 then
      raise exception
        '0352 preflight ABORT: public.% holds % row(s). This migration only removes verified-empty tables. Re-verify (or export) before applying.',
        tbl, n;
    end if;
    raise notice '0352 preflight: public.% empty — ok', tbl;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Preflight B — agent_voice_sessions, the one deliberate deletion.
--
-- The voice feature was removed from the product (commit a500fa02). One
-- bookkeeping row survived it. The founder confirmed voice is gone, so that
-- row is deleted here explicitly and the count is logged rather than being
-- swallowed by a blanket TRUNCATE.
--
-- The guard: a handful of leftover rows is the expected state, but if this
-- table has grown, something started writing to it after this migration was
-- written — i.e. voice came back — and the drop must fail loudly instead.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare
  n bigint;
begin
  if to_regclass('public.agent_voice_sessions') is null then
    raise notice '0352 preflight: public.agent_voice_sessions already absent';
    return;
  end if;

  select count(*) into n from public.agent_voice_sessions;

  if n > 5 then
    raise exception
      '0352 preflight ABORT: public.agent_voice_sessions holds % row(s), far more than the 1 leftover row this migration was written to remove. Something is writing voice sessions again — re-verify before applying.',
      n;
  end if;

  if n > 0 then
    delete from public.agent_voice_sessions;
    raise notice '0352: deleted % leftover agent_voice_sessions row(s) (voice feature removed in a500fa02)', n;
  else
    raise notice '0352: agent_voice_sessions already empty';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────
-- The last voice remnants on the PMS schema.
--
-- pms_work_orders_v2.voice_session_id carried the only foreign key pointing
-- at agent_voice_sessions, so it has to go first. Both columns are dead
-- plumbing: AgentToolContext.voiceSessionId is declared in
-- src/lib/agent/tools.ts and never assigned or read by anything, and the
-- table is empty. Verified live: no other table references
-- agent_voice_sessions.
-- ─────────────────────────────────────────────────────────────────────────
drop index if exists public.pms_work_orders_v2_voice_session_unique;
drop index if exists public.pms_work_orders_v2_voice_recent_idx;
alter table if exists public.pms_work_orders_v2
  drop column if exists voice_session_id,
  drop column if exists voice_metadata;

drop table if exists public.agent_voice_sessions;

-- ─────────────────────────────────────────────────────────────────────────
-- Compliance (0229 / 0236) — 5 tables.
-- The whole compliance section was deleted from the product in the July
-- reports removal (−5,737 lines). Nothing reads or writes these; the only
-- surviving mention anywhere was one stale comment in
-- src/lib/reports/catalog/definitions.ts, corrected in this change.
-- Dropped children-first so the inbound foreign keys unwind cleanly.
-- ─────────────────────────────────────────────────────────────────────────
drop table if exists public.compliance_anomaly_alerts;
drop table if exists public.compliance_pm_checks;
drop table if exists public.compliance_readings;
drop table if exists public.compliance_pm_tasks;
drop table if exists public.compliance_reading_types;

-- ─────────────────────────────────────────────────────────────────────────
-- mapping_takeover_steps — the per-step log for the manual mapper takeover
-- flow. Zero rows and zero mentions of any kind outside its own migration.
-- (mapper_takeover_sessions, its sibling, still holds rows and is kept.)
-- ─────────────────────────────────────────────────────────────────────────
drop table if exists public.mapping_takeover_steps;

-- ─────────────────────────────────────────────────────────────────────────
-- Twilio leftovers. All texting was removed from the product (−9,837 lines);
-- there is no sender, no webhook and no queue consumer left.
--   sms_jobs                  — outbound SMS queue. Its two claim/reset
--                               helper functions have no callers anywhere,
--                               so they go with it; the updated_at trigger
--                               function is used by this table only.
--   processed_twilio_webhooks — inbound webhook dedupe. Its one remaining
--                               caller was the nightly webhook-dedup-purge
--                               cron, which has been purging an empty table
--                               that nothing writes; that call is removed in
--                               this change.
-- ─────────────────────────────────────────────────────────────────────────
drop table if exists public.sms_jobs;
drop function if exists public.staxis_claim_sms_jobs(integer);
drop function if exists public.staxis_reset_stuck_sms_jobs(integer);
drop function if exists public.touch_sms_jobs_updated_at();

drop table if exists public.processed_twilio_webhooks;

-- ─────────────────────────────────────────────────────────────────────────
-- pull_metrics (0011) — per-pull timing rows from the retired Railway
-- scraper. The one route that read it was already changed to stop querying
-- it because the query logged an error on every request; what is left is a
-- comment and two assertions against migration source text, neither of which
-- touches the table.
-- ─────────────────────────────────────────────────────────────────────────
drop table if exists public.pull_metrics;

-- ─────────────────────────────────────────────────────────────────────────
-- pms_sync_alert_state (0253) — dedupe state for a stuck-sync SMS watchdog
-- that no longer exists. Zero rows, zero references outside its own
-- migration.
-- ─────────────────────────────────────────────────────────────────────────
drop table if exists public.pms_sync_alert_state;

-- ═════════════════════════════════════════════════════════════════════════
-- CHECKED AND DELIBERATELY KEPT — each failed the bar above
-- ═════════════════════════════════════════════════════════════════════════
--
-- Empty, but with live writers (empty because the feature is new or paused,
-- not because it is dead — removing them is a product decision, not cleanup):
--   plan_snapshots      — upserted by the seal-daily cron, read by ml-service
--                         (inference/inventory_rate.py).
--   cleaning_tasks      — written by the auto-assign runner, read by
--   hk_assignments        /api/housekeeping/*. Actively being rebuilt.
--   mapping_notes       — written by cua-service/src/mapper.ts and
--                         /api/admin/mapper/note.
--   pms_sync_echo       — written by cua-service write-back + read by the
--   pms_writeback_recipes generic table writer. Robot: OFF, not deleted.
--
-- Empty and unreferenced, but held back on purpose:
--   pull_jobs           — the pre-v4 pull queue. No code reads it, but four
--                         database functions and a live rollback procedure in
--                         RUNBOOKS.md still target it, and it belongs to the
--                         robot-retirement workstream, not to this cleanup.
--   mapper_job_watchers — zero rows, zero references, but it is mapper
--                         infrastructure and the mapper is still wired up.
--
-- Not empty (so not eligible at all):
--   mapping_feed_captures (30), mapper_takeover_sessions (6), webhook_log (5),
--   mapping_help_requests (4), phone_pairings (4).
-- ═════════════════════════════════════════════════════════════════════════

insert into public.applied_migrations (version, description) values (
  '0352',
  'Drop 11 verified-dead tables (compliance x5, mapping_takeover_steps, sms_jobs, processed_twilio_webhooks, pull_metrics, pms_sync_alert_state, agent_voice_sessions) plus the last voice columns on pms_work_orders_v2 and three orphaned sms_jobs functions, behind a preflight that aborts if any of them is no longer empty'
)
on conflict (version) do nothing;

commit;

-- PostgREST caches the schema; reload it so the dropped relations disappear.
notify pgrst, 'reload schema';

-- Verify after applying (expect 0 rows):
--   select c.relname
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public'
--      and c.relname in (
--        'compliance_anomaly_alerts','compliance_readings','compliance_pm_checks',
--        'compliance_pm_tasks','compliance_reading_types','mapping_takeover_steps',
--        'sms_jobs','processed_twilio_webhooks','pull_metrics',
--        'pms_sync_alert_state','agent_voice_sessions');
