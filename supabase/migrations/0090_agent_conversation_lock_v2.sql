-- Migration 0090: real per-conversation advisory lock — single-RPC pattern
--
-- Codex post-merge review (2026-05-13) finding F1: the previous
-- staxis_lock_conversation RPC from migration 0085 was a no-op. It used
-- pg_advisory_xact_lock, which auto-releases when the implicit transaction
-- around the RPC commits. PostgREST calls each RPC in its own auto-commit
-- transaction, so the lock was released BEFORE the route's subsequent
-- loadConversation + recordUserTurn calls ever ran. The race window was
-- left wide open despite the apparent fix.
--
-- New approach: a single RPC that does load+write inside ONE transaction:
--   1. Take advisory lock (xact-scoped, holds for this RPC's life)
--   2. Validate ownership
--   3. Load all messages in chronological order
--   4. Insert the new user turn
--   5. Return the full bundle as jsonb
-- All steps run in the same transaction, so the lock genuinely serializes
-- concurrent callers. Two browser tabs hitting the same conversation_id
-- now queue here instead of interleaving.

create or replace function public.staxis_load_and_record_user_turn(
  p_conversation_id uuid,
  p_user_id uuid,
  p_user_message text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_convo record;
  v_messages jsonb;
begin
  -- 1. Take the advisory lock. Holds until this function returns (and the
  --    implicit RPC transaction commits). Same hash pattern as other
  --    staxis_* locks so we don't collide.
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- 2. Ownership + metadata.
  select
    id, title, role, property_id, prompt_version,
    created_at, updated_at, user_id
    into v_convo
    from public.agent_conversations
    where id = p_conversation_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_convo.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'wrong_owner');
  end if;

  -- 3. Load messages as a jsonb array. TS side reconstructs AgentMessage
  --    shapes the same way loadConversation() did pre-fix. Order by
  --    created_at ASC, id ASC for deterministic ordering on microsecond ties.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'role', m.role,
      'content', m.content,
      'tool_call_id', m.tool_call_id,
      'tool_name', m.tool_name,
      'tool_args', m.tool_args,
      'tool_result', m.tool_result,
      'created_at', m.created_at
    )
    order by m.created_at asc, m.id asc
  ), '[]'::jsonb)
    into v_messages
    from public.agent_messages m
    where m.conversation_id = p_conversation_id;

  -- 4. Insert the new user turn. agent_messages.created_at defaults to now()
  --    so this user message sorts AFTER everything we just loaded.
  insert into public.agent_messages (conversation_id, role, content)
    values (p_conversation_id, 'user', p_user_message);

  -- 5. Return the bundle.
  return jsonb_build_object(
    'ok', true,
    'conversation', jsonb_build_object(
      'id', v_convo.id,
      'title', v_convo.title,
      'role', v_convo.role,
      'property_id', v_convo.property_id,
      'prompt_version', v_convo.prompt_version,
      'created_at', v_convo.created_at,
      'updated_at', v_convo.updated_at
    ),
    'messages', v_messages
  );
end;
$$;

comment on function public.staxis_load_and_record_user_turn is
  'Per-conversation serialized load+write under a single advisory lock that genuinely holds for the duration. Replaces the broken staxis_lock_conversation RPC from migration 0085. Codex post-merge review 2026-05-13 (F1).';

revoke all on function public.staxis_load_and_record_user_turn(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.staxis_load_and_record_user_turn(uuid, uuid, text) to service_role;

insert into public.applied_migrations (version, description)
values ('0090', 'Codex post-merge review: real per-conversation lock via single load+write RPC (F1)')
on conflict (version) do nothing;
