-- Migration 0083: close the property + global cap race in agent cost reservations
--
-- Codex adversarial review (2026-05-13) finding F1: the staxis_reserve_agent_spend
-- RPC introduced in migration 0081 only takes an advisory lock keyed on
-- p_user_id. That serializes per-user reservations, but two DIFFERENT users
-- on the same property can concurrently:
--   1. Both read v_property_spend (same value)
--   2. Both pass the property cap check
--   3. Both insert reservations
-- Same problem at the global scope. Property/global caps don't actually cap.
--
-- Fix: take three advisory locks (global, property, user) in deterministic
-- order to prevent deadlock. The advisory locks are pg_advisory_xact_lock,
-- so they auto-release on transaction end.
--
-- Lock-order policy:
--   - Global lock first: hash of the constant 'agent_costs_global'
--   - Property lock second: hash of 'agent_costs_property:' || property_id
--   - User lock third: hash of 'agent_costs:' || user_id
-- Locks are taken in this fixed order in EVERY caller, so two concurrent
-- callers always queue in the same direction → no deadlock.

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
  v_global_lock_key bigint;
  v_property_lock_key bigint;
  v_user_lock_key bigint;
  v_day_start timestamptz;
  v_user_spend numeric;
  v_property_spend numeric;
  v_global_spend numeric;
  v_id uuid;
begin
  -- Build deterministic bigint lock keys. The pattern matches migration 0078
  -- staxis_insert_draft_recipe and 0081 (md5 hex → bit(64) → bigint).
  v_global_lock_key := ('x' || substr(md5('agent_costs_global'), 1, 16))::bit(64)::bigint;
  v_property_lock_key := ('x' || substr(md5('agent_costs_property:' || p_property_id::text), 1, 16))::bit(64)::bigint;
  v_user_lock_key := ('x' || substr(md5('agent_costs:' || p_user_id::text), 1, 16))::bit(64)::bigint;

  -- Take in fixed order: global → property → user. ALL callers serialize
  -- on the same global key first, so even if two requests are for
  -- different (user, property) pairs they queue here. This is the
  -- correctness guarantee: no aggregate-cap reader can race past another
  -- aggregate-cap reader's reservation insert.
  perform pg_advisory_xact_lock(v_global_lock_key);
  perform pg_advisory_xact_lock(v_property_lock_key);
  perform pg_advisory_xact_lock(v_user_lock_key);

  v_day_start := date_trunc('day', now() at time zone 'UTC');

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

  -- Cap order user → property → global is for message specificity (the most
  -- specific cap that's hit gets reported back to the user). The locking
  -- order above ensures correctness regardless of cap-check order here.
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
  'Atomic cap-check-and-reserve under three advisory locks (global → property → user, deterministic order to prevent deadlock). Returns ok=true with reservation_id when caps are clear, ok=false with reason code (user_cap | property_cap | global_cap) otherwise. Codex adversarial review 2026-05-13 (A-C5 / Codex F1) — supersedes the user-only lock from migration 0081.';

-- Re-grant the same permissions as 0081.
revoke all on function public.staxis_reserve_agent_spend(uuid, uuid, numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.staxis_reserve_agent_spend(uuid, uuid, numeric, numeric, numeric, numeric) to service_role;
