-- Phase M3 (2026-05-14): cohort priors for demand + supply layers.
--
-- Why this exists (root cause, not band-aid):
--   Inventory ML works from Day 1 for any new hotel via cohort priors:
--   1. ml-aggregate-priors cron fills inventory_rate_priors with median
--      per-(cohort, item) rates aggregated from all properties.
--   2. When training a new hotel's inventory model, if local data < 3
--      events, the training path consults the cohort prior, writes a
--      'cold-start-cohort-prior' model_runs row, and inference produces
--      reasonable predictions immediately.
--
--   Demand + supply have ZERO cold-start mechanism today. Their training
--   functions return early when local data < 14 days, leaving NEW hotels
--   without any active model and zero predictions for the first 2 weeks
--   of operation. The Optimizer (which depends on both) can't run either.
--
--   The fix is structural: clone inventory's cohort-prior table + cold-
--   start path for demand and supply. Lowering the training threshold
--   would be a band-aid (training on 5 days of noise produces garbage).
--
-- Schema mirrors inventory_rate_priors (migration 0062) exactly so we
-- get the same operational surface (idempotent upsert, source-tagged,
-- prior_strength weighting against the local Bayesian posterior).
--
-- Source values:
--   'industry-benchmark' — hardcoded seed below; covers Day 1 of the
--                          first hotel before any cohort data exists
--   'cohort-aggregate'   — written by aggregate_demand_priors() /
--                          aggregate_supply_priors() once 5+ hotels
--                          share a cohort

CREATE TABLE IF NOT EXISTS public.demand_priors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_key text NOT NULL,
  prior_minutes_per_room_per_day numeric(10,4) NOT NULL,
  n_hotels_contributing integer NOT NULL DEFAULT 0,
  prior_strength numeric(6,2) NOT NULL DEFAULT 1.0,
  source text NOT NULL DEFAULT 'industry-benchmark'
    CHECK (source IN ('industry-benchmark', 'cohort-aggregate')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_key)
);

CREATE INDEX IF NOT EXISTS demand_priors_cohort_idx
  ON public.demand_priors (cohort_key);

ALTER TABLE public.demand_priors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read demand_priors" ON public.demand_priors;
CREATE POLICY "auth read demand_priors"
  ON public.demand_priors FOR SELECT
  TO authenticated
  USING (true);

CREATE TABLE IF NOT EXISTS public.supply_priors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_key text NOT NULL,
  prior_minutes_per_event numeric(10,4) NOT NULL,
  n_hotels_contributing integer NOT NULL DEFAULT 0,
  prior_strength numeric(6,2) NOT NULL DEFAULT 1.0,
  source text NOT NULL DEFAULT 'industry-benchmark'
    CHECK (source IN ('industry-benchmark', 'cohort-aggregate')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cohort_key)
);

CREATE INDEX IF NOT EXISTS supply_priors_cohort_idx
  ON public.supply_priors (cohort_key);

ALTER TABLE public.supply_priors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read supply_priors" ON public.supply_priors;
CREATE POLICY "auth read supply_priors"
  ON public.supply_priors FOR SELECT
  TO authenticated
  USING (true);

-- ─── Industry-benchmark seeds ────────────────────────────────────────────
-- These cover Day 1 of the FIRST hotel onboarded — before any cohort
-- aggregation can run. Numbers are reasoned from limited-service hotel
-- norms:
--   demand:  20 min/room/day = ~30min cleaning × 67% avg occupancy
--   supply:  30 min/event    = standard checkout cleaning time
-- prior_strength=0.5 is intentionally weak so the local Bayesian posterior
-- dominates as soon as 14+ days of real data accumulate.
INSERT INTO public.demand_priors (cohort_key, prior_minutes_per_room_per_day, source, prior_strength)
VALUES ('industry-default', 20.0, 'industry-benchmark', 0.5)
ON CONFLICT (cohort_key) DO NOTHING;

INSERT INTO public.supply_priors (cohort_key, prior_minutes_per_event, source, prior_strength)
VALUES ('industry-default', 30.0, 'industry-benchmark', 0.5)
ON CONFLICT (cohort_key) DO NOTHING;

-- ─── RPC: atomic install of cold-start model_run for demand/supply ───────
-- Mirrors staxis_install_cold_start_model_run for inventory (migration
-- 0086). Atomicity matters because:
--   1. The model_runs_active_housekeeping_uq partial unique index forbids
--      two active rows for (property_id, layer) for demand/supply/optimizer.
--   2. Without a transaction, deactivate-then-insert can race against a
--      concurrent training run.
--   3. We must NOT clobber a real graduated (Bayesian/XGBoost) model with
--      a cold-start prior — only install if the current active model
--      either doesn't exist OR is itself a cold-start.
CREATE OR REPLACE FUNCTION public.staxis_install_demand_supply_cold_start(
  p_property_id uuid,
  p_layer text,
  p_model_version text,
  p_posterior_params jsonb,
  p_hyperparameters jsonb
) RETURNS uuid
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

  -- Per-(property, layer) advisory lock prevents two concurrent installers
  -- from racing each other.
  v_lock_key := abs(hashtextextended(format('cold_start_dsh:%s:%s', p_property_id, p_layer), 0));
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Check what's currently active. If a non-cold-start model is active,
  -- refuse to clobber it (the training path may have flapped back to
  -- "insufficient data" but we'd lose a real model).
  SELECT algorithm INTO v_existing_algo
  FROM public.model_runs
  WHERE property_id = p_property_id
    AND layer = p_layer
    AND is_active = true
    AND is_shadow = false
  LIMIT 1;

  IF v_existing_algo IS NOT NULL AND v_existing_algo != 'cold-start-cohort-prior' THEN
    RAISE NOTICE 'staxis_install_demand_supply_cold_start: refusing to clobber active % model with algorithm=%', p_layer, v_existing_algo;
    RETURN NULL;
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

  -- Insert the new cold-start row.
  INSERT INTO public.model_runs (
    property_id, layer, algorithm, model_version, training_row_count,
    posterior_params, hyperparameters, is_active, activated_at
  ) VALUES (
    p_property_id, p_layer, 'cold-start-cohort-prior', p_model_version, 0,
    p_posterior_params, p_hyperparameters, true, now()
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.staxis_install_demand_supply_cold_start
  TO service_role;

INSERT INTO public.applied_migrations (version, description)
VALUES ('0122', 'Phase M3: demand_priors + supply_priors tables + cold-start install RPC')
ON CONFLICT (version) DO NOTHING;
