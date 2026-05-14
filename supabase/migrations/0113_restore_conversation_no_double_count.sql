-- ─── Round 12 T12.2: restore RPC must not double-count counters ──────────
-- Codex round-12 finding #2 (HIGH).
--
-- The 0105 staxis_restore_conversation inserts the archived
-- agent_conversations row with message_count=N and unsummarized=M
-- (taken from the archive), then re-inserts all N archived messages
-- into agent_messages. The bump triggers
-- (staxis_bump_agent_conversation_message_count from 0100 +
-- staxis_bump_unsummarized_count from 0105) fire on each message
-- insert and increment the counters AGAIN. Restored 60-message
-- conversation comes back showing ~120 → premature/repeated
-- summarization, /admin/agent KPI lies.
--
-- Fix: insert conversation with message_count=0, unsummarized=0.
-- Triggers fire correctly as messages insert. After the message
-- inserts complete, recompute both counters from agent_messages
-- explicitly — defends against any edge case (e.g. archived rows
-- with is_summarized=true that the trigger handles differently).
--
-- Idempotent via CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.staxis_restore_conversation(
  p_conversation_id uuid
)
RETURNS integer  -- count of messages restored (-1 if not archived)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lock_key bigint;
  v_message_count integer;
  v_exists boolean;
BEGIN
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT EXISTS (SELECT 1 FROM public.agent_conversations_archived WHERE id = p_conversation_id)
    INTO v_exists;
  IF NOT v_exists THEN RETURN -1; END IF;

  -- Restore the conversation row FIRST so the FK on
  -- agent_messages.conversation_id satisfies on the message inserts.
  -- Round 12 T12.2 (2026-05-13): override message_count + unsummarized
  -- to 0. The bump triggers will increment correctly as we re-insert
  -- the messages below. We restore last_summarized_at as-is so any
  -- semantics depending on "when was this conversation last folded"
  -- stay intact.
  INSERT INTO public.agent_conversations
    (id, user_id, property_id, title, role, prompt_version,
     created_at, updated_at, message_count, unsummarized_message_count,
     last_summarized_at)
  SELECT id, user_id, property_id, title, role, prompt_version,
         created_at, updated_at,
         0,  -- message_count: trigger will rebuild from message inserts
         0,  -- unsummarized_message_count: same
         last_summarized_at
    FROM public.agent_conversations_archived
    WHERE id = p_conversation_id;

  -- Restore messages. The bump triggers fire on each insert, counting
  -- UP from zero. Trigger logic (staxis_bump_unsummarized_count in 0105)
  -- only increments when is_summarized=false AND is_summary=false, which
  -- is the correct semantic for unsummarized_message_count anyway.
  INSERT INTO public.agent_messages
    (id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result,
     is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version,
     is_summarized, is_summary, created_at)
  SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result,
         is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version,
         is_summarized, is_summary, created_at
    FROM public.agent_messages_archived
    WHERE conversation_id = p_conversation_id;
  GET DIAGNOSTICS v_message_count = ROW_COUNT;

  -- Defense-in-depth: recompute both counters explicitly. Handles any
  -- edge case where the trigger logic didn't fire as expected (e.g.
  -- if 0100's trigger only counts certain roles, or if a future
  -- trigger drift causes asymmetric maintenance).
  UPDATE public.agent_conversations
    SET message_count = (
          SELECT count(*) FROM public.agent_messages
          WHERE conversation_id = p_conversation_id
        ),
        unsummarized_message_count = (
          SELECT count(*) FROM public.agent_messages
          WHERE conversation_id = p_conversation_id
            AND is_summarized = false
            AND is_summary = false
        )
    WHERE id = p_conversation_id;

  DELETE FROM public.agent_messages_archived WHERE conversation_id = p_conversation_id;
  DELETE FROM public.agent_conversations_archived WHERE id = p_conversation_id;

  RETURN v_message_count;
END;
$$;

COMMENT ON FUNCTION public.staxis_restore_conversation(uuid) IS
  'Move a previously-archived conversation back to the hot tables. Round 12 T12.2: inserts conversation with counters=0 so the bump triggers rebuild them correctly (the prior 0105 version double-counted). Defensive recompute UPDATE handles edge cases. Atomic under per-conversation advisory lock.';

-- Grant unchanged (signature unchanged), but re-grant for safety.
REVOKE EXECUTE ON FUNCTION public.staxis_restore_conversation(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_restore_conversation(uuid) TO service_role;

INSERT INTO public.applied_migrations (version, description)
VALUES ('0113', 'Round 12 T12.2: restore RPC inserts counters=0 + recomputes from agent_messages to prevent double-counting via bump triggers')
ON CONFLICT (version) DO NOTHING;
