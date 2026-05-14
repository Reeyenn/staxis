-- Migration 0112: preserve auto_fill_enabled_at on inventory retrain.
--
-- Codex round-4 adversarial review 2026-05-13 (Senior eng HIGH F3):
-- migrations 0110 + 0111 set
--   auto_fill_enabled_at = case when (p_fields auto_fill_enabled boolean)
--                           then now() else null end
-- Python passes auto_fill_enabled=true on every retrain of a graduated
-- model. So a model that graduated 6 weeks ago gets auto_fill_enabled_at
-- reset to now() every Sunday — violating migration 0062's column comment
-- ("Timestamp when auto_fill_enabled most recently flipped to true").
--
-- No UI consumer reads it today, but the bug is latent: a future
-- "model graduated N days ago" indicator or "models stable for >30d"
-- query would be wrong fleet-wide.
--
-- Fix: SELECT the existing active row's auto_fill_enabled_at BEFORE
-- deactivating, then on the new INSERT preserve the original timestamp
-- when both old + new are auto_fill_enabled=true. Otherwise behave as
-- before:
--   new=true, old=true       → preserve old auto_fill_enabled_at
--   new=true, old=false/null → now() (genuinely first-time graduation)
--   new=false                → null
--
-- This migration redefines staxis_install_inventory_model_run only.
-- The housekeeping RPC (demand+supply, migration 0107/0111) doesn't
-- have an auto_fill_enabled column — those models grow active/inactive
-- only via the activation gate, no separate "auto_fill" graduation.

create or replace function public.staxis_install_inventory_model_run(
  p_property_id        uuid,
  p_item_id            uuid,
  p_fields             jsonb,
  p_should_activate    boolean,
  p_should_shadow      boolean
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
  v_known_fields constant text[] := ARRAY[
    'trained_at', 'training_row_count', 'feature_set_version',
    'model_version', 'algorithm',
    'training_mae', 'validation_mae', 'baseline_mae', 'beats_baseline_pct',
    'validation_holdout_n', 'shadow_started_at', 'consecutive_passing_runs',
    'auto_fill_enabled', 'posterior_params', 'hyperparameters', 'notes'
  ];
  v_unknown_keys text[];
  -- F3: capture the existing active row's auto_fill_enabled_at BEFORE
  -- the deactivate so we can preserve it on the new row when this
  -- retrain stays graduated.
  v_existing_auto_fill_at timestamptz;
  v_new_auto_fill_enabled boolean := coalesce((p_fields->>'auto_fill_enabled')::boolean, false);
  v_resolved_auto_fill_at timestamptz;
begin
  -- Round-3 D5: surface unknown JSONB keys.
  select array_agg(k) into v_unknown_keys
    from jsonb_object_keys(p_fields) k
    where k <> all (v_known_fields);
  if v_unknown_keys is not null and array_length(v_unknown_keys, 1) > 0 then
    raise notice 'staxis_install_inventory_model_run: unknown field(s) silently ignored: %', v_unknown_keys;
  end if;

  v_lock_key := ('x' || substr(md5('inventory_regular_install:' || p_property_id::text || ':' || p_item_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  if p_should_activate and p_should_shadow then
    return query select false, 'invalid_mode_active_and_shadow'::text, null::uuid;
    return;
  end if;

  -- F3: capture existing active row's auto_fill_enabled_at IF this
  -- retrain is going to also be active AND auto_fill_enabled. Done
  -- BEFORE the deactivate update so we don't lose the timestamp.
  if p_should_activate and v_new_auto_fill_enabled then
    select auto_fill_enabled_at
      into v_existing_auto_fill_at
      from public.model_runs
     where property_id = p_property_id
       and layer = 'inventory_rate'
       and item_id = p_item_id
       and is_active = true
       and is_shadow = false
       and auto_fill_enabled = true
     limit 1;
  end if;

  -- Resolve the new row's auto_fill_enabled_at:
  --   new=false                  → null
  --   new=true,  preserved found → keep the original graduation ts
  --   new=true,  no prior graduation → now() (first-time graduation)
  if not v_new_auto_fill_enabled then
    v_resolved_auto_fill_at := null;
  elsif v_existing_auto_fill_at is not null then
    v_resolved_auto_fill_at := v_existing_auto_fill_at;
  else
    v_resolved_auto_fill_at := now();
  end if;

  if p_should_activate then
    update public.model_runs
       set is_active = false,
           deactivated_at = now(),
           deactivation_reason = coalesce(deactivation_reason, 'superseded_by_new_training_run')
     where property_id = p_property_id
       and layer = 'inventory_rate'
       and item_id = p_item_id
       and is_active = true
       and is_shadow = false;
  end if;

  if p_should_shadow then
    update public.model_runs
       set is_shadow = false,
           is_active = false,
           deactivated_at = now(),
           deactivation_reason = coalesce(deactivation_reason, 'superseded_by_new_shadow')
     where property_id = p_property_id
       and layer = 'inventory_rate'
       and item_id = p_item_id
       and is_shadow = true
       and shadow_promoted_at is null;
  end if;

  insert into public.model_runs (
    property_id, layer, item_id, trained_at,
    training_row_count, feature_set_version, model_version, algorithm,
    training_mae, validation_mae, baseline_mae, beats_baseline_pct,
    validation_holdout_n,
    is_active, is_shadow, activated_at, shadow_started_at,
    consecutive_passing_runs,
    auto_fill_enabled, auto_fill_enabled_at,
    posterior_params, hyperparameters, notes
  ) values (
    p_property_id,
    'inventory_rate',
    p_item_id,
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
    p_should_shadow,
    case when p_should_activate then now() else null end,
    case when p_should_shadow then coalesce((p_fields->>'shadow_started_at')::timestamptz, now()) else null end,
    coalesce((p_fields->>'consecutive_passing_runs')::integer, 0),
    v_new_auto_fill_enabled,
    v_resolved_auto_fill_at,  -- F3: preserved when continuing graduation
    case when p_fields ? 'posterior_params' and (p_fields->'posterior_params')::text <> 'null'
         then p_fields->'posterior_params'
         else null end,
    case when p_fields ? 'hyperparameters' and (p_fields->'hyperparameters')::text <> 'null'
         then p_fields->'hyperparameters'
         else null end,
    p_fields->>'notes'
  )
  returning id into v_new_id;

  return query select true, null::text, v_new_id;
end;
$$;

comment on function public.staxis_install_inventory_model_run is
  'Atomic deactivate-then-insert for inventory_rate model_runs (mig 0110+0111). '
  'Round-4 F3: now preserves auto_fill_enabled_at across retrains so the '
  'graduation timestamp matches when the model actually first flipped to '
  'auto_fill_enabled=true (not the most recent retrain).';

revoke all on function public.staxis_install_inventory_model_run(uuid, uuid, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.staxis_install_inventory_model_run(uuid, uuid, jsonb, boolean, boolean) to service_role;

insert into public.applied_migrations (version, description)
values ('0112', 'Codex round-4 F3: preserve auto_fill_enabled_at across inventory retrains')
on conflict (version) do nothing;
