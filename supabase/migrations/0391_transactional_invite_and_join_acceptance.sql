-- 0391_transactional_invite_and_join_acceptance.sql
--
-- Account invitations and staff join approvals both create authorization
-- facts.  They therefore cannot be a sequence of service-role writes in a
-- route: a hotel can move companies, an inviter can be revoked, or the final
-- entitlement write can fail after the UI has already reported success.
--
-- This migration makes both workflows database transactions.  Invitation
-- acceptance uses a short exact-token reservation only to serialize the Auth
-- user creation that necessarily happens outside Postgres; the final RPC
-- re-locks and re-authorizes everything before it creates any database row.

begin;

do $$
begin
  if to_regclass('public.account_authorization_state') is null
     or to_regclass('public.account_property_staff_links') is null
     or to_regprocedure('public.staxis_list_account_authorized_properties(uuid)') is null
     or to_regprocedure('public.staxis_set_membership_hat(uuid,uuid,uuid,text,text,jsonb,text)') is null
  then
    raise exception '0391 requires organization access 0325/0364/0370, join requests 0315, and authoritative access 0376';
  end if;
end
$$;

-- A reservation is not acceptance.  accepted_at remains the terminal marker;
-- a crashed request can be retried after the bounded claim expires.
alter table public.account_invites
  add column if not exists acceptance_claim_token uuid;
alter table public.account_invites
  add column if not exists acceptance_claimed_at timestamptz;

alter table public.account_invites
  drop constraint if exists account_invites_acceptance_claim_shape_check;
alter table public.account_invites
  add constraint account_invites_acceptance_claim_shape_check check (
    (acceptance_claim_token is null and acceptance_claimed_at is null)
    or (acceptance_claim_token is not null and acceptance_claimed_at is not null)
  );

-- A property invitation's hotel_id is its durable authority/audit anchor.
-- Older application versions could persist an unrelated company hotel there,
-- so add this as NOT VALID: all new/changed rows are bound immediately while
-- any historical poison remains readable only for fail-closed cleanup.
alter table public.account_invites
  drop constraint if exists account_invites_property_anchor_check;
alter table public.account_invites
  add constraint account_invites_property_anchor_check check (
    membership_scope is distinct from 'property'
    or hotel_id = any(covered_property_ids)
  ) not valid;

comment on column public.account_invites.acceptance_claim_token is
  'Exact short-lived reservation for the external Auth-user creation window. It grants no access and is cleared by the transactional acceptance RPC.';

-- Internal mirror of the manage_team boundary.  It consumes the authoritative
-- per-hotel standing (never accounts.property_access directly), requires the
-- mutation bit, manager floor, and the current per-role capability override.
-- The organization ids are provenance from the winning entitlement class and
-- let callers prove that a normalized manager belongs to the company that
-- currently governs the hotel.
create or replace function public._staxis_manage_team_context(
  p_actor_account_id uuid,
  p_property_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_projection jsonb;
  v_standing jsonb;
  v_role text;
  v_organization_ids jsonb := '[]'::jsonb;
begin
  if p_actor_account_id is null or p_property_id is null then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_request');
  end if;

  select actor.* into v_account
  from public.accounts actor
  where actor.id = p_actor_account_id
    and actor.active is true;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'inactive_actor');
  end if;

  if v_account.role = 'admin' then
    return jsonb_build_object(
      'allowed', true,
      'role', 'admin',
      'authorityMode', 'admin',
      'organizationIds', '[]'::jsonb
    );
  end if;

  v_projection := public.staxis_list_account_authorized_properties(p_actor_account_id);
  if coalesce((v_projection->>'ok')::boolean, false) is not true then
    return jsonb_build_object('allowed', false, 'reason', 'authority_unavailable');
  end if;

  select standing into v_standing
  from jsonb_array_elements(coalesce(v_projection->'propertyStandings', '[]'::jsonb)) standing
  where standing->>'propertyId' = p_property_id::text
  limit 1;
  if v_standing is null
     or coalesce((v_standing->>'hotelMutationAllowed')::boolean, false) is not true
  then
    return jsonb_build_object('allowed', false, 'reason', 'property_denied');
  end if;

  v_role := v_standing->>'operationalRole';
  if v_role not in ('owner', 'general_manager') then
    return jsonb_build_object('allowed', false, 'reason', 'manager_floor');
  end if;
  if exists (
    select 1
    from public.capability_overrides override_row
    where override_row.property_id = p_property_id
      and override_row.capability = 'manage_team'
      and override_row.role = v_role
      and override_row.allowed is false
  ) then
    return jsonb_build_object('allowed', false, 'reason', 'capability_denied');
  end if;

  select coalesce(jsonb_agg(distinct entitlement->>'organizationId'), '[]'::jsonb)
    into v_organization_ids
  from jsonb_array_elements(coalesce(v_standing->'entitlements', '[]'::jsonb)) entitlement
  where entitlement->>'organizationId' is not null;

  return jsonb_build_object(
    'allowed', true,
    'role', v_role,
    'authorityMode', v_projection->>'authorityMode',
    'organizationIds', v_organization_ids
  );
end;
$$;

revoke all on function public._staxis_manage_team_context(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.staxis_claim_account_invite_acceptance(
  p_token_hash text,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.account_invites%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_token_hash is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_claim_token is null
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select invitation.* into v_invite
  from public.account_invites invitation
  where invitation.token_hash = p_token_hash
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_invite.accepted_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_used');
  end if;
  if v_invite.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_invite.acceptance_claim_token = p_claim_token then
    return jsonb_build_object(
      'ok', true, 'status', 'claimed', 'inviteId', v_invite.id,
      'claimExpiresAt', v_invite.acceptance_claimed_at + interval '10 minutes'
    );
  end if;
  if v_invite.acceptance_claim_token is not null
     and v_invite.acceptance_claimed_at > v_now - interval '10 minutes'
  then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;

  update public.account_invites invitation
     set acceptance_claim_token = p_claim_token,
         acceptance_claimed_at = v_now
   where invitation.id = v_invite.id;

  return jsonb_build_object(
    'ok', true, 'status', 'claimed', 'inviteId', v_invite.id,
    'claimExpiresAt', v_now + interval '10 minutes'
  );
end;
$$;

revoke all on function public.staxis_claim_account_invite_acceptance(text, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_claim_account_invite_acceptance(text, uuid)
  to service_role;

create or replace function public.staxis_release_account_invite_acceptance(
  p_invite_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row_count integer := 0;
begin
  if p_invite_id is null or p_claim_token is null then return false; end if;
  update public.account_invites invitation
     set acceptance_claim_token = null,
         acceptance_claimed_at = null
   where invitation.id = p_invite_id
     and invitation.accepted_at is null
     and invitation.acceptance_claim_token = p_claim_token;
  get diagnostics v_row_count = row_count;
  return v_row_count = 1;
end;
$$;

revoke all on function public.staxis_release_account_invite_acceptance(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_release_account_invite_acceptance(uuid, uuid)
  to service_role;

-- Finalize an invitation after Auth created the identity.  No account row is
-- visible unless the promised entitlement, normalized cutover, invite consume,
-- and audit record all commit with it.
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
set search_path = public, pg_temp
as $$
declare
  v_invite public.account_invites%rowtype;
  v_now timestamptz := clock_timestamp();
  v_context jsonb;
  v_account_id uuid;
  v_membership_id uuid;
  v_account_role text;
  v_candidate_username text;
  v_coverage uuid[];
  v_property_id uuid;
  v_current_org_id uuid;
  v_current_relationship_id uuid;
  v_current_org_type text;
  v_attempt integer;
begin
  if p_token_hash is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_claim_token is null
     or p_auth_user_id is null
     or p_username is null
     or lower(btrim(p_username)) !~ '^[a-z0-9._+-]{2,40}$'
     or p_display_name is null
     or char_length(btrim(p_display_name)) not between 1 and 120
  then
    raise exception 'invalid invitation acceptance input' using errcode = '22023';
  end if;

  select invitation.* into v_invite
  from public.account_invites invitation
  where invitation.token_hash = p_token_hash
  for update;
  if not found
     or v_invite.accepted_at is not null
     or v_invite.expires_at <= v_now
     or v_invite.acceptance_claim_token is distinct from p_claim_token
     or v_invite.acceptance_claimed_at <= v_now - interval '10 minutes'
  then
    raise exception 'invitation claim is no longer current' using errcode = '40001';
  end if;

  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_auth_user_id
      and lower(auth_user.email) = lower(v_invite.email)
  ) or exists (
    select 1 from public.accounts account where account.data_user_id = p_auth_user_id
  ) then
    raise exception 'Auth identity does not match this unused invitation'
      using errcode = '42501';
  end if;

  v_coverage := case
    when v_invite.membership_scope = 'property'
      then coalesce(v_invite.covered_property_ids, '{}'::uuid[])
    else '{}'::uuid[]
  end;

  -- Same first lock as the hotel-transfer primitive.  A transfer can neither
  -- interleave after this check nor make an old company's invite land in the
  -- acquiring company.
  for v_property_id in
    select distinct locked_id
    from unnest(array[v_invite.hotel_id] || v_coverage) locked_id
    order by locked_id
  loop
    perform 1 from public.properties property
      where property.id = v_property_id for update;
    if not found then raise exception 'invited hotel is unavailable' using errcode = 'P0002'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
  end loop;

  select relationship.organization_id, relationship.id, organization.organization_type
    into v_current_org_id, v_current_relationship_id, v_current_org_type
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id
   and organization.status = 'active'
  where relationship.property_id = v_invite.hotel_id
    and relationship.active_primary_count = 1
  order by relationship.id
  limit 1;
  if not found then
    raise exception 'invited hotel has no authoritative topology' using errcode = '23514';
  end if;
  -- Serialize final inviter authority with deactivation/admin-demotion and
  -- normalized entitlement changes. An open acceptance request never carries
  -- the inviter's earlier role across this boundary.
  perform public._staxis_lock_organization(
    coalesce(v_invite.organization_id, v_current_org_id)
  );
  begin
    lock table public.capability_overrides in share mode nowait;
  exception when lock_not_available then
    raise exception 'inviter capability changed concurrently'
      using errcode = '40001';
  end;
  perform 1
  from public.accounts inviter
  where inviter.id = v_invite.invited_by
  for share nowait;
  if not found then
    raise exception 'inviter no longer exists' using errcode = '42501';
  end if;
  perform 1
  from public.account_authorization_state state
  where state.account_id = v_invite.invited_by
  for share nowait;

  if v_invite.membership_scope is not null or v_invite.organization_id is not null then
    if v_invite.organization_id is null
       or v_invite.membership_scope not in ('company', 'property')
       or not (
         (v_invite.membership_scope = 'company'
           and v_invite.role in ('owner', 'vp', 'finance')
           and v_invite.covered_property_ids is null)
         or
         (v_invite.membership_scope = 'property'
           and v_invite.role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance')
           and cardinality(v_coverage) > 0
           and v_invite.hotel_id = any(v_coverage))
       )
       or v_current_org_type not in ('management_company', 'ownership_group')
       or v_current_org_id is distinct from v_invite.organization_id
    then
      raise exception 'invitation topology or promised job is no longer valid'
        using errcode = '42501';
    end if;

    if exists (
      select 1 from unnest(v_coverage) covered(property_id)
      where not exists (
        select 1
        from public._staxis_current_primary_property_relationships() relationship
        where relationship.organization_id = v_invite.organization_id
          and relationship.property_id = covered.property_id
          and relationship.active_primary_count = 1
      )
    ) then
      raise exception 'one or more invited hotels changed company' using errcode = '42501';
    end if;
    if not public._staxis_can_set_membership_hat(
      v_invite.invited_by,
      v_invite.organization_id,
      v_invite.membership_scope,
      v_invite.role,
      case when v_invite.membership_scope = 'property' then v_coverage else null end
    ) then
      raise exception 'inviter may no longer grant the promised job' using errcode = '42501';
    end if;

    v_account_role := case v_invite.role
      when 'owner' then 'owner'
      when 'vp' then 'front_desk'
      when 'finance' then 'front_desk'
      else v_invite.role
    end;
  else
    -- A legacy invite is safe only at the independent hotel it was created
    -- for.  Company hotels must use a topology-bound normalized invitation;
    -- otherwise a stale legacy manager could follow a transferred hotel id.
    v_context := public._staxis_manage_team_context(
      v_invite.invited_by,
      v_invite.hotel_id
    );
    if coalesce((v_context->>'allowed')::boolean, false) is not true
       or v_current_org_type <> 'single_hotel'
       or v_invite.role not in (
         'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'
       )
       or not (
         (v_invite.role in ('owner', 'general_manager')
           and v_context->>'role' in ('admin', 'owner'))
         or v_invite.role in ('front_desk', 'housekeeping', 'maintenance')
       )
    then
      raise exception 'legacy invitation is no longer valid for this hotel'
        using errcode = '42501';
    end if;
    v_account_role := v_invite.role;
  end if;

  -- Retry only username collisions.  The claim token makes the suffix stable
  -- across transport retries and avoids a pre-check race.
  for v_attempt in 0..4 loop
    v_candidate_username := case when v_attempt = 0 then lower(btrim(p_username))
      else left(lower(btrim(p_username)), 30)
        || substring(replace(p_claim_token::text, '-', ''), 1 + (v_attempt - 1) * 2, 6)
        || v_attempt::text
      end;
    begin
      insert into public.accounts (
        username, display_name, role, property_access, data_user_id
      ) values (
        v_candidate_username,
        btrim(p_display_name),
        v_account_role,
        case when v_invite.organization_id is null
          then array[v_invite.hotel_id] else '{}'::uuid[] end,
        p_auth_user_id
      ) returning id into v_account_id;
      exit;
    exception when unique_violation then
      if exists (
        select 1 from public.accounts account where account.data_user_id = p_auth_user_id
      ) then
        raise exception 'Auth identity already has an account' using errcode = '23505';
      end if;
      if v_attempt = 4 then
        raise exception 'could not allocate an account username' using errcode = '23505';
      end if;
    end;
  end loop;

  if v_invite.organization_id is not null then
    v_membership_id := public.staxis_set_membership_hat(
      v_invite.invited_by,
      v_invite.organization_id,
      v_account_id,
      v_invite.membership_scope,
      v_invite.role,
      case when v_invite.membership_scope = 'property'
        then to_jsonb(v_coverage) else null end,
      null
    );
    if v_membership_id is null or not exists (
      select 1
      from public.account_authorization_state state
      where state.account_id = v_account_id
        and state.authority_mode = 'normalized'
    ) then
      raise exception 'promised normalized entitlement did not activate'
        using errcode = '23514';
    end if;
    if v_invite.membership_scope = 'property' and exists (
      select 1 from unnest(v_coverage) covered(property_id)
      where not exists (
        select 1 from public._staxis_account_property_authorizations(v_account_id) authz
        where authz.property_id = covered.property_id
          and authz.entitlement_kind = 'membership_hat'
          and authz.entitlement_id = v_membership_id
      )
    ) then
      raise exception 'promised hotel coverage did not activate' using errcode = '23514';
    end if;
  end if;

  update public.account_invites invitation
     set accepted_at = v_now,
         accepted_by = v_account_id,
         acceptance_claim_token = null,
         acceptance_claimed_at = null
   where invitation.id = v_invite.id
     and invitation.accepted_at is null
     and invitation.acceptance_claim_token = p_claim_token;
  if not found then
    raise exception 'invitation claim changed before commit' using errcode = '40001';
  end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_auth_user_id,
    lower(v_invite.email),
    'invite.accept',
    'invite',
    v_invite.id::text,
    jsonb_build_object(
      'hotel_id', v_invite.hotel_id,
      'role', v_invite.role,
      'username', v_candidate_username,
      'scope', v_invite.membership_scope,
      'organizationId', v_invite.organization_id,
      'membershipId', v_membership_id,
      'authorityMode', case when v_invite.organization_id is null then 'legacy' else 'normalized' end
    )
  );

  return jsonb_build_object(
    'ok', true,
    'accountId', v_account_id,
    'email', lower(v_invite.email),
    'username', v_candidate_username,
    'normalized', v_invite.organization_id is not null,
    'membershipId', v_membership_id
  );
end;
$$;

revoke all on function public.staxis_accept_account_invite(text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.staxis_accept_account_invite(text, uuid, uuid, text, text)
  to service_role;

-- One commit for the My Hotel > People approval decision.  The property lock
-- serializes against company transfer; authoritative standing and capability
-- are recomputed after that lock.  Company hotels receive a normalized
-- property hat. Independent hotels retain the legacy array path.
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
  -- Entitlement projections use transaction-stable now(). Keep the new
  -- membership's starts_at on that same clock so the verification below can
  -- observe the hat in the transaction that creates it.
  v_now timestamptz := now();
  v_org_id uuid;
  v_org_type text;
  v_relationship_count integer;
  v_staff_id uuid;
  v_staff_link_account_id uuid;
  v_membership_id uuid;
  v_phone_lookup text;
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

  select target.* into v_account
  from public.accounts target
  where target.id = v_request.account_id
    and target.active is true
  for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'account_unavailable'); end if;
  if v_account.staff_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_linked');
  end if;
  if v_account.role not in ('front_desk', 'housekeeping', 'maintenance')
     or v_request.department <> v_account.role
  then
    return jsonb_build_object('ok', false, 'reason', 'role_mismatch');
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

  if v_org_type in ('management_company', 'ownership_group') then
    -- Grant-only and hat-based normalized managers are both represented in the
    -- winning standing provenance. Legacy managers are deliberately refused at
    -- a company hotel: their flat id array is not a safe delegation source.
    -- A platform admin is the explicit cross-tenant break-glass authority and
    -- has no customer organization entitlement to use as provenance.
    if v_context->>'role' <> 'admin'
       and (
         v_context->>'authorityMode' <> 'normalized'
         or not coalesce(v_context->'organizationIds', '[]'::jsonb)
           @> jsonb_build_array(v_org_id::text)
       )
    then
      return jsonb_build_object('ok', false, 'reason', 'normalized_manager_required');
    end if;
    perform public._staxis_lock_organization(v_org_id);
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
  insert into public.staff (
    property_id, name, phone, phone_lookup, language, is_senior, department,
    scheduled_today, weekly_hours, max_weekly_hours, max_days_per_week,
    days_worked_this_week, is_active
  ) values (
    p_property_id, v_request.name, coalesce(v_request.phone, ''), v_phone_lookup,
    v_request.language, false, v_request.department, false, 0, 40, 5, 0, true
  ) returning id into v_staff_id;

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
             'accountId', v_account.id, 'membershipId', v_membership_id,
             'authorityMode', case when v_membership_id is null then 'legacy' else 'normalized' end
           )
      from public.accounts actor where actor.id = p_actor_account_id;

  return jsonb_build_object(
    'ok', true, 'decided', 'approved', 'staffId', v_staff_id,
    'membershipId', v_membership_id,
    'authorityMode', case when v_membership_id is null then 'legacy' else 'normalized' end
  );
end;
$$;

revoke all on function public.staxis_decide_staff_join_request(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_decide_staff_join_request(uuid, uuid, uuid, text)
  to service_role;

insert into public.applied_migrations (version, description)
values (
  '0391',
  'Transactional exact-claim account invitation acceptance and authoritative staff join decisions with topology locks, normalized entitlements, and atomic audit'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
