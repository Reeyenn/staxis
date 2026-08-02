-- 0423_authoritative_access_stage_a_invariants.sql
--
-- Durable Stage A invariant evidence. This is an assertion/reporting surface,
-- not a compatibility teardown: it never clears legacy arrays, revokes the
-- old projections, changes account authority, or repairs an ambiguous row.

begin;

do $$
begin
  if to_regclass('public.account_access_cutover_status') is null
     or to_regclass('public.account_access_cutover_preflight_issues') is null
     or to_regclass('public.account_access_cutover_legacy_write_events') is null
     or to_regprocedure('public.staxis_invite_access_shadow(uuid)') is null
  then
    raise exception '0423 requires all Stage A preflight, translation, People, and invite foundations';
  end if;
end
$$;

create table if not exists public.account_access_cutover_invariant_runs (
  id           uuid primary key default gen_random_uuid(),
  status       text not null check (status in ('running', 'passed', 'failed')),
  issue_count  integer not null default 0 check (issue_count >= 0),
  checked_at   timestamptz not null default clock_timestamp(),
  details      jsonb not null default '{}'::jsonb
);

-- @rls: service-role-only — invariant anomalies contain cross-tenant authorization IDs and are reviewed only by rollout tooling.
create table if not exists public.account_access_cutover_invariant_issues (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.account_access_cutover_invariant_runs(id) on delete cascade,
  account_id  uuid references public.accounts(id) on delete cascade,
  -- An invariant report must retain an orphan legacy UUID as evidence rather
  -- than fail while recording the missing-property violation.
  property_id uuid,
  issue_code  text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default clock_timestamp()
);

alter table public.account_access_cutover_invariant_runs enable row level security;
alter table public.account_access_cutover_invariant_issues enable row level security;
revoke all on public.account_access_cutover_invariant_runs
  from public, anon, authenticated, service_role;
revoke all on public.account_access_cutover_invariant_issues
  from public, anon, authenticated, service_role;

comment on table public.account_access_cutover_invariant_issues is
  'Stage A service-only invariant evidence. Issues are reported for remediation or a later approved stage; no row is guessed, dropped, or broadened.';

create or replace function public.staxis_assert_stage_a_access_invariants()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_issue_count integer := 0;
  v_sample jsonb := '[]'::jsonb;
  v_snapshot_count integer := 0;
  v_event_count integer := 0;
begin
  insert into public.account_access_cutover_invariant_runs (id, status)
  values (v_run_id, 'running');

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, null::uuid, null::uuid, 'stage_a_status_changed',
         jsonb_build_object(
           'stage', status.stage,
           'enforcementEnabled', status.enforcement_enabled
         )
  from public.account_access_cutover_status status
  where status.id is true
    and (status.stage <> 'A' or status.enforcement_enabled is true);

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, account.id, null::uuid, 'duplicate_legacy_property_ids',
         jsonb_build_object(
           'arrayLength', cardinality(account.property_access),
           'distinctLength', cardinality(array(
             select distinct property_id
             from unnest(coalesce(account.property_access, '{}'::uuid[])) ids(property_id)
           ))
         )
  from public.accounts account
  where cardinality(coalesce(account.property_access, '{}'::uuid[]))
     <> cardinality(array(
       select distinct property_id
       from unnest(coalesce(account.property_access, '{}'::uuid[])) ids(property_id)
     ));

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, account.id, null::uuid, 'invalid_legacy_account_identity',
         jsonb_build_object(
           'active', account.active,
           'role', account.role,
           'dataUserId', account.data_user_id
         )
  from public.accounts account
  where cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0
    and (
      account.active is not true
      or account.role = 'admin'
      or account.data_user_id is null
      or not exists (
        select 1 from auth.users auth_user where auth_user.id = account.data_user_id
      )
    );

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, bridge.account_id, bridge.property_id,
         'active_bridge_account_unavailable',
         jsonb_build_object(
           'active', account.active,
           'dataUserId', account.data_user_id
         )
  from public.account_property_authorization_bridges bridge
  left join public.accounts account on account.id = bridge.account_id
  where bridge.status = 'active'
    and (
      account.id is null
      or account.active is not true
      or account.data_user_id is null
      or not exists (
        select 1 from auth.users auth_user where auth_user.id = account.data_user_id
      )
    );

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, bridge.account_id, bridge.property_id,
         'active_bridge_topology_stale',
         jsonb_build_object(
           'cutoverOrganizationId', bridge.cutover_organization_id,
           'cutoverRelationshipId', bridge.cutover_relationship_id
         )
  from public.account_property_authorization_bridges bridge
  where bridge.status = 'active'
    and (
      (
        bridge.cutover_relationship_id is null
        and exists (
          select 1
          from public._staxis_current_primary_property_relationships() current_relationship
          where current_relationship.property_id = bridge.property_id
        )
      )
      or (
        bridge.cutover_relationship_id is not null
        and not exists (
          select 1
          from public._staxis_current_primary_property_relationships() current_relationship
          where current_relationship.id = bridge.cutover_relationship_id
            and current_relationship.organization_id = bridge.cutover_organization_id
            and current_relationship.property_id = bridge.property_id
            and current_relationship.active_primary_count = 1
        )
      )
    );

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  with real_account_organizations as (
    select real_org.account_id, real_org.organization_id
    from public._staxis_cutover_real_account_organizations() real_org
  )
  select v_run_id, bridge.account_id, bridge.property_id,
         'active_bridge_cross_company',
         jsonb_build_object(
           'cutoverOrganizationId', bridge.cutover_organization_id,
           'accountOrganizations', coalesce((
             select jsonb_agg(real_org.organization_id order by real_org.organization_id)
             from real_account_organizations real_org
             where real_org.account_id = bridge.account_id
           ), '[]'::jsonb)
         )
  from public.account_property_authorization_bridges bridge
  where bridge.status = 'active'
    and bridge.cutover_organization_id is not null
    and exists (
      select 1
      from public.organizations organization
      where organization.id = bridge.cutover_organization_id
        and organization.organization_type <> 'single_hotel'
    )
    and exists (
      select 1 from real_account_organizations real_org
      where real_org.account_id = bridge.account_id
    )
    and not exists (
      select 1 from real_account_organizations real_org
      where real_org.account_id = bridge.account_id
        and real_org.organization_id = bridge.cutover_organization_id
    );

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, bridge.account_id, bridge.property_id,
         'legacy_bridge_not_in_current_array',
         jsonb_build_object('authorityMode', state.authority_mode)
  from public.account_property_authorization_bridges bridge
  join public.account_authorization_state state
    on state.account_id = bridge.account_id
   and state.authority_mode in ('legacy', 'shadow')
  join public.accounts account on account.id = bridge.account_id
  where bridge.status = 'active'
    and not (bridge.property_id = any(coalesce(account.property_access, '{}'::uuid[])));

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, account.id, legacy.property_id,
         'legacy_row_without_shadow_translation',
         jsonb_build_object(
           'authorityMode', state.authority_mode,
           'preflightIssues', coalesce((
             select jsonb_agg(jsonb_build_object(
               'runId', issue.run_id,
               'code', issue.issue_code,
               'details', issue.details
             ) order by issue.created_at, issue.id)
             from public.account_access_cutover_preflight_issues issue
             where issue.account_id = account.id
               and issue.property_id = legacy.property_id
           ), '[]'::jsonb)
         )
  from public.accounts account
  join public.account_authorization_state state
    on state.account_id = account.id
   and state.authority_mode in ('legacy', 'shadow')
  cross join lateral unnest(coalesce(account.property_access, '{}'::uuid[])) legacy(property_id)
  where not exists (
    select 1
    from public.account_property_authorization_bridges bridge
    where bridge.account_id = account.id
      and bridge.property_id = legacy.property_id
      and bridge.status = 'active'
  );

  insert into public.account_access_cutover_invariant_issues (
    run_id, account_id, property_id, issue_code, details
  )
  select v_run_id, invitation.accepted_by, invitation.hotel_id,
         'accepted_invite_account_unavailable',
         jsonb_build_object('inviteId', invitation.id, 'acceptedAt', invitation.accepted_at)
  from public.account_invites invitation
  left join public.accounts account on account.id = invitation.accepted_by
  where invitation.accepted_at is not null
    and (
      invitation.accepted_by is null
      or account.id is null
      or account.active is not true
    );

  v_issue_count := (
    select count(*)::integer
    from public.account_access_cutover_invariant_issues issue
    where issue.run_id = v_run_id
  );

  v_sample := coalesce((
    select jsonb_agg(jsonb_build_object(
      'accountId', issue.account_id,
      'propertyId', issue.property_id,
      'code', issue.issue_code,
      'details', issue.details
    ))
    from public.account_access_cutover_invariant_issues issue
    where issue.run_id = v_run_id
  ), '[]'::jsonb);

  v_snapshot_count := (
    select count(*)::integer
    from public.account_access_cutover_legacy_snapshots
  );
  v_event_count := (
    select count(*)::integer
    from public.account_access_cutover_legacy_write_events
  );

  update public.account_access_cutover_invariant_runs
     set status = case when v_issue_count = 0 then 'passed' else 'failed' end,
         issue_count = v_issue_count,
         checked_at = clock_timestamp(),
         details = jsonb_build_object(
           'stage', 'A',
           'legacyArraysPreserved', true,
           'legacySnapshotCount', v_snapshot_count,
           'legacyWriteEventCount', v_event_count,
           'sample', v_sample
         )
   where id = v_run_id;

  return jsonb_build_object(
    'ok', v_issue_count = 0,
    'stage', 'A',
    'runId', v_run_id,
    'issueCount', v_issue_count,
    'legacyArraysPreserved', true,
    'legacySnapshotCount', v_snapshot_count,
    'legacyWriteEventCount', v_event_count,
    'sample', v_sample
  );
end;
$$;

comment on function public.staxis_assert_stage_a_access_invariants() is
  'Stage A service-only invariant report. It detects stale or cross-company shadow bridges, untranslated legacy rows, invalid identities, and accepted-invite lifecycle anomalies without changing authority.';

revoke all on function public.staxis_assert_stage_a_access_invariants()
  from public, anon, authenticated;
grant execute on function public.staxis_assert_stage_a_access_invariants()
  to service_role;

select public.staxis_assert_stage_a_access_invariants();

insert into public.applied_migrations (version, description)
values (
  '0423',
  'Stage A durable access invariants for topology-bound bridges, legacy preservation, lifecycle identity, and invite acceptance; report-only with no compatibility teardown.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
