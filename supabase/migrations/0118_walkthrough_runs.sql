-- Migration 0118: walkthrough_runs — server-side lifecycle for AI walkthroughs
--
-- The Clicky-style AI walkthrough overlay had no server concept of a "run" —
-- the client called /api/walkthrough/step repeatedly with no shared state.
-- Codex review (2026-05-14) flagged the consequences:
--   - no rate limit (a buggy client or malicious user could hammer the route)
--   - no enforced step cap (client said max 12; server didn't track)
--   - no concurrent-run dedup (two tabs = double spend, interleaved snapshots)
--   - no telemetry (zero data on completion / failure rates)
--   - property switch mid-walkthrough corrupted state silently
--
-- This table is the canonical "a walkthrough is in progress" row. Three
-- short RPCs enforce the invariants the route cannot enforce alone:
--   staxis_walkthrough_start  — INSERT with unique-active partial index
--   staxis_walkthrough_step   — UPDATE step_count with MAX_STEPS=12 cap
--   staxis_walkthrough_end    — UPDATE status to a terminal state
--
-- Telemetry: /admin/agent can aggregate from this table for completion
-- rate, average step count, common failure modes.

-- ─── Table ────────────────────────────────────────────────────────────

create table if not exists public.walkthrough_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.accounts(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  task text not null check (length(task) between 1 and 200),
  step_count integer not null default 0 check (step_count >= 0 and step_count <= 12),
  status text not null default 'active'
    check (status in ('active', 'done', 'stopped', 'capped', 'errored', 'timeout')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- INV: ended_at non-null iff status != 'active'. Enforced at the DB level
  -- so the heal cron / admin pages can rely on it without code-side guards.
  constraint walkthrough_runs_ended_at_matches_status
    check ((status = 'active' and ended_at is null) or (status != 'active' and ended_at is not null))
);

-- ─── Indexes ───────────────────────────────────────────────────────────

-- Partial unique: only ONE active run per user. This IS the concurrency lock.
-- Second concurrent start from the same user (other tab, retry storm) hits
-- this constraint and the RPC returns null.
create unique index if not exists walkthrough_runs_one_active_per_user
  on public.walkthrough_runs(user_id) where status = 'active';

-- Hot path: count runs per user since dayStart for analytics.
create index if not exists walkthrough_runs_user_started_idx
  on public.walkthrough_runs(user_id, started_at desc);

-- Property-level rollup for /admin/agent.
create index if not exists walkthrough_runs_property_started_idx
  on public.walkthrough_runs(property_id, started_at desc);

-- Stale-active cleanup query — see staxis_walkthrough_heal_stale below.
create index if not exists walkthrough_runs_active_started_idx
  on public.walkthrough_runs(started_at) where status = 'active';

-- ─── RLS ───────────────────────────────────────────────────────────────
-- Users can SELECT their own runs. Routes use supabaseAdmin (service role)
-- to insert/update, so no INSERT/UPDATE policy is needed for ordinary users.
-- This matches the agent_costs pattern from migration 0080.

alter table public.walkthrough_runs enable row level security;

create policy "walkthrough_runs_select_own"
  on public.walkthrough_runs
  for select
  using (
    exists (
      select 1 from public.accounts a
      where a.id = walkthrough_runs.user_id
        and a.data_user_id = auth.uid()
    )
  );

-- ─── RPC: staxis_walkthrough_start ────────────────────────────────────
-- Atomic insert. Returns the new run id, or null if the user already has
-- an active run (the unique partial index prevents the insert; we catch
-- the conflict and return null instead of failing).
--
-- Why a function instead of a plain INSERT from JS: the partial unique
-- index throws on conflict. Catching it in JS is doable but messy; here
-- we squelch it in plpgsql and return a sentinel.

create or replace function public.staxis_walkthrough_start(
  p_user_id uuid,
  p_property_id uuid,
  p_task text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_id uuid;
begin
  -- Defensive: parameters are sanitized by the route, but enforce the same
  -- limits the table check would, so the function fails fast with a clean
  -- message instead of throwing a check_violation.
  if p_task is null or length(trim(p_task)) = 0 then
    raise exception 'task must be non-empty';
  end if;
  if length(p_task) > 200 then
    raise exception 'task exceeds 200 chars';
  end if;

  begin
    insert into public.walkthrough_runs (user_id, property_id, task)
    values (p_user_id, p_property_id, p_task)
    returning id into v_id;
  exception when unique_violation then
    -- The walkthrough_runs_one_active_per_user partial unique index fired.
    return null;
  end;
  return v_id;
end;
$$;

comment on function public.staxis_walkthrough_start is
  'Atomically start a walkthrough run. Returns the new run id, or null if the user already has an active run (concurrency dedup via the partial unique index). 2026-05-14 RC2.';

-- ─── RPC: staxis_walkthrough_step ─────────────────────────────────────
-- Increment step_count atomically. Returns the new count if under MAX_STEPS,
-- or -1 if the cap was hit (route marks the run 'capped' in that case).
-- Returns -1 also when the run doesn't exist or isn't active, so the
-- caller treats either as "step rejected" — the differentiation is
-- visible in /admin/agent if needed.

create or replace function public.staxis_walkthrough_step(
  p_run_id uuid,
  p_expected_property_id uuid default null
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_count integer;
        v_property uuid;
begin
  -- Fetch + lock the row. If property mismatch (the user switched property
  -- mid-walkthrough), reject — the loop should abort, not hop properties.
  select property_id into v_property
    from public.walkthrough_runs
    where id = p_run_id and status = 'active'
    for update;

  if v_property is null then
    return -1;
  end if;

  if p_expected_property_id is not null and v_property != p_expected_property_id then
    -- Property mismatch — return a distinct sentinel so the route can render
    -- a "you switched properties; restarting" message.
    return -2;
  end if;

  update public.walkthrough_runs
    set step_count = step_count + 1
    where id = p_run_id and status = 'active' and step_count < 12
    returning step_count into v_count;

  return coalesce(v_count, -1);
end;
$$;

comment on function public.staxis_walkthrough_step is
  'Atomically increment step_count under the MAX_STEPS=12 cap. Returns the new count, -1 if capped/not-found, or -2 if property mismatch. 2026-05-14 RC2.';

-- ─── RPC: staxis_walkthrough_end ──────────────────────────────────────
-- Mark a run terminal. Idempotent — calling it twice is a no-op on the
-- second call (the WHERE clause requires status='active'). Status must
-- be one of the terminal values; check enforced at the table level.

create or replace function public.staxis_walkthrough_end(
  p_run_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_status not in ('done', 'stopped', 'capped', 'errored', 'timeout') then
    raise exception 'invalid terminal status: %', p_status;
  end if;
  update public.walkthrough_runs
    set status = p_status, ended_at = now()
    where id = p_run_id and status = 'active';
end;
$$;

comment on function public.staxis_walkthrough_end is
  'Close an active walkthrough run with a terminal status. Idempotent (no-op on a non-active run). 2026-05-14 RC2.';

-- ─── RPC: staxis_walkthrough_heal_stale ───────────────────────────────
-- Safety net for orphaned 'active' runs: if /end never fires (network
-- drop, browser crash, dev-server restart mid-step), the partial unique
-- index would block the user from ever starting a new walkthrough. This
-- function closes runs that have been 'active' for > 30 minutes by
-- marking them 'timeout'. Wire up as a cron in a follow-up — for now
-- the function is callable manually from /admin/agent if Reeyen needs
-- to unblock a stuck user.
--
-- Modeled after staxis_heal_conversation_counters from migration 0114.

create or replace function public.staxis_walkthrough_heal_stale(
  p_dry_run boolean default true
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_count integer;
begin
  if p_dry_run then
    select count(*) into v_count
      from public.walkthrough_runs
      where status = 'active' and started_at < now() - interval '30 minutes';
  else
    update public.walkthrough_runs
      set status = 'timeout', ended_at = now()
      where status = 'active' and started_at < now() - interval '30 minutes';
    get diagnostics v_count = row_count;
  end if;
  return v_count;
end;
$$;

comment on function public.staxis_walkthrough_heal_stale is
  'Close walkthrough runs that have been ''active'' for >30 minutes. Use p_dry_run=true to count without modifying. Safety net for orphaned runs when /end never fires. 2026-05-14 RC2.';

-- ─── Telemetry view (for /admin/agent) ────────────────────────────────
-- Per-day rollup of walkthroughs by outcome. Cheap query — single index
-- scan. /admin/agent picks this up via the metrics route.

create or replace view public.walkthrough_runs_daily as
select
  date_trunc('day', started_at)::date as day,
  count(*) filter (where status = 'done')     as completed,
  count(*) filter (where status = 'stopped')  as user_stopped,
  count(*) filter (where status = 'capped')   as hit_step_cap,
  count(*) filter (where status = 'errored')  as errored,
  count(*) filter (where status = 'timeout')  as timed_out,
  count(*) filter (where status = 'active')   as still_active,
  count(*)                                    as total,
  avg(step_count) filter (where status = 'done')::numeric(5, 2) as avg_steps_to_done
from public.walkthrough_runs
group by 1
order by 1 desc;

comment on view public.walkthrough_runs_daily is
  'Per-day outcome breakdown for AI walkthroughs. Drives the /admin/agent walkthrough KPI tile. 2026-05-14 RC2.';

-- ─── Track the migration ──────────────────────────────────────────────

insert into public.applied_migrations (version, description)
values ('0118', 'AI walkthrough: server-side run lifecycle (walkthrough_runs + 4 RPCs + daily view)')
on conflict (version) do nothing;

-- ─── Schema reload notice ─────────────────────────────────────────────
-- Reload PostgREST's schema cache so /api routes see the new table + RPCs
-- immediately. (Required after every DDL change.)

notify pgrst, 'reload schema';
