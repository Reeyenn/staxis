-- Migration 0111: RAISE NOTICE on unknown JSONB fields in the housekeeping
-- + inventory model-install RPCs.
--
-- Codex round-3 adversarial review 2026-05-13 (Senior eng HIGH #5):
-- migrations 0107 + 0110 take p_fields jsonb and extract a hardcoded list
-- of column names. A future caller adding a new column (say
-- `feature_importance`) would have it silently dropped — no NOTICE, no
-- WARNING, no operator-visible signal that the contract drifted.
--
-- Fix: at the start of each install RPC, diff jsonb_object_keys(p_fields)
-- against the known set and `raise notice` for unknown keys. Doesn't fail
-- the call (forward compatibility — callers can keep adding fields without
-- breaking deploys), but the next operator looking at Postgres logs after
-- a failed model_runs query will see the dropped field name immediately.
--
-- Both RPCs (0107 housekeeping + 0110 inventory) get the check.

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
  v_known_fields constant text[] := ARRAY[
    'trained_at', 'training_row_count', 'feature_set_version',
    'model_version', 'algorithm',
    'training_mae', 'validation_mae', 'baseline_mae', 'beats_baseline_pct',
    'validation_holdout_n', 'consecutive_passing_runs',
    'posterior_params', 'hyperparameters'
  ];
  v_unknown_keys text[];
begin
  if p_layer not in ('demand', 'supply') then
    return query select false, 'invalid_layer:' || p_layer, null::uuid;
    return;
  end if;

  -- Codex round-3 D5: surface unknown JSONB keys via RAISE NOTICE.
  -- Forward-compatible (doesn't fail the call); operator sees the
  -- dropped field name in Postgres logs.
  select array_agg(k) into v_unknown_keys
    from jsonb_object_keys(p_fields) k
    where k <> all (v_known_fields);
  if v_unknown_keys is not null and array_length(v_unknown_keys, 1) > 0 then
    raise notice 'staxis_install_housekeeping_model_run: unknown field(s) silently ignored: %', v_unknown_keys;
  end if;

  v_lock_key := ('x' || substr(md5('housekeeping_model_install:' || p_property_id::text || ':' || p_layer), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  if p_should_activate then
    update public.model_runs
       set is_active = false,
           deactivated_at = now(),
           deactivation_reason = coalesce(deactivation_reason, 'superseded_by_new_training_run')
     where property_id = p_property_id
       and layer = p_layer
       and item_id is null
       and is_active = true
       and is_shadow = false;
  end if;

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
  'Atomic deactivate-then-insert for demand+supply model_runs (mig 0107). '
  'Round-3 D5: now RAISE NOTICE on unknown JSONB fields in p_fields so '
  'a future schema drift surfaces in Postgres logs instead of silently '
  'dropping the new column.';

revoke all on function public.staxis_install_housekeeping_model_run(uuid, text, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.staxis_install_housekeeping_model_run(uuid, text, jsonb, boolean) to service_role;


-- Same RAISE NOTICE for the inventory RPC (migration 0110).
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
begin
  -- Codex round-3 D5.
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
    coalesce((p_fields->>'auto_fill_enabled')::boolean, false),
    case when (p_fields->>'auto_fill_enabled')::boolean then now() else null end,
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
  'Atomic deactivate-then-insert for inventory_rate model_runs (mig 0110). '
  'Round-3 D5: now RAISE NOTICE on unknown JSONB fields.';

revoke all on function public.staxis_install_inventory_model_run(uuid, uuid, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.staxis_install_inventory_model_run(uuid, uuid, jsonb, boolean, boolean) to service_role;

insert into public.applied_migrations (version, description)
values ('0111', 'Codex round-3 D5: RAISE NOTICE on unknown JSONB fields in 0107+0110 RPCs')
on conflict (version) do nothing;
