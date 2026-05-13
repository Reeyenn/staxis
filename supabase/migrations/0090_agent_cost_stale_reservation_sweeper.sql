-- Migration 0090: stuck-reservation sweeper for agent_costs
--
-- (Originally drafted as 0084 in this branch; renumbered to 0090 because
-- 0084-0089 were claimed by a parallel ai-stack net-new-fixes commit
-- cbc4228 that landed on main while round-5 was in flight.)
--
-- Codex round-5 adversarial review (2026-05-13) flagged that 'reserved'
-- rows can be stranded indefinitely when finalize AND cancel both fail
-- (transient Supabase outage, server crash mid-request, etc.). Stranded
-- rows are bad because:
--   1. They inflate cap checks — the reservation RPC sums BOTH
--      'reserved' and 'finalized' state for the daily-cap math, so a
--      $1.99 stranded hold permanently shrinks the user's daily budget.
--   2. They are invisible to /admin/agent — the metrics route filters
--      to state='finalized'.
--   3. They have no TTL.
--
-- This migration adds:
--   1. staxis_sweep_stale_reservations — cancels reservations older
--      than `p_max_age_minutes` (default 5) that are still in 'reserved'
--      state. Run periodically via Vercel cron.
--   2. staxis_count_stale_reservations — operator-facing count used by
--      /admin/agent to surface stuck-reservation pressure.

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

  -- Capture the oldest stuck reservation's age BEFORE sweeping so the
  -- operator dashboard has a "how long was it stuck" signal even on a
  -- successful sweep run.
  select extract(epoch from (now() - min(created_at)))::integer
    into v_oldest_age
    from public.agent_costs
    where state = 'reserved'
      and created_at < v_cutoff;

  with swept as (
    update public.agent_costs
    set state = 'finalized',
        cost_usd = 0
    where state = 'reserved'
      and created_at < v_cutoff
    returning id
  )
  select count(*)::integer into v_swept from swept;

  return query select v_swept, coalesce(v_oldest_age, 0);
end;
$$;

comment on function public.staxis_sweep_stale_reservations(integer) is
  'Cancel agent_costs reservations older than p_max_age_minutes that are still in ''reserved'' state. Run periodically to recover from finalize+cancel double failures. Codex round-5 fix, 2026-05-13.';

create or replace function public.staxis_count_stale_reservations(
  p_max_age_minutes integer default 5
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_cutoff timestamptz;
  v_count integer;
begin
  v_cutoff := now() - make_interval(mins => p_max_age_minutes);
  select count(*)::integer
    into v_count
    from public.agent_costs
    where state = 'reserved'
      and created_at < v_cutoff;
  return coalesce(v_count, 0);
end;
$$;

comment on function public.staxis_count_stale_reservations(integer) is
  'Operator-facing count of stranded reservations older than p_max_age_minutes. Surfaced on /admin/agent so the team sees stuck holds before they squeeze the daily cap. Codex round-5 fix, 2026-05-13.';

revoke execute on function public.staxis_sweep_stale_reservations(integer) from public;
revoke execute on function public.staxis_sweep_stale_reservations(integer) from anon, authenticated;
grant  execute on function public.staxis_sweep_stale_reservations(integer) to   service_role;

revoke execute on function public.staxis_count_stale_reservations(integer) from public;
revoke execute on function public.staxis_count_stale_reservations(integer) from anon, authenticated;
grant  execute on function public.staxis_count_stale_reservations(integer) to   service_role;

insert into public.applied_migrations (version, description)
values ('0090', 'Codex round-5: stale agent_costs reservation sweeper + count')
on conflict (version) do nothing;
