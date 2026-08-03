-- 0426_authoritative_access_stage_c_final_contract.sql
--
-- Final Access contract.  The preflight transaction commits first.  A second
-- transaction then installs canonical-only resolvers, normalizes proven legacy
-- receipts, clears the physical rollback arrays, retires the translators, and
-- enables the final write fence.  Any error in that second transaction rolls
-- back every authority mutation.

do $requirements$
begin
  if to_regclass('public.account_access_cutover_status') is null
     or to_regclass('public.account_access_cutover_preflight_runs') is null
     or to_regprocedure('public.staxis_preflight_authorization_cutover_stage_c()') is null
     or to_regprocedure('public._staxis_stage_b_import_legacy_scope(uuid,text)') is null
     or to_regprocedure('public._staxis_nonlegacy_property_authorizations(uuid)') is null
     or to_regprocedure('public._staxis_account_property_authorizations(uuid)') is null
  then
    raise exception '0426 requires the Stage C preflight and Stage B canonical access contracts';
  end if;
end
$requirements$;

alter table public.account_access_cutover_status
  add column if not exists final_preflight_run_id uuid
    references public.account_access_cutover_preflight_runs(id),
  add column if not exists finalized_at timestamptz;

-- 0425 is a separately shipped test-property roster migration.  Stage C
-- owns this preflight in 0426 so it never collides with that production
-- version.  The run is deliberately report-only; the strict gate below runs
-- after this transaction commits and therefore preserves evidence on reject.
create or replace function public.staxis_preflight_authorization_cutover_stage_c()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_issue_count integer := 0;
  v_stage text;
  v_enforcement boolean;
  v_account record;
  v_state record;
  v_bridge record;
  v_invite record;
  v_intent record;
  v_property_id uuid;
  v_raw_relationship_count integer;
  v_valid_relationship_count integer;
  v_org_id uuid;
  v_org_type text;
  v_scope_ids uuid[];
  v_expected_ids uuid[];
begin
  select status.stage, status.enforcement_enabled
    into v_stage, v_enforcement
  from public.account_access_cutover_status status
  where status.id is true
  for update;
  if not found then
    raise exception '0426 Stage C preflight requires cutover status';
  end if;
  if v_stage = 'C' and v_enforcement is true then
    return jsonb_build_object('ok', true, 'alreadyFinalized', true, 'stage', 'C');
  end if;

  insert into public.account_access_cutover_preflight_runs (
    id, status, created_by, details
  ) values (
    v_run_id, 'running', '0426-stage-c', jsonb_build_object('stage', 'C')
  );

  if not exists (
    select 1 from public.applied_migrations where version = '0424'
  ) or to_regprocedure('public.staxis_list_account_authorized_properties(uuid)') is null
  then
    insert into public.account_access_cutover_preflight_issues (
      run_id, issue_code, details
    ) values (
      v_run_id, 'stage_b_contract_missing',
      jsonb_build_object('applied0424', exists (
        select 1 from public.applied_migrations where version = '0424'
      ))
    );
  end if;

  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'authorization_state_missing',
         jsonb_build_object('accountId', account.id)
  from public.accounts account
  left join public.account_authorization_state state on state.account_id = account.id
  where state.account_id is null;

  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'auth_identity_missing',
         jsonb_build_object('dataUserId', account.data_user_id)
  from public.accounts account
  left join auth.users auth_user on auth_user.id = account.data_user_id
  where auth_user.id is null;

  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'invalid_account_role',
         jsonb_build_object('role', account.role)
  from public.accounts account
  where account.role is null
     or account.role not in (
       'admin', 'owner', 'general_manager', 'front_desk',
       'housekeeping', 'maintenance', 'staff'
     );

  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'normalized_legacy_residue',
         jsonb_build_object('propertyIds', to_jsonb(account.property_access))
  from public.accounts account
  join public.account_authorization_state state on state.account_id = account.id
  where state.authority_mode = 'normalized'
    and cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0;

  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'inactive_legacy_access',
         jsonb_build_object('propertyIds', to_jsonb(account.property_access))
  from public.accounts account
  join public.account_authorization_state state on state.account_id = account.id
  where state.authority_mode in ('legacy', 'shadow')
    and account.active is not true
    and cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0;

  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'admin_legacy_access',
         jsonb_build_object('propertyIds', to_jsonb(account.property_access))
  from public.accounts account
  join public.account_authorization_state state on state.account_id = account.id
  where state.authority_mode in ('legacy', 'shadow')
    and account.role = 'admin'
    and cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0;

  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'legacy_scope_invalid',
         jsonb_build_object(
           'propertyIds', to_jsonb(account.property_access),
           'hasNull', array_position(account.property_access, null::uuid) is not null,
           'arrayLength', cardinality(account.property_access),
           'distinctLength', cardinality(array(
             select distinct id
             from unnest(coalesce(account.property_access, '{}'::uuid[])) ids(id)
           ))
         )
  from public.accounts account
  join public.account_authorization_state state on state.account_id = account.id
  where state.authority_mode in ('legacy', 'shadow')
    and (
      array_position(account.property_access, null::uuid) is not null
      or cardinality(coalesce(account.property_access, '{}'::uuid[]))
           <> cardinality(array(
             select distinct id
             from unnest(coalesce(account.property_access, '{}'::uuid[])) ids(id)
           ))
    );

  for v_account in
    select account.*
    from public.accounts account
    join public.account_authorization_state state on state.account_id = account.id
    where state.authority_mode in ('legacy', 'shadow')
      and account.active is true
      and account.role <> 'admin'
      and cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0
    order by account.id
  loop
    foreach v_property_id in array coalesce(v_account.property_access, '{}'::uuid[])
    loop
      if v_property_id is null then continue; end if;
      if not exists (select 1 from public.properties property where property.id = v_property_id) then
        insert into public.account_access_cutover_preflight_issues (
          run_id, account_id, property_id, issue_code, details
        ) values (
          v_run_id, v_account.id, v_property_id, 'property_missing',
          jsonb_build_object('propertyId', v_property_id)
        );
        continue;
      end if;
      select count(*)::integer into v_raw_relationship_count
      from public._staxis_current_primary_property_relationships() relationship
      where relationship.property_id = v_property_id;
      if v_raw_relationship_count <> 1 then
        insert into public.account_access_cutover_preflight_issues (
          run_id, account_id, property_id, issue_code, details
        ) values (
          v_run_id, v_account.id, v_property_id,
          case when v_raw_relationship_count = 0
            then 'governing_topology_missing' else 'ambiguous_governing_topology' end,
          jsonb_build_object('governingCount', v_raw_relationship_count)
        );
        continue;
      end if;
      select count(*)::integer,
             (array_agg(relationship.organization_id order by relationship.id))[1],
             (array_agg(relationship.organization_type order by relationship.id))[1]
        into v_valid_relationship_count, v_org_id, v_org_type
      from public._staxis_cutover_valid_current_primary_property_relationships() relationship
      where relationship.property_id = v_property_id
        and relationship.active_primary_count = 1;
      if v_valid_relationship_count <> 1 then
        insert into public.account_access_cutover_preflight_issues (
          run_id, account_id, property_id, issue_code, details
        ) values (
          v_run_id, v_account.id, v_property_id, 'invalid_governing_organization',
          jsonb_build_object('validRelationshipCount', v_valid_relationship_count)
        );
      end if;
      if v_org_type <> 'single_hotel'
         and exists (
           select 1 from public._staxis_cutover_real_account_organizations() real_org
           where real_org.account_id = v_account.id
         )
         and not exists (
           select 1 from public._staxis_cutover_real_account_organizations() real_org
           where real_org.account_id = v_account.id and real_org.organization_id = v_org_id
         ) then
        insert into public.account_access_cutover_preflight_issues (
          run_id, account_id, property_id, issue_code, details
        ) values (
          v_run_id, v_account.id, v_property_id, 'cross_company_legacy_access',
          jsonb_build_object('governingOrganizationId', v_org_id)
        );
      end if;
      if exists (
        select 1 from public.account_property_authorization_bridges bridge
        where bridge.account_id = v_account.id
          and bridge.property_id = v_property_id
          and bridge.status = 'retired'
      ) then
        insert into public.account_access_cutover_preflight_issues (
          run_id, account_id, property_id, issue_code, details
        ) values (
          v_run_id, v_account.id, v_property_id, 'retired_bridge', '{}'::jsonb
        );
      end if;
    end loop;
  end loop;

  for v_bridge in
    select bridge.*, account.data_user_id, state.authority_mode
    from public.account_property_authorization_bridges bridge
    join public.accounts account on account.id = bridge.account_id
    left join public.account_authorization_state state on state.account_id = bridge.account_id
    where bridge.status = 'active'
    order by bridge.account_id, bridge.property_id, bridge.id
  loop
    if v_bridge.data_user_id is null
       or not exists (select 1 from auth.users auth_user where auth_user.id = v_bridge.data_user_id) then
      insert into public.account_access_cutover_preflight_issues (
        run_id, account_id, property_id, issue_code, details
      ) values (
        v_run_id, v_bridge.account_id, v_bridge.property_id,
        'bridge_auth_identity_missing', jsonb_build_object('bridgeId', v_bridge.id)
      );
    end if;
    if not exists (select 1 from public.properties property where property.id = v_bridge.property_id) then
      insert into public.account_access_cutover_preflight_issues (
        run_id, account_id, property_id, issue_code, details
      ) values (
        v_run_id, v_bridge.account_id, v_bridge.property_id,
        'bridge_property_missing', jsonb_build_object('bridgeId', v_bridge.id)
      );
    elsif v_bridge.cutover_relationship_id is null then
      if v_bridge.cutover_organization_id is not null
         or exists (
           select 1 from public._staxis_current_primary_property_relationships() relationship
           where relationship.property_id = v_bridge.property_id
         ) then
        insert into public.account_access_cutover_preflight_issues (
          run_id, account_id, property_id, issue_code, details
        ) values (
          v_run_id, v_bridge.account_id, v_bridge.property_id,
          'bridge_topology_stale', jsonb_build_object('bridgeId', v_bridge.id)
        );
      end if;
    elsif not exists (
      select 1 from public._staxis_current_primary_property_relationships() relationship
      where relationship.id = v_bridge.cutover_relationship_id
        and relationship.organization_id = v_bridge.cutover_organization_id
        and relationship.property_id = v_bridge.property_id
        and relationship.active_primary_count = 1
    ) then
      insert into public.account_access_cutover_preflight_issues (
        run_id, account_id, property_id, issue_code, details
      ) values (
        v_run_id, v_bridge.account_id, v_bridge.property_id,
        'bridge_topology_stale', jsonb_build_object('bridgeId', v_bridge.id)
      );
    end if;
  end loop;

  -- Do not tear down while Auth/lifecycle is in an external two-phase window.
  for v_intent in
    select intent.* from public.account_lifecycle_intents intent
    where intent.status in ('pending', 'processing')
    order by intent.operation_id
  loop
    insert into public.account_access_cutover_preflight_issues (
      run_id, account_id, issue_code, details
    ) values (
      v_run_id, v_intent.account_id, 'lifecycle_in_flight',
      jsonb_build_object(
        'operationId', v_intent.operation_id,
        'status', v_intent.status,
        'processorToken', v_intent.processor_token
      )
    );
  end loop;

  for v_invite in
    select invitation.* from public.account_invites invitation
    where invitation.acceptance_claim_token is not null
      and invitation.accepted_at is null
    order by invitation.id
  loop
    insert into public.account_access_cutover_preflight_issues (
      run_id, property_id, issue_code, details
    ) values (
      v_run_id, v_invite.hotel_id, 'invite_acceptance_in_flight',
      jsonb_build_object('inviteId', v_invite.id)
    );
  end loop;

  for v_invite in
    select invitation.* from public.account_invites invitation
    where invitation.accepted_at is not null
    order by invitation.id
  loop
    if v_invite.accepted_by is null
       or not exists (select 1 from public.accounts account where account.id = v_invite.accepted_by) then
      insert into public.account_access_cutover_preflight_issues (
        run_id, issue_code, details
      ) values (
        v_run_id, 'accepted_invite_account_missing',
        jsonb_build_object('inviteId', v_invite.id, 'acceptedBy', v_invite.accepted_by)
      );
    else
      v_scope_ids := public._staxis_structural_account_property_ids(v_invite.accepted_by);
      if v_invite.hotel_id is null or not (v_invite.hotel_id = any(v_scope_ids)) then
        insert into public.account_access_cutover_preflight_issues (
          run_id, account_id, property_id, issue_code, details
        ) values (
          v_run_id, v_invite.accepted_by, v_invite.hotel_id,
          'accepted_invite_access_missing', jsonb_build_object('inviteId', v_invite.id)
        );
      end if;
      if v_invite.target_staff_id is not null
         and not exists (
           select 1 from public.account_property_staff_links staff_link
           where staff_link.account_id = v_invite.accepted_by
             and staff_link.property_id = v_invite.hotel_id
             and staff_link.staff_id = v_invite.target_staff_id
             and staff_link.is_active is true
         ) then
        insert into public.account_access_cutover_preflight_issues (
          run_id, account_id, property_id, issue_code, details
        ) values (
          v_run_id, v_invite.accepted_by, v_invite.hotel_id,
          'accepted_invite_roster_link_missing', jsonb_build_object('inviteId', v_invite.id)
        );
      end if;
    end if;
  end loop;

  for v_account in
    select distinct staff_link.account_id, staff_link.property_id, staff_link.staff_id
    from public.account_property_staff_links staff_link
    where staff_link.is_active is true
    order by staff_link.account_id, staff_link.property_id
  loop
    v_scope_ids := public._staxis_structural_account_property_ids(v_account.account_id);
    if not (v_account.property_id = any(v_scope_ids)) then
      insert into public.account_access_cutover_preflight_issues (
        run_id, account_id, property_id, issue_code, details
      ) values (
        v_run_id, v_account.account_id, v_account.property_id,
        'roster_link_without_authority', jsonb_build_object('staffId', v_account.staff_id)
      );
    end if;
  end loop;

  select count(*)::integer into v_issue_count
  from public.account_access_cutover_preflight_issues issue
  where issue.run_id = v_run_id;
  update public.account_access_cutover_preflight_runs
     set status = case when v_issue_count = 0 then 'passed' else 'failed' end,
         issue_count = v_issue_count,
         completed_at = clock_timestamp(),
         details = jsonb_build_object('stage', 'C', 'enforcementBefore', v_enforcement)
   where id = v_run_id;
  update public.account_access_cutover_status
     set last_preflight_run_id = v_run_id,
         final_preflight_run_id = v_run_id
   where id is true;
  return jsonb_build_object(
    'ok', v_issue_count = 0, 'runId', v_run_id,
    'issueCount', v_issue_count, 'stage', 'C'
  );
end;
$$;

revoke all on function public.staxis_preflight_authorization_cutover_stage_c()
  from public, anon, authenticated, service_role;

-- Run and commit the preflight before the strict gate.  This deliberately uses
-- two transactions: a failed final gate must leave the issue rows available to
-- the operator rather than rolling the evidence back with the exception.
begin;
select public.staxis_preflight_authorization_cutover_stage_c();
commit;

do $strict_gate$
declare
  v_stage text;
  v_enforcement boolean;
  v_run_id uuid;
  v_issue_count integer;
begin
  select status.stage, status.enforcement_enabled,
         status.final_preflight_run_id
    into v_stage, v_enforcement, v_run_id
  from public.account_access_cutover_status status
  where status.id is true;
  if v_stage = 'C' and v_enforcement is true then
    return;
  end if;
  select run.issue_count into v_issue_count
  from public.account_access_cutover_preflight_runs run
  where run.id = v_run_id;
  if v_run_id is null or coalesce(v_issue_count, 1) <> 0 then
    raise exception '0426 Stage C preflight rejected finalization (run %, issues %)',
      v_run_id, coalesce(v_issue_count, 1)
      using errcode = '55000';
  end if;
end
$strict_gate$;

begin;

do $requirements$
begin
  if to_regclass('public.accounts') is null
     or to_regclass('public.properties') is null
     or to_regclass('public.account_authorization_state') is null
     or to_regclass('public.account_property_authorization_bridges') is null
     or to_regclass('public.account_property_staff_links') is null
     or to_regclass('public.account_invites') is null
     or to_regclass('public.account_lifecycle_intents') is null
  then
    raise exception '0426 requires accounts, canonical authority, People, invites, and lifecycle tables';
  end if;
end
$requirements$;

-- A durable final receipt is the only retained copy of an account's former
-- raw hotel list.  It is service-only, immutable by convention, and includes
-- the canonical result that was actually installed before the array was
-- cleared.  The pre-existing Stage A snapshot and write-event tables remain
-- intact as earlier evidence.
create table if not exists public.account_access_cutover_final_receipts (
  account_id             uuid primary key references public.accounts(id) on delete cascade,
  preflight_run_id       uuid not null references public.account_access_cutover_preflight_runs(id),
  source_property_ids    uuid[] not null default '{}'::uuid[],
  source_property_count  integer not null default 0 check (source_property_count >= 0),
  source_scope_hash      text not null,
  canonical_property_ids uuid[] not null default '{}'::uuid[],
  canonical_property_count integer not null default 0 check (canonical_property_count >= 0),
  bridge_count           integer not null default 0 check (bridge_count >= 0),
  cleared_at             timestamptz not null default clock_timestamp(),
  details                jsonb not null default '{}'::jsonb
);

alter table public.account_access_cutover_final_receipts enable row level security;
revoke all on public.account_access_cutover_final_receipts
  from public, anon, authenticated, service_role;
drop policy if exists account_access_cutover_final_receipts_deny_browser
  on public.account_access_cutover_final_receipts;
create policy account_access_cutover_final_receipts_deny_browser
  on public.account_access_cutover_final_receipts
  for all to anon, authenticated using (false) with check (false);

comment on table public.account_access_cutover_final_receipts is
  'Stage C immutable service-only receipts. The former property_access array is cleared after the proven canonical result and receipt are written.';

-- Structural scope is used by People lifecycle and admin operations, including
-- inactive targets whose access resumes on reactivation.  It is now entirely
-- canonical: memberships, grants, topology-bound bridges, and nothing from
-- accounts.property_access.
create or replace function public._staxis_structural_account_property_ids(
  p_account_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with recursive
  governing_relationships as (
    select relationship.id, relationship.organization_id, relationship.property_id
    from public._staxis_current_primary_property_relationships() relationship
    join public.organizations organization
      on organization.id = relationship.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    where relationship.active_primary_count = 1
  ),
  active_memberships as (
    select membership.*
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
     and organization.status = 'active'
     and organization.organization_type <> 'single_hotel'
    where membership.account_id = p_account_id
      and membership.status = 'active'
      and membership.starts_at <= clock_timestamp()
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
      and grant_row.starts_at <= clock_timestamp()
      and (grant_row.expires_at is null or grant_row.expires_at > clock_timestamp())
  ),
  portfolio_tree (grant_id, organization_id, membership_id, portfolio_id) as (
    select grant_row.id, grant_row.organization_id,
           grant_row.membership_id, portfolio.id
    from active_grants grant_row
    join public.portfolios portfolio
      on portfolio.id = grant_row.portfolio_id
     and portfolio.organization_id = grant_row.organization_id
     and portfolio.status = 'active'
    where grant_row.scope_type = 'portfolio'

    union

    select tree.grant_id, tree.organization_id,
           tree.membership_id, child.id
    from portfolio_tree tree
    join public.portfolios child
      on child.parent_id = tree.portfolio_id
     and child.organization_id = tree.organization_id
     and child.status = 'active'
  ),
  expanded(property_id) as (
    select relationship.property_id
    from active_memberships membership
    join governing_relationships relationship
      on relationship.organization_id = membership.organization_id
    where membership.membership_scope = 'company'
      and membership.staxis_role in ('owner', 'vp', 'finance')

    union

    select relationship.property_id
    from active_memberships membership
    cross join lateral unnest(
      coalesce(membership.covered_property_ids, '{}'::uuid[])
    ) covered(property_id)
    join governing_relationships relationship
      on relationship.organization_id = membership.organization_id
     and relationship.property_id = covered.property_id
    where membership.membership_scope = 'property'
      and membership.staxis_role in (
        'general_manager', 'front_desk', 'housekeeping', 'maintenance'
      )

    union

    select relationship.property_id
    from active_grants grant_row
    join governing_relationships relationship
      on relationship.organization_id = grant_row.organization_id
    where grant_row.scope_type = 'organization'

    union

    select relationship.property_id
    from active_grants grant_row
    join governing_relationships relationship
      on relationship.id = grant_row.property_relationship_id
     and relationship.organization_id = grant_row.organization_id
     and relationship.property_id = grant_row.property_id
    where grant_row.scope_type = 'property'

    union

    select relationship.property_id
    from portfolio_tree tree
    join public.portfolio_properties assignment
      on assignment.organization_id = tree.organization_id
     and assignment.portfolio_id = tree.portfolio_id
     and assignment.assigned_at <= clock_timestamp()
     and (assignment.removed_at is null or assignment.removed_at > clock_timestamp())
    join governing_relationships relationship
      on relationship.id = assignment.property_relationship_id
     and relationship.organization_id = assignment.organization_id
     and relationship.property_id = assignment.property_id

    union

    select bridge.property_id
    from public.account_property_authorization_bridges bridge
    where bridge.account_id = p_account_id
      and bridge.status = 'active'
      and (
        (bridge.cutover_relationship_id is null and not exists (
          select 1
          from public._staxis_current_primary_property_relationships() current_relationship
          where current_relationship.property_id = bridge.property_id
        ))
        or exists (
          select 1
          from public._staxis_current_primary_property_relationships() current_relationship
          where current_relationship.id = bridge.cutover_relationship_id
            and current_relationship.organization_id = bridge.cutover_organization_id
            and current_relationship.property_id = bridge.property_id
            and current_relationship.active_primary_count = 1
        )
      )
  )
  select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
  from expanded;
$$;

revoke all on function public._staxis_structural_account_property_ids(uuid)
  from public, anon, authenticated, service_role;

-- Canonical-only version/hash maintenance.  A non-empty receipt at this point
-- is an invariant violation, not a reason to resurrect the old translator.
create or replace function public._staxis_refresh_account_authorization(
  p_account_id uuid,
  p_reason text default 'canonical authorization fact changed'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state public.account_authorization_state%rowtype;
  v_hash text;
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'canonical authorization fact changed'), 500);
begin
  if p_account_id is null then return; end if;

  insert into public.account_authorization_state (account_id)
  select account.id from public.accounts account where account.id = p_account_id
  on conflict (account_id) do nothing;

  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id
  for update;
  if not found then return; end if;

  if v_state.authority_mode <> 'normalized' then
    update public.account_authorization_state state
       set authority_mode = 'normalized',
           cutover_at = coalesce(state.cutover_at, clock_timestamp()),
           cutover_reason = coalesce(state.cutover_reason, v_reason),
           updated_at = clock_timestamp()
     where state.account_id = p_account_id;
  end if;

  select encode(sha256(convert_to(coalesce(string_agg(
    concat_ws(':', authz.organization_id::text,
                    authz.property_id::text,
                    authz.entitlement_kind,
                    authz.entitlement_id::text,
                    coalesce(authz.scope_type, ''),
                    coalesce(authz.portfolio_id::text, ''),
                    authz.can_portfolio_intelligence::text),
    ',' order by authz.organization_id::text nulls first,
                 authz.property_id::text,
                 authz.entitlement_kind,
                 authz.entitlement_id::text
  ), ''), 'UTF8')), 'hex')
    into v_hash
  from public._staxis_account_property_authorizations(p_account_id) authz;

  update public.account_authorization_state state
     set legacy_scope_hash = coalesce(state.legacy_scope_hash, ''),
         normalized_scope_hash = coalesce(v_hash, encode(sha256(convert_to('', 'UTF8')), 'hex')),
         authority_version = state.authority_version + 1,
         updated_at = clock_timestamp()
   where state.account_id = p_account_id;
end;
$$;

revoke all on function public._staxis_refresh_account_authorization(uuid, text)
  from public, anon, authenticated;
grant execute on function public._staxis_refresh_account_authorization(uuid, text)
  to service_role;

create or replace function public._staxis_refresh_account_authorization_from_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._staxis_refresh_account_authorization(new.id, 'account canonical fields changed');
  return new;
end;
$$;

drop trigger if exists trg_accounts_authorization_refresh on public.accounts;
create trigger trg_accounts_authorization_refresh
  after insert or update of active, role on public.accounts
  for each row execute function public._staxis_refresh_account_authorization_from_account();

-- The operational resolver and the RLS reach helper now have no legacy mode.
-- `legacyPropertyIds` remains in the DTO as a stable empty compatibility field
-- for current app consumers, never as an authority source.
create or replace function public.staxis_list_account_authorized_properties(
  p_account_id uuid
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
  v_property_ids uuid[] := '{}'::uuid[];
  v_bridge_ids uuid[] := '{}'::uuid[];
  v_normalized_ids uuid[] := '{}'::uuid[];
  v_standings jsonb := '[]'::jsonb;
  v_hash text;
begin
  select account.* into v_account
  from public.accounts account
  where account.id = p_account_id and account.active is true;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_active_account');
  end if;

  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing');
  end if;
  if v_state.authority_mode <> 'normalized' then
    return jsonb_build_object('ok', false, 'reason', 'final_authority_not_normalized');
  end if;

  if v_account.role = 'admin' then
    v_hash := encode(sha256(convert_to(jsonb_build_object(
      'all', true, 'authorityMode', 'normalized',
      'authorityVersion', v_state.authority_version,
      'accountRole', v_account.role,
      'propertyIds', '[]'::jsonb,
      'propertyStandings', '[]'::jsonb
    )::text, 'UTF8')), 'hex');
    return jsonb_build_object(
      'ok', true, 'all', true, 'authorityMode', 'normalized',
      'authorityVersion', v_state.authority_version,
      'effectiveAccessHash', v_hash,
      'propertyIds', '[]'::jsonb, 'legacyPropertyIds', '[]'::jsonb,
      'membershipPropertyIds', '[]'::jsonb, 'propertyStandings', '[]'::jsonb
    );
  end if;

  with raw as (
    select authz.*,
           case authz.entitlement_kind
             when 'membership_hat' then 3
             when 'access_grant' then 2
             else 1
           end as authority_priority,
           case
             when authz.entitlement_kind = 'membership_hat' then
               case authz.staxis_role
                 when 'general_manager' then 'general_manager'
                 when 'housekeeping' then 'housekeeping'
                 when 'maintenance' then 'maintenance'
                 else 'front_desk'
               end
             when authz.entitlement_kind = 'access_grant' then
               case when authz.access_profile = 'property_manager'
                    and authz.scope_type = 'property'
                 then 'general_manager' else 'front_desk' end
             else v_account.role
           end as operational_role,
           case
             when authz.entitlement_kind = 'membership_hat'
               and authz.scope_type = 'property' then
                 case authz.staxis_role
                   when 'general_manager' then 900
                   when 'front_desk' then 500
                   when 'maintenance' then 400
                   when 'housekeeping' then 300
                   else 100
                 end
             when authz.entitlement_kind = 'access_grant'
               and authz.scope_type = 'property'
               and authz.access_profile = 'property_manager' then 850
             else 100
           end as role_priority,
           case
             when authz.entitlement_kind = 'membership_hat'
               then authz.staxis_role in ('owner', 'vp', 'finance', 'general_manager')
             when authz.entitlement_kind = 'access_grant'
               then authz.access_profile in ('organization_owner', 'property_manager')
             else v_account.role in ('owner', 'general_manager')
           end as sees_financials,
           case
             when authz.entitlement_kind = 'access_grant'
               then authz.scope_type = 'property' and authz.access_profile = 'property_manager'
             when authz.entitlement_kind = 'membership_hat'
               then authz.scope_type = 'property'
             else true
           end as hotel_mutation_allowed
    from public._staxis_account_property_authorizations(p_account_id) authz
  ),
  winning as (
    select raw.*
    from raw
    join (
      select property_id, max(authority_priority) as authority_priority
      from raw group by property_id
    ) priority
      on priority.property_id = raw.property_id
     and priority.authority_priority = raw.authority_priority
  ),
  grouped as (
    select winning.property_id,
           (array_agg(winning.operational_role order by winning.role_priority desc,
             winning.entitlement_kind, winning.entitlement_id))[1] as operational_role,
           bool_or(winning.sees_financials) as sees_financials,
           bool_or(winning.hotel_mutation_allowed) as hotel_mutation_allowed,
           bool_or(winning.can_portfolio_intelligence) as portfolio_intelligence_read,
           jsonb_agg(jsonb_build_object(
             'kind', winning.entitlement_kind,
             'entitlementId', winning.entitlement_id,
             'organizationId', winning.organization_id,
             'membershipId', winning.membership_id,
             'accessProfile', winning.access_profile,
             'staxisRole', winning.staxis_role,
             'scopeType', winning.scope_type,
             'portfolioId', winning.portfolio_id
           ) order by winning.role_priority desc,
             winning.entitlement_kind, winning.entitlement_id) as entitlements
    from winning
    group by winning.property_id
  )
  select coalesce(array_agg(grouped.property_id order by grouped.property_id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object(
           'propertyId', grouped.property_id,
           'operationalRole', grouped.operational_role,
           'seesFinancials', grouped.sees_financials,
           'hotelMutationAllowed', grouped.hotel_mutation_allowed,
           'portfolioIntelligenceRead', grouped.portfolio_intelligence_read,
           'entitlements', grouped.entitlements
         ) order by grouped.property_id), '[]'::jsonb)
    into v_property_ids, v_standings
  from grouped;

  select coalesce(array_agg(distinct authz.property_id order by authz.property_id)
                    filter (where authz.entitlement_kind = 'legacy_bridge'), '{}'::uuid[]),
         coalesce(array_agg(distinct authz.property_id order by authz.property_id)
                    filter (where authz.entitlement_kind <> 'legacy_bridge'), '{}'::uuid[])
    into v_bridge_ids, v_normalized_ids
  from public._staxis_account_property_authorizations(p_account_id) authz;

  v_hash := encode(sha256(convert_to(jsonb_build_object(
    'all', false, 'authorityMode', 'normalized',
    'authorityVersion', v_state.authority_version,
    'accountRole', v_account.role,
    'propertyIds', to_jsonb(v_property_ids),
    'legacyPropertyIds', to_jsonb(v_bridge_ids),
    'membershipPropertyIds', to_jsonb(v_normalized_ids),
    'propertyStandings', v_standings
  )::text, 'UTF8')), 'hex');

  return jsonb_build_object(
    'ok', true, 'all', false, 'authorityMode', 'normalized',
    'authorityVersion', v_state.authority_version,
    'effectiveAccessHash', v_hash,
    'propertyIds', to_jsonb(v_property_ids),
    'legacyPropertyIds', to_jsonb(v_bridge_ids),
    'membershipPropertyIds', to_jsonb(v_normalized_ids),
    'propertyStandings', v_standings
  );
end;
$$;

revoke all on function public.staxis_list_account_authorized_properties(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_list_account_authorized_properties(uuid)
  to service_role;

create or replace function public.staxis_account_reaches_property(
  p_user_id uuid,
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.accounts account
    join public.account_authorization_state state on state.account_id = account.id
    where account.data_user_id = p_user_id
      and account.active is true
      and state.authority_mode = 'normalized'
      and (
        account.role = 'admin'
        or exists (
          select 1
          from public._staxis_account_property_authorizations(account.id) authz
          where authz.property_id = p_property_id
        )
      )
  );
$$;

comment on function public.staxis_account_reaches_property(uuid, uuid) is
  'Final canonical tenant gate. Admins use role authority; every other account uses only normalized memberships, grants, and topology-bound bridges.';

revoke all on function public.staxis_account_reaches_property(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_account_reaches_property(uuid, uuid)
  to service_role;

-- Final physical-column fence.  The column remains for rollback evidence and
-- old schema compatibility, but any new non-empty value is rejected before it
-- can be mistaken for an authority fact.  The finalizer drops the Stage A/B
-- observers before clearing the existing values and installs this trigger
-- afterward.
create or replace function public._staxis_reject_final_legacy_property_access_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if cardinality(coalesce(new.property_access, '{}'::uuid[])) > 0 then
    raise exception 'final access contract rejects accounts.property_access writes'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_reject_final_legacy_property_access_write()
  from public, anon, authenticated, service_role;

-- The final receipt table is created before this block so the block can be
-- retried idempotently after a deployment interruption.
do $finalize$
declare
  v_status public.account_access_cutover_status%rowtype;
  v_run_id uuid;
  v_account record;
  v_state record;
  v_raw_ids uuid[];
  v_canonical_ids uuid[];
  v_hash text;
  v_import jsonb;
begin
  select status.* into v_status
  from public.account_access_cutover_status status
  where status.id is true
  for update;
  if not found then
    raise exception 'Stage C finalization status row is missing';
  end if;
  if v_status.stage = 'C' and v_status.enforcement_enabled is true then
    return;
  end if;
  v_run_id := v_status.final_preflight_run_id;
  if v_run_id is null then
    raise exception 'Stage C finalization has no preflight evidence';
  end if;

  -- Preserve each account's exact source list before the one-way clear.
  for v_account in
    select account.id, account.property_access, account.data_user_id, account.role
    from public.accounts account
    order by account.id
    for update
  loop
    v_raw_ids := coalesce(v_account.property_access, '{}'::uuid[]);
    select coalesce(array_agg(distinct id order by id), '{}'::uuid[])
      into v_raw_ids
    from unnest(v_raw_ids) ids(id);
    v_hash := encode(sha256(convert_to(coalesce(array_to_string(v_raw_ids, ','), ''), 'UTF8')), 'hex');

    select state.* into v_state
    from public.account_authorization_state state
    where state.account_id = v_account.id
    for update;
    if not found then
      raise exception 'Stage C account % has no authorization state', v_account.id;
    end if;

    if v_state.authority_mode in ('legacy', 'shadow') then
      v_import := public._staxis_stage_b_import_legacy_scope(
        v_account.id, 'Access Stage C final contract import'
      );
      if coalesce((v_import->>'ok')::boolean, false) is not true then
        raise exception 'Stage C could not import account %: %', v_account.id, v_import;
      end if;
    else
      update public.account_authorization_state state
         set authority_mode = 'normalized',
             cutover_at = coalesce(state.cutover_at, clock_timestamp()),
             cutover_reason = coalesce(state.cutover_reason, 'Access Stage C final contract'),
             updated_at = clock_timestamp()
       where state.account_id = v_account.id;
      perform public._staxis_refresh_account_authorization(
        v_account.id, 'Access Stage C final contract normalization'
      );
    end if;

    v_canonical_ids := public._staxis_structural_account_property_ids(v_account.id);
    insert into public.account_access_cutover_final_receipts (
      account_id, preflight_run_id, source_property_ids, source_property_count,
      source_scope_hash, canonical_property_ids, canonical_property_count,
      bridge_count, details
    ) values (
      v_account.id, v_run_id, v_raw_ids, cardinality(v_raw_ids), v_hash,
      v_canonical_ids, cardinality(v_canonical_ids),
      (select count(*)::integer
       from public.account_property_authorization_bridges bridge
       where bridge.account_id = v_account.id and bridge.status = 'active'),
      jsonb_build_object('role', v_account.role, 'authUserId', v_account.data_user_id)
    )
    on conflict (account_id) do update
      set preflight_run_id = excluded.preflight_run_id,
          source_property_ids = excluded.source_property_ids,
          source_property_count = excluded.source_property_count,
          source_scope_hash = excluded.source_scope_hash,
          canonical_property_ids = excluded.canonical_property_ids,
          canonical_property_count = excluded.canonical_property_count,
          bridge_count = excluded.bridge_count,
          cleared_at = clock_timestamp(),
          details = excluded.details;
  end loop;

  -- No Stage A/B trigger may observe the clear or create a compatibility
  -- bridge.  Property lifecycle triggers remain intact for independent-hotel
  -- topology cleanup; only account-array observers are retired here.
  drop trigger if exists trg_accounts_zz_authorization_translate_legacy_property_access
    on public.accounts;
  drop trigger if exists trg_accounts_authorization_translate_legacy_property_access
    on public.accounts;
  drop trigger if exists trg_accounts_reconcile_legacy_organization_access
    on public.accounts;

  update public.accounts account
     set property_access = '{}'::uuid[]
   where cardinality(coalesce(account.property_access, '{}'::uuid[])) > 0;

  drop trigger if exists trg_accounts_final_legacy_property_access_fence
    on public.accounts;
  create trigger trg_accounts_final_legacy_property_access_fence
    before insert or update of property_access on public.accounts
    for each row execute function public._staxis_reject_final_legacy_property_access_write();

  update public.account_access_cutover_status
     set stage = 'C',
         enforcement_enabled = true,
         finalized_at = coalesce(finalized_at, clock_timestamp()),
         details = coalesce(details, '{}'::jsonb) || jsonb_build_object(
           'stage', 'C',
           'legacyArraysCleared', true,
           'legacyTranslatorRetired', true,
           'legacyImportRetired', true,
           'finalReceipts', (select count(*) from public.account_access_cutover_final_receipts),
           'preflightRunId', v_run_id
         )
   where id is true;
end
$finalize$;

-- Retire the Stage A/B translators, import seam, and shadow-only DTOs after
-- the finalizer has completed.  The old physical column is intentionally not
-- dropped: final receipts and the applied migration history remain rollback
-- evidence, while the trigger above makes the column inert and fail-closed.
drop function if exists public.staxis_translate_legacy_property_access(uuid, uuid[], text);
drop function if exists public._staxis_translate_legacy_property_access_trigger();
drop function if exists public._staxis_stage_a_should_run_legacy_reconciliation(uuid[]);
drop function if exists public._staxis_stage_b_validate_legacy_scope(uuid);
drop function if exists public._staxis_stage_b_import_legacy_scope(uuid, text);
drop function if exists public.staxis_people_access_shadow(uuid, uuid);
drop function if exists public.staxis_invite_access_shadow(uuid);
drop function if exists public.staxis_promote_shadow_authorization(uuid, text);

insert into public.applied_migrations (version, description)
values (
  '0426',
  'Access Stage C canonical-only contract, final receipts, array teardown, and fail-closed enforcement'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
