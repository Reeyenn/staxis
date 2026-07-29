-- 0403_recursive_portfolio_access_scope.sql
--
-- Keep Access preview/delegation topology identical to the authoritative
-- resolver: a portfolio grant covers the active descendant tree, not only the
-- root's directly assigned hotels. Preview, impact counts, and commit therefore
-- describe exactly the reach the grant will produce.

begin;

do $$
begin
  if to_regprocedure('public._staxis_company_access_can_delegate(uuid,uuid,text,text,uuid,uuid)') is null
     or to_regprocedure('public._staxis_company_access_scope_properties(uuid,text,uuid,uuid)') is null
  then
    raise exception '0403 requires company access management migration 0383';
  end if;
end
$$;

-- One atomic, service-only topology projection for company helpers that do
-- not have an account-specific authorization receipt (scheduled portfolio
-- jobs, rulebook comparisons, invite previews, and legacy hat presentation).
--
-- Reading only rows belonging to p_organization_id is insufficient: if a
-- damaged restore leaves hotel H current-primary in both company A and company
-- B, each isolated read sees one apparently valid row. Count every current
-- primary for each candidate hotel inside this single SQL statement and reject
-- the entire company projection on any ambiguity. This deliberately returns a
-- proven empty success for an active organization with no hotels, while an
-- absent/inactive organization and an ambiguous/oversized topology stay
-- indistinguishable to service callers.
create or replace function public.staxis_resolve_organization_property_topology(
  p_organization_id uuid,
  p_effective_at timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with current_primary as (
    select relationship.organization_id,
           relationship.property_id,
           count(*) over (partition by relationship.property_id)
             as active_primary_count
    from public.organization_property_relationships relationship
    where relationship.is_primary_grouping is true
      and relationship.relationship_type in ('operator', 'owner')
      and relationship.starts_at <= p_effective_at
      and (relationship.ends_at is null
        or relationship.ends_at > p_effective_at)
  ),
  organization_rows as (
    select current_primary.property_id,
           current_primary.active_primary_count
    from current_primary
    where current_primary.organization_id = p_organization_id
  ),
  projection as (
    select coalesce(
             array_agg(organization_rows.property_id
               order by organization_rows.property_id)
               filter (where organization_rows.active_primary_count = 1),
             '{}'::uuid[]
           ) as property_ids,
           count(*) filter (
             where organization_rows.active_primary_count > 1
           )::integer as ambiguous_row_count
    from organization_rows
  )
  select case
    when p_organization_id is null or p_effective_at is null then
      jsonb_build_object('ok', false, 'reason', 'invalid_input')
    when not exists (
      select 1
      from public.organizations organization
      where organization.id = p_organization_id
        and organization.status = 'active'
    ) then
      jsonb_build_object('ok', false, 'reason', 'store_unavailable')
    when projection.ambiguous_row_count > 0
      or cardinality(projection.property_ids) > 5000 then
      jsonb_build_object('ok', false, 'reason', 'store_unavailable')
    else
      jsonb_build_object(
        'ok', true,
        'schemaVersion', 'organization-property-topology-v1',
        'organizationId', p_organization_id,
        'effectiveAt', p_effective_at,
        'propertyIds', to_jsonb(projection.property_ids)
      )
  end
  from projection;
$$;

revoke all on function public.staxis_resolve_organization_property_topology(
  uuid, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.staxis_resolve_organization_property_topology(
  uuid, timestamptz
) to service_role;

-- Recursive, cycle-safe (UNION, not UNION ALL) current scope expansion.
create or replace function public._staxis_company_access_scope_properties(
  p_organization_id uuid,
  p_scope_type text,
  p_portfolio_id uuid,
  p_property_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  portfolio_tree (portfolio_id) as (
    select portfolio.id
    from public.portfolios portfolio
    where p_scope_type = 'portfolio'
      and portfolio.id = p_portfolio_id
      and portfolio.organization_id = p_organization_id
      and portfolio.status = 'active'

    union

    select child.id
    from portfolio_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = p_organization_id
     and child.status = 'active'
  ),
  candidate as (
    select distinct relationship.property_id
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.organization_id = p_organization_id
      and relationship.active_primary_count = 1
      and (
        (p_scope_type = 'organization'
          and p_portfolio_id is null and p_property_id is null)
        or (p_scope_type = 'property'
          and p_portfolio_id is null
          and relationship.property_id = p_property_id)
        or (
          p_scope_type = 'portfolio'
          and p_property_id is null
          and exists (
            select 1
            from public.portfolio_properties assignment
            join portfolio_tree tree on tree.portfolio_id = assignment.portfolio_id
            where assignment.organization_id = relationship.organization_id
              and assignment.property_relationship_id = relationship.id
              and assignment.property_id = relationship.property_id
              and assignment.assigned_at <= now()
              and (assignment.removed_at is null or assignment.removed_at > now())
          )
        )
      )
  )
  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
  from candidate;
$$;

revoke all on function public._staxis_company_access_scope_properties(
  uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;

-- Retain the complete 0383 policy for company-wide, VP, and direct-root cases;
-- add only the missing descendant-tree branch for portfolio managers.
do $$
begin
  if to_regprocedure('public._staxis_company_access_can_delegate_v0381(uuid,uuid,text,text,uuid,uuid)') is null then
    alter function public._staxis_company_access_can_delegate(
      uuid, uuid, text, text, uuid, uuid
    ) rename to _staxis_company_access_can_delegate_v0381;
  end if;
end
$$;

revoke all on function public._staxis_company_access_can_delegate_v0381(
  uuid, uuid, text, text, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function public._staxis_company_access_can_delegate(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_access_profile text,
  p_scope_type text,
  p_portfolio_id uuid,
  p_property_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_allowed boolean := false;
begin
  -- Preserve every original policy branch first.
  if public._staxis_company_access_can_delegate_v0381(
    p_actor_account_id,
    p_organization_id,
    p_access_profile,
    p_scope_type,
    p_portfolio_id,
    p_property_id
  ) then
    return true;
  end if;

  -- The only additional authority is a lower-profile target in an active
  -- descendant of a portfolio-manager root. It cannot mint peers, company
  -- scope, foreign topology, or reach from an unrelated narrow grant.
  if p_actor_account_id is null
     or p_organization_id is null
     or p_access_profile not in (
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     )
     or p_scope_type not in ('portfolio', 'property')
     or (p_scope_type = 'portfolio'
       and (p_portfolio_id is null or p_property_id is not null))
     or (p_scope_type = 'property'
       and (p_property_id is null or p_portfolio_id is not null))
  then
    return false;
  end if;

  with recursive
  manager_tree (grant_id, portfolio_id) as (
    select grant_row.id, portfolio.id
    from public.accounts account
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    join public.organization_memberships membership
      on membership.account_id = account.id
     and membership.organization_id = p_organization_id
     and membership.status = 'active'
     and membership.starts_at <= now()
     and membership.ended_at is null
    join public.organization_access_grants grant_row
      on grant_row.membership_id = membership.id
     and grant_row.organization_id = membership.organization_id
     and grant_row.status = 'active'
     and grant_row.source <> 'legacy_backfill'
     and grant_row.starts_at <= now()
     and (grant_row.expires_at is null or grant_row.expires_at > now())
     and grant_row.access_profile = 'portfolio_manager'
     and grant_row.scope_type = 'portfolio'
    join public.portfolios portfolio
      on portfolio.id = grant_row.portfolio_id
     and portfolio.organization_id = grant_row.organization_id
     and portfolio.status = 'active'
    join public.organizations organization
      on organization.id = grant_row.organization_id
     and organization.status = 'active'
     and organization.organization_type in ('management_company', 'ownership_group')
    where account.id = p_actor_account_id
      and account.active is true
      and account.role <> 'admin'

    union

    select tree.grant_id, child.id
    from manager_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = p_organization_id
     and child.status = 'active'
  )
  select exists (
    select 1
    from manager_tree tree
    where (p_scope_type = 'portfolio' and tree.portfolio_id = p_portfolio_id)
       or (
         p_scope_type = 'property'
         and exists (
           select 1
           from public.portfolio_properties assignment
           join public._staxis_current_primary_property_relationships() relationship
             on relationship.id = assignment.property_relationship_id
            and relationship.organization_id = assignment.organization_id
            and relationship.property_id = assignment.property_id
            and relationship.active_primary_count = 1
           where assignment.organization_id = p_organization_id
             and assignment.portfolio_id = tree.portfolio_id
             and assignment.property_id = p_property_id
             and assignment.assigned_at <= now()
             and (assignment.removed_at is null or assignment.removed_at > now())
         )
       )
  ) into v_allowed;

  return coalesce(v_allowed, false);
end;
$$;

revoke all on function public._staxis_company_access_can_delegate(
  uuid, uuid, text, text, uuid, uuid
) from public, anon, authenticated, service_role;

insert into public.applied_migrations(version, description)
values (
  '0403',
  'Align company Access preview, impact, and delegation with recursive active portfolio descendant scope.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
