-- ═══════════════════════════════════════════════════════════════════════════
-- 0207b — Plan v7 Phase 2c: claude_usage_log source column.
--
-- Why this exists:
--   The CUA mapper run (Plan v7) for a brand-new PMS family burns
--   $3-10 in Claude tokens before any hotel data flows. That spend
--   is an admin/onboarding cost, NOT an ongoing-ops cost — it should
--   NOT trip the per-hotel $5/day cap on
--   property_sessions.daily_claude_cost_micros.
--
--   Today's pipeline doesn't distinguish: cost-cap.recordSpend
--   bumps the per-hotel counter on every Claude call regardless of
--   source. A mapping run blowing through $7 would auto-pause the
--   hotel's ongoing polling — wrong behavior.
--
--   This migration adds a `source` column to claude_usage_log so
--   each row tags whether it was 'mapping' (mapper-driver), 'workflow'
--   (operator-triggered workflow), 'polling' (session-driver routine),
--   or 'repair' (Claude-vision repair of a broken feed).
--
--   The cua-service cost-cap.ts (Plan v7 Phase 2c change) reads the
--   source when recording spend; if source='mapping' it logs to
--   claude_usage_log for audit but DOES NOT bump the per-hotel
--   property_sessions counter. Admin UI splits "today's ops cost"
--   from "lifetime mapper cost" on the property-sessions view.
--
-- Codex v2 P2-COST-ATTRIBUTION finding.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.claude_usage_log
  add column if not exists source text not null default 'polling'
  check (source in ('mapping', 'workflow', 'polling', 'repair', 'other'));

comment on column public.claude_usage_log.source is
  'Plan v7 — categorizes Claude spend so mapping-only runs don''t trip the per-hotel daily cap. Set by cua-service helpers based on the calling subsystem. Default polling covers any caller that hasn''t been migrated yet.';

-- Backfill: rows logged from the mapper workload should be 'mapping'.
-- The existing 'workload' column already tags this: 'cua_mapping_login',
-- 'cua_mapping_action', and (post-Phase 2a) 'cua_mapping_drilldown'.
update public.claude_usage_log
  set source = 'mapping'
  where source = 'polling'
    and workload like 'cua_mapping%';

-- Index for the admin UI's "lifetime mapper cost per PMS family" query.
create index if not exists claude_usage_log_source_idx
  on public.claude_usage_log (source, ts desc);

-- ─── Track the migration ─────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values ('0207b', 'Plan v7 Phase 2c: add source column to claude_usage_log so mapper-only spend is separable from per-hotel daily cap. Backfills mapping workload rows.')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
