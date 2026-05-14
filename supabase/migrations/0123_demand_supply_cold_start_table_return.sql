-- Phase M3.1 (2026-05-14): two structural changes that come together.
--
-- 1. model_runs.is_cold_start boolean — canonical, queryable flag for
--    "this row is a cohort-prior cold-start, not a fitted model". M3
--    relied on string-matching algorithm = 'cold-start-cohort-prior',
--    which is fragile against renames and harder to query in analytics.
--    The MlHealthPanel + admin/ml-health route are switching to read
--    is_cold_start instead.
--
-- 2. staxis_install_demand_supply_cold_start RPC — return TABLE(ok,
--    reason, model_run_id) instead of bare uuid (NULL = skip). Aligns
--    with the inventory cold-start RPC pattern (migration 0097 returns
--    the same triple). Benefits:
--      - One mental model for ML cold-start across inventory + demand +
--        supply. No "remember which one returns scalar."
--      - Refusal reason is canonical + queryable (was previously
--        invented in Python from a NULL return, brittle).
--      - Defensive caller unpacking matches inventory_rate.py:904-905
--        which has been hardened against supabase-py shape drift.

-- ─── Column 1: is_cold_start flag ───────────────────────────────────────

ALTER TABLE public.model_runs
  ADD COLUMN IF NOT EXISTS is_cold_start boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.model_runs.is_cold_start IS
  'True when this run was installed as a cold-start cohort prior (no local data fit). The cold-start install RPCs (staxis_install_demand_supply_cold_start, staxis_install_cold_start_model_run for inventory) set this to true. MlHealthPanel + admin/ml-health route use this as the source-of-truth flag. The algorithm string is preserved for analytics queries but is no longer the source-of-truth. Phase M3.1.';

-- One-shot backfill: any existing cold-start row identified by the legacy
-- algorithm string. Idempotent — re-running the migration is a no-op.
UPDATE public.model_runs
   SET is_cold_start = true
 WHERE algorithm = 'cold-start-cohort-prior'
   AND is_cold_start = false;

-- Index to support MlHealthPanel queries that filter by is_cold_start
-- (small partial index; only indexes the rows that need it).
CREATE INDEX IF NOT EXISTS model_runs_is_cold_start_active_idx
  ON public.model_runs (property_id, layer)
  WHERE is_cold_start = true AND is_active = true;

-- ─── RPC: replace uuid return with TABLE(ok, reason, model_run_id) ──────
--
-- Migration 0122's RPC returned `uuid` (NULL=skip). Caller unpacked
-- `rpc_result.data` as the bare value. Two failure modes:
--   - supabase-py shape drift: some versions wrap scalar returns as
--     [{"funcname": "uuid"}], breaking the bare-value assumption silently.
--   - Refusal carries no reason — caller invents one in Python which
--     could lie if a future RETURN NULL path is added.
--
-- Match the inventory pattern (migration 0097) by returning a 3-tuple.

CREATE OR REPLACE FUNCTION public.staxis_install_demand_supply_cold_start(
  p_property_id uuid,
  p_layer text,
  p_model_version text,
  p_posterior_params jsonb,
  p_hyperparameters jsonb
) RETURNS TABLE(
  ok boolean,
  reason text,
  model_run_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_algo text;
  v_lock_key bigint;
  v_new_id uuid;
BEGIN
  IF p_layer NOT IN ('demand', 'supply') THEN
    RAISE EXCEPTION 'staxis_install_demand_supply_cold_start: p_layer must be demand or supply, got %', p_layer;
  END IF;

  v_lock_key := abs(hashtextextended(format('cold_start_dsh:%s:%s', p_property_id, p_layer), 0));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT algorithm INTO v_existing_algo
  FROM public.model_runs
  WHERE property_id = p_property_id
    AND layer = p_layer
    AND is_active = true
    AND is_shadow = false
  LIMIT 1;

  IF v_existing_algo IS NOT NULL AND v_existing_algo != 'cold-start-cohort-prior' THEN
    -- Phase M3.1: explicit refusal reason replaces M3's NULL-as-skip.
    RETURN QUERY SELECT false, 'graduated_model_active'::text, NULL::uuid;
    RETURN;
  END IF;

  -- Deactivate any existing cold-start row (we're replacing it with a
  -- fresh one from a possibly-updated cohort prior).
  UPDATE public.model_runs
  SET is_active = false,
      deactivated_at = now(),
      deactivation_reason = 'replaced_by_fresh_cold_start'
  WHERE property_id = p_property_id
    AND layer = p_layer
    AND is_active = true
    AND is_shadow = false
    AND algorithm = 'cold-start-cohort-prior';

  -- Insert the new cold-start row. Phase M3.1: explicitly set is_cold_start
  -- so MlHealthPanel + ml-health route can read the canonical flag instead
  -- of string-matching the algorithm column.
  INSERT INTO public.model_runs (
    property_id, layer, algorithm, model_version, training_row_count,
    posterior_params, hyperparameters, is_active, is_cold_start, activated_at
  ) VALUES (
    p_property_id, p_layer, 'cold-start-cohort-prior', p_model_version, 0,
    p_posterior_params, p_hyperparameters, true, true, now()
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT true, NULL::text, v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.staxis_install_demand_supply_cold_start(
  uuid, text, text, jsonb, jsonb
) TO service_role;

COMMENT ON FUNCTION public.staxis_install_demand_supply_cold_start IS
  'Atomic install of a cold-start model_runs row for demand/supply layers. Returns (ok=true, reason=null, model_run_id=<uuid>) on success, (ok=false, reason=''graduated_model_active'', model_run_id=null) when a non-cold-start active model exists (refused to clobber). Sets is_cold_start=true on the new row. Phase M3.1 — replaces M3''s scalar uuid return.';

-- ─── Self-register ──────────────────────────────────────────────────────

INSERT INTO public.applied_migrations (version, description)
VALUES ('0123', 'Phase M3.1: model_runs.is_cold_start column + RPC returns TABLE(ok, reason, model_run_id)')
ON CONFLICT (version) DO NOTHING;
