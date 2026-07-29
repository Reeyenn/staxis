-- 0390_authoritative_people_access_bridge.sql
--
-- Forward-only hardening for existing Company Hub people/access workflows.
--
--  * one authoritative per-hotel roster (legacy/shadow OR normalized, never a
--    runtime union) replaces raw accounts.property_access + hat merges;
--  * existing membership hats can be atomically replaced by normalized grant
--    sets through the existing My Hotel > Access UI;
--  * a normalized account with no current membership remains empty/denied;
--  * scheduled normalized entitlements permanently supersede matching cutover
--    bridges before they activate, so revocation cannot resurrect old access;
--  * the legacy global-role ownership transfer is limited to proven
--    legacy/shadow accounts at an independent single-hotel anchor.

begin;

do $$
begin
  if to_regclass('public.account_authorization_state') is null
     or to_regclass('public.company_access_mutation_requests') is null
     or to_regprocedure('public._staxis_nonlegacy_property_authorizations(uuid)') is null
     or to_regprocedure('public.staxis_company_access_editor_projection(uuid)') is null
     or to_regprocedure('public._staxis_preview_company_access_edit(uuid,uuid,uuid,text,text,text,uuid,uuid[],timestamp with time zone,bigint,text)') is null
     or to_regprocedure('public.staxis_commit_company_access_edit(uuid,uuid,uuid,text,text,text,uuid,uuid[],timestamp with time zone,bigint,text,text,boolean,uuid)') is null
  then
    raise exception '0390 requires authoritative access 0378 and access editor 0383';
  end if;
end
$$;

-- ── Scheduled entitlement bridge retirement ──────────────────────────────
--
-- _staxis_nonlegacy_property_authorizations intentionally returns effective
-- access "now". That is correct for reads, but not for the one-way cutover
-- invariant: a future grant already owns the right to supersede a matching
-- legacy bridge. These trigger helpers run immediately after the existing 00
-- refresh trigger and retire that bridge in the same transaction.

create or replace function public._staxis_scheduled_membership_property_ids(
  p_membership_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(candidate.property_id order by candidate.property_id), '{}'::uuid[])
  from (
    select distinct relationship.property_id
    from public.organization_memberships membership
    join public.accounts account
      on account.id = membership.account_id
     and account.active is true
     and account.role <> 'admin'
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    join public._staxis_current_primary_property_relationships() relationship
      on relationship.organization_id = membership.organization_id
     and relationship.active_primary_count = 1
    where membership.id = p_membership_id
      and membership.status = 'active'
      and membership.ended_at is null
      and membership.staxis_role is not null
      and membership.membership_scope in ('company', 'property')
      and (
        membership.membership_scope = 'company'
        or relationship.property_id = any(
          coalesce(membership.covered_property_ids, '{}'::uuid[])
        )
      )
  ) candidate;
$$;

create or replace function public._staxis_scheduled_grant_property_ids(
  p_grant_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  eligible_grant as (
    select grant_row.*
    from public.organization_access_grants grant_row
    join public.organization_memberships membership
      on membership.id = grant_row.membership_id
     and membership.organization_id = grant_row.organization_id
     and membership.status = 'active'
     and membership.ended_at is null
    join public.accounts account
      on account.id = membership.account_id
     and account.active is true
     and account.role <> 'admin'
    join public.organizations organization
      on organization.id = grant_row.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    where grant_row.id = p_grant_id
      and grant_row.status = 'active'
      and grant_row.source <> 'legacy_backfill'
      and (grant_row.expires_at is null
        or grant_row.expires_at > clock_timestamp())
  ),
  portfolio_tree(portfolio_id, organization_id) as (
    select grant_row.portfolio_id, grant_row.organization_id
    from eligible_grant grant_row
    where grant_row.scope_type = 'portfolio'
    union
    select child.id, child.organization_id
    from portfolio_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = tree.organization_id
     and child.status = 'active'
  ),
  governed as (
    select relationship.id, relationship.organization_id, relationship.property_id
    from public._staxis_current_primary_property_relationships() relationship
    join eligible_grant grant_row
      on grant_row.organization_id = relationship.organization_id
    where relationship.active_primary_count = 1
  ),
  candidate as (
    select governed.property_id
    from eligible_grant grant_row
    join governed on governed.organization_id = grant_row.organization_id
    where grant_row.scope_type = 'organization'
    union
    select governed.property_id
    from eligible_grant grant_row
    join governed
      on governed.id = grant_row.property_relationship_id
     and governed.property_id = grant_row.property_id
    where grant_row.scope_type = 'property'
    union
    select governed.property_id
    from eligible_grant grant_row
    join portfolio_tree tree on tree.organization_id = grant_row.organization_id
    join public.portfolio_properties assignment
      on assignment.organization_id = tree.organization_id
     and assignment.portfolio_id = tree.portfolio_id
     and assignment.assigned_at <= clock_timestamp()
     and (assignment.removed_at is null
       or assignment.removed_at > clock_timestamp())
    join governed
      on governed.id = assignment.property_relationship_id
     and governed.organization_id = assignment.organization_id
     and governed.property_id = assignment.property_id
    where grant_row.scope_type = 'portfolio'
  )
  select coalesce(array_agg(distinct candidate.property_id order by candidate.property_id), '{}'::uuid[])
  from candidate;
$$;

revoke all on function public._staxis_scheduled_membership_property_ids(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public._staxis_scheduled_grant_property_ids(uuid)
  from public, anon, authenticated, service_role;

create or replace function public._staxis_retire_bridges_for_scheduled_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_ids uuid[] := '{}'::uuid[];
  v_retired integer := 0;
begin
  if new.status <> 'active'
     or new.ended_at is not null
     or new.staxis_role is null
     or new.membership_scope not in ('company', 'property')
  then
    return new;
  end if;

  v_property_ids := public._staxis_scheduled_membership_property_ids(new.id);

  update public.account_property_authorization_bridges bridge
     set status = 'retired',
         retired_at = clock_timestamp(),
         retirement_reason = 'Superseded by scheduled normalized membership'
   where bridge.account_id = new.account_id
     and bridge.status = 'active'
     and bridge.property_id = any(v_property_ids);
  get diagnostics v_retired = row_count;
  if v_retired > 0 then
    perform public._staxis_refresh_account_authorization(
      new.account_id,
      'scheduled normalized membership permanently superseded legacy bridge'
    );
  end if;
  return new;
end;
$$;

create or replace function public._staxis_retire_bridges_for_scheduled_grant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid;
  v_property_ids uuid[] := '{}'::uuid[];
  v_retired integer := 0;
begin
  if new.status <> 'active'
     or new.source = 'legacy_backfill'
     or (new.expires_at is not null and new.expires_at <= clock_timestamp())
  then
    return new;
  end if;

  select membership.account_id into v_account_id
  from public.organization_memberships membership
  join public.accounts account
    on account.id = membership.account_id
   and account.active is true
   and account.role <> 'admin'
  join public.organizations organization
    on organization.id = membership.organization_id
   and organization.status = 'active'
   and organization.organization_type <> 'single_hotel'
  where membership.id = new.membership_id
    and membership.organization_id = new.organization_id
    and membership.status = 'active'
    and membership.ended_at is null;
  if not found then return new; end if;

  v_property_ids := public._staxis_scheduled_grant_property_ids(new.id);

  update public.account_property_authorization_bridges bridge
     set status = 'retired',
         retired_at = clock_timestamp(),
         retirement_reason = 'Superseded by scheduled normalized grant'
   where bridge.account_id = v_account_id
     and bridge.status = 'active'
     and bridge.property_id = any(v_property_ids);
  get diagnostics v_retired = row_count;
  if v_retired > 0 then
    perform public._staxis_refresh_account_authorization(
      v_account_id,
      'scheduled normalized grant permanently superseded legacy bridge'
    );
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_retire_bridges_for_scheduled_membership()
  from public, anon, authenticated, service_role;
revoke all on function public._staxis_retire_bridges_for_scheduled_grant()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_organization_memberships_01_scheduled_bridge_retirement
  on public.organization_memberships;
create trigger trg_organization_memberships_01_scheduled_bridge_retirement
  after insert or update on public.organization_memberships
  for each row execute function public._staxis_retire_bridges_for_scheduled_membership();

drop trigger if exists trg_organization_access_grants_01_scheduled_bridge_retirement
  on public.organization_access_grants;
create trigger trg_organization_access_grants_01_scheduled_bridge_retirement
  after insert or update on public.organization_access_grants
  for each row execute function public._staxis_retire_bridges_for_scheduled_grant();

-- Repair rows created before this forward migration. Retirement is permanent;
-- there is intentionally no path that reactivates a bridge on later revoke.
do $$
declare
  v_account_id uuid;
begin
  for v_account_id in
    with scheduled_coverage as (
      select membership.account_id, covered.property_id
      from public.organization_memberships membership
      cross join lateral unnest(
        public._staxis_scheduled_membership_property_ids(membership.id)
      ) covered(property_id)
      where membership.status = 'active'
        and membership.ended_at is null
        and membership.staxis_role is not null
      union
      select membership.account_id, covered.property_id
      from public.organization_access_grants grant_row
      join public.organization_memberships membership
        on membership.id = grant_row.membership_id
       and membership.organization_id = grant_row.organization_id
      cross join lateral unnest(
        public._staxis_scheduled_grant_property_ids(grant_row.id)
      ) covered(property_id)
      where grant_row.status = 'active'
        and grant_row.source <> 'legacy_backfill'
    ),
    retired as (
      update public.account_property_authorization_bridges bridge
         set status = 'retired',
             retired_at = clock_timestamp(),
             retirement_reason = 'Superseded by scheduled normalized entitlement'
       where bridge.status = 'active'
         and exists (
           select 1 from scheduled_coverage coverage
           where coverage.account_id = bridge.account_id
             and coverage.property_id = bridge.property_id
         )
       returning bridge.account_id
    )
    select distinct retired.account_id from retired
  loop
    perform public._staxis_refresh_account_authorization(
      v_account_id,
      '0390 repaired scheduled entitlement bridge suppression'
    );
  end loop;
end
$$;

-- Protect the older hat removal RPC and direct service writes too. A company
-- owner hat may be removed only after another live owner hat or a permanent
-- organization-owner grant exists. The conversion workflow can insert the
-- replacement grant first inside its transaction.
create or replace function public._staxis_guard_last_company_owner_hat()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_removes_owner boolean;
begin
  if tg_op = 'DELETE' then
    v_removes_owner := old.status = 'active'
      and old.starts_at <= clock_timestamp()
      and old.ended_at is null
      and old.membership_scope = 'company'
      and old.staxis_role = 'owner';
  else
    v_removes_owner := old.status = 'active'
      and old.starts_at <= clock_timestamp()
      and old.ended_at is null
      and old.membership_scope = 'company'
      and old.staxis_role = 'owner'
      and (
        new.status <> 'active'
        or new.ended_at is not null
        or new.membership_scope is distinct from 'company'
        or new.staxis_role is distinct from 'owner'
        or new.starts_at > clock_timestamp()
      );
  end if;
  if not v_removes_owner then return coalesce(new, old); end if;

  perform public._staxis_lock_organization(old.organization_id);
  if not exists (
    select 1 from public.organizations organization
    where organization.id = old.organization_id
      and organization.status = 'active'
      and organization.organization_type in ('management_company', 'ownership_group')
  ) then
    return coalesce(new, old);
  end if;

  if not exists (
    select 1
    from public.organization_memberships other_hat
    join public.accounts owner_account
      on owner_account.id = other_hat.account_id
     and owner_account.active is true
    where other_hat.organization_id = old.organization_id
      and other_hat.id <> old.id
      and other_hat.status = 'active'
      and other_hat.starts_at <= clock_timestamp()
      and other_hat.ended_at is null
      and other_hat.membership_scope = 'company'
      and other_hat.staxis_role = 'owner'
  ) and not exists (
    select 1
    from public.organization_access_grants owner_grant
    join public.organization_memberships owner_membership
      on owner_membership.id = owner_grant.membership_id
     and owner_membership.organization_id = owner_grant.organization_id
    join public.accounts owner_account
      on owner_account.id = owner_membership.account_id
     and owner_account.active is true
    where owner_grant.organization_id = old.organization_id
      and owner_grant.access_profile = 'organization_owner'
      and owner_grant.scope_type = 'organization'
      and owner_grant.status = 'active'
      and owner_grant.starts_at <= clock_timestamp()
      and owner_grant.expires_at is null
      and owner_membership.status = 'active'
      and owner_membership.starts_at <= clock_timestamp()
      and owner_membership.ended_at is null
  ) then
    raise exception 'cannot remove the final active organization owner'
      using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public._staxis_guard_last_company_owner_hat()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_organization_memberships_05_last_company_owner_hat
  on public.organization_memberships;
create trigger trg_organization_memberships_05_last_company_owner_hat
  before update or delete on public.organization_memberships
  for each row execute function public._staxis_guard_last_company_owner_hat();

-- ── Exact hotel roster DTO ────────────────────────────────────────────────
-- One account appears only if its selected authority mode currently reaches
-- this exact hotel. Normalized rows use the same entitlement projection as
-- RLS/portfolio scope, including neutral access grants and cutover bridges;
-- stale property_access and hats at a former company are not unioned in.
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
    select account.id,
           account.username,
           account.display_name,
           account.role,
           account.active,
           account.data_user_id,
           account.staff_id,
           account.created_at,
           account.updated_at,
           state.authority_mode,
           state.authority_version,
           case
             when account.role = 'admin' then '{}'::uuid[]
             when state.authority_mode in ('legacy', 'shadow') then (
               select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
               from unnest(coalesce(account.property_access, '{}'::uuid[])) property_id
             )
             else coalesce(normalized.property_ids, '{}'::uuid[])
           end as property_ids
    from public.accounts account
    join public.account_authorization_state state on state.account_id = account.id
    left join lateral (
      select coalesce(array_agg(distinct authz.property_id order by authz.property_id), '{}'::uuid[])
        as property_ids
      from public._staxis_account_property_authorizations(account.id) authz
      where state.authority_mode = 'normalized'
    ) normalized on true
    where account.active is true
      and (
        (account.role = 'admin' and p_include_platform_admins is true)
        or (
          account.role <> 'admin'
          and (
            (state.authority_mode in ('legacy', 'shadow')
              and p_property_id = any(coalesce(account.property_access, '{}'::uuid[])))
            or (state.authority_mode = 'normalized'
              and p_property_id = any(coalesce(normalized.property_ids, '{}'::uuid[])))
          )
        )
      )
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
           'propertyIds', to_jsonb(roster.property_ids),
           'managementSurface', case
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

comment on function public.staxis_list_authoritative_hotel_accounts(uuid, boolean) is
  'Service-only exact-hotel roster. Selects legacy/shadow property_access or normalized entitlements according to durable account authority mode; never unions them.';
revoke all on function public.staxis_list_authoritative_hotel_accounts(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.staxis_list_authoritative_hotel_accounts(uuid, boolean)
  to service_role;

-- ── Hat-to-grant conversion helpers ───────────────────────────────────────

create or replace function public._staxis_company_access_can_retire_hat(
  p_actor_account_id uuid,
  p_membership_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hat public.organization_memberships%rowtype;
begin
  select * into v_hat
  from public.organization_memberships membership
  where membership.id = p_membership_id
    and membership.status = 'active'
    and membership.starts_at <= clock_timestamp()
    and membership.ended_at is null
    and membership.staxis_role is not null
    and membership.membership_scope in ('company', 'property');
  if not found or v_hat.account_id = p_actor_account_id then return false; end if;

  if not exists (
    select 1
    from public.accounts actor
    join public.account_authorization_state state
      on state.account_id = actor.id
     and state.authority_mode = 'normalized'
    where actor.id = p_actor_account_id
      and actor.active is true
      and actor.role <> 'admin'
  ) or not exists (
    select 1
    from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
    where authz.organization_id = v_hat.organization_id
  ) then
    return false;
  end if;

  return public._staxis_can_set_membership_hat(
    p_actor_account_id,
    v_hat.organization_id,
    v_hat.membership_scope,
    v_hat.staxis_role,
    v_hat.covered_property_ids
  );
end;
$$;

create or replace function public._staxis_company_access_hat_conversion_revision(
  p_membership_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'company-access-editor-v2',
    'sourceMembershipId', source_membership.id,
    'sourceRevision', public._staxis_company_access_membership_revision(source_membership.id),
    'neutralMembershipId', neutral_membership.id,
    'neutralRevision', case when neutral_membership.id is null then null
      else public._staxis_company_access_membership_revision(neutral_membership.id) end
  )::text, 'UTF8')), 'hex')
  from public.organization_memberships source_membership
  left join public.organization_memberships neutral_membership
    on neutral_membership.organization_id = source_membership.organization_id
   and neutral_membership.account_id = source_membership.account_id
   and neutral_membership.ended_at is null
   and neutral_membership.staxis_role is null
  where source_membership.id = p_membership_id;
$$;

revoke all on function public._staxis_company_access_can_retire_hat(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public._staxis_company_access_hat_conversion_revision(uuid)
  from public, anon, authenticated, service_role;

-- Versioned projection used by the existing Access tab. The v1 grant-set
-- projection remains intact for rollback, while this wrapper adds editable
-- hat rows with explicit provenance and a combined source+neutral revision.
create or replace function public.staxis_company_access_editor_projection_v2(
  p_actor_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base jsonb;
  v_organization jsonb;
  v_organizations jsonb := '[]'::jsonb;
  v_grant_memberships jsonb;
  v_hat_memberships jsonb;
begin
  v_base := public.staxis_company_access_editor_projection(p_actor_account_id);
  if v_base is null or jsonb_typeof(v_base->'organizations') <> 'array' then
    raise exception 'company access editor v1 projection was malformed'
      using errcode = '22023';
  end if;

  for v_organization in
    select organization_value
    from jsonb_array_elements(v_base->'organizations') organization_value
  loop
    select coalesce(jsonb_agg(
      membership_value || jsonb_build_object(
        'sourceKind', 'grant_set',
        'sourceRole', null,
        'sourceScope', null
      ) order by membership_value->>'id'
    ), '[]'::jsonb)
      into v_grant_memberships
    from jsonb_array_elements(v_organization->'memberships') membership_value;

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', membership.id,
      'accessRevision', public._staxis_company_access_hat_conversion_revision(membership.id),
      'sourceKind', 'membership_hat',
      'sourceRole', membership.staxis_role,
      'sourceScope', membership.membership_scope,
      'canAdd', false,
      'canReplace', public._staxis_company_access_can_retire_hat(
        p_actor_account_id, membership.id
      ),
      'blockedReason', case
        when public._staxis_company_access_can_retire_hat(
          p_actor_account_id, membership.id
        ) then null
        else 'membership_hat_outside_scope'
      end,
      'currentGrants', case
        when membership.membership_scope = 'company' then jsonb_build_array(
          jsonb_build_object(
            'id', membership.id,
            'accessProfile', case membership.staxis_role
              when 'owner' then 'organization_owner'
              when 'vp' then 'contributor'
              when 'finance' then 'viewer'
              else 'viewer'
            end,
            'scopeType', 'organization',
            'portfolioId', null,
            'propertyId', null,
            'startsAt', membership.starts_at,
            'expiresAt', null
          )
        )
        else coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', relationship.id,
            'accessProfile', case membership.staxis_role
              when 'general_manager' then 'property_manager'
              when 'front_desk' then 'contributor'
              else 'viewer'
            end,
            'scopeType', 'property',
            'portfolioId', null,
            'propertyId', relationship.property_id,
            'startsAt', membership.starts_at,
            'expiresAt', null
          ) order by relationship.property_id)
          from public._staxis_current_primary_property_relationships() relationship
          where relationship.organization_id = membership.organization_id
            and relationship.property_id = any(
              coalesce(membership.covered_property_ids, '{}'::uuid[])
            )
            and relationship.active_primary_count = 1
        ), '[]'::jsonb)
      end
    ) order by target_account.display_name, membership.id), '[]'::jsonb)
      into v_hat_memberships
    from public.organization_memberships membership
    join public.accounts target_account
      on target_account.id = membership.account_id
     and target_account.active is true
     and target_account.role <> 'admin'
    where membership.organization_id = (v_organization->>'id')::uuid
      and membership.account_id <> p_actor_account_id
      and membership.status = 'active'
      and membership.starts_at <= clock_timestamp()
      and membership.ended_at is null
      and membership.staxis_role is not null
      and membership.membership_scope in ('company', 'property');

    v_organization := jsonb_set(
      v_organization,
      '{memberships}',
      coalesce(v_grant_memberships, '[]'::jsonb)
        || coalesce(v_hat_memberships, '[]'::jsonb),
      true
    );
    v_organizations := v_organizations || jsonb_build_array(v_organization);
  end loop;

  return jsonb_build_object(
    'schemaVersion', 'company-access-editor-v2',
    'generatedAt', clock_timestamp(),
    'organizations', v_organizations
  );
end;
$$;

revoke all on function public.staxis_company_access_editor_projection_v2(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_company_access_editor_projection_v2(uuid)
  to service_role;

create or replace function public._staxis_preview_company_access_hat_conversion(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_membership_id uuid,
  p_operation text,
  p_access_profile text,
  p_scope_kind text,
  p_portfolio_id uuid,
  p_property_ids uuid[],
  p_expires_at timestamptz,
  p_expected_access_epoch bigint,
  p_expected_access_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hat public.organization_memberships%rowtype;
  v_neutral public.organization_memberships%rowtype;
  v_has_neutral boolean := false;
  v_canonical_membership_id uuid;
  v_epoch bigint;
  v_revision text;
  v_organization_name text;
  v_member_name text;
  v_property_ids uuid[] := '{}'::uuid[];
  v_desired_property_ids uuid[] := '{}'::uuid[];
  v_before_property_ids uuid[] := '{}'::uuid[];
  v_after_property_ids uuid[] := '{}'::uuid[];
  v_gaining_property_ids uuid[] := '{}'::uuid[];
  v_losing_property_ids uuid[] := '{}'::uuid[];
  v_conversion_membership_ids uuid[];
  v_current_grant_count integer := 0;
  v_retained_grant_count integer := 0;
  v_revoked_grant_count integer := 0;
  v_upserted_grant_count integer := 0;
  v_fingerprint text;
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_membership_id is null
     or p_operation <> 'replace'
     or p_access_profile not in (
       'organization_owner', 'organization_admin', 'portfolio_manager',
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     )
     or p_scope_kind not in ('organization', 'portfolio', 'selected_properties')
     or p_property_ids is null
     or p_expected_access_epoch is null
     or p_expected_access_epoch <= 0
     or p_expected_access_revision is null
     or p_expected_access_revision !~ '^[0-9a-f]{64}$'
  then
    raise exception 'membership hats require an exact replacement preview'
      using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
    into v_property_ids
  from unnest(p_property_ids) property_id;
  if cardinality(v_property_ids) <> cardinality(p_property_ids)
     or cardinality(v_property_ids) > 500
  then
    raise exception 'selected hotel ids must be unique and bounded'
      using errcode = '22023';
  end if;

  if p_scope_kind = 'organization' then
    if p_portfolio_id is not null or cardinality(v_property_ids) <> 0 then
      raise exception 'whole-company scope cannot include portfolio or hotel ids'
        using errcode = '22023';
    end if;
  elsif p_scope_kind = 'portfolio' then
    if p_portfolio_id is null or cardinality(v_property_ids) <> 0 then
      raise exception 'portfolio scope requires exactly one portfolio'
        using errcode = '22023';
    end if;
  elsif p_portfolio_id is not null or cardinality(v_property_ids) = 0 then
    raise exception 'selected-hotel scope requires one or more hotels'
      using errcode = '22023';
  end if;

  if (p_access_profile in ('organization_owner', 'organization_admin')
        and p_scope_kind <> 'organization')
     or (p_access_profile = 'portfolio_manager' and p_scope_kind <> 'portfolio')
     or (p_access_profile = 'property_manager'
        and p_scope_kind <> 'selected_properties')
  then
    raise exception 'profile cannot use the selected scope' using errcode = '22023';
  end if;
  if p_access_profile = 'organization_owner' and p_expires_at is not null then
    raise exception 'organization owner access cannot expire' using errcode = '22023';
  end if;
  if p_access_profile = 'external_collaborator' and p_expires_at is null then
    raise exception 'external collaborator access requires an expiration'
      using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= clock_timestamp() then
    raise exception 'access expiration must be in the future' using errcode = '22023';
  end if;

  select membership.* into v_hat
  from public.organization_memberships membership
  join public.organizations organization
    on organization.id = membership.organization_id
   and organization.status = 'active'
   and organization.organization_type in ('management_company', 'ownership_group')
  join public.accounts target_account
    on target_account.id = membership.account_id
   and target_account.active is true
   and target_account.role <> 'admin'
  where membership.id = p_membership_id
    and membership.organization_id = p_organization_id
    and membership.account_id <> p_actor_account_id
    and membership.status = 'active'
    and membership.starts_at <= clock_timestamp()
    and membership.ended_at is null
    and membership.staxis_role is not null
    and membership.membership_scope in ('company', 'property')
  for share of organization, membership, target_account;
  if not found then
    raise exception 'editable active membership hat not found' using errcode = 'P0002';
  end if;

  select organization.name, epoch.version, target_account.display_name
    into v_organization_name, v_epoch, v_member_name
  from public.organizations organization
  join public.organization_access_epochs epoch
    on epoch.organization_id = organization.id
  join public.accounts target_account
    on target_account.id = v_hat.account_id
   and target_account.active is true
   and target_account.role <> 'admin'
  where organization.id = p_organization_id
    and organization.status = 'active'
    and organization.organization_type in ('management_company', 'ownership_group')
  for share of organization, epoch, target_account;
  if not found then
    raise exception 'editable active membership hat not found' using errcode = 'P0002';
  end if;

  select membership.* into v_neutral
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.account_id = v_hat.account_id
    and membership.ended_at is null
    and membership.staxis_role is null
  for share;
  v_has_neutral := found;
  if v_has_neutral and (
    v_neutral.status <> 'active'
    or v_neutral.starts_at > clock_timestamp()
    or v_neutral.ended_at is not null
  ) then
    raise exception 'the existing normalized membership is not currently active'
      using errcode = '40900';
  end if;
  v_canonical_membership_id := case
    when v_has_neutral then v_neutral.id else v_hat.id end;
  v_conversion_membership_ids := case
    when v_has_neutral then array[v_hat.id, v_neutral.id]
    else array[v_hat.id]
  end;

  if v_epoch <> p_expected_access_epoch then
    raise exception 'company access changed; reload before confirming'
      using errcode = '40001';
  end if;
  v_revision := public._staxis_company_access_hat_conversion_revision(p_membership_id);
  if v_revision is distinct from p_expected_access_revision then
    raise exception 'membership access changed; reload before confirming'
      using errcode = '40001';
  end if;
  if not public._staxis_company_access_can_retire_hat(
    p_actor_account_id, p_membership_id
  ) then
    raise exception 'actor cannot replace this membership role'
      using errcode = '42501';
  end if;

  if exists (
    select 1 from public.organization_access_grants legacy_grant
    where legacy_grant.membership_id = any(v_conversion_membership_ids)
      and legacy_grant.status = 'active'
      and legacy_grant.source = 'legacy_backfill'
  ) then
    raise exception 'legacy hotel access must be migrated before replacing this role'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from public.organization_access_grants current_grant
    where current_grant.membership_id = any(v_conversion_membership_ids)
      and current_grant.status = 'active'
      and current_grant.source <> 'legacy_backfill'
      and not public._staxis_company_access_can_delegate(
        p_actor_account_id, p_organization_id, current_grant.access_profile,
        current_grant.scope_type, current_grant.portfolio_id,
        current_grant.property_id
      )
  ) then
    raise exception 'existing membership access is outside the actor scope'
      using errcode = '42501';
  end if;

  if p_scope_kind = 'organization' then
    if not public._staxis_company_access_can_delegate(
      p_actor_account_id, p_organization_id, p_access_profile,
      'organization', null, null
    ) then
      raise exception 'actor cannot delegate this company scope'
        using errcode = '42501';
    end if;
    v_desired_property_ids := public._staxis_company_access_scope_properties(
      p_organization_id, 'organization', null, null
    );
    v_upserted_grant_count := 1;
  elsif p_scope_kind = 'portfolio' then
    if not public._staxis_company_access_can_delegate(
      p_actor_account_id, p_organization_id, p_access_profile,
      'portfolio', p_portfolio_id, null
    ) then
      raise exception 'actor cannot delegate this portfolio scope'
        using errcode = '42501';
    end if;
    v_desired_property_ids := public._staxis_company_access_scope_properties(
      p_organization_id, 'portfolio', p_portfolio_id, null
    );
    v_upserted_grant_count := 1;
  else
    if exists (
      select 1 from unnest(v_property_ids) property_id
      where not public._staxis_company_access_can_delegate(
        p_actor_account_id, p_organization_id, p_access_profile,
        'property', null, property_id
      )
    ) then
      raise exception 'selected hotel is outside the actor scope or company'
        using errcode = '42501';
    end if;
    v_desired_property_ids := v_property_ids;
    v_upserted_grant_count := cardinality(v_property_ids);
  end if;

  -- The final-owner check excludes every owner grant on the target account:
  -- the exact replacement may revoke its neutral grant set as well as the hat.
  if v_hat.membership_scope = 'company'
     and v_hat.staxis_role = 'owner'
     and not (p_access_profile = 'organization_owner'
       and p_scope_kind = 'organization')
     and not exists (
       select 1
       from public.organization_memberships other_hat
       join public.accounts owner_account
         on owner_account.id = other_hat.account_id
        and owner_account.active is true
       where other_hat.organization_id = p_organization_id
         and other_hat.account_id <> v_hat.account_id
         and other_hat.status = 'active'
         and other_hat.starts_at <= clock_timestamp()
         and other_hat.ended_at is null
         and other_hat.membership_scope = 'company'
         and other_hat.staxis_role = 'owner'
     ) and not exists (
       select 1
       from public.organization_access_grants other_owner
       join public.organization_memberships other_membership
         on other_membership.id = other_owner.membership_id
        and other_membership.organization_id = other_owner.organization_id
       join public.accounts owner_account
         on owner_account.id = other_membership.account_id
        and owner_account.active is true
       where other_owner.organization_id = p_organization_id
         and other_membership.account_id <> v_hat.account_id
         and other_owner.access_profile = 'organization_owner'
         and other_owner.scope_type = 'organization'
         and other_owner.status = 'active'
         and other_owner.starts_at <= clock_timestamp()
         and other_owner.expires_at is null
         and other_membership.status = 'active'
         and other_membership.starts_at <= clock_timestamp()
         and other_membership.ended_at is null
     )
  then
    raise exception 'cannot remove the final active organization owner'
      using errcode = '23514';
  end if;

  select 1 + count(*)::integer into v_current_grant_count
  from public.organization_access_grants current_grant
  where current_grant.membership_id = any(v_conversion_membership_ids)
    and current_grant.status = 'active'
    and current_grant.source <> 'legacy_backfill';

  select count(*)::integer into v_retained_grant_count
  from public.organization_access_grants current_grant
  where current_grant.membership_id = v_canonical_membership_id
    and current_grant.status = 'active'
    and current_grant.source <> 'legacy_backfill'
    and current_grant.access_profile = p_access_profile
    and (
      (p_scope_kind = 'organization' and current_grant.scope_type = 'organization')
      or (p_scope_kind = 'portfolio'
        and current_grant.scope_type = 'portfolio'
        and current_grant.portfolio_id = p_portfolio_id)
      or (p_scope_kind = 'selected_properties'
        and current_grant.scope_type = 'property'
        and current_grant.property_id = any(v_property_ids))
    );
  v_revoked_grant_count := v_current_grant_count - v_retained_grant_count;

  select coalesce(array_agg(distinct authz.property_id order by authz.property_id), '{}'::uuid[])
    into v_before_property_ids
  from public._staxis_nonlegacy_property_authorizations(v_hat.account_id) authz
  where authz.organization_id = p_organization_id;

  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
    into v_after_property_ids
  from (
    select distinct authz.property_id
    from public._staxis_nonlegacy_property_authorizations(v_hat.account_id) authz
    where authz.organization_id = p_organization_id
      and not (authz.membership_id = any(v_conversion_membership_ids))
    union
    select property_id from unnest(v_desired_property_ids) property_id
  ) after_scope;

  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
    into v_gaining_property_ids
  from unnest(v_after_property_ids) property_id
  where not (property_id = any(v_before_property_ids));
  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
    into v_losing_property_ids
  from unnest(v_before_property_ids) property_id
  where not (property_id = any(v_after_property_ids));

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'company-access-editor-v2',
    'conversionFromHat', true,
    'actorAccountId', p_actor_account_id,
    'organizationId', p_organization_id,
    'sourceMembershipId', p_membership_id,
    'canonicalMembershipId', v_canonical_membership_id,
    'sourceRole', v_hat.staxis_role,
    'sourceScope', v_hat.membership_scope,
    'sourcePropertyIds', to_jsonb(coalesce(v_hat.covered_property_ids, '{}'::uuid[])),
    'operation', p_operation,
    'accessProfile', p_access_profile,
    'scopeKind', p_scope_kind,
    'portfolioId', p_portfolio_id,
    'propertyIds', to_jsonb(v_property_ids),
    'expiresAt', p_expires_at,
    'expectedAccessEpoch', p_expected_access_epoch,
    'expectedAccessRevision', p_expected_access_revision,
    'currentGrantCount', v_current_grant_count,
    'retainedGrantCount', v_retained_grant_count,
    'revokedGrantCount', v_revoked_grant_count,
    'upsertedGrantCount', v_upserted_grant_count,
    'beforePropertyIds', to_jsonb(v_before_property_ids),
    'afterPropertyIds', to_jsonb(v_after_property_ids)
  )::text, 'UTF8')), 'hex');

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'organizationName', v_organization_name,
    'membershipId', p_membership_id,
    'memberName', v_member_name,
    'operation', p_operation,
    'accessProfile', p_access_profile,
    'scopeKind', p_scope_kind,
    'portfolioId', p_portfolio_id,
    'propertyIds', to_jsonb(v_property_ids),
    'expiresAt', p_expires_at,
    'expectedAccessEpoch', p_expected_access_epoch,
    'expectedAccessRevision', p_expected_access_revision,
    'currentGrantCount', v_current_grant_count,
    'retainedGrantCount', v_retained_grant_count,
    'revokedGrantCount', v_revoked_grant_count,
    'upsertedGrantCount', v_upserted_grant_count,
    'beforePropertyIds', to_jsonb(v_before_property_ids),
    'afterPropertyIds', to_jsonb(v_after_property_ids),
    'gainingPropertyIds', to_jsonb(v_gaining_property_ids),
    'losingPropertyIds', to_jsonb(v_losing_property_ids),
    'accessChangesImmediately', true,
    'conversionFromHat', true,
    'sourceRole', v_hat.staxis_role,
    'sourceScope', v_hat.membership_scope,
    'canonicalMembershipId', v_canonical_membership_id,
    'previewFingerprint', v_fingerprint
  );
end;
$$;

revoke all on function public._staxis_preview_company_access_hat_conversion(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz, bigint, text
) from public, anon, authenticated, service_role;

create or replace function public.staxis_preview_company_access_edit_v2(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_membership_id uuid,
  p_operation text,
  p_access_profile text,
  p_scope_kind text,
  p_portfolio_id uuid,
  p_property_ids uuid[],
  p_expires_at timestamptz,
  p_expected_access_epoch bigint,
  p_expected_access_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.organization_memberships membership
    where membership.id = p_membership_id
      and membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.starts_at <= clock_timestamp()
      and membership.ended_at is null
      and membership.staxis_role is not null
  ) then
    return public._staxis_preview_company_access_hat_conversion(
      p_actor_account_id, p_organization_id, p_membership_id, p_operation,
      p_access_profile, p_scope_kind, p_portfolio_id, p_property_ids,
      p_expires_at, p_expected_access_epoch, p_expected_access_revision
    );
  end if;
  return public._staxis_preview_company_access_edit(
    p_actor_account_id, p_organization_id, p_membership_id, p_operation,
    p_access_profile, p_scope_kind, p_portfolio_id, p_property_ids,
    p_expires_at, p_expected_access_epoch, p_expected_access_revision
  );
end;
$$;

revoke all on function public.staxis_preview_company_access_edit_v2(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz, bigint, text
) from public, anon, authenticated;
grant execute on function public.staxis_preview_company_access_edit_v2(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz, bigint, text
) to service_role;

create or replace function public._staxis_commit_company_access_hat_conversion(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_membership_id uuid,
  p_operation text,
  p_access_profile text,
  p_scope_kind text,
  p_portfolio_id uuid,
  p_property_ids uuid[],
  p_expires_at timestamptz,
  p_expected_access_epoch bigint,
  p_expected_access_revision text,
  p_preview_fingerprint text,
  p_confirmed boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cached public.company_access_mutation_requests%rowtype;
  v_preview jsonb;
  v_request_fingerprint text;
  v_property_ids uuid[] := '{}'::uuid[];
  v_source public.organization_memberships%rowtype;
  v_canonical_membership_id uuid;
  v_property_id uuid;
  v_relationship_id uuid;
  v_grant_id uuid;
  v_rows integer := 0;
  -- Match the transaction-stable clock used by the authoritative entitlement
  -- projection and its refresh triggers. `clock_timestamp()` here would make
  -- the replacement grant look future-dated to `now()` in this transaction,
  -- leaving normalized_scope_hash stale after the hat is retired.
  v_now timestamptz := now();
  v_epoch bigint;
  v_revision text;
  v_response jsonb;
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_membership_id is null
     or p_operation <> 'replace'
     or p_access_profile not in (
       'organization_owner', 'organization_admin', 'portfolio_manager',
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     )
     or p_scope_kind not in ('organization', 'portfolio', 'selected_properties')
     or p_property_ids is null
     or p_expected_access_epoch is null
     or p_expected_access_epoch <= 0
     or p_expected_access_revision is null
     or p_expected_access_revision !~ '^[0-9a-f]{64}$'
     or p_preview_fingerprint is null
     or p_preview_fingerprint !~ '^[0-9a-f]{64}$'
     or p_confirmed is not true
     or p_idempotency_key is null
  then
    raise exception 'explicit hat replacement preview, confirmation, and idempotency key are required'
      using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
    into v_property_ids
  from unnest(p_property_ids) property_id;
  if cardinality(v_property_ids) <> cardinality(p_property_ids)
     or cardinality(v_property_ids) > 500
  then
    raise exception 'selected hotel ids must be unique and bounded'
      using errcode = '22023';
  end if;

  v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'company-access-editor-v2',
    'conversionFromHat', true,
    'actorAccountId', p_actor_account_id,
    'organizationId', p_organization_id,
    'membershipId', p_membership_id,
    'operation', p_operation,
    'accessProfile', p_access_profile,
    'scopeKind', p_scope_kind,
    'portfolioId', p_portfolio_id,
    'propertyIds', to_jsonb(v_property_ids),
    'expiresAt', p_expires_at,
    'expectedAccessEpoch', p_expected_access_epoch,
    'expectedAccessRevision', p_expected_access_revision,
    'previewFingerprint', p_preview_fingerprint,
    'confirmed', p_confirmed
  )::text, 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'staxis.company-access-idempotency:'
      || p_actor_account_id::text || ':' || p_idempotency_key::text, 0
  ));
  select * into v_cached
  from public.company_access_mutation_requests request_row
  where request_row.actor_account_id = p_actor_account_id
    and request_row.idempotency_key = p_idempotency_key;
  if found then
    if v_cached.request_fingerprint <> v_request_fingerprint
       or v_cached.response->>'conversionFromHat' <> 'true'
    then
      raise exception 'idempotency key is already bound to a different request'
        using errcode = '23505';
    end if;

    select membership.* into v_source
    from public.organization_memberships membership
    where membership.id = p_membership_id
      and membership.organization_id = p_organization_id;
    if not found or not exists (
      select 1
      from public.organization_memberships canonical_membership
      join public.accounts target_account
        on target_account.id = canonical_membership.account_id
       and target_account.id = v_source.account_id
       and target_account.active is true
       and target_account.role <> 'admin'
      where canonical_membership.id = (v_cached.response->>'membershipId')::uuid
        and canonical_membership.organization_id = p_organization_id
        and canonical_membership.status = 'active'
        and canonical_membership.starts_at <= clock_timestamp()
        and canonical_membership.ended_at is null
        and canonical_membership.staxis_role is null
    ) then
      raise exception 'converted active membership not found' using errcode = 'P0002';
    end if;
    if (p_scope_kind = 'organization' and not public._staxis_company_access_can_delegate(
          p_actor_account_id, p_organization_id, p_access_profile,
          'organization', null, null
        ))
       or (p_scope_kind = 'portfolio' and not public._staxis_company_access_can_delegate(
          p_actor_account_id, p_organization_id, p_access_profile,
          'portfolio', p_portfolio_id, null
        ))
       or (p_scope_kind = 'selected_properties' and exists (
          select 1 from unnest(v_property_ids) property_id
          where not public._staxis_company_access_can_delegate(
            p_actor_account_id, p_organization_id, p_access_profile,
            'property', null, property_id
          )
        ))
    then
      raise exception 'actor can no longer delegate this access'
        using errcode = '42501';
    end if;
    return jsonb_set(v_cached.response, '{idempotentReplay}', 'true'::jsonb, true);
  end if;

  perform public._staxis_lock_organization(p_organization_id);

  select membership.* into v_source
  from public.organization_memberships membership
  where membership.id = p_membership_id
    and membership.organization_id = p_organization_id;
  if not found then
    raise exception 'editable active membership hat not found' using errcode = 'P0002';
  end if;

  select membership.id into v_canonical_membership_id
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.account_id = v_source.account_id
    and membership.ended_at is null
    and membership.staxis_role is null;
  v_canonical_membership_id := coalesce(v_canonical_membership_id, p_membership_id);

  perform 1
  from public.organization_memberships membership
  where membership.id = any(array[p_membership_id, v_canonical_membership_id])
  order by membership.id
  for update;
  perform 1
  from public.organization_access_grants grant_row
  where grant_row.membership_id = any(array[p_membership_id, v_canonical_membership_id])
    and grant_row.status = 'active'
  order by grant_row.id
  for update;

  v_preview := public._staxis_preview_company_access_hat_conversion(
    p_actor_account_id, p_organization_id, p_membership_id, p_operation,
    p_access_profile, p_scope_kind, p_portfolio_id, v_property_ids,
    p_expires_at, p_expected_access_epoch, p_expected_access_revision
  );
  if v_preview->>'previewFingerprint' <> p_preview_fingerprint
     or (v_preview->>'canonicalMembershipId')::uuid <> v_canonical_membership_id
  then
    raise exception 'access preview is stale or does not match this change'
      using errcode = '40001';
  end if;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  perform set_config('staxis.request_id', p_idempotency_key::text, true);

  -- Ensure the replacement before retiring the hat. This ordering lets the
  -- database-level last-owner guard observe a permanent owner replacement in
  -- the same transaction and keeps every external observer atomic.
  if p_scope_kind = 'organization' then
    select grant_row.id into v_grant_id
    from public.organization_access_grants grant_row
    where grant_row.membership_id = v_canonical_membership_id
      and grant_row.organization_id = p_organization_id
      and grant_row.access_profile = p_access_profile
      and grant_row.scope_type = 'organization'
      and grant_row.status = 'active'
    limit 1
    for update;
    if v_grant_id is null then
      insert into public.organization_access_grants (
        organization_id, membership_id, access_profile, scope_type,
        starts_at, expires_at, source, granted_by_account_id
      ) values (
        p_organization_id, v_canonical_membership_id, p_access_profile,
        'organization', v_now, p_expires_at, 'manual', p_actor_account_id
      );
    else
      update public.organization_access_grants grant_row
         set starts_at = case when grant_row.starts_at > v_now then v_now else grant_row.starts_at end,
             expires_at = p_expires_at,
             source = 'manual',
             granted_by_account_id = p_actor_account_id,
             version = grant_row.version + 1
       where grant_row.id = v_grant_id
         and (
           grant_row.starts_at > v_now
           or grant_row.expires_at is distinct from p_expires_at
           or grant_row.source is distinct from 'manual'
           or grant_row.granted_by_account_id is distinct from p_actor_account_id
         );
    end if;
  elsif p_scope_kind = 'portfolio' then
    select grant_row.id into v_grant_id
    from public.organization_access_grants grant_row
    where grant_row.membership_id = v_canonical_membership_id
      and grant_row.organization_id = p_organization_id
      and grant_row.access_profile = p_access_profile
      and grant_row.scope_type = 'portfolio'
      and grant_row.portfolio_id = p_portfolio_id
      and grant_row.status = 'active'
    limit 1
    for update;
    if v_grant_id is null then
      insert into public.organization_access_grants (
        organization_id, membership_id, access_profile, scope_type,
        portfolio_id, starts_at, expires_at, source, granted_by_account_id
      ) values (
        p_organization_id, v_canonical_membership_id, p_access_profile,
        'portfolio', p_portfolio_id, v_now, p_expires_at,
        'manual', p_actor_account_id
      );
    else
      update public.organization_access_grants grant_row
         set starts_at = case when grant_row.starts_at > v_now then v_now else grant_row.starts_at end,
             expires_at = p_expires_at,
             source = 'manual',
             granted_by_account_id = p_actor_account_id,
             version = grant_row.version + 1
       where grant_row.id = v_grant_id
         and (
           grant_row.starts_at > v_now
           or grant_row.expires_at is distinct from p_expires_at
           or grant_row.source is distinct from 'manual'
           or grant_row.granted_by_account_id is distinct from p_actor_account_id
         );
    end if;
  else
    foreach v_property_id in array v_property_ids
    loop
      select relationship.id into v_relationship_id
      from public.organization_property_relationships relationship
      join public._staxis_current_primary_property_relationships() governing
        on governing.id = relationship.id
       and governing.active_primary_count = 1
      where relationship.organization_id = p_organization_id
        and relationship.property_id = v_property_id
      for share of relationship;
      if not found then
        raise exception 'current governing hotel relationship not found'
          using errcode = '23503';
      end if;

      v_grant_id := null;
      select grant_row.id into v_grant_id
      from public.organization_access_grants grant_row
      where grant_row.membership_id = v_canonical_membership_id
        and grant_row.organization_id = p_organization_id
        and grant_row.access_profile = p_access_profile
        and grant_row.scope_type = 'property'
        and grant_row.property_id = v_property_id
        and grant_row.status = 'active'
      limit 1
      for update;
      if v_grant_id is null then
        insert into public.organization_access_grants (
          organization_id, membership_id, access_profile, scope_type,
          property_relationship_id, property_id, starts_at, expires_at,
          source, granted_by_account_id
        ) values (
          p_organization_id, v_canonical_membership_id, p_access_profile,
          'property', v_relationship_id, v_property_id, v_now, p_expires_at,
          'manual', p_actor_account_id
        );
      else
        update public.organization_access_grants grant_row
           set property_relationship_id = v_relationship_id,
               starts_at = case when grant_row.starts_at > v_now then v_now else grant_row.starts_at end,
               expires_at = p_expires_at,
               source = 'manual',
               granted_by_account_id = p_actor_account_id,
               version = grant_row.version + 1
         where grant_row.id = v_grant_id
           and (
             grant_row.property_relationship_id is distinct from v_relationship_id
             or grant_row.starts_at > v_now
             or grant_row.expires_at is distinct from p_expires_at
             or grant_row.source is distinct from 'manual'
             or grant_row.granted_by_account_id is distinct from p_actor_account_id
           );
      end if;
    end loop;
  end if;

  update public.organization_access_grants current_grant
     set status = 'revoked',
         revoked_at = v_now,
         revoked_by_account_id = p_actor_account_id,
         revocation_reason = 'Atomic membership-hat conversion',
         version = current_grant.version + 1
   where current_grant.organization_id = p_organization_id
     and current_grant.status = 'active'
     and current_grant.source <> 'legacy_backfill'
     and (
       (current_grant.membership_id = p_membership_id
         and p_membership_id <> v_canonical_membership_id)
       or (
         current_grant.membership_id = v_canonical_membership_id
         and not (
           current_grant.access_profile = p_access_profile
           and (
             (p_scope_kind = 'organization'
               and current_grant.scope_type = 'organization')
             or (p_scope_kind = 'portfolio'
               and current_grant.scope_type = 'portfolio'
               and current_grant.portfolio_id = p_portfolio_id)
             or (p_scope_kind = 'selected_properties'
               and current_grant.scope_type = 'property'
               and current_grant.property_id = any(v_property_ids))
           )
         )
       )
     );

  if v_canonical_membership_id = p_membership_id then
    update public.organization_memberships membership
       set membership_scope = null,
           staxis_role = null,
           covered_property_ids = null,
           updated_by_account_id = p_actor_account_id
     where membership.id = p_membership_id
       and membership.organization_id = p_organization_id;
  else
    update public.organization_memberships membership
       set status = 'revoked',
           ended_at = v_now,
           updated_by_account_id = p_actor_account_id
     where membership.id = p_membership_id
       and membership.organization_id = p_organization_id;
  end if;

  v_revision := public._staxis_company_access_membership_revision(
    v_canonical_membership_id
  );
  select epoch.version into v_epoch
  from public.organization_access_epochs epoch
  where epoch.organization_id = p_organization_id;

  insert into public.organization_access_events (
    organization_id, actor_account_id, actor_kind, event_type, target_type,
    target_id, request_id, before_state, after_state, metadata
  ) values (
    p_organization_id, p_actor_account_id, 'account',
    'company_access.membership_hat_conversion_commit',
    'organization_membership', p_membership_id::text, p_idempotency_key,
    jsonb_build_object(
      'sourceMembershipId', p_membership_id,
      'sourceRole', v_source.staxis_role,
      'sourceScope', v_source.membership_scope,
      'sourcePropertyIds', to_jsonb(coalesce(v_source.covered_property_ids, '{}'::uuid[])),
      'accessRevision', p_expected_access_revision,
      'effectivePropertyIds', v_preview->'beforePropertyIds',
      'accessEntryCount', v_preview->'currentGrantCount'
    ),
    jsonb_build_object(
      'canonicalMembershipId', v_canonical_membership_id,
      'accessRevision', v_revision,
      'effectivePropertyIds', v_preview->'afterPropertyIds',
      'accessProfile', p_access_profile,
      'scopeKind', p_scope_kind,
      'portfolioId', p_portfolio_id,
      'propertyIds', to_jsonb(v_property_ids),
      'expiresAt', p_expires_at
    ),
    jsonb_build_object(
      'operation', 'replace',
      'previewFingerprint', p_preview_fingerprint,
      'retainedGrantCount', v_preview->'retainedGrantCount',
      'revokedGrantCount', v_preview->'revokedGrantCount',
      'upsertedGrantCount', v_preview->'upsertedGrantCount',
      'accessChangesImmediately', true
    )
  );

  v_response := jsonb_build_object(
    'schemaVersion', 'company-access-editor-v2',
    'organizationId', p_organization_id,
    'membershipId', v_canonical_membership_id,
    'sourceMembershipId', p_membership_id,
    'conversionFromHat', true,
    'accessEpoch', v_epoch,
    'accessRevision', v_revision,
    'changed', true,
    'idempotentReplay', false,
    'auditRequestId', p_idempotency_key
  );

  insert into public.company_access_mutation_requests (
    actor_account_id, idempotency_key, request_fingerprint,
    organization_id, membership_id, response
  ) values (
    p_actor_account_id, p_idempotency_key, v_request_fingerprint,
    p_organization_id, p_membership_id, v_response
  );
  return v_response;
end;
$$;

revoke all on function public._staxis_commit_company_access_hat_conversion(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz,
  bigint, text, text, boolean, uuid
) from public, anon, authenticated, service_role;

create or replace function public.staxis_commit_company_access_edit_v2(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_membership_id uuid,
  p_operation text,
  p_access_profile text,
  p_scope_kind text,
  p_portfolio_id uuid,
  p_property_ids uuid[],
  p_expires_at timestamptz,
  p_expected_access_epoch bigint,
  p_expected_access_revision text,
  p_preview_fingerprint text,
  p_confirmed boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if exists (
    select 1 from public.organization_memberships membership
    where membership.id = p_membership_id
      and membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.starts_at <= clock_timestamp()
      and membership.ended_at is null
      and membership.staxis_role is not null
  ) or exists (
    select 1 from public.company_access_mutation_requests request_row
    where request_row.actor_account_id = p_actor_account_id
      and request_row.idempotency_key = p_idempotency_key
      and request_row.membership_id = p_membership_id
      and request_row.organization_id = p_organization_id
      and request_row.response->>'conversionFromHat' = 'true'
  ) then
    return public._staxis_commit_company_access_hat_conversion(
      p_actor_account_id, p_organization_id, p_membership_id, p_operation,
      p_access_profile, p_scope_kind, p_portfolio_id, p_property_ids,
      p_expires_at, p_expected_access_epoch, p_expected_access_revision,
      p_preview_fingerprint, p_confirmed, p_idempotency_key
    );
  end if;

  v_result := public.staxis_commit_company_access_edit(
    p_actor_account_id, p_organization_id, p_membership_id, p_operation,
    p_access_profile, p_scope_kind, p_portfolio_id, p_property_ids,
    p_expires_at, p_expected_access_epoch, p_expected_access_revision,
    p_preview_fingerprint, p_confirmed, p_idempotency_key
  );
  return jsonb_set(
    v_result,
    '{schemaVersion}',
    to_jsonb('company-access-editor-v2'::text),
    true
  );
end;
$$;

revoke all on function public.staxis_commit_company_access_edit_v2(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz,
  bigint, text, text, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.staxis_commit_company_access_edit_v2(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz,
  bigint, text, text, boolean, uuid
) to service_role;

-- Existing hotel-team mutations remain available only for accounts whose
-- durable authority is still legacy/shadow at an independent hotel. A target
-- that has cut over is edited through the Access workflow above, even if a
-- stale property_access value remains on accounts.
alter function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,
  timestamptz,bigint,text
) rename to _staxis_change_hotel_team_role_guarded_legacy_impl;

revoke all on function public._staxis_change_hotel_team_role_guarded_legacy_impl(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,
  timestamptz,bigint,text
) from public, anon, authenticated, service_role;

create or replace function public.staxis_change_hotel_team_role_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_new_role text,
  p_new_display_name text,
  p_expected_active boolean,
  p_expected_role text,
  p_expected_auth_user_id uuid,
  p_expected_property_access uuid[],
  p_expected_display_name text,
  p_expected_updated_at timestamptz,
  p_expected_intent_version bigint,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.accounts target_account
    join public.account_authorization_state target_state
      on target_state.account_id = target_account.id
     and target_state.authority_mode in ('legacy', 'shadow')
    where target_account.id = p_target_account_id
  ) or exists (
    select 1
    from public.accounts actor
    left join public.account_authorization_state actor_state
      on actor_state.account_id = actor.id
    where actor.id = p_actor_account_id
      and actor.role <> 'admin'
      and (actor_state.account_id is null
        or actor_state.authority_mode not in ('legacy', 'shadow'))
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
  end if;
  if not exists (
    select 1
    from public._staxis_current_primary_property_relationships() relationship
    join public.organizations organization
      on organization.id = relationship.organization_id
     and organization.organization_type = 'single_hotel'
     and organization.legacy_property_id = p_hotel_id
     and organization.status = 'active'
    where relationship.property_id = p_hotel_id
      and relationship.active_primary_count = 1
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'company_owned_hotel');
  end if;
  return public._staxis_change_hotel_team_role_guarded_legacy_impl(
    p_actor_account_id, p_actor_auth_user_id, p_actor_email, p_hotel_id,
    p_target_account_id, p_new_role, p_new_display_name, p_expected_active,
    p_expected_role, p_expected_auth_user_id, p_expected_property_access,
    p_expected_display_name, p_expected_updated_at,
    p_expected_intent_version, p_request_id
  );
end;
$$;

revoke all on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,
  timestamptz,bigint,text
) from public, anon, authenticated;
grant execute on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,
  timestamptz,bigint,text
) to service_role;

alter function public.staxis_remove_property_access_guarded(
  uuid,uuid,text,timestamptz
) rename to _staxis_remove_property_access_guarded_legacy_impl;

revoke all on function public._staxis_remove_property_access_guarded_legacy_impl(
  uuid,uuid,text,timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.staxis_remove_property_access_guarded(
  p_account_id uuid,
  p_hotel_id uuid,
  p_expected_role text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.account_authorization_state state
    where state.account_id = p_account_id
      and state.authority_mode in ('legacy', 'shadow')
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
  end if;
  if not exists (
    select 1
    from public._staxis_current_primary_property_relationships() relationship
    join public.organizations organization
      on organization.id = relationship.organization_id
     and organization.organization_type = 'single_hotel'
     and organization.legacy_property_id = p_hotel_id
     and organization.status = 'active'
    where relationship.property_id = p_hotel_id
      and relationship.active_primary_count = 1
  ) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'company_owned_hotel');
  end if;
  return public._staxis_remove_property_access_guarded_legacy_impl(
    p_account_id, p_hotel_id, p_expected_role, p_expected_updated_at
  );
end;
$$;

revoke all on function public.staxis_remove_property_access_guarded(
  uuid,uuid,text,timestamptz
) from public, anon, authenticated;
grant execute on function public.staxis_remove_property_access_guarded(
  uuid,uuid,text,timestamptz
) to service_role;

-- ── Legacy ownership transfer containment ─────────────────────────────────
-- The implementation from 0335 remains the audited/idempotent writer, but is
-- now reachable only through this forward guard. Global accounts.role swaps
-- cannot represent company ownership and must never run for normalized users
-- or a hotel currently governed by a real company.
alter function public.staxis_transfer_ownership_guarded(
  uuid,uuid,uuid,text,uuid,uuid,uuid,
  boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) rename to _staxis_transfer_ownership_guarded_legacy_impl;

revoke all on function public._staxis_transfer_ownership_guarded_legacy_impl(
  uuid,uuid,uuid,text,uuid,uuid,uuid,
  boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) from public, anon, authenticated, service_role;

-- Read-only response-loss settlement. The HTTP route calls this before its
-- normal hotel-roster preflight because a completed transfer may subsequently
-- move into normalized authority or a different company topology. Only the
-- exact durable receipt can bypass that preflight; every non-replay continues
-- through the ordinary tenant/capability checks and the mutating guard below.
create or replace function public.staxis_check_ownership_transfer_replay(
  p_operation_id uuid,
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_property_id uuid,
  p_old_owner_account_id uuid,
  p_new_owner_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_matching_audit boolean := false;
begin
  if p_operation_id is null
     or p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_property_id is null
     or p_old_owner_account_id is null
     or p_new_owner_account_id is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Match the writer's operation lock. A response racing the original commit
  -- waits here and then observes its immutable audit atomically. Do not read
  -- either account before the tenant-bounded roster preflight: the exact
  -- receipt is enough to settle a replay, while `not_applied` deliberately
  -- reveals nothing about an arbitrary target id.
  perform pg_advisory_xact_lock(
    hashtextextended('staxis.transfer-ownership:' || p_operation_id::text, 0)
  );

  if not exists (
    select 1
    from public.accounts actor
    where actor.id = p_actor_account_id
      and actor.data_user_id = p_actor_auth_user_id
  ) then
    return jsonb_build_object('status', 'not_applied');
  end if;

  select exists (
    select 1
    from public.admin_audit_log audit
    where audit.action = 'account.transfer_ownership'
      and audit.actor_user_id = p_actor_auth_user_id
      and audit.target_type = 'account'
      and audit.target_id = p_new_owner_account_id::text
      and audit.metadata ->> 'operation_id' = p_operation_id::text
      and audit.metadata ->> 'hotel_id' = p_property_id::text
      and audit.metadata ->> 'from_account_id' = p_old_owner_account_id::text
      and audit.metadata ->> 'to_account_id' = p_new_owner_account_id::text
      and audit.metadata ->> 'from_old_role' = 'owner'
      and audit.metadata ->> 'global_account_change' = 'true'
      and jsonb_typeof(audit.metadata -> 'old_owner_affected_hotel_ids') = 'array'
      and jsonb_typeof(audit.metadata -> 'new_owner_affected_hotel_ids') = 'array'
      and audit.metadata -> 'old_owner_affected_hotel_ids'
            = audit.metadata -> 'new_owner_affected_hotel_ids'
      and (audit.metadata -> 'old_owner_affected_hotel_ids')
            @> jsonb_build_array(p_property_id)
  ) into v_matching_audit;

  if v_matching_audit then
    return jsonb_build_object('status', 'already_applied');
  end if;

  -- A collision is disclosed only to the same authenticated actor. An
  -- operation UUID used by another tenant remains indistinguishable from an
  -- unused UUID until the ordinary authorized mutation path evaluates it.
  if exists (
    select 1
    from public.admin_audit_log audit
    where audit.action = 'account.transfer_ownership'
      and audit.actor_user_id = p_actor_auth_user_id
      and audit.metadata ->> 'operation_id' = p_operation_id::text
  ) then
    return jsonb_build_object('status', 'conflict', 'reason', 'operation_id_reused');
  end if;

  return jsonb_build_object('status', 'not_applied');
end;
$$;

revoke all on function public.staxis_check_ownership_transfer_replay(
  uuid,uuid,uuid,uuid,uuid,uuid
) from public, anon, authenticated;
grant execute on function public.staxis_check_ownership_transfer_replay(
  uuid,uuid,uuid,uuid,uuid,uuid
) to service_role;

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
  v_old_owner public.accounts%rowtype;
  v_new_owner public.accounts%rowtype;
  v_old_affected_hotel_ids uuid[] := '{}'::uuid[];
  v_new_affected_hotel_ids uuid[] := '{}'::uuid[];
  v_matching_audit boolean := false;
  v_property_id uuid;
begin
  if p_operation_id is null
     or p_actor_account_id is null
     or p_actor_auth_user_id is null
     or p_old_owner_account_id is null
     or p_new_owner_account_id is null
     or p_property_id is null
  then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Serialize the client-stable operation before any replay or containment
  -- decision. The nested 0335 implementation takes this same lock reentrantly.
  perform pg_advisory_xact_lock(
    hashtextextended('staxis.transfer-ownership:' || p_operation_id::text, 0)
  );

  -- Freeze every fact used by both the legacy-containment check below and the
  -- 0335 writer before deciding which authority plane owns this handoff. Keep
  -- the established people-lifecycle order: account rows, authority-state
  -- rows, every affected property in UUID order, then the topology tables.
  -- Property rows use NOWAIT because the relationship writer takes them before
  -- organization/authority facts; waiting after locking account state would
  -- create a lock-order cycle. The table lock is NOWAIT for the same reason.
  -- A bounded retry gives the competing writer a clean serialization point.
  --
  -- These locks remain held through the nested legacy implementation. An exact
  -- durable receipt may return read-only before authority/topology containment;
  -- a new operation re-reads all of those facts immediately before the atomic
  -- role/audit write.
  begin
    perform 1
    from public.accounts account
    where account.id = any(array[
      p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id
    ])
    order by account.id
    for update;

    select * into v_actor
    from public.accounts where id = p_actor_account_id;
    select * into v_old_owner
    from public.accounts where id = p_old_owner_account_id;
    select * into v_new_owner
    from public.accounts where id = p_new_owner_account_id;
    if v_actor.id is null then
      return jsonb_build_object('status', 'not_found', 'reason', 'actor');
    end if;
    if v_old_owner.id is null then
      return jsonb_build_object('status', 'not_found', 'reason', 'old_owner');
    end if;
    if v_new_owner.id is null then
      return jsonb_build_object('status', 'not_found', 'reason', 'new_owner');
    end if;
    if v_actor.data_user_id <> p_actor_auth_user_id then
      return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
    end if;

    select coalesce(array_agg(affected.id order by affected.id), '{}'::uuid[])
      into v_old_affected_hotel_ids
    from (
      select distinct unnest(v_old_owner.property_access) as id
    ) affected;
    select coalesce(array_agg(affected.id order by affected.id), '{}'::uuid[])
      into v_new_affected_hotel_ids
    from (
      select distinct unnest(v_new_owner.property_access) as id
    ) affected;

    select exists (
      select 1
      from public.admin_audit_log audit
      where audit.action = 'account.transfer_ownership'
        and audit.actor_user_id = p_actor_auth_user_id
        and audit.target_type = 'account'
        and audit.target_id = p_new_owner_account_id::text
        and audit.metadata ->> 'operation_id' = p_operation_id::text
        and audit.metadata ->> 'hotel_id' = p_property_id::text
        and audit.metadata ->> 'from_account_id' = p_old_owner_account_id::text
        and audit.metadata ->> 'to_account_id' = p_new_owner_account_id::text
    ) into v_matching_audit;

    if v_matching_audit then
      if v_old_owner.role = 'general_manager'
         and v_new_owner.role = 'owner'
         and exists (
           select 1
           from public.admin_audit_log audit
           where audit.action = 'account.transfer_ownership'
             and audit.actor_user_id = p_actor_auth_user_id
             and audit.target_type = 'account'
             and audit.target_id = p_new_owner_account_id::text
             and audit.metadata ->> 'operation_id' = p_operation_id::text
             and audit.metadata ->> 'hotel_id' = p_property_id::text
             and audit.metadata ->> 'from_account_id' = p_old_owner_account_id::text
             and audit.metadata ->> 'to_account_id' = p_new_owner_account_id::text
             and audit.metadata ->> 'from_active' = v_old_owner.active::text
             and audit.metadata ->> 'to_active' = v_new_owner.active::text
             and audit.metadata ->> 'from_auth_user_id'
                   = v_old_owner.data_user_id::text
             and audit.metadata ->> 'to_auth_user_id'
                   = v_new_owner.data_user_id::text
             and audit.metadata -> 'old_owner_affected_hotel_ids'
                   = to_jsonb(v_old_affected_hotel_ids)
             and audit.metadata -> 'new_owner_affected_hotel_ids'
                   = to_jsonb(v_new_affected_hotel_ids)
         )
      then
        return jsonb_build_object(
          'status', 'already_applied',
          'operation_id', p_operation_id,
          'old_owner_account_id', v_old_owner.id,
          'new_owner_account_id', v_new_owner.id
        );
      end if;
      return jsonb_build_object('status', 'conflict', 'reason', 'replay_state_changed');
    end if;

    if exists (
      select 1
      from public.admin_audit_log audit
      where audit.action = 'account.transfer_ownership'
        and audit.metadata ->> 'operation_id' = p_operation_id::text
    ) then
      return jsonb_build_object('status', 'conflict', 'reason', 'operation_id_reused');
    end if;

    perform 1
    from public.account_authorization_state state
    where state.account_id = any(array[
      p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id
    ])
    order by state.account_id
    for update;

    if v_old_affected_hotel_ids is distinct from v_new_affected_hotel_ids then
      return jsonb_build_object(
        'status', 'conflict',
        'reason', 'hotel_access_mismatch'
      );
    end if;

    for v_property_id in
      select affected.id
      from unnest(v_old_affected_hotel_ids) affected(id)
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

  -- Platform admins may operate the legacy tool, but both customer subjects
  -- and every non-admin actor must still be explicitly legacy/shadow.
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
        or state.authority_mode not in ('legacy', 'shadow')
      )
  ) then
    return jsonb_build_object(
      'status', 'forbidden',
      'reason', 'normalized_authority'
    );
  end if;

  if exists (
    select 1
    from public.organization_memberships membership
    where membership.account_id = any(array[
      p_old_owner_account_id, p_new_owner_account_id
    ])
      and membership.status = 'active'
      and membership.ended_at is null
      and membership.staxis_role is not null
  ) or exists (
    select 1
    from public.organization_access_grants grant_row
    join public.organization_memberships membership
      on membership.id = grant_row.membership_id
     and membership.organization_id = grant_row.organization_id
    join public.organizations organization
      on organization.id = grant_row.organization_id
     and organization.organization_type <> 'single_hotel'
    where membership.account_id = any(array[
      p_old_owner_account_id, p_new_owner_account_id
    ])
      and membership.status = 'active'
      and membership.ended_at is null
      and grant_row.status = 'active'
      and grant_row.source <> 'legacy_backfill'
  ) then
    return jsonb_build_object(
      'status', 'forbidden',
      'reason', 'company_authority'
    );
  end if;

  if exists (
    select 1
    from unnest(v_old_affected_hotel_ids) affected(property_id)
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
       or exists (
         select 1
         from public._staxis_current_primary_property_relationships() relationship
         join public.organizations organization
           on organization.id = relationship.organization_id
          and organization.status = 'active'
          and organization.organization_type <> 'single_hotel'
         where relationship.property_id = affected.property_id
           and relationship.active_primary_count = 1
       )
  ) then
    return jsonb_build_object(
      'status', 'forbidden',
      'reason', 'company_owned_hotel'
    );
  end if;

  return public._staxis_transfer_ownership_guarded_legacy_impl(
    p_operation_id,
    p_actor_account_id,
    p_actor_auth_user_id,
    p_actor_email,
    p_property_id,
    p_old_owner_account_id,
    p_new_owner_account_id,
    p_expected_old_active,
    p_expected_old_role,
    p_expected_old_auth_user_id,
    p_expected_old_property_access,
    p_expected_old_intent_version,
    p_expected_new_active,
    p_expected_new_role,
    p_expected_new_auth_user_id,
    p_expected_new_property_access,
    p_expected_new_intent_version,
    p_reason,
    p_request_id
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

-- The unauthenticated-snapshot three-argument compatibility RPC can bypass
-- neither the forward guard nor its identity-bound audit contract anymore.
revoke execute on function public.staxis_transfer_ownership(uuid, uuid, uuid)
  from service_role;

insert into public.applied_migrations(version, description)
values (
  '0390',
  'Authoritative exact-hotel people roster, fail-closed hat-to-grant access conversion, scheduled entitlement bridge retirement, final owner guard, and legacy ownership-transfer containment.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
