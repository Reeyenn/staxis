-- Migration 0092: atomic lock + load + record-user-turn for agent route
--
-- Codex round-7 adversarial review (2026-05-13) found that the
-- per-conversation lock from migration 0085 was a no-op because the
-- supabase-js .rpc() call wraps each invocation in its own implicit
-- transaction. The lock acquired inside that tx is released when the
-- RPC returns — BEFORE the JS-side loadConversation + recordUserTurn
-- run. So two concurrent POSTs to /api/agent/command for the same
-- conversation can still race past the lock and interleave writes.
--
-- This migration adds staxis_lock_load_and_record_user_turn which does
-- the FULL prep window atomically: lock + verify ownership + verify
-- property + load history + insert user turn — all inside ONE RPC
-- transaction. The lock holds for that whole window, so concurrent
-- POSTs serialize on the lock instead of racing.
--
-- The lock still releases when the RPC returns (before the long-lived
-- SSE stream starts), which is by design — holding it across a 30s+
-- stream would create user-visible queueing for tabs that just want
-- to send a quick second message. The remaining window (rpc-end →
-- stream-start) is microseconds.

create or replace function public.staxis_lock_load_and_record_user_turn(
  p_conversation_id uuid,
  p_user_account_id uuid,
  p_property_id uuid,
  p_user_message text
)
returns table(
  ok boolean,
  reason text,
  history_rows jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_convo record;
  v_history jsonb;
begin
  -- Same hash pattern as the cost-control + 0085 RPCs (md5 → bit(64) → bigint)
  -- so we play nicely with other staxis_* advisory locks (no collisions).
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Verify ownership + property scope inside the lock so we can't be
  -- racing against a sibling tab that's about to delete the conversation.
  select id, user_id, property_id into v_convo
    from public.agent_conversations
    where id = p_conversation_id;

  if not found then
    return query select false, 'not_found'::text, null::jsonb;
    return;
  end if;

  if v_convo.user_id != p_user_account_id then
    return query select false, 'wrong_owner'::text, null::jsonb;
    return;
  end if;

  if v_convo.property_id != p_property_id then
    return query select false, 'wrong_property'::text, null::jsonb;
    return;
  end if;

  -- Load history while still under the lock so the snapshot is consistent
  -- with what we're about to append. jsonb_agg with explicit ORDER BY for
  -- deterministic replay reconstruction.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role', m.role,
        'content', m.content,
        'tool_call_id', m.tool_call_id,
        'tool_name', m.tool_name,
        'tool_args', m.tool_args,
        'tool_result', m.tool_result
      )
      order by m.created_at asc
    ),
    '[]'::jsonb
  )
  into v_history
  from public.agent_messages m
  where m.conversation_id = p_conversation_id;

  -- Record the user turn while still under the lock. The trigger
  -- staxis_touch_conversation_updated_at fires here, bumping updated_at.
  insert into public.agent_messages (conversation_id, role, content)
  values (p_conversation_id, 'user', p_user_message);

  return query select true, null::text, v_history;
end;
$$;

comment on function public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text) is
  'Atomic prep for /api/agent/command: take per-conversation advisory lock, verify ownership + property, load history, and insert the user turn — all in one RPC transaction so two concurrent POSTs cannot interleave. Replaces the no-op staxis_lock_conversation from migration 0085. Codex round-7 fix F2, 2026-05-13.';

revoke execute on function public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text) from public;
revoke execute on function public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text) from anon, authenticated;
grant  execute on function public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text) to   service_role;

insert into public.applied_migrations (version, description)
values ('0092', 'Codex round-7: atomic lock + load + record-user-turn RPC (F2)')
on conflict (version) do nothing;
