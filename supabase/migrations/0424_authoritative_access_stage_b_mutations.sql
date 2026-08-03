-- 0424_authoritative_access_stage_b_mutations.sql
--
-- Stage B application mutation boundary.  The application no longer writes
-- accounts.property_access or treats that column as an access mutation input.
-- This migration keeps the Stage A array/translator available for rollback-era
-- deployments, but imports a legacy account into the canonical bridge model
-- inside one service-only transaction before changing its scope.

begin;

do $$
begin
  if to_regprocedure('public.staxis_list_account_authorized_properties(uuid)') is null
     or to_regprocedure('public._staxis_cutover_valid_current_primary_property_relationships()') is null
     or to_regprocedure('public._staxis_cutover_real_account_organizations()') is null
     or to_regprocedure('public._staxis_structural_account_property_ids(uuid)') is null
     or to_regclass('public.account_authorization_state') is null
     or to_regclass('public.account_property_authorization_bridges') is null
  then
    raise exception '0424 requires the Stage A canonical authority, topology, state, and bridge objects';
  end if;
end
$$;

-- Validate a legacy/shadow snapshot without changing any authorization row.
-- Mutation RPCs call this before the first import in a transaction, so a
-- rejected scope, detach, or ownership request cannot leave an earlier
-- account partially normalized.  Keep the topology and real-company
-- predicate byte-for-byte aligned with the Stage A cutover helpers.
create or replace function public._staxis_stage_b_validate_legacy_scope(
  p_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_property_id uuid;
  v_property_ids uuid[] := '{}'::uuid[];
  v_raw_relationship_count integer;
  v_valid_relationship_count integer;
  v_relationship_id uuid;
  v_organization_id uuid;
  v_organization_type text;
begin
  if p_account_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select account.* into v_account
  from public.accounts account
  where account.id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'account_not_found');
  end if;
  if v_account.active is not true then
    return jsonb_build_object('ok', false, 'reason', 'account_inactive');
  end if;

  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing');
  end if;
  if v_state.authority_mode = 'normalized' then
    return jsonb_build_object(
      'ok', true,
      'status', 'already_normalized',
      'accountId', p_account_id,
      'propertyIds', to_jsonb(public._staxis_structural_account_property_ids(p_account_id))
    );
  end if;
  if v_state.authority_mode not in ('legacy', 'shadow') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_authority_mode');
  end if;

  if v_account.data_user_id is null
     or not exists (
       select 1 from auth.users auth_user where auth_user.id = v_account.data_user_id
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'auth_identity_missing');
  end if;
  if v_account.role is null
     or v_account.role not in (
       'admin', 'owner', 'general_manager', 'front_desk',
       'housekeeping', 'maintenance', 'staff'
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_account_role');
  end if;
  if v_account.role = 'admin'
     and cardinality(coalesce(v_account.property_access, '{}'::uuid[])) > 0
  then
    return jsonb_build_object('ok', false, 'reason', 'admin_legacy_access');
  end if;
  if array_position(coalesce(v_account.property_access, '{}'::uuid[]), null) is not null
     or cardinality(coalesce(v_account.property_access, '{}'::uuid[]))
          <> cardinality(array(
            select distinct id
            from unnest(coalesce(v_account.property_access, '{}'::uuid[])) ids(id)
          ))
  then
    return jsonb_build_object('ok', false, 'reason', 'legacy_scope_invalid');
  end if;

  select coalesce(array_agg(id order by id), '{}'::uuid[])
    into v_property_ids
  from (
    select distinct id
    from unnest(coalesce(v_account.property_access, '{}'::uuid[])) ids(id)
  ) sorted_ids;

  foreach v_property_id in array v_property_ids
  loop
    if not exists (
      select 1 from public.properties property where property.id = v_property_id
    ) then
      return jsonb_build_object(
        'ok', false, 'reason', 'property_missing', 'propertyId', v_property_id
      );
    end if;

    select count(*)::integer
      into v_raw_relationship_count
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id;
    if v_raw_relationship_count = 0 then
      return jsonb_build_object(
        'ok', false, 'reason', 'governing_topology_missing', 'propertyId', v_property_id
      );
    end if;
    if v_raw_relationship_count <> 1 then
      return jsonb_build_object(
        'ok', false, 'reason', 'ambiguous_governing_topology', 'propertyId', v_property_id
      );
    end if;

    select count(*)::integer,
           (array_agg(relationship.id order by relationship.id))[1],
           (array_agg(relationship.organization_id order by relationship.id))[1],
           (array_agg(relationship.organization_type order by relationship.id))[1]
      into v_valid_relationship_count, v_relationship_id,
           v_organization_id, v_organization_type
    from public._staxis_cutover_valid_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id
      and relationship.active_primary_count = 1;
    if v_valid_relationship_count <> 1 then
      return jsonb_build_object(
        'ok', false, 'reason', 'invalid_governing_organization', 'propertyId', v_property_id
      );
    end if;

    if v_organization_type <> 'single_hotel'
       and exists (
         select 1
         from public._staxis_cutover_real_account_organizations() real_org
         where real_org.account_id = p_account_id
       )
       and not exists (
         select 1
         from public._staxis_cutover_real_account_organizations() real_org
         where real_org.account_id = p_account_id
           and real_org.organization_id = v_organization_id
       )
    then
      return jsonb_build_object(
        'ok', false, 'reason', 'cross_company_legacy_access', 'propertyId', v_property_id
      );
    end if;

    if exists (
      select 1
      from public.account_property_authorization_bridges bridge
      where bridge.account_id = p_account_id
        and bridge.property_id = v_property_id
        and bridge.status = 'retired'
    ) then
      return jsonb_build_object(
        'ok', false, 'reason', 'retired_bridge', 'propertyId', v_property_id
      );
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'status', 'validated',
    'accountId', p_account_id,
    'propertyIds', to_jsonb(v_property_ids)
  );
end;
$$;

revoke all on function public._staxis_stage_b_validate_legacy_scope(uuid)
  from public, anon, authenticated, service_role;

-- Import the still-present legacy snapshot only inside the canonical mutation
-- boundary.  This is not an application reader: it is the one-way rollback
-- compatibility receipt that makes a legacy/shadow account normalized before
-- the new application changes its scope.  Every row is validated first, so a
-- missing, ambiguous, stale, cross-company, retired, inactive, or unlinked
-- legacy fact aborts the import without dropping or guessing any access.
create or replace function public._staxis_stage_b_import_legacy_scope(
  p_account_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_property_id uuid;
  v_property_ids uuid[] := '{}'::uuid[];
  v_legacy_hash text;
  v_raw_relationship_count integer;
  v_valid_relationship_count integer;
  v_relationship_id uuid;
  v_organization_id uuid;
  v_organization_type text;
  v_validation jsonb;
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'Stage B canonical mutation'), 500);
begin
  if p_account_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select account.* into v_account
  from public.accounts account
  where account.id = p_account_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'account_not_found');
  end if;
  if v_account.active is not true then
    return jsonb_build_object('ok', false, 'reason', 'account_inactive');
  end if;

  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing');
  end if;
  if v_state.authority_mode = 'normalized' then
    return jsonb_build_object(
      'ok', true,
      'status', 'already_normalized',
      'accountId', p_account_id,
      'propertyIds', '[]'::jsonb,
      'authorityVersion', v_state.authority_version
    );
  end if;
  if v_state.authority_mode not in ('legacy', 'shadow') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_authority_mode');
  end if;

  v_validation := public._staxis_stage_b_validate_legacy_scope(p_account_id);
  if coalesce((v_validation->>'ok')::boolean, false) is not true then
    return v_validation;
  end if;

  if v_account.data_user_id is null
     or not exists (
       select 1 from auth.users auth_user where auth_user.id = v_account.data_user_id
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'auth_identity_missing');
  end if;
  if v_account.role is null
     or v_account.role not in (
       'admin', 'owner', 'general_manager', 'front_desk',
       'housekeeping', 'maintenance', 'staff'
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_account_role');
  end if;
  if v_account.role = 'admin'
     and cardinality(coalesce(v_account.property_access, '{}'::uuid[])) > 0
  then
    return jsonb_build_object('ok', false, 'reason', 'admin_legacy_access');
  end if;
  if array_position(coalesce(v_account.property_access, '{}'::uuid[]), null) is not null
     or cardinality(coalesce(v_account.property_access, '{}'::uuid[]))
          <> cardinality(array(
            select distinct id
            from unnest(coalesce(v_account.property_access, '{}'::uuid[])) ids(id)
          ))
  then
    return jsonb_build_object('ok', false, 'reason', 'legacy_scope_invalid');
  end if;

  select coalesce(array_agg(id order by id), '{}'::uuid[])
    into v_property_ids
  from (
    select distinct id
    from unnest(coalesce(v_account.property_access, '{}'::uuid[])) ids(id)
  ) sorted_ids;
  select encode(sha256(convert_to(coalesce((
    select string_agg(id::text, ',' order by id::text)
    from unnest(v_property_ids) ids(id)
  ), ''), 'UTF8')), 'hex')
    into v_legacy_hash;

  -- First pass: validate every legacy row without changing any canonical
  -- table.  The second pass below is therefore all-or-nothing even when the
  -- caller asks to translate a multi-hotel account.
  foreach v_property_id in array v_property_ids
  loop
    if not exists (
      select 1 from public.properties property where property.id = v_property_id
    ) then
      return jsonb_build_object(
        'ok', false, 'reason', 'property_missing', 'propertyId', v_property_id
      );
    end if;

    select count(*)::integer
      into v_raw_relationship_count
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id;
    if v_raw_relationship_count = 0 then
      return jsonb_build_object(
        'ok', false, 'reason', 'governing_topology_missing', 'propertyId', v_property_id
      );
    end if;
    if v_raw_relationship_count <> 1 then
      return jsonb_build_object(
        'ok', false, 'reason', 'ambiguous_governing_topology', 'propertyId', v_property_id
      );
    end if;

    select count(*)::integer,
           (array_agg(relationship.id order by relationship.id))[1],
           (array_agg(relationship.organization_id order by relationship.id))[1],
           (array_agg(relationship.organization_type order by relationship.id))[1]
      into v_valid_relationship_count, v_relationship_id,
           v_organization_id, v_organization_type
    from public._staxis_cutover_valid_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id
      and relationship.active_primary_count = 1;
    if v_valid_relationship_count <> 1 then
      return jsonb_build_object(
        'ok', false, 'reason', 'invalid_governing_organization', 'propertyId', v_property_id
      );
    end if;

    if v_organization_type <> 'single_hotel'
       and exists (
         select 1
         from public._staxis_cutover_real_account_organizations() real_org
         where real_org.account_id = p_account_id
       )
       and not exists (
         select 1
         from public._staxis_cutover_real_account_organizations() real_org
         where real_org.account_id = p_account_id
           and real_org.organization_id = v_organization_id
       )
    then
      return jsonb_build_object(
        'ok', false, 'reason', 'cross_company_legacy_access', 'propertyId', v_property_id
      );
    end if;

    if exists (
      select 1
      from public.account_property_authorization_bridges bridge
      where bridge.account_id = p_account_id
        and bridge.property_id = v_property_id
        and bridge.status = 'retired'
    ) then
      return jsonb_build_object(
        'ok', false, 'reason', 'retired_bridge', 'propertyId', v_property_id
      );
    end if;
  end loop;

  foreach v_property_id in array v_property_ids
  loop
    select relationship.id, relationship.organization_id
      into v_relationship_id, v_organization_id
    from public._staxis_cutover_valid_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id
      and relationship.active_primary_count = 1;

    insert into public.account_property_authorization_bridges (
      account_id, property_id, cutover_organization_id,
      cutover_relationship_id, source_legacy_scope_hash, cutover_reason
    ) values (
      p_account_id, v_property_id, v_organization_id,
      v_relationship_id, coalesce(v_legacy_hash, ''), v_reason
    )
    on conflict (account_id, property_id) where status = 'active' do nothing;
  end loop;

  update public.account_authorization_state state
     set authority_mode = 'normalized',
         cutover_at = coalesce(state.cutover_at, clock_timestamp()),
         cutover_reason = coalesce(state.cutover_reason, v_reason),
         updated_at = clock_timestamp()
   where state.account_id = p_account_id;
  perform public._staxis_refresh_account_authorization(
    p_account_id, 'Stage B legacy scope import'
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'imported',
    'accountId', p_account_id,
    'propertyIds', to_jsonb(v_property_ids)
  );
end;
$$;

revoke all on function public._staxis_stage_b_import_legacy_scope(uuid, text)
  from public, anon, authenticated, service_role;

-- 0395's profile RPC accepts both a rollback-era raw-array CAS receipt and a
-- canonical target-property CAS receipt. The Stage B route deliberately sends
-- canonical IDs in both fields, so preserve the old raw-array comparison only
-- for legacy/shadow accounts and make normalized self-edits compare the
-- canonical IDs while ignoring the stale rollback snapshot.
do $$
begin
  if to_regprocedure(
       'public.staxis_update_hotel_team_profile_guarded(uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,uuid[],uuid[],text,uuid,timestamptz,bigint,text)'
     ) is not null
     and to_regprocedure(
       'public._staxis_update_hotel_team_profile_guarded_legacy_cas(uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,uuid[],uuid[],text,uuid,timestamptz,bigint,text)'
     ) is null
  then
    alter function public.staxis_update_hotel_team_profile_guarded(
      uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,
      uuid[],uuid[],text,uuid,timestamptz,bigint,text
    ) rename to _staxis_update_hotel_team_profile_guarded_legacy_cas;
  end if;
end
$$;

create or replace function public.staxis_update_hotel_team_profile_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_change_display_name boolean,
  p_new_display_name text,
  p_change_staff_link boolean,
  p_new_staff_id uuid,
  p_expected_active boolean,
  p_expected_role text,
  p_expected_auth_user_id uuid,
  p_expected_property_access uuid[],
  p_expected_target_property_ids uuid[],
  p_expected_display_name text,
  p_expected_staff_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_intent_version bigint,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_authority_mode text;
  v_raw_property_access uuid[];
begin
  select state.authority_mode, account.property_access
    into v_authority_mode, v_raw_property_access
  from public.account_authorization_state state
  join public.accounts account on account.id = state.account_id
  where state.account_id = p_target_account_id;

  if v_authority_mode = 'normalized' then
    -- The canonical target IDs remain the authoritative CAS. The raw array is
    -- rollback material and may legitimately differ or be empty.
    p_expected_property_access := coalesce(v_raw_property_access, '{}'::uuid[]);
  end if;

  return public._staxis_update_hotel_team_profile_guarded_legacy_cas(
    p_actor_account_id,
    p_actor_auth_user_id,
    p_actor_email,
    p_hotel_id,
    p_target_account_id,
    p_change_display_name,
    p_new_display_name,
    p_change_staff_link,
    p_new_staff_id,
    p_expected_active,
    p_expected_role,
    p_expected_auth_user_id,
    p_expected_property_access,
    p_expected_target_property_ids,
    p_expected_display_name,
    p_expected_staff_id,
    p_expected_updated_at,
    p_expected_intent_version,
    p_request_id
  );
end;
$$;

revoke all on function public._staxis_update_hotel_team_profile_guarded_legacy_cas(
  uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,
  uuid[],uuid[],text,uuid,timestamptz,bigint,text
) from public, anon, authenticated, service_role;
revoke all on function public.staxis_update_hotel_team_profile_guarded(
  uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,
  uuid[],uuid[],text,uuid,timestamptz,bigint,text
) from public, anon, authenticated;
grant execute on function public.staxis_update_hotel_team_profile_guarded(
  uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,
  uuid[],uuid[],text,uuid,timestamptz,bigint,text
) to service_role;

-- Administrative resolver for account CRUD.  Unlike the operational resolver,
-- this reports structural canonical scope for an inactive account so an admin
-- can edit a disabled profile without reading the rollback array from the
-- application.  It never grants access: the normal resolver still requires
-- an active account for every operational decision.
create or replace function public.staxis_list_account_authorization_admin(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_property_ids uuid[] := '{}'::uuid[];
begin
  if p_account_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  select account.* into v_account from public.accounts account where account.id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'account_not_found');
  end if;
  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing');
  end if;
  if v_account.role = 'admin' then
    return jsonb_build_object(
      'ok', true, 'all', true, 'active', v_account.active,
      'authorityMode', v_state.authority_mode,
      'authorityVersion', v_state.authority_version,
      'propertyIds', '[]'::jsonb
    );
  end if;
  v_property_ids := public._staxis_structural_account_property_ids(p_account_id);
  return jsonb_build_object(
    'ok', true, 'all', false, 'active', v_account.active,
    'authorityMode', v_state.authority_mode,
    'authorityVersion', v_state.authority_version,
    'propertyIds', to_jsonb(v_property_ids)
  );
end;
$$;

revoke all on function public.staxis_list_account_authorization_admin(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_list_account_authorization_admin(uuid)
  to service_role;

-- Platform-admin account CRUD scope mutation.  The actor is checked inside the
-- transaction rather than relying only on the route, and all requested scope
-- rows are topology-bound canonical bridges.  A retired bridge is a durable
-- revoke and cannot be resurrected by retrying an older request.
create or replace function public.staxis_set_account_authorization_scope(
  p_actor_account_id uuid,
  p_account_id uuid,
  p_property_ids uuid[],
  p_expected_authority_version bigint,
  p_expected_role text,
  p_new_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_requested uuid[] := '{}'::uuid[];
  v_property_id uuid;
  v_raw_relationship_count integer;
  v_valid_relationship_count integer;
  v_relationship_id uuid;
  v_organization_id uuid;
  v_organization_type text;
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'Platform-admin canonical scope mutation'), 500);
  v_import jsonb;
  v_access jsonb;
  v_role text;
begin
  if p_actor_account_id is null
     or p_account_id is null
     or p_property_ids is null
     or p_new_role is null
     or p_new_role not in (
       'admin', 'owner', 'general_manager', 'front_desk',
       'housekeeping', 'maintenance', 'staff'
     )
     or p_expected_role is null
  then
    return jsonb_build_object('ok', false, 'status', 'invalid', 'reason', 'request');
  end if;
  if array_position(p_property_ids, null) is not null
     or cardinality(p_property_ids) > 5000
     or cardinality(p_property_ids)
          <> cardinality(array(select distinct id from unnest(p_property_ids) ids(id)))
  then
    return jsonb_build_object('ok', false, 'status', 'invalid', 'reason', 'property_ids');
  end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[])
    into v_requested
  from (
    select distinct id from unnest(p_property_ids) ids(id)
  ) sorted_ids;
  if p_new_role = 'admin' and cardinality(v_requested) > 0 then
    return jsonb_build_object('ok', false, 'status', 'invalid', 'reason', 'admin_scope');
  end if;

  perform 1
  from public.accounts account
  where account.id = any(array[p_actor_account_id, p_account_id])
  order by account.id
  for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_account from public.accounts where id = p_account_id;
  select * into v_state from public.account_authorization_state
    where account_id = p_account_id
    for update;
  if v_actor.id is null or v_account.id is null or v_state.account_id is null then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;
  if v_actor.active is not true or v_actor.role <> 'admin' then
    return jsonb_build_object('ok', false, 'status', 'forbidden', 'reason', 'actor');
  end if;
  if v_account.role is distinct from p_expected_role
     or (p_expected_authority_version is not null
         and v_state.authority_version is distinct from p_expected_authority_version)
  then
    return jsonb_build_object(
      'ok', false, 'status', 'conflict',
      'authorityVersion', v_state.authority_version
    );
  end if;

  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_property_relationships,
               public.organization_memberships,
               public.organization_access_grants,
               public.portfolios,
               public.portfolio_properties,
               public.account_property_authorization_bridges
      in share mode nowait;
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('ok', false, 'status', 'retry');
  end;

  begin
    for v_property_id in
      select requested.id
      from unnest(v_requested) requested(id)
      order by requested.id
    loop
      perform 1
      from public.properties property
      where property.id = v_property_id
      for update nowait;
      if not found then
        return jsonb_build_object(
          'ok', false, 'status', 'conflict', 'reason', 'property_missing',
          'propertyId', v_property_id
        );
      end if;
      perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
    end loop;
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('ok', false, 'status', 'retry');
  end;

  -- Validate every new canonical bridge before changing any bridge or role.
  -- These are explicit platform-admin assignments, so they may cross a
  -- customer organization; topology is still required and the bridge remains
  -- bound to the exact current relationship.
  foreach v_property_id in array v_requested
  loop
    if not exists (
      select 1 from public.properties property where property.id = v_property_id
    ) then
      return jsonb_build_object('ok', false, 'status', 'conflict', 'reason', 'property_missing');
    end if;
    select count(*)::integer into v_raw_relationship_count
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id;
    if v_raw_relationship_count <> 1 then
      return jsonb_build_object(
        'ok', false, 'status', 'conflict',
        'reason', case when v_raw_relationship_count = 0
          then 'governing_topology_missing' else 'ambiguous_governing_topology' end,
        'propertyId', v_property_id
      );
    end if;
    select count(*)::integer,
           (array_agg(relationship.id order by relationship.id))[1],
           (array_agg(relationship.organization_id order by relationship.id))[1],
           (array_agg(relationship.organization_type order by relationship.id))[1]
      into v_valid_relationship_count, v_relationship_id,
           v_organization_id, v_organization_type
    from public._staxis_cutover_valid_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id
      and relationship.active_primary_count = 1;
    if v_valid_relationship_count <> 1 then
      return jsonb_build_object(
        'ok', false, 'status', 'conflict',
        'reason', 'invalid_governing_organization', 'propertyId', v_property_id
      );
    end if;
    if exists (
      select 1
      from public.account_property_authorization_bridges bridge
      where bridge.account_id = p_account_id
        and bridge.property_id = v_property_id
        and bridge.status = 'retired'
    )
    then
      return jsonb_build_object(
        'ok', false, 'status', 'conflict',
        'reason', 'retired_bridge', 'propertyId', v_property_id
      );
    end if;
  end loop;

  -- Complete all rejectable request checks before importing a legacy/shadow
  -- snapshot. A failed request must leave bridges, state, and audit unchanged.
  if v_state.authority_mode in ('legacy', 'shadow') then
    v_import := public._staxis_stage_b_import_legacy_scope(
      p_account_id, 'Stage B account scope mutation import'
    );
    if coalesce((v_import->>'ok')::boolean, false) is not true then
      return v_import || jsonb_build_object('status', 'conflict');
    end if;
    select * into v_state from public.account_authorization_state
      where account_id = p_account_id
      for update;
  end if;

  if v_account.role is distinct from p_new_role then
    update public.accounts
       set role = p_new_role
     where id = p_account_id;
  end if;

  update public.account_property_authorization_bridges bridge
     set status = 'retired',
         retired_at = clock_timestamp(),
         retirement_reason = left('Canonical scope removed by platform admin: ' || v_reason, 500)
   where bridge.account_id = p_account_id
     and bridge.status = 'active'
     and not (bridge.property_id = any(v_requested));

  if p_new_role <> 'admin' then
    foreach v_property_id in array v_requested
    loop
      select relationship.id, relationship.organization_id
        into v_relationship_id, v_organization_id
      from public._staxis_cutover_valid_current_primary_property_relationships() relationship
      where relationship.property_id = v_property_id
        and relationship.active_primary_count = 1;
      insert into public.account_property_authorization_bridges (
        account_id, property_id, cutover_organization_id,
        cutover_relationship_id, source_legacy_scope_hash, cutover_reason
      ) values (
        p_account_id, v_property_id, v_organization_id,
        v_relationship_id, encode(sha256(convert_to(
          array_to_string(v_requested, ','), 'UTF8'
        )), 'hex'), v_reason
      )
      on conflict (account_id, property_id) where status = 'active' do nothing;
    end loop;
  end if;

  perform public._staxis_refresh_account_authorization(
    p_account_id, 'Stage B canonical account scope mutation'
  );
  select state.authority_version into v_state.authority_version
  from public.account_authorization_state state
  where state.account_id = p_account_id;
  v_role := p_new_role;
  if v_account.active is true then
    v_access := public.staxis_list_account_authorized_properties(p_account_id);
  else
    v_access := jsonb_build_object(
      'ok', true, 'all', p_new_role = 'admin',
      'propertyIds', to_jsonb(v_requested)
    );
  end if;
  return jsonb_build_object(
    'ok', true,
    'status', 'updated',
    'accountId', p_account_id,
    'role', v_role,
    'authorityVersion', v_state.authority_version,
    'access', v_access
  );
end;
$$;

revoke all on function public.staxis_set_account_authorization_scope(
  uuid, uuid, uuid[], bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.staxis_set_account_authorization_scope(
  uuid, uuid, uuid[], bigint, text, text, text
) to service_role;

-- Actor-bound hotel detach.  The old v2 RPC changed the legacy array.  Stage B
-- first imports a legacy/shadow target into canonical bridges and then retires
-- exactly one bridge; no access decision or mutation depends on the array.
create or replace function public.staxis_remove_property_access_authoritative(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_account_id uuid,
  p_hotel_id uuid,
  p_expected_role text,
  p_expected_authority_version bigint,
  p_expected_updated_at timestamptz,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_access jsonb;
  v_target_ids uuid[] := '{}'::uuid[];
  v_remaining integer := 0;
  v_import jsonb;
  v_actor_role text;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_account_id is null or p_hotel_id is null
     or p_expected_role is null or p_expected_updated_at is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_actor_account_id = p_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;

  perform 1
  from public.accounts account
  where account.id = any(array[p_actor_account_id, p_account_id])
  order by account.id
  for update;
  perform 1
  from public.account_authorization_state state
  where state.account_id = any(array[p_actor_account_id, p_account_id])
  order by state.account_id
  for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_account_id;
  select * into v_actor_state from public.account_authorization_state
    where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state
    where account_id = p_account_id;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null
     or v_target_state.account_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if exists (
    select 1
    from public.account_lifecycle_intents intent
    where intent.status = 'pending'
      and intent.account_id = any(array[p_actor_account_id, p_account_id])
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;

  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_property_relationships,
               public.organization_memberships,
               public.organization_access_grants,
               public.portfolios,
               public.portfolio_properties,
               public.account_property_authorization_bridges
      in share mode nowait;
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('status', 'retry');
  end;

  begin
    perform 1
    from public.properties property
    where property.id = p_hotel_id
    for update nowait;
    if not found then
      return jsonb_build_object('status', 'not_found', 'reason', 'hotel_scope');
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('status', 'retry');
  end;

  if v_actor.active is not true or v_actor.data_user_id is distinct from p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if v_target.active is not true or v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target');
  end if;
  if public._staxis_account_is_live_organization_owner(v_target.id) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'organization_owner');
  end if;
  if v_target.role is distinct from p_expected_role
     or v_target.updated_at is distinct from p_expected_updated_at
     or (p_expected_authority_version is not null
         and v_target_state.authority_version is distinct from p_expected_authority_version)
  then
    return jsonb_build_object('status', 'conflict');
  end if;

  if not public._staxis_account_can_manage_users_at_property(
    p_actor_account_id, p_hotel_id
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
  end if;
  if v_actor.role <> 'admin' and v_target.role = 'general_manager' then
    v_actor_role := public._staxis_account_operational_role_at_property(
      v_actor.id, p_hotel_id
    );
    if not public._staxis_account_has_company_manager_hierarchy_at_property(
         v_actor.id, p_hotel_id
       )
       and v_actor_role <> 'owner'
    then
      return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
    end if;
  end if;
  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  if coalesce((v_access->>'ok')::boolean, false) is not true then
    return jsonb_build_object('status', 'forbidden', 'reason', 'authority_unavailable');
  end if;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_target_ids
  from jsonb_array_elements_text(coalesce(v_access->'propertyIds', '[]'::jsonb)) value;
  if not (p_hotel_id = any(v_target_ids)) then
    return jsonb_build_object('status', 'not_attached');
  end if;

  -- Capability, hierarchy, CAS, and target-scope checks are all complete
  -- before the legacy snapshot is translated. The validator is read-only on
  -- failure, so a rejected detach cannot leave a bridge or state mutation.
  if v_target_state.authority_mode in ('legacy', 'shadow') then
    v_import := public._staxis_stage_b_import_legacy_scope(
      p_account_id, 'Stage B canonical hotel detach import'
    );
    if coalesce((v_import->>'ok')::boolean, false) is not true then
      return v_import || jsonb_build_object('status', 'conflict');
    end if;
    select * into v_target_state from public.account_authorization_state
      where account_id = p_account_id
      for update;
  end if;

  if not exists (
    select 1 from public.account_property_authorization_bridges bridge
    where bridge.account_id = p_account_id
      and bridge.property_id = p_hotel_id
      and bridge.status = 'active'
  ) then
    if v_import is not null then
      raise exception 'Stage B detach import completed without an active bridge'
        using errcode = 'P0001';
    end if;
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
  end if;

  update public.account_property_authorization_bridges bridge
     set status = 'retired',
         retired_at = clock_timestamp(),
         retirement_reason = left(
           'Canonical hotel detach: ' || coalesce(nullif(btrim(p_request_id), ''), 'request'),
           500
         )
   where bridge.account_id = p_account_id
     and bridge.property_id = p_hotel_id
     and bridge.status = 'active';
  perform public._staxis_refresh_account_authorization(
    p_account_id, 'Stage B canonical hotel detach'
  );
  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  v_remaining := jsonb_array_length(coalesce(v_access->'propertyIds', '[]'::jsonb));

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''),
    'account.team_detach', 'account', p_account_id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id,
      'remaining_hotels', v_remaining,
      'authority_mode', 'normalized',
      'request_id', p_request_id
    )
  );
  return jsonb_build_object(
    'status', 'ok',
    'remaining_hotels', v_remaining,
    'audit_written', true,
    'authorityVersion', (v_access->>'authorityVersion')::bigint
  );
end;
$$;

revoke all on function public.staxis_remove_property_access_authoritative(
  uuid, uuid, text, uuid, uuid, text, bigint, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.staxis_remove_property_access_authoritative(
  uuid, uuid, text, uuid, uuid, text, bigint, timestamptz, text
) to service_role;

-- The hotel ownership workflow is also the correct path for a normalized
-- independent property owner. A canonical bridge is eligible only when the
-- complete current scope is bridge-only and every property has exactly one
-- current primary relationship to an active single_hotel organization. A
-- company membership/grant, suspended organization, missing relationship, or
-- ambiguous topology keeps the account on the company path (or fails closed).
create or replace function public._staxis_stage_b_is_independent_single_hotel_scope(
  p_account_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.account_authorization_state state
    join public.accounts account on account.id = state.account_id
    where state.account_id = p_account_id
      and state.authority_mode = 'normalized'
      and account.role <> 'admin'
      and cardinality(public._staxis_structural_account_property_ids(p_account_id)) > 0
      and not exists (
        select 1
        from public._staxis_nonlegacy_property_authorizations(p_account_id)
      )
      and not exists (
        select 1
        from unnest(public._staxis_structural_account_property_ids(p_account_id)) scope(property_id)
        where (
          select count(*)::integer
          from public._staxis_current_primary_property_relationships() relationship
          where relationship.property_id = scope.property_id
        ) <> 1
        or (
          select count(*)::integer
          from public._staxis_cutover_valid_current_primary_property_relationships() relationship
          where relationship.property_id = scope.property_id
            and relationship.active_primary_count = 1
            and relationship.organization_type = 'single_hotel'
            and relationship.organization_status = 'active'
        ) <> 1
      )
  );
$$;

revoke all on function public._staxis_stage_b_is_independent_single_hotel_scope(uuid)
  from public, anon, authenticated, service_role;

-- Route a normalized bridge-only independent owner through the existing hotel
-- People/ownership surface. This is a projection choice only: authority still
-- comes from the canonical resolver and the guarded ownership RPC rechecks the
-- exact single_hotel topology, role, capability, and CAS.
create or replace function public.staxis_list_authoritative_hotel_accounts(
  p_property_id uuid,
  p_include_platform_admins boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_accounts jsonb;
begin
  if p_property_id is null or not exists (
    select 1 from public.properties property where property.id = p_property_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'property_not_found');
  end if;

  with roster as (
    select account.id, account.username, account.display_name, account.role,
           account.active, account.data_user_id, account.staff_id,
           account.created_at, account.updated_at, state.authority_mode,
           state.authority_version, structural.property_ids
    from public.accounts account
    join public.account_authorization_state state on state.account_id = account.id
    cross join lateral (
      select public._staxis_structural_account_property_ids(account.id) as property_ids
    ) structural
    where (account.role = 'admin' and account.active is true
           and p_include_platform_admins is true)
       or (account.role <> 'admin'
           and p_property_id = any(structural.property_ids))
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'accountId', roster.id,
           'username', roster.username,
           'displayName', roster.display_name,
           'role', roster.role,
           'active', roster.active,
           'dataUserId', roster.data_user_id,
           'staffId', roster.staff_id,
           'createdAt', roster.created_at,
           'updatedAt', roster.updated_at,
           'authorityMode', roster.authority_mode,
           'authorityVersion', roster.authority_version,
           'propertyIds', case when roster.role = 'admin' then '[]'::jsonb
             else to_jsonb(roster.property_ids) end,
           'managementSurface', case
             when roster.authority_mode = 'normalized'
                  and public._staxis_stage_b_is_independent_single_hotel_scope(roster.id)
               then 'legacy_hotel'
             when roster.authority_mode = 'normalized' then 'company_access'
             else 'legacy_hotel'
           end
         ) order by roster.created_at, roster.id), '[]'::jsonb)
    into v_count, v_accounts
  from roster;

  if v_count > 5000 then
    return jsonb_build_object('ok', false, 'reason', 'roster_too_large');
  end if;
  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'authoritative-hotel-roster-v1',
    'propertyId', p_property_id,
    'generatedAt', clock_timestamp(),
    'accounts', v_accounts
  );
end;
$$;

revoke all on function public.staxis_list_authoritative_hotel_accounts(uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.staxis_list_authoritative_hotel_accounts(uuid,boolean)
  to service_role;

-- The guarded ownership function retains its established signature and
-- idempotency contract, but its access snapshots are now canonical resolver
-- results. The arrays in the argument names remain only as rollback-era CAS
-- receipts; this implementation never reads or writes accounts.property_access.
create or replace function public.staxis_transfer_ownership_guarded(
  p_operation_id uuid,
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_property_id uuid,
  p_old_owner_account_id uuid,
  p_new_owner_account_id uuid,
  p_expected_old_active boolean,
  p_expected_old_role text,
  p_expected_old_auth_user_id uuid,
  p_expected_old_property_access uuid[],
  p_expected_old_intent_version bigint,
  p_expected_new_active boolean,
  p_expected_new_role text,
  p_expected_new_auth_user_id uuid,
  p_expected_new_property_access uuid[],
  p_expected_new_intent_version bigint,
  p_reason text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_old public.accounts%rowtype;
  v_new public.accounts%rowtype;
  v_actor_state public.account_authorization_state%rowtype;
  v_old_state public.account_authorization_state%rowtype;
  v_new_state public.account_authorization_state%rowtype;
  v_actor_access jsonb;
  v_old_access jsonb;
  v_new_access jsonb;
  v_old_ids uuid[] := '{}'::uuid[];
  v_new_ids uuid[] := '{}'::uuid[];
  v_actor_ids uuid[] := '{}'::uuid[];
  v_operation_audit boolean;
  v_import jsonb;
  v_property_id uuid;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_operation_id is null or p_actor_account_id is null
     or p_actor_auth_user_id is null or p_property_id is null
     or p_old_owner_account_id is null or p_new_owner_account_id is null
     or p_expected_old_active is null or p_expected_old_role is null
     or p_expected_old_auth_user_id is null or p_expected_old_property_access is null
     or p_expected_old_intent_version is null or p_expected_new_active is null
     or p_expected_new_role is null or p_expected_new_auth_user_id is null
     or p_expected_new_property_access is null or p_expected_new_intent_version is null
     or nullif(btrim(p_request_id), '') is null
     or char_length(btrim(p_request_id)) > 200
  then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_old_owner_account_id = p_new_owner_account_id then
    return jsonb_build_object('status', 'invalid', 'reason', 'same_account');
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    return jsonb_build_object('status', 'invalid', 'reason', 'reason');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('staxis.transfer-ownership:' || p_operation_id::text, 0)
  );
  perform 1
  from public.accounts account
  where account.id = any(array[
    p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id
  ])
  order by account.id
  for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_old from public.accounts where id = p_old_owner_account_id;
  select * into v_new from public.accounts where id = p_new_owner_account_id;
  if v_actor.id is null or v_old.id is null or v_new.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_actor.data_user_id is distinct from p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;

  perform 1
  from public.account_authorization_state state
  where state.account_id = any(array[
    p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id
  ])
  order by state.account_id
  for update;
  select * into v_actor_state from public.account_authorization_state
    where account_id = p_actor_account_id;
  select * into v_old_state from public.account_authorization_state
    where account_id = p_old_owner_account_id;
  select * into v_new_state from public.account_authorization_state
    where account_id = p_new_owner_account_id;
  if v_actor_state.account_id is null
     or v_old_state.account_id is null
     or v_new_state.account_id is null
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'authority_unavailable');
  end if;

  select exists (
    select 1 from public.admin_audit_log audit
    where audit.action = 'account.transfer_ownership'
      and audit.actor_user_id = p_actor_auth_user_id
      and audit.target_type = 'account'
      and audit.target_id = p_new_owner_account_id::text
      and audit.metadata->>'operation_id' = p_operation_id::text
      and audit.metadata->>'hotel_id' = p_property_id::text
      and audit.metadata->>'from_account_id' = p_old_owner_account_id::text
      and audit.metadata->>'to_account_id' = p_new_owner_account_id::text
  ) into v_operation_audit;
  if v_operation_audit then
    if v_old.role = 'general_manager' and v_new.role = 'owner' then
      return jsonb_build_object(
        'status', 'already_applied',
        'operation_id', p_operation_id,
        'old_owner_account_id', v_old.id,
        'new_owner_account_id', v_new.id
      );
    end if;
    return jsonb_build_object('status', 'conflict', 'reason', 'replay_state_changed');
  end if;
  if exists (
    select 1 from public.admin_audit_log audit
    where audit.action = 'account.transfer_ownership'
      and audit.metadata->>'operation_id' = p_operation_id::text
  ) then
    return jsonb_build_object('status', 'conflict', 'reason', 'operation_id_reused');
  end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
    where intent.status = 'pending'
      and intent.account_id = any(array[
        p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id
      ])
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;

  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_property_relationships,
               public.organization_memberships,
               public.organization_access_grants,
               public.portfolios,
               public.portfolio_properties,
               public.account_property_authorization_bridges
      in share mode nowait;
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('status', 'retry');
  end;

  -- This RPC remains the hotel ownership workflow. A normalized subject may
  -- use it only for an exact active independent single-hotel scope; a
  -- normalized company subject must use the company ownership flow. Legacy or
  -- shadow subjects are translated only after every rejection check below has
  -- completed, so a failed request cannot partially normalize its peers.
  if exists (
    select 1
    from unnest(array[
      p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id
    ]) subject(account_id)
    join public.accounts account on account.id = subject.account_id
    left join public.account_authorization_state state
      on state.account_id = account.id
    where (account.role <> 'admin' or subject.account_id <> p_actor_account_id)
      and (
        state.account_id is null
        or (
          state.authority_mode not in ('legacy', 'shadow')
          and not public._staxis_stage_b_is_independent_single_hotel_scope(subject.account_id)
        )
      )
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
  end if;

  -- Resolve the pre-translation scope once for topology containment. This is
  -- still inside the service-only database boundary; the application never
  -- reads the rollback array. It preserves the legacy workflow's precise
  -- company-owned-hotel denial before a failed import can report retired_bridge.
  v_actor_access := public.staxis_list_account_authorized_properties(v_actor.id);
  v_old_access := public.staxis_list_account_authorized_properties(v_old.id);
  v_new_access := public.staxis_list_account_authorized_properties(v_new.id);
  if coalesce((v_actor_access->>'ok')::boolean, false) is not true
     or coalesce((v_old_access->>'ok')::boolean, false) is not true
     or coalesce((v_new_access->>'ok')::boolean, false) is not true
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'authority_unavailable');
  end if;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_actor_ids from jsonb_array_elements_text(coalesce(v_actor_access->'propertyIds', '[]'::jsonb)) value;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_old_ids from jsonb_array_elements_text(coalesce(v_old_access->'propertyIds', '[]'::jsonb)) value;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_new_ids from jsonb_array_elements_text(coalesce(v_new_access->'propertyIds', '[]'::jsonb)) value;
  if not (p_property_id = any(v_old_ids))
     or not (p_property_id = any(v_new_ids))
  then
    return jsonb_build_object('status', 'not_found', 'reason', 'hotel_scope');
  end if;
  if v_old_ids is distinct from v_new_ids then
    return jsonb_build_object('status', 'conflict', 'reason', 'hotel_access_mismatch');
  end if;
  if exists (
    select 1
    from unnest(v_old_ids) affected(property_id)
    where affected.property_id is null
       or not exists (
         select 1
         from public._staxis_current_primary_property_relationships() relationship
         join public.organizations organization
           on organization.id = relationship.organization_id
          and organization.status = 'active'
          and organization.organization_type = 'single_hotel'
          and organization.legacy_property_id = affected.property_id
         where relationship.property_id = affected.property_id
           and relationship.active_primary_count = 1
       )
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'company_owned_hotel');
  end if;

  begin
    for v_property_id in
      select affected.id
      from unnest(v_old_ids) affected(id)
      where affected.id is not null
      order by affected.id
    loop
      perform 1
      from public.properties property
      where property.id = v_property_id
      for update nowait;
      if not found then
        return jsonb_build_object('status', 'not_found', 'reason', 'hotel_scope');
      end if;
      perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
    end loop;
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('status', 'retry');
  end;

  if v_actor.active is not true
     or v_old.role <> 'owner'
     or v_new.role in ('admin', 'owner')
     or not v_old.active or not v_new.active
     or p_expected_old_role <> 'owner'
     or p_expected_new_role in ('admin', 'owner')
  then
    return jsonb_build_object('status', 'invalid', 'reason', 'role_or_active');
  end if;
  if not (p_property_id = any(v_old_ids))
     or not (p_property_id = any(v_new_ids))
  then
    return jsonb_build_object('status', 'not_found', 'reason', 'hotel_scope');
  end if;
  if v_old_ids is distinct from v_new_ids then
    return jsonb_build_object('status', 'conflict', 'reason', 'hotel_access_mismatch');
  end if;
  if v_old_ids is distinct from p_expected_old_property_access
     or v_new_ids is distinct from p_expected_new_property_access
     or v_old.active is distinct from p_expected_old_active
     or v_old.role is distinct from p_expected_old_role
     or v_old.data_user_id is distinct from p_expected_old_auth_user_id
     or v_old.lifecycle_intent_version is distinct from p_expected_old_intent_version
     or v_new.active is distinct from p_expected_new_active
     or v_new.role is distinct from p_expected_new_role
     or v_new.data_user_id is distinct from p_expected_new_auth_user_id
     or v_new.lifecycle_intent_version is distinct from p_expected_new_intent_version
  then
    return jsonb_build_object('status', 'conflict');
  end if;
  if v_actor.role <> 'admin'
     and (
       v_actor.id is distinct from v_old.id
       or v_actor.role is distinct from 'owner'
     )
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'current_owner');
  end if;
  if v_actor.role <> 'admin'
     and (
       not (p_property_id = any(v_actor_ids))
       or not (v_old_ids <@ v_actor_ids)
       or not (v_new_ids <@ v_actor_ids)
     )
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'scope');
  end if;
  if v_actor.role <> 'admin'
     and exists (
       select 1
       from unnest(v_old_ids) affected(property_id)
       join public.capability_overrides override_row
         on override_row.property_id = affected.property_id
        and override_row.capability = 'manage_users'
        and override_row.role = v_actor.role
        and override_row.allowed is false
     )
  then
    return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
  end if;

  if exists (
    select 1
    from unnest(v_old_ids) affected(property_id)
    where affected.property_id is null
       or not exists (
         select 1
         from public._staxis_current_primary_property_relationships() relationship
         join public.organizations organization
           on organization.id = relationship.organization_id
          and organization.status = 'active'
          and organization.organization_type = 'single_hotel'
          and organization.legacy_property_id = affected.property_id
         where relationship.property_id = affected.property_id
           and relationship.active_primary_count = 1
       )
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'company_owned_hotel');
  end if;

  if exists (
    select 1
    where public._staxis_account_is_live_organization_owner(v_old.id)
       or public._staxis_account_is_live_organization_owner(v_new.id)
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_organization_owner');
  end if;

  -- Preflight every legacy/shadow subject before importing any one of them.
  -- This keeps a missing identity, inactive account, retired bridge, or other
  -- unresolved peer from leaving a partially normalized ownership transfer.
  for v_property_id in
    select distinct subject.account_id
    from unnest(array[
      p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id
    ]) subject(account_id)
    join public.account_authorization_state state
      on state.account_id = subject.account_id
     and state.authority_mode in ('legacy', 'shadow')
    -- A platform admin is an explicit customer-context actor, not a hotel
    -- subject.  Importing its empty rollback-era array would normalize it and
    -- bump its canonical authority version during an unrelated transfer.
    where not (
      subject.account_id = p_actor_account_id
      and v_actor.role = 'admin'
    )
  loop
    v_import := public._staxis_stage_b_validate_legacy_scope(v_property_id);
    if coalesce((v_import->>'ok')::boolean, false) is not true then
      return v_import || jsonb_build_object('status', 'conflict');
    end if;
  end loop;

  -- All rejection paths are now behind us. The import helper is expected to
  -- succeed for each prevalidated row; an impossible post-lock discrepancy
  -- raises so PostgreSQL rolls the whole guarded mutation back.
  for v_property_id in
    select distinct subject.account_id
    from unnest(array[
      p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id
    ]) subject(account_id)
    join public.account_authorization_state state
      on state.account_id = subject.account_id
     and state.authority_mode in ('legacy', 'shadow')
    where not (
      subject.account_id = p_actor_account_id
      and v_actor.role = 'admin'
    )
  loop
    v_import := public._staxis_stage_b_import_legacy_scope(
      v_property_id, 'Stage B ownership transfer import'
    );
    if coalesce((v_import->>'ok')::boolean, false) is not true then
      raise exception 'Stage B ownership import failed after preflight for %', v_property_id
        using errcode = 'P0001', detail = v_import::text;
    end if;
  end loop;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', btrim(p_request_id), true);
  update public.accounts set role = 'owner' where id = v_new.id;
  update public.accounts set role = 'general_manager' where id = v_old.id;
  insert into public.role_changes (
    account_id, property_id, changed_by_account_id,
    old_role, new_role, change_kind, reason
  )
  select v_new.id, affected.id, v_actor.id,
         v_new.role, 'owner', 'transfer_ownership', v_reason
  from unnest(v_new_ids) affected(id);
  insert into public.role_changes (
    account_id, property_id, changed_by_account_id,
    old_role, new_role, change_kind, reason
  )
  select v_old.id, affected.id, v_actor.id,
         v_old.role, 'general_manager', 'transfer_ownership', v_reason
  from unnest(v_old_ids) affected(id);
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''),
    'account.transfer_ownership', 'account', v_new.id::text,
    jsonb_build_object(
      'hotel_id', p_property_id,
      'operation_id', p_operation_id,
      'from_account_id', v_old.id,
      'to_account_id', v_new.id,
      'from_old_role', v_old.role,
      'to_old_role', v_new.role,
      'from_active', v_old.active,
      'to_active', v_new.active,
      'from_auth_user_id', v_old.data_user_id,
      'to_auth_user_id', v_new.data_user_id,
      'from_property_access', to_jsonb(v_old_ids),
      'to_property_access', to_jsonb(v_new_ids),
      'old_owner_affected_hotel_ids', to_jsonb(v_old_ids),
      'new_owner_affected_hotel_ids', to_jsonb(v_new_ids),
      'global_account_change', true,
      'reason', v_reason,
      'request_id', p_request_id
    )
  );
  return jsonb_build_object(
    'status', 'ok',
    'operation_id', p_operation_id,
    'old_owner_account_id', v_old.id,
    'new_owner_account_id', v_new.id
  );
end;
$$;

revoke all on function public.staxis_transfer_ownership_guarded(
  uuid,uuid,uuid,text,uuid,uuid,uuid,
  boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_transfer_ownership_guarded(
  uuid,uuid,uuid,text,uuid,uuid,uuid,
  boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) to service_role;

insert into public.applied_migrations(version, description)
values (
  '0424',
  'Stage B canonical account scope, ownership transfer, and hotel detach mutations; application access no longer reads or writes the legacy property_access column.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
