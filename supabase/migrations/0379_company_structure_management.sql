-- 0379_company_structure_management.sql
--
-- Customer-safe company structure management for the existing My Hotel
-- Overview / Hotels / People / Access surface.
--
-- This migration deliberately DOES NOT expose customer RPCs that create,
-- claim, end, or transfer an organization/property relationship. Those are
-- trust-boundary changes and continue to flow through the verified Staxis
-- platform-admin RPC `staxis_set_primary_property_organization`.
--
-- Customers with a fresh `manage_portfolios` capability may change only the
-- portfolio/region assignments of a hotel that is already governed by their
-- same active primary owner/operator relationship. Every confirmed change is
-- preview-bound, epoch-checked, idempotent, audited, and immediately
-- invalidates outstanding organization scope receipts through the existing
-- organization_access_epochs audit triggers.

begin;

do $$
begin
  if to_regclass('public.account_authorization_state') is null
     or to_regclass('public.organization_access_epochs') is null
     or to_regclass('public.organization_access_events') is null
     or to_regprocedure('public._staxis_nonlegacy_property_authorizations(uuid)') is null
  then
    raise exception '0379 requires authoritative organization access migration 0376';
  end if;
end
$$;

-- @rls: service-role-only — idempotency receipts contain authorization-bound
-- request fingerprints and are reachable only through the confirmed commit RPC.
create table if not exists public.company_structure_mutation_requests (
  id                   uuid primary key default gen_random_uuid(),
  actor_account_id     uuid not null references public.accounts(id) on delete restrict,
  idempotency_key      uuid not null,
  request_fingerprint  text not null,
  organization_id      uuid not null references public.organizations(id) on delete restrict,
  property_id          uuid not null references public.properties(id) on delete restrict,
  response             jsonb not null,
  created_at           timestamptz not null default now(),

  constraint company_structure_mutation_requests_actor_key
    unique (actor_account_id, idempotency_key),
  constraint company_structure_mutation_requests_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint company_structure_mutation_requests_response_check
    check (jsonb_typeof(response) = 'object')
);

comment on table public.company_structure_mutation_requests is
  'Service-only exact responses for idempotent company structure commits. A key is permanently bound to one actor and request fingerprint.';

create index if not exists company_structure_mutation_requests_created_idx
  on public.company_structure_mutation_requests (created_at desc);

alter table public.company_structure_mutation_requests enable row level security;
revoke all on public.company_structure_mutation_requests from public, anon, authenticated, service_role;

-- One fresh, fail-closed capability answer for one actor and organization.
-- `authorized_property_ids` is always produced by the same normalized
-- entitlement projection used by the portfolio resolver. Brand/vendor/
-- consultant links cannot enter that projection.
create or replace function public._staxis_company_structure_actor_rights(
  p_actor_account_id uuid,
  p_organization_id uuid
)
returns table (
  authorized_property_ids uuid[],
  whole_company_view boolean,
  can_manage_portfolios boolean,
  manageable_portfolio_ids uuid[]
)
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
  actor_authorizations as (
    select distinct authorized.property_id
    from live_actor actor
    cross join lateral public._staxis_nonlegacy_property_authorizations(actor.id) authorized
    where authorized.organization_id = p_organization_id
  ),
  flags as (
    select
      exists (
        select 1
        from active_memberships membership
        where membership.membership_scope = 'company'
          and membership.staxis_role in ('owner', 'vp', 'finance')
      ) or exists (
        select 1
        from active_grants grant_row
        where grant_row.scope_type = 'organization'
      ) as whole_company_view,
      exists (
        select 1
        from active_memberships membership
        where membership.membership_scope = 'company'
          and membership.staxis_role in ('owner', 'vp')
      ) or exists (
        select 1
        from active_grants grant_row
        where (grant_row.scope_type = 'organization'
                 and grant_row.access_profile in ('organization_owner', 'organization_admin'))
           or (grant_row.scope_type = 'portfolio'
                 and grant_row.access_profile = 'portfolio_manager')
      ) as can_manage_portfolios,
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
      ) as manages_all_portfolios
  ),
  portfolio_tree (portfolio_id) as (
    select portfolio.id
    from public.portfolios portfolio
    cross join flags
    where portfolio.organization_id = p_organization_id
      and portfolio.status = 'active'
      and flags.manages_all_portfolios

    union

    select grant_row.portfolio_id
    from active_grants grant_row
    join public.portfolios portfolio
      on portfolio.id = grant_row.portfolio_id
     and portfolio.organization_id = grant_row.organization_id
     and portfolio.status = 'active'
    where grant_row.scope_type = 'portfolio'
      and grant_row.access_profile = 'portfolio_manager'

    union

    select child.id
    from portfolio_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = p_organization_id
     and child.status = 'active'
  )
  select
    coalesce((select array_agg(property_id order by property_id) from actor_authorizations), '{}'::uuid[]),
    flags.whole_company_view,
    flags.can_manage_portfolios,
    coalesce((select array_agg(portfolio_id order by portfolio_id) from portfolio_tree), '{}'::uuid[])
  from flags;
$$;

revoke all on function public._staxis_company_structure_actor_rights(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Read projection used only by the authenticated server route. It returns no
-- account identifiers and no organization for which the actor has zero
-- normalized hotel reach. A scoped hotel user sees no sister hotel metadata.
create or replace function public.staxis_company_structure_projection(
  p_actor_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with
  candidate_organizations as (
    select distinct authz.organization_id
    from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
    join public.account_authorization_state state
      on state.account_id = authz.account_id
     and state.authority_mode = 'normalized'
    join public.accounts actor
      on actor.id = authz.account_id
     and actor.active is true
     and actor.role <> 'admin'
    join public.organizations organization
      on organization.id = authz.organization_id
     and organization.status = 'active'
     and organization.organization_type in ('management_company', 'ownership_group')
  ),
  organization_rows as (
    select organization.id, organization.name,
           organization.organization_type, epoch.version,
           rights.authorized_property_ids, rights.whole_company_view,
           rights.can_manage_portfolios, rights.manageable_portfolio_ids,
           public._staxis_authorized_portfolio_catalog(
             organization.id, rights.authorized_property_ids
           ) as portfolio_catalog
    from candidate_organizations candidate
    join public.organizations organization on organization.id = candidate.organization_id
    join public.organization_access_epochs epoch on epoch.organization_id = organization.id
    cross join lateral public._staxis_company_structure_actor_rights(
      p_actor_account_id, organization.id
    ) rights
    where cardinality(rights.authorized_property_ids) > 0
  ),
  serialized as (
    select row.id,
      jsonb_build_object(
        'id', row.id,
        'name', row.name,
        'type', row.organization_type,
        'status', 'active',
        'accessEpoch', row.version,
        'canManagePortfolios', row.can_manage_portfolios,
        'hotelRelationshipChangesRequirePlatformAdmin', true,
        'hotels', coalesce((
          select jsonb_agg(jsonb_build_object(
            'propertyId', relationship.property_id,
            'name', coalesce(property.name, 'Hotel'),
            'relationshipId', relationship.id,
            'relationshipType', relationship.relationship_type,
            'relationshipStatus', 'active',
            'portfolioIds', coalesce((
              select jsonb_agg(assignment.portfolio_id order by assignment.portfolio_id)
              from public.portfolio_properties assignment
              join public.portfolios assigned_portfolio
                on assigned_portfolio.id = assignment.portfolio_id
               and assigned_portfolio.organization_id = assignment.organization_id
               and assigned_portfolio.status = 'active'
              where assignment.organization_id = row.id
                and assignment.property_relationship_id = relationship.id
                and assignment.property_id = relationship.property_id
                and assignment.assigned_at <= now()
                and (assignment.removed_at is null or assignment.removed_at > now())
                and (
                  row.whole_company_view
                  or assignment.portfolio_id = any(row.manageable_portfolio_ids)
                  or exists (
                    select 1
                    from jsonb_array_elements(row.portfolio_catalog) catalog
                    where catalog->>'portfolioId' = assignment.portfolio_id::text
                      and jsonb_array_length(catalog->'propertyIds') > 0
                  )
                )
            ), '[]'::jsonb),
            'manageable', row.can_manage_portfolios
              and relationship.property_id = any(row.authorized_property_ids)
          ) order by lower(coalesce(property.name, '')), relationship.property_id)
          from public._staxis_current_primary_property_relationships() relationship
          join public.properties property on property.id = relationship.property_id
          where relationship.organization_id = row.id
            and relationship.property_id = any(row.authorized_property_ids)
            and relationship.active_primary_count = 1
        ), '[]'::jsonb),
        'portfolios', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', catalog->>'portfolioId',
            'organizationId', row.id,
            'parentId', catalog->>'parentId',
            'name', catalog->>'name',
            'type', catalog->>'portfolioType',
            'propertyIds', catalog->'directPropertyIds',
            'manageable', (catalog->>'portfolioId')::uuid = any(row.manageable_portfolio_ids)
          ) order by lower(catalog->>'name'), catalog->>'portfolioId')
          from jsonb_array_elements(row.portfolio_catalog) catalog
          where row.whole_company_view
             or (catalog->>'portfolioId')::uuid = any(row.manageable_portfolio_ids)
             or jsonb_array_length(catalog->'propertyIds') > 0
        ), '[]'::jsonb),
        'problems', (
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'code', 'hotel_without_portfolio',
              'severity', 'warning',
              'organizationId', row.id,
              'propertyId', relationship.property_id,
              'portfolioId', null,
              'title', coalesce(property.name, 'Hotel') || ' is not assigned to a portfolio or region',
              'detail', 'Company-wide access remains active, but portfolio-scoped people will not inherit this hotel until it is assigned.'
            ) order by lower(coalesce(property.name, '')), relationship.property_id)
            from public._staxis_current_primary_property_relationships() relationship
            join public.properties property on property.id = relationship.property_id
            where relationship.organization_id = row.id
              and relationship.property_id = any(row.authorized_property_ids)
              and relationship.active_primary_count = 1
              and not exists (
                select 1
                from public.portfolio_properties assignment
                join public.portfolios portfolio
                  on portfolio.id = assignment.portfolio_id
                 and portfolio.organization_id = assignment.organization_id
                 and portfolio.status = 'active'
                where assignment.organization_id = row.id
                  and assignment.property_relationship_id = relationship.id
                  and assignment.property_id = relationship.property_id
                  and assignment.assigned_at <= now()
                  and (assignment.removed_at is null or assignment.removed_at > now())
              )
          ), '[]'::jsonb)
          || coalesce((
            select jsonb_agg(jsonb_build_object(
              'code', 'empty_portfolio',
              'severity', 'info',
              'organizationId', row.id,
              'propertyId', null,
              'portfolioId', (catalog->>'portfolioId')::uuid,
              'title', (catalog->>'name') || ' has no hotels',
              'detail', 'This active portfolio or region currently grants no hotel reach.'
            ) order by lower(catalog->>'name'), catalog->>'portfolioId')
            from jsonb_array_elements(row.portfolio_catalog) catalog
            where row.whole_company_view
              and jsonb_array_length(catalog->'propertyIds') = 0
          ), '[]'::jsonb)
          || jsonb_build_array(jsonb_build_object(
            'code', 'relationship_change_restricted',
            'severity', 'info',
            'organizationId', row.id,
            'propertyId', null,
            'portfolioId', null,
            'title', 'Company hotel relationships are protected',
            'detail', 'Only a verified Staxis platform administrator can add, remove, or move a hotel between companies.'
          ))
        )
      ) as payload
    from organization_rows row
  )
  select jsonb_build_object(
    'schemaVersion', 'company-structure-v1',
    'generatedAt', clock_timestamp(),
    'organizations', coalesce(jsonb_agg(payload order by id), '[]'::jsonb)
  )
  from serialized;
$$;

revoke all on function public.staxis_company_structure_projection(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_company_structure_projection(uuid)
  to service_role;

create or replace function public._staxis_company_structure_portfolio_grants(
  p_organization_id uuid,
  p_assigned_portfolio_ids uuid[]
)
returns table (grant_id uuid, account_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive ancestors (portfolio_id) as (
    select portfolio.id
    from public.portfolios portfolio
    where portfolio.organization_id = p_organization_id
      and portfolio.status = 'active'
      and portfolio.id = any(coalesce(p_assigned_portfolio_ids, '{}'::uuid[]))

    union

    select parent.id
    from ancestors child
    join public.portfolios current_portfolio
      on current_portfolio.id = child.portfolio_id
     and current_portfolio.organization_id = p_organization_id
    join public.portfolios parent
      on parent.id = current_portfolio.parent_id
     and parent.organization_id = p_organization_id
     and parent.status = 'active'
  )
  select distinct grant_row.id, membership.account_id
  from ancestors
  join public.organization_access_grants grant_row
    on grant_row.organization_id = p_organization_id
   and grant_row.scope_type = 'portfolio'
   and grant_row.portfolio_id = ancestors.portfolio_id
   and grant_row.status = 'active'
   and grant_row.source <> 'legacy_backfill'
   and grant_row.starts_at <= now()
   and (grant_row.expires_at is null or grant_row.expires_at > now())
  join public.organization_memberships membership
    on membership.id = grant_row.membership_id
   and membership.organization_id = grant_row.organization_id
   and membership.status = 'active'
   and membership.starts_at <= now()
   and membership.ended_at is null
  join public.accounts account
    on account.id = membership.account_id
   and account.active is true
   and account.role <> 'admin';
$$;

revoke all on function public._staxis_company_structure_portfolio_grants(uuid, uuid[])
  from public, anon, authenticated, service_role;

-- Shared preview is called by both the read-only preview endpoint and the
-- commit RPC after acquiring the organization lock. It validates every opaque
-- id against the actor's fresh capability and the same governing relationship.
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
declare
  v_rights record;
  v_epoch bigint;
  v_relationship_id uuid;
  v_property_name text;
  v_organization_name text;
  v_current_managed uuid[] := '{}'::uuid[];
  v_all_current uuid[] := '{}'::uuid[];
  v_unmanaged_current uuid[] := '{}'::uuid[];
  v_all_desired uuid[] := '{}'::uuid[];
  v_desired uuid[] := '{}'::uuid[];
  v_added uuid[] := '{}'::uuid[];
  v_removed uuid[] := '{}'::uuid[];
  v_gaining integer := 0;
  v_losing integer := 0;
  v_affected_grants integer := 0;
  v_fingerprint text;
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_property_id is null
     or p_desired_portfolio_ids is null
     or p_expected_access_epoch is null
     or p_expected_access_epoch <= 0
  then
    raise exception 'invalid company structure preview' using errcode = '22023';
  end if;

  select * into v_rights
  from public._staxis_company_structure_actor_rights(
    p_actor_account_id, p_organization_id
  );
  if not found or not coalesce(v_rights.can_manage_portfolios, false) then
    raise exception 'actor cannot manage company portfolios' using errcode = '42501';
  end if;
  if not (p_property_id = any(v_rights.authorized_property_ids)) then
    raise exception 'hotel is outside the actor scope' using errcode = '42501';
  end if;

  select organization.name, epoch.version
    into v_organization_name, v_epoch
  from public.organizations organization
  join public.organization_access_epochs epoch
    on epoch.organization_id = organization.id
  where organization.id = p_organization_id
    and organization.status = 'active'
    and organization.organization_type in ('management_company', 'ownership_group')
  for share of organization, epoch;
  if not found then
    raise exception 'company not found' using errcode = 'P0002';
  end if;
  if v_epoch <> p_expected_access_epoch then
    raise exception 'company access changed; reload before confirming'
      using errcode = '40001';
  end if;

  select relationship.id, coalesce(property.name, 'Hotel')
    into v_relationship_id, v_property_name
  from public.organization_property_relationships relationship
  join public._staxis_current_primary_property_relationships() governing
    on governing.id = relationship.id
   and governing.active_primary_count = 1
  join public.properties property on property.id = relationship.property_id
  where relationship.organization_id = p_organization_id
    and relationship.property_id = p_property_id
  for share of relationship, property;
  if not found then
    raise exception 'active primary owner/operator hotel relationship not found'
      using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct desired order by desired), '{}'::uuid[])
    into v_desired
  from unnest(p_desired_portfolio_ids) desired;
  if cardinality(v_desired) <> cardinality(p_desired_portfolio_ids)
     or cardinality(v_desired) > 500 then
    raise exception 'portfolio ids must be unique and bounded' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(v_desired) desired(portfolio_id)
    where not (desired.portfolio_id = any(v_rights.manageable_portfolio_ids))
       or not exists (
         select 1 from public.portfolios portfolio
         where portfolio.id = desired.portfolio_id
           and portfolio.organization_id = p_organization_id
           and portfolio.status = 'active'
       )
  ) then
    raise exception 'portfolio is outside the actor scope or company'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(assignment.portfolio_id order by assignment.portfolio_id), '{}'::uuid[])
    into v_all_current
  from public.portfolio_properties assignment
  join public.portfolios portfolio
    on portfolio.id = assignment.portfolio_id
   and portfolio.organization_id = assignment.organization_id
   and portfolio.status = 'active'
  where assignment.organization_id = p_organization_id
    and assignment.property_relationship_id = v_relationship_id
    and assignment.property_id = p_property_id
    and assignment.assigned_at <= now()
    and (assignment.removed_at is null or assignment.removed_at > now());

  select coalesce(array_agg(portfolio_id order by portfolio_id), '{}'::uuid[])
    into v_current_managed
  from unnest(v_all_current) portfolio_id
  where portfolio_id = any(v_rights.manageable_portfolio_ids);

  select coalesce(array_agg(portfolio_id order by portfolio_id), '{}'::uuid[])
    into v_unmanaged_current
  from unnest(v_all_current) portfolio_id
  where not (portfolio_id = any(v_rights.manageable_portfolio_ids));

  select coalesce(array_agg(portfolio_id order by portfolio_id), '{}'::uuid[])
    into v_all_desired
  from (
    select portfolio_id from unnest(v_unmanaged_current) portfolio_id
    union
    select portfolio_id from unnest(v_desired) portfolio_id
  ) exact_after;

  select coalesce(array_agg(portfolio_id order by portfolio_id), '{}'::uuid[])
    into v_added
  from unnest(v_desired) portfolio_id
  where not (portfolio_id = any(v_current_managed));

  select coalesce(array_agg(portfolio_id order by portfolio_id), '{}'::uuid[])
    into v_removed
  from unnest(v_current_managed) portfolio_id
  where not (portfolio_id = any(v_desired));

  select count(*)::integer into v_gaining
  from (
    select distinct after_grant.account_id
    from public._staxis_company_structure_portfolio_grants(
      p_organization_id, v_all_desired
    ) after_grant
    where not exists (
      select 1
      from public._staxis_company_structure_portfolio_grants(
        p_organization_id, v_all_current
      ) before_grant
      where before_grant.account_id = after_grant.account_id
    )
  ) gaining;

  select count(*)::integer into v_losing
  from (
    select distinct before_grant.account_id
    from public._staxis_company_structure_portfolio_grants(
      p_organization_id, v_all_current
    ) before_grant
    where not exists (
      select 1
      from public._staxis_company_structure_portfolio_grants(
        p_organization_id, v_all_desired
      ) after_grant
      where after_grant.account_id = before_grant.account_id
    )
  ) losing;

  select count(*)::integer into v_affected_grants
  from (
    (
      select before_grant.grant_id
      from public._staxis_company_structure_portfolio_grants(
        p_organization_id, v_all_current
      ) before_grant
      except
      select after_grant.grant_id
      from public._staxis_company_structure_portfolio_grants(
        p_organization_id, v_all_desired
      ) after_grant
    )
    union
    (
      select after_grant.grant_id
      from public._staxis_company_structure_portfolio_grants(
        p_organization_id, v_all_desired
      ) after_grant
      except
      select before_grant.grant_id
      from public._staxis_company_structure_portfolio_grants(
        p_organization_id, v_all_current
      ) before_grant
    )
  ) affected;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'company-structure-v1',
    'actorAccountId', p_actor_account_id,
    'organizationId', p_organization_id,
    'propertyId', p_property_id,
    'relationshipId', v_relationship_id,
    'expectedAccessEpoch', p_expected_access_epoch,
    'currentPortfolioIds', to_jsonb(v_current_managed),
    'desiredPortfolioIds', to_jsonb(v_desired),
    'allPortfolioIdsAfter', to_jsonb(v_all_desired),
    'gainingAccessCount', v_gaining,
    'losingAccessCount', v_losing,
    'affectedGrantCount', v_affected_grants
  )::text, 'UTF8')), 'hex');

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'organizationName', v_organization_name,
    'propertyId', p_property_id,
    'propertyName', v_property_name,
    'desiredPortfolioIds', to_jsonb(v_desired),
    'expectedAccessEpoch', p_expected_access_epoch,
    'currentPortfolioIds', to_jsonb(v_current_managed),
    'addedPortfolioIds', to_jsonb(v_added),
    'removedPortfolioIds', to_jsonb(v_removed),
    'gainingAccessCount', v_gaining,
    'losingAccessCount', v_losing,
    'affectedGrantCount', v_affected_grants,
    'accessChangesImmediately', true,
    'previewFingerprint', v_fingerprint
  );
end;
$$;

revoke all on function public._staxis_preview_company_portfolio_assignment(
  uuid, uuid, uuid, uuid[], bigint
) from public, anon, authenticated;
grant execute on function public._staxis_preview_company_portfolio_assignment(
  uuid, uuid, uuid, uuid[], bigint
) to service_role;

create or replace function public.staxis_commit_company_portfolio_assignment(
  p_actor_account_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_desired_portfolio_ids uuid[],
  p_expected_access_epoch bigint,
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
  v_cached public.company_structure_mutation_requests%rowtype;
  v_preview jsonb;
  v_request_fingerprint text;
  v_relationship_id uuid;
  v_current_managed uuid[] := '{}'::uuid[];
  v_desired uuid[] := '{}'::uuid[];
  v_now timestamptz := clock_timestamp();
  v_epoch bigint;
  v_changed boolean := false;
  v_response jsonb;
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_property_id is null
     or p_desired_portfolio_ids is null
     or p_expected_access_epoch is null
     or p_expected_access_epoch <= 0
     or p_confirmed is not true
     or p_idempotency_key is null
     or p_preview_fingerprint is null
     or p_preview_fingerprint !~ '^[0-9a-f]{64}$'
  then
    raise exception 'explicit preview confirmation and idempotency key are required'
      using errcode = '22023';
  end if;

  v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'company-structure-v1',
    'actorAccountId', p_actor_account_id,
    'organizationId', p_organization_id,
    'propertyId', p_property_id,
    'desiredPortfolioIds', to_jsonb(p_desired_portfolio_ids),
    'expectedAccessEpoch', p_expected_access_epoch,
    'previewFingerprint', p_preview_fingerprint,
    'confirmed', p_confirmed
  )::text, 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'staxis.company-structure-idempotency:'
      || p_actor_account_id::text || ':' || p_idempotency_key::text, 0
  ));
  select * into v_cached
  from public.company_structure_mutation_requests request_row
  where request_row.actor_account_id = p_actor_account_id
    and request_row.idempotency_key = p_idempotency_key;
  if found then
    if v_cached.request_fingerprint <> v_request_fingerprint then
      raise exception 'idempotency key is already bound to a different request'
        using errcode = '23505';
    end if;
    return jsonb_set(v_cached.response, '{idempotentReplay}', 'true'::jsonb, true);
  end if;

  perform public._staxis_lock_organization(p_organization_id);
  v_preview := public._staxis_preview_company_portfolio_assignment(
    p_actor_account_id,
    p_organization_id,
    p_property_id,
    p_desired_portfolio_ids,
    p_expected_access_epoch
  );
  if v_preview->>'previewFingerprint' <> p_preview_fingerprint then
    raise exception 'structure preview is stale or does not match this change'
      using errcode = '40001';
  end if;

  select relationship.id into v_relationship_id
  from public.organization_property_relationships relationship
  join public._staxis_current_primary_property_relationships() governing
    on governing.id = relationship.id
   and governing.active_primary_count = 1
  where relationship.organization_id = p_organization_id
    and relationship.property_id = p_property_id
  for update of relationship;
  if not found then
    raise exception 'active primary owner/operator hotel relationship not found'
      using errcode = 'P0002';
  end if;

  select coalesce(array_agg(portfolio_id order by portfolio_id), '{}'::uuid[])
    into v_current_managed
  from jsonb_array_elements_text(v_preview->'currentPortfolioIds') value(portfolio_id_text)
  cross join lateral (select value.portfolio_id_text::uuid as portfolio_id) parsed;
  select coalesce(array_agg(portfolio_id order by portfolio_id), '{}'::uuid[])
    into v_desired
  from jsonb_array_elements_text(v_preview->'desiredPortfolioIds') value(portfolio_id_text)
  cross join lateral (select value.portfolio_id_text::uuid as portfolio_id) parsed;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  perform set_config('staxis.request_id', p_idempotency_key::text, true);

  update public.portfolio_properties assignment
     set removed_at = greatest(v_now, assignment.assigned_at + interval '1 microsecond'),
         removed_by_account_id = p_actor_account_id,
         updated_at = v_now
   where assignment.organization_id = p_organization_id
     and assignment.property_relationship_id = v_relationship_id
     and assignment.property_id = p_property_id
     and assignment.portfolio_id = any(v_current_managed)
     and not (assignment.portfolio_id = any(v_desired))
     and assignment.assigned_at <= now()
     and (assignment.removed_at is null or assignment.removed_at > now());
  if found then v_changed := true; end if;

  insert into public.portfolio_properties (
    organization_id, portfolio_id, property_relationship_id, property_id,
    assigned_at, assigned_by_account_id
  )
  select p_organization_id, desired.portfolio_id, v_relationship_id,
         p_property_id, v_now, p_actor_account_id
  from unnest(v_desired) desired(portfolio_id)
  where not exists (
    select 1
    from public.portfolio_properties assignment
    where assignment.organization_id = p_organization_id
      and assignment.portfolio_id = desired.portfolio_id
      and assignment.property_relationship_id = v_relationship_id
      and assignment.property_id = p_property_id
      and assignment.assigned_at <= now()
      and (assignment.removed_at is null or assignment.removed_at > now())
  );
  if found then v_changed := true; end if;

  insert into public.organization_access_events (
    organization_id, actor_account_id, actor_kind, event_type, target_type,
    target_id, request_id, before_state, after_state, metadata
  ) values (
    p_organization_id, p_actor_account_id, 'account',
    'company_structure.portfolio_assignment_commit', 'property',
    p_property_id::text, p_idempotency_key,
    jsonb_build_object('portfolioIds', v_preview->'currentPortfolioIds'),
    jsonb_build_object('portfolioIds', v_preview->'desiredPortfolioIds'),
    jsonb_build_object(
      'previewFingerprint', p_preview_fingerprint,
      'gainingAccessCount', v_preview->'gainingAccessCount',
      'losingAccessCount', v_preview->'losingAccessCount',
      'affectedGrantCount', v_preview->'affectedGrantCount',
      'changed', v_changed
    )
  );

  select epoch.version into v_epoch
  from public.organization_access_epochs epoch
  where epoch.organization_id = p_organization_id;

  v_response := jsonb_build_object(
    'schemaVersion', 'company-structure-v1',
    'organizationId', p_organization_id,
    'propertyId', p_property_id,
    'desiredPortfolioIds', v_preview->'desiredPortfolioIds',
    'accessEpoch', v_epoch,
    'changed', v_changed,
    'idempotentReplay', false,
    'auditRequestId', p_idempotency_key
  );

  insert into public.company_structure_mutation_requests (
    actor_account_id, idempotency_key, request_fingerprint,
    organization_id, property_id, response
  ) values (
    p_actor_account_id, p_idempotency_key, v_request_fingerprint,
    p_organization_id, p_property_id, v_response
  );

  return v_response;
end;
$$;

revoke all on function public.staxis_commit_company_portfolio_assignment(
  uuid, uuid, uuid, uuid[], bigint, text, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.staxis_commit_company_portfolio_assignment(
  uuid, uuid, uuid, uuid[], bigint, text, boolean, uuid
) to service_role;

insert into public.applied_migrations(version, description)
values (
  '0379',
  'Customer-safe company structure projection and preview-bound idempotent portfolio assignment management for the existing My Hotel surface.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
