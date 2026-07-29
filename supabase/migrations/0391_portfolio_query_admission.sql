-- 0391 — Distributed admission control for Portfolio Intelligence queries.
--
-- Portfolio chat deliberately fans one exact authorization receipt out into
-- hotel-scoped reads.  That structural tenant wall is safe, but without an
-- admission boundary a retry storm can still ask PostgREST to read hundreds of
-- authorized hotels before the later model-cost reservation rejects it.
--
-- This migration provides one atomic, service-role-only operation that:
--   * rate-limits the exact (account, organization) pair before metadata;
--   * permits at most one live portfolio query for that pair across every app
--     process/region; and
--   * uses a bounded lease so a killed server cannot wedge the user forever.
--
-- Rate-limit attempts, including attempts rejected as concurrently busy, are
-- counted.  This prevents a tight retry loop from turning the admission RPC
-- itself into an unbounded database workload.

begin;

-- @rls: service-role-only — distributed rate/concurrency lease state is
-- reachable only through the bounded SECURITY DEFINER admission RPCs below.
create table if not exists public.portfolio_query_admissions (
  account_id uuid not null references public.accounts(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  minute_bucket timestamptz not null,
  minute_count integer not null default 0,
  hour_bucket timestamptz not null,
  hour_count integer not null default 0,

  lease_token uuid,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),

  primary key (account_id, organization_id),
  constraint portfolio_query_admissions_minute_count_check
    check (minute_count >= 0),
  constraint portfolio_query_admissions_hour_count_check
    check (hour_count >= 0),
  constraint portfolio_query_admissions_lease_state_check
    check ((lease_token is null) = (lease_expires_at is null))
);

create unique index if not exists portfolio_query_admissions_live_token_uq
  on public.portfolio_query_admissions (lease_token)
  where lease_token is not null;

alter table public.portfolio_query_admissions enable row level security;
revoke all on public.portfolio_query_admissions from public, anon, authenticated, service_role;

comment on table public.portfolio_query_admissions is
  'Service-only, distributed pre-query rate and concurrency state for the exact account+organization Portfolio Intelligence boundary. No hotel data is stored.';

create or replace function public.staxis_acquire_portfolio_query_lease(
  p_account_id uuid,
  p_organization_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer default 75
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Human chat comfortably fits below these bounds.  The later agent cost
  -- control remains a second, independent 10/minute and dollar-budget gate;
  -- this one exists before any metadata or per-hotel read can happen.
  c_minute_cap constant integer := 10;
  c_hour_cap constant integer := 120;
  v_now timestamptz := clock_timestamp();
  v_minute_bucket timestamptz;
  v_hour_bucket timestamptz;
  v_minute_count integer;
  v_hour_count integer;
  v_lease interval;
  v_row public.portfolio_query_admissions%rowtype;
  v_retry_seconds integer;
begin
  if p_account_id is null
     or p_organization_id is null
     or p_lease_token is null
     or p_lease_seconds is null
  then
    return jsonb_build_object(
      'status', 'invalid',
      'contractVersion', 'portfolio-query-admission.v1'
    );
  end if;

  -- Longer than the 60-second route lifetime, but tightly bounded so a dead
  -- worker self-heals quickly.  Production passes 75 seconds.
  v_lease := make_interval(secs => least(greatest(p_lease_seconds, 65), 120));
  v_minute_bucket := date_trunc('minute', v_now);
  v_hour_bucket := date_trunc('hour', v_now);

  insert into public.portfolio_query_admissions (
    account_id,
    organization_id,
    minute_bucket,
    minute_count,
    hour_bucket,
    hour_count,
    updated_at
  ) values (
    p_account_id,
    p_organization_id,
    v_minute_bucket,
    0,
    v_hour_bucket,
    0,
    v_now
  )
  on conflict (account_id, organization_id) do nothing;

  select * into strict v_row
    from public.portfolio_query_admissions admission
   where admission.account_id = p_account_id
     and admission.organization_id = p_organization_id
   for update;

  -- A response-lost retry using the same unguessable token is idempotent.  It
  -- neither consumes another rate slot nor competes with itself.
  if v_row.lease_token = p_lease_token
     and v_row.lease_expires_at > v_now
  then
    return jsonb_build_object(
      'status', 'admitted',
      'contractVersion', 'portfolio-query-admission.v1',
      'leaseExpiresAt', v_row.lease_expires_at,
      'minuteCount', v_row.minute_count,
      'minuteCap', c_minute_cap,
      'hourCount', v_row.hour_count,
      'hourCap', c_hour_cap
    );
  end if;

  v_minute_count := case
    when v_row.minute_bucket = v_minute_bucket then v_row.minute_count + 1
    else 1
  end;
  v_hour_count := case
    when v_row.hour_bucket = v_hour_bucket then v_row.hour_count + 1
    else 1
  end;

  -- Persist the attempt before either refusal.  The row lock makes the counter
  -- and the lease one serializable decision for this account+organization.
  update public.portfolio_query_admissions
     set minute_bucket = v_minute_bucket,
         minute_count = v_minute_count,
         hour_bucket = v_hour_bucket,
         hour_count = v_hour_count,
         updated_at = v_now
   where account_id = p_account_id
     and organization_id = p_organization_id;

  if v_minute_count > c_minute_cap or v_hour_count > c_hour_cap then
    v_retry_seconds := case
      when v_hour_count > c_hour_cap
        then greatest(1, ceil(extract(epoch from ((v_hour_bucket + interval '1 hour') - v_now)))::integer)
      else greatest(1, ceil(extract(epoch from ((v_minute_bucket + interval '1 minute') - v_now)))::integer)
    end;
    return jsonb_build_object(
      'status', 'rate_limited',
      'contractVersion', 'portfolio-query-admission.v1',
      'retryAfterSeconds', v_retry_seconds,
      'minuteCount', v_minute_count,
      'minuteCap', c_minute_cap,
      'hourCount', v_hour_count,
      'hourCap', c_hour_cap
    );
  end if;

  if v_row.lease_token is not null
     and v_row.lease_expires_at > v_now
  then
    v_retry_seconds := greatest(
      1,
      ceil(extract(epoch from (v_row.lease_expires_at - v_now)))::integer
    );
    return jsonb_build_object(
      'status', 'busy',
      'contractVersion', 'portfolio-query-admission.v1',
      'retryAfterSeconds', v_retry_seconds,
      'minuteCount', v_minute_count,
      'minuteCap', c_minute_cap,
      'hourCount', v_hour_count,
      'hourCap', c_hour_cap
    );
  end if;

  update public.portfolio_query_admissions
     set lease_token = p_lease_token,
         lease_expires_at = v_now + v_lease,
         updated_at = v_now
   where account_id = p_account_id
     and organization_id = p_organization_id
  returning * into v_row;

  return jsonb_build_object(
    'status', 'admitted',
    'contractVersion', 'portfolio-query-admission.v1',
    'leaseExpiresAt', v_row.lease_expires_at,
    'minuteCount', v_minute_count,
    'minuteCap', c_minute_cap,
    'hourCount', v_hour_count,
    'hourCap', c_hour_cap
  );
exception
  when no_data_found then
    -- Includes a raced parent deletion.  The application treats every status
    -- other than an exact parsed admission as unavailable/fail-closed.
    return jsonb_build_object(
      'status', 'unavailable',
      'contractVersion', 'portfolio-query-admission.v1'
    );
end;
$$;

create or replace function public.staxis_release_portfolio_query_lease(
  p_account_id uuid,
  p_organization_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.portfolio_query_admissions%rowtype;
begin
  if p_account_id is null or p_organization_id is null or p_lease_token is null then
    return jsonb_build_object(
      'status', 'invalid',
      'contractVersion', 'portfolio-query-admission.v1'
    );
  end if;

  select * into v_row
    from public.portfolio_query_admissions admission
   where admission.account_id = p_account_id
     and admission.organization_id = p_organization_id
   for update;

  if not found or v_row.lease_token is null then
    return jsonb_build_object(
      'status', 'released',
      'contractVersion', 'portfolio-query-admission.v1'
    );
  end if;
  if v_row.lease_token <> p_lease_token then
    return jsonb_build_object(
      'status', 'lease_lost',
      'contractVersion', 'portfolio-query-admission.v1'
    );
  end if;

  update public.portfolio_query_admissions
     set lease_token = null,
         lease_expires_at = null,
         updated_at = clock_timestamp()
   where account_id = p_account_id
     and organization_id = p_organization_id;
  return jsonb_build_object(
    'status', 'released',
    'contractVersion', 'portfolio-query-admission.v1'
  );
end;
$$;

revoke all on function public.staxis_acquire_portfolio_query_lease(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
revoke all on function public.staxis_release_portfolio_query_lease(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_acquire_portfolio_query_lease(uuid,uuid,uuid,integer)
  to service_role;
grant execute on function public.staxis_release_portfolio_query_lease(uuid,uuid,uuid)
  to service_role;

insert into public.applied_migrations(version, description)
values (
  '0391',
  'Atomic account-organization rate admission and bounded distributed lease before Portfolio Intelligence fanout.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
