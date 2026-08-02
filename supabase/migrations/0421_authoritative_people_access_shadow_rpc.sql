-- 0421_authoritative_people_access_shadow_rpc.sql
--
-- Stage A People foundation. Existing People mutations continue to use their
-- established transactional RPCs and the legacy array trigger in 0420. This
-- service-only DTO gives later rollout stages one explicit, non-authoritative
-- place to inspect the legacy scope, translated bridge scope, roster links,
-- and lifecycle state without silently unioning them.

begin;

do $$
begin
  if to_regclass('public.account_access_cutover_status') is null
     or to_regclass('public.account_access_cutover_preflight_issues') is null
     or to_regclass('public.account_property_staff_links') is null
     or to_regprocedure('public.staxis_translate_legacy_property_access(uuid,uuid[],text)') is null
  then
    raise exception '0421 requires Stage A access translation and People identity foundations';
  end if;
end
$$;

create or replace function public.staxis_people_access_shadow(
  p_account_id uuid,
  p_property_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_status public.account_access_cutover_status%rowtype;
  v_legacy_property_ids uuid[] := '{}'::uuid[];
  v_bridge_property_ids uuid[] := '{}'::uuid[];
  v_normalized_property_ids uuid[] := '{}'::uuid[];
  v_untranslated_property_ids uuid[] := '{}'::uuid[];
  v_staff_links jsonb := '[]'::jsonb;
  v_invite_counts jsonb := '{}'::jsonb;
  v_issue_count integer := 0;
begin
  if p_account_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  if p_property_id is not null and not exists (
    select 1 from public.properties property where property.id = p_property_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'property_not_found');
  end if;

  select account.* into v_account
  from public.accounts account
  where account.id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'account_not_found');
  end if;
  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing');
  end if;
  select status.* into v_status
  from public.account_access_cutover_status status
  where status.id is true;

  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
    into v_legacy_property_ids
  from (
    select distinct legacy_property.property_id
    from unnest(coalesce(v_account.property_access, '{}'::uuid[])) legacy_property(property_id)
    where p_property_id is null or legacy_property.property_id = p_property_id
  ) legacy;

  select coalesce(array_agg(bridge.property_id order by bridge.property_id), '{}'::uuid[])
    into v_bridge_property_ids
  from public.account_property_authorization_bridges bridge
  where bridge.account_id = p_account_id
    and bridge.status = 'active'
    and (p_property_id is null or bridge.property_id = p_property_id);

  if v_state.authority_mode = 'normalized' then
    select coalesce(array_agg(distinct authz.property_id order by authz.property_id), '{}'::uuid[])
      into v_normalized_property_ids
    from public._staxis_account_property_authorizations(p_account_id) authz
    where p_property_id is null or authz.property_id = p_property_id;
  end if;

  select coalesce(array_agg(legacy.property_id order by legacy.property_id), '{}'::uuid[])
    into v_untranslated_property_ids
  from unnest(v_legacy_property_ids) legacy(property_id)
  where v_state.authority_mode in ('legacy', 'shadow')
    and not exists (
      select 1
      from public.account_property_authorization_bridges bridge
      where bridge.account_id = p_account_id
        and bridge.property_id = legacy.property_id
        and bridge.status = 'active'
    )
    and not exists (
      select 1
      from public.account_access_cutover_preflight_issues issue
      where issue.account_id = p_account_id
        and issue.property_id = legacy.property_id
    );

  select coalesce(jsonb_agg(jsonb_build_object(
    'propertyId', link.property_id,
    'staffId', link.staff_id,
    'active', link.is_active,
    'source', link.source,
    'linkedAt', link.linked_at,
    'updatedAt', link.updated_at
  ) order by link.property_id), '[]'::jsonb)
    into v_staff_links
  from public.account_property_staff_links link
  where link.account_id = p_account_id
    and (p_property_id is null or link.property_id = p_property_id);

  select jsonb_build_object(
    'pending', count(*) filter (where invitation.accepted_at is null),
    'accepted', count(*) filter (where invitation.accepted_at is not null),
    'expiredPending', count(*) filter (
      where invitation.accepted_at is null and invitation.expires_at <= clock_timestamp()
    )
  ) into v_invite_counts
  from public.account_invites invitation
  where invitation.accepted_by = p_account_id
     or invitation.target_staff_id = v_account.staff_id
     or (
       invitation.accepted_by is null
       and invitation.target_staff_id is not null
       and exists (
         select 1
         from public.account_property_staff_links link
         where link.account_id = p_account_id
           and link.staff_id = invitation.target_staff_id
           and link.property_id = invitation.hotel_id
       )
     );

  select count(*)::integer into v_issue_count
  from public.account_access_cutover_preflight_issues issue
  where issue.account_id = p_account_id
    and (p_property_id is null or issue.property_id = p_property_id);

  return jsonb_build_object(
    'ok', true,
    'schemaVersion', 'stage-a-people-access-shadow-v1',
    'accountId', p_account_id,
    'active', v_account.active,
    'role', v_account.role,
    'authIdentityLinked', v_account.data_user_id is not null
      and exists (select 1 from auth.users auth_user where auth_user.id = v_account.data_user_id),
    'authorityMode', v_state.authority_mode,
    'authorityVersion', v_state.authority_version,
    'stage', coalesce(v_status.stage, 'A'),
    'enforcementEnabled', coalesce(v_status.enforcement_enabled, false),
    'propertyFilter', p_property_id,
    'legacyPropertyIds', to_jsonb(v_legacy_property_ids),
    'activeShadowBridgePropertyIds', to_jsonb(v_bridge_property_ids),
    'normalizedPropertyIds', to_jsonb(v_normalized_property_ids),
    'untranslatedLegacyPropertyIds', to_jsonb(v_untranslated_property_ids),
    'staffLinks', v_staff_links,
    'inviteCounts', v_invite_counts,
    'preflightIssueCount', v_issue_count,
    'legacyAuthorityPreserved', true
  );
end;
$$;

comment on function public.staxis_people_access_shadow(uuid, uuid) is
  'Stage A service-only People shadow DTO. Legacy arrays, shadow bridges, and normalized properties are separate fields; this RPC deliberately never unions them or creates access.';

revoke all on function public.staxis_people_access_shadow(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_people_access_shadow(uuid, uuid)
  to service_role;

insert into public.applied_migrations (version, description)
values (
  '0421',
  'Stage A service-only People access shadow DTO; existing lifecycle writers remain backward-compatible and legacy authority is preserved.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
