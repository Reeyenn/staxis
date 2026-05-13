-- Migration 0098: round-8 fixes — dedupe preflight + finalize state-guard
--
-- Codex round-8 adversarial review (2026-05-13) caught two real issues:
--
-- B1 [high functional]: migration 0094 shipped the unique index
--   `agent_messages(conversation_id, tool_call_id) WHERE role='tool'`
--   WITHOUT first detecting/resolving legacy duplicate rows. Our prod
--   DB happened to be clean (the migration succeeded), but any other
--   environment with even one duplicate would have aborted the
--   migration mid-flight — leaving the new 8-arg
--   staxis_record_assistant_turn RPC uncreated and the deployed app
--   hitting a "function not found" wall after deploy. This migration
--   adds a forward-fix preflight that deduplicates safely + re-asserts
--   the index (idempotent via IF NOT EXISTS).
--
-- B6 [functional]: staxis_finalize_agent_spend (from migration 0081)
--   has only `WHERE id = p_reservation_id`. No state or swept_at
--   guard. So when the sweeper wins a race against a legit finalize,
--   the swept row gets cost_usd overwritten to the actual value BUT
--   keeps swept_at set. The /admin/agent metrics filter excludes
--   swept_at IS NOT NULL — the actual cost is in the DB but invisible
--   to operators. This migration replaces the RPC with a version
--   that adds the guard and raises an exception when the target is
--   already finalized/swept, so the route's 3-retry + audit-row path
--   from round 7 catches it cleanly.

-- ─── B1 preflight: dedupe + re-assert 0094's index ────────────────────
-- Keep the chronologically-earliest row for each (conv_id, tool_call_id),
-- delete the rest. Idempotent: run on a clean DB and DELETE affects 0 rows.
WITH dupes AS (
  SELECT conversation_id, tool_call_id, MIN(created_at) AS keep_created
  FROM public.agent_messages
  WHERE role = 'tool' AND tool_call_id IS NOT NULL
  GROUP BY conversation_id, tool_call_id
  HAVING count(*) > 1
)
DELETE FROM public.agent_messages m
USING dupes d
WHERE m.conversation_id = d.conversation_id
  AND m.tool_call_id    = d.tool_call_id
  AND m.role            = 'tool'
  AND m.created_at      > d.keep_created;

-- Re-assert the unique index from 0094 (idempotent — IF NOT EXISTS).
-- Belt-and-suspenders: if 0094 succeeded on this DB this is a no-op;
-- if it aborted before reaching the CREATE INDEX, this creates it now.
CREATE UNIQUE INDEX IF NOT EXISTS agent_messages_tool_result_uq
  ON public.agent_messages(conversation_id, tool_call_id)
  WHERE role = 'tool' AND tool_call_id IS NOT NULL;

-- ─── B6: finalize state-guard ─────────────────────────────────────────
-- Replace staxis_finalize_agent_spend with a version that refuses to
-- write when the row is no longer in 'reserved' state OR has been
-- swept (swept_at IS NOT NULL). Raises an exception so the JS-side
-- 3-retry-then-audit-row path (round 7 F1) catches and writes to
-- agent_cost_finalize_failures — operator-visible on /admin/agent.
CREATE OR REPLACE FUNCTION public.staxis_finalize_agent_spend(
  p_reservation_id uuid,
  p_conversation_id uuid,
  p_actual_usd numeric,
  p_model text,
  p_model_id text,
  p_tokens_in integer,
  p_tokens_out integer,
  p_cached_input_tokens integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.agent_costs
  SET state               = 'finalized',
      conversation_id     = p_conversation_id,
      cost_usd            = p_actual_usd,
      model               = p_model,
      model_id            = p_model_id,
      tokens_in           = p_tokens_in,
      tokens_out          = p_tokens_out,
      cached_input_tokens = p_cached_input_tokens
  WHERE id           = p_reservation_id
    AND state        = 'reserved'
    AND swept_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'finalize_target_unavailable'
      USING DETAIL = 'reservation ' || p_reservation_id::text || ' is already finalized or swept';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) IS
  'Reconcile a reservation to actual spend. Refuses (raises finalize_target_unavailable) if the row has already been finalized or swept — protects the sweeper-vs-finalize race from quietly losing spend visibility. Codex round-8 fix B6, 2026-05-13.';

REVOKE EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) FROM public;
REVOKE EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.staxis_finalize_agent_spend(uuid, uuid, numeric, text, text, integer, integer, integer) TO   service_role;

INSERT INTO public.applied_migrations (version, description)
VALUES ('0098', 'Codex round-8: dedupe preflight (B1) + finalize state-guard (B6)')
ON CONFLICT (version) DO NOTHING;
