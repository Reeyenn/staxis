-- 0383_company_access_management.sql
--
-- Existing-person access editing for the existing My Hotel > Access tab.
-- This is deliberately a normalized grant-set workflow, not a second People
-- or Hotels workflow: hats remain managed as memberships, legacy hotel roles
-- remain in hotel settings, and organization/property relationships are never
-- created, ended, claimed, or transferred here.
--
-- The browser receives only a fresh server-authorized edit projection. Preview
-- and commit both re-resolve the actor, target membership, every existing
-- grant, current governing topology, access epoch, and membership revision.
-- Replace and add are atomic; commit is preview-bound, explicitly confirmed,
-- idempotent, audited, and invalidates authority immediately through the
-- existing grant authorization-refresh and organization epoch triggers.

begin;

do $$
begin
  if to_regclass('public.account_authorization_state') is null
     or to_regclass('public.organization_access_epochs') is null
     or to_regclass('public.organization_access_events') is null
     or to_regprocedure('public._staxis_nonlegacy_property_authorizations(uuid)') is null
  then
    raise exception '0383 requires authoritative organization access migration 0378';
  end if;
end
$$;

-- @rls: service-role-only — exact idempotency fingerprints and responses are
-- reachable only through the confirmed SECURITY DEFINER commit RPC.
create table if not exists public.company_access_mutation_requests (
  id                   uuid primary key default gen_random_uuid(),
  actor_account_id     uuid not null references public.accounts(id) on delete restrict,
  idempotency_key      uuid not null,
  request_fingerprint  text not null,
  organization_id      uuid not null references public.organizations(id) on delete restrict,
  membership_id        uuid not null,
  response             jsonb not null,
  created_at           timestamptz not null default now(),

  constraint company_access_mutation_requests_actor_key
    unique (actor_account_id, idempotency_key),
  constraint company_access_mutation_requests_membership_scope_fkey
    foreign key (membership_id, organization_id)
    references public.organization_memberships(id, organization_id) on delete restrict,
  constraint company_access_mutation_requests_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint company_access_mutation_requests_response_check
    check (jsonb_typeof(response) = 'object')
);

comment on table public.company_access_mutation_requests is
  'Service-only exact responses for idempotent normalized membership access edits.';

create index if not exists company_access_mutation_requests_created_idx
  on public.company_access_mutation_requests (created_at desc);

alter table public.company_access_mutation_requests enable row level security;
revoke all on public.company_access_mutation_requests
  from public, anon, authenticated, service_role;

-- Revision includes the membership lifecycle and every status=active grant,
-- including scheduled/expired rows and legacy rows. A hidden future grant or
-- a legacy bridge therefore cannot survive a stale replace confirmation.
create or replace function public._staxis_company_access_membership_revision(
  p_membership_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'company-access-editor-v1',
    'membership', jsonb_build_object(
      'id', membership.id,
      'organizationId', membership.organization_id,
      'accountId', membership.account_id,
      'status', membership.status,
      'startsAt', membership.starts_at,
      'endedAt', membership.ended_at,
      'staxisRole', membership.staxis_role,
      'updatedAt', membership.updated_at
    ),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', grant_row.id,
        'profile', grant_row.access_profile,
        'scope', grant_row.scope_type,
        'portfolioId', grant_row.portfolio_id,
        'relationshipId', grant_row.property_relationship_id,
        'propertyId', grant_row.property_id,
        'startsAt', grant_row.starts_at,
        'expiresAt', grant_row.expires_at,
        'status', grant_row.status,
        'source', grant_row.source,
        'version', grant_row.version,
        'updatedAt', grant_row.updated_at
      ) order by grant_row.id)
      from public.organization_access_grants grant_row
      where grant_row.membership_id = membership.id
        and grant_row.status = 'active'
    ), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
  from public.organization_memberships membership
  where membership.id = p_membership_id;
$$;

revoke all on function public._staxis_company_access_membership_revision(uuid)
  from public, anon, authenticated, service_role;

-- One fresh delegation predicate shared by projection, preview, and commit.
-- It deliberately excludes platform admins, finance hats, GM/property-manager
-- authority, legacy rows, inactive accounts, and non-governing relationships.
-- A portfolio manager can delegate only lower profiles within that portfolio.
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
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_access_profile not in (
       'organization_owner', 'organization_admin', 'portfolio_manager',
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     )
     or p_scope_type not in ('organization', 'portfolio', 'property')
  then
    return false;
  end if;

  if (p_access_profile in ('organization_owner', 'organization_admin')
      and p_scope_type <> 'organization')
     or (p_access_profile = 'portfolio_manager' and p_scope_type <> 'portfolio')
     or (p_access_profile = 'property_manager' and p_scope_type <> 'property')
  then
    return false;
  end if;

  if not exists (
    select 1
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
  ) or not exists (
    select 1
    from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
    where authz.organization_id = p_organization_id
  ) then
    return false;
  end if;

  if p_scope_type = 'organization' then
    if p_portfolio_id is not null or p_property_id is not null then return false; end if;
  elsif p_scope_type = 'portfolio' then
    if p_portfolio_id is null or p_property_id is not null or not exists (
      select 1 from public.portfolios portfolio
      where portfolio.id = p_portfolio_id
        and portfolio.organization_id = p_organization_id
        and portfolio.status = 'active'
    ) then return false; end if;
  else
    if p_property_id is null or p_portfolio_id is not null or not exists (
      select 1
      from public._staxis_current_primary_property_relationships() relationship
      join public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
        on authz.organization_id = relationship.organization_id
       and authz.property_id = relationship.property_id
      where relationship.organization_id = p_organization_id
        and relationship.property_id = p_property_id
        and relationship.active_primary_count = 1
    ) then return false; end if;
  end if;

  -- Company owner: any valid normalized profile/scope in this company.
  if exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.account_id = p_actor_account_id
      and membership.status = 'active'
      and membership.starts_at <= now()
      and membership.ended_at is null
      and membership.membership_scope = 'company'
      and membership.staxis_role = 'owner'
  ) then
    return true;
  end if;

  -- Company VP has manage_access but cannot mint an owner/admin/peer portfolio
  -- authority. Finance and all property hats intentionally have no branch.
  if p_access_profile in (
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     ) and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.account_id = p_actor_account_id
      and membership.status = 'active'
      and membership.starts_at <= now()
      and membership.ended_at is null
      and membership.membership_scope = 'company'
      and membership.staxis_role = 'vp'
  ) then
    return true;
  end if;

  -- Normalized organization owner/admin grants follow the canonical
  -- DELEGATABLE_PROFILES hierarchy.
  if exists (
    select 1
    from public.organization_access_grants actor_grant
    join public.organization_memberships actor_membership
      on actor_membership.id = actor_grant.membership_id
     and actor_membership.organization_id = actor_grant.organization_id
    where actor_membership.account_id = p_actor_account_id
      and actor_membership.organization_id = p_organization_id
      and actor_membership.status = 'active'
      and actor_membership.starts_at <= now()
      and actor_membership.ended_at is null
      and actor_grant.status = 'active'
      and actor_grant.source <> 'legacy_backfill'
      and actor_grant.starts_at <= now()
      and (actor_grant.expires_at is null or actor_grant.expires_at > now())
      and actor_grant.scope_type = 'organization'
      and (
        actor_grant.access_profile = 'organization_owner'
        or (
          actor_grant.access_profile = 'organization_admin'
          and p_access_profile not in ('organization_owner', 'organization_admin')
        )
      )
  ) then
    return true;
  end if;

  -- A normalized portfolio manager can delegate only lower access inside the
  -- exact portfolio they hold. Property-manager holders are excluded from
  -- this company-level editor even though hotel-specific team tooling remains.
  if p_access_profile in (
       'property_manager', 'department_lead', 'contributor', 'viewer',
       'external_collaborator'
     ) and exists (
    select 1
    from public.organization_access_grants actor_grant
    join public.organization_memberships actor_membership
      on actor_membership.id = actor_grant.membership_id
     and actor_membership.organization_id = actor_grant.organization_id
    join public.portfolios held_portfolio
      on held_portfolio.id = actor_grant.portfolio_id
     and held_portfolio.organization_id = actor_grant.organization_id
     and held_portfolio.status = 'active'
    where actor_membership.account_id = p_actor_account_id
      and actor_membership.organization_id = p_organization_id
      and actor_membership.status = 'active'
      and actor_membership.starts_at <= now()
      and actor_membership.ended_at is null
      and actor_grant.status = 'active'
      and actor_grant.source <> 'legacy_backfill'
      and actor_grant.starts_at <= now()
      and (actor_grant.expires_at is null or actor_grant.expires_at > now())
      and actor_grant.access_profile = 'portfolio_manager'
      and actor_grant.scope_type = 'portfolio'
      and (
        (p_scope_type = 'portfolio' and p_portfolio_id = actor_grant.portfolio_id)
        or (
          p_scope_type = 'property'
          and exists (
            select 1
            from public.portfolio_properties assignment
            join public._staxis_current_primary_property_relationships() relationship
              on relationship.id = assignment.property_relationship_id
             and relationship.organization_id = assignment.organization_id
             and relationship.property_id = assignment.property_id
            where assignment.organization_id = p_organization_id
              and assignment.portfolio_id = actor_grant.portfolio_id
              and assignment.property_id = p_property_id
              and assignment.assigned_at <= now()
              and (assignment.removed_at is null or assignment.removed_at > now())
              and relationship.active_primary_count = 1
          )
        )
      )
  ) then
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public._staxis_company_access_can_delegate(
  uuid, uuid, text, text, uuid, uuid
) from public, anon, authenticated, service_role;

-- Expand one requested/granted scope into current governed hotels. This is
-- used for impact only; authorization is always checked separately above.
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
  select coalesce(array_agg(candidate.property_id order by candidate.property_id), '{}'::uuid[])
  from (
    select distinct relationship.property_id
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.organization_id = p_organization_id
      and relationship.active_primary_count = 1
      and (
        p_scope_type = 'organization'
        or (p_scope_type = 'property' and relationship.property_id = p_property_id)
        or (
          p_scope_type = 'portfolio'
          and exists (
            select 1 from public.portfolio_properties assignment
            where assignment.organization_id = relationship.organization_id
              and assignment.property_relationship_id = relationship.id
              and assignment.property_id = relationship.property_id
              and assignment.portfolio_id = p_portfolio_id
              and assignment.assigned_at <= now()
              and (assignment.removed_at is null or assignment.removed_at > now())
          )
        )
      )
  ) candidate;
$$;

revoke all on function public._staxis_company_access_scope_properties(
  uuid, text, uuid, uuid
) from public, anon, authenticated, service_role;

-- Server-only editor catalog. It never emits account ids, foreign topology,
-- hat memberships, platform admins, or self-edit targets. The profile policy
-- arrays are the exact current targets accepted by the same predicate used at
-- preview/commit; clients may render them but cannot widen them.
create or replace function public.staxis_company_access_editor_projection(
  p_actor_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with
  profile_values(access_profile, sort_order) as (
    values
      ('organization_owner'::text, 1),
      ('organization_admin'::text, 2),
      ('portfolio_manager'::text, 3),
      ('property_manager'::text, 4),
      ('department_lead'::text, 5),
      ('contributor'::text, 6),
      ('viewer'::text, 7),
      ('external_collaborator'::text, 8)
  ),
  candidate_organizations as (
    select distinct authz.organization_id
    from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
    join public.accounts actor
      on actor.id = authz.account_id
     and actor.active is true
     and actor.role <> 'admin'
    join public.account_authorization_state state
      on state.account_id = actor.id
     and state.authority_mode = 'normalized'
    join public.organizations organization
      on organization.id = authz.organization_id
     and organization.status = 'active'
     and organization.organization_type in ('management_company', 'ownership_group')
  ),
  editable_organizations as (
    select organization.id, organization.name, epoch.version
    from candidate_organizations candidate
    join public.organizations organization on organization.id = candidate.organization_id
    join public.organization_access_epochs epoch on epoch.organization_id = organization.id
    where exists (
      select 1 from profile_values profile
      where public._staxis_company_access_can_delegate(
              p_actor_account_id, organization.id, profile.access_profile,
              'organization', null, null
            )
         or exists (
              select 1 from public.portfolios portfolio
              where portfolio.organization_id = organization.id
                and portfolio.status = 'active'
                and public._staxis_company_access_can_delegate(
                  p_actor_account_id, organization.id, profile.access_profile,
                  'portfolio', portfolio.id, null
                )
            )
         or exists (
              select 1
              from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
              where authz.organization_id = organization.id
                and public._staxis_company_access_can_delegate(
                  p_actor_account_id, organization.id, profile.access_profile,
                  'property', null, authz.property_id
                )
            )
    )
  ),
  serialized as (
    select editable.id,
      jsonb_build_object(
        'id', editable.id,
        'name', editable.name,
        'accessEpoch', editable.version,
        'profilePolicies', coalesce((
          select jsonb_agg(jsonb_build_object(
            'accessProfile', profile.access_profile,
            'organizationScope', public._staxis_company_access_can_delegate(
              p_actor_account_id, editable.id, profile.access_profile,
              'organization', null, null
            ),
            'portfolioIds', coalesce((
              select jsonb_agg(portfolio.id order by portfolio.id)
              from public.portfolios portfolio
              where portfolio.organization_id = editable.id
                and portfolio.status = 'active'
                and public._staxis_company_access_can_delegate(
                  p_actor_account_id, editable.id, profile.access_profile,
                  'portfolio', portfolio.id, null
                )
            ), '[]'::jsonb),
            'propertyIds', coalesce((
              select jsonb_agg(property_id order by property_id)
              from (
                select distinct authz.property_id
                from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
                where authz.organization_id = editable.id
                  and public._staxis_company_access_can_delegate(
                    p_actor_account_id, editable.id, profile.access_profile,
                    'property', null, authz.property_id
                  )
              ) property_scope
            ), '[]'::jsonb)
          ) order by profile.sort_order)
          from profile_values profile
          where public._staxis_company_access_can_delegate(
                  p_actor_account_id, editable.id, profile.access_profile,
                  'organization', null, null
                )
             or exists (
                  select 1 from public.portfolios portfolio
                  where portfolio.organization_id = editable.id
                    and portfolio.status = 'active'
                    and public._staxis_company_access_can_delegate(
                      p_actor_account_id, editable.id, profile.access_profile,
                      'portfolio', portfolio.id, null
                    )
                )
             or exists (
                  select 1
                  from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
                  where authz.organization_id = editable.id
                    and public._staxis_company_access_can_delegate(
                      p_actor_account_id, editable.id, profile.access_profile,
                      'property', null, authz.property_id
                    )
                )
        ), '[]'::jsonb),
        'properties', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', property.id,
            'name', coalesce(property.name, 'Hotel')
          ) order by coalesce(property.name, 'Hotel'), property.id)
          from public.properties property
          join public._staxis_current_primary_property_relationships() relationship
            on relationship.property_id = property.id
           and relationship.organization_id = editable.id
           and relationship.active_primary_count = 1
          where exists (
            select 1
            from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
            where authz.organization_id = editable.id
              and authz.property_id = property.id
          )
            and exists (
              select 1 from profile_values profile
              where public._staxis_company_access_can_delegate(
                p_actor_account_id, editable.id, profile.access_profile,
                'property', null, property.id
              )
            )
        ), '[]'::jsonb),
        'portfolios', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', portfolio.id,
            'name', portfolio.name,
            'type', portfolio.portfolio_type,
            'propertyIds', coalesce((
              select jsonb_agg(assignment.property_id order by assignment.property_id)
              from public.portfolio_properties assignment
              join public._staxis_current_primary_property_relationships() relationship
                on relationship.id = assignment.property_relationship_id
               and relationship.organization_id = assignment.organization_id
               and relationship.property_id = assignment.property_id
               and relationship.active_primary_count = 1
              where assignment.organization_id = editable.id
                and assignment.portfolio_id = portfolio.id
                and assignment.assigned_at <= now()
                and (assignment.removed_at is null or assignment.removed_at > now())
                and exists (
                  select 1
                  from public._staxis_nonlegacy_property_authorizations(p_actor_account_id) authz
                  where authz.organization_id = editable.id
                    and authz.property_id = assignment.property_id
                )
            ), '[]'::jsonb)
          ) order by portfolio.name, portfolio.id)
          from public.portfolios portfolio
          where portfolio.organization_id = editable.id
            and portfolio.status = 'active'
            and exists (
              select 1 from profile_values profile
              where public._staxis_company_access_can_delegate(
                p_actor_account_id, editable.id, profile.access_profile,
                'portfolio', portfolio.id, null
              )
            )
        ), '[]'::jsonb),
        'memberships', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', membership.id,
            'accessRevision', public._staxis_company_access_membership_revision(membership.id),
            'canAdd',
              not exists (
                select 1 from public.organization_access_grants legacy_grant
                where legacy_grant.membership_id = membership.id
                  and legacy_grant.status = 'active'
                  and legacy_grant.source = 'legacy_backfill'
              )
              and not exists (
                select 1 from public.organization_access_grants current_grant
                where current_grant.membership_id = membership.id
                  and current_grant.status = 'active'
                  and current_grant.source <> 'legacy_backfill'
                  and not public._staxis_company_access_can_delegate(
                    p_actor_account_id, editable.id, current_grant.access_profile,
                    current_grant.scope_type, current_grant.portfolio_id,
                    current_grant.property_id
                  )
              ),
            'canReplace',
              exists (
                select 1 from public.organization_access_grants current_grant
                where current_grant.membership_id = membership.id
                  and current_grant.status = 'active'
                  and current_grant.source <> 'legacy_backfill'
              )
              and not exists (
                select 1 from public.organization_access_grants legacy_grant
                where legacy_grant.membership_id = membership.id
                  and legacy_grant.status = 'active'
                  and legacy_grant.source = 'legacy_backfill'
              )
              and not exists (
                select 1 from public.organization_access_grants current_grant
                where current_grant.membership_id = membership.id
                  and current_grant.status = 'active'
                  and current_grant.source <> 'legacy_backfill'
                  and not public._staxis_company_access_can_delegate(
                    p_actor_account_id, editable.id, current_grant.access_profile,
                    current_grant.scope_type, current_grant.portfolio_id,
                    current_grant.property_id
                  )
              ),
            'blockedReason', case
              when exists (
                select 1 from public.organization_access_grants legacy_grant
                where legacy_grant.membership_id = membership.id
                  and legacy_grant.status = 'active'
                  and legacy_grant.source = 'legacy_backfill'
              ) then 'legacy_access'
              when exists (
                select 1 from public.organization_access_grants current_grant
                where current_grant.membership_id = membership.id
                  and current_grant.status = 'active'
                  and current_grant.source <> 'legacy_backfill'
                  and not public._staxis_company_access_can_delegate(
                    p_actor_account_id, editable.id, current_grant.access_profile,
                    current_grant.scope_type, current_grant.portfolio_id,
                    current_grant.property_id
                  )
              ) then 'existing_access_outside_scope'
              else null
            end,
            'currentGrants', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', grant_row.id,
                'accessProfile', grant_row.access_profile,
                'scopeType', grant_row.scope_type,
                'portfolioId', grant_row.portfolio_id,
                'propertyId', grant_row.property_id,
                'startsAt', grant_row.starts_at,
                'expiresAt', grant_row.expires_at
              ) order by grant_row.access_profile, grant_row.scope_type,
                         grant_row.portfolio_id, grant_row.property_id, grant_row.id)
              from public.organization_access_grants grant_row
              where grant_row.membership_id = membership.id
                and grant_row.status = 'active'
                and grant_row.source <> 'legacy_backfill'
            ), '[]'::jsonb)
          ) order by target_account.display_name, membership.id)
          from public.organization_memberships membership
          join public.accounts target_account
            on target_account.id = membership.account_id
           and target_account.active is true
           and target_account.role <> 'admin'
          where membership.organization_id = editable.id
            and membership.account_id <> p_actor_account_id
            and membership.status = 'active'
            and membership.starts_at <= now()
            and membership.ended_at is null
            and membership.staxis_role is null
        ), '[]'::jsonb)
      ) as value
    from editable_organizations editable
  )
  select jsonb_build_object(
    'schemaVersion', 'company-access-editor-v1',
    'generatedAt', clock_timestamp(),
    'organizations', coalesce(jsonb_agg(serialized.value order by serialized.id), '[]'::jsonb)
  )
  from serialized;
$$;

revoke all on function public.staxis_company_access_editor_projection(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_company_access_editor_projection(uuid)
  to service_role;

-- Shared impact preview. Commit calls this again while holding the same
-- organization lock, so no browser-computed policy, count, or target survives
-- to the write path.
create or replace function public._staxis_preview_company_access_edit(
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
  v_current_grant_count integer := 0;
  v_retained_grant_count integer := 0;
  v_revoked_grant_count integer := 0;
  v_upserted_grant_count integer := 0;
  v_fingerprint text;
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_membership_id is null
     or p_operation not in ('replace', 'add')
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
    raise exception 'invalid company access preview' using errcode = '22023';
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
     or (p_access_profile = 'property_manager' and p_scope_kind <> 'selected_properties')
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
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'access expiration must be in the future' using errcode = '22023';
  end if;

  select organization.name, epoch.version, target_account.display_name
    into v_organization_name, v_epoch, v_member_name
  from public.organization_memberships membership
  join public.organizations organization
    on organization.id = membership.organization_id
   and organization.status = 'active'
   and organization.organization_type in ('management_company', 'ownership_group')
  join public.organization_access_epochs epoch
    on epoch.organization_id = organization.id
  join public.accounts target_account
    on target_account.id = membership.account_id
   and target_account.active is true
   and target_account.role <> 'admin'
  where membership.id = p_membership_id
    and membership.organization_id = p_organization_id
    and membership.account_id <> p_actor_account_id
    and membership.status = 'active'
    and membership.starts_at <= now()
    and membership.ended_at is null
    and membership.staxis_role is null
  for share of organization, epoch, membership, target_account;
  if not found then
    raise exception 'editable active membership not found' using errcode = 'P0002';
  end if;
  if v_epoch <> p_expected_access_epoch then
    raise exception 'company access changed; reload before confirming'
      using errcode = '40001';
  end if;

  v_revision := public._staxis_company_access_membership_revision(p_membership_id);
  if v_revision is distinct from p_expected_access_revision then
    raise exception 'membership access changed; reload before confirming'
      using errcode = '40001';
  end if;

  if exists (
    select 1 from public.organization_access_grants legacy_grant
    where legacy_grant.membership_id = p_membership_id
      and legacy_grant.status = 'active'
      and legacy_grant.source = 'legacy_backfill'
  ) then
    raise exception 'legacy hotel access must be managed in hotel settings'
      using errcode = '42501';
  end if;

  -- Re-authorize every grant that an atomic replace would retain or revoke.
  -- Add also performs this check so it cannot hide a higher/out-of-scope grant
  -- behind a new lower grant in the same membership.
  if exists (
    select 1 from public.organization_access_grants current_grant
    where current_grant.membership_id = p_membership_id
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

  select count(*)::integer into v_current_grant_count
  from public.organization_access_grants current_grant
  where current_grant.membership_id = p_membership_id
    and current_grant.status = 'active'
    and current_grant.source <> 'legacy_backfill';

  if p_operation = 'add' then
    v_retained_grant_count := v_current_grant_count;
    v_revoked_grant_count := 0;
  else
    select count(*)::integer into v_retained_grant_count
    from public.organization_access_grants current_grant
    where current_grant.membership_id = p_membership_id
      and current_grant.status = 'active'
      and current_grant.source <> 'legacy_backfill'
      and current_grant.access_profile = p_access_profile
      and (
        (p_scope_kind = 'organization'
          and current_grant.scope_type = 'organization')
        or (p_scope_kind = 'portfolio'
          and current_grant.scope_type = 'portfolio'
          and current_grant.portfolio_id = p_portfolio_id)
        or (p_scope_kind = 'selected_properties'
          and current_grant.scope_type = 'property'
          and current_grant.property_id = any(v_property_ids))
      );
    v_revoked_grant_count := v_current_grant_count - v_retained_grant_count;
  end if;

  -- Match the existing final-owner trigger during preview so the user sees a
  -- deterministic conflict before explicit confirmation.
  if p_operation = 'replace'
     and not (p_access_profile = 'organization_owner'
              and p_scope_kind = 'organization')
     and exists (
       select 1 from public.organization_access_grants owner_grant
       where owner_grant.membership_id = p_membership_id
         and owner_grant.organization_id = p_organization_id
         and owner_grant.access_profile = 'organization_owner'
         and owner_grant.scope_type = 'organization'
         and owner_grant.status = 'active'
         and owner_grant.starts_at <= now()
         and owner_grant.expires_at is null
     )
     and not exists (
       select 1
       from public.organization_access_grants other_owner
       join public.organization_memberships other_membership
         on other_membership.id = other_owner.membership_id
        and other_membership.organization_id = other_owner.organization_id
       join public.accounts other_account
         on other_account.id = other_membership.account_id
        and other_account.active is true
       where other_owner.organization_id = p_organization_id
         and other_owner.membership_id <> p_membership_id
         and other_owner.access_profile = 'organization_owner'
         and other_owner.scope_type = 'organization'
         and other_owner.status = 'active'
         and other_owner.starts_at <= now()
         and other_owner.expires_at is null
         and other_membership.status = 'active'
         and other_membership.starts_at <= now()
         and other_membership.ended_at is null
     )
  then
    raise exception 'cannot remove the final active organization owner'
      using errcode = '23514';
  end if;

  select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
    into v_before_property_ids
  from (
    select unnest(public._staxis_company_access_scope_properties(
      current_grant.organization_id,
      current_grant.scope_type,
      current_grant.portfolio_id,
      current_grant.property_id
    )) as property_id
    from public.organization_access_grants current_grant
    where current_grant.membership_id = p_membership_id
      and current_grant.status = 'active'
      and current_grant.source <> 'legacy_backfill'
      and current_grant.starts_at <= now()
      and (current_grant.expires_at is null or current_grant.expires_at > now())
  ) effective_before;

  if p_operation = 'add' then
    select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
      into v_after_property_ids
    from (
      select property_id from unnest(v_before_property_ids) property_id
      union
      select property_id from unnest(v_desired_property_ids) property_id
    ) combined;
  else
    v_after_property_ids := v_desired_property_ids;
  end if;

  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
    into v_gaining_property_ids
  from unnest(v_after_property_ids) property_id
  where not (property_id = any(v_before_property_ids));

  select coalesce(array_agg(property_id order by property_id), '{}'::uuid[])
    into v_losing_property_ids
  from unnest(v_before_property_ids) property_id
  where not (property_id = any(v_after_property_ids));

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'company-access-editor-v1',
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
    'previewFingerprint', v_fingerprint
  );
end;
$$;

revoke all on function public._staxis_preview_company_access_edit(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz, bigint, text
) from public, anon, authenticated;
grant execute on function public._staxis_preview_company_access_edit(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz, bigint, text
) to service_role;

create or replace function public.staxis_commit_company_access_edit(
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
  v_property_id uuid;
  v_relationship_id uuid;
  v_grant_id uuid;
  v_rows integer := 0;
  v_changed boolean := false;
  -- Entitlement projection/authorization refresh uses transaction-stable
  -- `now()`. An immediately effective grant must use the same clock or the
  -- refresh trigger can hash an empty scope until an unrelated later write.
  v_now timestamptz := now();
  v_epoch bigint;
  v_revision text;
  v_response jsonb;
begin
  if p_actor_account_id is null
     or p_organization_id is null
     or p_membership_id is null
     or p_operation not in ('replace', 'add')
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
    raise exception 'explicit preview confirmation and idempotency key are required'
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
    'schemaVersion', 'company-access-editor-v1',
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
    if v_cached.request_fingerprint <> v_request_fingerprint then
      raise exception 'idempotency key is already bound to a different request'
        using errcode = '23505';
    end if;

    -- A retry is read-only, but revoked managers must not keep receiving an
    -- authorization-bound response through an open/stale browser session.
    if not exists (
      select 1
      from public.organization_memberships membership
      join public.accounts target_account
        on target_account.id = membership.account_id
       and target_account.active is true
       and target_account.role <> 'admin'
      where membership.id = p_membership_id
        and membership.organization_id = p_organization_id
        and membership.account_id <> p_actor_account_id
        and membership.status = 'active'
        and membership.starts_at <= now()
        and membership.ended_at is null
        and membership.staxis_role is null
    ) then
      raise exception 'editable active membership not found' using errcode = 'P0002';
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
  v_preview := public._staxis_preview_company_access_edit(
    p_actor_account_id,
    p_organization_id,
    p_membership_id,
    p_operation,
    p_access_profile,
    p_scope_kind,
    p_portfolio_id,
    v_property_ids,
    p_expires_at,
    p_expected_access_epoch,
    p_expected_access_revision
  );
  if v_preview->>'previewFingerprint' <> p_preview_fingerprint then
    raise exception 'access preview is stale or does not match this change'
      using errcode = '40001';
  end if;

  perform 1
  from public.organization_memberships membership
  where membership.id = p_membership_id
    and membership.organization_id = p_organization_id
  for update;
  perform 1
  from public.organization_access_grants grant_row
  where grant_row.membership_id = p_membership_id
    and grant_row.status = 'active'
  for update;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  perform set_config('staxis.request_id', p_idempotency_key::text, true);

  if p_operation = 'replace' then
    update public.organization_access_grants current_grant
       set status = 'revoked',
           revoked_at = v_now,
           revoked_by_account_id = p_actor_account_id,
           revocation_reason = 'Atomic company access replacement',
           version = current_grant.version + 1
     where current_grant.membership_id = p_membership_id
       and current_grant.organization_id = p_organization_id
       and current_grant.status = 'active'
       and current_grant.source <> 'legacy_backfill'
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
       );
    get diagnostics v_rows = row_count;
    if v_rows > 0 then v_changed := true; end if;
  end if;

  if p_scope_kind = 'organization' then
    select grant_row.id into v_grant_id
    from public.organization_access_grants grant_row
    where grant_row.membership_id = p_membership_id
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
        p_organization_id, p_membership_id, p_access_profile, 'organization',
        v_now, p_expires_at, 'manual', p_actor_account_id
      );
      v_changed := true;
    else
      update public.organization_access_grants grant_row
         set starts_at = case when grant_row.starts_at > now() then v_now else grant_row.starts_at end,
             expires_at = p_expires_at,
             source = 'manual',
             granted_by_account_id = p_actor_account_id,
             version = grant_row.version + 1
       where grant_row.id = v_grant_id
         and (
           grant_row.starts_at > now()
           or grant_row.expires_at is distinct from p_expires_at
           or grant_row.source is distinct from 'manual'
           or grant_row.granted_by_account_id is distinct from p_actor_account_id
         );
      get diagnostics v_rows = row_count;
      if v_rows > 0 then v_changed := true; end if;
    end if;
  elsif p_scope_kind = 'portfolio' then
    select grant_row.id into v_grant_id
    from public.organization_access_grants grant_row
    where grant_row.membership_id = p_membership_id
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
        p_organization_id, p_membership_id, p_access_profile, 'portfolio',
        p_portfolio_id, v_now, p_expires_at, 'manual', p_actor_account_id
      );
      v_changed := true;
    else
      update public.organization_access_grants grant_row
         set starts_at = case when grant_row.starts_at > now() then v_now else grant_row.starts_at end,
             expires_at = p_expires_at,
             source = 'manual',
             granted_by_account_id = p_actor_account_id,
             version = grant_row.version + 1
       where grant_row.id = v_grant_id
         and (
           grant_row.starts_at > now()
           or grant_row.expires_at is distinct from p_expires_at
           or grant_row.source is distinct from 'manual'
           or grant_row.granted_by_account_id is distinct from p_actor_account_id
         );
      get diagnostics v_rows = row_count;
      if v_rows > 0 then v_changed := true; end if;
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
      where grant_row.membership_id = p_membership_id
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
          p_organization_id, p_membership_id, p_access_profile, 'property',
          v_relationship_id, v_property_id, v_now, p_expires_at,
          'manual', p_actor_account_id
        );
        v_changed := true;
      else
        update public.organization_access_grants grant_row
           set property_relationship_id = v_relationship_id,
               starts_at = case when grant_row.starts_at > now() then v_now else grant_row.starts_at end,
               expires_at = p_expires_at,
               source = 'manual',
               granted_by_account_id = p_actor_account_id,
               version = grant_row.version + 1
         where grant_row.id = v_grant_id
           and (
             grant_row.property_relationship_id is distinct from v_relationship_id
             or grant_row.starts_at > now()
             or grant_row.expires_at is distinct from p_expires_at
             or grant_row.source is distinct from 'manual'
             or grant_row.granted_by_account_id is distinct from p_actor_account_id
           );
        get diagnostics v_rows = row_count;
        if v_rows > 0 then v_changed := true; end if;
      end if;
    end loop;
  end if;

  v_revision := public._staxis_company_access_membership_revision(p_membership_id);
  select epoch.version into v_epoch
  from public.organization_access_epochs epoch
  where epoch.organization_id = p_organization_id;

  insert into public.organization_access_events (
    organization_id, actor_account_id, actor_kind, event_type, target_type,
    target_id, request_id, before_state, after_state, metadata
  ) values (
    p_organization_id, p_actor_account_id, 'account',
    'company_access.membership_grant_set_commit', 'organization_membership',
    p_membership_id::text, p_idempotency_key,
    jsonb_build_object(
      'accessRevision', p_expected_access_revision,
      'effectivePropertyIds', v_preview->'beforePropertyIds',
      'grantCount', v_preview->'currentGrantCount'
    ),
    jsonb_build_object(
      'accessRevision', v_revision,
      'effectivePropertyIds', v_preview->'afterPropertyIds',
      'accessProfile', p_access_profile,
      'scopeKind', p_scope_kind,
      'portfolioId', p_portfolio_id,
      'propertyIds', to_jsonb(v_property_ids),
      'expiresAt', p_expires_at
    ),
    jsonb_build_object(
      'operation', p_operation,
      'previewFingerprint', p_preview_fingerprint,
      'retainedGrantCount', v_preview->'retainedGrantCount',
      'revokedGrantCount', v_preview->'revokedGrantCount',
      'upsertedGrantCount', v_preview->'upsertedGrantCount',
      'changed', v_changed,
      'accessChangesImmediately', true
    )
  );

  v_response := jsonb_build_object(
    'schemaVersion', 'company-access-editor-v1',
    'organizationId', p_organization_id,
    'membershipId', p_membership_id,
    'accessEpoch', v_epoch,
    'accessRevision', v_revision,
    'changed', v_changed,
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

revoke all on function public.staxis_commit_company_access_edit(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz,
  bigint, text, text, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.staxis_commit_company_access_edit(
  uuid, uuid, uuid, text, text, text, uuid, uuid[], timestamptz,
  bigint, text, text, boolean, uuid
) to service_role;

insert into public.applied_migrations(version, description)
values (
  '0383',
  'Fail-closed existing-person normalized access editor with exact company, portfolio/region, or selected-hotel scopes; preview, confirmation, idempotency, audit, and immediate authority invalidation.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
