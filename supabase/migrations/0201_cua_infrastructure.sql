-- ═══════════════════════════════════════════════════════════════════════════
-- 0201 — Universal CUA infrastructure tables.
--
-- Why this exists:
--   Plan v4 (mission-plan-a-optimized-torvalds.md) replaces the Railway
--   scraper with a per-hotel persistent Playwright browser running on
--   Fly.io. This migration creates the three support tables that
--   infrastructure needs:
--
--   1. property_sessions
--        One row per hotel. Heartbeat + status + cost-cap tally.
--        Doctor reads this to surface unhealthy sessions; admin UI uses
--        it for /admin/property-sessions; cost cap is enforced against
--        daily_claude_cost_micros + daily_claude_cost_resets_at.
--
--   2. workflow_jobs
--        Generic queue any trigger source (web button, SMS, voice, AI
--        chat) inserts into. The CUA worker picks jobs, runs them via
--        the persistent browser, and writes results back. Specific
--        workflows are NOT defined here — only the contract for the
--        runtime. The `kind` column is free-text so trigger sources
--        can add new workflow types without DB migrations.
--
--   3. pms_knowledge_files
--        Versioned per-PMS-family knowledge ("here's where arrivals
--        live in Choice Advantage"). Shared across all hotels on that
--        family. Knowledge file rollback supported via version +
--        status: a bad Claude-vision repair creates a new draft, and
--        only manual promotion to 'active' makes it live.
--
-- All three tables are SERVICE-ROLE-ONLY:
--   - The CUA worker (cua-service on Fly) reads/writes via service-role.
--   - The web app reads via /api/admin/* routes that use supabaseAdmin.
--   - anon/authenticated denied by deny-all-browser policy, per the
--     pattern established in 0200 and applied to scraper_session.
--
-- Idempotent: `create table if not exists` + `drop policy if exists` +
-- `create policy`. Safe to re-run.
--
-- Manual prod apply: per project_migration_application_manual.md.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── property_sessions ────────────────────────────────────────────────────
--
-- Heartbeat + status + cost-cap state per hotel. One row per property.
-- The CUA worker upserts this every 60s; admin/doctor/cost-cap read it.
--
-- status semantics:
--   - starting:              session-driver booting up, not yet logged in
--   - alive:                 logged in, polling, healthy
--   - paused_cost_cap:       hit $5/day cap, Claude calls paused (browser
--                            still alive, deterministic reads continue),
--                            auto-resume at daily_claude_cost_resets_at
--   - paused_mfa:            MFA prompt hit, waiting for manual re-login
--                            via /admin/mfa-resume/[propertyId]
--   - paused_circuit_breaker: >5 read failures in an hour, paused for
--                            triage
--   - failed_restart:        worker crashed and respawn failed multiple
--                            times; needs operator attention
--   - stopped:               intentionally stopped (admin paused this hotel)

create table if not exists public.property_sessions (
  property_id                    uuid primary key references public.properties(id) on delete cascade,
  pms_family                     text not null,
  status                         text not null default 'starting'
                                 check (status in (
                                   'starting',
                                   'alive',
                                   'paused_cost_cap',
                                   'paused_mfa',
                                   'paused_circuit_breaker',
                                   'failed_restart',
                                   'stopped'
                                 )),
  last_alive_at                  timestamptz,
  last_successful_read_at        timestamptz,
  current_browser_url            text,
  daily_claude_cost_micros       bigint not null default 0
                                 check (daily_claude_cost_micros >= 0),
  daily_claude_cost_resets_at    timestamptz not null default now(),
  paused_reason                  text,
  paused_until                   timestamptz,
  worker_machine_id              text,
  restart_count                  integer not null default 0
                                 check (restart_count >= 0),
  read_failure_streak            integer not null default 0
                                 check (read_failure_streak >= 0),
  notes                          text,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

comment on table public.property_sessions is
  'One row per hotel. CUA worker heartbeat + status + cost-cap tally. Created in 0201.';
comment on column public.property_sessions.daily_claude_cost_micros is
  'Running tally of Claude spend in millionths-of-a-dollar (e.g. $5.00/day cap = 5_000_000). Resets at daily_claude_cost_resets_at (midnight in property local time).';
comment on column public.property_sessions.read_failure_streak is
  'Consecutive failed read attempts. >=3 triggers Claude-vision repair; >=5 trips circuit breaker.';

create index if not exists property_sessions_status_idx
  on public.property_sessions (status);
create index if not exists property_sessions_last_alive_at_idx
  on public.property_sessions (last_alive_at desc);

alter table public.property_sessions enable row level security;
revoke all on public.property_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.property_sessions to service_role;

drop policy if exists property_sessions_deny_all_browser on public.property_sessions;
create policy property_sessions_deny_all_browser
  on public.property_sessions
  for all to anon, authenticated
  using (false) with check (false);
comment on policy property_sessions_deny_all_browser on public.property_sessions is
  'Service-role only. Read by CUA worker + /api/admin/* routes via supabaseAdmin. Created 0201.';

-- Auto-update updated_at trigger.
create or replace function public._set_updated_at_property_sessions()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_updated_at_property_sessions on public.property_sessions;
create trigger set_updated_at_property_sessions
  before update on public.property_sessions
  for each row execute function public._set_updated_at_property_sessions();

-- ─── workflow_jobs ────────────────────────────────────────────────────────
--
-- Generic queue for operator workflows. Any trigger source (web button,
-- SMS, voice, AI chat) inserts a row here; the CUA worker picks the
-- oldest queued job for an alive hotel and runs it. Specific workflows
-- are NOT defined here — `kind` is free-text and `payload` is jsonb so
-- new workflow types can be added without DB migrations.
--
-- Idempotency: (property_id, idempotency_key) is unique. Trigger sources
-- pass a stable key (e.g. "sms:{message_sid}" or "web:{button_id}:{user_id}:{minute_bucket}")
-- so the same logical request triggered twice doesn't double-execute.
--
-- status lifecycle:
--   queued -> running -> completed | failed | cancelled
--   queued/running rows can be cancelled by admin.

create table if not exists public.workflow_jobs (
  id                       uuid primary key default gen_random_uuid(),
  property_id              uuid not null references public.properties(id) on delete cascade,
  kind                     text not null,
  payload                  jsonb not null default '{}'::jsonb,
  status                   text not null default 'queued'
                           check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  idempotency_key          text not null,
  claude_cost_micros       bigint not null default 0
                           check (claude_cost_micros >= 0),
  attempts                 integer not null default 0
                           check (attempts >= 0),
  max_attempts             integer not null default 3
                           check (max_attempts >= 1),
  error                    text,
  error_detail             jsonb,
  result                   jsonb,
  triggered_by             text,
  worker_machine_id        text,
  created_at               timestamptz not null default now(),
  started_at               timestamptz,
  last_attempt_at          timestamptz,
  completed_at             timestamptz,
  expires_at               timestamptz not null default (now() + interval '7 days'),
  constraint workflow_jobs_idempotency_unique unique (property_id, idempotency_key)
);

comment on table public.workflow_jobs is
  'Generic queue for operator workflows. Triggers insert here; CUA worker picks + runs. Created in 0201.';
comment on column public.workflow_jobs.idempotency_key is
  'Stable key from trigger source. (property_id, idempotency_key) unique — prevents double-execution from duplicate triggers.';
comment on column public.workflow_jobs.expires_at is
  'Auto-cleanup after 7 days. Background job (TBD) deletes rows past this. Not enforced by DB.';

create index if not exists workflow_jobs_queued_property_idx
  on public.workflow_jobs (property_id, created_at)
  where status = 'queued';
create index if not exists workflow_jobs_status_idx
  on public.workflow_jobs (status, created_at desc);
create index if not exists workflow_jobs_kind_idx
  on public.workflow_jobs (kind, created_at desc);

alter table public.workflow_jobs enable row level security;
revoke all on public.workflow_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.workflow_jobs to service_role;

drop policy if exists workflow_jobs_deny_all_browser on public.workflow_jobs;
create policy workflow_jobs_deny_all_browser
  on public.workflow_jobs
  for all to anon, authenticated
  using (false) with check (false);
comment on policy workflow_jobs_deny_all_browser on public.workflow_jobs is
  'Service-role only. Inserted by trigger routes via supabaseAdmin; consumed by CUA worker. Created 0201.';

-- ─── pms_knowledge_files ──────────────────────────────────────────────────
--
-- Versioned, per-PMS-family knowledge (where data lives in each PMS).
-- Shared across all hotels on that family — when Claude maps Choice
-- Advantage once, every Comfort Suites uses the same knowledge file.
--
-- Rollback semantics: every new mapping or repair creates a draft. Only
-- explicit promotion to 'active' makes it the canonical version for that
-- family. Old 'active' rows get demoted to 'deprecated' on promotion.
-- If a repair turns out to be wrong, set the bad row to 'quarantined'
-- and promote the previous good version.
--
-- Knowledge schema (jsonb):
--   {
--     "schema": 1,
--     "login": { "startUrl": "...", "steps": [...], "successSelectors": [...] },
--     "feeds": {
--        "arrivals_departures": { "url": "...", "extraction": "csv"|"dom"|"api", ... },
--        "room_status":         { ... },
--        "dashboard_counts":    { ... },
--        "housekeeping":        { ... },
--        "work_orders":         { ... }
--     },
--     "hints": {
--        "dismissDialogs": [ "selector1", "selector2" ],
--        "polling_p95_ms": 8000
--     }
--   }

create table if not exists public.pms_knowledge_files (
  id                       uuid primary key default gen_random_uuid(),
  pms_family               text not null,
  version                  integer not null,
  status                   text not null default 'draft'
                           check (status in ('draft', 'active', 'deprecated', 'quarantined')),
  knowledge                jsonb not null,
  learned_at               timestamptz not null default now(),
  promoted_to_active_at    timestamptz,
  deprecated_at            timestamptz,
  created_by               text not null default 'manual',
  notes                    text,
  created_at               timestamptz not null default now(),
  constraint pms_knowledge_files_family_version_unique unique (pms_family, version)
);

comment on table public.pms_knowledge_files is
  'Versioned per-PMS-family knowledge. Shared across all hotels on that family. Created in 0201.';
comment on column public.pms_knowledge_files.status is
  'draft (Claude just learned), active (canonical for this family), deprecated (replaced), quarantined (known-bad, do not use).';
comment on column public.pms_knowledge_files.created_by is
  'mapper:<model> or manual or human:<email>. Provenance for repair audit.';

create index if not exists pms_knowledge_files_active_idx
  on public.pms_knowledge_files (pms_family)
  where status = 'active';
create index if not exists pms_knowledge_files_family_version_idx
  on public.pms_knowledge_files (pms_family, version desc);

-- Exactly one active row per pms_family — enforced at the DB layer so a
-- racy promotion can't leave two actives. Partial unique index on
-- status='active'.
create unique index if not exists pms_knowledge_files_one_active_per_family
  on public.pms_knowledge_files (pms_family)
  where status = 'active';

alter table public.pms_knowledge_files enable row level security;
revoke all on public.pms_knowledge_files from public, anon, authenticated;
grant select, insert, update, delete on public.pms_knowledge_files to service_role;

drop policy if exists pms_knowledge_files_deny_all_browser on public.pms_knowledge_files;
create policy pms_knowledge_files_deny_all_browser
  on public.pms_knowledge_files
  for all to anon, authenticated
  using (false) with check (false);
comment on policy pms_knowledge_files_deny_all_browser on public.pms_knowledge_files is
  'Service-role only. Read by CUA worker before every session boot; written by mapper + admin promotion route. Created 0201.';

-- ─── Track the migration ─────────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values (
  '0201',
  'Universal CUA infrastructure: property_sessions (heartbeat + cost-cap), workflow_jobs (generic operator queue), pms_knowledge_files (versioned per-PMS knowledge).'
)
on conflict (version) do nothing;

-- ─── PostgREST schema reload ─────────────────────────────────────────────
notify pgrst, 'reload schema';
