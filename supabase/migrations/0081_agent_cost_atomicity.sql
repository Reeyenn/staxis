-- Migration 0081: atomicity fixes for the agent layer
--
-- Codex adversarial review (2026-05-13) flagged four real bugs in the
-- shipped agent layer. Two of them — cost-cap TOCTOU race and partial
-- assistant-turn persistence — need database-side critical sections to
-- fix correctly. This migration adds:
--
--   1. agent_costs.state — 'reserved' vs 'finalized' so the cap-check SUM
--      sees in-flight spend, not just completed spend.
--
--   2. staxis_reserve_agent_spend — atomic check-and-reserve under a
--      per-user advisory lock. Replaces the JS check-then-write pattern
--      that lets 20 concurrent requests all sneak past a $0.50 cap.
--
--   3. staxis_finalize_agent_spend — reconciles reservation to actual
--      cost when the stream completes.
--
--   4. staxis_cancel_agent_spend — releases reservation on stream abort
--      so a user's daily budget isn't permanently held by failed requests.
--
--   5. staxis_record_assistant_turn — writes assistant text row + each
--      tool_use row in ONE transaction. Replaces the per-row inserts in
--      memory.ts:recordAssistantTurn that could partially fail and leave
--      orphan tool_result rows in agent_messages.

-- ─── agent_costs.state column ─────────────────────────────────────────
-- Default 'finalized' so existing rows (and any code path that doesn't
-- yet call the new RPC) behave as before.
alter table public.agent_costs
  add column if not exists state text not null default 'finalized'
    check (state in ('reserved', 'finalized'));

-- Index supports the cap-sum query: WHERE user_id=? AND kind='request' AND state IN (...) AND created_at >= today.
-- We re-shape the existing per-user-day idx to also cover state filtering.
create index if not exists agent_costs_user_state_idx
  on public.agent_costs(user_id, state, created_at desc);

create index if not exists agent_costs_property_state_idx
  on public.agent_costs(property_id, state, created_at desc);

-- ─── RPC: staxis_reserve_agent_spend ──────────────────────────────────
-- Takes an advisory lock keyed on user_id_hash so concurrent reservations
-- for the same user serialize. Inside the lock: sum today's spend
-- (reserved + finalized), check the three caps, insert a reservation row
-- if cap clear. Returns { ok, reservation_id, reason, remaining }.
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
  v_lock_key bigint;
  v_day_start timestamptz;
  v_user_spend numeric;
  v_property_spend numeric;
  v_global_spend numeric;
  v_id uuid;
begin
  -- Lock against concurrent reservations for THIS user only. The hash
  -- gives a deterministic bigint without colliding with other advisory
  -- lock callers (no integer-only keys in use elsewhere — see migration
  -- 0078 staxis_insert_draft_recipe for the same pattern).
  v_lock_key := ('x' || substr(md5('agent_costs:' || p_user_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  v_day_start := date_trunc('day', now() at time zone 'UTC');

  -- Sum today's spend across both 'reserved' and 'finalized' rows for
  -- this user. Reserved rows represent in-flight requests whose actual
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

  -- Cap clear — insert reservation. The advisory lock guarantees that
  -- two concurrent reservations for this user can't both pass: the second
  -- caller waits on the lock and then sees the first's row.
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
  'Atomic cap-check-and-reserve for an agent request. Returns ok=true with a reservation_id when caps are clear, ok=false with a reason code (user_cap | property_cap | global_cap) otherwise. Serializes concurrent reservations for the same user via pg_advisory_xact_lock. Codex adversarial review fix #1, 2026-05-13.';

-- ─── RPC: staxis_finalize_agent_spend ─────────────────────────────────
-- Reconcile a reservation to actual cost + telemetry. Called after the
-- stream's `done` event. Idempotent — calling it twice on the same id is
-- harmless (second call just updates the same fields).
create or replace function public.staxis_finalize_agent_spend(
  p_reservation_id uuid,
  p_conversation_id uuid,
  p_actual_usd numeric,
  p_model text,
  p_tokens_in integer,
  p_tokens_out integer,
  p_cached_input_tokens integer
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.agent_costs
  set state = 'finalized',
      conversation_id = p_conversation_id,
      cost_usd = p_actual_usd,
      model = p_model,
      tokens_in = p_tokens_in,
      tokens_out = p_tokens_out,
      cached_input_tokens = p_cached_input_tokens
  where id = p_reservation_id;
end;
$$;

comment on function public.staxis_finalize_agent_spend is
  'Reconcile a reservation to actual spend after the agent stream completes. Codex adversarial review fix #1, 2026-05-13.';

-- ─── RPC: staxis_cancel_agent_spend ───────────────────────────────────
-- Release a reservation that never finalized (stream aborted, client
-- disconnect, etc.). Sets cost_usd=0 so the user's daily budget isn't
-- permanently held by failed requests.
create or replace function public.staxis_cancel_agent_spend(
  p_reservation_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.agent_costs
  set state = 'finalized',
      cost_usd = 0
  where id = p_reservation_id
    and state = 'reserved';
end;
$$;

comment on function public.staxis_cancel_agent_spend is
  'Cancel an unfinalized reservation. Used in the stream abort path to release the budget hold. Codex adversarial review fix #1, 2026-05-13.';

-- ─── RPC: staxis_record_assistant_turn ────────────────────────────────
-- Writes the assistant text row + each tool_use row for ONE assistant
-- iteration in a single transaction. Replaces the per-row inserts in
-- memory.ts:recordAssistantTurn that could partially succeed and leave
-- orphan tool_result rows pointing at non-existent tool_use rows.
--
-- p_tool_calls jsonb format: [{ id: "toolu_…", name: "…", args: {…} }, …]
create or replace function public.staxis_record_assistant_turn(
  p_conversation_id uuid,
  p_text text,
  p_tool_calls jsonb,
  p_tokens_in integer,
  p_tokens_out integer,
  p_model text,
  p_cost_usd numeric
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_call jsonb;
begin
  -- Insert assistant text row (only when text is non-empty)
  if p_text is not null and length(p_text) > 0 then
    insert into public.agent_messages (
      conversation_id, role, content,
      tokens_in, tokens_out, model_used, cost_usd
    ) values (
      p_conversation_id, 'assistant', p_text,
      p_tokens_in, p_tokens_out, p_model, p_cost_usd
    );
  end if;

  -- Insert one row per tool_call from the jsonb array. Order matters —
  -- jsonb_array_elements preserves insertion order, which gives us
  -- deterministic created_at sequencing within the microsecond bucket.
  if p_tool_calls is not null and jsonb_typeof(p_tool_calls) = 'array' then
    for v_call in select * from jsonb_array_elements(p_tool_calls)
    loop
      insert into public.agent_messages (
        conversation_id, role,
        tool_call_id, tool_name, tool_args
      ) values (
        p_conversation_id, 'assistant',
        v_call->>'id',
        v_call->>'name',
        coalesce(v_call->'args', '{}'::jsonb)
      );
    end loop;
  end if;
end;
$$;

comment on function public.staxis_record_assistant_turn is
  'Atomically write an assistant turn (text + tool_use rows) for one iteration. All rows succeed together or none do. Codex adversarial review fix #2, 2026-05-13.';

-- ─── Grants ────────────────────────────────────────────────────────────
-- These RPCs are only meant for the server (service_role). Keep public
-- locked out so a future RLS audit doesn't surface them as user-callable.
revoke execute on function public.staxis_reserve_agent_spend(uuid, uuid, numeric, numeric, numeric, numeric) from public;
revoke execute on function public.staxis_reserve_agent_spend(uuid, uuid, numeric, numeric, numeric, numeric) from anon, authenticated;
grant  execute on function public.staxis_reserve_agent_spend(uuid, uuid, numeric, numeric, numeric, numeric) to   service_role;

revoke execute on function public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, integer, integer, integer) from public;
revoke execute on function public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, integer, integer, integer) from anon, authenticated;
grant  execute on function public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, integer, integer, integer) to   service_role;

revoke execute on function public.staxis_cancel_agent_spend(uuid) from public;
revoke execute on function public.staxis_cancel_agent_spend(uuid) from anon, authenticated;
grant  execute on function public.staxis_cancel_agent_spend(uuid) to   service_role;

revoke execute on function public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, numeric) from public;
revoke execute on function public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, numeric) from anon, authenticated;
grant  execute on function public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, numeric) to   service_role;

insert into public.applied_migrations (version, description)
values ('0081', 'Codex review: atomic cost-cap reservation + atomic assistant-turn persistence')
on conflict (version) do nothing;
