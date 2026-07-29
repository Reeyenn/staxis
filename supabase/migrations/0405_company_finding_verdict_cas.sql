-- 0405 — Per-hotel authority + atomic CAS for company finding verdicts.
--
-- Organization-level queue access is read-only authority.  A company Owner or
-- VP may inspect aggregate cards but may not mutate the private operating state
-- of every hotel by implication.  This migration creates one service-only
-- transaction boundary which:
--   * reasserts a fresh exact property-subset authorization receipt;
--   * binds it to the finding's canonical non-empty affected-property set;
--   * requires current hotelMutationAllowed and the closed action/finding
--     capability policy at every affected hotel;
--   * locks capability overrides while deciding;
--   * compares status + timestamp + revision before one update; and
--   * records an immutable audit event.
--
-- The BEFORE trigger also makes DB-first rolling deployment safe: an old app's
-- direct service-role update into known_problem/muted/resolved is refused, not
-- silently authorized.  Ordinary detector refreshes, escalations and expiry
-- continue to work and advance the revision token.

begin;

do $$
begin
  if to_regclass('public.company_findings') is null
     or to_regclass('public.authorization_scope_receipts') is null
     or to_regclass('public.capability_overrides') is null
     or to_regprocedure('public.staxis_assert_authorization_scope_receipt(uuid,uuid)') is null
     or to_regprocedure('public.staxis_list_account_authorized_properties(uuid)') is null
     or to_regprocedure('public._staxis_current_primary_property_relationships()') is null then
    raise exception '0405 requires company findings and authoritative access through 0403'
      using errcode = '55000';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'company_findings'
      and column_name = 'affected_property_ids'
  ) then
    raise exception '0405 requires 0390 company finding affected-property scope'
      using errcode = '55000';
  end if;
end
$$;

alter table public.company_findings
  add column if not exists verdict_revision bigint not null default 1;

-- Normalize only legacy (non-management-pattern) projections. New pattern
-- candidates already carry an authoritative affected_property_ids array. The
-- legacy app may be deployed before or after this migration, so prefer its new
-- explicit affected_hotel_ids evidence when present; otherwise only the supply
-- detector has a safely derivable target (the first, high-spend row in its
-- ranked comparison input). Activity rows without machine ids stay empty and
-- therefore visibly non-actionable until their next detector refresh. Names
-- are never reverse-resolved.
do $$
declare
  v_row record;
  v_candidate jsonb;
  v_affected uuid[];
  v_count integer;
begin
  for v_row in
    select id, organization_id, detector_id, evidence
    from public.company_findings
    where latest_pattern_candidate_id is null
      and detector_id in ('portfolio_supply_spend_gap', 'portfolio_activity_stopped')
  loop
    v_affected := '{}'::uuid[];
    v_candidate := v_row.evidence #> '{params,affected_hotel_ids}';
    begin
      if jsonb_typeof(v_candidate) = 'array'
         and jsonb_array_length(v_candidate) between 1 and 250 then
        select array_agg(distinct value::uuid order by value::uuid), count(*)
          into v_affected, v_count
        from jsonb_array_elements_text(v_candidate) item(value);
        if v_count <> cardinality(v_affected) then
          v_affected := '{}'::uuid[];
        end if;
      elsif v_row.detector_id = 'portfolio_supply_spend_gap'
         and jsonb_typeof(v_row.evidence #> '{params,hotel_ids}') = 'array'
         and jsonb_array_length(v_row.evidence #> '{params,hotel_ids}') > 0 then
        v_affected := array[(v_row.evidence #>> '{params,hotel_ids,0}')::uuid];
      end if;
    exception when invalid_text_representation or data_exception then
      v_affected := '{}'::uuid[];
    end;

    -- A stale/foreign/ambiguous topology is not a target. Detector refresh can
    -- repopulate the row only after current organization topology is explicit.
    if cardinality(v_affected) > 0 and (
      select count(*)
      from unnest(v_affected) affected(property_id)
      join public._staxis_current_primary_property_relationships() relationship
        on relationship.property_id = affected.property_id
       and relationship.organization_id = v_row.organization_id
       and relationship.active_primary_count = 1
    ) <> cardinality(v_affected) then
      v_affected := '{}'::uuid[];
    end if;

    update public.company_findings
       set affected_property_ids = coalesce(v_affected, '{}'::uuid[])
     where id = v_row.id;
  end loop;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.company_findings'::regclass
      and conname = 'company_findings_verdict_revision_positive'
  ) then
    alter table public.company_findings
      add constraint company_findings_verdict_revision_positive
      check (verdict_revision > 0);
  end if;
end
$$;

-- An unprivileged service-role session can set arbitrary custom GUCs, so a GUC
-- is NOT a safe call-path marker. This owner-private table instead records the
-- current transaction only while the SECURITY DEFINER RPC performs its update.
-- The marker is inserted and removed inside the same transaction and therefore
-- is never durable evidence; the immutable event below is the durable audit.
create table if not exists public.company_finding_verdict_transaction_markers (
  transaction_id          xid8 not null,
  finding_id              uuid not null,
  actor_account_id        uuid not null,
  authorization_receipt_id uuid not null,
  primary key (transaction_id, finding_id)
);

alter table public.company_finding_verdict_transaction_markers enable row level security;
revoke all on public.company_finding_verdict_transaction_markers
  from public, anon, authenticated, service_role;
drop policy if exists company_finding_verdict_transaction_markers_deny_all
  on public.company_finding_verdict_transaction_markers;
create policy company_finding_verdict_transaction_markers_deny_all
  on public.company_finding_verdict_transaction_markers
  for all to anon, authenticated, service_role using (false) with check (false);

-- One trigger owns both the monotonic CAS token and the rolling-deploy fence.
create or replace function public._staxis_company_finding_verdict_revision_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('known_problem', 'muted', 'resolved')
     and (
       new.status is distinct from old.status
       or new.status_changed_at is distinct from old.status_changed_at
       or new.status_changed_by is distinct from old.status_changed_by
       or new.resolved_at is distinct from old.resolved_at
       or new.silenced_at_magnitude is distinct from old.silenced_at_magnitude
     )
     and not exists (
       select 1
       from public.company_finding_verdict_transaction_markers marker
       where marker.transaction_id = pg_current_xact_id()
         and marker.finding_id = old.id
         and marker.actor_account_id = new.status_changed_by
     ) then
    raise exception 'company finding verdicts require the authoritative CAS RPC'
      using errcode = '42501';
  end if;
  new.verdict_revision := old.verdict_revision + 1;
  return new;
end
$$;

revoke all on function public._staxis_company_finding_verdict_revision_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_company_findings_verdict_revision_guard
  on public.company_findings;
create trigger trg_company_findings_verdict_revision_guard
  before update on public.company_findings
  for each row execute function public._staxis_company_finding_verdict_revision_guard();

-- Append-only proof of the exact hotels, receipt, capabilities and row token
-- accepted by the commit.  IDs are intentionally retained without cascading
-- foreign keys so account/company cleanup cannot rewrite historical evidence.
-- @rls: service-role-only — immutable authorization audit with no browser surface.
create table if not exists public.company_finding_verdict_events (
  id                         uuid primary key default gen_random_uuid(),
  organization_id            uuid not null,
  finding_id                 uuid not null,
  actor_account_id           uuid not null,
  authorization_receipt_id   uuid not null,
  action                     text not null
    check (action in ('known_problem', 'muted', 'resolved')),
  affected_property_ids      uuid[] not null,
  required_capabilities      text[] not null,
  required_sections          text[] not null,
  authorization_hash         text not null,
  scope_hash                 text not null,
  resolver_version           text not null,
  account_authorization_version bigint not null,
  organization_access_epoch  bigint not null,
  receipt_resolved_at        timestamptz not null,
  receipt_expires_at         timestamptz not null,
  detector_id                text not null,
  semantic_family            text,
  from_status                text not null,
  to_status                  text not null,
  from_verdict_revision      bigint not null check (from_verdict_revision > 0),
  to_verdict_revision        bigint not null check (to_verdict_revision > from_verdict_revision),
  committed_at               timestamptz not null default clock_timestamp(),
  constraint company_finding_verdict_events_scope_check check (
    cardinality(affected_property_ids) between 1 and 250
    and array_position(affected_property_ids, null) is null
  ),
  constraint company_finding_verdict_events_capabilities_check check (
    cardinality(required_capabilities) between 1 and 8
    and array_position(required_capabilities, null) is null
    and required_capabilities <@ array[
      'manage_checklists', 'manage_inventory_orders', 'manage_notifications',
      'run_reports', 'view_financials'
    ]::text[]
  ),
  constraint company_finding_verdict_events_sections_check check (
    cardinality(required_sections) between 1 and 4
    and array_position(required_sections, null) is null
    and required_sections <@ array[
      'staxis', 'dashboard', 'maintenance', 'inventory', 'financials'
    ]::text[]
  ),
  constraint company_finding_verdict_events_receipt_proof_check check (
    authorization_hash ~ '^[0-9a-f]{64}$'
    and scope_hash ~ '^[0-9a-f]{64}$'
    and account_authorization_version > 0
    and organization_access_epoch > 0
    and receipt_expires_at > receipt_resolved_at
    and char_length(resolver_version) between 1 and 120
    and char_length(detector_id) between 1 and 160
    and (semantic_family is null or char_length(semantic_family) between 1 and 80)
  ),
  unique (finding_id, to_verdict_revision)
);

create index if not exists company_finding_verdict_events_org_time_idx
  on public.company_finding_verdict_events (organization_id, committed_at desc);
create index if not exists company_finding_verdict_events_finding_revision_idx
  on public.company_finding_verdict_events (finding_id, to_verdict_revision desc);

alter table public.company_finding_verdict_events enable row level security;
revoke all on public.company_finding_verdict_events
  from public, anon, authenticated, service_role;
grant select on public.company_finding_verdict_events to service_role;
drop policy if exists company_finding_verdict_events_deny_browser
  on public.company_finding_verdict_events;
create policy company_finding_verdict_events_deny_browser
  on public.company_finding_verdict_events
  for all to anon, authenticated using (false) with check (false);

create or replace function public._staxis_company_finding_verdict_event_immutable()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'company finding verdict events are immutable'
    using errcode = '55000';
end
$$;

revoke all on function public._staxis_company_finding_verdict_event_immutable()
  from public, anon, authenticated, service_role;
drop trigger if exists trg_company_finding_verdict_events_immutable
  on public.company_finding_verdict_events;
create trigger trg_company_finding_verdict_events_immutable
  before update or delete on public.company_finding_verdict_events
  for each row execute function public._staxis_company_finding_verdict_event_immutable();

create or replace function public.staxis_set_company_finding_verdict_cas(
  p_authorization_receipt_id uuid,
  p_account_id uuid,
  p_organization_id uuid,
  p_finding_id uuid,
  p_expected_status text,
  p_expected_status_changed_at timestamptz,
  p_expected_verdict_revision bigint,
  p_expected_affected_property_ids uuid[],
  p_action text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
set lock_timeout = '5s'
set statement_timeout = '15s'
as $$
declare
  v_assertion jsonb;
  v_receipt public.authorization_scope_receipts%rowtype;
  v_finding public.company_findings%rowtype;
  v_access jsonb;
  v_standing jsonb;
  v_role text;
  v_standing_count integer;
  v_property_id uuid;
  v_capability text;
  v_section text;
  v_enabled_sections jsonb;
  v_family_capabilities text[];
  v_required_sections text[];
  v_activity_stream text;
  v_legacy_activity_stream text;
  v_pattern_activity_stream text;
  v_action_capability text;
  v_required_capabilities text[];
  v_canonical_affected uuid[];
  v_now timestamptz := clock_timestamp();
  v_new_revision bigint;
begin
  if p_authorization_receipt_id is null
     or p_account_id is null
     or p_organization_id is null
     or p_finding_id is null
     or p_expected_status_changed_at is null
     or p_expected_verdict_revision is null
     or p_expected_verdict_revision <= 0
     or p_expected_status not in (
       'open', 'updated', 'known_problem', 'muted', 'resolved', 'expired'
     )
     or p_action not in ('known_problem', 'muted', 'resolved')
     or p_expected_affected_property_ids is null
     or cardinality(p_expected_affected_property_ids) not between 1 and 250
     or array_position(p_expected_affected_property_ids, null) is not null then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
    into v_canonical_affected
  from unnest(p_expected_affected_property_ids) property_id;
  if v_canonical_affected is distinct from p_expected_affected_property_ids then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  -- This assertion locks the account authorization state and organization
  -- access epoch FOR SHARE. Revocation or hotel transfer therefore either wins
  -- before this statement and is observed, or waits until this commit ends.
  v_assertion := public.staxis_assert_authorization_scope_receipt(
    p_authorization_receipt_id,
    p_account_id
  );
  if v_assertion->'ok' is distinct from 'true'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  select receipt.* into v_receipt
  from public.authorization_scope_receipts receipt
  where receipt.id = p_authorization_receipt_id
    and receipt.account_id = p_account_id
    and receipt.organization_id = p_organization_id;
  if not found
     or v_receipt.selector_type <> 'property_subset'
     or v_receipt.requested_property_ids is distinct from p_expected_affected_property_ids
     or v_receipt.selected_property_ids is distinct from p_expected_affected_property_ids then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  -- Prevent an override update from landing between the capability decision and
  -- row commit. An already-running writer completes first and is then observed.
  lock table public.capability_overrides in share mode;

  select finding.* into v_finding
  from public.company_findings finding
  where finding.organization_id = p_organization_id
    and finding.id = p_finding_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  select coalesce(array_agg(distinct property_id order by property_id), '{}'::uuid[])
    into v_canonical_affected
  from unnest(v_finding.affected_property_ids) property_id;
  if cardinality(v_finding.affected_property_ids) not between 1 and 250
     or array_position(v_finding.affected_property_ids, null) is not null
     or v_canonical_affected is distinct from v_finding.affected_property_ids
     or v_finding.affected_property_ids is distinct from p_expected_affected_property_ids then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  -- Every affected hotel must still have one unambiguous active governing
  -- relationship to this exact organization. Receipt assertion already locks
  -- the organization's epoch, so a concurrent transfer cannot slip through.
  if (
    select count(*)
    from unnest(v_finding.affected_property_ids) affected(property_id)
    join public._staxis_current_primary_property_relationships() relationship
      on relationship.property_id = affected.property_id
     and relationship.organization_id = p_organization_id
     and relationship.active_primary_count = 1
  ) <> cardinality(v_finding.affected_property_ids) then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  -- Closed policy: unknown detector/family rows are intentionally read-only.
  -- A future producer must add an explicit capability mapping here before its
  -- cards may alter hotel operating state.
  if v_finding.semantic_family = 'supply_spend_control'
     or v_finding.detector_id = 'portfolio_supply_spend_gap' then
    v_family_capabilities := array['manage_inventory_orders', 'view_financials'];
    v_required_sections := array['financials', 'inventory', 'staxis'];
  elsif v_finding.semantic_family = 'portfolio_activity_stopped'
     or v_finding.detector_id = 'portfolio_activity_stopped' then
    v_family_capabilities := array['run_reports'];
    v_legacy_activity_stream := v_finding.evidence #>> '{params,stream}';
    v_pattern_activity_stream := v_finding.evidence ->> 'streamId';
    if v_legacy_activity_stream is not null
       and v_pattern_activity_stream is not null
       and v_legacy_activity_stream is distinct from v_pattern_activity_stream then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    v_activity_stream := coalesce(v_legacy_activity_stream, v_pattern_activity_stream);
    v_required_sections := case v_activity_stream
      when 'inventory_counts' then array['inventory', 'staxis']
      when 'daily_log_closings' then array['dashboard', 'staxis']
      when 'work_order_flow' then array['maintenance', 'staxis']
      else null
    end;
  else
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;
  if v_required_sections is null then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  v_action_capability := case p_action
    when 'resolved' then 'manage_checklists'
    else 'manage_notifications'
  end;
  select array_agg(distinct capability order by capability)
    into v_required_capabilities
  from unnest(v_family_capabilities || v_action_capability) capability;

  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  if v_access->'ok' is distinct from 'true'::jsonb
     or v_access->'all' is distinct from 'false'::jsonb
     or v_access->'authorityMode' is distinct from '"normalized"'::jsonb
     or jsonb_typeof(v_access->'propertyStandings') <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'denied');
  end if;

  foreach v_property_id in array v_finding.affected_property_ids loop
    select count(*) into v_standing_count
    from jsonb_array_elements(v_access->'propertyStandings') standing(value)
    where standing.value->>'propertyId' = v_property_id::text;
    if v_standing_count <> 1 then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    select standing.value into v_standing
    from jsonb_array_elements(v_access->'propertyStandings') standing(value)
    where standing.value->>'propertyId' = v_property_id::text;
    if not found
       or jsonb_typeof(v_standing) <> 'object'
       or not (v_standing ?& array[
         'propertyId', 'operationalRole', 'seesFinancials',
         'hotelMutationAllowed', 'portfolioIntelligenceRead', 'entitlements'
       ])
       or jsonb_typeof(v_standing->'propertyId') <> 'string'
       or jsonb_typeof(v_standing->'operationalRole') <> 'string'
       or jsonb_typeof(v_standing->'seesFinancials') <> 'boolean'
       or jsonb_typeof(v_standing->'hotelMutationAllowed') <> 'boolean'
       or jsonb_typeof(v_standing->'portfolioIntelligenceRead') <> 'boolean'
       or jsonb_typeof(v_standing->'entitlements') <> 'array'
       or v_standing->'hotelMutationAllowed' is distinct from 'true'::jsonb then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    v_role := v_standing->>'operationalRole';
    if v_role is null or v_role not in (
      'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance', 'staff'
    ) then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;

    -- Row locking makes a section toggle linearize with this commit. NULL or a
    -- missing key is the documented legacy default-on state; malformed values
    -- fail closed instead of erasing a hotel's explicit product boundary.
    select property.enabled_sections into v_enabled_sections
    from public.properties property
    where property.id = v_property_id
    for share;
    if not found
       or (v_enabled_sections is not null and jsonb_typeof(v_enabled_sections) <> 'object') then
      return jsonb_build_object('ok', false, 'reason', 'denied');
    end if;
    foreach v_section in array v_required_sections loop
      if v_enabled_sections is not null
         and v_enabled_sections ? v_section
         and v_enabled_sections -> v_section is distinct from 'true'::jsonb then
        return jsonb_build_object('ok', false, 'reason', 'denied');
      end if;
    end loop;

    foreach v_capability in array v_required_capabilities loop
      -- Mirrors the registry's non-liftable manager floor.
      if v_capability in ('view_financials', 'run_reports')
         and (v_role is null or v_role not in ('owner', 'general_manager')) then
        return jsonb_build_object('ok', false, 'reason', 'denied');
      end if;
      if exists (
        select 1
        from public.capability_overrides override_row
        where override_row.property_id = v_property_id
          and override_row.capability = v_capability
          and override_row.role = v_role
          and override_row.allowed is false
      ) then
        return jsonb_build_object('ok', false, 'reason', 'denied');
      end if;
    end loop;
  end loop;

  -- Idempotency is checked only after every current authorization/capability
  -- check. A retry after revocation must not reveal or reaffirm a prior write.
  if v_finding.status = p_action then
    return jsonb_build_object(
      'ok', true,
      'outcome', 'already_applied',
      'status', v_finding.status,
      'revision', v_finding.verdict_revision
    );
  end if;

  if v_finding.status not in ('open', 'updated', 'known_problem', 'muted')
     or v_finding.status is distinct from p_expected_status
     or v_finding.status_changed_at is distinct from p_expected_status_changed_at
     or v_finding.verdict_revision is distinct from p_expected_verdict_revision then
    return jsonb_build_object('ok', false, 'reason', 'conflict');
  end if;

  insert into public.company_finding_verdict_transaction_markers (
    transaction_id,
    finding_id,
    actor_account_id,
    authorization_receipt_id
  ) values (
    pg_current_xact_id(),
    p_finding_id,
    p_account_id,
    p_authorization_receipt_id
  );
  update public.company_findings finding
  set status = p_action,
      status_changed_at = v_now,
      status_changed_by = p_account_id,
      resolved_at = case when p_action = 'resolved' then v_now else null end,
      silenced_at_magnitude = case
        when p_action in ('known_problem', 'muted') then finding.magnitude
        else finding.silenced_at_magnitude
      end
  where finding.organization_id = p_organization_id
    and finding.id = p_finding_id
    and finding.status = p_expected_status
    and finding.status_changed_at = p_expected_status_changed_at
    and finding.verdict_revision = p_expected_verdict_revision
  returning finding.verdict_revision into v_new_revision;
  delete from public.company_finding_verdict_transaction_markers marker
  where marker.transaction_id = pg_current_xact_id()
    and marker.finding_id = p_finding_id;

  -- DELETE above changes PL/pgSQL FOUND. The UPDATE's RETURNING target is the
  -- durable row-count signal; testing FOUND here would turn a zero-row CAS into
  -- a false success whenever marker cleanup deleted its one row.
  if v_new_revision is null then
    return jsonb_build_object('ok', false, 'reason', 'conflict');
  end if;

  insert into public.company_finding_verdict_events (
    organization_id,
    finding_id,
    actor_account_id,
    authorization_receipt_id,
    action,
    affected_property_ids,
    required_capabilities,
    required_sections,
    authorization_hash,
    scope_hash,
    resolver_version,
    account_authorization_version,
    organization_access_epoch,
    receipt_resolved_at,
    receipt_expires_at,
    detector_id,
    semantic_family,
    from_status,
    to_status,
    from_verdict_revision,
    to_verdict_revision,
    committed_at
  ) values (
    p_organization_id,
    p_finding_id,
    p_account_id,
    p_authorization_receipt_id,
    p_action,
    p_expected_affected_property_ids,
    v_required_capabilities,
    v_required_sections,
    v_receipt.authorization_hash,
    v_receipt.scope_hash,
    v_receipt.resolver_version,
    v_receipt.account_authorization_version,
    v_receipt.organization_access_epoch,
    v_receipt.resolved_at,
    v_receipt.expires_at,
    v_finding.detector_id,
    v_finding.semantic_family,
    p_expected_status,
    p_action,
    p_expected_verdict_revision,
    v_new_revision,
    v_now
  );

  return jsonb_build_object(
    'ok', true,
    'outcome', 'applied',
    'status', p_action,
    'revision', v_new_revision
  );
end
$$;

revoke all on function public.staxis_set_company_finding_verdict_cas(
  uuid, uuid, uuid, uuid, text, timestamptz, bigint, uuid[], text
) from public, anon, authenticated, service_role;
grant execute on function public.staxis_set_company_finding_verdict_cas(
  uuid, uuid, uuid, uuid, text, timestamptz, bigint, uuid[], text
) to service_role;

comment on function public.staxis_set_company_finding_verdict_cas(
  uuid, uuid, uuid, uuid, text, timestamptz, bigint, uuid[], text
) is
  'Atomic company-finding verdict boundary: exact affected scope, final authorization/capability assertion, CAS and immutable audit. Company-level queue read authority alone never authorizes mutation.';

insert into public.applied_migrations (version, description)
values (
  '0405',
  'Per-hotel authoritative company-finding verdict CAS with final receipt assertion, closed capability policy, rolling old-writer denial and immutable audit events.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
