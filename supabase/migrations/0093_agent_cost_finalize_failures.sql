-- Migration 0093: audit log for permanent finalize failures
--
-- Codex round-7 adversarial review (2026-05-13) found that when
-- finalizeCostReservation throws (transient Supabase outage etc.),
-- the route's catch path called cancelCostReservation, which set the
-- row to state='finalized' with cost_usd=0. The user already received
-- their response, but Anthropic billed us for the actual spend ($0.05+),
-- and our ledger now shows $0. Operators see a "successful zero-cost"
-- request in the dashboard, hiding the loss.
--
-- Fix F1: finalize is inline-retried 2× with short backoff. If all
-- attempts fail, an audit row goes here so the loss is operator-visible
-- AND the actual usage payload is preserved for later reconciliation.
-- The reservation itself still gets cancelled (releasing the budget
-- hold) so legitimate users aren't locked out by a transient outage.
--
-- This table is append-only. RLS allows admin SELECT for the
-- /admin/agent dashboard's "finalize failures today" KPI.

create table if not exists public.agent_cost_finalize_failures (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null,
  conversation_id uuid,
  user_id uuid not null,
  property_id uuid not null,
  -- Snapshot of the actual usage at the moment finalize gave up. The
  -- canonical agent_costs row gets cost_usd=0 via cancel, so this is
  -- the only place the real cost is recorded.
  actual_cost_usd numeric(10, 6) not null,
  model text,
  model_id text,
  tokens_in integer,
  tokens_out integer,
  cached_input_tokens integer,
  -- Error trail
  attempt_count integer not null default 1,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists agent_cost_finalize_failures_created_idx
  on public.agent_cost_finalize_failures(created_at desc);

create index if not exists agent_cost_finalize_failures_user_idx
  on public.agent_cost_finalize_failures(user_id);

-- RLS: no end-user reads. Service role only (admin reads via supabaseAdmin).
alter table public.agent_cost_finalize_failures enable row level security;

-- Count-today RPC for the dashboard
create or replace function public.staxis_count_finalize_failures_today()
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
    from public.agent_cost_finalize_failures
    where created_at >= date_trunc('day', now() at time zone 'UTC');
  return coalesce(v_count, 0);
end;
$$;

comment on function public.staxis_count_finalize_failures_today() is
  'Count of permanent finalize-RPC failures since UTC midnight. Surfaced on /admin/agent so a recurring Supabase finalize outage is operator-visible instead of hiding as zero-cost successes. Codex round-7 fix F1, 2026-05-13.';

revoke execute on function public.staxis_count_finalize_failures_today() from public;
revoke execute on function public.staxis_count_finalize_failures_today() from anon, authenticated;
grant  execute on function public.staxis_count_finalize_failures_today() to   service_role;

insert into public.applied_migrations (version, description)
values ('0093', 'Codex round-7: agent_cost_finalize_failures audit table + count RPC (F1)')
on conflict (version) do nothing;
