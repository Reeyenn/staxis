-- Migration 0105: L4 (renumbered from 0103, then 0104 (parallel chats kept claiming numbers) — parallel ML chat claimed 0103 mid-flight) — conversation archival + auto-summarization schema
--
-- Two related but separable workstreams ship in one schema migration
-- so the code can land in two commits:
--   Commit 1 — archival service + cron (uses archived tables + RPCs)
--   Commit 2 — summarization service + cron (uses is_summarized,
--                                            is_summary, summary RPC,
--                                            and the filter added here
--                                            to staxis_lock_load_and_record_user_turn)
--
-- All additive. No data loss. Existing routes unaffected until commits
-- 1 and 2 ship the code that uses these.

-- ─── Part A: archival tables ──────────────────────────────────────────────
-- Mirror agent_conversations + agent_messages WITHOUT the FKs to
-- accounts/properties (so a user/property delete doesn't cascade-wipe
-- our archive) and WITHOUT the FK from messages to conversations on
-- the archive side (since archive is a flat snapshot — both tables can
-- have their conversation_id rows present at different stages of
-- restore).
--
-- We use LIKE INCLUDING DEFAULTS INCLUDING CONSTRAINTS — NOT
-- INCLUDING INDEXES — because partial unique indexes (0094's
-- agent_messages_tool_result_uq) aren't always copied by LIKE across
-- Postgres versions. We re-create the partial index explicitly below.

CREATE TABLE IF NOT EXISTS public.agent_conversations_archived (
  LIKE public.agent_conversations INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_conversations_archived
  DROP CONSTRAINT IF EXISTS agent_conversations_user_id_fkey,
  DROP CONSTRAINT IF EXISTS agent_conversations_property_id_fkey;

CREATE TABLE IF NOT EXISTS public.agent_messages_archived (
  LIKE public.agent_messages INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  archived_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_messages_archived
  DROP CONSTRAINT IF EXISTS agent_messages_conversation_id_fkey;

-- Operational indexes (cleanup queries, archival-list endpoint)
CREATE INDEX IF NOT EXISTS agent_conversations_archived_at_idx
  ON public.agent_conversations_archived(archived_at DESC);

CREATE INDEX IF NOT EXISTS agent_messages_archived_at_idx
  ON public.agent_messages_archived(archived_at DESC);

-- Restore queries need to find archived messages by conversation_id fast.
CREATE INDEX IF NOT EXISTS agent_messages_archived_conv_idx
  ON public.agent_messages_archived(conversation_id);

-- Explicitly recreate 0094's partial unique index on the archived table.
-- Don't trust LIKE INCLUDING ALL to copy partial indexes — Postgres
-- behaviour varies by version. Restore correctness depends on this
-- preventing tool_result duplicates on the way back to the hot table.
CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_archived_tool_result_uq
  ON public.agent_messages_archived(conversation_id, tool_call_id)
  WHERE role = 'tool' AND tool_call_id IS NOT NULL;

-- RLS — service role only.
ALTER TABLE public.agent_conversations_archived ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_messages_archived ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.agent_conversations_archived IS
  'Conversations >90 days dormant. Moved here by /api/cron/agent-archive-stale-conversations. Read-only; restore via staxis_restore_conversation. Longevity L4, 2026-05-13.';

COMMENT ON TABLE public.agent_messages_archived IS
  'Messages of archived conversations. Snapshot at archival time. Longevity L4, 2026-05-13.';

-- ─── Part B: summarization schema on hot tables ───────────────────────────

-- is_summarized = true: this row was folded into a summary; replay skips it.
ALTER TABLE public.agent_messages
  ADD COLUMN IF NOT EXISTS is_summarized boolean NOT NULL DEFAULT false;

-- is_summary = true: this is the summary row REPLACING a batch.
-- Distinguished from regular assistant rows so memory.ts grouping
-- won't accidentally attach subsequent tool_result rows to it.
ALTER TABLE public.agent_messages
  ADD COLUMN IF NOT EXISTS is_summary boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS agent_messages_summarized_idx
  ON public.agent_messages(conversation_id)
  WHERE is_summarized = true;

-- Live count of messages NOT folded into a summary and NOT summary
-- rows themselves. The cron uses THIS, not message_count, to decide
-- "needs summarization?" — otherwise the summary's own insert
-- (which the message_count trigger increments) would re-trigger the
-- cron forever.
ALTER TABLE public.agent_conversations
  ADD COLUMN IF NOT EXISTS unsummarized_message_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_summarized_at timestamptz;

-- Backfill: count existing unsummarized non-summary rows per convo.
-- At deploy time, every row has is_summary=false and is_summarized=false
-- (defaults), so this collapses to a simple count.
UPDATE public.agent_conversations c
  SET unsummarized_message_count = sub.cnt
  FROM (
    SELECT conversation_id, count(*)::integer AS cnt
    FROM public.agent_messages
    WHERE is_summarized = false AND is_summary = false
    GROUP BY conversation_id
  ) sub
  WHERE c.id = sub.conversation_id;

-- Trigger maintains unsummarized_message_count on three transitions:
--   INSERT a regular message (both flags false) → +1
--   INSERT a summary row (is_summary=true) → +0 (don't count)
--   INSERT a row that's already marked summarized (is_summarized=true) → +0
--   UPDATE is_summarized: false → true → -1 (no count change for true → false; rare)
--   DELETE a regular message (both flags false) → -1
CREATE OR REPLACE FUNCTION public.staxis_bump_unsummarized_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND COALESCE(NEW.is_summary, false) = false AND COALESCE(NEW.is_summarized, false) = false THEN
    UPDATE public.agent_conversations
      SET unsummarized_message_count = unsummarized_message_count + 1
      WHERE id = NEW.conversation_id;
  ELSIF TG_OP = 'UPDATE'
        AND COALESCE(OLD.is_summarized, false) = false
        AND COALESCE(NEW.is_summarized, false) = true THEN
    UPDATE public.agent_conversations
      SET unsummarized_message_count = GREATEST(0, unsummarized_message_count - 1)
      WHERE id = NEW.conversation_id;
  ELSIF TG_OP = 'DELETE'
        AND COALESCE(OLD.is_summary, false) = false
        AND COALESCE(OLD.is_summarized, false) = false THEN
    UPDATE public.agent_conversations
      SET unsummarized_message_count = GREATEST(0, unsummarized_message_count - 1)
      WHERE id = OLD.conversation_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS staxis_unsummarized_count_trg ON public.agent_messages;
CREATE TRIGGER staxis_unsummarized_count_trg
  AFTER INSERT OR UPDATE OF is_summarized OR DELETE ON public.agent_messages
  FOR EACH ROW EXECUTE FUNCTION public.staxis_bump_unsummarized_count();

-- ─── Part A: archive + restore RPCs ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.staxis_archive_conversation(
  p_conversation_id uuid,
  p_min_age_days integer DEFAULT 90
)
RETURNS integer  -- count of messages archived (-1 if conversation not eligible)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lock_key bigint;
  v_message_count integer;
  v_updated_at timestamptz;
BEGIN
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Re-check eligibility under the lock so we don't archive a convo
  -- a user is actively using.
  SELECT updated_at INTO v_updated_at
    FROM public.agent_conversations
    WHERE id = p_conversation_id;
  IF NOT FOUND OR v_updated_at >= now() - make_interval(days => p_min_age_days) THEN
    RETURN -1;
  END IF;

  -- Copy messages first. Use EXPLICIT column lists in both INSERT and
  -- SELECT so column-order drift between hot and archived tables can't
  -- silently misalign data. The integrity test caught this — the
  -- archived table's archived_at column lives between the original
  -- column tail and any later-added columns, so `SELECT m.*, now()`
  -- mapped now() into the wrong slot.
  INSERT INTO public.agent_messages_archived
    (id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result,
     is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version,
     is_summarized, is_summary, created_at)
  SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result,
     is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version,
     is_summarized, is_summary, created_at
  FROM public.agent_messages
  WHERE conversation_id = p_conversation_id;
  GET DIAGNOSTICS v_message_count = ROW_COUNT;

  -- Copy conversation row. archived_at defaults to now() so we don't
  -- list it.
  INSERT INTO public.agent_conversations_archived
    (id, user_id, property_id, title, role, prompt_version, created_at, updated_at,
     message_count, unsummarized_message_count, last_summarized_at)
  SELECT id, user_id, property_id, title, role, prompt_version, created_at, updated_at,
     message_count, unsummarized_message_count, last_summarized_at
  FROM public.agent_conversations
  WHERE id = p_conversation_id;

  -- Delete from hot tables (messages first; FK from messages→conversation).
  DELETE FROM public.agent_messages WHERE conversation_id = p_conversation_id;
  DELETE FROM public.agent_conversations WHERE id = p_conversation_id;

  RETURN v_message_count;
END;
$$;

COMMENT ON FUNCTION public.staxis_archive_conversation(uuid, integer) IS
  'Move a stale conversation + its messages to *_archived tables. Atomic under per-conversation advisory lock. Returns rows moved, or -1 if not eligible. Longevity L4, 2026-05-13.';

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

  -- Conversation first so the FK on agent_messages.conversation_id
  -- satisfies on the message inserts.
  INSERT INTO public.agent_conversations
    (id, user_id, property_id, title, role, prompt_version, created_at, updated_at, message_count, unsummarized_message_count, last_summarized_at)
  SELECT id, user_id, property_id, title, role, prompt_version, created_at, updated_at, message_count, unsummarized_message_count, last_summarized_at
    FROM public.agent_conversations_archived
    WHERE id = p_conversation_id;

  INSERT INTO public.agent_messages
    (id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version, is_summarized, is_summary, created_at)
  SELECT id, conversation_id, role, content, tool_call_id, tool_name, tool_args, tool_result, is_error, tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version, is_summarized, is_summary, created_at
    FROM public.agent_messages_archived
    WHERE conversation_id = p_conversation_id;
  GET DIAGNOSTICS v_message_count = ROW_COUNT;

  DELETE FROM public.agent_messages_archived WHERE conversation_id = p_conversation_id;
  DELETE FROM public.agent_conversations_archived WHERE id = p_conversation_id;

  RETURN v_message_count;
END;
$$;

COMMENT ON FUNCTION public.staxis_restore_conversation(uuid) IS
  'Move a previously-archived conversation back to the hot tables. Atomic under per-conversation advisory lock. Longevity L4, 2026-05-13.';

-- ─── Part B: apply-summary RPC + lock_load_and_record_user_turn filter ──

-- Inserts the summary row, marks the input range as summarized, updates
-- the conversation's last_summarized_at. The unsummarized_count trigger
-- handles count maintenance.
CREATE OR REPLACE FUNCTION public.staxis_apply_conversation_summary(
  p_conversation_id uuid,
  p_summary_content text,
  p_summarized_message_ids uuid[],
  p_tokens_in integer,
  p_tokens_out integer,
  p_model text,
  p_model_id text,
  p_cost_usd numeric
)
RETURNS uuid  -- id of the new summary row
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lock_key bigint;
  v_summary_id uuid;
BEGIN
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Insert summary row. created_at = now() places it AFTER the messages
  -- it replaces (which had earlier created_at). The replay layer reads
  -- in created_at order so this preserves correctness.
  INSERT INTO public.agent_messages (
    conversation_id, role, content,
    tokens_in, tokens_out, model_used, model_id, cost_usd,
    prompt_version, is_summary, is_summarized
  ) VALUES (
    p_conversation_id, 'assistant', p_summary_content,
    p_tokens_in, p_tokens_out, p_model, p_model_id, p_cost_usd,
    'summary-v1', true, false
  )
  RETURNING id INTO v_summary_id;

  -- Mark the input range as summarized. Trigger decrements
  -- unsummarized_message_count for each.
  UPDATE public.agent_messages
    SET is_summarized = true
    WHERE conversation_id = p_conversation_id
      AND id = ANY(p_summarized_message_ids);

  UPDATE public.agent_conversations
    SET last_summarized_at = now()
    WHERE id = p_conversation_id;

  RETURN v_summary_id;
END;
$$;

COMMENT ON FUNCTION public.staxis_apply_conversation_summary(uuid, text, uuid[], integer, integer, text, text, numeric) IS
  'Atomic: insert summary row + mark input rows as summarized + bump conversation. Called by /api/cron/agent-summarize-long-conversations. Longevity L4, 2026-05-13.';

-- Replace staxis_lock_load_and_record_user_turn so the loaded history
-- filters out is_summarized=true rows. The summary row itself
-- (is_summary=true, is_summarized=false) is INCLUDED in the history so
-- the model sees it as the bridge to the older context.
--
-- The function name is unchanged; the SELECT body adds the filter.
-- Old code paths keep working.
CREATE OR REPLACE FUNCTION public.staxis_lock_load_and_record_user_turn(
  p_conversation_id uuid,
  p_user_account_id uuid,
  p_property_id uuid,
  p_user_message text
)
RETURNS TABLE(ok boolean, reason text, history_rows jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lock_key bigint;
  v_convo record;
  v_history jsonb;
BEGIN
  v_lock_key := ('x' || substr(md5('agent_conv:' || p_conversation_id::text), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT id, user_id, property_id INTO v_convo
    FROM public.agent_conversations
    WHERE id = p_conversation_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb;
    RETURN;
  END IF;

  IF v_convo.user_id != p_user_account_id THEN
    RETURN QUERY SELECT false, 'wrong_owner'::text, NULL::jsonb;
    RETURN;
  END IF;

  IF v_convo.property_id != p_property_id THEN
    RETURN QUERY SELECT false, 'wrong_property'::text, NULL::jsonb;
    RETURN;
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role',         m.role,
        'content',      m.content,
        'tool_call_id', m.tool_call_id,
        'tool_name',    m.tool_name,
        'tool_args',    m.tool_args,
        'tool_result',  m.tool_result,
        'is_summary',   m.is_summary
      )
      ORDER BY m.created_at ASC
    ),
    '[]'::jsonb
  )
  INTO v_history
  FROM public.agent_messages m
  WHERE m.conversation_id = p_conversation_id
    AND m.is_summarized = false;
  -- L4 (2026-05-13): filter excludes summarized rows. The summary row
  -- itself (is_summary=true, is_summarized=false) passes through and
  -- appears in the model's history in chronological order.

  INSERT INTO public.agent_messages (conversation_id, role, content)
  VALUES (p_conversation_id, 'user', p_user_message);

  RETURN QUERY SELECT true, NULL::text, v_history;
END;
$$;

-- ─── Grants — service_role only ───────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.staxis_archive_conversation(uuid, integer) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_archive_conversation(uuid, integer) TO service_role;

REVOKE EXECUTE ON FUNCTION public.staxis_restore_conversation(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_restore_conversation(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.staxis_apply_conversation_summary(uuid, text, uuid[], integer, integer, text, text, numeric) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_apply_conversation_summary(uuid, text, uuid[], integer, integer, text, text, numeric) TO service_role;

-- Re-grant lock_load_and_record_user_turn (signature unchanged but new body).
REVOKE EXECUTE ON FUNCTION public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_lock_load_and_record_user_turn(uuid, uuid, uuid, text) TO service_role;

INSERT INTO public.applied_migrations (version, description)
VALUES ('0105', 'L4: conversation archival + auto-summarization schema (archived tables, is_summarized/is_summary, RPCs, trigger)')
ON CONFLICT (version) DO NOTHING;
