-- Migration 0100: longevity foundation — multiple additive items
-- (Originally drafted as 0099; renumbered to 0100 because a parallel
-- ai-stack commit claimed 0099 for unrelated work mid-flight.)
--
-- After 8 review rounds, the bug-fixing phase is in good shape. Round 9
-- (this commit) is the first lift of the longevity backlog from the
-- year-from-now architecture review:
--
--   L2a — prompt_version per agent_messages row (was per-conversation only)
--   L4a — composite index on agent_messages(conversation_id, created_at)
--   L4b — message_count column on agent_conversations + maintained trigger
--   L5a — agent_eval_baselines table for cost/latency regression detection
--   L7a — accounts.ai_cost_tier column + tier-based cost caps
--
-- All additive. No data loss. Defaults preserve existing behaviour.
-- staxis_record_assistant_turn signature bumps from 8 → 9 args; old
-- 8-arg signature is dropped to force callers to update.

-- ── L2a: prompt_version per agent_messages row ────────────────────────
ALTER TABLE public.agent_messages
  ADD COLUMN IF NOT EXISTS prompt_version text;

COMMENT ON COLUMN public.agent_messages.prompt_version IS
  'Snapshot of PROMPT_VERSION at the moment this turn was produced. Lets us correlate behaviour to a specific prompt version when investigating quality shifts. Longevity L2a, 2026-05-13.';

-- ── L4a: composite index for the loadConversation hot path ───────────
CREATE INDEX IF NOT EXISTS agent_messages_conv_created_idx
  ON public.agent_messages(conversation_id, created_at);

-- ── L4b: message_count denormalized + trigger ────────────────────────
ALTER TABLE public.agent_conversations
  ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.staxis_bump_agent_conversation_message_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.agent_conversations
      SET message_count = message_count + 1
      WHERE id = NEW.conversation_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.agent_conversations
      SET message_count = GREATEST(0, message_count - 1)
      WHERE id = OLD.conversation_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS staxis_agent_messages_count_trg ON public.agent_messages;
CREATE TRIGGER staxis_agent_messages_count_trg
  AFTER INSERT OR DELETE ON public.agent_messages
  FOR EACH ROW
  EXECUTE FUNCTION public.staxis_bump_agent_conversation_message_count();

-- Backfill message_count for existing conversations
UPDATE public.agent_conversations c
  SET message_count = sub.cnt
  FROM (
    SELECT conversation_id, count(*)::integer AS cnt
    FROM public.agent_messages
    GROUP BY conversation_id
  ) sub
WHERE c.id = sub.conversation_id
  AND c.message_count != sub.cnt;

-- ── L5a: eval baselines for regression detection ─────────────────────
CREATE TABLE IF NOT EXISTS public.agent_eval_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_name text NOT NULL,
  prompt_version text NOT NULL,
  model text NOT NULL,
  model_id text,
  passed boolean NOT NULL,
  cost_usd numeric(10, 6) NOT NULL,
  tokens_in integer NOT NULL,
  tokens_out integer NOT NULL,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_eval_baselines_case_created_idx
  ON public.agent_eval_baselines(case_name, created_at DESC);

COMMENT ON TABLE public.agent_eval_baselines IS
  'Per-case eval baselines for cost + latency regression detection. The runner writes a row after each eval and compares against the most-recent prior baseline for the same case_name + prompt_version. CI fails if cost > 2x or duration > 1.5x prior baseline. Longevity L5a, 2026-05-13.';

ALTER TABLE public.agent_eval_baselines ENABLE ROW LEVEL SECURITY;
-- No SELECT/UPDATE policies — service role only via supabaseAdmin.

-- ── L7a: account-tier-based cost caps ────────────────────────────────
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS ai_cost_tier text NOT NULL DEFAULT 'free'
  CHECK (ai_cost_tier IN ('free', 'pro', 'enterprise'));

COMMENT ON COLUMN public.accounts.ai_cost_tier IS
  'Cost-cap tier for this account: free ($10/day), pro ($50/day), enterprise (custom). Drives caps in src/lib/agent/cost-controls.ts. Longevity L7a, 2026-05-13.';

-- ── L2a wiring: bump staxis_record_assistant_turn to accept p_prompt_version ──
-- 9-arg variant. Drops the 8-arg from migration 0094 so application
-- code must update — fails loudly on schema drift.
CREATE OR REPLACE FUNCTION public.staxis_record_assistant_turn(
  p_conversation_id uuid,
  p_text text,
  p_tool_calls jsonb,
  p_tokens_in integer,
  p_tokens_out integer,
  p_model text,
  p_model_id text,
  p_cost_usd numeric,
  p_prompt_version text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_call jsonb;
BEGIN
  IF p_text IS NOT NULL AND length(p_text) > 0 THEN
    INSERT INTO public.agent_messages (
      conversation_id, role, content,
      tokens_in, tokens_out, model_used, model_id, cost_usd, prompt_version
    ) VALUES (
      p_conversation_id, 'assistant', p_text,
      p_tokens_in, p_tokens_out, p_model, p_model_id, p_cost_usd, p_prompt_version
    );
  END IF;

  IF p_tool_calls IS NOT NULL AND jsonb_typeof(p_tool_calls) = 'array' THEN
    FOR v_call IN SELECT * FROM jsonb_array_elements(p_tool_calls)
    LOOP
      INSERT INTO public.agent_messages (
        conversation_id, role,
        tool_call_id, tool_name, tool_args, prompt_version
      ) VALUES (
        p_conversation_id, 'assistant',
        v_call->>'id',
        v_call->>'name',
        coalesce(v_call->'args', '{}'::jsonb),
        p_prompt_version
      );
    END LOOP;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric, text) IS
  'Atomic assistant turn write with prompt_version. Replaces 8-arg variant from migration 0094. Longevity L2a, 2026-05-13.';

REVOKE EXECUTE ON FUNCTION public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric, text) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric, text) TO   service_role;

DROP FUNCTION IF EXISTS public.staxis_record_assistant_turn(uuid, text, jsonb, integer, integer, text, text, numeric);

INSERT INTO public.applied_migrations (version, description)
VALUES ('0100', 'Longevity foundation: prompt_version per msg + msg_count trigger + eval baselines + account tier')
ON CONFLICT (version) DO NOTHING;
