-- Migration 0107: atomic deactivate-then-insert for demand + supply training.
--
-- Codex adversarial review 2026-05-13 (A6): the demand and supply training
-- paths in ml-service/src/training/{demand,supply}.py do
--   client.insert("model_runs", { ..., is_active: should_activate, ... })
-- without first deactivating any existing active model for the same
-- (property_id, layer). The schema partial-unique index
-- `model_runs_active_housekeeping_uq` (migration 0062) enforces ONE active
-- non-item model per (property, layer). At the boundary where Phase 3.2
-- Option B flips a model's would-be activation from true to false and a
-- subsequent run flips back to true, the insert can hit the unique
-- constraint and throw — the cron's response handler maps non-JSON failures
-- to 'non_json_response', so the heartbeat goes green while the model is
-- silently broken.
--
-- This migration mirrors 0087's cold-start RPC pattern but for demand +
-- supply (no item_id):
--   • Per-(property, layer) advisory lock so concurrent trainings serialize
--   • Conditional deactivate of existing active row when should_activate=true
--   • Insert the new model_runs row
--   • Returns the new id
-- Skips is_shadow=true rows so the shadow-evaluation track stays intact.

create or replace function public.staxis_install_housekeeping_model_run(
  p_property_id        uuid,
  p_layer              text,
  p_fields             jsonb,
  p_should_activate    boolean
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
  v_new_id uuid;
begin
  -- Layer guard: this function is for demand + supply only. Inventory
  -- training has its own per-item RPC (staxis_install_cold_start_model_run).
  if p_layer not in ('demand', 'supply') then
    return query select false, 'invalid_layer:' || p_layer, null::uuid;
    return;
  end if;

  -- Per-(property, layer) advisory lock. Same hash pattern as other
  -- staxis_* RPCs so we can mix this with related work in one txn.
  v_lock_key := ('x' || substr(md5('housekeeping_model_install:' || p_property_id::text || ':' || p_layer), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- If we're activating a new model, deactivate any existing active row
  -- for this (property, layer). Skips is_shadow=true rows — those are on
  -- a separate soak-then-promote track managed by the shadow-evaluate cron.
  -- When p_should_activate is false, no deactivation needed (the new row
  -- won't conflict with the partial unique index).
  if p_should_activate then
    update public.model_runs
       set is_active = false,
           deactivated_at = now(),
           deactivation_reason = coalesce(deactivation_reason, 'superseded_by_new_training_run')
     where property_id = p_property_id
       and layer = p_layer
       and item_id is null            -- housekeeping models have no item
       and is_active = true
       and is_shadow = false;
  end if;

  -- Insert the new row. p_fields is the entire row payload as JSONB
  -- (mirrors how the Python client.insert() builds it). We extract the
  -- known columns and let unknown keys be ignored. The is_active and
  -- activated_at columns are sourced from p_should_activate so the
  -- caller can't desync them.
  insert into public.model_runs (
    property_id, layer, item_id, trained_at,
    training_row_count, feature_set_version, model_version, algorithm,
    training_mae, validation_mae, baseline_mae, beats_baseline_pct,
    validation_holdout_n, is_active, activated_at,
    consecutive_passing_runs, posterior_params, hyperparameters
  ) values (
    p_property_id,
    p_layer,
    null,
    coalesce((p_fields->>'trained_at')::timestamptz, now()),
    coalesce((p_fields->>'training_row_count')::integer, 0),
    coalesce(p_fields->>'feature_set_version', 'v1'),
    p_fields->>'model_version',
    p_fields->>'algorithm',
    nullif(p_fields->>'training_mae', '')::numeric,
    nullif(p_fields->>'validation_mae', '')::numeric,
    nullif(p_fields->>'baseline_mae', '')::numeric,
    nullif(p_fields->>'beats_baseline_pct', '')::numeric,
    coalesce((p_fields->>'validation_holdout_n')::integer, 0),
    p_should_activate,
    case when p_should_activate then now() else null end,
    coalesce((p_fields->>'consecutive_passing_runs')::integer, 0),
    case when p_fields ? 'posterior_params' and (p_fields->'posterior_params')::text <> 'null'
         then p_fields->'posterior_params'
         else null end,
    case when p_fields ? 'hyperparameters' and (p_fields->'hyperparameters')::text <> 'null'
         then p_fields->'hyperparameters'
         else null end
  )
  returning id into v_new_id;

  return query select true, null::text, v_new_id;
end;
$$;

comment on function public.staxis_install_housekeeping_model_run is
  'Atomic deactivate-then-insert for demand+supply model_runs. Wraps the supersede '
  'pattern in a single transaction with a per-(property,layer) advisory lock so '
  'two concurrent trainings can''t both insert is_active=true and fight the partial '
  'unique index. Skips is_shadow=true rows. Codex adversarial review 2026-05-13 (A6).';

revoke all on function public.staxis_install_housekeeping_model_run(uuid, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.staxis_install_housekeeping_model_run(uuid, text, jsonb, boolean) to service_role;

insert into public.applied_migrations (version, description)
values ('0107', 'Codex review A6: atomic deactivate-then-insert RPC for demand+supply training')
on conflict (version) do nothing;
