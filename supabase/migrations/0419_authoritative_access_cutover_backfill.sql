-- 0419_authoritative_access_cutover_backfill.sql
--
-- Stage A additive backfill. Proven legacy hotel rows receive an explicit,
-- topology-bound bridge, while accounts.property_access and all existing
-- projections remain intact and authoritative for the current application.

begin;

do $$
begin
  if to_regprocedure('public.staxis_preflight_authorization_cutover()') is null
     or to_regclass('public.account_access_cutover_preflight_runs') is null
     or to_regclass('public.account_property_authorization_bridges') is null
     or to_regprocedure('public._staxis_cutover_real_account_organizations()') is null
  then
    raise exception '0419 requires the 0418 Stage A preflight and 0378 bridge table';
  end if;
end
$$;

create table if not exists public.account_access_cutover_status (
  id                 boolean primary key default true check (id is true),
  stage              text not null default 'A' check (stage in ('A', 'B', 'C')),
  enforcement_enabled boolean not null default false,
  last_preflight_run_id uuid references public.account_access_cutover_preflight_runs(id),
  last_backfill_at   timestamptz,
  details            jsonb not null default '{}'::jsonb
);

revoke all on public.account_access_cutover_status from public, anon, authenticated, service_role;
alter table public.account_access_cutover_status enable row level security;

create table if not exists public.account_access_cutover_backfill_runs (
  id              uuid primary key default gen_random_uuid(),
  preflight_run_id uuid references public.account_access_cutover_preflight_runs(id),
  status          text not null check (status in ('completed', 'completed_with_skips', 'failed')),
  bridged_count   integer not null default 0 check (bridged_count >= 0),
  skipped_count   integer not null default 0 check (skipped_count >= 0),
  started_at      timestamptz not null default clock_timestamp(),
  completed_at    timestamptz,
  details         jsonb not null default '{}'::jsonb
);

-- Keep a read-only migration baseline so a later stage can prove that the
-- compatibility train did not silently rewrite or clear the legacy scope.
-- Subsequent application changes are expected and are recorded separately by
-- 0420; this table is the state that Stage A observed, not a second authority.
-- @rls: service-role-only — migration baselines contain cross-tenant legacy authorization scope and never leave server tooling.
create table if not exists public.account_access_cutover_legacy_snapshots (
  account_id          uuid primary key references public.accounts(id) on delete cascade,
  property_ids        uuid[] not null default '{}'::uuid[],
  property_count      integer not null default 0 check (property_count >= 0),
  property_scope_hash  text not null,
  captured_at         timestamptz not null default clock_timestamp()
);

revoke all on public.account_access_cutover_backfill_runs from public, anon, authenticated, service_role;
alter table public.account_access_cutover_backfill_runs enable row level security;
revoke all on public.account_access_cutover_legacy_snapshots from public, anon, authenticated, service_role;
alter table public.account_access_cutover_legacy_snapshots enable row level security;

comment on table public.account_access_cutover_status is
  'Stage A/B/C control record. Stage A leaves enforcement disabled and preserves legacy authority.';
comment on table public.account_access_cutover_backfill_runs is
  'Stage A additive bridge-backfill evidence. Skipped rows remain in the legacy array for explicit remediation; they are never guessed or dropped.';

do $$
declare
  v_preflight jsonb;
  v_preflight_run_id uuid;
  v_backfill_run_id uuid := gen_random_uuid();
  v_started_at timestamptz := clock_timestamp();
  v_now timestamptz := clock_timestamp();
  v_account_id uuid;
  v_property_id uuid;
  v_legacy_hash text;
  v_relationship_count integer;
  v_relationship_id uuid;
  v_organization_id uuid;
  v_organization_type text;
  v_bridged_count integer := 0;
  v_skipped_count integer := 0;
  v_reason text;
  v_preflight_issue_code text;
  v_preflight_issue_details jsonb;
begin
  insert into public.account_access_cutover_legacy_snapshots (
    account_id, property_ids, property_count, property_scope_hash
  )
  select account.id,
         coalesce(account.property_access, '{}'::uuid[]),
         cardinality(coalesce(account.property_access, '{}'::uuid[])),
         encode(sha256(convert_to(coalesce((
           select string_agg(property_id::text, ',' order by property_id::text)
           from unnest(coalesce(account.property_access, '{}'::uuid[])) property_id
         ), ''), 'UTF8')), 'hex')
  from public.accounts account
  on conflict (account_id) do nothing;

  v_preflight := public.staxis_preflight_authorization_cutover();
  v_preflight_run_id := nullif(v_preflight->>'runId', '')::uuid;
  if v_preflight_run_id is null then
    raise exception '0419 did not receive an exact 0418 preflight run id';
  end if;

  insert into public.account_access_cutover_backfill_runs (
    id, preflight_run_id, status, started_at
  ) values (
    v_backfill_run_id, v_preflight_run_id, 'completed', v_started_at
  );

  -- The legacy row remains the current authority. A bridge is copied only
  -- when its topology can be proven at this transaction's snapshot.
  for v_account_id, v_property_id in
    select account.id, legacy.property_id
    from public.accounts account
    cross join lateral unnest(coalesce(account.property_access, '{}'::uuid[]))
      legacy(property_id)
    order by account.id, legacy.property_id
  loop
    v_reason := null;
    v_preflight_issue_code := null;
    v_preflight_issue_details := null;

    -- The exact run created above is the source of truth for this backfill.
    -- Account-level issues (property_id IS NULL) poison every legacy row for
    -- that account; property-level issues poison only the matching row. This
    -- check deliberately precedes every repeated topology/account check so a
    -- later bridge can never be created for a row already deemed unresolved.
    select issue.issue_code, issue.details
      into v_preflight_issue_code, v_preflight_issue_details
    from public.account_access_cutover_preflight_issues issue
    where issue.run_id = v_preflight_run_id
      and issue.account_id = v_account_id
      and (issue.property_id is null or issue.property_id = v_property_id)
    -- Prefer the most fundamental matching property diagnosis when a
    -- malformed UUID also lacks governing topology. This keeps the retained
    -- reason deterministic while every matching issue still poisons the row.
    order by issue.property_id nulls first,
             case issue.issue_code
               when 'property_missing' then 0
               else 1
             end,
             issue.id
    limit 1;
    if found then
      v_reason := 'preflight_' || v_preflight_issue_code;
    end if;

    if v_reason is null then
      select state.legacy_scope_hash
        into v_legacy_hash
      from public.account_authorization_state state
      where state.account_id = v_account_id
      for update;
      if not found then
        v_reason := 'authorization_state_missing';
      elsif exists (
      select 1
      from public.accounts account
      where account.id = v_account_id
        and (account.active is not true or account.role = 'admin')
      ) then
        v_reason := 'inactive_or_platform_admin';
      elsif exists (
      select 1
      from public.account_authorization_state state
      where state.account_id = v_account_id
        and state.authority_mode = 'normalized'
      ) then
        -- A normalized account's residual array is not safe to interpret as a
        -- new grant. Stage A records it and leaves the current model untouched.
        v_reason := 'normalized_legacy_residue';
      elsif not exists (
      select 1 from public.properties property where property.id = v_property_id
      ) then
        v_reason := 'property_missing';
      else
      select count(*)::integer,
             (array_agg(relationship.id order by relationship.id))[1],
             (array_agg(relationship.organization_id order by relationship.id))[1],
             max(organization.organization_type)
        into v_relationship_count, v_relationship_id, v_organization_id,
             v_organization_type
      from public._staxis_current_primary_property_relationships() relationship
      join public.organizations organization
        on organization.id = relationship.organization_id
       and organization.status = 'active'
      where relationship.property_id = v_property_id
        and relationship.active_primary_count = 1;

        if v_relationship_count <> 1 then
          v_reason := case when v_relationship_count = 0
            then 'governing_topology_missing' else 'ambiguous_governing_topology' end;
        elsif v_organization_type is null then
          v_reason := 'invalid_governing_organization';
        elsif v_organization_type <> 'single_hotel'
          and exists (
            select 1
            from public._staxis_cutover_real_account_organizations() real_org
            where real_org.account_id = v_account_id
          )
          and not exists (
            select 1
            from public._staxis_cutover_real_account_organizations() real_org
            where real_org.account_id = v_account_id
              and real_org.organization_id = v_organization_id
          ) then
          v_reason := 'cross_company_legacy_access';
        elsif exists (
        select 1
        from public.account_property_authorization_bridges bridge
        where bridge.account_id = v_account_id
          and bridge.property_id = v_property_id
          and bridge.status = 'retired'
        ) then
          v_reason := 'retired_bridge_not_resurrected';
        end if;
      end if;
    end if;

    if v_reason is not null then
      v_skipped_count := v_skipped_count + 1;
      insert into public.account_access_cutover_preflight_issues (
        run_id, account_id, property_id, issue_code, details
      ) values (
        v_preflight_run_id, v_account_id, v_property_id,
        'backfill_skipped_' || v_reason,
        jsonb_build_object(
          'backfillRunId', v_backfill_run_id,
          'reason', v_reason,
          'preflightRunId', v_preflight_run_id,
          'preflightIssueCode', v_preflight_issue_code,
          'preflightIssueDetails', v_preflight_issue_details
        )
      );
      continue;
    end if;

    insert into public.account_property_authorization_bridges (
      account_id, property_id, cutover_organization_id,
      cutover_relationship_id, topology_bound_at,
      source_legacy_scope_hash, cutover_reason
    ) values (
      v_account_id, v_property_id, v_organization_id,
      v_relationship_id, v_now,
      coalesce(v_legacy_hash, encode(sha256(convert_to('', 'UTF8')), 'hex')),
      '0419 Stage A legacy hotel-access shadow bridge'
    )
    on conflict (account_id, property_id) where status = 'active' do nothing;
    if found then v_bridged_count := v_bridged_count + 1; end if;
  end loop;

  update public.account_access_cutover_backfill_runs
     set status = case when v_skipped_count = 0 then 'completed'
                       else 'completed_with_skips' end,
         bridged_count = v_bridged_count,
         skipped_count = v_skipped_count,
         completed_at = clock_timestamp(),
         details = jsonb_build_object(
           'stage', 'A',
           'legacyArraysPreserved', true,
           'legacyProjectionsPreserved', true,
           'preflight', v_preflight
         )
   where id = v_backfill_run_id;

  insert into public.account_access_cutover_status (
    id, stage, enforcement_enabled, last_preflight_run_id,
    last_backfill_at, details
  ) values (
    true, 'A', false, v_preflight_run_id, clock_timestamp(),
    jsonb_build_object('backfillRunId', v_backfill_run_id,
                       'bridgedCount', v_bridged_count,
                       'skippedCount', v_skipped_count,
                       'arraysPreserved', true,
                       'legacySnapshotCount', (
                         select count(*) from public.account_access_cutover_legacy_snapshots
                       ))
  )
  on conflict (id) do update
    set stage = 'A',
        enforcement_enabled = false,
        last_preflight_run_id = excluded.last_preflight_run_id,
        last_backfill_at = excluded.last_backfill_at,
        details = excluded.details;
end
$$;

insert into public.applied_migrations (version, description)
values (
  '0419',
  'Stage A additive topology-bound bridge backfill; unresolved rows are reported and legacy arrays/projections remain authoritative.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
