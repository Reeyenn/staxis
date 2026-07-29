-- 0402_company_structure_manager_entitlement_boundary.sql
--
-- Close a mixed-entitlement confused-deputy path in the 0381 portfolio
-- assignment preview. Read reach and mutation reach are deliberately separate:
-- a viewer/property grant may let an actor see a hotel, but only a company-wide
-- manager entitlement or a portfolio-manager entitlement that already covers
-- that hotel may authorize changing its portfolio assignments.

begin;

do $$
begin
  if to_regprocedure('public._staxis_company_structure_actor_rights(uuid,uuid)') is null
     or to_regprocedure('public._staxis_preview_company_portfolio_assignment(uuid,uuid,uuid,uuid[],bigint)') is null
     or to_regclass('public.account_authorization_state') is null
  then
    raise exception '0402 requires company structure and authoritative access migrations 0378/0381';
  end if;
end
$$;

-- Exact hotels whose structure this actor may mutate. This is intentionally
-- NOT the actor's unioned read scope. A portfolio manager gets hotels already
-- assigned anywhere in the active descendant tree of a portfolio-manager
-- grant. Narrow viewer/property grants never contribute rows here.
create or replace function public._staxis_company_structure_manageable_property_ids(
  p_actor_account_id uuid,
  p_organization_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  live_actor as (
    select account.id
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    join public.organizations organization
      on organization.id = p_organization_id
     and organization.status = 'active'
     and organization.organization_type in ('management_company', 'ownership_group')
    where account.id = p_actor_account_id
      and account.active is true
      and account.role <> 'admin'
  ),
  active_memberships as (
    select membership.*
    from public.organization_memberships membership
    join live_actor actor on actor.id = membership.account_id
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.starts_at <= now()
      and membership.ended_at is null
  ),
  active_grants as (
    select grant_row.*
    from public.organization_access_grants grant_row
    join active_memberships membership
      on membership.id = grant_row.membership_id
     and membership.organization_id = grant_row.organization_id
    where grant_row.status = 'active'
      and grant_row.source <> 'legacy_backfill'
      and grant_row.starts_at <= now()
      and (grant_row.expires_at is null or grant_row.expires_at > now())
  ),
  broad_manager as (
    select (
      exists (
        select 1
        from active_memberships membership
        where membership.membership_scope = 'company'
          and membership.staxis_role in ('owner', 'vp')
      ) or exists (
        select 1
        from active_grants grant_row
        where grant_row.scope_type = 'organization'
          and grant_row.access_profile in ('organization_owner', 'organization_admin')
      )
    ) as allowed
  ),
  manager_portfolio_tree (portfolio_id) as (
    select portfolio.id
    from active_grants grant_row
    join public.portfolios portfolio
      on portfolio.id = grant_row.portfolio_id
     and portfolio.organization_id = grant_row.organization_id
     and portfolio.status = 'active'
    where grant_row.scope_type = 'portfolio'
      and grant_row.access_profile = 'portfolio_manager'

    union

    select child.id
    from manager_portfolio_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = p_organization_id
     and child.status = 'active'
  ),
  governed_relationships as (
    select relationship.id, relationship.property_id
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.organization_id = p_organization_id
      and relationship.active_primary_count = 1
  ),
  manageable as (
    select relationship.property_id
    from governed_relationships relationship
    cross join broad_manager manager
    where manager.allowed

    union

    select relationship.property_id
    from manager_portfolio_tree tree
    join public.portfolio_properties assignment
      on assignment.organization_id = p_organization_id
     and assignment.portfolio_id = tree.portfolio_id
     and assignment.assigned_at <= now()
     and (assignment.removed_at is null or assignment.removed_at > now())
    join governed_relationships relationship
      on relationship.id = assignment.property_relationship_id
     and relationship.property_id = assignment.property_id
  )
  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
  from manageable;
$$;

revoke all on function public._staxis_company_structure_manageable_property_ids(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Preserve the fully preview-bound 0381 implementation behind a private name,
-- then put the manager-entitlement intersection in front of every preview and
-- commit (the commit re-invokes this public-name preview while holding locks).
do $$
begin
  if to_regprocedure('public._staxis_preview_company_portfolio_assignment_v0379(uuid,uuid,uuid,uuid[],bigint)') is null then
    alter function public._staxis_preview_company_portfolio_assignment(
      uuid, uuid, uuid, uuid[], bigint
    ) rename to _staxis_preview_company_portfolio_assignment_v0379;
  end if;
end
$$;

revoke all on function public._staxis_preview_company_portfolio_assignment_v0379(
  uuid, uuid, uuid, uuid[], bigint
) from public, anon, authenticated, service_role;

create or replace function public._staxis_preview_company_portfolio_assignment(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_desired_portfolio_ids uuid[],
  p_expected_access_epoch bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not coalesce(
    p_property_id = any(public._staxis_company_structure_manageable_property_ids(
      p_actor_account_id, p_organization_id
    )),
    false
  ) then
    raise exception 'hotel is outside the actor structure-management scope'
      using errcode = '42501';
  end if;

  return public._staxis_preview_company_portfolio_assignment_v0379(
    p_actor_account_id,
    p_organization_id,
    p_property_id,
    p_desired_portfolio_ids,
    p_expected_access_epoch
  );
end;
$$;

revoke all on function public._staxis_preview_company_portfolio_assignment(
  uuid, uuid, uuid, uuid[], bigint
) from public, anon, authenticated;
grant execute on function public._staxis_preview_company_portfolio_assignment(
  uuid, uuid, uuid, uuid[], bigint
) to service_role;

insert into public.applied_migrations(version, description)
values (
  '0402',
  'Separate company-structure read reach from manager-entitlement mutation reach, closing mixed-grant confused-deputy assignment.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
