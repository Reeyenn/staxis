-- 0411_first_person_onboarding.sql
--
-- Hotel shells now exist before any customer account. The first person is a
-- separate, platform-admin invitation whose Owner/General Manager role and
-- email are fixed by the inviter. Onboarding is six stages and resume authority
-- belongs to that exact account; legacy PMS/mapping/team markers remain stored
-- but no longer participate in progress.

begin;

do $requirements$
begin
  if to_regclass('public.hotel_join_codes') is null
     or to_regclass('public.properties') is null
     or to_regclass('public.accounts') is null
     or to_regprocedure('public._staxis_structural_account_property_ids(uuid)') is null
     or to_regprocedure('public.staxis_finalize_join_code_signup(uuid,text,uuid,integer,uuid,text,text,text,text,text,text)') is null
     or to_regprocedure('public.staxis_apply_onboarding_join_code_transition(uuid,uuid,text,text)') is null
     or to_regprocedure('public.staxis_resolve_or_mint_resume_join_code_guarded(uuid,uuid,uuid,text,text)') is null
  then
    raise exception '0411 requires the privileged onboarding boundary from migration 0398';
  end if;
end
$requirements$;

-- Company-wide people inherit every hotel their organization governs. Their
-- presence must not make a newly assigned shell look claimed. A direct hotel
-- account is different: legacy/shadow property_access, a normalized
-- property-scope hat/grant, or a still-valid cutover bridge is authoritative
-- evidence that this hotel already has a person of its own.
create or replace function public._staxis_hotel_has_direct_customer_account(
  p_hotel_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
    where account.role <> 'admin'
      and (
        (
          state.authority_mode in ('legacy', 'shadow')
          and p_hotel_id = any(coalesce(account.property_access, '{}'::uuid[]))
        )
        or (
          state.authority_mode = 'normalized'
          and (
            exists (
              select 1
              from public.organization_memberships membership
              join public.organizations organization
                on organization.id = membership.organization_id
               and organization.status = 'active'
               and organization.organization_type <> 'single_hotel'
              join public._staxis_current_primary_property_relationships() relationship
                on relationship.organization_id = membership.organization_id
               and relationship.property_id = p_hotel_id
               and relationship.active_primary_count = 1
              where membership.account_id = account.id
                and membership.status = 'active'
                and membership.starts_at <= clock_timestamp()
                and membership.ended_at is null
                and membership.membership_scope = 'property'
                and membership.staxis_role in (
                  'general_manager', 'front_desk', 'housekeeping', 'maintenance'
                )
                and p_hotel_id = any(
                  coalesce(membership.covered_property_ids, '{}'::uuid[])
                )
            )
            or exists (
              select 1
              from public.organization_access_grants grant_row
              join public.organization_memberships membership
                on membership.id = grant_row.membership_id
               and membership.organization_id = grant_row.organization_id
               and membership.account_id = account.id
               and membership.status = 'active'
               and membership.starts_at <= clock_timestamp()
               and membership.ended_at is null
              join public.organizations organization
                on organization.id = grant_row.organization_id
               and organization.status = 'active'
               and organization.organization_type <> 'single_hotel'
              join public._staxis_current_primary_property_relationships() relationship
                on relationship.id = grant_row.property_relationship_id
               and relationship.organization_id = grant_row.organization_id
               and relationship.property_id = grant_row.property_id
               and relationship.property_id = p_hotel_id
               and relationship.active_primary_count = 1
              where grant_row.scope_type = 'property'
                and grant_row.status = 'active'
                and grant_row.source <> 'legacy_backfill'
                and grant_row.starts_at <= clock_timestamp()
                and (
                  grant_row.expires_at is null
                  or grant_row.expires_at > clock_timestamp()
                )
            )
            or exists (
              select 1
              from public.account_property_authorization_bridges bridge
              where bridge.account_id = account.id
                and bridge.property_id = p_hotel_id
                and bridge.status = 'active'
                and (
                  (
                    bridge.cutover_relationship_id is null
                    and not exists (
                      select 1
                      from public._staxis_current_primary_property_relationships() current_relationship
                      where current_relationship.property_id = bridge.property_id
                    )
                  )
                  or exists (
                    select 1
                    from public._staxis_current_primary_property_relationships() current_relationship
                    where current_relationship.id = bridge.cutover_relationship_id
                      and current_relationship.organization_id = bridge.cutover_organization_id
                      and current_relationship.property_id = bridge.property_id
                      and current_relationship.active_primary_count = 1
                  )
                )
            )
          )
        )
      )
  );
$$;

revoke all on function public._staxis_hotel_has_direct_customer_account(uuid)
  from public, anon, authenticated, service_role;

comment on function public._staxis_hotel_has_direct_customer_account(uuid) is
  'Internal first-person guard. True only for a direct hotel customer account; inherited organization or portfolio reach is intentionally excluded.';

-- One platform-admin-issued first-person invitation. The role and normalized
-- email are persisted on the hotel in the same transaction as the credential,
-- so neither can be chosen or elevated by the invitee.
create or replace function public.staxis_mint_first_person_onboarding_invite(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_code text,
  p_role text,
  p_invited_email text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_code_text text := upper(btrim(coalesce(p_code, '')));
  v_email text := lower(btrim(coalesce(p_invited_email, '')));
  v_state jsonb;
  v_completed_at timestamptz;
  v_owner_id uuid;
  v_existing public.hotel_join_codes%rowtype;
  v_invite public.hotel_join_codes%rowtype;
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_hotel_id is null
     or p_role not in ('owner', 'general_manager')
     or v_code_text !~ '^[A-Z]{4}-[A-Z2-9]{10}$'
     or char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  perform 1
  from public.accounts actor
  where actor.id = p_actor_account_id
    and actor.data_user_id = p_actor_auth_user_id
    and actor.active is true
    and actor.role = 'admin'
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  select property.owner_id,
         property.onboarding_completed_at,
         coalesce(property.onboarding_state, jsonb_build_object('step', 1))
    into v_owner_id, v_completed_at, v_state
  from public.properties property
  where property.id = p_hotel_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));

  if v_completed_at is not null
     or nullif(v_state->>'accountCreatedAt', '') is not null
     or nullif(v_state->>'firstPersonAccountId', '') is not null
  then
    return jsonb_build_object('ok', false, 'reason', 'hotel_not_unclaimed');
  end if;
  if not exists (
    select 1
    from public.accounts placeholder
    where placeholder.data_user_id = v_owner_id
      and placeholder.active is true
      and placeholder.role = 'admin'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'hotel_not_unclaimed');
  end if;
  if public._staxis_hotel_has_direct_customer_account(p_hotel_id) then
    return jsonb_build_object('ok', false, 'reason', 'hotel_not_unclaimed');
  end if;

  select code_row.* into v_existing
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
    and code_row.code_kind = 'privileged_onboarding'
    and code_row.revoked_at is null
  for update;

  if found then
    if v_existing.used_count > 0 then
      return jsonb_build_object('ok', false, 'reason', 'hotel_not_unclaimed');
    end if;
    if v_existing.expires_at > v_now then
      if v_existing.role is distinct from p_role then
        return jsonb_build_object('ok', false, 'reason', 'role_conflict');
      end if;
      if nullif(v_state->>'invitedEmail', '') is not null
         and lower(v_state->>'invitedEmail') is distinct from v_email
      then
        return jsonb_build_object('ok', false, 'reason', 'email_conflict');
      end if;

      if nullif(v_state->>'invitedEmail', '') is null then
        v_state := jsonb_set(v_state, '{invitedEmail}', to_jsonb(v_email), true);
        update public.properties property
           set onboarding_state = v_state
         where property.id = p_hotel_id;
      end if;

      return jsonb_build_object(
        'ok', true,
        'schemaVersion', 'first-person-onboarding-invite-v1',
        'status', 'existing',
        'created', false,
        'codeId', v_existing.id,
        'hotelId', v_existing.hotel_id,
        'code', v_existing.code,
        'expiresAt', v_existing.expires_at,
        'role', v_existing.role,
        'invitedEmail', v_email
      );
    end if;

    update public.hotel_join_codes code_row
       set revoked_at = v_now
     where code_row.id = v_existing.id;
  end if;

  perform set_config('staxis.privileged_join_code_write', 'mint', true);
  begin
    insert into public.hotel_join_codes (
      hotel_id, code, role, code_kind, expires_at,
      max_uses, used_count, created_by, created_at
    ) values (
      p_hotel_id, v_code_text, p_role, 'privileged_onboarding',
      v_now + interval '7 days', 1, 0, p_actor_account_id, v_now
    ) returning * into v_invite;
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'code_collision');
    when sqlstate '55000' then
      return jsonb_build_object('ok', false, 'reason', 'hotel_not_unclaimed');
  end;

  v_state := jsonb_set(v_state, '{invitedEmail}', to_jsonb(v_email), true);
  if nullif(v_state->>'accountCreatedAt', '') is null then
    v_state := jsonb_set(v_state, '{step}', '1'::jsonb, true);
  end if;
  update public.properties property
     set onboarding_state = v_state
   where property.id = p_hotel_id;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id,
    'join_code.first_person_onboarding_mint',
    'join_code',
    v_invite.id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id,
      'role', p_role,
      'invited_email', v_email,
      'max_uses', 1,
      'expires_at', v_invite.expires_at,
      'request_id', nullif(btrim(p_request_id), '')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'first-person-onboarding-invite-v1',
    'status', 'created',
    'created', true,
    'codeId', v_invite.id,
    'hotelId', v_invite.hotel_id,
    'code', v_invite.code,
    'expiresAt', v_invite.expires_at,
    'role', v_invite.role,
    'invitedEmail', v_email
  );
end;
$$;

revoke all on function public.staxis_mint_first_person_onboarding_invite(
  uuid,uuid,uuid,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_mint_first_person_onboarding_invite(
  uuid,uuid,uuid,text,text,text,text
) to service_role;

comment on function public.staxis_mint_first_person_onboarding_invite(
  uuid,uuid,uuid,text,text,text,text
) is
  'Service-only platform-admin first-person invitation. Atomically binds one unclaimed hotel to an assigned Owner/GM role and normalized invited email.';

create or replace function public._staxis_guard_privileged_onboarding_join_code()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_context text := coalesce(
    current_setting('staxis.privileged_join_code_write', true), ''
  );
  v_property_owner_id uuid;
  v_onboarding_completed_at timestamptz;
  v_onboarding_state jsonb;
  v_creator_auth_user_id uuid;
  v_creator_role text;
  v_creator_active boolean;
  v_placeholder_account_id uuid;
  v_structural_change boolean := false;
begin
  if new.role is null or new.role not in ('owner', 'general_manager') then
    return new;
  end if;

  if new.code_kind = 'legacy_revoked' then
    if new.revoked_at is null then
      raise exception 'legacy privileged join codes cannot be reactivated'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.code_kind <> 'privileged_onboarding' then
    raise exception 'privileged join code kind is invalid'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if v_context <> 'mint' then
      raise exception 'privileged onboarding codes must be minted by the guarded RPC'
        using errcode = '42501';
    end if;
  else
    v_structural_change :=
      new.id is distinct from old.id
      or new.hotel_id is distinct from old.hotel_id
      or new.code is distinct from old.code
      or new.role is distinct from old.role
      or new.code_kind is distinct from old.code_kind
      or new.expires_at is distinct from old.expires_at
      or new.max_uses is distinct from old.max_uses
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or (old.revoked_at is not null and new.revoked_at is null);

    if v_structural_change and v_context <> 'mint' then
      raise exception 'privileged onboarding code structure is immutable outside mint'
        using errcode = '42501';
    end if;
    if new.used_count is distinct from old.used_count and not (
      (v_context = 'claim' and old.used_count = 0 and new.used_count = 1)
      or (v_context = 'release' and old.used_count = 1 and new.used_count = 0)
    ) then
      raise exception 'privileged onboarding code usage must use claim/release RPCs'
        using errcode = '42501';
    end if;
  end if;

  -- Revocation is always safe and remains available to existing operational
  -- tooling. Every live/unrevoked mutation below must re-prove hotel state.
  if new.revoked_at is not null then
    return new;
  end if;

  select property.owner_id,
         property.onboarding_completed_at,
         coalesce(property.onboarding_state, '{}'::jsonb)
    into v_property_owner_id,
         v_onboarding_completed_at,
         v_onboarding_state
  from public.properties property
  where property.id = new.hotel_id
  for update of property;

  if not found then
    raise exception 'privileged onboarding hotel does not exist'
      using errcode = '55000';
  end if;

  select creator.data_user_id, creator.role, creator.active
    into v_creator_auth_user_id, v_creator_role, v_creator_active
  from public.accounts creator
  where creator.id = new.created_by
  for update;

  if not found
     or v_creator_role is distinct from 'admin'
     or v_creator_active is distinct from true
     or v_creator_auth_user_id is null
  then
    raise exception 'privileged onboarding code requires an active platform-admin actor'
      using errcode = '55000';
  end if;

  -- The shell's NOT NULL owner_id is only a compatibility placeholder. Any
  -- active platform admin may invite the first person, even when a different
  -- active platform admin created the shell.
  select placeholder.id
    into v_placeholder_account_id
  from public.accounts placeholder
  where placeholder.data_user_id = v_property_owner_id
    and placeholder.role = 'admin'
    and placeholder.active is true
  for update;
  if not found then
    raise exception 'privileged onboarding code requires an active platform-admin placeholder owner'
      using errcode = '55000';
  end if;

  if v_onboarding_completed_at is not null
     or nullif(v_onboarding_state->>'accountCreatedAt', '') is not null
     or nullif(v_onboarding_state->>'firstPersonAccountId', '') is not null
  then
    raise exception 'hotel onboarding has already been claimed or completed'
      using errcode = '55000';
  end if;

  -- Direct hotel accounts are fail-closed repair evidence for older or
  -- non-atomic paths where the lifecycle marker failed to persist. Inherited
  -- company members deliberately do not claim each newly assigned hotel.
  if public._staxis_hotel_has_direct_customer_account(new.hotel_id) then
    raise exception 'hotel already has a direct customer account'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

revoke all on function public._staxis_guard_privileged_onboarding_join_code()
  from public, anon, authenticated, service_role;

create or replace function public.staxis_resolve_or_mint_resume_join_code_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_code text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_actor_email text;
  v_state jsonb;
  v_completed_at timestamptz;
  v_code_text text := upper(btrim(coalesce(p_code, '')));
  v_resume public.hotel_join_codes%rowtype;
  v_created boolean := false;
begin
  if p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_hotel_id is null
     or v_code_text !~ '^[A-Z]{4}-[A-Z2-9]{10}$'
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  select lower(auth_user.email)
    into v_actor_email
  from public.accounts actor
  join auth.users auth_user on auth_user.id = actor.data_user_id
  where actor.id = p_actor_account_id
    and actor.data_user_id = p_actor_auth_user_id
    and actor.active is true
    and actor.role in ('owner', 'general_manager')
  for update of actor;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  select coalesce(property.onboarding_state, '{}'::jsonb),
         property.onboarding_completed_at
    into v_state, v_completed_at
  from public.properties property
  where property.id = p_hotel_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));

  if v_completed_at is not null
     or nullif(v_state->>'accountCreatedAt', '') is null
     or (
       nullif(v_state->>'firstPersonAccountId', '') is not null
       and v_state->>'firstPersonAccountId' is distinct from p_actor_account_id::text
     )
     or p_hotel_id <> all(
       public._staxis_structural_account_property_ids(p_actor_account_id)
     )
  then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  perform 1
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
  for update;

  select code_row.* into v_resume
  from public.hotel_join_codes code_row
  where code_row.hotel_id = p_hotel_id
    and code_row.code_kind in ('onboarding_resume', 'privileged_onboarding')
    and code_row.revoked_at is null
    and code_row.expires_at > v_now
    and code_row.max_uses >= 1
    and code_row.used_count >= 0
    and code_row.code ~ '^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$'
    and exists (
      select 1
      from public._staxis_current_primary_property_relationships() relationship
      where relationship.property_id = code_row.hotel_id
        and relationship.active_primary_count = 1
        and relationship.starts_at <= code_row.created_at
    )
  order by code_row.created_at desc, code_row.id desc
  limit 1;

  if not found then
    begin
      insert into public.hotel_join_codes (
        hotel_id, code, role, code_kind, expires_at,
        max_uses, used_count, created_by, created_at
      ) values (
        p_hotel_id, v_code_text, null, 'onboarding_resume',
        v_now + interval '7 days', 1, 1, p_actor_account_id, v_now
      ) returning * into v_resume;
      v_created := true;
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'code_collision');
    end;

    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, metadata
    ) values (
      p_actor_auth_user_id,
      v_actor_email,
      'join_code.resume_create',
      'join_code',
      v_resume.id::text,
      jsonb_build_object(
        'hotel_id', p_hotel_id,
        'max_uses', 1,
        'used_count', 1,
        'expires_at', v_resume.expires_at,
        'request_id', nullif(btrim(p_request_id), '')
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'join-code-resume-v1',
    'status', case when v_created then 'created' else 'existing' end,
    'created', v_created,
    'codeId', v_resume.id,
    'hotelId', v_resume.hotel_id,
    'code', v_resume.code,
    'expiresAt', v_resume.expires_at
  );
end;
$$;

revoke all on function public.staxis_resolve_or_mint_resume_join_code_guarded(
  uuid,uuid,uuid,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_resolve_or_mint_resume_join_code_guarded(
  uuid,uuid,uuid,text,text
) to service_role;

comment on function public.staxis_resolve_or_mint_resume_join_code_guarded(uuid,uuid,uuid,text,text) is
  'Service-only first-person resume-code resolve/mint. Rechecks exact account binding, incomplete onboarding, actor identity, and live hotel authority; fallback is pre-consumed.';

create or replace function public.staxis_apply_onboarding_join_code_transition(
  p_code_id uuid,
  p_hotel_id uuid,
  p_transition text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_code public.hotel_join_codes%rowtype;
  v_state jsonb;
  v_next_state jsonb;
  v_current_step integer;
  v_changed boolean := false;
begin
  if p_code_id is null
     or p_hotel_id is null
     or p_transition not in ('welcome', 'account_created')
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- Match the relationship-transfer and staff-code RPC lock order.
  select coalesce(property.onboarding_state, jsonb_build_object('step', 1))
    into v_state
  from public.properties property
  where property.id = p_hotel_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));

  select code_row.* into v_code
  from public.hotel_join_codes code_row
  where code_row.id = p_code_id
    and code_row.hotel_id = p_hotel_id
  for update;
  if not found
     or v_code.revoked_at is not null
     or v_code.expires_at <= v_now
     or v_code.code_kind not in ('privileged_onboarding', 'onboarding_resume')
     or (
       select count(*)
       from public._staxis_current_primary_property_relationships() relationship
       where relationship.property_id = v_code.hotel_id
         and relationship.active_primary_count = 1
         and relationship.starts_at <= v_code.created_at
     ) <> 1
  then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  if p_transition = 'account_created' and not (
    v_code.code_kind = 'privileged_onboarding'
    and v_code.role in ('owner', 'general_manager')
    and v_code.used_count >= v_code.max_uses
  ) then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  v_next_state := v_state;
  if p_transition = 'welcome' then
    if nullif(v_state->>'accountCreatedAt', '') is null
       and coalesce((v_state->>'step')::integer, 1) <= 2
    then
      v_next_state := jsonb_set(v_state, '{step}', '2'::jsonb, true);
      v_changed := v_next_state is distinct from v_state;
    end if;
  elsif nullif(v_state->>'accountCreatedAt', '') is null then
    v_next_state := jsonb_set(
      v_state,
      '{accountCreatedAt}',
      to_jsonb(v_now),
      true
    );
    v_changed := true;
  end if;

  v_current_step := case
    when nullif(v_next_state->>'accountCreatedAt', '') is null
      then case when v_next_state->>'step' = '2' then 2 else 1 end
    when nullif(v_next_state->>'emailVerifiedAt', '') is null then 3
    when nullif(v_next_state->>'hotelDetailsAt', '') is null then 4
    when nullif(v_next_state->>'hotelContextAt', '') is null then 5
    else 6
  end;
  v_next_state := jsonb_set(v_next_state, '{step}', to_jsonb(v_current_step), true);

  if v_changed or v_next_state is distinct from v_state then
    update public.properties property
       set onboarding_state = v_next_state
     where property.id = p_hotel_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'onboarding-code-transition-v1',
    'status', case when v_changed then 'applied' else 'noop' end,
    'hotelId', p_hotel_id,
    'transition', p_transition,
    'currentStep', v_current_step
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok', false, 'reason', 'invalid_state');
end;
$$;

revoke all on function public.staxis_apply_onboarding_join_code_transition(
  uuid,uuid,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_apply_onboarding_join_code_transition(
  uuid,uuid,text,text
) to service_role;

comment on function public.staxis_apply_onboarding_join_code_transition(uuid,uuid,text,text) is
  'Service-only atomic welcome/account-created mutation using the six-stage first-person onboarding derivation.';

create or replace function public.staxis_finalize_join_code_signup(
  p_code_id uuid,
  p_code text,
  p_hotel_id uuid,
  p_expected_used_count integer,
  p_auth_user_id uuid,
  p_username text,
  p_display_name text,
  p_requested_role text,
  p_phone text,
  p_language text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz;
  v_code public.hotel_join_codes%rowtype;
  v_onboarding_state jsonb;
  v_next_state jsonb;
  v_current_step integer;
  v_final_role text;
  v_pending_approval boolean;
  v_account_id uuid;
  v_existing_username text;
  v_actor_email text;
  v_code_text text := upper(btrim(coalesce(p_code, '')));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if p_code_id is null
     or p_hotel_id is null
     or p_auth_user_id is null
     or octet_length(v_code_text) not between 6 and 128
     or v_code_text !~ '^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$'
     or p_expected_used_count is null
     or p_expected_used_count < 0
     or char_length(v_username) not between 1 and 40
     or octet_length(v_username) > 160
     or v_username !~ '^[a-z0-9._+-]+$'
     or char_length(v_display_name) not between 1 and 200
     or octet_length(v_display_name) > 800
     or char_length(coalesce(v_phone, '')) > 64
     or p_requested_role not in (
       'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance'
     )
     or p_language not in ('en', 'es')
     or char_length(coalesce(p_request_id, '')) > 200
  then
    return jsonb_build_object('ok', false, 'status', 'invalid');
  end if;

  -- Transfer and join-code writers all acquire property -> advisory -> code.
  -- A transfer that wins first revokes the code; a finalization that wins
  -- first commits its complete account before the transfer can revoke reach.
  select coalesce(property.onboarding_state, jsonb_build_object('step', 1))
    into v_onboarding_state
  from public.properties property
  where property.id = p_hotel_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));
  v_now := clock_timestamp();

  select code_row.* into v_code
  from public.hotel_join_codes code_row
  where code_row.id = p_code_id
    and code_row.hotel_id = p_hotel_id
    and code_row.code = v_code_text
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;

  if v_code.code_kind = 'privileged_onboarding'
     and v_code.role in ('owner', 'general_manager')
     and p_requested_role = v_code.role
  then
    v_final_role := v_code.role;
    v_pending_approval := false;
  elsif v_code.code_kind = 'staff_signup'
        and v_code.role is null
        and p_requested_role in ('front_desk', 'housekeeping', 'maintenance')
  then
    v_final_role := p_requested_role;
    v_pending_approval := true;
  elsif v_code.code_kind = 'staff_signup'
        and v_code.role in ('front_desk', 'housekeeping', 'maintenance')
        and p_requested_role = v_code.role
  then
    v_final_role := v_code.role;
    v_pending_approval := false;
  else
    return jsonb_build_object('ok', false, 'status', 'denied');
  end if;

  select lower(auth_user.email)
    into v_actor_email
  from auth.users auth_user
  where auth_user.id = p_auth_user_id
  for share;
  if not found then
    return jsonb_build_object('ok', false, 'status', 'auth_user_missing');
  end if;
  if v_code.code_kind = 'privileged_onboarding'
     and nullif(v_onboarding_state->>'invitedEmail', '') is not null
     and lower(v_onboarding_state->>'invitedEmail') is distinct from v_actor_email
  then
    return jsonb_build_object('ok', false, 'status', 'denied');
  end if;

  -- A retry after a committed-but-unacknowledged RPC recovers the exact
  -- result. The audit row and account must agree on every authority-bearing
  -- field; an unrelated account for the Auth identity is never adopted.
  select account.id, account.username
    into v_account_id, v_existing_username
  from public.admin_audit_log audit
  join public.accounts account
    on account.id::text = audit.metadata->>'account_id'
   and account.data_user_id = p_auth_user_id
  where audit.action = 'join_code.use'
    and audit.target_type = 'join_code'
    and audit.target_id = v_code.id::text
    and audit.actor_user_id = p_auth_user_id
    and audit.metadata->>'hotel_id' = p_hotel_id::text
    and audit.metadata->>'role' = v_final_role
    and audit.metadata->>'pending_approval' = v_pending_approval::text
    and audit.metadata->>'expected_used_count' = p_expected_used_count::text
    and v_code.used_count >= p_expected_used_count + 1
  order by audit.ts desc, audit.id desc
  limit 1;
  if found then
    return jsonb_build_object(
      'ok', true,
      'schemaVersion', 'join-code-signup-finalization-v1',
      'status', 'existing',
      'codeId', v_code.id,
      'hotelId', v_code.hotel_id,
      'accountId', v_account_id,
      'finalRole', v_final_role,
      'username', v_existing_username,
      'pendingApproval', v_pending_approval,
      'usedCount', p_expected_used_count + 1
    );
  end if;

  if exists (
    select 1 from public.accounts account
    where account.data_user_id = p_auth_user_id
  ) then
    return jsonb_build_object('ok', false, 'status', 'account_exists');
  end if;

  if v_code.revoked_at is not null then
    return jsonb_build_object('ok', false, 'status', 'revoked');
  end if;
  if v_code.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'status', 'expired');
  end if;
  if v_code.used_count >= v_code.max_uses then
    return jsonb_build_object('ok', false, 'status', 'used_up');
  end if;
  if v_code.used_count <> p_expected_used_count then
    return jsonb_build_object('ok', false, 'status', 'conflict');
  end if;
  if (
    select count(*)
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_code.hotel_id
      and relationship.active_primary_count = 1
      and relationship.starts_at <= v_code.created_at
  ) <> 1 then
    return jsonb_build_object('ok', false, 'status', 'denied');
  end if;

  -- Roll the code increment back to this savepoint if username allocation
  -- loses a race. Every later failure remains uncaught and rolls the entire
  -- RPC transaction back, including the account and code use.
  begin
    if v_code.code_kind = 'privileged_onboarding' then
      perform set_config('staxis.privileged_join_code_write', 'claim', true);
    end if;
    update public.hotel_join_codes code_row
       set used_count = code_row.used_count + 1
     where code_row.id = v_code.id;

    insert into public.accounts (
      username, display_name, role, property_access, data_user_id, phone
    ) values (
      v_username,
      v_display_name,
      v_final_role,
      case when v_pending_approval then '{}'::uuid[] else array[p_hotel_id] end,
      p_auth_user_id,
      v_phone
    ) returning id into v_account_id;
  exception
    when unique_violation then
      if exists (
        select 1 from public.accounts account
        where account.data_user_id = p_auth_user_id
      ) then
        return jsonb_build_object('ok', false, 'status', 'account_exists');
      end if;
      if exists (
        select 1 from public.accounts account
        where account.username = v_username
      ) then
        return jsonb_build_object('ok', false, 'status', 'username_conflict');
      end if;
      raise;
    when sqlstate '55000' then
      return jsonb_build_object('ok', false, 'status', 'denied');
  end;

  if v_pending_approval then
    insert into public.join_requests (
      property_id, account_id, name, phone, language, department
    ) values (
      p_hotel_id, v_account_id, v_display_name, v_phone, p_language, v_final_role
    );
  end if;

  if v_final_role = 'owner' then
    update public.properties property
       set owner_id = p_auth_user_id
     where property.id = p_hotel_id;
  end if;

  if v_code.code_kind = 'privileged_onboarding' then
    v_next_state := jsonb_set(
      v_onboarding_state,
      '{accountCreatedAt}',
      to_jsonb(v_now),
      true
    );
    v_next_state := jsonb_set(
      v_next_state,
      '{firstPersonAccountId}',
      to_jsonb(v_account_id::text),
      true
    );
    v_current_step := case
      when nullif(v_next_state->>'emailVerifiedAt', '') is null then 3
      when nullif(v_next_state->>'hotelDetailsAt', '') is null then 4
      when nullif(v_next_state->>'hotelContextAt', '') is null then 5
      else 6
    end;
    v_next_state := jsonb_set(
      v_next_state, '{step}', to_jsonb(v_current_step), true
    );
    update public.properties property
       set onboarding_state = v_next_state
     where property.id = p_hotel_id;
  end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_auth_user_id,
    v_actor_email,
    'join_code.use',
    'join_code',
    v_code.id::text,
    jsonb_build_object(
      'account_id', v_account_id,
      'hotel_id', p_hotel_id,
      'role', v_final_role,
      'username', v_username,
      'has_phone', v_phone is not null,
      'owner_id_transferred', v_final_role = 'owner',
      'pending_approval', v_pending_approval,
      'expected_used_count', p_expected_used_count,
      'used_count', p_expected_used_count + 1,
      'request_id', nullif(btrim(p_request_id), '')
    )
  );

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'join-code-signup-finalization-v1',
    'status', 'finalized',
    'codeId', v_code.id,
    'hotelId', v_code.hotel_id,
    'accountId', v_account_id,
    'finalRole', v_final_role,
    'username', v_username,
    'pendingApproval', v_pending_approval,
    'usedCount', p_expected_used_count + 1
  );
end;
$$;

revoke all on function public.staxis_finalize_join_code_signup(
  uuid,text,uuid,integer,uuid,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_finalize_join_code_signup(
  uuid,text,uuid,integer,uuid,text,text,text,text,text,text
) to service_role;

comment on function public.staxis_finalize_join_code_signup(
  uuid,text,uuid,integer,uuid,text,text,text,text,text,text
) is
  'Service-only idempotent signup finalizer. First-person redemption rechecks an assigned email when present, records the exact account, and derives six-stage progress atomically.';

-- Deterministically bind retained, already-redeemed privileged onboarding
-- records to the account recorded by 0398's transactional finalizer. This is
-- compatibility only: new invitations write the binding in the finalizer.
with ranked_first_people as (
  select property.id as property_id,
         account.id as account_id,
         lower(nullif(btrim(audit.actor_email), '')) as redeemed_email,
         row_number() over (
           partition by property.id
           order by audit.ts asc, audit.id asc
         ) as candidate_rank
  from public.properties property
  join public.hotel_join_codes code_row
    on code_row.hotel_id = property.id
   and code_row.code_kind = 'privileged_onboarding'
  join public.admin_audit_log audit
    on audit.action = 'join_code.use'
   and audit.target_type = 'join_code'
   and audit.target_id = code_row.id::text
   and audit.metadata->>'hotel_id' = property.id::text
  join public.accounts account
    on account.id::text = audit.metadata->>'account_id'
   and account.data_user_id = audit.actor_user_id
   and account.role in ('owner', 'general_manager')
  where property.onboarding_completed_at is null
    and nullif(property.onboarding_state->>'accountCreatedAt', '') is not null
    and nullif(property.onboarding_state->>'firstPersonAccountId', '') is null
), chosen_first_people as (
  select *
  from ranked_first_people
  where candidate_rank = 1
)
update public.properties property
   set onboarding_state = jsonb_set(
     case
       when nullif(property.onboarding_state->>'invitedEmail', '') is null
        and chosen.redeemed_email is not null
        and chosen.redeemed_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       then jsonb_set(
         property.onboarding_state,
         '{invitedEmail}',
         to_jsonb(chosen.redeemed_email),
         true
       )
       else property.onboarding_state
     end,
     '{firstPersonAccountId}',
     to_jsonb(chosen.account_id::text),
     true
   )
from chosen_first_people chosen
where property.id = chosen.property_id;

-- Retained unused privileged invites predate an explicit step marker. Stamp
-- only those active credentials so the admin journey can distinguish them
-- from historical live hotels whose state is the legacy empty object.
update public.properties property
   set onboarding_state = jsonb_set(
     coalesce(property.onboarding_state, '{}'::jsonb),
     '{step}',
     '1'::jsonb,
     true
   )
 where property.onboarding_completed_at is null
   and coalesce(property.onboarding_state, '{}'::jsonb) = '{}'::jsonb
   and exists (
     select 1
     from public.hotel_join_codes code_row
     where code_row.hotel_id = property.id
       and code_row.code_kind = 'privileged_onboarding'
       and code_row.revoked_at is null
       and code_row.used_count = 0
       and code_row.expires_at > clock_timestamp()
   );

-- Rewrite only the stored progress pointer for incomplete, already-started
-- records. All legacy PMS/mapping/team keys remain intact and auditable.
update public.properties property
   set onboarding_state = jsonb_set(
     property.onboarding_state,
     '{step}',
     to_jsonb(case
       when nullif(property.onboarding_state->>'emailVerifiedAt', '') is null then 3
       when nullif(property.onboarding_state->>'hotelDetailsAt', '') is null then 4
       when nullif(property.onboarding_state->>'hotelContextAt', '') is null then 5
       else 6
     end),
     true
   )
 where property.onboarding_completed_at is null
   and nullif(property.onboarding_state->>'accountCreatedAt', '') is not null;

-- ─── applied_migrations bookkeeping ──────────────────────────────────────
INSERT INTO public.applied_migrations (version, description)
VALUES (
  '0411',
  'first-person hotel onboarding: platform admins mint immutable Owner/GM invitations for pre-created zero-user hotel shells; onboarding and resume use six customer stages without PMS, mapping, or team; inherited organization members do not claim a newly assigned hotel while direct hotel accounts remain fail-closed.'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
