-- 0418_authoritative_access_cutover_preflight.sql
--
-- Stage A records a durable, fail-closed inventory of legacy hotel rows. It
-- does not change authority, clear arrays, revoke projections, or reject the
-- existing application. Later Stage A work copies only rows whose account,
-- identity, property, and current governing topology are provable.

begin;

do $$
begin
  if to_regclass('public.account_authorization_state') is null
     or to_regclass('public.account_property_authorization_bridges') is null
     or to_regprocedure('public._staxis_current_primary_property_relationships()') is null
  then
    raise exception '0418 requires authoritative access migration 0378';
  end if;
end
$$;

create table if not exists public.account_access_cutover_preflight_runs (
  id              uuid primary key default gen_random_uuid(),
  status          text not null check (status in ('running', 'passed', 'failed')),
  issue_count     integer not null default 0 check (issue_count >= 0),
  started_at      timestamptz not null default clock_timestamp(),
  completed_at    timestamptz,
  created_by      text not null default '0418',
  details         jsonb not null default '{}'::jsonb
);

-- @rls: service-role-only — preflight anomalies contain cross-tenant access IDs and are reviewed only by migration/incident tooling.
create table if not exists public.account_access_cutover_preflight_issues (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.account_access_cutover_preflight_runs(id) on delete cascade,
  account_id      uuid references public.accounts(id) on delete cascade,
  -- Deliberately no FK: a legacy array may contain an orphan property UUID,
  -- and the preflight must durably preserve/report that exact UUID instead of
  -- failing while trying to record the property_missing anomaly.
  property_id     uuid,
  issue_code      text not null,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default clock_timestamp()
);

alter table public.account_access_cutover_preflight_runs enable row level security;
alter table public.account_access_cutover_preflight_issues enable row level security;
revoke all on public.account_access_cutover_preflight_runs from public, anon, authenticated, service_role;
revoke all on public.account_access_cutover_preflight_issues from public, anon, authenticated, service_role;

comment on table public.account_access_cutover_preflight_runs is
  'Stage A service-only evidence for additive account authorization translation. A failed row is retained for review; legacy authority remains active until a later approved stage.';
comment on table public.account_access_cutover_preflight_issues is
  'Stage A anomalies. Unresolved, ambiguous, inactive, unlinked, or cross-company legacy rows are never guessed into a canonical bridge.';

-- One definition of a real company context is shared by preflight, backfill,
-- and the invariant report. The single-hotel compatibility organization is
-- deliberately excluded; legacy hotel scope is allowed to remain governed by
-- that independent topology during Stage A.
create or replace function public._staxis_cutover_real_account_organizations()
returns table (account_id uuid, organization_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct membership.account_id, membership.organization_id
  from public.organization_memberships membership
  join public.organizations organization
    on organization.id = membership.organization_id
   and organization.status = 'active'
   and organization.organization_type <> 'single_hotel'
  where membership.status = 'active'
    and membership.starts_at <= clock_timestamp()
    and membership.ended_at is null
    and membership.staxis_role is not null

  union

  select distinct membership.account_id, grant_row.organization_id
  from public.organization_access_grants grant_row
  join public.organization_memberships membership
    on membership.id = grant_row.membership_id
   and membership.organization_id = grant_row.organization_id
  join public.organizations organization
    on organization.id = grant_row.organization_id
   and organization.status = 'active'
   and organization.organization_type <> 'single_hotel'
  where membership.status = 'active'
    and membership.starts_at <= clock_timestamp()
    and membership.ended_at is null
    and grant_row.status = 'active'
    and grant_row.starts_at <= clock_timestamp()
    and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
    and grant_row.source <> 'legacy_backfill';
$$;

revoke all on function public._staxis_cutover_real_account_organizations()
  from public, anon, authenticated, service_role;

-- A governing relationship is usable for Stage A only when it is the exact
-- current primary relationship and its organization is active and of a type
-- that can govern property access. Keep this definition separate from the
-- older topology helper: the latter intentionally exposes raw current
-- relationships for lifecycle/audit code, while Stage A authorization must
-- fail closed for suspended or non-governing organizations.
create or replace function public._staxis_cutover_valid_current_primary_property_relationships()
returns table (
  id uuid,
  organization_id uuid,
  property_id uuid,
  relationship_type text,
  active_primary_count bigint,
  organization_status text,
  organization_type text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select relationship.id,
         relationship.organization_id,
         relationship.property_id,
         relationship.relationship_type,
         relationship.active_primary_count,
         organization.status,
         organization.organization_type
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id
  where organization.status = 'active'
    and organization.organization_type in (
      'single_hotel', 'management_company', 'ownership_group'
    );
$$;

revoke all on function public._staxis_cutover_valid_current_primary_property_relationships()
  from public, anon, authenticated, service_role;

create or replace function public.staxis_preflight_authorization_cutover_labeled(
  p_created_by text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_issue_count integer := 0;
  v_sample jsonb := '[]'::jsonb;
begin
  if nullif(btrim(p_created_by), '') is null then
    raise exception 'Stage A preflight requires a durable creator label'
      using errcode = '22023';
  end if;

  insert into public.account_access_cutover_preflight_runs (id, status, created_by)
  values (v_run_id, 'running', left(p_created_by, 100));

  with legacy_rows as (
    select account.id as account_id, legacy.property_id
    from public.accounts account
    cross join lateral unnest(coalesce(account.property_access, '{}'::uuid[]))
      legacy(property_id)
    where cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0
  ),
  governing as (
    select relationship.property_id,
           count(*)::integer as governing_count,
           (array_agg(relationship.organization_id order by relationship.id))[1]
             as governing_organization_id,
             count(*) filter (
               where organization.id is null
                or organization.status <> 'active'
                or organization.organization_type not in (
                  'single_hotel', 'management_company', 'ownership_group'
                )
             )::integer as invalid_organization_count
    from public._staxis_current_primary_property_relationships() relationship
    left join public.organizations organization
      on organization.id = relationship.organization_id
    group by relationship.property_id
  ),
  account_real_organizations as (
    select real_org.account_id, real_org.organization_id
    from public._staxis_cutover_real_account_organizations() real_org
  ),
  issues as (
    select account.id as account_id, null::uuid as property_id,
           'authorization_state_missing'::text as issue_code,
           jsonb_build_object('accountId', account.id) as details
    from public.accounts account
    left join public.account_authorization_state state
      on state.account_id = account.id
    where state.account_id is null

    union all

    select account.id, null::uuid, 'auth_identity_missing',
           jsonb_build_object('dataUserId', account.data_user_id)
    from public.accounts account
    left join auth.users auth_user on auth_user.id = account.data_user_id
    where auth_user.id is null

    union all

    select account.id, null::uuid, 'inactive_legacy_access',
           jsonb_build_object('active', account.active, 'propertyIds', to_jsonb(account.property_access))
    from public.accounts account
    where account.active is not true
      and cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0

    union all

    select account.id, null::uuid, 'admin_legacy_access',
           jsonb_build_object('role', account.role, 'propertyIds', to_jsonb(account.property_access))
    from public.accounts account
    where account.role = 'admin'
      and cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0

    union all

    select account.id, null::uuid, 'invalid_account_role',
           jsonb_build_object('role', account.role)
    from public.accounts account
    where account.role is null
       or account.role not in (
         'admin', 'owner', 'general_manager', 'front_desk',
         'housekeeping', 'maintenance', 'staff'
       )

    union all

    select account.id, null::uuid, 'duplicate_legacy_property_ids',
           jsonb_build_object(
             'arrayLength', cardinality(account.property_access),
             'distinctLength', cardinality(array(select distinct id from unnest(account.property_access) ids(id)))
           )
    from public.accounts account
    where cardinality(coalesce(account.property_access, '{}'::uuid[]))
       <> cardinality(array(select distinct id from unnest(account.property_access) ids(id)))

    union all

    select legacy.account_id, legacy.property_id, 'property_missing',
           jsonb_build_object('propertyId', legacy.property_id)
    from legacy_rows legacy
    left join public.properties property on property.id = legacy.property_id
    where property.id is null

    union all

    select legacy.account_id, legacy.property_id, 'governing_topology_missing',
           jsonb_build_object('propertyId', legacy.property_id)
    from legacy_rows legacy
    left join governing on governing.property_id = legacy.property_id
    where governing.property_id is null

    union all

    select legacy.account_id, legacy.property_id, 'ambiguous_governing_topology',
           jsonb_build_object('governingCount', governing.governing_count)
    from legacy_rows legacy
    join governing on governing.property_id = legacy.property_id
    where governing.governing_count > 1

    union all

    select legacy.account_id, legacy.property_id, 'invalid_governing_organization',
           jsonb_build_object('invalidOrganizationCount', governing.invalid_organization_count)
    from legacy_rows legacy
    join governing on governing.property_id = legacy.property_id
    where governing.invalid_organization_count > 0

    union all

    select legacy.account_id, legacy.property_id, 'normalized_legacy_residue',
           jsonb_build_object('authorityMode', state.authority_mode)
    from legacy_rows legacy
    join public.account_authorization_state state on state.account_id = legacy.account_id
    where state.authority_mode = 'normalized'

    union all

    select legacy.account_id, legacy.property_id, 'cross_company_legacy_access',
           jsonb_build_object(
             'governingOrganizationId', governing.governing_organization_id,
             'accountOrganizations', coalesce((
               select jsonb_agg(account_org.organization_id order by account_org.organization_id)
               from account_real_organizations account_org
               where account_org.account_id = legacy.account_id
             ), '[]'::jsonb)
           )
    from legacy_rows legacy
    join governing on governing.property_id = legacy.property_id
    where governing.governing_organization_id is not null
      and exists (
        select 1 from account_real_organizations account_org
        where account_org.account_id = legacy.account_id
      )
      and not exists (
        select 1 from account_real_organizations account_org
        where account_org.account_id = legacy.account_id
          and account_org.organization_id = governing.governing_organization_id
      )
  )
  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, issue.account_id, issue.property_id, issue.issue_code, issue.details
  from issues issue;

  select count(*)::integer into v_issue_count
  from public.account_access_cutover_preflight_issues issue
  where issue.run_id = v_run_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'accountId', issue.account_id,
    'propertyId', issue.property_id,
    'code', issue.issue_code,
    'details', issue.details
  ) order by issue.issue_code, issue.account_id, issue.property_id), '[]'::jsonb)
    into v_sample
  from (
    select issue.*
    from public.account_access_cutover_preflight_issues issue
    where issue.run_id = v_run_id
    order by issue.issue_code, issue.account_id, issue.property_id
    limit 25
  ) issue;

  update public.account_access_cutover_preflight_runs
     set status = case when v_issue_count = 0 then 'passed' else 'failed' end,
         issue_count = v_issue_count,
         completed_at = clock_timestamp(),
         details = jsonb_build_object('sample', v_sample, 'stage', 'A')
   where id = v_run_id;

  return jsonb_build_object(
    'ok', v_issue_count = 0,
    'runId', v_run_id,
    'issueCount', v_issue_count,
    'sample', v_sample,
    'stage', 'A'
  );
end;
$$;

-- Preserve the existing service hook and test/API call while making the
-- migration-0419 immediate run independently identifiable from the initial
-- migration-0418 baseline.
create or replace function public.staxis_preflight_authorization_cutover()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  select public.staxis_preflight_authorization_cutover_labeled('0418');
$$;

revoke all on function public.staxis_preflight_authorization_cutover_labeled(text)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_preflight_authorization_cutover_labeled(text)
  to service_role;
revoke all on function public.staxis_preflight_authorization_cutover()
  from public, anon, authenticated;
grant execute on function public.staxis_preflight_authorization_cutover()
  to service_role;

-- Stage A is observational. A failed preflight is durable evidence and is
-- intentionally not a migration failure because the old application remains
-- the active authority until the separately approved Stage B/C train.
select public.staxis_preflight_authorization_cutover();

insert into public.applied_migrations (version, description)
values (
  '0418',
  'Stage A fail-closed access preflight with durable anomaly evidence; legacy authority remains active.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
