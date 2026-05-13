-- Migration 0086: atomic cold-start model installation
--
-- Adversarial review (2026-05-13) finding M-C8: ml-service/src/training/
-- inventory_rate.py:807-846 has two related bugs in the cold-start path:
--
--   1. Deactivation does NOT filter by is_shadow=False, so a recently-
--      promoted shadow that hasn't graduated yet gets killed alongside
--      the prior active.
--
--   2. Deactivate-then-insert is two separate Supabase calls. Two
--      concurrent trainings for the same (property, item) can both
--      complete the deactivation, both insert is_active=true, and end up
--      with two active rows (or zero, depending on race outcome). The
--      partial-unique-index that's supposed to prevent this is fragile
--      against concurrent multi-statement work.
--
--   3. The cold-start path will REPLACE a real graduated model if cold-
--      start runs again (e.g. after retention purges old counts and the
--      gate condition flips back to "insufficient data").
--
-- Fix: a single Postgres function that does deactivate + insert in one
-- transaction with a row-level lock on the model_runs partition for this
-- (property, layer, item). Refuses to run if a real graduated active model
-- already exists (validation_mae IS NOT NULL and algorithm is not
-- 'cold-start-cohort-prior').

create or replace function public.staxis_install_cold_start_model_run(
  p_property_id      uuid,
  p_item_id          uuid,
  p_model_version    text,
  p_posterior_params jsonb,
  p_hyperparameters  jsonb
)
returns table(
  ok            boolean,
  reason        text,
  model_run_id  uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_lock_key bigint;
  v_existing_graduated_count int;
  v_new_id uuid;
begin
  -- Per-(property, item) advisory lock so two concurrent cold-start trainings
  -- for the same item serialize. Same hash pattern as other staxis_* RPCs.
  v_lock_key := ('x' || substr(md5('inventory_cold_start:' || p_property_id::text || ':' || p_item_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Refuse to clobber a real graduated model. Cold-start should only fill
  -- the gap when the real model isn't there.
  select count(*)
    into v_existing_graduated_count
    from public.model_runs
    where property_id = p_property_id
      and layer = 'inventory_rate'
      and item_id = p_item_id
      and is_active = true
      and is_shadow = false
      and validation_mae is not null
      and (algorithm is null or algorithm <> 'cold-start-cohort-prior');

  if v_existing_graduated_count > 0 then
    return query select false, 'graduated_model_active'::text, null::uuid;
    return;
  end if;

  -- Deactivate prior active rows for this (property, layer, item).
  -- IMPORTANT: do NOT touch is_shadow=true rows. Shadows are a separate
  -- track being soaked for graduation; killing them would lose validation
  -- evidence the shadow-evaluate cron needs.
  update public.model_runs
    set is_active = false,
        deactivated_at = now(),
        deactivation_reason = coalesce(deactivation_reason, 'superseded_by_cold_start')
    where property_id = p_property_id
      and layer = 'inventory_rate'
      and item_id = p_item_id
      and is_active = true
      and is_shadow = false;

  -- Insert the new cold-start row.
  insert into public.model_runs (
    property_id, layer, item_id, trained_at,
    training_row_count, feature_set_version, model_version, algorithm,
    training_mae, validation_mae, baseline_mae, beats_baseline_pct,
    validation_holdout_n, is_active, activated_at,
    consecutive_passing_runs, auto_fill_enabled, auto_fill_enabled_at,
    posterior_params, hyperparameters
  ) values (
    p_property_id, 'inventory_rate', p_item_id, now(),
    0, 'v1', p_model_version, 'cold-start-cohort-prior',
    null, null, null, null,
    0, true, now(),
    0, false, null,
    p_posterior_params, p_hyperparameters
  )
  returning id into v_new_id;

  return query select true, null::text, v_new_id;
end;
$$;

comment on function public.staxis_install_cold_start_model_run is
  'Atomic deactivate-then-insert for cold-start model_runs. Refuses to clobber an existing graduated active model (validation_mae IS NOT NULL and algorithm <> cold-start-cohort-prior). Skips is_shadow=true rows so shadows soak undisturbed. Codex adversarial review 2026-05-13 (M-C8).';

revoke all on function public.staxis_install_cold_start_model_run(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.staxis_install_cold_start_model_run(uuid, uuid, text, jsonb, jsonb) to service_role;

insert into public.applied_migrations (version, description)
values ('0087', 'Codex review: atomic cold-start model install with shadow-preserving deactivate (M-C8)')
on conflict (version) do nothing;
