-- Migration 0082: multi-scope advisory locks for agent cost reservations
--
-- The second Codex adversarial review (2026-05-13) caught that the
-- reservation RPC introduced in 0081 only locks per-user. Two different
-- users on the same property both pass the property + global cap checks
-- before either insert is visible, so the shared caps still race.
--
-- This migration replaces the RPC body to take THREE advisory locks in a
-- fixed order — user → property → global — so concurrent reservations
-- across any scope serialize correctly. The fixed ordering prevents
-- deadlock (any two callers wanting the same property end up requesting
-- the locks in identical order, so one waits behind the other instead
-- of crossing).
--
-- The signature is unchanged so the JS caller in src/lib/agent/cost-controls.ts
-- doesn't need to update its rpc() invocation.

create or replace function public.staxis_reserve_agent_spend(
  p_user_id uuid,
  p_property_id uuid,
  p_estimated_usd numeric,
  p_user_cap_usd numeric default 10,
  p_property_cap_usd numeric default 50,
  p_global_cap_usd numeric default 500
)
returns table(
  ok boolean,
  reservation_id uuid,
  reason text,
  user_spend_usd numeric,
  property_spend_usd numeric,
  global_spend_usd numeric
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_lock_key bigint;
  v_property_lock_key bigint;
  -- Fixed integer key for the global lock. Picked from outside any other
  -- advisory-lock keyspace we use; pg_advisory_xact_lock keyed on a
  -- bigint integer doesn't collide with the 2-arg variant either.
  v_global_lock_key constant bigint := 8001;
  v_day_start timestamptz;
  v_user_spend numeric;
  v_property_spend numeric;
  v_global_spend numeric;
  v_id uuid;
begin
  -- Compute deterministic lock keys for the user and property scopes.
  v_user_lock_key := ('x' || substr(md5('agent_costs:user:' || p_user_id::text), 1, 16))::bit(64)::bigint;
  v_property_lock_key := ('x' || substr(md5('agent_costs:property:' || p_property_id::text), 1, 16))::bit(64)::bigint;

  -- Take locks in a STRICT order: user → property → global. Same order
  -- across all callers prevents deadlock. Every reservation goes through
  -- this RPC, so as long as nothing else in the schema takes these keys
  -- in a different order, we're cycle-free.
  perform pg_advisory_xact_lock(v_user_lock_key);
  perform pg_advisory_xact_lock(v_property_lock_key);
  perform pg_advisory_xact_lock(v_global_lock_key);

  v_day_start := date_trunc('day', now() at time zone 'UTC');

  -- Sum today's spend across both 'reserved' and 'finalized' rows for
  -- each scope. Reserved rows represent in-flight requests whose actual
  -- spend we don't know yet — counting them is the whole point of the
  -- reservation pattern.
  select coalesce(sum(cost_usd), 0)
    into v_user_spend
    from public.agent_costs
    where user_id = p_user_id
      and kind = 'request'
      and state in ('reserved', 'finalized')
      and created_at >= v_day_start;

  select coalesce(sum(cost_usd), 0)
    into v_property_spend
    from public.agent_costs
    where property_id = p_property_id
      and kind = 'request'
      and state in ('reserved', 'finalized')
      and created_at >= v_day_start;

  select coalesce(sum(cost_usd), 0)
    into v_global_spend
    from public.agent_costs
    where kind = 'request'
      and state in ('reserved', 'finalized')
      and created_at >= v_day_start;

  -- Check caps in order: user → property → global. Most specific first
  -- so the error message tells the user the right thing.
  if (v_user_spend + p_estimated_usd) > p_user_cap_usd then
    return query select false, null::uuid, 'user_cap'::text, v_user_spend, v_property_spend, v_global_spend;
    return;
  end if;

  if (v_property_spend + p_estimated_usd) > p_property_cap_usd then
    return query select false, null::uuid, 'property_cap'::text, v_user_spend, v_property_spend, v_global_spend;
    return;
  end if;

  if (v_global_spend + p_estimated_usd) > p_global_cap_usd then
    return query select false, null::uuid, 'global_cap'::text, v_user_spend, v_property_spend, v_global_spend;
    return;
  end if;

  -- All three caps clear under all three locks — insert reservation. The
  -- lock ordering guarantees serializability against any concurrent
  -- caller hitting the same scope at any level.
  insert into public.agent_costs (
    user_id, property_id, conversation_id, model,
    tokens_in, tokens_out, cached_input_tokens,
    cost_usd, kind, state
  ) values (
    p_user_id, p_property_id, null, 'pending',
    0, 0, 0,
    p_estimated_usd, 'request', 'reserved'
  )
  returning id into v_id;

  return query select true, v_id, null::text, v_user_spend, v_property_spend, v_global_spend;
end;
$$;

comment on function public.staxis_reserve_agent_spend is
  'Atomic cap-check-and-reserve with per-user, per-property, and global advisory locks taken in fixed order (user → property → global). Codex adversarial review fix C1, 2026-05-13.';

insert into public.applied_migrations (version, description)
values ('0082', 'Codex review: multi-scope advisory locks for agent cost reservations')
on conflict (version) do nothing;
