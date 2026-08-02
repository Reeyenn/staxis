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
  v_account_available boolean := false;
  v_auth_identity_linked boolean := false;
  v_topology_valid boolean := false;
  v_promised_coverage_complete boolean := false;
  v_access_established boolean := false;
  v_roster_bound boolean := true;
  v_roster_promised boolean := false;
  v_roster_link_exists boolean := false;
  v_account_staff_link_active boolean := false;
  v_target_staff_exists boolean := false;
  v_target_staff_active boolean := false;
  v_roster_role_matches boolean := false;
  v_roster_target_valid boolean := false;
  v_reason text := 'pending_acceptance';
  v_topology_reason text := 'pending_acceptance';
  v_promised_property_ids uuid[] := '{}'::uuid[];
  v_current_property_ids uuid[] := '{}'::uuid[];
  v_raw_property_ids uuid[] := '{}'::uuid[];
  v_missing_property_ids uuid[] := '{}'::uuid[];
  v_extra_property_ids uuid[] := '{}'::uuid[];
  v_current_topology_property_ids uuid[] := '{}'::uuid[];
  v_missing_topology_property_ids uuid[] := '{}'::uuid[];
  v_extra_topology_property_ids uuid[] := '{}'::uuid[];
  v_invited_organization_status text;
  v_invited_organization_type text;
  v_current_organization_id uuid;
  v_current_organization_type text;
  v_current_organization_status text;
  v_target_staff_property_id uuid;
  v_target_staff_department text;
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

  -- Organization facts are part of the assertion, not a grant. The current
  -- valid-topology helper requires the exact primary relationship plus an
  -- active governing organization of an allowed type, so suspended, stale,
  -- cross-company, and vendor/brand relationships cannot look current.
  if v_invite.organization_id is not null then
    select organization.status, organization.organization_type
      into v_invited_organization_status, v_invited_organization_type
    from public.organizations organization
    where organization.id = v_invite.organization_id;
  end if;

  if v_invite.membership_scope is null then
    v_promised_property_ids := array[v_invite.hotel_id];
    select coalesce(array(
             select distinct relationship.property_id
             from public._staxis_cutover_valid_current_primary_property_relationships() relationship
             where relationship.property_id = v_invite.hotel_id
               and relationship.active_primary_count = 1
             order by relationship.property_id
           ), '{}'::uuid[]),
           (array_agg(relationship.organization_id order by relationship.id))[1],
           (array_agg(relationship.organization_type order by relationship.id))[1],
           (array_agg(relationship.organization_status order by relationship.id))[1]
      into v_current_topology_property_ids, v_current_organization_id,
           v_current_organization_type, v_current_organization_status
    from public._staxis_cutover_valid_current_primary_property_relationships() relationship
    where relationship.property_id = v_invite.hotel_id
      and relationship.active_primary_count = 1;
    -- A legacy NULL-scope invite promises the independent hotel's anchor
    -- only while that exact current primary relationship is still an active
    -- single_hotel organization. A later transfer to a company topology is
    -- a different promise and must invalidate the accepted invite.
    v_topology_valid := cardinality(v_current_topology_property_ids) = 1
      and v_current_organization_type is not distinct from 'single_hotel';
    v_topology_reason := case when v_topology_valid then 'valid'
      else 'legacy_anchor_topology_invalid' end;
  elsif v_invite.membership_scope = 'company' then
    select coalesce(array(
             select distinct relationship.property_id
             from public._staxis_cutover_valid_current_primary_property_relationships() relationship
             where relationship.organization_id = v_invite.organization_id
               and relationship.organization_type in ('management_company', 'ownership_group')
               and relationship.active_primary_count = 1
             order by relationship.property_id
           ), '{}'::uuid[])
      into v_promised_property_ids;
    v_current_topology_property_ids := v_promised_property_ids;
    v_current_organization_id := case
      when v_invited_organization_status = 'active'
       and v_invited_organization_type in ('management_company', 'ownership_group')
      then v_invite.organization_id else null end;
    v_current_organization_type := v_invited_organization_type;
    v_current_organization_status := v_invited_organization_status;
    v_topology_valid := v_current_organization_id is not null
      and cardinality(v_promised_property_ids) > 0;
    v_topology_reason := case
      when v_invite.organization_id is null then 'company_invite_organization_missing'
      when v_invited_organization_status is distinct from 'active'
        then 'company_invite_organization_inactive_or_missing'
      when v_invited_organization_type not in ('management_company', 'ownership_group')
        then 'company_invite_organization_type_invalid'
      when cardinality(v_promised_property_ids) = 0
        then 'company_invite_has_no_current_governed_properties'
      else 'valid'
    end;
  elsif v_invite.membership_scope = 'property' then
    v_promised_property_ids := coalesce(v_invite.covered_property_ids, '{}'::uuid[]);
    select coalesce(array(
             select distinct relationship.property_id
             from public._staxis_cutover_valid_current_primary_property_relationships() relationship
             where relationship.organization_id = v_invite.organization_id
               and relationship.organization_type in ('management_company', 'ownership_group')
               and relationship.active_primary_count = 1
             order by relationship.property_id
           ), '{}'::uuid[])
      into v_current_topology_property_ids;
    v_current_organization_id := case
      when v_invited_organization_status = 'active'
       and v_invited_organization_type in ('management_company', 'ownership_group')
      then v_invite.organization_id else null end;
    v_current_organization_type := v_invited_organization_type;
    v_current_organization_status := v_invited_organization_status;
    v_topology_valid := v_current_organization_id is not null
      and cardinality(v_promised_property_ids) > 0
      and cardinality(array(
        select distinct promised.property_id
        from unnest(v_promised_property_ids) promised(property_id)
        except
        select distinct current_property.property_id
        from unnest(v_current_topology_property_ids) current_property(property_id)
      )) = 0;
    v_topology_reason := case
      when v_invite.organization_id is null then 'property_invite_organization_missing'
      when v_invited_organization_status is distinct from 'active'
        then 'property_invite_organization_inactive_or_missing'
      when v_invited_organization_type not in ('management_company', 'ownership_group')
        then 'property_invite_organization_type_invalid'
      when not v_topology_valid then 'property_invite_topology_stale_or_cross_company'
      else 'valid'
    end;
  else
    v_topology_reason := 'invite_scope_invalid';
  end if;

  select coalesce(array(
           select distinct promised.property_id
           from unnest(v_promised_property_ids) promised(property_id)
           except
           select distinct current_property.property_id
           from unnest(v_current_topology_property_ids) current_property(property_id)
         ), '{}'::uuid[])
    into v_missing_topology_property_ids;
  select coalesce(array(
           select distinct current_property.property_id
           from unnest(v_current_topology_property_ids) current_property(property_id)
           except
           select distinct promised.property_id
           from unnest(v_promised_property_ids) promised(property_id)
         ), '{}'::uuid[])
    into v_extra_topology_property_ids;

  if v_invite.target_staff_id is not null then
    v_roster_promised := true;
    -- Keep this assertion in lockstep with _staxis_lock_invite_target_staff:
    -- the effective department is coalesce(department, 'housekeeping'), and
    -- only the three operational invite roles can bind a roster identity.
    select staff.property_id,
           coalesce(staff.is_active, false),
           coalesce(staff.department, 'housekeeping')
      into v_target_staff_property_id,
           v_target_staff_active,
           v_target_staff_department
    from public.staff staff
    where staff.id = v_invite.target_staff_id;
    v_target_staff_exists := found;
    if not v_target_staff_exists then
      v_target_staff_active := false;
    end if;
    v_roster_target_valid := coalesce(
      v_target_staff_exists
        and v_target_staff_property_id = v_invite.hotel_id,
      false
    );
    v_roster_role_matches := coalesce(v_target_staff_exists
      and v_invite.role in ('front_desk', 'housekeeping', 'maintenance')
      and v_target_staff_department = v_invite.role, false);
  end if;

  -- A pending claim has no account fact to inspect. It still receives the
  -- complete persisted promise/topology description, while claimIsAccess and
  -- accessEstablished remain false.
  if v_invite.accepted_at is null or v_invite.accepted_by is null then
    return jsonb_build_object(
      'ok', true,
      'schemaVersion', 'stage-a-invite-access-shadow-v1',
      'inviteId', p_invite_id,
      'accepted', false,
      'accessEstablished', false,
      'claimIsAccess', false,
      'currentAccessValid', false,
      'promisedCoverageComplete', false,
      'authIdentityLinked', false,
      'accountAvailable', false,
      'accountActive', false,
      'rosterPromised', v_roster_promised,
      'rosterBound', false,
      'rosterLinkExists', false,
      'accountStaffLinkActive', false,
      'targetStaffExists', v_target_staff_exists,
      'targetStaffActive', v_target_staff_active,
      'targetStaffDepartment', v_target_staff_department,
      'rosterRoleMatches', v_roster_role_matches,
      'targetStaffPropertyId', v_target_staff_property_id,
      'targetStaffMatchesAnchor', v_roster_target_valid,
      'topologyValid', v_topology_valid,
      'topologyReason', v_topology_reason,
      'promisedPropertyIds', to_jsonb(v_promised_property_ids),
      'currentPropertyIds', '[]'::jsonb,
      'rawPropertyIds', '[]'::jsonb,
      'missingPropertyIds', to_jsonb(v_promised_property_ids),
      'extraPropertyIds', '[]'::jsonb,
      'currentTopologyPropertyIds', to_jsonb(v_current_topology_property_ids),
      'missingTopologyPropertyIds', to_jsonb(v_missing_topology_property_ids),
      'extraTopologyPropertyIds', to_jsonb(v_extra_topology_property_ids),
      'hotelId', v_invite.hotel_id,
      'organizationId', v_invite.organization_id,
      'membershipScope', v_invite.membership_scope,
      'invitedOrganizationStatus', v_invited_organization_status,
      'invitedOrganizationType', v_invited_organization_type,
      'currentOrganizationId', v_current_organization_id,
      'currentOrganizationStatus', v_current_organization_status,
      'currentOrganizationType', v_current_organization_type,
      'rosterBinding', jsonb_build_object(
        'promised', v_roster_promised,
        'bound', false,
        'targetStaffId', v_invite.target_staff_id,
        'exists', v_target_staff_exists,
        'active', v_target_staff_active,
        'department', v_target_staff_department,
        'roleMatchesDepartment', v_roster_role_matches,
        'accountStaffLinkActive', false,
        'targetStaffPropertyId', v_target_staff_property_id,
        'targetStaffMatchesAnchor', v_roster_target_valid
      ),
      'reason', 'pending_acceptance'
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
      'currentAccessValid', false,
      'promisedCoverageComplete', false,
      'accountAvailable', false,
      'authIdentityLinked', false,
      'rosterPromised', v_roster_promised,
      'rosterBound', false,
      'rosterLinkExists', false,
      'accountStaffLinkActive', false,
      'targetStaffExists', v_target_staff_exists,
      'targetStaffActive', v_target_staff_active,
      'targetStaffDepartment', v_target_staff_department,
      'rosterRoleMatches', v_roster_role_matches,
      'targetStaffPropertyId', v_target_staff_property_id,
      'targetStaffMatchesAnchor', v_roster_target_valid,
      'topologyValid', v_topology_valid,
      'topologyReason', v_topology_reason,
      'promisedPropertyIds', to_jsonb(v_promised_property_ids),
      'currentPropertyIds', '[]'::jsonb,
      'rawPropertyIds', '[]'::jsonb,
      'missingPropertyIds', to_jsonb(v_promised_property_ids),
      'extraPropertyIds', '[]'::jsonb,
      'currentTopologyPropertyIds', to_jsonb(v_current_topology_property_ids),
      'missingTopologyPropertyIds', to_jsonb(v_missing_topology_property_ids),
      'extraTopologyPropertyIds', to_jsonb(v_extra_topology_property_ids),
      'hotelId', v_invite.hotel_id,
      'organizationId', v_invite.organization_id,
      'membershipScope', v_invite.membership_scope,
      'invitedOrganizationStatus', v_invited_organization_status,
      'invitedOrganizationType', v_invited_organization_type,
      'currentOrganizationId', v_current_organization_id,
      'currentOrganizationStatus', v_current_organization_status,
      'currentOrganizationType', v_current_organization_type,
      'rosterBinding', jsonb_build_object(
        'promised', v_roster_promised,
        'bound', false,
        'targetStaffId', v_invite.target_staff_id,
        'exists', v_target_staff_exists,
        'active', v_target_staff_active,
        'department', v_target_staff_department,
        'roleMatchesDepartment', v_roster_role_matches,
        'accountStaffLinkActive', false,
        'targetStaffPropertyId', v_target_staff_property_id,
        'targetStaffMatchesAnchor', v_roster_target_valid
      ),
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
      'currentAccessValid', false,
      'promisedCoverageComplete', false,
      'accountAvailable', true,
      'authIdentityLinked', false,
      'accountActive', v_account.active,
      'rosterPromised', v_roster_promised,
      'rosterBound', false,
      'rosterLinkExists', false,
      'accountStaffLinkActive', false,
      'targetStaffExists', v_target_staff_exists,
      'targetStaffActive', v_target_staff_active,
      'targetStaffDepartment', v_target_staff_department,
      'rosterRoleMatches', v_roster_role_matches,
      'targetStaffPropertyId', v_target_staff_property_id,
      'targetStaffMatchesAnchor', v_roster_target_valid,
      'topologyValid', v_topology_valid,
      'topologyReason', v_topology_reason,
      'promisedPropertyIds', to_jsonb(v_promised_property_ids),
      'currentPropertyIds', '[]'::jsonb,
      'rawPropertyIds', to_jsonb(coalesce(v_account.property_access, '{}'::uuid[])),
      'missingPropertyIds', to_jsonb(v_promised_property_ids),
      'extraPropertyIds', '[]'::jsonb,
      'currentTopologyPropertyIds', to_jsonb(v_current_topology_property_ids),
      'missingTopologyPropertyIds', to_jsonb(v_missing_topology_property_ids),
      'extraTopologyPropertyIds', to_jsonb(v_extra_topology_property_ids),
      'hotelId', v_invite.hotel_id,
      'organizationId', v_invite.organization_id,
      'membershipScope', v_invite.membership_scope,
      'invitedOrganizationStatus', v_invited_organization_status,
      'invitedOrganizationType', v_invited_organization_type,
      'currentOrganizationId', v_current_organization_id,
      'currentOrganizationStatus', v_current_organization_status,
      'currentOrganizationType', v_current_organization_type,
      'rosterBinding', jsonb_build_object(
        'promised', v_roster_promised,
        'bound', false,
        'targetStaffId', v_invite.target_staff_id,
        'exists', v_target_staff_exists,
        'active', v_target_staff_active,
        'department', v_target_staff_department,
        'roleMatchesDepartment', v_roster_role_matches,
        'accountStaffLinkActive', false,
        'targetStaffPropertyId', v_target_staff_property_id,
        'targetStaffMatchesAnchor', v_roster_target_valid
      ),
      'reason', 'accepted_account_authority_missing'
    );
  end if;

  v_account_available := true;
  v_auth_identity_linked := v_account.data_user_id is not null
    and exists (
      select 1 from auth.users auth_user where auth_user.id = v_account.data_user_id
    );

  v_raw_property_ids := coalesce(v_account.property_access, '{}'::uuid[]);
  if v_state.authority_mode in ('legacy', 'shadow') then
    select coalesce(array(
             select distinct legacy.property_id
             from unnest(v_raw_property_ids) legacy(property_id)
             join public._staxis_cutover_valid_current_primary_property_relationships() relationship
               on relationship.property_id = legacy.property_id
              and relationship.active_primary_count = 1
              and (
                relationship.organization_type = 'single_hotel'
                or not exists (
                  select 1
                  from public._staxis_cutover_real_account_organizations() real_org
                  where real_org.account_id = v_account.id
                )
                or exists (
                  select 1
                  from public._staxis_cutover_real_account_organizations() real_org
                  where real_org.account_id = v_account.id
                    and real_org.organization_id = relationship.organization_id
                )
              )
             order by legacy.property_id
           ), '{}'::uuid[])
      into v_current_property_ids;
  elsif v_state.authority_mode = 'normalized' then
    select coalesce(array(
             select distinct authz.property_id
             from public._staxis_account_property_authorizations(v_account.id) authz
             join public._staxis_cutover_valid_current_primary_property_relationships() relationship
               on relationship.property_id = authz.property_id
              and relationship.active_primary_count = 1
              and (
                relationship.organization_type = 'single_hotel'
                or not exists (
                  select 1
                  from public._staxis_cutover_real_account_organizations() real_org
                  where real_org.account_id = v_account.id
                )
                or exists (
                  select 1
                  from public._staxis_cutover_real_account_organizations() real_org
                  where real_org.account_id = v_account.id
                    and real_org.organization_id = relationship.organization_id
                )
              )
             order by authz.property_id
           ), '{}'::uuid[])
      into v_current_property_ids;
  end if;

  select coalesce(array(
           select distinct promised.property_id
           from unnest(v_promised_property_ids) promised(property_id)
           except
           select distinct current_property.property_id
           from unnest(v_current_property_ids) current_property(property_id)
         ), '{}'::uuid[])
    into v_missing_property_ids;
  select coalesce(array(
           select distinct current_property.property_id
           from unnest(v_current_property_ids) current_property(property_id)
           except
           select distinct promised.property_id
           from unnest(v_promised_property_ids) promised(property_id)
         ), '{}'::uuid[])
    into v_extra_property_ids;

  v_promised_coverage_complete := v_topology_valid
    and cardinality(v_promised_property_ids) > 0
    and cardinality(v_missing_property_ids) = 0;
  v_access_established := v_account.active is true
    and v_auth_identity_linked
    and v_promised_coverage_complete;

  if v_roster_promised then
    v_account_staff_link_active := exists (
      select 1
      from public.account_property_staff_links link
      where link.account_id = v_account.id
        and link.property_id = v_invite.hotel_id
        and link.staff_id = v_invite.target_staff_id
        and link.is_active is true
    );
    v_roster_link_exists := coalesce(
      v_account.staff_id = v_invite.target_staff_id,
      false
    ) and v_account_staff_link_active;
    v_roster_bound := coalesce(v_account.active is true
      and v_target_staff_exists
      and v_target_staff_active
      and v_roster_target_valid
      and v_roster_role_matches
      and v_roster_link_exists, false);
  end if;

  if v_account.active is not true then
    v_reason := 'accepted_account_inactive';
  elsif v_auth_identity_linked is not true then
    v_reason := 'accepted_auth_identity_missing';
  elsif v_topology_valid is not true then
    v_reason := 'accepted_topology_invalid';
  elsif v_access_established is not true then
    v_reason := 'accepted_without_current_property_access';
  elsif v_roster_bound is not true then
    v_reason := 'accepted_without_promised_roster_link';
  else
    v_reason := 'accepted_and_access_established';
  end if;

  return jsonb_build_object(
    'ok', v_access_established and v_roster_bound,
    'schemaVersion', 'stage-a-invite-access-shadow-v1',
    'inviteId', p_invite_id,
    'accepted', true,
    'accessEstablished', v_access_established,
    'currentAccessValid', v_access_established,
    'promisedCoverageComplete', v_promised_coverage_complete,
    'claimIsAccess', false,
    'rosterBound', v_roster_bound,
    'rosterPromised', v_roster_promised,
    'rosterLinkExists', v_roster_link_exists,
    'accountStaffLinkActive', v_account_staff_link_active,
    'targetStaffExists', v_target_staff_exists,
    'targetStaffActive', v_target_staff_active,
    'targetStaffDepartment', v_target_staff_department,
    'rosterRoleMatches', v_roster_role_matches,
    'targetStaffPropertyId', v_target_staff_property_id,
    'targetStaffMatchesAnchor', v_roster_target_valid,
    'accountId', v_account.id,
    'accountAvailable', v_account_available,
    'accountActive', v_account.active,
    'authIdentityLinked', v_auth_identity_linked,
    'authorityMode', v_state.authority_mode,
    'hotelId', v_invite.hotel_id,
    'organizationId', v_invite.organization_id,
    'membershipScope', v_invite.membership_scope,
    'promisedPropertyIds', to_jsonb(v_promised_property_ids),
    'currentPropertyIds', to_jsonb(v_current_property_ids),
    'rawPropertyIds', to_jsonb(v_raw_property_ids),
    'missingPropertyIds', to_jsonb(v_missing_property_ids),
    'extraPropertyIds', to_jsonb(v_extra_property_ids),
    'topologyValid', v_topology_valid,
    'topologyReason', v_topology_reason,
    'currentTopologyPropertyIds', to_jsonb(v_current_topology_property_ids),
    'missingTopologyPropertyIds', to_jsonb(v_missing_topology_property_ids),
    'extraTopologyPropertyIds', to_jsonb(v_extra_topology_property_ids),
    'invitedOrganizationStatus', v_invited_organization_status,
    'invitedOrganizationType', v_invited_organization_type,
    'currentOrganizationId', v_current_organization_id,
    'currentOrganizationStatus', v_current_organization_status,
    'currentOrganizationType', v_current_organization_type,
    'rosterBinding', jsonb_build_object(
      'promised', v_roster_promised,
      'bound', v_roster_bound,
      'linkExists', v_roster_link_exists,
      'targetStaffId', v_invite.target_staff_id,
      'accountStaffId', v_account.staff_id,
      'exists', v_target_staff_exists,
      'active', v_target_staff_active,
      'department', v_target_staff_department,
      'roleMatchesDepartment', v_roster_role_matches,
      'accountStaffLinkActive', v_account_staff_link_active,
      'targetStaffPropertyId', v_target_staff_property_id,
      'targetStaffMatchesAnchor', v_roster_target_valid
    ),
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
