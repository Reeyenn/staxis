-- Migration 0091: distinguish swept reservations from real finalized requests
--
-- Codex round-6 adversarial review (2026-05-13) flagged that the sweeper
-- erases recurring failures from the KPI it added. The sweeper UPDATEs
-- stuck rows to state='finalized' with cost_usd=0 — visually identical
-- to a successful zero-cost request. So:
--   1. The "Stuck reservations" KPI (counts state='reserved') drops to
--      zero after each sweep — a recurring finalize+cancel failure mode
--      becomes invisible on /admin/agent.
--   2. The /api/agent/metrics route's spend/cache/model calculations
--      include the swept rows as if they were real requests, inflating
--      request counts and skewing cache-hit math toward zero.
--
-- Fix: add a `swept_at timestamptz` column. The sweeper stamps it on the
-- rows it swept. The metrics route excludes rows with swept_at IS NOT NULL
-- from real-request aggregates and surfaces a separate "Swept today"
-- count so an operator sees recurring failures even after the sweeper
-- has run.

alter table public.agent_costs
  add column if not exists swept_at timestamptz;

create index if not exists agent_costs_swept_at_idx
  on public.agent_costs(swept_at)
  where swept_at is not null;

-- Replace the sweeper RPC so it stamps swept_at on every row it cleans up.
create or replace function public.staxis_sweep_stale_reservations(
  p_max_age_minutes integer default 5
)
returns table(swept_count integer, oldest_age_seconds integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cutoff timestamptz;
  v_swept integer;
  v_oldest_age integer;
begin
  v_cutoff := now() - make_interval(mins => p_max_age_minutes);

  select extract(epoch from (now() - min(created_at)))::integer
    into v_oldest_age
    from public.agent_costs
    where state = 'reserved'
      and created_at < v_cutoff;

  with swept as (
    update public.agent_costs
    set state = 'finalized',
        cost_usd = 0,
        swept_at = now()
    where state = 'reserved'
      and created_at < v_cutoff
    returning id
  )
  select count(*)::integer into v_swept from swept;

  return query select v_swept, coalesce(v_oldest_age, 0);
end;
$$;

comment on function public.staxis_sweep_stale_reservations(integer) is
  'Cancel agent_costs reservations older than p_max_age_minutes. Stamps swept_at so metrics can distinguish recovered-from-failure rows from successful zero-cost requests. Codex round-6 fix, 2026-05-13.';

-- New RPC: count swept-today so /admin/agent surfaces recurring failures.
create or replace function public.staxis_count_swept_today()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  select count(*)::integer
    into v_count
    from public.agent_costs
    where swept_at >= date_trunc('day', now() at time zone 'UTC');
  return coalesce(v_count, 0);
end;
$$;

comment on function public.staxis_count_swept_today() is
  'Count of agent_costs rows swept by the stale-reservation sweeper since UTC midnight. Surfaced on /admin/agent so a recurring finalize+cancel failure mode does not stay invisible after each sweep run. Codex round-6 fix, 2026-05-13.';

revoke execute on function public.staxis_count_swept_today() from public;
revoke execute on function public.staxis_count_swept_today() from anon, authenticated;
grant  execute on function public.staxis_count_swept_today() to   service_role;

insert into public.applied_migrations (version, description)
values ('0091', 'Codex round-6: swept_at column + count_swept_today RPC')
on conflict (version) do nothing;
