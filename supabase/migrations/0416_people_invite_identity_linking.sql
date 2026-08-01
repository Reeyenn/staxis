-- 0416_people_invite_identity_linking.sql
--
-- A roster profile and a Staxis account are separate identities. Email invites
-- may now promise an exact, still-unlinked roster profile, and acceptance binds
-- that profile in the same transaction as account/access creation. Existing
-- Staxis accounts receive the same guarded hotel-access operation without
-- manufacturing a second Auth identity. Shared-link approvals reuse a roster
-- profile only when one deterministic same-hotel/department match exists.

begin;

do $$
begin
  if to_regclass('public.account_invites') is null
     or to_regclass('public.account_property_staff_links') is null
     or to_regclass('public.account_authorization_state') is null
     or to_regprocedure('public._staxis_manage_team_context(uuid,uuid)') is null
     or to_regprocedure('public._staxis_can_control_account_invite(uuid,uuid,uuid,text,text,uuid[])') is null
     or to_regprocedure('public.staxis_create_account_invite_guarded(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text)') is null
     or to_regprocedure('public.staxis_accept_account_invite(text,uuid,uuid,text,text)') is null
     or to_regprocedure('public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)') is null
  then
    raise exception '0416 requires authoritative People lifecycle migrations 0393, 0395, and 0411';
  end if;
end
$$;

alter table public.account_invites
  add column if not exists target_staff_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.account_invites'::regclass
      and constraint_row.conname = 'account_invites_target_staff_property_fkey'
  ) then
    alter table public.account_invites
      add constraint account_invites_target_staff_property_fkey
      foreign key (target_staff_id, hotel_id)
      references public.staff (id, property_id);
  end if;
end
$$;

create index if not exists account_invites_target_staff_idx
  on public.account_invites (target_staff_id, hotel_id)
  where target_staff_id is not null;

comment on column public.account_invites.target_staff_id is
  'Optional active roster identity promised by this email invitation. It must belong to hotel_id, remain unlinked, match the invited operational role, and is bound atomically at acceptance.';

-- Every caller already holds (or immediately takes) the hotel row/advisory
-- lock. This helper adds the exact roster-row/link locks and mirrors the
-- manage_team capability boundary. The allowed account is used only for
-- idempotent existing-account grants; pending/new-account invites pass NULL.
create or replace function public._staxis_lock_invite_target_staff(
  p_actor_account_id uuid,
  p_hotel_id uuid,
  p_role text,
  p_target_staff_id uuid,
  p_allowed_account_id uuid default null,
  p_allowed_invite_id uuid default null
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_context jsonb;
  v_department text;
begin
  if p_target_staff_id is null then return 'ok'; end if;
  if p_actor_account_id is null or p_hotel_id is null
     or p_role not in ('front_desk', 'housekeeping', 'maintenance')
  then
    return 'role_conflict';
  end if;

  v_context := public._staxis_manage_team_context(
    p_actor_account_id,
    p_hotel_id
  );
  if coalesce((v_context->>'allowed')::boolean, false) is not true then
    return 'denied';
  end if;

  select coalesce(staff_row.department, 'housekeeping')
    into v_department
  from public.staff staff_row
  where staff_row.id = p_target_staff_id
    and staff_row.property_id = p_hotel_id
    and staff_row.is_active is true
  for update;
  if not found then return 'not_found'; end if;
  if v_department is distinct from p_role then return 'role_conflict'; end if;

  -- Every entry point takes the hotel row lock before reaching this helper.
  -- That shared lock order serializes reservation reads with invite creation,
  -- acceptance, direct grants, and join approval without introducing an
  -- invite-row/property-row deadlock with the older acceptance transaction.
  if exists (
    select 1
    from public.account_invites invitation
    where invitation.hotel_id = p_hotel_id
      and invitation.target_staff_id = p_target_staff_id
      and invitation.accepted_at is null
      and invitation.expires_at > clock_timestamp()
      and (
        p_allowed_invite_id is null
        or invitation.id <> p_allowed_invite_id
      )
  ) then
    return 'staff_in_use';
  end if;

  perform 1
  from public.accounts account
  where account.staff_id = p_target_staff_id
  order by account.id
  for update;

  perform 1
  from public.account_property_staff_links staff_link
  where (staff_link.staff_id = p_target_staff_id and staff_link.is_active is true)
     or (p_allowed_account_id is not null
         and staff_link.account_id = p_allowed_account_id
         and staff_link.property_id = p_hotel_id)
  order by staff_link.account_id, staff_link.property_id
  for update;

  if exists (
    select 1
    from public.accounts account
    where account.staff_id = p_target_staff_id
      and (p_allowed_account_id is null or account.id <> p_allowed_account_id)
  ) or exists (
    select 1
    from public.account_property_staff_links staff_link
    where staff_link.staff_id = p_target_staff_id
      and staff_link.is_active is true
      and (p_allowed_account_id is null or staff_link.account_id <> p_allowed_account_id)
  ) then
    return 'staff_in_use';
  end if;

  if p_allowed_account_id is not null and exists (
    select 1
    from public.account_property_staff_links staff_link
    where staff_link.account_id = p_allowed_account_id
      and staff_link.property_id = p_hotel_id
      and staff_link.is_active is true
      and staff_link.staff_id <> p_target_staff_id
  ) then
    return 'staff_in_use';
  end if;

  if p_allowed_account_id is not null then
    perform 1
    from public.accounts allowed_account
    join public.staff existing_staff
      on existing_staff.id = allowed_account.staff_id
    where allowed_account.id = p_allowed_account_id
      and allowed_account.staff_id <> p_target_staff_id
      and existing_staff.property_id = p_hotel_id
    for update of existing_staff;
    if found then return 'staff_in_use'; end if;
  end if;

  return 'ok';
end;
$$;

revoke all on function public._staxis_lock_invite_target_staff(
  uuid,uuid,text,uuid,uuid,uuid
) from public, anon, authenticated, service_role;

-- Retain the proven 0395 lock/recheck/insert/audit implementation privately.
-- Argument 11 remains p_request_id; the optional roster target is appended so
-- rolling callers using the original 11 positional arguments remain valid.
do $$
begin
  if to_regprocedure(
    'public._staxis_create_account_invite_guarded_0395_impl(uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text)'
  ) is null then
    alter function public.staxis_create_account_invite_guarded(
      uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text
    ) rename to _staxis_create_account_invite_guarded_0395_impl;
  end if;
end
$$;

revoke all on function public._staxis_create_account_invite_guarded_0395_impl(
  uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text
) from public, anon, authenticated, service_role;

create or replace function public.staxis_create_account_invite_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_email text,
  p_role text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_organization_id uuid,
  p_membership_scope text,
  p_covered_property_ids uuid[],
  p_request_id text,
  p_target_staff_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_staff_status text;
  v_invite_id uuid;
  v_actor_email text;
begin
  if p_target_staff_id is not null then
    perform 1
    from public.properties property
    where property.id = p_hotel_id
    for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));

    v_staff_status := public._staxis_lock_invite_target_staff(
      p_actor_account_id,
      p_hotel_id,
      p_role,
      p_target_staff_id,
      null,
      null
    );
    if v_staff_status <> 'ok' then
      return jsonb_build_object('ok', false, 'reason', v_staff_status);
    end if;
  end if;

  v_result := public._staxis_create_account_invite_guarded_0395_impl(
    p_actor_account_id,
    p_actor_auth_user_id,
    p_hotel_id,
    p_email,
    p_role,
    p_token_hash,
    p_expires_at,
    p_organization_id,
    p_membership_scope,
    p_covered_property_ids,
    p_request_id
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;

  if p_target_staff_id is not null then
    v_invite_id := (v_result->>'inviteId')::uuid;
    update public.account_invites invitation
       set target_staff_id = p_target_staff_id
     where invitation.id = v_invite_id
       and invitation.hotel_id = p_hotel_id
       and invitation.accepted_at is null;
    if not found then
      raise exception 'created invitation receipt changed before roster binding'
        using errcode = '40001';
    end if;

    -- The staff row remains locked from the first check. Recompute manage_team
    -- after the authoritative invitation implementation locked/rechecked every
    -- delegation input, so a capability change cannot straddle the promise.
    -- The just-created invitation now holds the reservation and is the only
    -- invite excluded from this final conflict check.
    v_staff_status := public._staxis_lock_invite_target_staff(
      p_actor_account_id,
      p_hotel_id,
      p_role,
      p_target_staff_id,
      null,
      v_invite_id
    );
    if v_staff_status <> 'ok' then
      raise exception 'target staff changed while invitation was created'
        using errcode = '40001';
    end if;

    select lower(auth_user.email) into v_actor_email
    from auth.users auth_user
    where auth_user.id = p_actor_auth_user_id;
    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, metadata
    ) values (
      p_actor_auth_user_id,
      v_actor_email,
      'invite.target_staff_bind',
      'invite',
      v_invite_id::text,
      jsonb_build_object(
        'hotel_id', p_hotel_id,
        'target_staff_id', p_target_staff_id,
        'role', p_role,
        'request_id', p_request_id
      )
    );
  end if;

  return v_result || jsonb_build_object('targetStaffId', p_target_staff_id);
end;
$$;

revoke all on function public.staxis_create_account_invite_guarded(
  uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text,uuid
) from public, anon, authenticated;
grant execute on function public.staxis_create_account_invite_guarded(
  uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text,uuid
) to service_role;

-- Exact rolling compatibility for pre-0416 positional callers and database
-- introspection. Keeping the 12-argument variant non-defaulted makes PostgREST
-- overload selection unambiguous.
create or replace function public.staxis_create_account_invite_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_email text,
  p_role text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_organization_id uuid,
  p_membership_scope text,
  p_covered_property_ids uuid[],
  p_request_id text default null
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.staxis_create_account_invite_guarded(
    p_actor_account_id,
    p_actor_auth_user_id,
    p_hotel_id,
    p_email,
    p_role,
    p_token_hash,
    p_expires_at,
    p_organization_id,
    p_membership_scope,
    p_covered_property_ids,
    p_request_id,
    null::uuid
  )
$$;

revoke all on function public.staxis_create_account_invite_guarded(
  uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text
) from public, anon, authenticated;
grant execute on function public.staxis_create_account_invite_guarded(
  uuid,uuid,uuid,text,text,text,timestamptz,uuid,text,uuid[],text
) to service_role;

-- Retain the 0393 exact-claim/account/entitlement/audit transaction privately.
-- The wrapper adds the promised roster link before the outer transaction can
-- commit, so any link conflict rolls back Auth-account persistence as before.
do $$
begin
  if to_regprocedure(
    'public._staxis_accept_account_invite_0393_impl(text,uuid,uuid,text,text)'
  ) is null then
    alter function public.staxis_accept_account_invite(
      text,uuid,uuid,text,text
    ) rename to _staxis_accept_account_invite_0393_impl;
  end if;
end
$$;

revoke all on function public._staxis_accept_account_invite_0393_impl(
  text,uuid,uuid,text,text
) from public, anon, authenticated, service_role;

create or replace function public.staxis_accept_account_invite(
  p_token_hash text,
  p_claim_token uuid,
  p_auth_user_id uuid,
  p_username text,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result jsonb;
  v_invite public.account_invites%rowtype;
  v_account_id uuid;
  v_staff_status text;
  v_staff_link_account_id uuid;
  v_now timestamptz;
begin
  v_result := public._staxis_accept_account_invite_0393_impl(
    p_token_hash,
    p_claim_token,
    p_auth_user_id,
    p_username,
    p_display_name
  );

  select invitation.* into v_invite
  from public.account_invites invitation
  where invitation.token_hash = p_token_hash
  for update;
  if not found then
    raise exception 'accepted invitation disappeared before roster binding'
      using errcode = '40001';
  end if;
  if v_invite.target_staff_id is null then
    return v_result || jsonb_build_object('staffId', null);
  end if;

  v_account_id := (v_result->>'accountId')::uuid;
  v_staff_status := public._staxis_lock_invite_target_staff(
    v_invite.invited_by,
    v_invite.hotel_id,
    v_invite.role,
    v_invite.target_staff_id,
    v_account_id,
    v_invite.id
  );
  if v_staff_status <> 'ok' then
    raise exception 'promised roster profile is no longer linkable'
      using errcode = case
        when v_staff_status = 'staff_in_use' then '23505'
        else '42501'
      end;
  end if;
  v_now := clock_timestamp();

  update public.accounts account
     set staff_id = v_invite.target_staff_id,
         updated_at = v_now
   where account.id = v_account_id
     and account.staff_id is null;
  if not found then
    raise exception 'accepted account already has a different roster identity'
      using errcode = '23514';
  end if;

  insert into public.account_property_staff_links (
    account_id, property_id, staff_id, is_active, source,
    linked_by_account_id, linked_at, deactivated_at,
    deactivated_by_account_id, updated_at
  ) values (
    v_account_id, v_invite.hotel_id, v_invite.target_staff_id, true,
    'invitation', v_invite.invited_by, v_now, null, null, v_now
  )
  on conflict (account_id, property_id) do update
    set staff_id = excluded.staff_id,
        is_active = true,
        source = 'invitation',
        linked_by_account_id = excluded.linked_by_account_id,
        linked_at = case
          when public.account_property_staff_links.staff_id is distinct from excluded.staff_id
            or public.account_property_staff_links.is_active is false
            then excluded.linked_at
          else public.account_property_staff_links.linked_at
        end,
        deactivated_at = null,
        deactivated_by_account_id = null,
        updated_at = excluded.updated_at
    where public.account_property_staff_links.is_active is false
       or public.account_property_staff_links.staff_id = excluded.staff_id
  returning account_id into v_staff_link_account_id;
  if v_staff_link_account_id is null then
    raise exception 'accepted account staff link changed before commit'
      using errcode = '40001';
  end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_auth_user_id,
    lower(v_invite.email),
    'invite.accept_staff_link',
    'invite',
    v_invite.id::text,
    jsonb_build_object(
      'hotel_id', v_invite.hotel_id,
      'account_id', v_account_id,
      'staff_id', v_invite.target_staff_id,
      'role', v_invite.role
    )
  );

  return v_result || jsonb_build_object('staffId', v_invite.target_staff_id);
end;
$$;

revoke all on function public.staxis_accept_account_invite(
  text,uuid,uuid,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_accept_account_invite(
  text,uuid,uuid,text,text
) to service_role;

-- When the invited email already owns an active Staxis account, grant the
-- promised access directly. The service caller supplies both account id and
-- email; this transaction locks the account and re-binds those two facts to the
-- same Auth row before changing any authority.
create or replace function public.staxis_grant_existing_account_invite_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_email text,
  p_role text,
  p_organization_id uuid,
  p_membership_scope text,
  p_covered_property_ids uuid[],
  p_target_staff_id uuid default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  -- Authorization projections compare starts_at to transaction-stable now().
  -- Use that same clock so a hat created below is visible to its immediate
  -- in-transaction activation check.
  v_now timestamptz := now();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_actor_email text;
  v_target_email text;
  v_normalized boolean;
  v_current_organization_id uuid;
  v_current_organization_type text;
  v_relationship_count integer;
  v_lock_property_ids uuid[];
  v_property_id uuid;
  v_staff_status text;
  v_membership_id uuid;
  v_existing_membership public.organization_memberships%rowtype;
  v_effective_coverage uuid[];
  v_job_category text;
  v_projection jsonb;
  v_membership_changed boolean := false;
  v_existing_membership_found boolean := false;
  v_access_changed boolean := false;
  v_role_changed boolean := false;
  v_link_changed boolean := false;
  v_link_account_id uuid;
  v_has_normalized_authority boolean := false;
  v_existing_hat record;
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_hotel_id is null
     or p_target_account_id is null
     or char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_role is null
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  v_normalized := p_organization_id is not null
    or p_membership_scope is not null
    or p_covered_property_ids is not null;
  v_lock_property_ids := array[p_hotel_id]
    || case when p_membership_scope = 'property'
      then coalesce(p_covered_property_ids, '{}'::uuid[])
      else '{}'::uuid[] end;

  for v_property_id in
    select distinct locked_id
    from unnest(v_lock_property_ids) locked_id
    where locked_id is not null
    order by locked_id
  loop
    perform 1
    from public.properties property
    where property.id = v_property_id
    for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
  end loop;

  select count(*)::integer,
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(organization.organization_type order by relationship.id))[1]
    into v_relationship_count,
         v_current_organization_id,
         v_current_organization_type
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id
   and organization.status = 'active'
  where relationship.property_id = p_hotel_id
    and relationship.active_primary_count = 1;
  if v_relationship_count <> 1 then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  perform public._staxis_lock_organization(
    coalesce(p_organization_id, v_current_organization_id)
  );
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
  exception when lock_not_available then
    raise exception 'existing-account invitation authority changed concurrently'
      using errcode = '55P03';
  end;

  select actor.* into v_actor
  from public.accounts actor
  where actor.id = p_actor_account_id
  for share nowait;
  if not found then return jsonb_build_object('ok', false, 'reason', 'denied'); end if;

  perform 1
  from public.account_authorization_state state
  where state.account_id = p_actor_account_id
  for share nowait;

  select lower(auth_user.email) into v_actor_email
  from auth.users auth_user
  where auth_user.id = p_actor_auth_user_id
  for share;
  if not found
     or v_actor.data_user_id is distinct from p_actor_auth_user_id
     or v_actor.active is not true
     or not public._staxis_can_control_account_invite(
       p_actor_account_id,
       p_hotel_id,
       p_organization_id,
       p_membership_scope,
       p_role,
       p_covered_property_ids
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  select target.* into v_target
  from public.accounts target
  where target.id = p_target_account_id
    and target.active is true
  for update nowait;
  if not found or v_target.role = 'admin' then
    return jsonb_build_object(
      'ok', false,
      'reason', case when not found then 'not_found' else 'role_conflict' end
    );
  end if;

  select lower(auth_user.email) into v_target_email
  from auth.users auth_user
  where auth_user.id = v_target.data_user_id
  for share;
  if not found or v_target_email is distinct from v_email then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select state.* into v_target_state
  from public.account_authorization_state state
  where state.account_id = v_target.id
  for update nowait;
  if not found then return jsonb_build_object('ok', false, 'reason', 'denied'); end if;

  perform 1
  from public.account_property_staff_links staff_link
  where staff_link.account_id = v_target.id
  order by staff_link.property_id
  for update;

  v_staff_status := public._staxis_lock_invite_target_staff(
    p_actor_account_id,
    p_hotel_id,
    p_role,
    p_target_staff_id,
    v_target.id,
    null
  );
  if v_staff_status <> 'ok' then
    return jsonb_build_object('ok', false, 'reason', v_staff_status);
  end if;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', coalesce(p_request_id, ''), true);

  if v_normalized then
    if v_current_organization_type not in ('management_company', 'ownership_group')
       or v_current_organization_id is distinct from p_organization_id
       or v_target_state.authority_mode = 'shadow'
       or (v_target_state.authority_mode = 'legacy'
           and cardinality(coalesce(v_target.property_access, '{}'::uuid[])) <> 0)
    then
      return jsonb_build_object('ok', false, 'reason', 'role_conflict');
    end if;

    -- Match the target-hierarchy fence inside staxis_set_membership_hat. This
    -- direct-grant door intentionally replaces only that helper's historical
    -- "must already have an invitation" prerequisite.
    if v_actor.role <> 'admin' then
      for v_existing_hat in
        select membership.membership_scope,
               membership.staxis_role,
               membership.covered_property_ids
        from public.organization_memberships membership
        where membership.organization_id = p_organization_id
          and membership.account_id = v_target.id
          and membership.status = 'active'
          and membership.ended_at is null
          and membership.staxis_role is not null
      loop
        if not public._staxis_can_set_membership_hat(
          v_actor.id,
          p_organization_id,
          v_existing_hat.membership_scope,
          v_existing_hat.staxis_role,
          v_existing_hat.covered_property_ids
        ) then
          return jsonb_build_object('ok', false, 'reason', 'denied');
        end if;
      end loop;
    end if;

    v_effective_coverage := case when p_membership_scope = 'property' then
      array(
        select distinct covered.property_id
        from unnest(coalesce(p_covered_property_ids, '{}'::uuid[])) covered(property_id)
        order by covered.property_id
      )
      else null end;
    v_job_category := case p_role
      when 'owner' then 'owner_principal'
      when 'vp' then 'regional_manager'
      when 'finance' then 'finance'
      when 'general_manager' then 'general_manager'
      else 'hotel_employee'
    end;

    select membership.* into v_existing_membership
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.account_id = v_target.id
      and membership.membership_scope = p_membership_scope
      and membership.staxis_role = p_role
      and membership.ended_at is null
    for update;
    v_existing_membership_found := found;

    if v_existing_membership_found and p_membership_scope = 'property' then
      v_effective_coverage := array(
        select distinct covered.property_id
        from unnest(
          coalesce(v_existing_membership.covered_property_ids, '{}'::uuid[])
          || coalesce(v_effective_coverage, '{}'::uuid[])
        ) covered(property_id)
        order by covered.property_id
      );
    end if;
    v_membership_changed := not v_existing_membership_found
      or v_existing_membership.status <> 'active'
      or v_existing_membership.starts_at > v_now
      or v_existing_membership.covered_property_ids is distinct from v_effective_coverage;

    if v_membership_changed then
      insert into public.organization_memberships (
        organization_id, account_id, job_category, status, starts_at,
        created_by_account_id, updated_by_account_id,
        membership_scope, staxis_role, covered_property_ids
      ) values (
        p_organization_id, v_target.id, v_job_category, 'active', v_now,
        v_actor.id, v_actor.id,
        p_membership_scope, p_role, v_effective_coverage
      )
      on conflict (organization_id, account_id, membership_scope, staxis_role)
        where ended_at is null and staxis_role is not null
      do update set
        covered_property_ids = excluded.covered_property_ids,
        status = 'active',
        starts_at = least(public.organization_memberships.starts_at, excluded.starts_at),
        updated_by_account_id = excluded.updated_by_account_id,
        updated_at = v_now
      returning id into v_membership_id;
    else
      v_membership_id := v_existing_membership.id;
    end if;

    if not exists (
      select 1
      from public.account_authorization_state state
      where state.account_id = v_target.id
        and state.authority_mode = 'normalized'
    ) or not exists (
      select 1
      from public._staxis_account_property_authorizations(v_target.id) authz
      where authz.property_id = p_hotel_id
        and authz.entitlement_kind = 'membership_hat'
        and authz.entitlement_id = v_membership_id
    ) or (
      p_membership_scope = 'property' and exists (
        select 1
        from unnest(coalesce(p_covered_property_ids, '{}'::uuid[])) covered(property_id)
        where not exists (
          select 1
          from public._staxis_account_property_authorizations(v_target.id) authz
          where authz.property_id = covered.property_id
            and authz.entitlement_kind = 'membership_hat'
            and authz.entitlement_id = v_membership_id
        )
      )
    ) then
      raise exception 'existing-account normalized entitlement did not activate'
        using errcode = '23514';
    end if;
    v_access_changed := v_membership_changed;
  else
    if v_current_organization_type <> 'single_hotel'
       or v_target_state.authority_mode = 'normalized'
    then
      return jsonb_build_object('ok', false, 'reason', 'role_conflict');
    end if;

    if v_target.role is distinct from p_role then
      select exists (
        select 1
        from public._staxis_nonlegacy_property_authorizations(v_target.id)
      ) or exists (
        select 1
        from public.organization_memberships membership
        where membership.account_id = v_target.id
          and membership.ended_at is null
          and membership.staxis_role is not null
      ) or exists (
        select 1
        from public.organization_access_grants grant_row
        join public.organization_memberships membership
          on membership.id = grant_row.membership_id
         and membership.organization_id = grant_row.organization_id
        where membership.account_id = v_target.id
          and grant_row.status = 'active'
      ) into v_has_normalized_authority;

      if cardinality(coalesce(v_target.property_access, '{}'::uuid[])) <> 0
         or v_target_state.authority_mode = 'normalized'
         or v_has_normalized_authority
         or v_target.staff_id is not null
         or exists (
           select 1
           from public.account_property_staff_links staff_link
           where staff_link.account_id = v_target.id
             and staff_link.is_active is true
         )
      then
        return jsonb_build_object('ok', false, 'reason', 'role_conflict');
      end if;
      v_role_changed := true;
    end if;

    v_access_changed := not (p_hotel_id = any(
      coalesce(v_target.property_access, '{}'::uuid[])
    ));
    if v_role_changed or v_access_changed then
      update public.accounts target
         set role = case when v_role_changed then p_role else target.role end,
             property_access = case when v_access_changed then array(
               select distinct property_id
               from unnest(
                 coalesce(target.property_access, '{}'::uuid[]) || p_hotel_id
               ) property_id
               order by property_id
             ) else target.property_access end,
             updated_at = v_now
       where target.id = v_target.id;
    end if;

    v_projection := public.staxis_list_account_authorized_properties(v_target.id);
    if coalesce((v_projection->>'ok')::boolean, false) is not true
       or not exists (
         select 1
         from jsonb_array_elements(
           coalesce(v_projection->'propertyStandings', '[]'::jsonb)
         ) standing
         where standing->>'propertyId' = p_hotel_id::text
       )
    then
      raise exception 'existing-account independent access did not activate'
        using errcode = '23514';
    end if;
  end if;

  if p_target_staff_id is not null then
    v_link_changed := not exists (
      select 1
      from public.account_property_staff_links staff_link
      where staff_link.account_id = v_target.id
        and staff_link.property_id = p_hotel_id
        and staff_link.staff_id = p_target_staff_id
        and staff_link.is_active is true
    );

    update public.accounts target
       set staff_id = coalesce(target.staff_id, p_target_staff_id),
           updated_at = case when target.staff_id is null then v_now else target.updated_at end
     where target.id = v_target.id;

    insert into public.account_property_staff_links (
      account_id, property_id, staff_id, is_active, source,
      linked_by_account_id, linked_at, deactivated_at,
      deactivated_by_account_id, updated_at
    ) values (
      v_target.id, p_hotel_id, p_target_staff_id, true, 'invitation',
      v_actor.id, v_now, null, null, v_now
    )
    on conflict (account_id, property_id) do update
      set staff_id = excluded.staff_id,
          is_active = true,
          source = 'invitation',
          linked_by_account_id = excluded.linked_by_account_id,
          linked_at = case
            when public.account_property_staff_links.staff_id is distinct from excluded.staff_id
              or public.account_property_staff_links.is_active is false
              then excluded.linked_at
            else public.account_property_staff_links.linked_at
          end,
          deactivated_at = null,
          deactivated_by_account_id = null,
          updated_at = excluded.updated_at
      where public.account_property_staff_links.is_active is false
         or public.account_property_staff_links.staff_id = excluded.staff_id
    returning account_id into v_link_account_id;
    if v_link_account_id is null then
      raise exception 'target account staff link changed during access grant'
        using errcode = '40001';
    end if;
  end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id,
    v_actor_email,
    'invite.existing_account_grant',
    'account',
    v_target.id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id,
      'target_email', v_email,
      'role', p_role,
      'organization_id', p_organization_id,
      'scope', p_membership_scope,
      'property_ids', case when p_membership_scope = 'property'
        then to_jsonb(p_covered_property_ids) else null end,
      'membership_id', v_membership_id,
      'staff_id', p_target_staff_id,
      'role_changed', v_role_changed,
      'access_changed', v_access_changed,
      'staff_link_changed', v_link_changed,
      'request_id', p_request_id
    )
  );

  return jsonb_build_object(
    'ok', true,
    'status', case
      when v_role_changed or v_access_changed or v_link_changed then 'granted'
      else 'noop'
    end,
    'accountId', v_target.id,
    'hotelId', p_hotel_id,
    'role', p_role,
    'normalized', v_normalized,
    'membershipId', v_membership_id,
    'staffId', p_target_staff_id
  );
exception
  when lock_not_available or deadlock_detected then
    raise exception 'existing-account invitation changed concurrently'
      using errcode = '55P03';
end;
$$;

revoke all on function public.staxis_grant_existing_account_invite_guarded(
  uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text
) from public, anon, authenticated;
grant execute on function public.staxis_grant_existing_account_invite_guarded(
  uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text
) to service_role;

-- Shared-link approval still owns account authorization atomically. Before it
-- creates a roster row, it looks for exactly one active, unlinked profile at
-- the same hotel and department: normalized phone wins, then normalized exact
-- name. Zero or ambiguous matches create a new row instead of guessing.
create or replace function public.staxis_decide_staff_join_request(
  p_actor_account_id uuid,
  p_join_request_id uuid,
  p_property_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.join_requests%rowtype;
  v_account public.accounts%rowtype;
  v_context jsonb;
  v_now timestamptz := now();
  v_org_id uuid;
  v_org_type text;
  v_relationship_count integer;
  v_staff_id uuid;
  v_staff_link_account_id uuid;
  v_membership_id uuid;
  v_phone_lookup text;
  v_name_lookup text;
  v_match_count integer;
  v_staff_reused boolean := false;
begin
  if p_actor_account_id is null
     or p_join_request_id is null
     or p_property_id is null
     or p_decision not in ('approve', 'deny')
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  perform 1 from public.properties property
    where property.id = p_property_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'property_not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));

  select request_row.* into v_request
  from public.join_requests request_row
  where request_row.id = p_join_request_id
    and request_row.property_id = p_property_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_request.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided');
  end if;

  select count(*)::integer,
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(organization.organization_type order by relationship.id))[1]
    into v_relationship_count, v_org_id, v_org_type
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id
   and organization.status = 'active'
  where relationship.property_id = p_property_id
    and relationship.active_primary_count = 1;
  if v_relationship_count <> 1 then
    return jsonb_build_object('ok', false, 'reason', 'ambiguous_topology');
  end if;

  -- Match the authoritative People write boundary: after the property lock,
  -- freeze the governing organization and every projection input, then lock
  -- the actor identity/state before recomputing manage_team. A concurrent
  -- demotion, entitlement revocation, capability change, or hotel transfer
  -- therefore either lands first and is observed below, or waits until this
  -- approval/denial and its audit have committed.
  perform public._staxis_lock_organization(v_org_id);
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

    perform 1
    from public.accounts actor
    where actor.id = p_actor_account_id
    for share nowait;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'forbidden');
    end if;

    perform 1
    from public.account_authorization_state state
    where state.account_id = p_actor_account_id
    for share nowait;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'forbidden');
    end if;
  exception
    when lock_not_available or deadlock_detected then
      raise exception 'join-request authority changed concurrently'
        using errcode = '55P03';
  end;

  v_context := public._staxis_manage_team_context(p_actor_account_id, p_property_id);
  if coalesce((v_context->>'allowed')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if p_decision = 'deny' then
    update public.join_requests request_row
       set status = 'denied', decided_at = v_now, decided_by = p_actor_account_id
     where request_row.id = v_request.id and request_row.status = 'pending';
    if not found then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;
    insert into public.admin_audit_log (
      actor_user_id, action, target_type, target_id, metadata
    ) select actor.data_user_id, 'join_request.deny', 'join_request', v_request.id::text,
             jsonb_build_object('hotel_id', p_property_id, 'name', v_request.name,
                                'department', v_request.department)
        from public.accounts actor where actor.id = p_actor_account_id;
    return jsonb_build_object('ok', true, 'decided', 'denied');
  end if;

  begin
    select target.* into v_account
    from public.accounts target
    where target.id = v_request.account_id
      and target.active is true
    for update nowait;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'account_unavailable');
    end if;

    perform 1
    from public.account_authorization_state state
    where state.account_id = v_account.id
    for update nowait;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'account_unavailable');
    end if;
  exception
    when lock_not_available or deadlock_detected then
      raise exception 'join-request target changed concurrently'
        using errcode = '55P03';
  end;
  if v_account.staff_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_linked');
  end if;
  if v_account.role not in ('front_desk', 'housekeeping', 'maintenance')
     or v_request.department <> v_account.role
  then
    return jsonb_build_object('ok', false, 'reason', 'role_mismatch');
  end if;

  if v_org_type in ('management_company', 'ownership_group') then
    if v_context->>'role' <> 'admin'
       and (
         v_context->>'authorityMode' <> 'normalized'
         or not coalesce(v_context->'organizationIds', '[]'::jsonb)
           @> jsonb_build_array(v_org_id::text)
       )
    then
      return jsonb_build_object('ok', false, 'reason', 'normalized_manager_required');
    end if;
    if exists (
      select 1 from public.account_authorization_state state
      where state.account_id = v_account.id
        and state.authority_mode in ('legacy', 'shadow')
    ) and cardinality(coalesce(v_account.property_access, '{}'::uuid[])) <> 0 then
      return jsonb_build_object('ok', false, 'reason', 'target_scope_not_empty');
    end if;
  elsif v_org_type = 'single_hotel' then
    if exists (
      select 1 from public.account_authorization_state state
      where state.account_id = v_account.id and state.authority_mode = 'normalized'
    ) then
      return jsonb_build_object('ok', false, 'reason', 'normalized_independent_grant_unsupported');
    end if;
  else
    return jsonb_build_object('ok', false, 'reason', 'invalid_topology');
  end if;

  v_phone_lookup := case when coalesce(v_request.phone, '') = '' then null
    else right(regexp_replace(v_request.phone, '[^0-9]', '', 'g'), 10) end;
  v_name_lookup := lower(regexp_replace(
    btrim(v_request.name), '[[:space:]]+', ' ', 'g'
  ));

  if v_phone_lookup is not null then
    select count(*)::integer,
           (array_agg(candidate.id order by candidate.id))[1]
      into v_match_count, v_staff_id
    from public.staff candidate
    where candidate.property_id = p_property_id
      and candidate.is_active is true
      and coalesce(candidate.department, 'housekeeping') = v_request.department
      and candidate.phone_lookup = v_phone_lookup
      and not exists (
        select 1 from public.accounts linked_account
        where linked_account.staff_id = candidate.id
      )
      and not exists (
        select 1 from public.account_property_staff_links staff_link
        where staff_link.staff_id = candidate.id
          and staff_link.is_active is true
      )
      and not exists (
        select 1 from public.account_invites invitation
        where invitation.hotel_id = p_property_id
          and invitation.target_staff_id = candidate.id
          and invitation.accepted_at is null
          and invitation.expires_at > v_now
      );
    if v_match_count <> 1 then v_staff_id := null; end if;
  end if;

  if v_staff_id is null then
    select count(*)::integer,
           (array_agg(candidate.id order by candidate.id))[1]
      into v_match_count, v_staff_id
    from public.staff candidate
    where candidate.property_id = p_property_id
      and candidate.is_active is true
      and coalesce(candidate.department, 'housekeeping') = v_request.department
      and lower(regexp_replace(
        btrim(candidate.name), '[[:space:]]+', ' ', 'g'
      )) = v_name_lookup
      and (
        v_phone_lookup is null
        or candidate.phone_lookup is null
        or candidate.phone_lookup = v_phone_lookup
      )
      and not exists (
        select 1 from public.accounts linked_account
        where linked_account.staff_id = candidate.id
      )
      and not exists (
        select 1 from public.account_property_staff_links staff_link
        where staff_link.staff_id = candidate.id
          and staff_link.is_active is true
      )
      and not exists (
        select 1 from public.account_invites invitation
        where invitation.hotel_id = p_property_id
          and invitation.target_staff_id = candidate.id
          and invitation.accepted_at is null
          and invitation.expires_at > v_now
      );
    if v_match_count <> 1 then v_staff_id := null; end if;
  end if;

  if v_staff_id is not null then
    perform 1
    from public.staff candidate
    where candidate.id = v_staff_id
      and candidate.property_id = p_property_id
      and candidate.is_active is true
      and coalesce(candidate.department, 'housekeeping') = v_request.department
      and not exists (
        select 1 from public.accounts linked_account
        where linked_account.staff_id = candidate.id
      )
      and not exists (
        select 1 from public.account_property_staff_links staff_link
        where staff_link.staff_id = candidate.id
          and staff_link.is_active is true
      )
      and not exists (
        select 1 from public.account_invites invitation
        where invitation.hotel_id = p_property_id
          and invitation.target_staff_id = candidate.id
          and invitation.accepted_at is null
          and invitation.expires_at > v_now
      )
    for update;
    if found then v_staff_reused := true;
    else v_staff_id := null;
    end if;
  end if;

  if v_staff_id is null then
    insert into public.staff (
      property_id, name, phone, phone_lookup, language, is_senior, department,
      scheduled_today, weekly_hours, max_weekly_hours, max_days_per_week,
      days_worked_this_week, is_active
    ) values (
      p_property_id, v_request.name, coalesce(v_request.phone, ''), v_phone_lookup,
      v_request.language, false, v_request.department, false, 0, 40, 5, 0, true
    ) returning id into v_staff_id;
  end if;

  update public.accounts target
     set staff_id = v_staff_id,
         property_access = case when v_org_type = 'single_hotel'
           then array(select distinct property_id
                      from unnest(coalesce(target.property_access, '{}'::uuid[]) || p_property_id) property_id
                      order by property_id)
           else target.property_access end
   where target.id = v_account.id
     and target.staff_id is null;
  if not found then raise exception 'target account link changed during approval' using errcode = '40001'; end if;

  insert into public.account_property_staff_links (
    account_id, property_id, staff_id, is_active, source,
    linked_by_account_id, linked_at
  ) values (
    v_account.id, p_property_id, v_staff_id, true, 'invitation',
    p_actor_account_id, v_now
  )
  on conflict (account_id, property_id) do update
    set staff_id = excluded.staff_id,
        is_active = true,
        source = 'invitation',
        linked_by_account_id = excluded.linked_by_account_id,
        linked_at = excluded.linked_at,
        deactivated_at = null,
        deactivated_by_account_id = null,
        updated_at = v_now
    where public.account_property_staff_links.is_active is false
       or public.account_property_staff_links.staff_id = excluded.staff_id
  returning account_id into v_staff_link_account_id;
  if v_staff_link_account_id is null then
    raise exception 'target account already has an active hotel staff link'
      using errcode = '23514';
  end if;

  if v_org_type in ('management_company', 'ownership_group') then
    insert into public.organization_memberships (
      organization_id, account_id, job_category, status, starts_at,
      created_by_account_id, updated_by_account_id,
      membership_scope, staxis_role, covered_property_ids
    ) values (
      v_org_id, v_account.id, 'hotel_employee', 'active', v_now,
      p_actor_account_id, p_actor_account_id,
      'property', v_account.role, array[p_property_id]
    )
    on conflict (organization_id, account_id, membership_scope, staxis_role)
      where ended_at is null and staxis_role is not null
    do update set
      covered_property_ids = array(
        select distinct property_id
        from unnest(
          coalesce(public.organization_memberships.covered_property_ids, '{}'::uuid[])
            || excluded.covered_property_ids
        ) property_id
        order by property_id
      ),
      status = 'active',
      updated_by_account_id = p_actor_account_id,
      updated_at = v_now
    returning id into v_membership_id;

    if not exists (
      select 1 from public.account_authorization_state state
      where state.account_id = v_account.id and state.authority_mode = 'normalized'
    ) or not exists (
      select 1 from public._staxis_account_property_authorizations(v_account.id) authz
      where authz.property_id = p_property_id
        and authz.entitlement_kind = 'membership_hat'
        and authz.entitlement_id = v_membership_id
    ) then
      raise exception 'normalized staff entitlement did not activate' using errcode = '23514';
    end if;
  end if;

  update public.join_requests request_row
     set status = 'approved', decided_at = v_now, decided_by = p_actor_account_id
   where request_row.id = v_request.id and request_row.status = 'pending';
  if not found then raise exception 'join request changed during approval' using errcode = '40001'; end if;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, metadata
  ) select actor.data_user_id, 'join_request.approve', 'join_request', v_request.id::text,
           jsonb_build_object(
             'hotel_id', p_property_id, 'name', v_request.name,
             'department', v_request.department, 'staffId', v_staff_id,
             'staffReused', v_staff_reused,
             'accountId', v_account.id, 'membershipId', v_membership_id,
             'authorityMode', case when v_membership_id is null then 'legacy' else 'normalized' end
           )
      from public.accounts actor where actor.id = p_actor_account_id;

  return jsonb_build_object(
    'ok', true, 'decided', 'approved', 'staffId', v_staff_id,
    'staffReused', v_staff_reused,
    'membershipId', v_membership_id,
    'authorityMode', case when v_membership_id is null then 'legacy' else 'normalized' end
  );
end;
$$;

revoke all on function public.staxis_decide_staff_join_request(
  uuid,uuid,uuid,text
) from public, anon, authenticated;
grant execute on function public.staxis_decide_staff_join_request(
  uuid,uuid,uuid,text
) to service_role;

insert into public.applied_migrations (version, description)
values (
  '0416',
  'People invitation identity linking, guarded existing-account hotel grants, and deterministic join-request roster reuse'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
