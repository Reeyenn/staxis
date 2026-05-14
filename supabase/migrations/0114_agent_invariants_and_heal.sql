-- ─── Round 12 T12.9/T12.11/T12.12: invariant doctrine ────────────────────
-- The Round-12 meta analysis identified the root cause of the bug-fix
-- cycle: the system encodes implicit invariants in code, not in the
-- schema. Each new feature adds an invariant; two features interact
-- and one breaks the other silently.
--
-- This migration:
--   1. Adds CHECK constraints + a trigger that encode every implicit
--      invariant the AI layer currently depends on.
--   2. Adds a heal RPC that auto-corrects counter drift.
--   3. Updates the active 'base' prompt with the Round-12 T12.7
--      tool-count guidance (code half shipped in commit A).
--
-- Idempotent via DO-block wrappers + ON CONFLICT.
--
-- Pre-flight: before each ADD CONSTRAINT we SELECT for violating
-- rows. If any are found, we RAISE WARNING (not abort) so a careful
-- operator sees the count + can clean up before retrying.

-- ─── INV-3 (T12.5): agent_prompts.content is non-empty ───────────────────
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.agent_prompts
    WHERE content IS NULL OR length(trim(content)) = 0;
  IF v_bad > 0 THEN
    RAISE WARNING 'INV-3 pre-flight: % rows in agent_prompts have empty content. Constraint will fail until they are fixed.', v_bad;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_prompts_content_nonempty'
  ) THEN
    ALTER TABLE public.agent_prompts
      ADD CONSTRAINT agent_prompts_content_nonempty
      CHECK (content IS NOT NULL AND length(trim(content)) > 0);
  END IF;
END $$;

-- ─── INV-7 (T12.9): agent_conversations counter bounds ───────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_conversations_msg_count_nonneg') THEN
    ALTER TABLE public.agent_conversations
      ADD CONSTRAINT agent_conversations_msg_count_nonneg
      CHECK (message_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_conversations_unsummarized_bounds') THEN
    ALTER TABLE public.agent_conversations
      ADD CONSTRAINT agent_conversations_unsummarized_bounds
      CHECK (unsummarized_message_count >= 0 AND unsummarized_message_count <= message_count);
  END IF;
END $$;

-- ─── INV-8 (T12.9): agent_messages.role enum ─────────────────────────────
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.agent_messages
    WHERE role NOT IN ('user', 'assistant', 'tool', 'system');
  IF v_bad > 0 THEN
    RAISE WARNING 'INV-8 pre-flight: % rows in agent_messages have unexpected role values. Constraint will fail.', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_messages_role_enum') THEN
    ALTER TABLE public.agent_messages
      ADD CONSTRAINT agent_messages_role_enum
      CHECK (role IN ('user', 'assistant', 'tool', 'system'));
  END IF;
END $$;

-- ─── INV-9 (T12.9): is_summary implies role='assistant' ──────────────────
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.agent_messages
    WHERE is_summary = true AND role != 'assistant';
  IF v_bad > 0 THEN
    RAISE WARNING 'INV-9 pre-flight: % rows have is_summary=true but role!=assistant. Constraint will fail.', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_messages_summary_is_assistant') THEN
    ALTER TABLE public.agent_messages
      ADD CONSTRAINT agent_messages_summary_is_assistant
      CHECK (NOT is_summary OR role = 'assistant');
  END IF;
END $$;

-- ─── INV-10 (T12.9): tool rows must have a tool_call_id ──────────────────
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.agent_messages
    WHERE role = 'tool' AND tool_call_id IS NULL;
  IF v_bad > 0 THEN
    RAISE WARNING 'INV-10 pre-flight: % tool rows have NULL tool_call_id. Constraint will fail.', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_messages_tool_needs_call_id') THEN
    ALTER TABLE public.agent_messages
      ADD CONSTRAINT agent_messages_tool_needs_call_id
      CHECK (role != 'tool' OR tool_call_id IS NOT NULL);
  END IF;
END $$;

-- ─── INV-1 (T12.11): tool result rows must have preceding tool_use ───────
-- Trigger-enforced (CHECK constraints can't reference other rows).
CREATE OR REPLACE FUNCTION public.staxis_check_tool_result_pairing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.role = 'tool' AND NEW.tool_call_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.agent_messages
      WHERE conversation_id = NEW.conversation_id
        AND role = 'assistant'
        AND tool_name IS NOT NULL
        AND tool_call_id = NEW.tool_call_id
        AND created_at <= NEW.created_at
    ) THEN
      RAISE EXCEPTION 'orphan_tool_result: tool_call_id % has no preceding tool_use in conversation %',
        NEW.tool_call_id, NEW.conversation_id
        USING ERRCODE = 'P0003';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_messages_tool_result_orphan_check ON public.agent_messages;
CREATE TRIGGER agent_messages_tool_result_orphan_check
  BEFORE INSERT ON public.agent_messages
  FOR EACH ROW
  WHEN (NEW.role = 'tool')
  EXECUTE FUNCTION public.staxis_check_tool_result_pairing();

COMMENT ON FUNCTION public.staxis_check_tool_result_pairing() IS
  'Enforces INV-1: a tool_result row must have a preceding assistant tool_use with matching tool_call_id in the same conversation. Round 12 T12.11, 2026-05-13.';

-- ─── T12.12: counter-heal RPC ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staxis_heal_conversation_counters(
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE (
  conversation_id uuid,
  stored_msg_count integer,
  actual_msg_count integer,
  stored_unsum_count integer,
  actual_unsum_count integer,
  healed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  drift_row record;
BEGIN
  FOR drift_row IN
    SELECT
      c.id AS cid,
      c.message_count AS stored_msg,
      c.unsummarized_message_count AS stored_unsum,
      (SELECT count(*)::int FROM public.agent_messages m WHERE m.conversation_id = c.id) AS actual_msg,
      (SELECT count(*)::int FROM public.agent_messages m
        WHERE m.conversation_id = c.id
          AND m.is_summarized = false
          AND m.is_summary = false) AS actual_unsum
    FROM public.agent_conversations c
    WHERE c.message_count != (SELECT count(*) FROM public.agent_messages m WHERE m.conversation_id = c.id)
       OR c.unsummarized_message_count != (SELECT count(*) FROM public.agent_messages m
            WHERE m.conversation_id = c.id
              AND m.is_summarized = false
              AND m.is_summary = false)
  LOOP
    IF NOT p_dry_run THEN
      UPDATE public.agent_conversations
        SET message_count = drift_row.actual_msg,
            unsummarized_message_count = drift_row.actual_unsum
        WHERE id = drift_row.cid;
    END IF;
    conversation_id := drift_row.cid;
    stored_msg_count := drift_row.stored_msg;
    actual_msg_count := drift_row.actual_msg;
    stored_unsum_count := drift_row.stored_unsum;
    actual_unsum_count := drift_row.actual_unsum;
    healed := NOT p_dry_run;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.staxis_heal_conversation_counters(boolean) IS
  'Recompute message_count + unsummarized_message_count from agent_messages for every conversation; heal drift if p_dry_run=false. Returns one row per drifted conversation. Cron route /api/cron/agent-heal-counters invokes it daily. Round 12 T12.12, 2026-05-13.';

REVOKE EXECUTE ON FUNCTION public.staxis_heal_conversation_counters(boolean) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_heal_conversation_counters(boolean) TO service_role;

-- ─── T12.7 DB-half: append tool-count guidance to active 'base' prompt ──
UPDATE public.agent_prompts
  SET content = content || E'\n- When you have multiple actions to take, call ONE tool per turn and wait for its result before calling the next. The system gives you additional turns for follow-up actions. Never return more than 5 tool calls in a single response — anything past the fifth will be rejected.',
      version = '2026.05.13-v4',
      notes = COALESCE(notes, '') || E'\n[2026-05-13] Round-12 T12.7: appended tool-count guidance (max 5 per response, one at a time preferred) so the model trains to stay under MAX_TOOLS_PER_ITERATION instead of paying for over-cap responses we then refuse.'
  WHERE role = 'base' AND is_active = true;

-- Register migration.
INSERT INTO public.applied_migrations (version, description)
VALUES ('0114', 'Round 12 T12.9/T12.11/T12.12: invariant CHECKs + tool-result orphan trigger + heal RPC + T12.7 active prompt update')
ON CONFLICT (version) DO NOTHING;
