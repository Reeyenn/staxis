-- ═══════════════════════════════════════════════════════════════════════════
-- 0200 — Tenant-isolation hardening: explicit deny policies + close
--        pull_metrics / scraper_session RLS gap.
--
-- Why this exists:
--   The audit (claude/supabase-rls-20260522) found two distinct issues:
--
--   A. SEVEN tables had RLS enabled but ZERO policies. Postgres deny-by-
--      default already protects them today (no policy under RLS = deny all
--      non-service-role), but the intent isn't documented at the DB level
--      and a future migration that mistakenly adds a permissive policy
--      could open them up without a clear signal.
--
--   B. TWO tables (pull_metrics, scraper_session — created in 0011) never
--      had `enable row level security` applied. By Supabase's default
--      grants, the `anon` role can `select` from them via PostgREST. For
--      pull_metrics that exposes operational latency data (low impact);
--      for scraper_session that exposes **Playwright storage state**
--      (cookies + localStorage from the Choice Advantage PMS scraper
--      login). The blob is enough to replay the scraper's authenticated
--      session against the customer's PMS — genuine credential material.
--      No incident known; the table is keyed by property_id and the anon
--      key + project URL are public, so an internet caller could pull it.
--
--   Behavior change after applying:
--     - For the 7 RLS-on-no-policy tables: NONE. Service-role bypasses
--       RLS unchanged; anon/authenticated were already denied (RLS on +
--       no policy = deny). The new explicit policies just codify intent.
--     - For pull_metrics + scraper_session: anon/authenticated can no
--       longer SELECT or write. Service-role (the scraper, the doctor's
--       observability queries) is unaffected. Closes the real gap.
--
-- Policy pattern follows accounts_deny_writes (0017) and the
-- *_deny_browser pattern from 0018/0019/0020/0031/0035/0042/0139:
--
--   create policy "<table>_deny_all_browser" on <table>
--     for all to anon, authenticated using (false) with check (false);
--
-- The policy is PERMISSIVE (Postgres default). PERMISSIVE policies are
-- OR-ed together — so a future migration that adds a legitimate
-- `for select to authenticated using (auth.uid() = ...)` would OR with
-- `false`, producing `auth.uid() = ...` (correct). Never silently
-- overrides a legitimate grant.
--
-- Idempotent: `drop policy if exists` + `create policy`. Safe to re-run.
-- Manual prod apply: per project_migration_application_manual.md,
-- Reeyen applies migrations to prod manually. doctor's
-- supabase_migrations_applied check is the safety net.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Part A: explicit deny policies on RLS-on-no-policy tables ────────────

-- agent_eval_baselines (0100) — agent performance benchmarks, fleet-only.
drop policy if exists agent_eval_baselines_deny_all_browser on public.agent_eval_baselines;
create policy agent_eval_baselines_deny_all_browser
  on public.agent_eval_baselines
  for all to anon, authenticated
  using (false) with check (false);
comment on policy agent_eval_baselines_deny_all_browser on public.agent_eval_baselines is
  'Service-role only. anon/authenticated denied. Codifies the deny-by-default that already exists (RLS on + no policy = deny). Audit 2026-05-22.';

-- agent_prompts (0102) — agent LLM prompt templates, fleet-only config.
drop policy if exists agent_prompts_deny_all_browser on public.agent_prompts;
create policy agent_prompts_deny_all_browser
  on public.agent_prompts
  for all to anon, authenticated
  using (false) with check (false);
comment on policy agent_prompts_deny_all_browser on public.agent_prompts is
  'Service-role only. anon/authenticated denied. Codifies deny-by-default. Audit 2026-05-22.';

-- agent_conversations_archived (0105) — archival of agent conversations.
drop policy if exists agent_conversations_archived_deny_all_browser on public.agent_conversations_archived;
create policy agent_conversations_archived_deny_all_browser
  on public.agent_conversations_archived
  for all to anon, authenticated
  using (false) with check (false);
comment on policy agent_conversations_archived_deny_all_browser on public.agent_conversations_archived is
  'Service-role only. anon/authenticated denied. Archive table — restored via service-role on demand. Audit 2026-05-22.';

-- agent_messages_archived (0105) — archival of agent messages.
drop policy if exists agent_messages_archived_deny_all_browser on public.agent_messages_archived;
create policy agent_messages_archived_deny_all_browser
  on public.agent_messages_archived
  for all to anon, authenticated
  using (false) with check (false);
comment on policy agent_messages_archived_deny_all_browser on public.agent_messages_archived is
  'Service-role only. anon/authenticated denied. Archive table. Audit 2026-05-22.';

-- agent_voice_sessions (0143) — server-resolved voice identity nonce.
-- The id is a capability token; non-admin read = forged session minting.
drop policy if exists agent_voice_sessions_deny_all_browser on public.agent_voice_sessions;
create policy agent_voice_sessions_deny_all_browser
  on public.agent_voice_sessions
  for all to anon, authenticated
  using (false) with check (false);
comment on policy agent_voice_sessions_deny_all_browser on public.agent_voice_sessions is
  'Service-role only. anon/authenticated denied. id is a capability token — exposing this table = voice-identity-forgery escape (closed by 0143). Audit 2026-05-22.';

-- error_logs (0001) — application error stream. Sensitive: stack traces,
-- request paths, sometimes user identifiers. Service-role-readable only.
drop policy if exists error_logs_deny_all_browser on public.error_logs;
create policy error_logs_deny_all_browser
  on public.error_logs
  for all to anon, authenticated
  using (false) with check (false);
comment on policy error_logs_deny_all_browser on public.error_logs is
  'Service-role only. anon/authenticated denied. Error stream — reads via /api/admin/errors. Audit 2026-05-22.';

-- webhook_log (0001) — inbound Twilio SMS payloads.
drop policy if exists webhook_log_deny_all_browser on public.webhook_log;
create policy webhook_log_deny_all_browser
  on public.webhook_log
  for all to anon, authenticated
  using (false) with check (false);
comment on policy webhook_log_deny_all_browser on public.webhook_log is
  'Service-role only. anon/authenticated denied. Twilio inbound payloads — reads via /api/admin/webhooks. Audit 2026-05-22.';

-- ─── Part B: close the pull_metrics / scraper_session RLS gap ────────────
--
-- Both tables were created in 0011 without `enable row level security`,
-- which combined with Supabase's default grants meant `anon` could SELECT
-- them via PostgREST. For scraper_session that means PMS login cookies
-- were readable by anyone with the public anon key (i.e., the entire
-- internet). Enable RLS, revoke unnecessary grants, add deny-browser
-- policies matching the api_limits (0008) pattern.

-- pull_metrics: enable RLS + revoke + deny policy.
alter table public.pull_metrics enable row level security;
revoke all on public.pull_metrics from public, anon, authenticated;
grant select, insert, update, delete on public.pull_metrics to service_role;
drop policy if exists pull_metrics_deny_all_browser on public.pull_metrics;
create policy pull_metrics_deny_all_browser
  on public.pull_metrics
  for all to anon, authenticated
  using (false) with check (false);
comment on policy pull_metrics_deny_all_browser on public.pull_metrics is
  'Service-role only. Written by Railway scraper, read by /api/admin/scraper-metrics. Pre-0200 the table had no RLS; anon could SELECT via PostgREST. Audit 2026-05-22.';

-- scraper_session: enable RLS + revoke + deny policy.
-- HIGH-PRIORITY FIX: the `state` jsonb column is Playwright storageState
-- (cookies + localStorage from Choice Advantage). Pre-0200, anon could
-- read this via PostgREST and replay the scraper's authenticated session
-- against the customer's PMS.
alter table public.scraper_session enable row level security;
revoke all on public.scraper_session from public, anon, authenticated;
grant select, insert, update, delete on public.scraper_session to service_role;
drop policy if exists scraper_session_deny_all_browser on public.scraper_session;
create policy scraper_session_deny_all_browser
  on public.scraper_session
  for all to anon, authenticated
  using (false) with check (false);
comment on policy scraper_session_deny_all_browser on public.scraper_session is
  'Service-role only. Contains Playwright storageState (PMS login cookies + localStorage). Pre-0200 the table had no RLS; anon could read login material via PostgREST — closed here. Audit 2026-05-22.';

-- ─── Part C: doctor-readable view for policy coverage ───────────────────
--
-- The existing pg_tables_rls_status view (0004) tells the doctor whether
-- RLS is *enabled* on a table. It does NOT tell us whether the table has
-- at least one policy — which is the second half of the RLS contract.
-- Without a policy + RLS enabled, the table is effectively deny-all (which
-- is correct for the 7 service-role-only tables this migration is
-- declaring explicit policies for). For tenant-scoped tables we want to
-- *positively* verify a policy exists. Add a view that exposes the join.
--
-- Mirrors pg_tables_rls_status' contract: locked to authenticated +
-- service_role, runs against pg_catalog.

drop view if exists public.pg_tables_policy_coverage;
create view public.pg_tables_policy_coverage as
  select
    c.relname                          as tablename,
    n.nspname                          as schemaname,
    c.relrowsecurity                   as rls_enabled,
    coalesce(policy_counts.n, 0)       as policy_count,
    -- True iff the table has at least one column whose name matches a
    -- tenant identifier (property_id, account_id, etc.).
    exists (
      select 1 from pg_attribute a
      where a.attrelid = c.oid
        and a.attnum > 0
        and not a.attisdropped
        and a.attname in (
          'property_id', 'account_id', 'data_user_id',
          'user_id', 'staff_id', 'hotel_id'
        )
    )                                  as has_tenant_column
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join (
    select schemaname, tablename, count(*)::int as n
    from pg_policies
    group by schemaname, tablename
  ) policy_counts
    on policy_counts.schemaname = n.nspname
   and policy_counts.tablename  = c.relname
  where c.relkind = 'r'
    and n.nspname = 'public';

revoke all on public.pg_tables_policy_coverage from public;
grant select on public.pg_tables_policy_coverage to authenticated;

comment on view public.pg_tables_policy_coverage is
  'Per-table RLS + policy state for the public schema. has_tenant_column flags tables with property_id/account_id/etc. Read by /api/admin/doctor rls_policy_coverage_live check.';

-- ─── Track the migration ─────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values (
  '0200',
  'Tenant-isolation hardening: explicit deny policies on 7 RLS-on-no-policy tables; close pull_metrics + scraper_session RLS gap; add pg_tables_policy_coverage view for doctor'
)
on conflict (version) do nothing;

-- ─── PostgREST schema reload ─────────────────────────────────────────────
-- Policy-only changes don't strictly require a schema reload, but the
-- ALTER TABLE ... ENABLE ROW LEVEL SECURITY and CREATE VIEW do. Following
-- repo convention to be safe.
notify pgrst, 'reload schema';
