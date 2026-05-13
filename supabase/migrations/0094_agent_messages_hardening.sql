-- Migration 0094: defense-in-depth hardening for agent_messages
--
-- After seven adversarial review rounds, four "defensive only" items
-- remained on the backlog. Reeyen asked to fold them in too. This
-- migration covers the two DB-side ones:
--
--   1. Partial unique index on (conversation_id, tool_call_id) for
--      tool rows. Prevents future bugs (e.g. a sweeper-cleanup race
--      with the route's normal recordToolResult) from quietly
--      double-persisting a tool_result for the same tool_call_id,
--      which would corrupt the toClaudeMessages adjacency map.
--
--   2. agent_messages.model_id column. agent_costs already records
--      the exact Anthropic snapshot ID per request (round-4 S5);
--      agent_messages only had the tier ('sonnet'). Closing this
--      audit-trail gap lets us correlate individual assistant turns
--      to specific Claude releases when investigating quality shifts.
--
-- Both are additive — existing rows keep working without changes.

-- ── 1. Partial unique index on (conversation_id, tool_call_id) ──
-- 'role' filter so we don't conflict with assistant-turn tool_use rows
-- (which also have tool_call_id but represent a different concept).
-- tool_call_id is null on user + plain assistant rows so we require
-- it explicitly.
create unique index if not exists agent_messages_tool_result_uq
  on public.agent_messages(conversation_id, tool_call_id)
  where role = 'tool' and tool_call_id is not null;

-- ── 2. agent_messages.model_id column ──
alter table public.agent_messages
  add column if not exists model_id text;

-- ── 3. Update staxis_record_assistant_turn RPC to accept p_model_id ──
-- The old (7-arg) signature is dropped at the end to force callers to
-- update; supabase-js fails loudly on missing-RPC errors rather than
-- silently dropping the new field.
create or replace function public.staxis_record_assistant_turn(
  p_conversation_id uuid,
  p_text text,
  p_tool_calls jsonb,
  p_tokens_in integer,
  p_tokens_out integer,
  p_model text,
  p_model_id text,
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
  if p_text is not null and length(p_text) > 0 then
    insert into public.agent_messages (
      conversation_id, role, content,
      tokens_in, tokens_out, model_used, model_id, cost_usd
    ) values (
      p_conversation_id, 'assistant', p_text,
      p_tokens_in, p_tokens_out, p_model, p_model_id, p_cost_usd
    );
  end if;

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

comment on function public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric) is
  'Atomic assistant turn write (text + tool_use rows) with exact Anthropic snapshot ID. Replaces the 7-arg variant from migration 0081. Codex round-7 backlog cleanup, 2026-05-13.';

revoke execute on function public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric) from public;
revoke execute on function public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric) from anon, authenticated;
grant  execute on function public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric) to   service_role;

-- Drop the old 7-arg signature so application code MUST use the new one.
drop function if exists public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, numeric);

insert into public.applied_migrations (version, description)
values ('0094', 'Defense-in-depth: tool_result uq index + agent_messages.model_id + record_assistant_turn signature bump')
on conflict (version) do nothing;
