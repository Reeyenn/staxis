-- ═══════════════════════════════════════════════════════════════════════════
-- 0264 — AI Agent Builder · FOUNDATION (Chat 1 of 3)
--
-- Hotels turn on AI "agents" that run operational routines. Every agent =
-- a TRIGGER + what it can SEE (scopes) + what it can DO (actions) + APPROVAL
-- rules. This migration is the data foundation: config, run receipts, and the
-- per-action approval state machine. No UI (Chat 2) and no concrete templates
-- (Chat 3) yet.
--
-- THREE TABLES — all property-scoped, SERVICE-ROLE ONLY (deny-all RLS, mirrors
-- equipment 0249 / financials 0237). Agents act with elevated capability, so
-- ALL access goes through supabaseAdmin in /api/agents/*, /api/cron/agent-tick,
-- and src/lib/agents/engine.ts. anon + authenticated are deny-all.
--
-- RETENTION / PII: agent_runs.inputs_snapshot holds a TRIMMED copy of the
-- gathered scope data (guest first names + arrival info for a turnover agent;
-- guest phone is MINIMIZED — never a full reservation dump). agent_actions
-- describe_en/describe_es + payload may name a room/guest. The agent-tick cron's
-- 90-day retention sweep nulls inputs_snapshot AND redacts agent_actions
-- describe_en/describe_es/payload. A hard 256KB CHECK on inputs_snapshot is the
-- DB backstop against an unbounded write.
--
-- Numbering: the spec reserved 0253, but main's high-water mark is 0261 and
-- prod's applied_migrations is already at 0263 (0262 + 0263 were claimed by the
-- in-flight maintenance-redesign branch's work_orders migrations — applied to
-- prod, not yet merged to main). Next free is 0264. (Existing agent_* tables
-- are conversations/costs/memory/messages/nudges/voice_sessions — the copilot's
-- durable-memory subsystem, deliberately separate. agents / agent_runs /
-- agent_actions are free.)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. agents — property-scoped config (config jsonb is the SINGLE source) ──
-- @rls: service-role-only — all access via supabaseAdmin in /api/agents/*, the
-- agent engine, and /api/cron/agent-tick. Never the anon browser client.
create table if not exists public.agents (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references public.properties(id) on delete cascade,

  name                 text not null,
  description          text,
  template_key         text,                       -- null = fully custom

  -- AgentConfig (versioned): { version, trigger, scopes, actions, approvalRules, templateParams }
  config               jsonb not null default '{}'::jsonb,

  status               text not null default 'draft'
                       check (status in ('draft','active','paused','archived')),

  created_by           uuid references public.accounts(id) on delete set null,

  last_run_at          timestamptz,
  -- DISPLAY hint only. Set at run finalize, never at run start, so a crashed
  -- run leaves the agent still "due" for the reaper-then-retry path.
  last_run_local_date  date,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  check (jsonb_typeof(config) = 'object')
);

comment on table public.agents is
  'AI Agent Builder config (0264). One row per configured agent. config jsonb is the single source of truth (trigger/scopes/actions/approvalRules, versioned). Property-scoped, service-role-only. status archived = soft-delete so run history survives.';

create index if not exists agents_property_status_idx on public.agents (property_id, status);
-- Tick due-scan: active schedule-triggered agents only.
create index if not exists agents_active_schedule_idx
  on public.agents (property_id)
  where status = 'active' and (config -> 'trigger' ->> 'type') = 'schedule';

drop trigger if exists set_updated_at on public.agents;
create trigger set_updated_at before update on public.agents
  for each row execute function public._pms_set_updated_at();

-- ── 2. agent_runs — one row per execution (receipts + approval queue) ───────
-- @rls: service-role-only.
create table if not exists public.agent_runs (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references public.agents(id) on delete cascade,
  property_id       uuid not null references public.properties(id) on delete cascade,

  trigger_source    text not null check (trigger_source in ('scheduled','event','manual','backtest')),
  mode              text not null check (mode in ('live','dry_run')),
  status            text not null default 'running'
                    check (status in ('running','success','failed','awaiting_approval')),

  as_of_date        date,                            -- target day for dry_run/backtest; null for live-now
  run_local_date    date not null,                   -- property-local date this run represents (idempotency)
  triggered_by      uuid references public.accounts(id) on delete set null,  -- user for manual/backtest; null otherwise
  event_id          text,                            -- event idempotency (null unless trigger_source='event')

  inputs_snapshot   jsonb not null default '{}'::jsonb,
  summary           text,                            -- rendered EN, set on every terminal status
  summary_key       text,
  summary_params    jsonb not null default '{}'::jsonb,
  approximations    jsonb not null default '[]'::jsonb,  -- honest dry-run caveats

  error             text,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,

  check (octet_length(inputs_snapshot::text) < 262144)  -- hard 256KB backstop
);

comment on table public.agent_runs is
  'AI Agent Builder run receipts (0264). One row per execution (scheduled/event/manual/backtest, live/dry_run). Service-role-only. inputs_snapshot is trimmed + 90-day-retained.';

create index if not exists agent_runs_agent_started_idx   on public.agent_runs (agent_id, started_at desc);
create index if not exists agent_runs_property_started_idx on public.agent_runs (property_id, started_at desc);
-- Property-wide approval queue (Chat 2 headline surface).
create index if not exists agent_runs_awaiting_idx
  on public.agent_runs (property_id)
  where status = 'awaiting_approval';
-- Tick due-scan EXISTS gate (a run today already?).
create index if not exists agent_runs_due_scan_idx on public.agent_runs (agent_id, run_local_date, status);
-- Double-fire guard, retry-friendly: at most one NON-FAILED live scheduled run
-- per agent per property-local day. A failed (incl. reaped) run frees the slot.
create unique index if not exists agent_runs_sched_live_uniq
  on public.agent_runs (agent_id, run_local_date)
  where mode = 'live' and trigger_source = 'scheduled' and status <> 'failed';
-- Event idempotency: one run per (agent, event id).
create unique index if not exists agent_runs_event_uniq
  on public.agent_runs (agent_id, event_id)
  where event_id is not null;

-- ── 3. agent_actions — run steps / approval state machine ───────────────────
-- @rls: service-role-only.
create table if not exists public.agent_actions (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references public.agent_runs(id) on delete cascade,
  agent_id              uuid not null references public.agents(id) on delete cascade,
  property_id           uuid not null references public.properties(id) on delete cascade,

  action_key            text not null,
  payload               jsonb not null default '{}'::jsonb,
  status                text not null default 'proposed'
                        check (status in ('proposed','pending_approval','approved','rejected','executed','skipped','simulated')),
  result                jsonb,                       -- {ok,...} on execute; describe() on simulate; failure lives here

  describe_key          text,
  describe_params       jsonb not null default '{}'::jsonb,
  describe_en           text,                        -- bilingual inline (action carries EN…
  describe_es           text,                        -- …and ES) — no translations.ts dependency

  spends_money          boolean not null default false,
  contacts_guest        boolean not null default false,

  decided_by            uuid references public.accounts(id) on delete set null,
  decided_at            timestamptz,
  exec_idempotency_key  text,                        -- belt-and-braces side-effect dedup

  created_at            timestamptz not null default now()
);

comment on table public.agent_actions is
  'AI Agent Builder run steps (0264). Approval state machine: proposed | pending_approval | approved | rejected | executed | skipped | simulated. A live executed step with result.ok=false is a soft failure (no separate enum state by design). Service-role-only.';

create index if not exists agent_actions_run_idx on public.agent_actions (run_id, created_at);
create index if not exists agent_actions_pending_idx
  on public.agent_actions (property_id)
  where status = 'pending_approval';
create unique index if not exists agent_actions_exec_idem_uniq
  on public.agent_actions (exec_idempotency_key)
  where exec_idempotency_key is not null;

-- ── 4. RLS — service-role only; anon + authenticated deny-all (×3) ──────────
alter table public.agents       enable row level security;
alter table public.agent_runs   enable row level security;
alter table public.agent_actions enable row level security;

revoke all on public.agents        from public, anon, authenticated;
revoke all on public.agent_runs    from public, anon, authenticated;
revoke all on public.agent_actions from public, anon, authenticated;

grant select, insert, update, delete on public.agents        to service_role;
grant select, insert, update, delete on public.agent_runs    to service_role;
grant select, insert, update, delete on public.agent_actions to service_role;

drop policy if exists agents_deny_all on public.agents;
create policy agents_deny_all on public.agents
  for all to anon, authenticated using (false) with check (false);

drop policy if exists agent_runs_deny_all on public.agent_runs;
create policy agent_runs_deny_all on public.agent_runs
  for all to anon, authenticated using (false) with check (false);

drop policy if exists agent_actions_deny_all on public.agent_actions;
create policy agent_actions_deny_all on public.agent_actions
  for all to anon, authenticated using (false) with check (false);

-- ── 5. Bookkeeping + schema reload ─────────────────────────────────────────
insert into public.applied_migrations (version, description)
values (
  '0264',
  'AI Agent Builder FOUNDATION: agents + agent_runs + agent_actions (service-role deny-all RLS, property-scoped). Engine config (versioned jsonb), run receipts, per-action approval state machine, schedule + event triggers. No UI / no concrete templates (Chat 2/3 build on these contracts).'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
