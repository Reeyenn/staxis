-- Migration 0091: cold-start RPC validates (property_id, item_id) parent-child
--
-- Codex post-merge review (2026-05-13) finding N4: the cold-start RPC from
-- migration 0087 accepts p_property_id and p_item_id as independent UUIDs
-- with no check that inventory(id=p_item_id) actually belongs to p_property_id.
-- A mis-call (or a future caller other than the service-role ML service)
-- could pollute model_runs with cross-property associations:
--   model_runs.property_id = A, item_id = B (where B belongs to C)
-- The downstream _lookup_prior_with_source by (property_id, item_id) would
-- then attach the wrong canonical_name/cohort prior at next training run.
--
-- This migration adds a parent-child guard at the top of the function body.

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
  -- Codex post-merge review (N4): refuse if (p_property_id, p_item_id) is
  -- not a valid parent-child pair. Has to come BEFORE the advisory lock —
  -- no point holding a lock for a request we're going to refuse.
  if not exists (
    select 1 from public.inventory
     where id = p_item_id and property_id = p_property_id
  ) then
    return query select false, 'item_property_mismatch'::text, null::uuid;
    return;
  end if;

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
  'Atomic deactivate-then-insert for cold-start model_runs. Refuses cross-property (property_id, item_id) pairs (Codex post-merge N4). Refuses to clobber graduated active models. Skips is_shadow=true rows so shadows soak undisturbed. Codex adversarial review 2026-05-13 (M-C8 + N4).';

revoke all on function public.staxis_install_cold_start_model_run(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.staxis_install_cold_start_model_run(uuid, uuid, text, jsonb, jsonb) to service_role;

insert into public.applied_migrations (version, description)
values ('0097', 'Codex post-merge review: cold-start RPC parent-child guard (N4)')
on conflict (version) do nothing;
