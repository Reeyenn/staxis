-- 0422_authoritative_invite_acceptance_shadow_rpc.sql
--
-- Stage A invitation foundation. Claiming an invitation remains a reservation,
-- not access. Only the existing transactional acceptance RPC can create the
-- account/entitlement/link. This service-only assertion reports whether that
-- accepted fact is visible through the still-current legacy or normalized
-- authority without granting or unioning anything.

begin;

do $$
begin
  if to_regclass('public.account_invites') is null
     or to_regclass('public.account_authorization_state') is null
     or to_regprocedure('public._staxis_account_property_authorizations(uuid)') is null
     or to_regprocedure('public.staxis_people_access_shadow(uuid,uuid)') is null
  then
    raise exception '0422 requires the existing transactional invitation and Stage A People foundations';
  end if;
end
$$;

create or replace function public.staxis_invite_access_shadow(
  p_invite_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_invite public.account_invites%rowtype;
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_access_established boolean := false;
  v_roster_bound boolean := true;
  v_reason text := 'pending_acceptance';
begin
  if p_invite_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select invitation.* into v_invite
  from public.account_invites invitation
  where invitation.id = p_invite_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'invite_not_found');
  end if;

  if v_invite.accepted_at is null or v_invite.accepted_by is null then
    return jsonb_build_object(
      'ok', true,
      'schemaVersion', 'stage-a-invite-access-shadow-v1',
      'inviteId', p_invite_id,
      'accepted', false,
      'accessEstablished', false,
      'claimIsAccess', false,
      'reason', v_reason,
      'hotelId', v_invite.hotel_id,
      'organizationId', v_invite.organization_id,
      'membershipScope', v_invite.membership_scope
    );
  end if;

  select account.* into v_account
  from public.accounts account
  where account.id = v_invite.accepted_by;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'schemaVersion', 'stage-a-invite-access-shadow-v1',
      'inviteId', p_invite_id,
      'accepted', true,
      'accessEstablished', false,
      'reason', 'accepted_account_missing'
    );
  end if;
  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = v_account.id;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'schemaVersion', 'stage-a-invite-access-shadow-v1',
      'inviteId', p_invite_id,
      'accepted', true,
      'accessEstablished', false,
      'reason', 'accepted_account_authority_missing'
    );
  end if;

  if v_account.active is true
     and v_account.data_user_id is not null
     and exists (
       select 1 from auth.users auth_user where auth_user.id = v_account.data_user_id
     )
  then
    if v_state.authority_mode in ('legacy', 'shadow') then
      v_access_established := v_invite.hotel_id = any(
        coalesce(v_account.property_access, '{}'::uuid[])
      );
    elsif v_state.authority_mode = 'normalized' then
      v_access_established := exists (
        select 1
        from public._staxis_account_property_authorizations(v_account.id) authz
        where authz.property_id = v_invite.hotel_id
      );
    end if;
  end if;

  if v_invite.target_staff_id is not null then
    v_roster_bound := v_account.staff_id = v_invite.target_staff_id
      and exists (
        select 1
        from public.account_property_staff_links link
        where link.account_id = v_account.id
          and link.property_id = v_invite.hotel_id
          and link.staff_id = v_invite.target_staff_id
          and link.is_active is true
      );
  end if;

  if v_account.active is not true then
    v_reason := 'accepted_account_inactive';
  elsif v_access_established is not true then
    v_reason := 'accepted_without_current_property_access';
  elsif v_roster_bound is not true then
    v_reason := 'accepted_without_promised_roster_link';
  else
    v_reason := 'accepted_and_access_established';
  end if;

  return jsonb_build_object(
    'ok', v_access_established and v_roster_bound and v_account.active is true,
    'schemaVersion', 'stage-a-invite-access-shadow-v1',
    'inviteId', p_invite_id,
    'accepted', true,
    'accessEstablished', v_access_established,
    'claimIsAccess', false,
    'rosterBound', v_roster_bound,
    'accountId', v_account.id,
    'accountActive', v_account.active,
    'authIdentityLinked', v_account.data_user_id is not null
      and exists (select 1 from auth.users auth_user where auth_user.id = v_account.data_user_id),
    'authorityMode', v_state.authority_mode,
    'hotelId', v_invite.hotel_id,
    'organizationId', v_invite.organization_id,
    'membershipScope', v_invite.membership_scope,
    'reason', v_reason
  );
end;
$$;

comment on function public.staxis_invite_access_shadow(uuid) is
  'Stage A service-only invitation assertion. A claim or pending invite never reports access; accepted access must be visible through one current authority and any promised roster link must be present.';

revoke all on function public.staxis_invite_access_shadow(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_invite_access_shadow(uuid)
  to service_role;

insert into public.applied_migrations (version, description)
values (
  '0422',
  'Stage A service-only invitation acceptance assertion; pending claims remain non-authorizing and existing acceptance RPCs remain the only access-establishing path.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
