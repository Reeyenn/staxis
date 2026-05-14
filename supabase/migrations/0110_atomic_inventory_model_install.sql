-- Migration 0110: atomic deactivate-then-insert for inventory_rate training.
-- (Renumbered from 0108 — agent-layer Claude session shipped 0108+0109 first.)
--
-- Codex round-3 adversarial review 2026-05-13 (Senior eng HIGH #1): Phase A
-- (commit 11b9c7e, migration 0107) added the atomic RPC for demand+supply
-- training. Cold-start uses migration 0087's RPC. But the REGULAR inventory
-- training path (Bayesian/XGBoost after the graduation gate) at
-- ml-service/src/training/inventory_rate.py:600-661 still does:
--   1. client.update("model_runs", {is_active: false}, where=...)
--   2. client.insert("model_runs", {is_active: true, ...})
-- as two separate Supabase calls. Same race window A6 was supposed to close
-- fleet-wide. The exception handler at line 617 swallows partial-unique-index
-- rejections — function returns model_run_id=None while logs claim training
-- succeeded.
--
-- This RPC mirrors 0107's pattern but adds:
--   - p_item_id (inventory has per-item models — partial-unique index
--     model_runs_one_active_per_item_idx from migration 0072)
--   - p_should_shadow path (inventory has separate active vs shadow tracks;
--     shadows accumulate weekly until shadow-evaluate cron promotes/rejects)
--
-- Lock key: (property_id, item_id) so two concurrent retrains for the SAME
-- item serialize, but trainings for DIFFERENT items in the same property
-- proceed in parallel.

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
begin
  -- Per-(property, item) advisory lock — distinct lock space from the
  -- cold-start RPC (0087) so cold-start and regular path don't interfere.
  v_lock_key := ('x' || substr(md5('inventory_regular_install:' || p_property_id::text || ':' || p_item_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- Mutually exclusive: a row can't be both active AND shadow.
  if p_should_activate and p_should_shadow then
    return query select false, 'invalid_mode_active_and_shadow'::text, null::uuid;
    return;
  end if;

  -- Active path: clear the previous active row for (property, item).
  -- Skips is_shadow=true rows (separate track maintained by the
  -- shadow-evaluate cron).
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

  -- Shadow path: clear in-flight shadows (not yet promoted) for the same
  -- (property, item) so weekly retrains don't accumulate shadows
  -- indefinitely. Only touches rows with shadow_promoted_at IS NULL.
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

  -- Insert the new row. p_fields is the entire row payload as JSONB.
  -- is_active / is_shadow / activated_at sourced from the boolean params
  -- so caller can't desync. shadow_started_at + auto_fill_enabled +
  -- auto_fill_enabled_at sourced from p_fields.
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
  'Atomic deactivate-then-insert for inventory_rate model_runs (regular Bayesian/XGBoost path, NOT cold-start). Wraps deactivate + insert in one '
  'transaction with per-(property, item) advisory lock. Mutually-exclusive '
  'p_should_activate + p_should_shadow drive separate deactivate paths. '
  'Codex round-3 adversarial review 2026-05-13 (Senior eng HIGH #1).';

revoke all on function public.staxis_install_inventory_model_run(uuid, uuid, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.staxis_install_inventory_model_run(uuid, uuid, jsonb, boolean, boolean) to service_role;

insert into public.applied_migrations (version, description)
values ('0110', 'Codex round-3 D1: atomic deactivate-then-insert RPC for inventory_rate regular training path')
on conflict (version) do nothing;
