-- 0426_authoritative_access_stage_c_final_contract.sql
--
-- Final Access contract.  The preflight transaction commits first.  A second
-- transaction consumes an externally attested release receipt, then installs
-- canonical-only resolvers, normalizes proven legacy receipts, clears the
-- physical rollback arrays, retires the translators, and enables the final
-- write fence.  Any error in that second transaction rolls back the receipt
-- consumption and every authority mutation together.

do $requirements$
begin
  if to_regclass('public.account_access_cutover_status') is null
     or to_regclass('public.account_access_cutover_preflight_runs') is null
     or to_regprocedure('public._staxis_stage_b_import_legacy_scope(uuid,text)') is null
     or to_regprocedure('public._staxis_nonlegacy_property_authorizations(uuid)') is null
     or to_regprocedure('public._staxis_account_property_authorizations(uuid)') is null
     or to_regprocedure('public.staxis_assert_stage_a_access_invariants()') is null
     or not exists (
       select 1 from public.applied_migrations
       where version = '0425'
         and description = 'Restore missing canonical room identities for is_test properties through the lineage-complete service roster path'
     )
     or to_regprocedure('public.staxis_restore_test_room_roster(uuid,text[])') is null
     or to_regprocedure('public.staxis_create_test_property_with_roster(uuid,text,integer,text,text,text,text,text[])') is null
  then
    raise exception '0426 requires exact external 0425 plus the Stage B canonical access contracts';
  end if;
end
$requirements$;

alter table public.account_access_cutover_status
  add column if not exists final_preflight_run_id uuid
    references public.account_access_cutover_preflight_runs(id),
  add column if not exists finalized_at timestamptz;

-- The release receipt is a durable service-only control, not a report-only
-- preflight result.  The deployment/fencing owner supplies the values after
-- proving that the old deployment, jobs, and raw writers are frozen.  This
-- migration records that attestation and later consumes the exact receipt in
-- the same transaction as the destructive cutover; it does not infer or
-- invent external deployment state from a git SHA.
-- @rls: service-role-only — release controls are never browser-readable.
create table if not exists public.account_access_cutover_release_receipts (
  id                              uuid primary key default gen_random_uuid(),
  operator_label                  text not null
    check (char_length(btrim(operator_label)) between 1 and 200),
  access_b_merge_sha               text not null
    check (access_b_merge_sha = 'ec83bca6dab74a52dfb251d04be11d5c7427703f'),
  deployed_descendant_sha          text not null
    check (deployed_descendant_sha ~ '^[0-9a-f]{40}$'),
  attested_at                     timestamptz not null,
  preflight_run_id                uuid not null
    references public.account_access_cutover_preflight_runs(id),
  old_deployment_job              text not null
    check (char_length(btrim(old_deployment_job)) between 1 and 500),
  old_deployment_fence_evidence   text not null
    check (char_length(btrim(old_deployment_fence_evidence)) between 1 and 10000),
  old_deployment_fence_hash       text not null
    check (old_deployment_fence_hash ~ '^[0-9a-f]{64}$'),
  old_deployment_fence_nonce      text not null
    check (char_length(btrim(old_deployment_fence_nonce)) between 16 and 500),
  authorization_hash              text not null unique
    check (authorization_hash ~ '^[0-9a-f]{64}$'),
  status                          text not null default 'unconsumed'
    check (status in ('unconsumed', 'consumed')),
  consumed_at                     timestamptz,
  consumed_session_id             text,
  consumed_preflight_run_id       uuid,
  created_at                      timestamptz not null default clock_timestamp(),
  details                         jsonb not null default '{}'::jsonb
);

alter table public.account_access_cutover_release_receipts enable row level security;
revoke all on public.account_access_cutover_release_receipts
  from public, anon, authenticated, service_role;
drop policy if exists account_access_cutover_release_receipts_deny_browser
  on public.account_access_cutover_release_receipts;
create policy account_access_cutover_release_receipts_deny_browser
  on public.account_access_cutover_release_receipts
  for all to anon, authenticated using (false) with check (false);
grant select on public.account_access_cutover_release_receipts to service_role;

create or replace function public._staxis_reject_release_receipt_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Access Stage C release receipts are durable and cannot be deleted'
      using errcode = '42501';
  end if;
  if old.status = 'consumed' then
    raise exception 'Access Stage C release receipts are immutable after consumption'
      using errcode = '42501';
  end if;
  if old.status <> 'unconsumed'
     or new.status <> 'consumed'
     or row(old.id, old.operator_label, old.access_b_merge_sha,
            old.deployed_descendant_sha, old.attested_at, old.preflight_run_id,
            old.old_deployment_job, old.old_deployment_fence_evidence,
            old.old_deployment_fence_hash, old.old_deployment_fence_nonce,
            old.authorization_hash, old.created_at, old.details)
        is distinct from
        row(new.id, new.operator_label, new.access_b_merge_sha,
            new.deployed_descendant_sha, new.attested_at, new.preflight_run_id,
            new.old_deployment_job, new.old_deployment_fence_evidence,
            new.old_deployment_fence_hash, new.old_deployment_fence_nonce,
            new.authorization_hash, new.created_at, new.details)
     or new.consumed_at is null
     or nullif(btrim(new.consumed_session_id), '') is null
     or new.consumed_preflight_run_id is null then
    raise exception 'Access Stage C release receipt has an invalid mutation'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_reject_release_receipt_mutation()
  from public, anon, authenticated, service_role;
drop trigger if exists account_access_cutover_release_receipts_immutable
  on public.account_access_cutover_release_receipts;
create trigger account_access_cutover_release_receipts_immutable
  before update or delete on public.account_access_cutover_release_receipts
  for each row execute function public._staxis_reject_release_receipt_mutation();

create or replace function public.staxis_access_stage_c_record_release_receipt(
  p_operator_label text,
  p_access_b_merge_sha text,
  p_deployed_descendant_sha text,
  p_attested_at timestamptz,
  p_preflight_run_id uuid,
  p_old_deployment_job text,
  p_old_deployment_fence_evidence text,
  p_old_deployment_fence_hash text,
  p_old_deployment_fence_nonce text,
  p_authorization_value text,
  p_receipt_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid := coalesce(p_receipt_id, gen_random_uuid());
  v_authorization_hash text;
  v_preflight record;
  v_existing public.account_access_cutover_release_receipts%rowtype;
begin
  if nullif(btrim(p_operator_label), '') is null
     or char_length(btrim(p_operator_label)) > 200
     or lower(coalesce(p_access_b_merge_sha, '')) <> 'ec83bca6dab74a52dfb251d04be11d5c7427703f'
     or p_deployed_descendant_sha !~ '^[0-9a-f]{40}$'
     or p_attested_at is null
     or p_preflight_run_id is null
     or nullif(btrim(p_old_deployment_job), '') is null
     or char_length(btrim(p_old_deployment_job)) > 500
     or nullif(btrim(p_old_deployment_fence_evidence), '') is null
     or char_length(btrim(p_old_deployment_fence_evidence)) > 10000
     or nullif(btrim(p_old_deployment_fence_nonce), '') is null
     or char_length(btrim(p_old_deployment_fence_nonce)) < 16
     or char_length(btrim(p_old_deployment_fence_nonce)) > 500
     or nullif(p_authorization_value, '') is null
     or char_length(p_authorization_value) < 16
     or char_length(p_authorization_value) > 1000 then
    raise exception '0426 release receipt attestation is incomplete or has the wrong Access B SHA'
      using errcode = '22023';
  end if;
  select run.status, run.issue_count
    into v_preflight
  from public.account_access_cutover_preflight_runs run
  where run.id = p_preflight_run_id;
  if not found then
    raise exception '0426 release receipt references an unknown preflight run %', p_preflight_run_id
      using errcode = '22023';
  end if;
  if v_preflight.status <> 'passed' or coalesce(v_preflight.issue_count, 1) <> 0 then
    raise exception '0426 release receipt requires a passed preflight run (%, status %, issues %)',
      p_preflight_run_id, v_preflight.status, coalesce(v_preflight.issue_count, 1)
      using errcode = '22023';
  end if;

  v_authorization_hash := encode(
    pg_catalog.sha256(convert_to(p_authorization_value, 'UTF8')), 'hex'
  );
  if lower(p_old_deployment_fence_hash) <> encode(
       pg_catalog.sha256(convert_to(p_old_deployment_fence_evidence, 'UTF8')), 'hex'
     ) then
    raise exception '0426 release receipt fence hash does not match its evidence'
      using errcode = '22023';
  end if;

  select receipt.* into v_existing
  from public.account_access_cutover_release_receipts receipt
  where receipt.authorization_hash = v_authorization_hash
  for update;
  if found then
    if v_existing.status <> 'unconsumed'
       or v_existing.id <> v_id
       or v_existing.preflight_run_id <> p_preflight_run_id then
      raise exception '0426 release authorization has already been consumed or belongs to another run'
        using errcode = '55000';
    end if;
    return jsonb_build_object(
      'ok', true, 'receiptId', v_existing.id, 'status', v_existing.status,
      'idempotentReplay', true
    );
  end if;

  insert into public.account_access_cutover_release_receipts (
    id, operator_label, access_b_merge_sha, deployed_descendant_sha,
    attested_at, preflight_run_id, old_deployment_job,
    old_deployment_fence_evidence, old_deployment_fence_hash,
    old_deployment_fence_nonce, authorization_hash, details
  ) values (
    v_id, btrim(p_operator_label), lower(p_access_b_merge_sha),
    lower(p_deployed_descendant_sha), p_attested_at, p_preflight_run_id,
    btrim(p_old_deployment_job), btrim(p_old_deployment_fence_evidence),
    lower(p_old_deployment_fence_hash), btrim(p_old_deployment_fence_nonce),
    v_authorization_hash,
    jsonb_build_object(
      'attestationSource', 'external-deployment-owner',
      'accessBMergeSha', lower(p_access_b_merge_sha),
      'deployedDescendantSha', lower(p_deployed_descendant_sha),
      'writerFenceHash', lower(p_old_deployment_fence_hash)
    )
  );
  return jsonb_build_object(
    'ok', true, 'receiptId', v_id, 'status', 'unconsumed',
    'authorizationHash', v_authorization_hash
  );
end;
$$;

revoke all on function public.staxis_access_stage_c_record_release_receipt(
  text, text, text, timestamptz, uuid, text, text, text, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.staxis_access_stage_c_record_release_receipt(
  text, text, text, timestamptz, uuid, text, text, text, text, text, uuid
) to service_role;

create or replace function public.staxis_access_stage_c_release_receipt(
  p_receipt_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(to_jsonb(receipt), '{}'::jsonb)
  from public.account_access_cutover_release_receipts receipt
  where receipt.id = p_receipt_id;
$$;

revoke all on function public.staxis_access_stage_c_release_receipt(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_access_stage_c_release_receipt(uuid)
  to service_role;

create or replace function public.staxis_access_stage_c_consume_release()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_receipt_id uuid;
  v_token text;
  v_nonce text;
  v_run_id uuid;
  v_auth_hash text;
  v_receipt public.account_access_cutover_release_receipts%rowtype;
  v_preflight record;
  v_consumed_at timestamptz := clock_timestamp();
begin
  v_receipt_id := nullif(current_setting('staxis.access_stage_c_release_id', true), '')::uuid;
  v_token := nullif(current_setting('staxis.access_stage_c_release_token', true), '');
  v_nonce := nullif(current_setting('staxis.access_stage_c_release_nonce', true), '');
  select status.final_preflight_run_id into v_run_id
  from public.account_access_cutover_status status
  where status.id is true
  for update;
  if v_receipt_id is null or v_token is null or v_nonce is null or v_run_id is null then
    raise exception '0426 release gate requires a same-session receipt id, authorization token, nonce, and preflight run'
      using errcode = '55000';
  end if;

  select receipt.* into v_receipt
  from public.account_access_cutover_release_receipts receipt
  where receipt.id = v_receipt_id
  for update;
  if not found then
    raise exception '0426 release gate receipt % is missing', v_receipt_id
      using errcode = '55000';
  end if;
  if v_receipt.status <> 'unconsumed' then
    raise exception '0426 release gate receipt % was already consumed', v_receipt_id
      using errcode = '55000';
  end if;
  if v_receipt.preflight_run_id <> v_run_id then
    raise exception '0426 release gate receipt % does not match preflight run %', v_receipt_id, v_run_id
      using errcode = '55000';
  end if;
  select run.status, run.issue_count
    into v_preflight
  from public.account_access_cutover_preflight_runs run
  where run.id = v_run_id;
  if not found or v_preflight.status <> 'passed' or coalesce(v_preflight.issue_count, 1) <> 0 then
    raise exception '0426 release gate preflight run % is no longer clean', v_run_id
      using errcode = '55000';
  end if;
  if v_receipt.access_b_merge_sha <> 'ec83bca6dab74a52dfb251d04be11d5c7427703f'
     or v_receipt.deployed_descendant_sha !~ '^[0-9a-f]{40}$'
     or v_receipt.old_deployment_fence_nonce <> v_nonce
     or v_receipt.attested_at < v_consumed_at - interval '15 minutes'
     or v_receipt.attested_at > v_consumed_at + interval '5 minutes' then
    raise exception '0426 release gate receipt % is stale, fenced for another session, or has the wrong deployment evidence', v_receipt_id
      using errcode = '55000';
  end if;
  v_auth_hash := encode(pg_catalog.sha256(convert_to(v_token, 'UTF8')), 'hex');
  if v_auth_hash <> v_receipt.authorization_hash then
    raise exception '0426 release gate authorization token does not match receipt %', v_receipt_id
      using errcode = '55000';
  end if;

  update public.account_access_cutover_release_receipts receipt
     set status = 'consumed',
         consumed_at = v_consumed_at,
         consumed_session_id = pg_backend_pid()::text,
         consumed_preflight_run_id = v_run_id
   where receipt.id = v_receipt_id
     and receipt.status = 'unconsumed'
  returning receipt.* into v_receipt;
  if not found then
    raise exception '0426 release gate receipt % was consumed concurrently', v_receipt_id
      using errcode = '55000';
  end if;
  return jsonb_build_object(
    'ok', true, 'receiptId', v_receipt.id, 'status', v_receipt.status,
    'preflightRunId', v_receipt.preflight_run_id, 'consumedAt', v_receipt.consumed_at,
    'consumedSessionId', v_receipt.consumed_session_id
  );
end;
$$;

revoke all on function public.staxis_access_stage_c_consume_release()
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_access_stage_c_consume_release()
  to service_role;

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
  v_stage_a_invariant jsonb;
  v_stage_a_invariant_issue_count integer := 0;
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

  -- The Stage B importer intentionally refuses inactive accounts.  Make that
  -- handoff explicit here so the destructive finalizer can never discover it
  -- halfway through a cutover.
  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'inactive_legacy_account',
         jsonb_build_object(
           'active', account.active,
           'authorityMode', state.authority_mode,
           'propertyIds', to_jsonb(coalesce(account.property_access, '{}'::uuid[]))
         )
  from public.accounts account
  join public.account_authorization_state state on state.account_id = account.id
  where state.authority_mode in ('legacy', 'shadow')
    and account.active is not true;

  -- Admins have global role authority rather than a hotel-scoped bridge.  A
  -- legacy/shadow admin is therefore an explicit operator decision, including
  -- when its historical array is already empty.
  insert into public.account_access_cutover_preflight_issues (
    run_id, account_id, issue_code, details
  )
  select v_run_id, account.id, 'admin_legacy_account',
         jsonb_build_object(
           'authorityMode', state.authority_mode,
           'propertyIds', to_jsonb(coalesce(account.property_access, '{}'::uuid[]))
         )
  from public.accounts account
  join public.account_authorization_state state on state.account_id = account.id
  where state.authority_mode in ('legacy', 'shadow')
    and account.role = 'admin';

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

  -- These queues are still live two-phase mutations.  Freeze-and-forward must
  -- drain them before the final array fence so no request is stranded between
  -- the old writer and its canonical replacement.
  for v_invite in
    select request_row.* from public.join_requests request_row
    where request_row.status = 'pending'
    order by request_row.id
  loop
    insert into public.account_access_cutover_preflight_issues (
      run_id, account_id, property_id, issue_code, details
    ) values (
      v_run_id, v_invite.account_id, v_invite.property_id,
      'join_request_in_flight',
      jsonb_build_object('joinRequestId', v_invite.id)
    );
  end loop;

  for v_invite in
    select request_row.* from public.organization_access_requests request_row
    where request_row.status = 'pending'
    order by request_row.id
  loop
    insert into public.account_access_cutover_preflight_issues (
      run_id, issue_code, details
    ) values (
      v_run_id, 'organization_access_request_in_flight',
      jsonb_build_object(
        'requestId', v_invite.id,
        'organizationId', v_invite.organization_id,
        'membershipId', v_invite.membership_id,
        'scopeType', v_invite.scope_type,
        'propertyId', v_invite.property_id
      )
    );
  end loop;

  for v_invite in
    select invitation.* from public.organization_invitations invitation
    where invitation.status = 'pending'
    order by invitation.id
  loop
    insert into public.account_access_cutover_preflight_issues (
      run_id, issue_code, details
    ) values (
      v_run_id, 'organization_invitation_in_flight',
      jsonb_build_object(
        'invitationId', v_invite.id,
        'organizationId', v_invite.organization_id,
        'scopeType', v_invite.scope_type,
        'propertyId', v_invite.property_id
      )
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

  -- Stage A's independent invariant run is still the authoritative evidence
  -- for accepted-invite/shadow/bridge facts that predate this final contract.
  -- Fold any non-zero result into the strict Stage C gate rather than allowing
  -- the finalizer to guess which earlier anomaly is safe to retire.
  begin
    v_stage_a_invariant := public.staxis_assert_stage_a_access_invariants();
    v_stage_a_invariant_issue_count := coalesce((v_stage_a_invariant->>'issueCount')::integer, 1);
    if v_stage_a_invariant_issue_count <> 0 then
      insert into public.account_access_cutover_preflight_issues (
        run_id, issue_code, details
      ) values (
        v_run_id, 'stage_a_invariant_failure',
        jsonb_build_object(
          'stageAInvariantRunId', v_stage_a_invariant->>'runId',
          'stageAInvariantIssueCount', v_stage_a_invariant_issue_count,
          'stageAInvariant', v_stage_a_invariant
        )
      );
    end if;
  exception when others then
    insert into public.account_access_cutover_preflight_issues (
      run_id, issue_code, details
    ) values (
      v_run_id, 'stage_a_invariant_unavailable',
      jsonb_build_object('sqlstate', sqlstate, 'message', left(sqlerrm, 500))
    );
  end;

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

-- Named freeze-and-forward recovery evidence is installed before the strict
-- gate.  Operators can therefore record the failed run and remediation reason
-- even when preflight rejects the destructive finalization transaction.
create table if not exists public.account_access_cutover_recovery_actions (
  id                uuid primary key default gen_random_uuid(),
  preflight_run_id  uuid references public.account_access_cutover_preflight_runs(id) on delete set null,
  action            text not null check (action = 'freeze_and_forward'),
  operator_label    text not null check (char_length(btrim(operator_label)) between 1 and 200),
  reason            text not null check (char_length(btrim(reason)) between 1 and 2000),
  created_at        timestamptz not null default clock_timestamp(),
  details           jsonb not null default '{}'::jsonb
);

alter table public.account_access_cutover_recovery_actions enable row level security;
revoke all on public.account_access_cutover_recovery_actions
  from public, anon, authenticated, service_role;
drop policy if exists account_access_cutover_recovery_actions_deny_browser
  on public.account_access_cutover_recovery_actions;
create policy account_access_cutover_recovery_actions_deny_browser
  on public.account_access_cutover_recovery_actions
  for all to anon, authenticated using (false) with check (false);
grant select on public.account_access_cutover_recovery_actions to service_role;

create or replace function public.staxis_access_stage_c_freeze_and_forward(
  p_operator_label text,
  p_reason text,
  p_preflight_run_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_run_id uuid := p_preflight_run_id;
begin
  if nullif(btrim(p_operator_label), '') is null
     or char_length(btrim(p_operator_label)) > 200
     or nullif(btrim(p_reason), '') is null
     or char_length(btrim(p_reason)) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_recovery_evidence');
  end if;
  if v_run_id is null then
    select status.final_preflight_run_id
      into v_run_id
    from public.account_access_cutover_status status
    where status.id is true;
  end if;
  insert into public.account_access_cutover_recovery_actions (
    preflight_run_id, action, operator_label, reason, details
  ) values (
    v_run_id, 'freeze_and_forward', btrim(p_operator_label), btrim(p_reason),
    jsonb_build_object(
      'procedure', 'freeze-and-forward',
      'nextStep', 'repair the recorded preflight issue, drain the named queue, and rerun 0426',
      'authorityChanged', false
    )
  ) returning id into v_id;
  return jsonb_build_object(
    'ok', true,
    'action', 'freeze_and_forward',
    'receiptId', v_id,
    'preflightRunId', v_run_id,
    'authorityChanged', false
  );
end;
$$;

revoke all on function public.staxis_access_stage_c_freeze_and_forward(text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_access_stage_c_freeze_and_forward(text,text,uuid)
  to service_role;

create or replace function public.staxis_access_stage_c_recovery_evidence(
  p_preflight_run_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(jsonb_agg(to_jsonb(action_row) order by action_row.created_at, action_row.id), '[]'::jsonb)
  from public.account_access_cutover_recovery_actions action_row
  where p_preflight_run_id is null or action_row.preflight_run_id = p_preflight_run_id;
$$;

revoke all on function public.staxis_access_stage_c_recovery_evidence(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_access_stage_c_recovery_evidence(uuid)
  to service_role;

comment on function public.staxis_access_stage_c_freeze_and_forward(text,text,uuid) is
  'Named Access Stage C freeze-and-forward remediation procedure. Records durable operator evidence and never bypasses the 0426 strict preflight gate.';

-- Run and commit the preflight before the strict gate.  This deliberately uses
-- two transactions: a failed final gate must leave the issue rows available to
-- the operator rather than rolling the evidence back with the exception.
begin;
select public.staxis_preflight_authorization_cutover_stage_c();
commit;

-- Deployment procedure: apply the prefix through this marker, have the
-- deployment owner record the externally supplied service attestation with
-- staxis_access_stage_c_record_release_receipt(...) and set the three
-- staxis.access_stage_c_release_* session values, then execute the suffix in
-- that same service session.  The PGlite fixture pauses at this exact boundary
-- to exercise the same consumed receipt.  The migration never invents the
-- old-deployment/job/writer-fence evidence from a git SHA.
-- @access-stage-c-release-gate
begin;
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
  perform public.staxis_access_stage_c_consume_release();
end
$strict_gate$;

do $requirements$
begin
  if to_regclass('public.accounts') is null
     or to_regclass('public.properties') is null
     or to_regclass('public.account_authorization_state') is null
     or to_regclass('public.account_property_authorization_bridges') is null
     or to_regclass('public.account_property_staff_links') is null
     or to_regclass('public.account_invites') is null
     or to_regclass('public.account_lifecycle_intents') is null
     or not exists (
       select 1 from public.applied_migrations
       where version = '0425'
         and description = 'Restore missing canonical room identities for is_test properties through the lineage-complete service roster path'
     )
     or to_regprocedure('public.staxis_restore_test_room_roster(uuid,text[])') is null
     or to_regprocedure('public.staxis_create_test_property_with_roster(uuid,text,integer,text,text,text,text,text[])') is null
  then
    raise exception '0426 requires the externally shipped 0425 roster contract plus accounts, canonical authority, People, invites, and lifecycle tables';
  end if;
end
$requirements$;

-- After the one-way clear, a canonical account insert omits this historical
-- column and receives NULL.  That lets the trigger distinguish the canonical
-- default from an explicit `property_access = '{}'` write, which must be
-- rejected just like every non-empty compatibility write.
alter table public.accounts
  alter column property_access drop not null,
  alter column property_access set default null;

-- A durable final receipt is the only retained copy of an account's former
-- raw hotel list.  It is service-only, immutable by convention, and includes
-- the canonical result that was actually installed before the array was
-- cleared.  The pre-existing Stage A snapshot and write-event tables remain
-- intact as earlier evidence.
-- @rls: service-role-only — immutable cutover receipts are exposed only through the approved service remediation RPC.
create table if not exists public.account_access_cutover_final_receipts (
  -- Deliberately no ON DELETE action: this is durable evidence and must remain
  -- readable through the approved service remediation seam after account
  -- cleanup or GDPR deletion.
  -- Deliberately opaque after cleanup; do not add a foreign key to accounts.
  account_id             uuid primary key,
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

create or replace function public._staxis_reject_final_receipt_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'Access Stage C final receipts are immutable'
    using errcode = '42501';
end;
$$;

revoke all on function public._staxis_reject_final_receipt_mutation()
  from public, anon, authenticated, service_role;
drop trigger if exists account_access_cutover_final_receipts_immutable
  on public.account_access_cutover_final_receipts;
create trigger account_access_cutover_final_receipts_immutable
  before update or delete on public.account_access_cutover_final_receipts
  for each row execute function public._staxis_reject_final_receipt_mutation();

comment on table public.account_access_cutover_final_receipts is
  'Stage C immutable service-only receipts. The former property_access array is cleared after the proven canonical result and receipt are written.';

create or replace function public.staxis_access_stage_c_final_receipt(
  p_account_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(to_jsonb(receipt), '{}'::jsonb)
  from public.account_access_cutover_final_receipts receipt
  where receipt.account_id = p_account_id;
$$;

revoke all on function public.staxis_access_stage_c_final_receipt(uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_access_stage_c_final_receipt(uuid)
  to service_role;

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

-- Nudge delivery is an application runtime reader. Its final projection uses
-- the canonical resolver for both default and explicit recipients; the old
-- legacy-array candidate arm is intentionally gone.
create or replace function public.staxis_list_property_nudge_recipients(
  p_property_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_subscription jsonb;
  v_mode text := 'default';
  v_candidate_ids uuid[] := '{}'::uuid[];
  v_recipient_ids uuid[] := '{}'::uuid[];
  v_candidate_id uuid;
  v_candidate_limit constant integer := 128;
  v_recipient_limit constant integer := 64;
begin
  if p_property_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_property');
  end if;
  select property.nudge_subscription into v_subscription
  from public.properties property
  where property.id = p_property_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'property_not_found');
  end if;
  if v_subscription is not null
     and pg_catalog.jsonb_typeof(v_subscription) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_subscription');
  end if;
  if v_subscription ? 'enabled'
     and pg_catalog.jsonb_typeof(v_subscription->'enabled') <> 'boolean' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_subscription');
  end if;
  if coalesce((v_subscription->>'enabled')::boolean, true) is false then
    return jsonb_build_object(
      'ok', true, 'propertyId', p_property_id, 'subscriptionMode', 'disabled',
      'recipientAccountIds', '[]'::jsonb, 'candidateCount', 0,
      'recipientLimit', v_recipient_limit
    );
  end if;

  if v_subscription ? 'recipient_account_ids' then
    if pg_catalog.jsonb_typeof(v_subscription->'recipient_account_ids') <> 'array'
       or pg_catalog.jsonb_array_length(v_subscription->'recipient_account_ids') > v_recipient_limit then
      return jsonb_build_object('ok', false, 'reason', 'invalid_subscription');
    end if;
    if pg_catalog.jsonb_array_length(v_subscription->'recipient_account_ids') > 0 then
      v_mode := 'explicit';
      begin
        select coalesce(array_agg(distinct recipient.value::uuid order by recipient.value::uuid), '{}'::uuid[])
          into v_candidate_ids
        from pg_catalog.jsonb_array_elements_text(v_subscription->'recipient_account_ids') recipient(value);
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'reason', 'invalid_subscription');
      end;
    end if;
  end if;

  if v_mode = 'default' then
    select coalesce(array_agg(candidate.id order by candidate.id), '{}'::uuid[])
      into v_candidate_ids
    from (
      select account.id
      from public.accounts account
      where account.active is true
        and account.role in ('owner', 'general_manager')
        and public._staxis_account_is_current_nudge_recipient(account.id, p_property_id)
      order by account.id
      limit v_candidate_limit + 1
    ) candidate;
    if cardinality(v_candidate_ids) > v_candidate_limit then
      return jsonb_build_object(
        'ok', false, 'reason', 'candidate_limit_exceeded',
        'candidateLimit', v_candidate_limit
      );
    end if;
  end if;

  foreach v_candidate_id in array v_candidate_ids
  loop
    if public._staxis_account_is_current_nudge_recipient(v_candidate_id, p_property_id) then
      v_recipient_ids := array_append(v_recipient_ids, v_candidate_id);
      if cardinality(v_recipient_ids) > v_recipient_limit then
        return jsonb_build_object(
          'ok', false, 'reason', 'recipient_limit_exceeded',
          'recipientLimit', v_recipient_limit
        );
      end if;
    end if;
  end loop;
  return jsonb_build_object(
    'ok', true, 'propertyId', p_property_id, 'subscriptionMode', v_mode,
    'recipientAccountIds', to_jsonb(v_recipient_ids),
    'candidateCount', cardinality(v_candidate_ids), 'recipientLimit', v_recipient_limit
  );
end;
$$;

revoke all on function public.staxis_list_property_nudge_recipients(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_list_property_nudge_recipients(uuid)
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

create or replace function public.user_owns_property(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.staxis_account_reaches_property(auth.uid(), p_id);
$$;

comment on function public.user_owns_property(uuid) is
  'Final canonical per-property RLS gate. It delegates only to normalized memberships, grants, and topology-bound bridges.';

revoke all on function public.user_owns_property(uuid) from public;
grant execute on function public.user_owns_property(uuid)
  to anon, authenticated, service_role;

-- First-person onboarding must retain its direct-customer distinction after
-- the array is cleared. Company-wide inheritance is deliberately excluded;
-- only a property-scoped hat/grant or a valid bridge makes this hotel look
-- claimed.
create or replace function public._staxis_hotel_has_direct_customer_account(
  p_hotel_id uuid
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
    join public.account_authorization_state state
      on state.account_id = account.id
     and state.authority_mode = 'normalized'
    where account.role <> 'admin'
      and account.active is true
      and exists (
        select 1
        from public._staxis_account_property_authorizations(account.id) authz
        where authz.property_id = p_hotel_id
          and (
            (authz.entitlement_kind = 'membership_hat'
             and authz.scope_type = 'property')
            or (authz.entitlement_kind = 'access_grant'
                and authz.scope_type = 'property')
            or authz.entitlement_kind = 'legacy_bridge'
          )
      )
  );
$$;

revoke all on function public._staxis_hotel_has_direct_customer_account(uuid)
  from public, anon, authenticated, service_role;

-- Platform-admin scope editing remains the same RPC contract used by the
-- account-admin API, but its final implementation never imports or writes a
-- legacy array. The request's property_ids are canonical bridge targets and
-- the returned access document is generated by the final resolver.
create or replace function public.staxis_set_account_authorization_scope(
  p_actor_account_id uuid,
  p_account_id uuid,
  p_property_ids uuid[],
  p_expected_authority_version bigint,
  p_expected_role text,
  p_new_role text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_requested uuid[] := '{}'::uuid[];
  v_property_id uuid;
  v_relationship_id uuid;
  v_organization_id uuid;
  v_raw_relationship_count integer;
  v_valid_relationship_count integer;
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'Platform-admin canonical scope mutation'), 500);
  v_access jsonb;
begin
  if p_actor_account_id is null
     or p_account_id is null
     or p_property_ids is null
     or p_new_role is null
     or p_new_role not in (
       'admin', 'owner', 'general_manager', 'front_desk',
       'housekeeping', 'maintenance', 'staff'
     )
     or p_expected_role is null
  then
    return jsonb_build_object('ok', false, 'status', 'invalid', 'reason', 'request');
  end if;
  if array_position(p_property_ids, null) is not null
     or cardinality(p_property_ids) > 5000
     or cardinality(p_property_ids) <> cardinality(array(
       select distinct id from unnest(p_property_ids) ids(id)
     ))
  then
    return jsonb_build_object('ok', false, 'status', 'invalid', 'reason', 'property_ids');
  end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[])
    into v_requested
  from (select distinct id from unnest(p_property_ids) ids(id)) sorted_ids;
  if p_new_role = 'admin' and cardinality(v_requested) > 0 then
    return jsonb_build_object('ok', false, 'status', 'invalid', 'reason', 'admin_scope');
  end if;

  perform 1
  from public.accounts account
  where account.id = any(array[p_actor_account_id, p_account_id])
  order by account.id
  for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_account from public.accounts where id = p_account_id;
  select * into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id
  for update;
  if v_actor.id is null or v_account.id is null or v_state.account_id is null then
    return jsonb_build_object('ok', false, 'status', 'not_found');
  end if;
  if v_actor.active is not true or v_actor.role <> 'admin' then
    return jsonb_build_object('ok', false, 'status', 'forbidden', 'reason', 'actor');
  end if;
  if v_account.role is distinct from p_expected_role
     or (p_expected_authority_version is not null
         and v_state.authority_version is distinct from p_expected_authority_version)
  then
    return jsonb_build_object(
      'ok', false, 'status', 'conflict',
      'authorityVersion', v_state.authority_version
    );
  end if;
  if v_state.authority_mode <> 'normalized' then
    return jsonb_build_object('ok', false, 'status', 'conflict', 'reason', 'final_authority_not_normalized');
  end if;

  begin
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
      return jsonb_build_object('ok', false, 'status', 'retry');
  end;

  foreach v_property_id in array v_requested
  loop
    begin
      perform 1
      from public.properties property
      where property.id = v_property_id
      for update nowait;
      if not found then
        return jsonb_build_object('ok', false, 'status', 'conflict', 'reason', 'property_missing');
      end if;
      perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
    exception
      when lock_not_available or deadlock_detected then
        return jsonb_build_object('ok', false, 'status', 'retry');
    end;

    select count(*)::integer into v_raw_relationship_count
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id;
    if v_raw_relationship_count <> 1 then
      return jsonb_build_object(
        'ok', false, 'status', 'conflict',
        'reason', case when v_raw_relationship_count = 0
          then 'governing_topology_missing' else 'ambiguous_governing_topology' end,
        'propertyId', v_property_id
      );
    end if;
    select count(*)::integer,
           (array_agg(relationship.id order by relationship.id))[1],
           (array_agg(relationship.organization_id order by relationship.id))[1]
      into v_valid_relationship_count, v_relationship_id, v_organization_id
    from public._staxis_cutover_valid_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id
      and relationship.active_primary_count = 1;
    if v_valid_relationship_count <> 1 then
      return jsonb_build_object(
        'ok', false, 'status', 'conflict',
        'reason', 'invalid_governing_organization', 'propertyId', v_property_id
      );
    end if;
    if exists (
      select 1
      from public.account_property_authorization_bridges bridge
      where bridge.account_id = p_account_id
        and bridge.property_id = v_property_id
        and bridge.status = 'retired'
    ) then
      return jsonb_build_object(
        'ok', false, 'status', 'conflict',
        'reason', 'retired_bridge', 'propertyId', v_property_id
      );
    end if;
  end loop;

  if v_account.role is distinct from p_new_role then
    update public.accounts account
       set role = p_new_role
     where account.id = p_account_id;
  end if;

  update public.account_property_authorization_bridges bridge
     set status = 'retired',
         retired_at = clock_timestamp(),
         retirement_reason = left('Canonical scope removed by platform admin: ' || v_reason, 500)
   where bridge.account_id = p_account_id
     and bridge.status = 'active'
     and not (bridge.property_id = any(v_requested));

  if p_new_role <> 'admin' then
    foreach v_property_id in array v_requested
    loop
      select relationship.id, relationship.organization_id
        into v_relationship_id, v_organization_id
      from public._staxis_cutover_valid_current_primary_property_relationships() relationship
      where relationship.property_id = v_property_id
        and relationship.active_primary_count = 1;
      insert into public.account_property_authorization_bridges (
        account_id, property_id, cutover_organization_id,
        cutover_relationship_id, source_legacy_scope_hash, cutover_reason
      ) values (
        p_account_id, v_property_id, v_organization_id,
        v_relationship_id, encode(sha256(convert_to(array_to_string(v_requested, ','), 'UTF8')), 'hex'),
        v_reason
      )
      on conflict (account_id, property_id) where status = 'active' do nothing;
    end loop;
  end if;

  perform public._staxis_refresh_account_authorization(
    p_account_id, 'Access Stage C canonical account scope mutation'
  );
  select state.authority_version into v_state.authority_version
  from public.account_authorization_state state
  where state.account_id = p_account_id;
  if v_account.active is true then
    v_access := public.staxis_list_account_authorized_properties(p_account_id);
  else
    v_access := jsonb_build_object(
      'ok', true, 'all', p_new_role = 'admin',
      'propertyIds', to_jsonb(v_requested)
    );
  end if;
  return jsonb_build_object(
    'ok', true,
    'status', 'updated',
    'accountId', p_account_id,
    'role', p_new_role,
    'authorityVersion', v_state.authority_version,
    'access', v_access
  );
end;
$$;

revoke all on function public.staxis_set_account_authorization_scope(
  uuid, uuid, uuid[], bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.staxis_set_account_authorization_scope(
  uuid, uuid, uuid[], bigint, text, text, text
) to service_role;

-- Canonical relationship bootstrap used by normal property creation and the
-- admin organization-assignment route. It keeps the established status/error
-- behavior while retiring the 0325 legacy-array reconciler.
create or replace function public.staxis_set_primary_property_organization(
  p_actor_account_id uuid,
  p_property_id uuid,
  p_organization_id uuid,
  p_relationship_type text default 'operator'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_relationship_id uuid;
  v_anchor_organization_id uuid;
  v_current_primary_ids uuid[] := '{}'::uuid[];
  v_property_name text;
  v_now timestamptz := clock_timestamp();
  v_active_primary_count integer := 0;
  v_target_relationship_count integer := 0;
begin
  if not exists (
    select 1 from public.accounts actor
    where actor.id = p_actor_account_id
      and actor.role = 'admin'
      and actor.active is true
  ) then
    raise exception 'only a Staxis administrator may move a hotel between organizations'
      using errcode = '42501';
  end if;
  if p_relationship_type not in ('operator', 'owner') then
    raise exception 'primary relationship type must be operator or owner'
      using errcode = '22023';
  end if;

  select property.name into v_property_name
  from public.properties property
  where property.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));
  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);

  if p_organization_id is not null and not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.status = 'active'
      and organization.organization_type <> 'single_hotel'
  ) then
    raise exception 'target organization is unavailable or is a system-managed single-hotel anchor'
      using errcode = '23503';
  end if;

  select count(*)::integer into v_active_primary_count
  from public.organization_property_relationships relationship
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= v_now
    and (relationship.ends_at is null or relationship.ends_at > v_now);
  if v_active_primary_count > 1 then
    raise exception 'hotel has multiple active primary relationships; repair is required before transfer'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.organization_property_relationships relationship
    where relationship.property_id = p_property_id
      and relationship.is_primary_grouping is true
      and relationship.relationship_type in ('operator', 'owner')
      and relationship.starts_at > v_now
      and (relationship.ends_at is null or relationship.ends_at > relationship.starts_at)
  ) then
    raise exception 'hotel has a scheduled future primary relationship; repair is required before transfer'
      using errcode = '23514';
  end if;

  if p_organization_id is null then
    insert into public.organizations (
      name, organization_type, status, legacy_property_id, created_by_account_id
    ) values (
      coalesce(nullif(btrim(v_property_name), ''), 'Independent hotel'),
      'single_hotel', 'active', p_property_id, p_actor_account_id
    ) on conflict (legacy_property_id) do nothing;
    select organization.id into v_anchor_organization_id
    from public.organizations organization
    where organization.organization_type = 'single_hotel'
      and organization.legacy_property_id = p_property_id
    for update;
    if v_anchor_organization_id is null then
      raise exception 'independent hotel anchor is unavailable' using errcode = '23514';
    end if;
    insert into public.organization_property_relationships (
      organization_id, property_id, relationship_type, is_primary_grouping,
      created_by_account_id, updated_by_account_id
    ) values (
      v_anchor_organization_id, p_property_id, 'operator', false,
      p_actor_account_id, p_actor_account_id
    ) on conflict do nothing;
  end if;

  select coalesce(array_agg(relationship.id order by relationship.id), '{}'::uuid[])
    into v_current_primary_ids
  from public.organization_property_relationships relationship
  join public.organizations organization on organization.id = relationship.organization_id
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= v_now
    and (relationship.ends_at is null or relationship.ends_at > v_now)
    and (
      p_organization_id is null
      or relationship.organization_id <> p_organization_id
      or relationship.relationship_type <> p_relationship_type
      or organization.organization_type = 'single_hotel'
    );

  if cardinality(v_current_primary_ids) > 0 then
    update public.organization_access_grants grant_row
       set status = 'revoked', revoked_at = v_now,
           revoked_by_account_id = p_actor_account_id,
           revocation_reason = 'Hotel relationship ended',
           version = grant_row.version + 1
     where grant_row.property_relationship_id = any(v_current_primary_ids)
       and grant_row.status = 'active';
    update public.organization_invitations invitation
       set status = 'revoked', revoked_at = v_now,
           revoked_by_account_id = p_actor_account_id
     where invitation.property_relationship_id = any(v_current_primary_ids)
       and invitation.status = 'pending';
    update public.organization_access_requests request_row
       set status = 'cancelled', reviewed_at = v_now,
           reviewed_by_account_id = p_actor_account_id,
           review_note = 'Hotel relationship ended before review',
           resulting_grant_id = null
     where request_row.property_relationship_id = any(v_current_primary_ids)
       and request_row.status = 'pending';
    delete from public.portfolio_properties assignment
     where assignment.property_relationship_id = any(v_current_primary_ids)
       and assignment.removed_at is null
       and assignment.assigned_at >= v_now;
    update public.portfolio_properties assignment
       set removed_at = v_now, removed_by_account_id = p_actor_account_id
     where assignment.property_relationship_id = any(v_current_primary_ids)
       and assignment.removed_at is null
       and assignment.assigned_at < v_now;
    update public.organization_property_relationships relationship
       set starts_at = least(relationship.starts_at, v_now - interval '1 microsecond'),
           ends_at = v_now, updated_by_account_id = p_actor_account_id,
           is_primary_grouping = false
     where relationship.id = any(v_current_primary_ids);
  end if;

  if p_organization_id is null then
    select relationship.id into v_relationship_id
    from public.organization_property_relationships relationship
    where relationship.organization_id = v_anchor_organization_id
      and relationship.property_id = p_property_id
      and relationship.relationship_type = 'operator'
      and relationship.starts_at <= v_now
      and (relationship.ends_at is null or relationship.ends_at > v_now)
    order by relationship.starts_at desc, relationship.id
    limit 1
    for update;
    if v_relationship_id is null then
      raise exception 'independent hotel anchor relationship is unavailable' using errcode = '23514';
    end if;
    update public.organization_property_relationships relationship
       set is_primary_grouping = true, ends_at = null,
           starts_at = least(relationship.starts_at, v_now),
           updated_by_account_id = p_actor_account_id
     where relationship.id = v_relationship_id;
    v_relationship_id := null;
  else
    select count(*)::integer into v_target_relationship_count
    from public.organization_property_relationships relationship
    where relationship.organization_id = p_organization_id
      and relationship.property_id = p_property_id
      and relationship.relationship_type = p_relationship_type
      and relationship.starts_at <= v_now
      and (relationship.ends_at is null or relationship.ends_at > v_now);
    if v_target_relationship_count > 1 then
      raise exception 'target company has multiple active relationships for this hotel' using errcode = '23514';
    end if;
    select relationship.id into v_relationship_id
    from public.organization_property_relationships relationship
    where relationship.organization_id = p_organization_id
      and relationship.property_id = p_property_id
      and relationship.relationship_type = p_relationship_type
      and relationship.starts_at <= v_now
      and (relationship.ends_at is null or relationship.ends_at > v_now)
    for update;
    if v_relationship_id is null then
      insert into public.organization_property_relationships (
        organization_id, property_id, relationship_type, is_primary_grouping,
        created_by_account_id, updated_by_account_id
      ) values (
        p_organization_id, p_property_id, p_relationship_type, true,
        p_actor_account_id, p_actor_account_id
      ) returning id into v_relationship_id;
    else
      update public.organization_property_relationships relationship
         set is_primary_grouping = true, ends_at = null,
             starts_at = least(relationship.starts_at, v_now),
             updated_by_account_id = p_actor_account_id
       where relationship.id = v_relationship_id;
    end if;
  end if;

  select count(*)::integer into v_active_primary_count
  from public.organization_property_relationships relationship
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= v_now
    and (relationship.ends_at is null or relationship.ends_at > v_now);
  if v_active_primary_count <> 1 then
    raise exception 'hotel must have exactly one active primary relationship after transfer'
      using errcode = '23514';
  end if;
  return v_relationship_id;
end;
$$;

revoke all on function public.staxis_set_primary_property_organization(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_set_primary_property_organization(uuid, uuid, uuid, text)
  to service_role;

-- Actor-bound hotel detach. The route keeps its stable status/error envelope;
-- only the entitlement mutation is now canonical and final-authority-only.
create or replace function public.staxis_remove_property_access_authoritative(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_account_id uuid,
  p_hotel_id uuid,
  p_expected_role text,
  p_expected_authority_version bigint,
  p_expected_updated_at timestamptz,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_access jsonb;
  v_target_ids uuid[] := '{}'::uuid[];
  v_remaining integer := 0;
  v_actor_role text;
  v_authority_changed boolean := false;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_account_id is null or p_hotel_id is null
     or p_expected_role is null or p_expected_updated_at is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_actor_account_id = p_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;

  perform 1 from public.accounts account
   where account.id = any(array[p_actor_account_id, p_account_id])
   order by account.id for update;
  perform 1 from public.account_authorization_state state
   where state.account_id = any(array[p_actor_account_id, p_account_id])
   order by state.account_id for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_account_id;
  select * into v_actor_state from public.account_authorization_state where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state where account_id = p_account_id;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
    where intent.status = 'pending'
      and intent.account_id = any(array[p_actor_account_id, p_account_id])
  ) then
    return jsonb_build_object('status', 'pending_conflict');
  end if;
  begin
    lock table public.capability_overrides,
               public.organizations,
               public.organization_property_relationships,
               public.organization_memberships,
               public.organization_access_grants,
               public.portfolios,
               public.portfolio_properties,
               public.account_property_authorization_bridges
      in share mode nowait;
    perform 1 from public.properties property where property.id = p_hotel_id for update nowait;
    if not found then return jsonb_build_object('status', 'not_found', 'reason', 'hotel_scope'); end if;
    perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));
  exception
    when lock_not_available or deadlock_detected then
      return jsonb_build_object('status', 'retry');
  end;
  if v_actor.active is not true or v_actor.data_user_id is distinct from p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if v_target.active is not true or v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target');
  end if;
  if public._staxis_account_is_live_organization_owner(v_target.id) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'organization_owner');
  end if;
  if v_target.role is distinct from p_expected_role
     or v_target.updated_at is distinct from p_expected_updated_at
     or (p_expected_authority_version is not null
         and v_target_state.authority_version is distinct from p_expected_authority_version)
  then
    return jsonb_build_object('status', 'conflict');
  end if;
  if v_target_state.authority_mode <> 'normalized' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'final_authority_not_normalized');
  end if;
  if not public._staxis_account_can_manage_users_at_property(p_actor_account_id, p_hotel_id) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
  end if;
  if v_actor.role <> 'admin' and v_target.role = 'general_manager' then
    v_actor_role := public._staxis_account_operational_role_at_property(v_actor.id, p_hotel_id);
    if not public._staxis_account_has_company_manager_hierarchy_at_property(v_actor.id, p_hotel_id)
       and v_actor_role <> 'owner' then
      return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
    end if;
  end if;
  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  if coalesce((v_access->>'ok')::boolean, false) is not true then
    return jsonb_build_object('status', 'forbidden', 'reason', 'authority_unavailable');
  end if;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_target_ids
  from jsonb_array_elements_text(coalesce(v_access->'propertyIds', '[]'::jsonb)) value;
  if not (p_hotel_id = any(v_target_ids)) then
    return jsonb_build_object('status', 'not_attached');
  end if;

  -- Company/property memberships are canonical authority too, but do not
  -- materialize an account_property_authorization_bridges row.  Remove the
  -- detached hotel from every active property-scoped membership first, revoke
  -- any matching property grant, and retain the historical membership row.
  update public.organization_memberships membership
     set covered_property_ids = array(
           select distinct covered.property_id
           from unnest(coalesce(membership.covered_property_ids, '{}'::uuid[])) covered(property_id)
           where covered.property_id <> p_hotel_id
           order by covered.property_id
         ),
         updated_at = clock_timestamp()
   where membership.account_id = p_account_id
     and membership.membership_scope = 'property'
     and membership.status = 'active'
     and membership.ended_at is null
     and p_hotel_id = any(coalesce(membership.covered_property_ids, '{}'::uuid[]));
  if found then
    v_authority_changed := true;
    update public.organization_memberships membership
       set status = 'revoked',
           ended_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where membership.account_id = p_account_id
       and membership.membership_scope = 'property'
       and membership.status = 'active'
       and membership.ended_at is null
       and cardinality(coalesce(membership.covered_property_ids, '{}'::uuid[])) = 0;
  end if;
  update public.organization_access_grants grant_row
     set status = 'revoked',
         revoked_at = clock_timestamp(),
         revoked_by_account_id = p_actor_account_id,
         revocation_reason = left(
           'Canonical hotel detach: ' || coalesce(nullif(btrim(p_request_id), ''), 'request'), 500
         ),
         version = grant_row.version + 1
    from public.organization_memberships membership
   where grant_row.membership_id = membership.id
     and membership.account_id = p_account_id
     and grant_row.property_id = p_hotel_id
     and grant_row.status = 'active';
  if found then
    v_authority_changed := true;
  end if;

  if not exists (
    select 1 from public.account_property_authorization_bridges bridge
    where bridge.account_id = p_account_id
      and bridge.property_id = p_hotel_id
      and bridge.status = 'active'
  ) then
    if not v_authority_changed then
      return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority');
    end if;
  else
    update public.account_property_authorization_bridges bridge
       set status = 'retired', retired_at = clock_timestamp(),
           retirement_reason = left(
             'Canonical hotel detach: ' || coalesce(nullif(btrim(p_request_id), ''), 'request'), 500
           )
     where bridge.account_id = p_account_id
       and bridge.property_id = p_hotel_id
       and bridge.status = 'active';
    v_authority_changed := true;
  end if;
  perform public._staxis_refresh_account_authorization(p_account_id, 'Access Stage C canonical hotel detach');
  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  v_remaining := jsonb_array_length(coalesce(v_access->'propertyIds', '[]'::jsonb));
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''),
    'account.team_detach', 'account', p_account_id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id, 'remaining_hotels', v_remaining,
      'authority_mode', 'normalized', 'request_id', p_request_id
    )
  );
  return jsonb_build_object(
    'status', 'ok', 'remaining_hotels', v_remaining,
    'audit_written', true, 'authorityVersion', (v_access->>'authorityVersion')::bigint
  );
end;
$$;

revoke all on function public.staxis_remove_property_access_authoritative(
  uuid, uuid, text, uuid, uuid, text, bigint, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.staxis_remove_property_access_authoritative(
  uuid, uuid, text, uuid, uuid, text, bigint, timestamptz, text
) to service_role;

-- Canonical property deletion/rollback.  The old 0325 primitive classified
-- accounts from the raw array, which made a Stage C rollback either leak a
-- customer account or delete the wrong identity.  This replacement derives
-- scope from the same canonical structural resolver used by People and keeps
-- the 0425 test-room/PMS lineage rows inside the property transaction.
create or replace function public.staxis_delete_property_and_legacy_accounts(
  p_actor_account_id uuid,
  p_property_id uuid,
  p_confirmed_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_name text;
  v_onboarding_completed_at timestamptz;
  v_auth_user_ids uuid[] := '{}'::uuid[];
  v_accounts_to_remove uuid[] := '{}'::uuid[];
  v_accounts_removed integer := 0;
  v_accounts_pruned integer := 0;
  v_account record;
  v_scope_ids uuid[];
  v_has_company_scope boolean;
begin
  perform 1 from public.accounts account order by account.id for update;

  if not exists (
    select 1 from public.accounts actor
    where actor.id = p_actor_account_id and actor.role = 'admin' and actor.active is true
  ) then
    raise exception 'only an active Staxis administrator may delete a hotel'
      using errcode = '42501';
  end if;

  select property.name, property.onboarding_completed_at
    into v_property_name, v_onboarding_completed_at
  from public.properties property
  where property.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;
  if nullif(btrim(p_confirmed_name), '') is not null
     and lower(btrim(p_confirmed_name)) <> lower(btrim(v_property_name)) then
    raise exception 'confirmed hotel name does not match the locked hotel name'
      using errcode = '23514';
  end if;
  if v_onboarding_completed_at is not null
     and nullif(btrim(p_confirmed_name), '') is null then
    raise exception 'hotel completed onboarding and requires explicit confirmation'
      using errcode = '23514';
  end if;

  for v_account in
    select account.id, account.role, account.data_user_id
    from public.accounts account
    where account.role <> 'admin'
    order by account.id
  loop
    v_scope_ids := public._staxis_structural_account_property_ids(v_account.id);
    if not (p_property_id = any(v_scope_ids)) then continue; end if;

    select exists (
      select 1
      from public.organization_memberships membership
      join public.organizations organization
        on organization.id = membership.organization_id
       and organization.organization_type <> 'single_hotel'
      where membership.account_id = v_account.id
        and membership.status = 'active'
        and membership.ended_at is null
    ) into v_has_company_scope;

    if cardinality(v_scope_ids) = 1 and not v_has_company_scope then
      if v_account.data_user_id is not null then
        v_auth_user_ids := v_auth_user_ids || v_account.data_user_id;
      end if;
      -- Capture independent accounts before the property/anchor is removed.
      -- The property delete below retires the hidden single-hotel organization
      -- first; deleting these accounts only after that cascade avoids asking
      -- the final-owner guard to permit an account-by-account teardown of a
      -- whole hotel organization.
      v_accounts_to_remove := v_accounts_to_remove || v_account.id;
    else
      update public.account_property_authorization_bridges bridge
         set status = 'retired',
             retired_at = clock_timestamp(),
             retirement_reason = left('Property deleted: ' || p_property_id::text, 500)
       where bridge.account_id = v_account.id
         and bridge.property_id = p_property_id
         and bridge.status = 'active';

      update public.organization_memberships membership
         set covered_property_ids = array(
           select distinct covered.property_id
           from unnest(coalesce(membership.covered_property_ids, '{}'::uuid[])) covered(property_id)
           where covered.property_id <> p_property_id
           order by covered.property_id
         ),
             updated_at = clock_timestamp()
       where membership.account_id = v_account.id
         and membership.membership_scope = 'property'
         and p_property_id = any(coalesce(membership.covered_property_ids, '{}'::uuid[]));
      v_accounts_pruned := v_accounts_pruned + 1;
    end if;
  end loop;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  delete from public.properties where id = p_property_id;

  delete from public.accounts account
   where account.id = any(v_accounts_to_remove);
  get diagnostics v_accounts_removed = row_count;

  return jsonb_build_object(
    'name', v_property_name,
    'authUserIds', to_jsonb(v_auth_user_ids),
    'accountsRemoved', v_accounts_removed,
    'accountsPruned', v_accounts_pruned,
    'canonical', true,
    'propertyRosterLineagePreserved', true
  );
end;
$$;

revoke all on function public.staxis_delete_property_and_legacy_accounts(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_delete_property_and_legacy_accounts(uuid, uuid, text)
  to service_role;

-- Shared canonical lock order for People mutations.
create or replace function public._staxis_stage_c_expected_property_ids(
  p_property_ids uuid[]
)
returns uuid[]
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(distinct id order by id), '{}'::uuid[])
  from unnest(coalesce(p_property_ids, '{}'::uuid[])) ids(id)
  where id is not null;
$$;

revoke all on function public._staxis_stage_c_expected_property_ids(uuid[])
  from public, anon, authenticated, service_role;

create or replace function public.staxis_register_account_lifecycle_intent(
  p_operation_id uuid,
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_desired_active boolean,
  p_expected_active boolean,
  p_expected_role text,
  p_expected_auth_user_id uuid,
  p_expected_property_access uuid[],
  p_expected_intent_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_existing public.account_lifecycle_intents%rowtype;
  v_pending public.account_lifecycle_intents%rowtype;
  v_target_ids uuid[];
  v_expected_ids uuid[];
  v_property_id uuid;
  v_version bigint;
begin
  if p_operation_id is null or p_actor_account_id is null
     or p_actor_auth_user_id is null or p_hotel_id is null
     or p_target_account_id is null or p_desired_active is null
     or p_expected_active is null or p_expected_role is null
     or p_expected_auth_user_id is null or p_expected_property_access is null
     or p_expected_intent_version is null
  then return jsonb_build_object('status', 'invalid'); end if;
  if p_actor_account_id = p_target_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;

  perform 1 from public.accounts account
   where account.id = any(array[p_actor_account_id, p_target_account_id])
   order by account.id for update;
  perform 1 from public.account_authorization_state state
   where state.account_id = any(array[p_actor_account_id, p_target_account_id])
   order by state.account_id for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_target_account_id;
  select * into v_actor_state from public.account_authorization_state where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state where account_id = p_target_account_id;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_actor.data_user_id <> p_actor_auth_user_id
     or (select count(*) from public.accounts where data_user_id = p_actor_auth_user_id) <> 1
     or (select count(*) from public.accounts where data_user_id = v_target.data_user_id) <> 1 then
    return jsonb_build_object('status', 'identity_conflict');
  end if;
  if v_actor.active is not true then
    return jsonb_build_object('status', 'forbidden', 'reason', 'caller_inactive');
  end if;
  if v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target_role');
  end if;

  v_target_ids := public._staxis_structural_account_property_ids(v_target.id);
  v_expected_ids := public._staxis_stage_c_expected_property_ids(p_expected_property_access);
  if cardinality(v_target_ids) = 0 or not (p_hotel_id = any(v_target_ids))
     or v_expected_ids is distinct from v_target_ids then
    return jsonb_build_object('status', 'conflict', 'reason', 'target_scope');
  end if;

  if v_actor.role <> 'admin' then
    foreach v_property_id in array v_target_ids loop
      if not public._staxis_account_can_manage_users_at_property(v_actor.id, v_property_id) then
        return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
      end if;
      if v_target.role = 'general_manager'
         and not public._staxis_account_has_company_manager_hierarchy_at_property(v_actor.id, v_property_id)
         and public._staxis_account_operational_role_at_property(v_actor.id, v_property_id) <> 'owner' then
        return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
      end if;
    end loop;
  end if;

  select * into v_existing
  from public.account_lifecycle_intents intent
  where intent.operation_id = p_operation_id for update;
  if found then
    if v_existing.actor_account_id <> p_actor_account_id
       or v_existing.actor_auth_user_id <> p_actor_auth_user_id
       or v_existing.hotel_id <> p_hotel_id
       or v_existing.account_id <> p_target_account_id
       or v_existing.desired_active <> p_desired_active then
      return jsonb_build_object('status', 'operation_mismatch');
    end if;
    if v_existing.status = 'pending'
       and (v_existing.actor_authority_version_snapshot is null
         or v_existing.target_authority_version_snapshot is null
         or v_existing.target_authorized_property_ids_snapshot is null
         or v_existing.actor_authority_version_snapshot is distinct from v_actor_state.authority_version
         or v_existing.target_authority_version_snapshot is distinct from v_target_state.authority_version
         or v_existing.target_authorized_property_ids_snapshot is distinct from v_target_ids) then
      return jsonb_build_object('status', 'conflict');
    end if;
    return jsonb_build_object(
      'status', v_existing.status, 'operation_id', v_existing.operation_id,
      'intent_version', v_existing.version, 'desired_active', v_existing.desired_active,
      'prior_active', v_existing.prior_active, 'active', v_target.active,
      'committed_version', v_target.lifecycle_committed_version
    );
  end if;

  select * into v_pending
  from public.account_lifecycle_intents intent
  where intent.account_id = p_target_account_id and intent.status = 'pending'
  for update;
  if found then return jsonb_build_object('status', 'pending_conflict'); end if;
  if exists (
    select 1 from public.account_lifecycle_intents processing
    where processing.account_id = p_target_account_id
      and processing.processor_token is not null
      and processing.processor_lease_expires_at > clock_timestamp()
  ) then return jsonb_build_object('status', 'retry'); end if;

  if v_target.active is distinct from p_expected_active
     or v_target.role is distinct from p_expected_role
     or v_target.data_user_id is distinct from p_expected_auth_user_id
     or v_target.lifecycle_intent_version is distinct from p_expected_intent_version then
    return jsonb_build_object('status', 'conflict', 'active', v_target.active,
      'intent_version', v_target.lifecycle_intent_version);
  end if;
  if not p_desired_active and public._staxis_account_is_live_organization_owner(v_target.id) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'organization_owner');
  end if;

  v_version := v_target.lifecycle_intent_version + 1;
  update public.accounts
     set lifecycle_desired_active = p_desired_active,
         lifecycle_intent_version = v_version
   where id = v_target.id;
  insert into public.account_lifecycle_intents (
    operation_id, account_id, version, desired_active, prior_active,
    auth_user_id_snapshot, target_role_snapshot, target_property_access_snapshot,
    actor_account_id, actor_auth_user_id, actor_email, hotel_id,
    actor_authority_version_snapshot, target_authority_version_snapshot,
    target_authorized_property_ids_snapshot
  ) values (
    p_operation_id, v_target.id, v_version, p_desired_active, v_target.active,
    v_target.data_user_id, v_target.role, v_target_ids,
    v_actor.id, p_actor_auth_user_id, nullif(btrim(p_actor_email), ''), p_hotel_id,
    v_actor_state.authority_version, v_target_state.authority_version, v_target_ids
  );
  return jsonb_build_object(
    'status', 'pending', 'operation_id', p_operation_id, 'intent_version', v_version,
    'desired_active', p_desired_active, 'prior_active', v_target.active,
    'active', v_target.active, 'committed_version', v_target.lifecycle_committed_version,
    'auth_user_id', v_target.data_user_id
  );
end;
$$;

create or replace function public.staxis_commit_account_lifecycle_intent(
  p_operation_id uuid,
  p_request_id text,
  p_processor_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intent public.account_lifecycle_intents%rowtype;
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_target_ids uuid[];
  v_property_id uuid;
  v_state_changed boolean;
begin
  select * into v_intent from public.account_lifecycle_intents intent
   where intent.operation_id = p_operation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  perform 1 from public.accounts account
   where account.id = any(array[v_intent.actor_account_id, v_intent.account_id])
   order by account.id for update;
  perform 1 from public.account_authorization_state state
   where state.account_id = any(array[v_intent.actor_account_id, v_intent.account_id])
   order by state.account_id for update;
  select * into v_actor from public.accounts where id = v_intent.actor_account_id;
  select * into v_target from public.accounts where id = v_intent.account_id;
  select * into v_actor_state from public.account_authorization_state where account_id = v_intent.actor_account_id;
  select * into v_target_state from public.account_authorization_state where account_id = v_intent.account_id;
  if v_target.lifecycle_intent_version > v_intent.version then
    return jsonb_build_object('status', 'superseded', 'active', v_target.active,
      'desired_active', v_target.lifecycle_desired_active,
      'intent_version', v_target.lifecycle_intent_version);
  end if;
  if v_intent.status = 'committed' then
    return jsonb_build_object('status', 'committed', 'operation_id', p_operation_id,
      'intent_version', v_intent.version, 'active', v_target.active,
      'noop', v_intent.prior_active = v_intent.desired_active);
  end if;
  if v_intent.status = 'aborted' then return jsonb_build_object('status', 'aborted'); end if;
  if p_processor_token is null
     or v_intent.processor_token is distinct from p_processor_token
     or v_intent.processor_lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('status', 'lease_lost');
  end if;
  if v_target.lifecycle_intent_version <> v_intent.version
     or v_target.lifecycle_desired_active <> v_intent.desired_active
     or v_target.data_user_id <> v_intent.auth_user_id_snapshot
     or v_target.role <> v_intent.target_role_snapshot
     or v_target.active <> v_intent.prior_active
     or v_intent.auth_snapshot_recorded_at is null
     or v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'invariant_conflict', 'reason', 'target_snapshot_changed');
  end if;
  if v_actor.id is null or v_target.id is null
     or v_actor_state.account_id is null or v_target_state.account_id is null
     or v_intent.actor_authority_version_snapshot is null
     or v_intent.target_authority_version_snapshot is null
     or v_intent.target_authorized_property_ids_snapshot is null
     or not v_actor.active
     or v_actor.data_user_id <> v_intent.actor_auth_user_id
     or v_actor_state.authority_version is distinct from v_intent.actor_authority_version_snapshot
     or v_target_state.authority_version is distinct from v_intent.target_authority_version_snapshot then
    return jsonb_build_object('status', 'invariant_conflict', 'reason', 'authorization_changed');
  end if;
  v_target_ids := public._staxis_structural_account_property_ids(v_target.id);
  if cardinality(v_target_ids) = 0
     or v_target_ids is distinct from v_intent.target_authorized_property_ids_snapshot
     or not (v_intent.hotel_id = any(v_target_ids)) then
    return jsonb_build_object('status', 'invariant_conflict', 'reason', 'target_scope_changed');
  end if;
  if v_actor.role <> 'admin' then
    foreach v_property_id in array v_target_ids loop
      if not public._staxis_account_can_manage_users_at_property(v_actor.id, v_property_id) then
        return jsonb_build_object('status', 'invariant_conflict', 'reason', 'actor_scope_changed');
      end if;
    end loop;
  end if;
  if not v_intent.desired_active
     and public._staxis_account_is_live_organization_owner(v_target.id) then
    return jsonb_build_object('status', 'invariant_conflict', 'reason', 'organization_owner');
  end if;

  perform set_config('staxis.actor_account_id', v_intent.actor_account_id::text, true);
  perform set_config('staxis.account_lifecycle_operation_id', v_intent.operation_id::text, true);
  v_state_changed := v_target.active is distinct from v_intent.desired_active;
  update public.accounts
     set active = v_intent.desired_active,
         lifecycle_committed_version = v_intent.version
   where id = v_target.id;
  insert into public.role_changes (
    account_id, property_id, changed_by_account_id, old_role, new_role, change_kind, reason
  )
  select v_target.id, affected.property_id, v_intent.actor_account_id,
         v_target.role, v_target.role,
         case when v_intent.desired_active then 'reactivate' else 'deactivate' end, null
  from unnest(v_target_ids) affected(property_id);
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    v_intent.actor_auth_user_id, v_intent.actor_email,
    case when v_intent.desired_active then 'account.reactivate' else 'account.deactivate' end,
    'account', v_target.id::text,
    jsonb_build_object(
      'hotel_id', v_intent.hotel_id, 'role', v_target.role,
      'sign_in_blocked', not v_intent.desired_active, 'global_account_change', true,
      'affected_hotel_ids', to_jsonb(v_target_ids), 'authority_mode', 'normalized',
      'operation_id', v_intent.operation_id, 'lifecycle_version', v_intent.version,
      'request_id', p_request_id, 'state_changed', v_state_changed
    )
  );
  update public.account_lifecycle_intents
     set status = 'committed', committed_at = now(), processor_token = null,
         processor_lease_expires_at = null, updated_at = now(), last_error = null
   where operation_id = v_intent.operation_id;
  return jsonb_build_object('status', 'committed', 'operation_id', v_intent.operation_id,
    'intent_version', v_intent.version, 'active', v_intent.desired_active,
    'noop', not v_state_changed);
end;
$$;

revoke all on function public.staxis_register_account_lifecycle_intent(
  uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,uuid[],bigint
) from public, anon, authenticated;
grant execute on function public.staxis_register_account_lifecycle_intent(
  uuid,uuid,uuid,text,uuid,uuid,boolean,boolean,text,uuid,uuid[],bigint
) to service_role;
revoke all on function public.staxis_commit_account_lifecycle_intent(uuid,text,uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_commit_account_lifecycle_intent(uuid,text,uuid)
  to service_role;

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
declare
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_scope_ids uuid[];
  v_expected_ids uuid[];
  v_display_name text;
  v_property_id uuid;
  v_actor_role text;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_hotel_id is null or p_target_account_id is null or p_new_role is null
     or p_expected_property_access is null or p_expected_active is null
     or p_expected_role is null or p_expected_auth_user_id is null
     or p_expected_updated_at is null or p_expected_intent_version is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_actor_account_id = p_target_account_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'self');
  end if;
  if p_new_role not in ('general_manager', 'front_desk', 'housekeeping', 'maintenance') then
    return jsonb_build_object('status', 'invalid', 'reason', 'role');
  end if;
  v_display_name := case when p_new_display_name is null then null else nullif(btrim(p_new_display_name), '') end;
  if p_new_display_name is not null and (v_display_name is null or char_length(v_display_name) > 120) then
    return jsonb_build_object('status', 'invalid', 'reason', 'display_name');
  end if;

  perform 1 from public.accounts account
   where account.id = any(array[p_actor_account_id, p_target_account_id])
   order by account.id for update;
  perform 1 from public.account_authorization_state state
   where state.account_id = any(array[p_actor_account_id, p_target_account_id])
   order by state.account_id for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_target_account_id;
  select * into v_actor_state from public.account_authorization_state where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state where account_id = p_target_account_id;
  if v_actor.id is null or v_target.id is null or v_actor_state.account_id is null
     or v_target_state.account_id is null then return jsonb_build_object('status', 'not_found'); end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
    where intent.status = 'pending'
      and intent.account_id = any(array[p_actor_account_id, p_target_account_id])
  ) then return jsonb_build_object('status', 'pending_conflict'); end if;
  if v_actor.active is not true or v_actor.data_user_id <> p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if v_target.active is not true or v_target.role in ('admin', 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'target');
  end if;
  if v_target_state.authority_mode <> 'normalized' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'final_authority_not_normalized');
  end if;
  v_scope_ids := public._staxis_structural_account_property_ids(v_target.id);
  v_expected_ids := public._staxis_stage_c_expected_property_ids(p_expected_property_access);
  if cardinality(v_scope_ids) = 0 or not (p_hotel_id = any(v_scope_ids))
     or v_scope_ids is distinct from v_expected_ids then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_target.active is distinct from p_expected_active
     or v_target.role is distinct from p_expected_role
     or v_target.data_user_id is distinct from p_expected_auth_user_id
     or v_target.display_name is distinct from p_expected_display_name
     or v_target.updated_at is distinct from p_expected_updated_at
     or v_target.lifecycle_intent_version is distinct from p_expected_intent_version then
    return jsonb_build_object('status', 'conflict');
  end if;

  if v_actor.role <> 'admin' then
    foreach v_property_id in array v_scope_ids loop
      if not public._staxis_account_can_manage_users_at_property(v_actor.id, v_property_id) then
        return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users');
      end if;
      v_actor_role := public._staxis_account_operational_role_at_property(v_actor.id, v_property_id);
      if (v_target.role = 'general_manager' or p_new_role = 'general_manager')
         and not public._staxis_account_has_company_manager_hierarchy_at_property(v_actor.id, v_property_id)
         and v_actor_role <> 'owner' then
        return jsonb_build_object('status', 'forbidden', 'reason', 'hierarchy');
      end if;
    end loop;
  end if;
  if v_target.role = p_new_role and (v_display_name is null or v_target.display_name = v_display_name) then
    return jsonb_build_object('status', 'noop');
  end if;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', coalesce(p_request_id, ''), true);
  update public.accounts
     set role = p_new_role,
         display_name = coalesce(v_display_name, display_name)
   where id = v_target.id;
  insert into public.role_changes (
    account_id, property_id, changed_by_account_id, old_role, new_role, change_kind, reason
  )
  select v_target.id, affected.property_id, v_actor.id,
         v_target.role, p_new_role, 'role_change', null
  from unnest(v_scope_ids) affected(property_id);
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''), 'account.team_update',
    'account', v_target.id::text,
    jsonb_build_object(
      'hotel_id', p_hotel_id, 'affected_hotel_ids', to_jsonb(v_scope_ids),
      'authority_mode', 'normalized', 'role_changed', p_new_role,
      'old_role', v_target.role, 'display_name_changed', v_display_name is not null
        and v_display_name <> v_target.display_name, 'request_id', p_request_id
    )
  );
  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.staxis_update_hotel_team_profile_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_change_display_name boolean,
  p_new_display_name text,
  p_change_staff_link boolean,
  p_new_staff_id uuid,
  p_expected_active boolean,
  p_expected_role text,
  p_expected_auth_user_id uuid,
  p_expected_property_access uuid[],
  p_expected_target_property_ids uuid[],
  p_expected_display_name text,
  p_expected_staff_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_intent_version bigint,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_actor_state public.account_authorization_state%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_scope_ids uuid[];
  v_expected_ids uuid[];
  v_required_ids uuid[];
  v_display_name text;
  v_display_changed boolean := false;
  v_staff_changed boolean := false;
  v_link_changed boolean := false;
  v_property_id uuid;
  v_context jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null
     or p_hotel_id is null or p_target_account_id is null
     or p_change_display_name is null or p_change_staff_link is null
     or (not p_change_display_name and not p_change_staff_link)
     or p_expected_active is null or p_expected_role is null
     or p_expected_auth_user_id is null or p_expected_property_access is null
     or p_expected_target_property_ids is null or p_expected_updated_at is null
     or p_expected_intent_version is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  if (not p_change_display_name and p_new_display_name is not null)
     or (not p_change_staff_link and p_new_staff_id is not null) then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_change_display_name then
    v_display_name := nullif(btrim(p_new_display_name), '');
    if v_display_name is null or char_length(v_display_name) > 120 then
      return jsonb_build_object('status', 'invalid', 'reason', 'display_name');
    end if;
  end if;

  perform 1 from public.accounts account
   where account.id = any(array[p_actor_account_id, p_target_account_id])
   order by account.id for update;
  perform 1 from public.account_authorization_state state
   where state.account_id = any(array[p_actor_account_id, p_target_account_id])
   order by state.account_id for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_target from public.accounts where id = p_target_account_id;
  select * into v_actor_state from public.account_authorization_state where account_id = p_actor_account_id;
  select * into v_target_state from public.account_authorization_state where account_id = p_target_account_id;
  if v_actor.id is null or v_target.id is null or v_actor_state.account_id is null
     or v_target_state.account_id is null then return jsonb_build_object('status', 'not_found'); end if;
  if not v_actor.active or v_actor.data_user_id <> p_actor_auth_user_id then
    return jsonb_build_object('status', 'forbidden', 'reason', 'actor');
  end if;
  if v_target.role = 'admin' then return jsonb_build_object('status', 'forbidden', 'reason', 'target'); end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
    where intent.status = 'pending'
      and intent.account_id = any(array[p_actor_account_id, p_target_account_id])
  ) then return jsonb_build_object('status', 'pending_conflict'); end if;

  v_scope_ids := public._staxis_structural_account_property_ids(v_target.id);
  v_expected_ids := public._staxis_stage_c_expected_property_ids(p_expected_target_property_ids);
  if cardinality(v_scope_ids) = 0 or not (p_hotel_id = any(v_scope_ids))
     or v_scope_ids is distinct from v_expected_ids
     or v_target.active is distinct from p_expected_active
     or v_target.role is distinct from p_expected_role
     or v_target.data_user_id is distinct from p_expected_auth_user_id
     or v_target.display_name is distinct from p_expected_display_name
     or v_target.staff_id is distinct from p_expected_staff_id
     or v_target.updated_at is distinct from p_expected_updated_at
     or v_target.lifecycle_intent_version is distinct from p_expected_intent_version then
    return jsonb_build_object('status', 'conflict');
  end if;
  if v_target_state.authority_mode <> 'normalized' then
    return jsonb_build_object('status', 'forbidden', 'reason', 'final_authority_not_normalized');
  end if;

  v_required_ids := case when p_change_display_name and p_actor_account_id <> p_target_account_id
    then v_scope_ids else array[p_hotel_id]::uuid[] end;
  foreach v_property_id in array v_required_ids loop
    v_context := public._staxis_manage_team_context(v_actor.id, v_property_id);
    if coalesce((v_context->>'allowed')::boolean, false) is not true then
      return jsonb_build_object('status', 'forbidden', 'reason', 'manage_team');
    end if;
  end loop;

  if p_change_staff_link and p_new_staff_id is not null
     and not exists (
       select 1 from public.staff staff_row
       where staff_row.id = p_new_staff_id
         and staff_row.property_id = p_hotel_id and staff_row.is_active is true
     ) then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_change_staff_link and p_new_staff_id is not null and exists (
    select 1 from public.accounts other_account
    where other_account.id <> v_target.id and other_account.staff_id = p_new_staff_id
  ) then return jsonb_build_object('status', 'conflict', 'reason', 'staff_in_use'); end if;

  v_display_changed := p_change_display_name and v_target.display_name is distinct from v_display_name;
  v_staff_changed := p_change_staff_link and v_target.staff_id is distinct from p_new_staff_id;
  v_link_changed := p_change_staff_link and (
    (p_new_staff_id is not null and not exists (
      select 1 from public.account_property_staff_links staff_link
      where staff_link.account_id = v_target.id and staff_link.property_id = p_hotel_id
        and staff_link.staff_id = p_new_staff_id and staff_link.is_active is true
    )) or (p_new_staff_id is null and exists (
      select 1 from public.account_property_staff_links staff_link
      where staff_link.account_id = v_target.id and staff_link.property_id = p_hotel_id
        and staff_link.is_active is true
    ))
  );
  if not v_display_changed and not v_staff_changed and not v_link_changed then
    return jsonb_build_object('status', 'noop');
  end if;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', coalesce(p_request_id, ''), true);
  update public.accounts account
     set display_name = case when v_display_changed then v_display_name else account.display_name end,
         staff_id = case when p_change_staff_link then p_new_staff_id else account.staff_id end,
         updated_at = v_now
   where account.id = v_target.id;
  if p_change_staff_link and p_new_staff_id is null then
    update public.account_property_staff_links staff_link
       set is_active = false, deactivated_at = v_now,
           deactivated_by_account_id = v_actor.id, updated_at = v_now
     where staff_link.account_id = v_target.id
       and staff_link.property_id = p_hotel_id
       and staff_link.is_active is true;
  elsif p_change_staff_link then
    insert into public.account_property_staff_links (
      account_id, property_id, staff_id, is_active, source,
      linked_by_account_id, linked_at, updated_at
    ) values (
      v_target.id, p_hotel_id, p_new_staff_id, true, 'manual',
      v_actor.id, v_now, v_now
    ) on conflict (account_id, property_id) do update
      set staff_id = excluded.staff_id, is_active = true, source = 'manual',
          linked_by_account_id = excluded.linked_by_account_id,
          linked_at = case when public.account_property_staff_links.staff_id is distinct from excluded.staff_id
                           or public.account_property_staff_links.is_active is false
                     then excluded.linked_at else public.account_property_staff_links.linked_at end,
          deactivated_at = null, deactivated_by_account_id = null, updated_at = excluded.updated_at;
  end if;
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, nullif(btrim(p_actor_email), ''), 'account.team_update',
    'account', v_target.id::text,
    jsonb_build_object('hotel_id', p_hotel_id, 'affected_hotel_ids', to_jsonb(v_scope_ids),
      'authority_mode', 'normalized', 'display_name_changed', v_display_changed,
      'staff_link_changed', v_staff_changed or v_link_changed, 'request_id', p_request_id)
  );
  return jsonb_build_object('status', 'ok', 'audit_written', true,
    'display_name_changed', v_display_changed,
    'staff_link_changed', v_staff_changed or v_link_changed);
end;
$$;

revoke all on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,timestamptz,bigint,text
) from public, anon, authenticated;
grant execute on function public.staxis_change_hotel_team_role_guarded(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,timestamptz,bigint,text
) to service_role;
revoke all on function public.staxis_update_hotel_team_profile_guarded(
  uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,uuid[],uuid[],text,uuid,timestamptz,bigint,text
) from public, anon, authenticated;
grant execute on function public.staxis_update_hotel_team_profile_guarded(
  uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,uuid[],uuid[],text,uuid,timestamptz,bigint,text
) to service_role;

-- Canonical independent-hotel entitlement used by every final invite and
-- onboarding writer.  A topology-bound bridge is an explicit entitlement,
-- not a resurrected property_access projection.
create or replace function public._staxis_stage_c_grant_independent_hotel(
  p_account_id uuid,
  p_property_id uuid,
  p_reason text default 'Access Stage C independent hotel entitlement'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_relationship_id uuid;
  v_organization_id uuid;
  v_organization_type text;
  v_relationship_count integer;
  v_bridge_id uuid;
  v_now timestamptz := clock_timestamp();
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'Access Stage C independent hotel entitlement'), 500);
begin
  if p_account_id is null or p_property_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select account.* into v_account
  from public.accounts account
  where account.id = p_account_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_account.active is not true then
    return jsonb_build_object('ok', false, 'reason', 'account_inactive');
  end if;
  if v_account.role not in ('owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance') then
    return jsonb_build_object('ok', false, 'reason', 'role_conflict');
  end if;

  perform 1 from public.properties property
   where property.id = p_property_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'property_not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));

  select count(*)::integer,
         (array_agg(relationship.id order by relationship.id))[1],
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(relationship.organization_type order by relationship.id))[1]
    into v_relationship_count, v_relationship_id, v_organization_id, v_organization_type
  from public._staxis_cutover_valid_current_primary_property_relationships() relationship
  where relationship.property_id = p_property_id
    and relationship.active_primary_count = 1
    and relationship.organization_status = 'active';
  if v_relationship_count <> 1 or v_organization_type <> 'single_hotel' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_topology');
  end if;

  if exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
    where membership.account_id = p_account_id
      and membership.status = 'active'
      and membership.ended_at is null
      and organization.organization_type <> 'single_hotel'
  ) or exists (
    select 1
    from public.organization_access_grants grant_row
    join public.organization_memberships membership
      on membership.id = grant_row.membership_id
     and membership.account_id = p_account_id
    where grant_row.status = 'active'
      and grant_row.starts_at <= v_now
      and (grant_row.expires_at is null or grant_row.expires_at > v_now)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'role_conflict');
  end if;
  if exists (
    select 1 from public.account_property_authorization_bridges bridge
    where bridge.account_id = p_account_id
      and bridge.property_id = p_property_id
      and bridge.status = 'retired'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'retired_bridge');
  end if;

  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'authorization_state_missing'); end if;

  insert into public.account_property_authorization_bridges (
    account_id, property_id, cutover_organization_id, cutover_relationship_id,
    source_legacy_scope_hash, cutover_reason, created_at
  ) values (
    p_account_id, p_property_id, v_organization_id, v_relationship_id,
    encode(sha256(convert_to(p_property_id::text, 'UTF8')), 'hex'), v_reason, v_now
  ) on conflict (account_id, property_id) where status = 'active'
    do update set cutover_organization_id = excluded.cutover_organization_id,
                  cutover_relationship_id = excluded.cutover_relationship_id
    returning id into v_bridge_id;

  update public.account_authorization_state state
     set authority_mode = 'normalized',
         cutover_at = coalesce(state.cutover_at, v_now),
         cutover_reason = coalesce(state.cutover_reason, v_reason),
         updated_at = v_now
   where state.account_id = p_account_id;
  perform public._staxis_refresh_account_authorization(p_account_id, v_reason);
  return jsonb_build_object(
    'ok', true,
    'status', case when v_bridge_id is null then 'noop' else 'granted' end,
    'accountId', p_account_id,
    'propertyId', p_property_id,
    'bridgeId', v_bridge_id,
    'authorityMode', 'normalized'
  );
end;
$$;

revoke all on function public._staxis_stage_c_grant_independent_hotel(uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- Final exact-claim invite acceptance.  The stable signature and JSON envelope
-- remain unchanged; the former single_hotel array insert is replaced by the
-- topology-bound bridge helper and the promised roster link is committed in
-- this same transaction.
create or replace function public.staxis_accept_account_invite(
  p_token_hash text,
  p_claim_token uuid,
  p_auth_user_id uuid,
  p_username text,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite public.account_invites%rowtype;
  v_now timestamptz := clock_timestamp();
  v_context jsonb;
  v_account_id uuid;
  v_membership_id uuid;
  v_account_role text;
  v_candidate_username text;
  v_coverage uuid[];
  v_property_id uuid;
  v_current_org_id uuid;
  v_current_org_type text;
  v_relationship_count integer;
  v_attempt integer;
  v_independent jsonb;
  v_staff_status text;
  v_staff_link_account_id uuid;
begin
  if p_token_hash is null
     or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_claim_token is null
     or p_auth_user_id is null
     or p_username is null
     or lower(btrim(p_username)) !~ '^[a-z0-9._+-]{2,40}$'
     or p_display_name is null
     or char_length(btrim(p_display_name)) not between 1 and 120
  then
    raise exception 'invalid invitation acceptance input' using errcode = '22023';
  end if;

  select invitation.* into v_invite
  from public.account_invites invitation
  where invitation.token_hash = p_token_hash
  for update;
  if not found
     or v_invite.accepted_at is not null
     or v_invite.expires_at <= v_now
     or v_invite.acceptance_claim_token is distinct from p_claim_token
     or v_invite.acceptance_claimed_at <= v_now - interval '10 minutes'
  then
    raise exception 'invitation claim is no longer current' using errcode = '40001';
  end if;
  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_auth_user_id
      and lower(auth_user.email) = lower(v_invite.email)
  ) or exists (
    select 1 from public.accounts account where account.data_user_id = p_auth_user_id
  ) then
    raise exception 'Auth identity does not match this unused invitation' using errcode = '42501';
  end if;

  v_coverage := case when v_invite.membership_scope = 'property'
    then coalesce(v_invite.covered_property_ids, '{}'::uuid[])
    else '{}'::uuid[] end;
  for v_property_id in
    select distinct locked_id
    from unnest(array[v_invite.hotel_id] || v_coverage) locked_id
    order by locked_id
  loop
    perform 1 from public.properties property where property.id = v_property_id for update;
    if not found then raise exception 'invited hotel is unavailable' using errcode = 'P0002'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
  end loop;

  select count(*)::integer,
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(organization.organization_type order by relationship.id))[1]
    into v_relationship_count, v_current_org_id, v_current_org_type
  from public._staxis_current_primary_property_relationships() relationship
  join public.organizations organization
    on organization.id = relationship.organization_id and organization.status = 'active'
  where relationship.property_id = v_invite.hotel_id
    and relationship.active_primary_count = 1;
  if v_relationship_count <> 1 then
    raise exception 'invited hotel has no authoritative topology' using errcode = '23514';
  end if;
  perform public._staxis_lock_organization(coalesce(v_invite.organization_id, v_current_org_id));
  perform 1 from public.accounts inviter where inviter.id = v_invite.invited_by for share nowait;
  if not found then raise exception 'inviter no longer exists' using errcode = '42501'; end if;
  perform 1 from public.account_authorization_state state where state.account_id = v_invite.invited_by for share nowait;

  if v_invite.membership_scope is not null or v_invite.organization_id is not null then
    if v_invite.organization_id is null
       or v_invite.membership_scope not in ('company', 'property')
       or not (
         (v_invite.membership_scope = 'company'
           and v_invite.role in ('owner', 'vp', 'finance')
           and v_invite.covered_property_ids is null)
         or (v_invite.membership_scope = 'property'
           and v_invite.role in ('general_manager', 'front_desk', 'housekeeping', 'maintenance')
           and cardinality(v_coverage) > 0 and v_invite.hotel_id = any(v_coverage))
       )
       or v_current_org_type not in ('management_company', 'ownership_group')
       or v_current_org_id is distinct from v_invite.organization_id
       or not public._staxis_can_set_membership_hat(
         v_invite.invited_by, v_invite.organization_id, v_invite.membership_scope,
         v_invite.role, case when v_invite.membership_scope = 'property' then v_coverage else null end
       ) then
      raise exception 'invitation topology or promised job is no longer valid' using errcode = '42501';
    end if;
    if exists (
      select 1 from unnest(v_coverage) covered(property_id)
      where not exists (
        select 1 from public._staxis_current_primary_property_relationships() relationship
        where relationship.organization_id = v_invite.organization_id
          and relationship.property_id = covered.property_id
          and relationship.active_primary_count = 1
      )
    ) then
      raise exception 'one or more invited hotels changed company' using errcode = '42501';
    end if;
    v_account_role := case v_invite.role when 'owner' then 'owner' when 'vp' then 'front_desk'
      when 'finance' then 'front_desk' else v_invite.role end;
  else
    v_context := public._staxis_manage_team_context(v_invite.invited_by, v_invite.hotel_id);
    if coalesce((v_context->>'allowed')::boolean, false) is not true
       or v_current_org_type <> 'single_hotel'
       or v_invite.role not in ('owner','general_manager','front_desk','housekeeping','maintenance')
       or not ((v_invite.role in ('owner','general_manager') and v_context->>'role' in ('admin','owner'))
               or v_invite.role in ('front_desk','housekeeping','maintenance')) then
      raise exception 'legacy invitation is no longer valid for this hotel' using errcode = '42501';
    end if;
    v_account_role := v_invite.role;
  end if;

  for v_attempt in 0..4 loop
    v_candidate_username := case when v_attempt = 0 then lower(btrim(p_username))
      else left(lower(btrim(p_username)), 30)
        || substring(replace(p_claim_token::text, '-', ''), 1 + (v_attempt - 1) * 2, 6)
        || v_attempt::text end;
    begin
      insert into public.accounts (username, display_name, role, data_user_id)
      values (v_candidate_username, btrim(p_display_name), v_account_role, p_auth_user_id)
      returning id into v_account_id;
      exit;
    exception when unique_violation then
      if exists (select 1 from public.accounts account where account.data_user_id = p_auth_user_id) then
        raise exception 'Auth identity already has an account' using errcode = '23505';
      end if;
      if v_attempt = 4 then raise exception 'could not allocate an account username' using errcode = '23505'; end if;
    end;
  end loop;

  if v_invite.organization_id is not null then
    v_membership_id := public.staxis_set_membership_hat(
      v_invite.invited_by, v_invite.organization_id, v_account_id,
      v_invite.membership_scope, v_invite.role,
      case when v_invite.membership_scope = 'property' then to_jsonb(v_coverage) else null end,
      null
    );
    if v_membership_id is null or not exists (
      select 1 from public._staxis_account_property_authorizations(v_account_id) authz
      where authz.property_id = v_invite.hotel_id
    ) then
      raise exception 'promised normalized entitlement did not activate' using errcode = '23514';
    end if;
  else
    v_independent := public._staxis_stage_c_grant_independent_hotel(
      v_account_id, v_invite.hotel_id, 'Access Stage C invite acceptance'
    );
    if coalesce((v_independent->>'ok')::boolean, false) is not true then
      raise exception 'promised independent entitlement did not activate: %', v_independent using errcode = '23514';
    end if;
  end if;

  if v_invite.target_staff_id is not null then
    v_staff_status := public._staxis_lock_invite_target_staff(
      v_invite.invited_by, v_invite.hotel_id, v_invite.role,
      v_invite.target_staff_id, v_account_id, v_invite.id
    );
    if v_staff_status <> 'ok' then
      raise exception 'promised roster profile is no longer linkable' using errcode = '23514';
    end if;
    update public.accounts account
       set staff_id = v_invite.target_staff_id, updated_at = v_now
     where account.id = v_account_id and account.staff_id is null;
    if not found then raise exception 'accepted account already has a different roster identity' using errcode = '23514'; end if;
    insert into public.account_property_staff_links (
      account_id, property_id, staff_id, is_active, source,
      linked_by_account_id, linked_at, updated_at
    ) values (
      v_account_id, v_invite.hotel_id, v_invite.target_staff_id, true, 'invitation',
      v_invite.invited_by, v_now, v_now
    ) on conflict (account_id, property_id) do update
      set staff_id = excluded.staff_id, is_active = true, source = excluded.source,
          linked_by_account_id = excluded.linked_by_account_id,
          linked_at = coalesce(public.account_property_staff_links.linked_at, excluded.linked_at),
          deactivated_at = null, deactivated_by_account_id = null, updated_at = excluded.updated_at
      where public.account_property_staff_links.is_active is false
         or public.account_property_staff_links.staff_id = excluded.staff_id
      returning account_id into v_staff_link_account_id;
    if v_staff_link_account_id is null then raise exception 'accepted account staff link changed before commit' using errcode = '40001'; end if;
  end if;

  update public.account_invites invitation
     set accepted_at = v_now, accepted_by = v_account_id,
         acceptance_claim_token = null, acceptance_claimed_at = null
   where invitation.id = v_invite.id and invitation.accepted_at is null
     and invitation.acceptance_claim_token = p_claim_token;
  if not found then raise exception 'invitation claim changed before commit' using errcode = '40001'; end if;

  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_auth_user_id, lower(v_invite.email), 'invite.accept', 'invite', v_invite.id::text,
    jsonb_build_object('hotel_id', v_invite.hotel_id, 'role', v_invite.role,
      'username', v_candidate_username, 'scope', v_invite.membership_scope,
      'organizationId', v_invite.organization_id, 'membershipId', v_membership_id,
      'authorityMode', 'normalized', 'staffId', v_invite.target_staff_id)
  );
  return jsonb_build_object(
    'ok', true, 'accountId', v_account_id, 'email', lower(v_invite.email),
    'username', v_candidate_username, 'normalized', true, 'membershipId', v_membership_id,
    'staffId', v_invite.target_staff_id
  );
end;
$$;

revoke all on function public.staxis_accept_account_invite(text,uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.staxis_accept_account_invite(text,uuid,uuid,text,text)
  to service_role;

-- Existing-account invite grants retain their idempotent JSON envelope and
-- staff-link reservation, but both topology branches now write canonical
-- memberships or a topology-bound independent bridge.
create or replace function public.staxis_grant_existing_account_invite_guarded(
  p_actor_account_id uuid,
  p_actor_auth_user_id uuid,
  p_hotel_id uuid,
  p_target_account_id uuid,
  p_email text,
  p_role text,
  p_organization_id uuid,
  p_membership_scope text,
  p_covered_property_ids uuid[],
  p_target_staff_id uuid default null,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_actor public.accounts%rowtype;
  v_target public.accounts%rowtype;
  v_target_state public.account_authorization_state%rowtype;
  v_actor_email text;
  v_org_id uuid;
  v_org_type text;
  v_relationship_count integer;
  v_membership_id uuid;
  v_staff_status text;
  v_link_account_id uuid;
  v_role_changed boolean := false;
  v_access_changed boolean := false;
  v_link_changed boolean := false;
  v_effective_coverage uuid[];
  v_job_category text;
  v_independent jsonb;
begin
  if p_actor_account_id is null or p_actor_auth_user_id is null or p_hotel_id is null
     or p_target_account_id is null or char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_role not in ('owner','vp','finance','general_manager','front_desk','housekeeping','maintenance')
     or char_length(coalesce(p_request_id, '')) > 200 then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if p_actor_account_id = p_target_account_id then
    return jsonb_build_object('ok', false, 'reason', 'role_conflict');
  end if;

  perform 1 from public.properties property where property.id = p_hotel_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));
  select count(*)::integer,
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(relationship.organization_type order by relationship.id))[1]
    into v_relationship_count, v_org_id, v_org_type
  from public._staxis_cutover_valid_current_primary_property_relationships() relationship
  where relationship.property_id = p_hotel_id
    and relationship.active_primary_count = 1
    and relationship.organization_status = 'active';
  if v_relationship_count <> 1 then return jsonb_build_object('ok', false, 'reason', 'denied'); end if;

  select actor.* into v_actor from public.accounts actor where actor.id = p_actor_account_id for update;
  select lower(auth_user.email) into v_actor_email from auth.users auth_user
   where auth_user.id = p_actor_auth_user_id for share;
  if not found or v_actor.data_user_id is distinct from p_actor_auth_user_id
     or v_actor.active is not true
     or not public._staxis_can_control_account_invite(
       p_actor_account_id, p_hotel_id, p_organization_id, p_membership_scope,
       p_role, p_covered_property_ids
     ) then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;
  select target.* into v_target from public.accounts target
   where target.id = p_target_account_id for update;
  if not found or v_target.active is not true then
    return jsonb_build_object('ok', false, 'reason', case when not found then 'not_found' else 'role_conflict' end);
  end if;
  if v_target.role = 'admin' then return jsonb_build_object('ok', false, 'reason', 'role_conflict'); end if;
  if not exists (
    select 1 from auth.users auth_user where auth_user.id = v_target.data_user_id
      and lower(auth_user.email) = v_email
  ) then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  select state.* into v_target_state from public.account_authorization_state state
   where state.account_id = v_target.id for update;
  if not found or v_target_state.authority_mode <> 'normalized' then
    return jsonb_build_object('ok', false, 'reason', 'final_authority_not_normalized');
  end if;

  v_staff_status := public._staxis_lock_invite_target_staff(
    p_actor_account_id, p_hotel_id, p_role, p_target_staff_id, v_target.id, null
  );
  if v_staff_status <> 'ok' then return jsonb_build_object('ok', false, 'reason', v_staff_status); end if;

  if p_organization_id is not null or p_membership_scope is not null or p_covered_property_ids is not null then
    if p_organization_id is null or p_membership_scope not in ('company','property')
       or v_org_type not in ('management_company','ownership_group')
       or v_org_id is distinct from p_organization_id
       or (p_membership_scope = 'company' and p_covered_property_ids is not null)
       or (p_membership_scope = 'property' and (
         cardinality(coalesce(p_covered_property_ids, '{}'::uuid[])) = 0
         or not (p_hotel_id = any(p_covered_property_ids)))) then
      return jsonb_build_object('ok', false, 'reason', 'role_conflict');
    end if;
    if v_actor.role <> 'admin' and not public._staxis_can_set_membership_hat(
      v_actor.id, p_organization_id, p_membership_scope, p_role,
      case when p_membership_scope = 'property' then p_covered_property_ids else null end
    ) then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    v_effective_coverage := case when p_membership_scope = 'property' then array(
      select distinct covered.property_id from unnest(p_covered_property_ids) covered(property_id)
      order by covered.property_id) else null end;
    v_job_category := case p_role when 'owner' then 'owner_principal' when 'vp' then 'regional_manager'
      when 'finance' then 'finance' when 'general_manager' then 'general_manager' else 'hotel_employee' end;
    insert into public.organization_memberships (
      organization_id, account_id, job_category, status, starts_at,
      created_by_account_id, updated_by_account_id, membership_scope, staxis_role, covered_property_ids
    ) values (
      p_organization_id, v_target.id, v_job_category, 'active', v_now,
      v_actor.id, v_actor.id, p_membership_scope, p_role, v_effective_coverage
    ) on conflict (organization_id, account_id, membership_scope, staxis_role)
      where ended_at is null and staxis_role is not null
    do update set covered_property_ids = excluded.covered_property_ids,
                  status = 'active', starts_at = least(public.organization_memberships.starts_at, excluded.starts_at),
                  updated_by_account_id = excluded.updated_by_account_id, updated_at = v_now
    returning id into v_membership_id;
    v_access_changed := true;
    if not exists (
      select 1 from public._staxis_account_property_authorizations(v_target.id) authz
      where authz.property_id = p_hotel_id and authz.entitlement_kind = 'membership_hat'
        and authz.entitlement_id = v_membership_id
    ) then raise exception 'existing-account normalized entitlement did not activate' using errcode = '23514'; end if;
  else
    if v_org_type <> 'single_hotel' then return jsonb_build_object('ok', false, 'reason', 'role_conflict'); end if;
    if v_target.role is distinct from p_role then
      if exists (select 1 from public._staxis_nonlegacy_property_authorizations(v_target.id))
         or exists (select 1 from public.account_property_staff_links link_row where link_row.account_id = v_target.id and link_row.is_active)
      then return jsonb_build_object('ok', false, 'reason', 'role_conflict'); end if;
      update public.accounts account set role = p_role where account.id = v_target.id;
      v_role_changed := true;
    end if;
    v_independent := public._staxis_stage_c_grant_independent_hotel(
      v_target.id, p_hotel_id, 'Access Stage C existing-account invite grant'
    );
    if coalesce((v_independent->>'ok')::boolean, false) is not true then
      return v_independent || jsonb_build_object('ok', false);
    end if;
    v_access_changed := (v_independent->>'status') = 'granted';
  end if;

  if p_target_staff_id is not null then
    v_link_changed := not exists (
      select 1 from public.account_property_staff_links link_row
      where link_row.account_id = v_target.id and link_row.property_id = p_hotel_id
        and link_row.staff_id = p_target_staff_id and link_row.is_active
    );
    update public.accounts account set staff_id = coalesce(account.staff_id, p_target_staff_id)
      where account.id = v_target.id;
    insert into public.account_property_staff_links (
      account_id, property_id, staff_id, is_active, source, linked_by_account_id, linked_at, updated_at
    ) values (v_target.id, p_hotel_id, p_target_staff_id, true, 'invitation', v_actor.id, v_now, v_now)
    on conflict (account_id, property_id) do update
      set staff_id = excluded.staff_id, is_active = true, source = excluded.source,
          linked_by_account_id = excluded.linked_by_account_id, deactivated_at = null,
          deactivated_by_account_id = null, updated_at = excluded.updated_at
      where public.account_property_staff_links.is_active is false
         or public.account_property_staff_links.staff_id = excluded.staff_id
      returning account_id into v_link_account_id;
    if v_link_account_id is null then raise exception 'target account staff link changed during access grant' using errcode = '40001'; end if;
  end if;
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    p_actor_auth_user_id, v_actor_email, 'invite.existing_account_grant', 'account', v_target.id::text,
    jsonb_build_object('hotel_id', p_hotel_id, 'target_email', v_email, 'role', p_role,
      'organization_id', p_organization_id, 'scope', p_membership_scope,
      'property_ids', case when p_membership_scope = 'property' then to_jsonb(p_covered_property_ids) else null end,
      'membership_id', v_membership_id, 'staff_id', p_target_staff_id,
      'role_changed', v_role_changed, 'access_changed', v_access_changed,
      'staff_link_changed', v_link_changed, 'request_id', p_request_id, 'authorityMode', 'normalized')
  );
  return jsonb_build_object(
    'ok', true, 'status', case when v_role_changed or v_access_changed or v_link_changed then 'granted' else 'noop' end,
    'accountId', v_target.id, 'hotelId', p_hotel_id, 'role', p_role,
    'normalized', true, 'membershipId', v_membership_id, 'staffId', p_target_staff_id
  );
end;
$$;

revoke all on function public.staxis_grant_existing_account_invite_guarded(
  uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text
) from public, anon, authenticated;
grant execute on function public.staxis_grant_existing_account_invite_guarded(
  uuid,uuid,uuid,uuid,text,text,uuid,text,uuid[],uuid,text
) to service_role;

-- Join-request approval keeps the deterministic phone/name roster matching and
-- idempotent decision envelope.  Independent hotels receive a bridge; company
-- hotels receive a canonical property membership.  No branch writes the raw
-- account array.
create or replace function public.staxis_decide_staff_join_request(
  p_actor_account_id uuid,
  p_join_request_id uuid,
  p_property_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.join_requests%rowtype;
  v_account public.accounts%rowtype;
  v_context jsonb;
  v_now timestamptz := now();
  v_org_id uuid;
  v_org_type text;
  v_relationship_count integer;
  v_staff_id uuid;
  v_staff_link_account_id uuid;
  v_membership_id uuid;
  v_phone_lookup text;
  v_name_lookup text;
  v_match_count integer;
  v_staff_reused boolean := false;
  v_independent jsonb;
begin
  if p_actor_account_id is null or p_join_request_id is null or p_property_id is null
     or p_decision not in ('approve','deny') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;
  perform 1 from public.properties property where property.id = p_property_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'property_not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));
  select request_row.* into v_request from public.join_requests request_row
   where request_row.id = p_join_request_id and request_row.property_id = p_property_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_request.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;

  select count(*)::integer,
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(relationship.organization_type order by relationship.id))[1]
    into v_relationship_count, v_org_id, v_org_type
  from public._staxis_cutover_valid_current_primary_property_relationships() relationship
  where relationship.property_id = p_property_id
    and relationship.active_primary_count = 1
    and relationship.organization_status = 'active';
  if v_relationship_count <> 1 then return jsonb_build_object('ok', false, 'reason', 'ambiguous_topology'); end if;

  v_context := public._staxis_manage_team_context(p_actor_account_id, p_property_id);
  if coalesce((v_context->>'allowed')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;
  if p_decision = 'deny' then
    update public.join_requests request_row
       set status = 'denied', decided_at = v_now, decided_by = p_actor_account_id
     where request_row.id = v_request.id and request_row.status = 'pending';
    if not found then return jsonb_build_object('ok', false, 'reason', 'already_decided'); end if;
    insert into public.admin_audit_log (actor_user_id, action, target_type, target_id, metadata)
      select actor.data_user_id, 'join_request.deny', 'join_request', v_request.id::text,
             jsonb_build_object('hotel_id', p_property_id, 'name', v_request.name, 'department', v_request.department)
        from public.accounts actor where actor.id = p_actor_account_id;
    return jsonb_build_object('ok', true, 'decided', 'denied');
  end if;

  select target.* into v_account from public.accounts target
   where target.id = v_request.account_id and target.active is true for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'account_unavailable'); end if;
  if not exists (
    select 1 from public.account_authorization_state state
    where state.account_id = v_account.id and state.authority_mode = 'normalized'
  ) then return jsonb_build_object('ok', false, 'reason', 'final_authority_not_normalized'); end if;
  if v_account.staff_id is not null then return jsonb_build_object('ok', false, 'reason', 'already_linked'); end if;
  if v_account.role not in ('front_desk','housekeeping','maintenance')
     or v_request.department <> v_account.role then
    return jsonb_build_object('ok', false, 'reason', 'role_mismatch');
  end if;
  if v_org_type in ('management_company','ownership_group') then
    if v_context->>'role' <> 'admin'
       and (v_context->>'authorityMode' <> 'normalized'
         or not coalesce(v_context->'organizationIds', '[]'::jsonb) @> jsonb_build_array(v_org_id::text)) then
      return jsonb_build_object('ok', false, 'reason', 'normalized_manager_required');
    end if;
  elsif v_org_type <> 'single_hotel' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_topology');
  end if;

  v_phone_lookup := case when coalesce(v_request.phone, '') = '' then null
    else right(regexp_replace(v_request.phone, '[^0-9]', '', 'g'), 10) end;
  v_name_lookup := lower(regexp_replace(btrim(v_request.name), '[[:space:]]+', ' ', 'g'));
  if v_phone_lookup is not null then
    select count(*)::integer, (array_agg(candidate.id order by candidate.id))[1]
      into v_match_count, v_staff_id
    from public.staff candidate
    where candidate.property_id = p_property_id and candidate.is_active is true
      and coalesce(candidate.department, 'housekeeping') = v_request.department
      and candidate.phone_lookup = v_phone_lookup
      and not exists (select 1 from public.accounts linked_account where linked_account.staff_id = candidate.id)
      and not exists (select 1 from public.account_property_staff_links link_row where link_row.staff_id = candidate.id and link_row.is_active)
      and not exists (select 1 from public.account_invites invitation where invitation.hotel_id = p_property_id
        and invitation.target_staff_id = candidate.id and invitation.accepted_at is null and invitation.expires_at > v_now);
    if v_match_count <> 1 then v_staff_id := null; end if;
  end if;
  if v_staff_id is null then
    select count(*)::integer, (array_agg(candidate.id order by candidate.id))[1]
      into v_match_count, v_staff_id
    from public.staff candidate
    where candidate.property_id = p_property_id and candidate.is_active is true
      and coalesce(candidate.department, 'housekeeping') = v_request.department
      and lower(regexp_replace(btrim(candidate.name), '[[:space:]]+', ' ', 'g')) = v_name_lookup
      and (v_phone_lookup is null or candidate.phone_lookup is null or candidate.phone_lookup = v_phone_lookup)
      and not exists (select 1 from public.accounts linked_account where linked_account.staff_id = candidate.id)
      and not exists (select 1 from public.account_property_staff_links link_row where link_row.staff_id = candidate.id and link_row.is_active)
      and not exists (select 1 from public.account_invites invitation where invitation.hotel_id = p_property_id
        and invitation.target_staff_id = candidate.id and invitation.accepted_at is null and invitation.expires_at > v_now);
    if v_match_count <> 1 then v_staff_id := null; end if;
  end if;
  if v_staff_id is not null then
    perform 1 from public.staff candidate
    where candidate.id = v_staff_id and candidate.property_id = p_property_id
      and candidate.is_active is true and coalesce(candidate.department, 'housekeeping') = v_request.department
      and not exists (select 1 from public.accounts linked_account where linked_account.staff_id = candidate.id)
      and not exists (select 1 from public.account_property_staff_links link_row where link_row.staff_id = candidate.id and link_row.is_active)
      and not exists (select 1 from public.account_invites invitation where invitation.hotel_id = p_property_id
        and invitation.target_staff_id = candidate.id and invitation.accepted_at is null and invitation.expires_at > v_now)
    for update;
    if found then v_staff_reused := true; else v_staff_id := null; end if;
  end if;
  if v_staff_id is null then
    insert into public.staff (
      property_id, name, phone, phone_lookup, language, is_senior, department,
      scheduled_today, weekly_hours, max_weekly_hours, max_days_per_week,
      days_worked_this_week, is_active
    ) values (
      p_property_id, v_request.name, coalesce(v_request.phone, ''), v_phone_lookup,
      v_request.language, false, v_request.department, false, 0, 40, 5, 0, true
    ) returning id into v_staff_id;
  end if;

  update public.accounts target set staff_id = v_staff_id
   where target.id = v_account.id and target.staff_id is null;
  if not found then raise exception 'target account link changed during approval' using errcode = '40001'; end if;
  insert into public.account_property_staff_links (
    account_id, property_id, staff_id, is_active, source, linked_by_account_id, linked_at
  ) values (v_account.id, p_property_id, v_staff_id, true, 'invitation', p_actor_account_id, v_now)
  on conflict (account_id, property_id) do update
    set staff_id = excluded.staff_id, is_active = true, source = excluded.source,
        linked_by_account_id = excluded.linked_by_account_id, linked_at = excluded.linked_at,
        deactivated_at = null, deactivated_by_account_id = null, updated_at = v_now
    where public.account_property_staff_links.is_active is false
       or public.account_property_staff_links.staff_id = excluded.staff_id
    returning account_id into v_staff_link_account_id;
  if v_staff_link_account_id is null then raise exception 'target account already has an active hotel staff link' using errcode = '23514'; end if;

  if v_org_type in ('management_company','ownership_group') then
    insert into public.organization_memberships (
      organization_id, account_id, job_category, status, starts_at,
      created_by_account_id, updated_by_account_id, membership_scope, staxis_role, covered_property_ids
    ) values (
      v_org_id, v_account.id, 'hotel_employee', 'active', v_now,
      p_actor_account_id, p_actor_account_id, 'property', v_account.role, array[p_property_id]
    ) on conflict (organization_id, account_id, membership_scope, staxis_role)
      where ended_at is null and staxis_role is not null
    do update set covered_property_ids = array(
      select distinct covered.property_id from unnest(coalesce(public.organization_memberships.covered_property_ids, '{}'::uuid[]) || excluded.covered_property_ids) covered(property_id)
      order by covered.property_id), status = 'active', updated_by_account_id = excluded.updated_by_account_id, updated_at = v_now
    returning id into v_membership_id;
    if not exists (
      select 1 from public._staxis_account_property_authorizations(v_account.id) authz
      where authz.property_id = p_property_id and authz.entitlement_kind = 'membership_hat'
        and authz.entitlement_id = v_membership_id
    ) then raise exception 'normalized staff entitlement did not activate' using errcode = '23514'; end if;
  else
    v_independent := public._staxis_stage_c_grant_independent_hotel(
      v_account.id, p_property_id, 'Access Stage C join-request approval'
    );
    if coalesce((v_independent->>'ok')::boolean, false) is not true then
      raise exception 'independent staff entitlement did not activate: %', v_independent using errcode = '23514';
    end if;
  end if;

  update public.join_requests request_row
     set status = 'approved', decided_at = v_now, decided_by = p_actor_account_id
   where request_row.id = v_request.id and request_row.status = 'pending';
  if not found then raise exception 'join request changed during approval' using errcode = '40001'; end if;
  insert into public.admin_audit_log (actor_user_id, action, target_type, target_id, metadata)
    select actor.data_user_id, 'join_request.approve', 'join_request', v_request.id::text,
      jsonb_build_object('hotel_id', p_property_id, 'name', v_request.name, 'department', v_request.department,
        'staffId', v_staff_id, 'staffReused', v_staff_reused, 'accountId', v_account.id,
        'membershipId', v_membership_id, 'authorityMode', 'normalized')
      from public.accounts actor where actor.id = p_actor_account_id;
  return jsonb_build_object('ok', true, 'decided', 'approved', 'staffId', v_staff_id,
    'staffReused', v_staff_reused, 'membershipId', v_membership_id, 'authorityMode', 'normalized');
end;
$$;

revoke all on function public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.staxis_decide_staff_join_request(uuid,uuid,uuid,text)
  to service_role;

-- First-person join-code signup retains the exact code CAS, retry audit lookup,
-- username collision behavior, pending-approval queue, and onboarding state
-- envelope.  Its successful entitlement is now canonical before the code-use
-- audit is committed.
create or replace function public.staxis_finalize_join_code_signup(
  p_code_id uuid,
  p_code text,
  p_hotel_id uuid,
  p_expected_used_count integer,
  p_auth_user_id uuid,
  p_username text,
  p_display_name text,
  p_requested_role text,
  p_phone text,
  p_language text,
  p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz;
  v_code public.hotel_join_codes%rowtype;
  v_onboarding_state jsonb;
  v_next_state jsonb;
  v_current_step integer;
  v_final_role text;
  v_pending_approval boolean;
  v_account_id uuid;
  v_existing_username text;
  v_actor_email text;
  v_code_text text := upper(btrim(coalesce(p_code, '')));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_org_id uuid;
  v_org_type text;
  v_relationship_count integer;
  v_entitlement jsonb;
  v_membership_id uuid;
begin
  if p_code_id is null or p_hotel_id is null or p_auth_user_id is null
     or octet_length(v_code_text) not between 6 and 128
     or v_code_text !~ '^[A-Z0-9][A-Z0-9-]{4,126}[A-Z0-9]$'
     or p_expected_used_count is null or p_expected_used_count < 0
     or char_length(v_username) not between 1 and 40 or octet_length(v_username) > 160
     or v_username !~ '^[a-z0-9._+-]+$'
     or char_length(v_display_name) not between 1 and 200 or octet_length(v_display_name) > 800
     or char_length(coalesce(v_phone, '')) > 64
     or p_requested_role not in ('owner','general_manager','front_desk','housekeeping','maintenance')
     or p_language not in ('en','es') or char_length(coalesce(p_request_id, '')) > 200 then
    return jsonb_build_object('ok', false, 'status', 'invalid');
  end if;

  select coalesce(property.onboarding_state, jsonb_build_object('step', 1)) into v_onboarding_state
    from public.properties property where property.id = p_hotel_id for update;
  if not found then return jsonb_build_object('ok', false, 'status', 'not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended(p_hotel_id::text, 0));
  v_now := clock_timestamp();
  select code_row.* into v_code from public.hotel_join_codes code_row
   where code_row.id = p_code_id and code_row.hotel_id = p_hotel_id and code_row.code = v_code_text for update;
  if not found then return jsonb_build_object('ok', false, 'status', 'not_found'); end if;

  if v_code.code_kind = 'privileged_onboarding' and v_code.role in ('owner','general_manager')
     and p_requested_role = v_code.role then
    v_final_role := v_code.role; v_pending_approval := false;
  elsif v_code.code_kind = 'staff_signup' and v_code.role is null
        and p_requested_role in ('front_desk','housekeeping','maintenance') then
    v_final_role := p_requested_role; v_pending_approval := true;
  elsif v_code.code_kind = 'staff_signup' and v_code.role in ('front_desk','housekeeping','maintenance')
        and p_requested_role = v_code.role then
    v_final_role := v_code.role; v_pending_approval := false;
  else
    return jsonb_build_object('ok', false, 'status', 'denied');
  end if;
  select lower(auth_user.email) into v_actor_email from auth.users auth_user
   where auth_user.id = p_auth_user_id for share;
  if not found then return jsonb_build_object('ok', false, 'status', 'auth_user_missing'); end if;
  if v_code.code_kind = 'privileged_onboarding'
     and nullif(v_onboarding_state->>'invitedEmail', '') is not null
     and lower(v_onboarding_state->>'invitedEmail') is distinct from v_actor_email then
    return jsonb_build_object('ok', false, 'status', 'denied');
  end if;

  select account.id, account.username into v_account_id, v_existing_username
  from public.admin_audit_log audit
  join public.accounts account on account.id::text = audit.metadata->>'account_id'
    and account.data_user_id = p_auth_user_id
  where audit.action = 'join_code.use' and audit.target_type = 'join_code'
    and audit.target_id = v_code.id::text and audit.actor_user_id = p_auth_user_id
    and audit.metadata->>'hotel_id' = p_hotel_id::text
    and audit.metadata->>'role' = v_final_role
    and audit.metadata->>'pending_approval' = v_pending_approval::text
    and audit.metadata->>'expected_used_count' = p_expected_used_count::text
    and v_code.used_count >= p_expected_used_count + 1
  order by audit.ts desc, audit.id desc limit 1;
  if found then
    return jsonb_build_object('ok', true, 'schemaVersion', 'join-code-signup-finalization-v1',
      'status', 'existing', 'codeId', v_code.id, 'hotelId', v_code.hotel_id,
      'accountId', v_account_id, 'finalRole', v_final_role, 'username', v_existing_username,
      'pendingApproval', v_pending_approval, 'usedCount', p_expected_used_count + 1);
  end if;
  if exists (select 1 from public.accounts account where account.data_user_id = p_auth_user_id) then
    return jsonb_build_object('ok', false, 'status', 'account_exists');
  end if;
  if v_code.revoked_at is not null then return jsonb_build_object('ok', false, 'status', 'revoked'); end if;
  if v_code.expires_at <= v_now then return jsonb_build_object('ok', false, 'status', 'expired'); end if;
  if v_code.used_count >= v_code.max_uses then return jsonb_build_object('ok', false, 'status', 'used_up'); end if;
  if v_code.used_count <> p_expected_used_count then return jsonb_build_object('ok', false, 'status', 'conflict'); end if;
  if (select count(*) from public._staxis_current_primary_property_relationships() relationship
      where relationship.property_id = v_code.hotel_id and relationship.active_primary_count = 1
        and relationship.starts_at <= v_code.created_at) <> 1 then
    return jsonb_build_object('ok', false, 'status', 'denied');
  end if;

  if v_code.code_kind = 'privileged_onboarding' then perform set_config('staxis.privileged_join_code_write', 'claim', true); end if;
  update public.hotel_join_codes code_row set used_count = code_row.used_count + 1 where code_row.id = v_code.id;
  begin
    insert into public.accounts (username, display_name, role, data_user_id, phone)
    values (v_username, v_display_name, v_final_role, p_auth_user_id, v_phone)
    returning id into v_account_id;
  exception when unique_violation then
    if exists (select 1 from public.accounts account where account.data_user_id = p_auth_user_id) then
      return jsonb_build_object('ok', false, 'status', 'account_exists');
    end if;
    if exists (select 1 from public.accounts account where account.username = v_username) then
      return jsonb_build_object('ok', false, 'status', 'username_conflict');
    end if;
    raise;
  end;

  select count(*)::integer,
         (array_agg(relationship.organization_id order by relationship.id))[1],
         (array_agg(relationship.organization_type order by relationship.id))[1]
    into v_relationship_count, v_org_id, v_org_type
  from public._staxis_cutover_valid_current_primary_property_relationships() relationship
  where relationship.property_id = p_hotel_id and relationship.active_primary_count = 1
    and relationship.organization_status = 'active';
  if not v_pending_approval then
    if v_org_type = 'single_hotel' then
      v_entitlement := public._staxis_stage_c_grant_independent_hotel(
        v_account_id, p_hotel_id, 'Access Stage C first-person join-code signup'
      );
      if coalesce((v_entitlement->>'ok')::boolean, false) is not true then
        raise exception 'first-person canonical entitlement did not activate: %', v_entitlement using errcode = '23514';
      end if;
    elsif v_org_type in ('management_company','ownership_group') then
      insert into public.organization_memberships (
        organization_id, account_id, job_category, status, starts_at,
        created_by_account_id, updated_by_account_id, membership_scope, staxis_role, covered_property_ids
      ) values (
        v_org_id, v_account_id,
        case when v_final_role = 'owner' then 'owner_principal' else 'hotel_employee' end,
        'active', v_now, v_account_id, v_account_id,
        case when v_final_role = 'owner' then 'company' else 'property' end,
        v_final_role, case when v_final_role = 'owner' then null else array[p_hotel_id] end
      ) returning id into v_membership_id;
      perform public._staxis_refresh_account_authorization(v_account_id, 'Access Stage C first-person company signup');
      if not exists (select 1 from public._staxis_account_property_authorizations(v_account_id) authz where authz.property_id = p_hotel_id) then
        raise exception 'first-person company entitlement did not activate' using errcode = '23514';
      end if;
    else
      raise exception 'first-person signup topology is unavailable' using errcode = '23514';
    end if;
  end if;
  if v_pending_approval then
    insert into public.join_requests (property_id, account_id, name, phone, language, department)
    values (p_hotel_id, v_account_id, v_display_name, v_phone, p_language, v_final_role);
  end if;
  if v_final_role = 'owner' then update public.properties property set owner_id = p_auth_user_id where property.id = p_hotel_id; end if;
  if v_code.code_kind = 'privileged_onboarding' then
    v_next_state := jsonb_set(v_onboarding_state, '{accountCreatedAt}', to_jsonb(v_now), true);
    v_next_state := jsonb_set(v_next_state, '{firstPersonAccountId}', to_jsonb(v_account_id::text), true);
    v_current_step := case when nullif(v_next_state->>'emailVerifiedAt','') is null then 3
      when nullif(v_next_state->>'hotelDetailsAt','') is null then 4
      when nullif(v_next_state->>'hotelContextAt','') is null then 5 else 6 end;
    v_next_state := jsonb_set(v_next_state, '{step}', to_jsonb(v_current_step), true);
    update public.properties property set onboarding_state = v_next_state where property.id = p_hotel_id;
  end if;
  insert into public.admin_audit_log (actor_user_id, actor_email, action, target_type, target_id, metadata)
  values (p_auth_user_id, v_actor_email, 'join_code.use', 'join_code', v_code.id::text,
    jsonb_build_object('account_id', v_account_id, 'hotel_id', p_hotel_id, 'role', v_final_role,
      'username', v_username, 'has_phone', v_phone is not null, 'owner_id_transferred', v_final_role = 'owner',
      'pending_approval', v_pending_approval, 'expected_used_count', p_expected_used_count,
      'used_count', p_expected_used_count + 1, 'request_id', nullif(btrim(p_request_id), ''),
      'authority_mode', case when v_pending_approval then 'normalized_pending' else 'normalized' end));
  return jsonb_build_object('ok', true, 'schemaVersion', 'join-code-signup-finalization-v1',
    'status', 'finalized', 'codeId', v_code.id, 'hotelId', v_code.hotel_id, 'accountId', v_account_id,
    'finalRole', v_final_role, 'username', v_username, 'pendingApproval', v_pending_approval,
    'usedCount', p_expected_used_count + 1);
end;
$$;

revoke all on function public.staxis_finalize_join_code_signup(
  uuid,text,uuid,integer,uuid,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_finalize_join_code_signup(
  uuid,text,uuid,integer,uuid,text,text,text,text,text,text
) to service_role;

-- Ownership transfer remains the legacy route's stable CAS/idempotency surface,
-- but its snapshots are now canonical resolver results and no branch can call
-- the retired Stage B importer.
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
  v_old public.accounts%rowtype;
  v_new public.accounts%rowtype;
  v_actor_access jsonb;
  v_old_access jsonb;
  v_new_access jsonb;
  v_actor_ids uuid[];
  v_old_ids uuid[];
  v_new_ids uuid[];
  v_expected_old_ids uuid[];
  v_expected_new_ids uuid[];
  v_property_id uuid;
  v_operation_audit boolean;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if p_operation_id is null or p_actor_account_id is null or p_actor_auth_user_id is null
     or p_property_id is null or p_old_owner_account_id is null or p_new_owner_account_id is null
     or p_expected_old_active is null or p_expected_old_role is null or p_expected_old_auth_user_id is null
     or p_expected_old_property_access is null or p_expected_old_intent_version is null
     or p_expected_new_active is null or p_expected_new_role is null or p_expected_new_auth_user_id is null
     or p_expected_new_property_access is null or p_expected_new_intent_version is null
     or nullif(btrim(p_request_id), '') is null or char_length(btrim(p_request_id)) > 200 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if p_old_owner_account_id = p_new_owner_account_id then
    return jsonb_build_object('status', 'invalid', 'reason', 'same_account');
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    return jsonb_build_object('status', 'invalid', 'reason', 'reason');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('staxis.transfer-ownership:' || p_operation_id::text, 0));
  perform 1 from public.accounts account
   where account.id = any(array[p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id])
   order by account.id for update;
  select * into v_actor from public.accounts where id = p_actor_account_id;
  select * into v_old from public.accounts where id = p_old_owner_account_id;
  select * into v_new from public.accounts where id = p_new_owner_account_id;
  if v_actor.id is null or v_old.id is null or v_new.id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_actor.data_user_id is distinct from p_actor_auth_user_id then return jsonb_build_object('status', 'forbidden', 'reason', 'actor'); end if;
  if exists (
    select 1 from public.account_lifecycle_intents intent
    where intent.status in ('pending','processing')
      and intent.account_id = any(array[p_actor_account_id, p_old_owner_account_id, p_new_owner_account_id])
  ) then return jsonb_build_object('status', 'pending_conflict'); end if;
  if exists (
    select 1 from public.admin_audit_log audit
    where audit.action = 'account.transfer_ownership'
      and audit.actor_user_id = p_actor_auth_user_id
      and audit.target_type = 'account' and audit.target_id = p_new_owner_account_id::text
      and audit.metadata->>'operation_id' = p_operation_id::text
      and audit.metadata->>'hotel_id' = p_property_id::text
  ) then
    if v_old.role = 'general_manager' and v_new.role = 'owner' then
      return jsonb_build_object('status', 'already_applied', 'operation_id', p_operation_id,
        'old_owner_account_id', v_old.id, 'new_owner_account_id', v_new.id);
    end if;
    return jsonb_build_object('status', 'conflict', 'reason', 'replay_state_changed');
  end if;
  if exists (select 1 from public.admin_audit_log audit where audit.action = 'account.transfer_ownership'
      and audit.metadata->>'operation_id' = p_operation_id::text) then
    return jsonb_build_object('status', 'conflict', 'reason', 'operation_id_reused');
  end if;
  v_actor_access := public.staxis_list_account_authorized_properties(v_actor.id);
  v_old_access := public.staxis_list_account_authorized_properties(v_old.id);
  v_new_access := public.staxis_list_account_authorized_properties(v_new.id);
  if coalesce((v_actor_access->>'ok')::boolean, false) is not true
     or coalesce((v_old_access->>'ok')::boolean, false) is not true
     or coalesce((v_new_access->>'ok')::boolean, false) is not true then
    return jsonb_build_object('status', 'forbidden', 'reason', 'authority_unavailable');
  end if;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_actor_ids from jsonb_array_elements_text(coalesce(v_actor_access->'propertyIds','[]'::jsonb)) value;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_old_ids from jsonb_array_elements_text(coalesce(v_old_access->'propertyIds','[]'::jsonb)) value;
  select coalesce(array_agg(value::text::uuid order by value::text), '{}'::uuid[])
    into v_new_ids from jsonb_array_elements_text(coalesce(v_new_access->'propertyIds','[]'::jsonb)) value;
  v_expected_old_ids := public._staxis_stage_c_expected_property_ids(p_expected_old_property_access);
  v_expected_new_ids := public._staxis_stage_c_expected_property_ids(p_expected_new_property_access);
  if not (p_property_id = any(v_old_ids)) or not (p_property_id = any(v_new_ids))
     or v_old_ids is distinct from v_new_ids
     or v_old_ids is distinct from v_expected_old_ids
     or v_new_ids is distinct from v_expected_new_ids then
    return jsonb_build_object('status', 'conflict', 'reason', 'hotel_access_mismatch');
  end if;
  if v_actor.active is not true or v_old.role <> 'owner' or v_new.role in ('admin','owner')
     or not v_old.active or not v_new.active
     or v_old.active is distinct from p_expected_old_active or v_old.role is distinct from p_expected_old_role
     or v_old.data_user_id is distinct from p_expected_old_auth_user_id
     or v_old.lifecycle_intent_version is distinct from p_expected_old_intent_version
     or v_new.active is distinct from p_expected_new_active or v_new.role is distinct from p_expected_new_role
     or v_new.data_user_id is distinct from p_expected_new_auth_user_id
     or v_new.lifecycle_intent_version is distinct from p_expected_new_intent_version then
    return jsonb_build_object('status', 'conflict');
  end if;
  if v_actor.role <> 'admin' and (v_actor.id is distinct from v_old.id or v_actor.role is distinct from 'owner') then
    return jsonb_build_object('status', 'forbidden', 'reason', 'current_owner');
  end if;
  if v_actor.role <> 'admin' and (not (p_property_id = any(v_actor_ids))
     or not (v_old_ids <@ v_actor_ids) or not (v_new_ids <@ v_actor_ids)) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'scope');
  end if;
  if v_actor.role <> 'admin' and exists (
    select 1 from unnest(v_old_ids) affected(property_id)
    join public.capability_overrides override_row on override_row.property_id = affected.property_id
      and override_row.capability = 'manage_users' and override_row.role = v_actor.role and override_row.allowed is false
  ) then return jsonb_build_object('status', 'forbidden', 'reason', 'manage_users'); end if;
  if exists (
    select 1 from unnest(v_old_ids) affected(property_id)
    where not exists (
      select 1 from public._staxis_current_primary_property_relationships() relationship
      join public.organizations organization on organization.id = relationship.organization_id
        and organization.organization_type = 'single_hotel' and organization.status = 'active'
      where relationship.property_id = affected.property_id and relationship.active_primary_count = 1
    )
  ) then return jsonb_build_object('status', 'forbidden', 'reason', 'company_owned_hotel'); end if;
  if exists (select 1 where public._staxis_account_is_live_organization_owner(v_old.id)
      or public._staxis_account_is_live_organization_owner(v_new.id)) then
    return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_organization_owner');
  end if;
  begin
    for v_property_id in select affected.id from unnest(v_old_ids) affected(id) order by affected.id loop
      perform 1 from public.properties property where property.id = v_property_id for update nowait;
      if not found then return jsonb_build_object('status', 'not_found', 'reason', 'hotel_scope'); end if;
      perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
    end loop;
  exception when lock_not_available or deadlock_detected then
    return jsonb_build_object('status', 'retry');
  end;
  perform 1 from public.account_authorization_state state
   where state.account_id = any(array[p_actor_account_id,p_old_owner_account_id,p_new_owner_account_id])
   order by state.account_id for update;
  if exists (
    select 1 from public.account_authorization_state state
    where state.account_id in (p_old_owner_account_id,p_new_owner_account_id)
      and state.authority_mode <> 'normalized'
  ) then return jsonb_build_object('status', 'forbidden', 'reason', 'normalized_authority'); end if;

  perform set_config('staxis.actor_account_id', v_actor.id::text, true);
  perform set_config('staxis.request_id', btrim(p_request_id), true);
  update public.accounts set role = 'owner' where id = v_new.id;
  update public.accounts set role = 'general_manager' where id = v_old.id;
  insert into public.role_changes (account_id, property_id, changed_by_account_id, old_role, new_role, change_kind, reason)
    select v_new.id, affected.id, v_actor.id, v_new.role, 'owner', 'transfer_ownership', v_reason
    from unnest(v_new_ids) affected(id);
  insert into public.role_changes (account_id, property_id, changed_by_account_id, old_role, new_role, change_kind, reason)
    select v_old.id, affected.id, v_actor.id, v_old.role, 'general_manager', 'transfer_ownership', v_reason
    from unnest(v_old_ids) affected(id);
  insert into public.admin_audit_log (actor_user_id, actor_email, action, target_type, target_id, metadata)
  values (p_actor_auth_user_id, nullif(btrim(p_actor_email), ''), 'account.transfer_ownership', 'account', v_new.id::text,
    jsonb_build_object('hotel_id', p_property_id, 'operation_id', p_operation_id,
      'from_account_id', v_old.id, 'to_account_id', v_new.id,
      'from_old_role', v_old.role, 'to_old_role', v_new.role,
      'from_active', v_old.active, 'to_active', v_new.active,
      'from_auth_user_id', v_old.data_user_id, 'to_auth_user_id', v_new.data_user_id,
      'from_property_access', to_jsonb(v_old_ids), 'to_property_access', to_jsonb(v_new_ids),
      'old_owner_affected_hotel_ids', to_jsonb(v_old_ids), 'new_owner_affected_hotel_ids', to_jsonb(v_new_ids),
      'global_account_change', true, 'authority_mode', 'normalized', 'reason', v_reason, 'request_id', p_request_id));
  return jsonb_build_object('status', 'ok', 'operation_id', p_operation_id,
    'old_owner_account_id', v_old.id, 'new_owner_account_id', v_new.id);
end;
$$;

revoke all on function public.staxis_transfer_ownership_guarded(
  uuid,uuid,uuid,text,uuid,uuid,uuid,boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) from public, anon, authenticated;
grant execute on function public.staxis_transfer_ownership_guarded(
  uuid,uuid,uuid,text,uuid,uuid,uuid,boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
) to service_role;

-- The pending-lifecycle trigger remains a fail-closed CAS guard, but its
-- allowed commit comparison is canonical-only. It no longer reads the raw
-- property array, and the trigger event list no longer treats that column as
-- an active lifecycle input.
create or replace function public._staxis_guard_pending_account_lifecycle_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pending public.account_lifecycle_intents%rowtype;
  v_commit_operation text;
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.account_lifecycle_intents intent
      where intent.status = 'pending'
        and (intent.account_id = old.id or intent.actor_account_id = old.id)
    ) then
      raise exception 'account lifecycle change pending' using errcode = '55000';
    end if;
    return old;
  end if;

  select * into v_pending
  from public.account_lifecycle_intents intent
  where intent.account_id = old.id and intent.status = 'pending';
  if not found then return new; end if;
  v_commit_operation := nullif(current_setting('staxis.account_lifecycle_operation_id', true), '');
  if v_commit_operation = v_pending.operation_id::text
     and new.active is not distinct from v_pending.desired_active
     and new.role is not distinct from old.role
     and new.data_user_id is not distinct from old.data_user_id
     and new.display_name is not distinct from old.display_name
     and new.staff_id is not distinct from old.staff_id then
    return new;
  end if;
  raise exception 'account lifecycle change pending' using errcode = '55000';
end;
$$;

revoke all on function public._staxis_guard_pending_account_lifecycle_mutation()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_accounts_guard_pending_lifecycle_mutation on public.accounts;
create trigger trg_accounts_guard_pending_lifecycle_mutation
  before delete or update of active, role, data_user_id, display_name, staff_id
  on public.accounts
  for each row execute function public._staxis_guard_pending_account_lifecycle_mutation();

-- Activity-log account hooks now use the same canonical structural scope. An
-- account created before its entitlement is attached simply emits its later
-- canonical bridge/staff-link audit; it must never reintroduce an array read.
create or replace function public._activity_log_on_account_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id uuid;
  v_property_ids uuid[] := public._staxis_structural_account_property_ids(new.id);
begin
  foreach v_property_id in array v_property_ids loop
    perform public._activity_log_write(
      v_property_id, new.created_at, 'staff', 'user_created', null,
      new.data_user_id, 'user', new.id::text, new.display_name,
      format('User %s was added with role %s', new.display_name, new.role),
      'admin_dashboard', new.id,
      jsonb_build_object('account_id', new.id, 'username', new.username,
                         'display_name', new.display_name, 'role', new.role)
    );
  end loop;
  return new;
end;
$$;

create or replace function public._activity_log_on_account_role_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id uuid;
  v_property_ids uuid[];
begin
  if old.role is not distinct from new.role then return new; end if;
  v_property_ids := public._staxis_structural_account_property_ids(new.id);
  foreach v_property_id in array v_property_ids loop
    perform public._activity_log_write(
      v_property_id, new.updated_at, 'staff', 'role_changed', null,
      new.data_user_id, 'user', new.id::text, new.display_name,
      format('User %s, role changed from %s to %s', new.display_name, old.role, new.role),
      'admin_dashboard', new.id,
      jsonb_build_object('account_id', new.id, 'display_name', new.display_name,
                         'old_role', old.role, 'new_role', new.role)
    );
  end loop;
  return new;
end;
$$;

-- Auth rollback compensation retains the original API envelope while taking
-- its lifecycle scope from the canonical structural resolver. The legacy
-- snapshot column is retained only as a canonical CAS receipt.
create or replace function public.staxis_compensate_account_lifecycle_intent(
  p_operation_id uuid,
  p_reason text,
  p_processor_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid;
  v_intent public.account_lifecycle_intents%rowtype;
  v_target public.accounts%rowtype;
  v_scope_ids uuid[];
  v_compensation_id uuid := gen_random_uuid();
  v_version bigint;
begin
  select account_id into v_account_id
  from public.account_lifecycle_intents
  where operation_id = p_operation_id;
  if v_account_id is null then return jsonb_build_object('status', 'not_found'); end if;
  perform 1 from public.accounts where id = v_account_id for update;
  select * into v_intent from public.account_lifecycle_intents
  where operation_id = p_operation_id for update;
  select * into v_target from public.accounts where id = v_account_id;
  if v_target.id is null then return jsonb_build_object('status', 'not_found'); end if;
  if v_target.lifecycle_intent_version > v_intent.version and v_intent.status = 'committed' then
    return jsonb_build_object('status', 'superseded', 'active', v_target.active,
      'desired_active', v_target.lifecycle_desired_active,
      'intent_version', v_target.lifecycle_intent_version);
  end if;
  if v_intent.status = 'committed' then return jsonb_build_object('status', 'committed', 'active', v_target.active); end if;
  if v_intent.status = 'aborted' then return jsonb_build_object('status', 'aborted', 'active', v_target.active); end if;
  if p_processor_token is null
     or v_intent.processor_token is distinct from p_processor_token
     or v_intent.processor_lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  v_scope_ids := public._staxis_structural_account_property_ids(v_target.id);
  if v_target.lifecycle_intent_version <> v_intent.version then
    update public.account_lifecycle_intents
       set status = 'aborted', aborted_at = now(), processor_token = null,
           processor_lease_expires_at = null,
           abort_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Superseded lifecycle intent'), 500),
           updated_at = now()
     where operation_id = v_intent.operation_id;
    insert into public.admin_audit_log (
      actor_user_id, actor_email, action, target_type, target_id, metadata
    ) values (
      v_intent.actor_auth_user_id, v_intent.actor_email,
      'account.lifecycle_superseded', 'account', v_target.id::text,
      jsonb_build_object('hotel_id', v_intent.hotel_id, 'operation_id', v_intent.operation_id,
        'active', v_target.active, 'latest_lifecycle_version', v_target.lifecycle_intent_version,
        'reason', left(coalesce(nullif(btrim(p_reason), ''), 'Superseded lifecycle intent'), 500))
    );
    return jsonb_build_object('status', 'aborted', 'active', v_target.active,
      'intent_version', v_target.lifecycle_intent_version);
  end if;

  v_version := v_target.lifecycle_intent_version + 1;
  update public.account_lifecycle_intents
     set status = 'aborted', aborted_at = now(), processor_token = null,
         processor_lease_expires_at = null,
         abort_reason = left(coalesce(nullif(btrim(p_reason), ''), 'Auth state not changed'), 500),
         updated_at = now()
   where operation_id = v_intent.operation_id;
  update public.accounts
     set lifecycle_desired_active = v_target.active,
         lifecycle_intent_version = v_version,
         lifecycle_committed_version = v_version
   where id = v_target.id;
  insert into public.account_lifecycle_intents (
    operation_id, account_id, version, desired_active, prior_active,
    auth_user_id_snapshot, target_role_snapshot,
    target_property_access_snapshot, target_authorized_property_ids_snapshot,
    actor_account_id, actor_auth_user_id, actor_email, hotel_id,
    status, committed_at, compensates_operation_id, last_error
  ) values (
    v_compensation_id, v_target.id, v_version, v_target.active, v_target.active,
    v_target.data_user_id, v_target.role, v_scope_ids, v_scope_ids,
    v_intent.actor_account_id, v_intent.actor_auth_user_id, v_intent.actor_email,
    v_intent.hotel_id, 'committed', now(), v_intent.operation_id,
    left(coalesce(nullif(btrim(p_reason), ''), 'Auth state not changed'), 500)
  );
  insert into public.admin_audit_log (
    actor_user_id, actor_email, action, target_type, target_id, metadata
  ) values (
    v_intent.actor_auth_user_id, v_intent.actor_email,
    'account.lifecycle_compensated', 'account', v_target.id::text,
    jsonb_build_object('hotel_id', v_intent.hotel_id, 'operation_id', v_intent.operation_id,
      'compensation_operation_id', v_compensation_id, 'active', v_target.active,
      'canonical_property_ids', to_jsonb(v_scope_ids),
      'reason', left(coalesce(nullif(btrim(p_reason), ''), 'Auth state not changed'), 500))
  );
  return jsonb_build_object('status', 'aborted', 'operation_id', v_intent.operation_id,
    'compensation_operation_id', v_compensation_id, 'active', v_target.active,
    'intent_version', v_version);
end;
$$;

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
  if tg_op = 'UPDATE' then
    raise exception 'final access contract rejects all accounts.property_access writes'
      using errcode = '42501';
  elsif tg_op = 'INSERT'
        and new.property_access is not null then
    raise exception 'final access contract rejects accounts.property_access writes'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public._staxis_reject_final_legacy_property_access_write()
  from public, anon, authenticated, service_role;

-- New properties still need one canonical topology anchor before an admin
-- route can attach them to a company or before first-person onboarding can
-- grant the owner entitlement.  The Stage A/B property trigger also imported
-- raw account arrays; this replacement creates topology only and has no
-- dependency on accounts.property_access.
create or replace function public._staxis_ensure_canonical_property_topology()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_has_primary boolean;
begin
  insert into public.organizations (
    name, organization_type, status, legacy_property_id
  ) values (
    new.name, 'single_hotel', 'active', new.id
  )
  on conflict (legacy_property_id) do update
    set name = excluded.name,
        status = 'active',
        updated_at = clock_timestamp()
  returning id into v_organization_id;

  if v_organization_id is null then
    select organization.id into v_organization_id
    from public.organizations organization
    where organization.legacy_property_id = new.id
    for update;
  end if;
  if v_organization_id is null then
    raise exception 'canonical property topology anchor could not be created'
      using errcode = '23514';
  end if;

  select exists (
    select 1
    from public.organization_property_relationships relationship
    where relationship.property_id = new.id
      and relationship.is_primary_grouping is true
      and relationship.ends_at is null
  ) into v_has_primary;

  insert into public.organization_property_relationships (
    organization_id, property_id, relationship_type, is_primary_grouping
  ) values (
    v_organization_id, new.id, 'operator', not v_has_primary
  ) on conflict do nothing;

  return new;
end;
$$;

revoke all on function public._staxis_ensure_canonical_property_topology()
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

    if v_state.authority_mode in ('legacy', 'shadow')
       and cardinality(v_raw_ids) > 0 then
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
    on conflict (account_id) do nothing;
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
  drop trigger if exists trg_properties_reconcile_legacy_organization_access
    on public.properties;
  drop trigger if exists trg_properties_ensure_canonical_property_topology
    on public.properties;
  create trigger trg_properties_ensure_canonical_property_topology
    after insert on public.properties
    for each row execute function public._staxis_ensure_canonical_property_topology();

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
drop function if exists public._staxis_reconcile_property_trigger();
drop function if exists public._staxis_reconcile_account_trigger();
drop function if exists public._staxis_reconcile_legacy_organization_access(uuid, uuid);
drop function if exists public.staxis_reconcile_legacy_organization_access(uuid, uuid);
drop function if exists public.staxis_preflight_authorization_cutover_labeled(text);
drop function if exists public.staxis_preflight_authorization_cutover();
drop function if exists public.staxis_assert_stage_a_access_invariants();
drop function if exists public._staxis_stage_b_validate_legacy_scope(uuid);
drop function if exists public._staxis_stage_b_import_legacy_scope(uuid, text);
drop function if exists public.staxis_people_access_shadow(uuid, uuid);
drop function if exists public.staxis_invite_access_shadow(uuid);
drop function if exists public.staxis_promote_shadow_authorization(uuid, text);
drop function if exists public._staxis_accept_account_invite_0393_impl(text, uuid, uuid, text, text);
drop function if exists public._staxis_update_hotel_team_profile_guarded_legacy_cas(
  uuid,uuid,text,uuid,uuid,boolean,text,boolean,uuid,boolean,text,uuid,
  uuid[],uuid[],text,uuid,timestamptz,bigint,text
);
drop function if exists public._staxis_change_hotel_team_role_guarded_legacy_impl(
  uuid,uuid,text,uuid,uuid,text,text,boolean,text,uuid,uuid[],text,timestamptz,bigint,text
);
drop function if exists public._staxis_transfer_ownership_guarded_legacy_impl(
  uuid,uuid,uuid,text,uuid,uuid,uuid,boolean,text,uuid,uuid[],bigint,
  boolean,text,uuid,uuid[],bigint,text,text
);
drop function if exists public.staxis_transfer_ownership(uuid, uuid, uuid);
drop function if exists public.staxis_grant_property_access(uuid, uuid);
drop function if exists public.staxis_remove_property_access(uuid, uuid);
drop function if exists public.staxis_remove_property_access_guarded(uuid, uuid, text, timestamptz);
drop function if exists public._staxis_remove_property_access_guarded_legacy_impl(uuid, uuid, text, timestamptz);
drop function if exists public.staxis_remove_property_access_guarded_v2(
  uuid,uuid,text,uuid,uuid,text,timestamptz,text
);

insert into public.applied_migrations (version, description)
values (
  '0426',
  'Access Stage C canonical-only contract, final receipts, array teardown, and fail-closed enforcement'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
