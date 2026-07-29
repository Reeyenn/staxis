-- 0405_atomic_company_queue_verdict.sql
--
-- A company-wide authorization receipt admits an aggregate READ.  It is never
-- itself permission to mutate every hotel named by a company finding.  This
-- migration makes the exact verdict a single commit-time database operation:
--
--   * lock the exact tenant/finding row and require canonical affected lineage;
--   * assert the caller's aggregate read receipt, then mint an exact
--     property_subset receipt for the locked affected hotels;
--   * re-read current hotel standing, topology, Staxis section state, and the
--     closed detector/action capability policy while their locks remain held;
--   * compare-and-swap a monotonic verdict revision;
--   * append an immutable audit event in the same transaction.
--
-- A trigger also fences verdict-shaped direct service-role writes.  That is a
-- rolling-deploy boundary: an old application instance which still calls the
-- former direct PostgREST update fails closed after 0405 instead of bypassing
-- the new policy.  Detector refreshes (open/updated/expired) keep working.

begin;

do $$
begin
  if to_regclass('public.company_findings') is null
     or to_regclass('public.authorization_scope_receipts') is null
     or to_regclass('public.properties') is null
     or to_regclass('public.capability_overrides') is null
     or to_regprocedure(
       'public.staxis_assert_authorization_scope_receipt(uuid,uuid)'
     ) is null
     or to_regprocedure(
       'public.staxis_resolve_authorization_scope(uuid,uuid,text,uuid,jsonb,integer)'
     ) is null
     or to_regprocedure(
       'public.staxis_list_account_authorized_properties(uuid)'
     ) is null
     or to_regprocedure(
       'public._staxis_current_primary_property_relationships()'
     ) is null
     or not exists (
       select 1
       from pg_attribute
       where attrelid = 'public.company_findings'::regclass
         and attname = 'affected_property_ids'
         and not attisdropped
     )
     or not exists (
       select 1
       from pg_attribute
       where attrelid = 'public.company_findings'::regclass
         and attname = 'semantic_family'
         and not attisdropped
     )
  then
    raise exception '0405 requires authoritative receipts/access, capability overrides, and 0390 company finding lineage';
  end if;
end
$$;

alter table public.company_findings
  add column if not exists verdict_revision bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.company_findings'::regclass
      and conname = 'company_findings_verdict_revision_check'
  ) then
    alter table public.company_findings
      add constraint company_findings_verdict_revision_check
      check (verdict_revision >= 0);
  end if;
end
$$;

create or replace function public._staxis_uuid_array_is_canonical_nonempty(
  p_value uuid[]
)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select cardinality(p_value) between 1 and 250
    and array_position(p_value, null) is null
    and p_value = (
      select array_agg(distinct element order by element)
      from unnest(p_value) element
    );
$$;

create or replace function public._staxis_company_verdict_audit_snapshot_valid(
  p_value jsonb
)
returns boolean
language plpgsql
immutable
strict
set search_path = pg_catalog
as $$
declare
  v_key_count integer;
begin
  if jsonb_typeof(p_value) <> 'object'
     or octet_length(p_value::text) > 2048
  then
    return false;
  end if;
  select count(*)::integer into v_key_count from jsonb_object_keys(p_value);
  return v_key_count = 6
    and p_value ?& array[
      'authorityMode', 'selectorType', 'authorizationHash', 'scopeHash',
      'accountAuthorizationVersion', 'organizationAccessEpoch'
    ]
    and p_value ->> 'authorityMode' = 'normalized'
    and p_value ->> 'selectorType' = 'property_subset'
    and p_value ->> 'authorizationHash' ~ '^[0-9a-f]{64}$'
    and p_value ->> 'scopeHash' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(p_value -> 'accountAuthorizationVersion') = 'number'
    and jsonb_typeof(p_value -> 'organizationAccessEpoch') = 'number'
    and (p_value ->> 'accountAuthorizationVersion') ~ '^[0-9]+$'
    and (p_value ->> 'organizationAccessEpoch') ~ '^[0-9]+$';
end
$$;

revoke all on function public._staxis_uuid_array_is_canonical_nonempty(uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public._staxis_company_verdict_audit_snapshot_valid(jsonb)
  from public, anon, authenticated, service_role;

-- Retain opaque subject ids just like authorization_scope_receipts.  Account,
-- finding, or company lifecycle cleanup must not erase or be blocked by the
-- immutable proof of a committed verdict.
-- @rls: service-role-only — immutable verdict evidence is never browser-readable;
-- the authorized SECURITY DEFINER RPC is the sole writer.
create table if not exists public.company_finding_verdict_events (
  id                         uuid primary key default gen_random_uuid(),
  organization_id            uuid not null,
  finding_id                 uuid not null,
  detector_id                text not null,
  semantic_family            text,
  actor_account_id           uuid not null,
  aggregate_read_receipt_id  uuid not null,
  exact_scope_receipt_id     uuid not null,
  action                     text not null,
  prior_status               text not null,
  resulting_status           text not null,
  prior_verdict_revision     bigint not null,
  resulting_verdict_revision bigint not null,
  affected_property_ids      uuid[] not null,
  required_capabilities      text[] not null,
  authority_snapshot         jsonb not null,
  occurred_at                timestamptz not null default clock_timestamp(),

  constraint company_finding_verdict_events_action_check
    check (action in ('known_problem', 'muted', 'resolved')),
  constraint company_finding_verdict_events_status_check
    check (prior_status in ('open','updated','known_problem','muted','resolved')
      and resulting_status = action),
  constraint company_finding_verdict_events_revision_check
    check (prior_verdict_revision >= 0
      and resulting_verdict_revision = prior_verdict_revision + 1),
  constraint company_finding_verdict_events_affected_check
    check (public._staxis_uuid_array_is_canonical_nonempty(affected_property_ids)),
  constraint company_finding_verdict_events_capabilities_check
    check (
      (detector_id = 'portfolio_supply_spend_gap'
        and (semantic_family is null or semantic_family = 'supply_spend_control')
        and required_capabilities = case action
          when 'resolved' then array[
            'manage_checklists','manage_inventory_orders','view_financials'
          ]::text[]
          else array[
            'manage_inventory_orders','manage_notifications','view_financials'
          ]::text[]
        end)
      or
      (detector_id = 'portfolio_activity_stopped'
        and (semantic_family is null or semantic_family = 'portfolio_activity_stopped')
        and required_capabilities = case action
          when 'resolved' then array['manage_checklists','run_reports']::text[]
          else array['manage_notifications','run_reports']::text[]
        end)
    ),
  constraint company_finding_verdict_events_snapshot_check
    check (public._staxis_company_verdict_audit_snapshot_valid(authority_snapshot)),
  constraint company_finding_verdict_events_text_bounds_check
    check (char_length(detector_id) between 1 and 64
      and (semantic_family is null or char_length(semantic_family) between 1 and 80))
);

-- Replay safety for the pre-release draft of 0405.
alter table public.company_finding_verdict_events
  drop constraint if exists company_finding_verdict_events_status_check,
  drop constraint if exists company_finding_verdict_events_affected_check,
  drop constraint if exists company_finding_verdict_events_capabilities_check,
  drop constraint if exists company_finding_verdict_events_snapshot_check,
  drop constraint if exists company_finding_verdict_events_text_bounds_check;
alter table public.company_finding_verdict_events
  add constraint company_finding_verdict_events_status_check
    check (prior_status in ('open','updated','known_problem','muted','resolved')
      and resulting_status = action),
  add constraint company_finding_verdict_events_affected_check
    check (public._staxis_uuid_array_is_canonical_nonempty(affected_property_ids)),
  add constraint company_finding_verdict_events_capabilities_check
    check (
      (detector_id = 'portfolio_supply_spend_gap'
        and (semantic_family is null or semantic_family = 'supply_spend_control')
        and required_capabilities = case action
          when 'resolved' then array[
            'manage_checklists','manage_inventory_orders','view_financials'
          ]::text[]
          else array[
            'manage_inventory_orders','manage_notifications','view_financials'
          ]::text[]
        end)
      or
      (detector_id = 'portfolio_activity_stopped'
        and (semantic_family is null or semantic_family = 'portfolio_activity_stopped')
        and required_capabilities = case action
          when 'resolved' then array['manage_checklists','run_reports']::text[]
          else array['manage_notifications','run_reports']::text[]
        end)
    ),
  add constraint company_finding_verdict_events_snapshot_check
    check (public._staxis_company_verdict_audit_snapshot_valid(authority_snapshot)),
  add constraint company_finding_verdict_events_text_bounds_check
    check (char_length(detector_id) between 1 and 64
      and (semantic_family is null or char_length(semantic_family) between 1 and 80));

create index if not exists company_finding_verdict_events_finding_idx
  on public.company_finding_verdict_events(
    organization_id, finding_id, resulting_verdict_revision
  );
create index if not exists company_finding_verdict_events_actor_idx
  on public.company_finding_verdict_events(actor_account_id, occurred_at desc);
create unique index if not exists company_finding_verdict_events_revision_uq
  on public.company_finding_verdict_events(
    organization_id, finding_id, resulting_verdict_revision
  );

create or replace function public._staxis_reject_company_finding_verdict_event_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'company finding verdict events are immutable'
    using errcode = '55000';
end
$$;

revoke all on function public._staxis_reject_company_finding_verdict_event_change()
  from public, anon, authenticated, service_role;

drop trigger if exists company_finding_verdict_events_immutable
  on public.company_finding_verdict_events;
create trigger company_finding_verdict_events_immutable
  before update or delete on public.company_finding_verdict_events
  for each row execute function public._staxis_reject_company_finding_verdict_event_change();

alter table public.company_finding_verdict_events enable row level security;
revoke all on public.company_finding_verdict_events
  from public, anon, authenticated, service_role;
grant select on public.company_finding_verdict_events to service_role;
drop policy if exists company_finding_verdict_events_deny_browser
  on public.company_finding_verdict_events;
create policy company_finding_verdict_events_deny_browser
  on public.company_finding_verdict_events
  for all to anon, authenticated using (false) with check (false);

-- Ephemeral owner-private proof that one exact invocation of the authorized RPC
-- is performing one exact row transition. The row is inserted and deleted in
-- the same transaction, so it never survives commit. A service role can forge
-- a session setting but cannot read, insert, or guess the matching 128-bit
-- token row; unrelated owner SECURITY DEFINER functions do not create one.
-- @rls: service-role-only — ephemeral unforgeable write markers are private to
-- the authorized SECURITY DEFINER RPC and its guard trigger.
create table if not exists public.company_finding_verdict_write_tokens (
  token                    uuid primary key,
  backend_pid              integer not null,
  transaction_id           bigint not null,
  organization_id          uuid not null,
  finding_id               uuid not null,
  actor_account_id         uuid not null,
  action                   text not null,
  prior_verdict_revision   bigint not null,
  resulting_verdict_revision bigint not null,
  constraint company_finding_verdict_write_tokens_action_check
    check (action in ('known_problem','muted','resolved')),
  constraint company_finding_verdict_write_tokens_revision_check
    check (prior_verdict_revision >= 0
      and resulting_verdict_revision = prior_verdict_revision + 1)
);
alter table public.company_finding_verdict_write_tokens enable row level security;
revoke all on public.company_finding_verdict_write_tokens
  from public, anon, authenticated, service_role;
drop policy if exists company_finding_verdict_write_tokens_deny_all
  on public.company_finding_verdict_write_tokens;
create policy company_finding_verdict_write_tokens_deny_all
  on public.company_finding_verdict_write_tokens
  for all to anon, authenticated, service_role using (false) with check (false);

-- Reject every verdict-controlled mutation unless the private marker matches
-- the exact backend, transaction, finding, actor, action, and revision edge.
-- Detector refresh columns and detector-owned open/updated/expired transitions
-- remain available during the rolling deployment.
create or replace function public._staxis_guard_company_finding_verdict_write()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_verdict_shaped boolean := false;
  v_detector_escalation boolean := false;
  v_detector_lineage_rearm boolean := false;
  v_token uuid;
begin
  if tg_op = 'INSERT' then
    v_verdict_shaped := new.status in ('known_problem', 'muted', 'resolved')
      or new.status_changed_by is not null
      or new.resolved_at is not null
      or new.silenced_at_magnitude is not null
      or new.verdict_revision <> 0;
  else
    -- A silence is consent to one exact affected-hotel set. If a detector's
    -- next observation changes that set, rearm the row in this same UPDATE.
    -- Doing this in the before trigger is intentional: evidence/summary and
    -- lineage can never commit under the old verdict and rely on a later
    -- application write to make the drift visible. Advancing the CAS epoch
    -- also invalidates every screen and lost-response retry from the old set.
    v_detector_lineage_rearm := old.status in ('known_problem', 'muted')
      and new.affected_property_ids is distinct from old.affected_property_ids;
    if v_detector_lineage_rearm then
      if public._staxis_uuid_array_is_canonical_nonempty(
        new.affected_property_ids
      ) is distinct from true then
        raise exception 'company finding detector lineage must be canonical'
          using errcode = '22023';
      end if;
      new.status := 'updated';
      new.status_changed_at := clock_timestamp();
      new.status_changed_by := old.status_changed_by;
      new.resolved_at := old.resolved_at;
      new.silenced_at_magnitude := old.silenced_at_magnitude;
      new.verdict_revision := old.verdict_revision + 1;
    end if;

    -- The only detector-owned transition away from a human silence is the
    -- established known-problem magnitude escalation edge, plus the exact
    -- lineage rearm above. Require lifecycle markers so a generic refresh
    -- helper cannot silently reopen a verdict.
    v_detector_escalation := old.status = 'known_problem'
      and new.status = 'updated'
      and new.escalated_at is not null
      and new.escalated_at is distinct from old.escalated_at
      and new.status_changed_at is distinct from old.status_changed_at;
    v_verdict_shaped := (
        new.status is distinct from old.status
        and new.status in ('known_problem', 'muted', 'resolved')
      )
      or (
        old.status in ('known_problem', 'muted', 'resolved')
        and new.status not in ('known_problem', 'muted', 'resolved')
        and not v_detector_escalation
        and not v_detector_lineage_rearm
      )
      or new.status_changed_by is distinct from old.status_changed_by
      or new.resolved_at is distinct from old.resolved_at
      or new.silenced_at_magnitude is distinct from old.silenced_at_magnitude
      or (
        new.verdict_revision is distinct from old.verdict_revision
        and not v_detector_lineage_rearm
      );
  end if;

  if v_verdict_shaped then
    if tg_op = 'INSERT' then
      raise exception 'company finding verdict requires the authorized RPC'
        using errcode = '42501';
    end if;
    begin
      v_token := nullif(
        current_setting('staxis.company_finding_verdict_token', true), ''
      )::uuid;
    exception when others then
      v_token := null;
    end;
    if v_token is null or not exists (
      select 1
      from public.company_finding_verdict_write_tokens marker
      where marker.token = v_token
        and marker.backend_pid = pg_backend_pid()
        and marker.transaction_id = txid_current()
        and marker.organization_id = new.organization_id
        and marker.finding_id = new.id
        and marker.actor_account_id = new.status_changed_by
        and marker.action = new.status
        and marker.prior_verdict_revision = old.verdict_revision
        and marker.resulting_verdict_revision = new.verdict_revision
    ) then
      raise exception 'company finding verdict requires the authorized RPC'
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

revoke all on function public._staxis_guard_company_finding_verdict_write()
  from public, anon, authenticated, service_role;

drop trigger if exists company_findings_verdict_write_fence
  on public.company_findings;
create trigger company_findings_verdict_write_fence
  before insert or update on public.company_findings
  for each row execute function public._staxis_guard_company_finding_verdict_write();

-- Remove the pre-release five-argument draft if this file is replayed in a
-- development database.  Keeping an old overload would leave a stale RPC door.
drop function if exists public.staxis_set_company_finding_status_authorized(
  uuid, uuid, text, uuid, uuid
);

create or replace function public.staxis_set_company_finding_status_authorized(
  p_organization_id uuid,
  p_finding_id uuid,
  p_action text,
  p_account_id uuid,
  p_aggregate_receipt_id uuid,
  p_expected_verdict_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
set lock_timeout = '2s'
set statement_timeout = '15s'
as $$
declare
  v_finding public.company_findings%rowtype;
  v_aggregate_receipt public.authorization_scope_receipts%rowtype;
  v_exact_receipt public.authorization_scope_receipts%rowtype;
  v_assertion jsonb;
  v_exact_resolution jsonb;
  v_exact_receipt_id uuid;
  v_access jsonb;
  v_affected_property_ids uuid[];
  v_affected_count bigint;
  v_topology_count bigint;
  v_locked_property_count integer := 0;
  v_property_id uuid;
  v_property record;
  v_standing_count integer;
  v_operational_role text;
  v_required_capabilities text[];
  v_capability text;
  v_now timestamptz := clock_timestamp();
  v_committed_revision bigint;
  v_write_token uuid;
  v_same_current_action boolean := false;
  v_lost_response_retry boolean := false;
begin
  -- Invalid, absent, foreign, stale, and unauthorized targets deliberately
  -- share this function's single closed result.
  if p_organization_id is null
     or p_finding_id is null
     or p_account_id is null
     or p_aggregate_receipt_id is null
     or p_expected_verdict_revision is null
     or p_expected_verdict_revision < 0
     or p_action is null
     or p_action not in ('known_problem', 'muted', 'resolved')
  then
    return jsonb_build_object('ok', false);
  end if;

  -- Tenant key + opaque id is one exact predicate.  The row lock serializes
  -- detector refreshes and other verdicts through the final audit append.
  select finding.* into v_finding
  from public.company_findings finding
  where finding.organization_id = p_organization_id
    and finding.id = p_finding_id
    and finding.status in ('open', 'updated', 'known_problem', 'muted', 'resolved')
  for update of finding;
  if not found then
    return jsonb_build_object('ok', false);
  end if;

  -- Two idempotent retry forms are recognized, but neither returns yet:
  -- every current authorization/capability/section check below must still pass.
  -- (1) The presented revision is current and already carries this action.
  -- (2) A lost-response retry presents the immediately prior revision and the
  --     immutable next event proves the same actor/action AND the exact current
  --     affected-hotel lineage committed it.
  if v_finding.verdict_revision = p_expected_verdict_revision then
    v_same_current_action := v_finding.status = p_action;
  elsif v_finding.verdict_revision = p_expected_verdict_revision + 1 then
    if v_finding.status <> p_action then
      return jsonb_build_object('ok', false);
    end if;
    select exists (
      select 1
      from public.company_finding_verdict_events event
      where event.organization_id = p_organization_id
        and event.finding_id = p_finding_id
        and event.actor_account_id = p_account_id
        and event.action = p_action
        and event.prior_verdict_revision = p_expected_verdict_revision
        and event.resulting_verdict_revision = v_finding.verdict_revision
        and event.affected_property_ids is not distinct from
            v_finding.affected_property_ids
    ) into v_lost_response_retry;
    if not v_lost_response_retry then
      return jsonb_build_object('ok', false);
    end if;
  else
    return jsonb_build_object('ok', false);
  end if;
  if v_finding.status = 'resolved'
     and not v_same_current_action
     and not v_lost_response_retry
  then
    return jsonb_build_object('ok', false);
  end if;

  -- affected_property_ids is the only mutation lineage.  Empty arrays,
  -- duplicates, nulls, and noncanonical order abstain.  Never reconstruct it
  -- from evidence JSON or summary text.
  select
    coalesce(array_agg(distinct affected.property_id order by affected.property_id), '{}'::uuid[]),
    count(*)
  into v_affected_property_ids, v_affected_count
  from unnest(v_finding.affected_property_ids) affected(property_id);
  if v_affected_count = 0
     or v_affected_count > 250
     or v_affected_property_ids is distinct from v_finding.affected_property_ids
     or cardinality(v_affected_property_ids) <> v_affected_count
  then
    return jsonb_build_object('ok', false);
  end if;

  -- The route's all-authorized receipt proves only that this aggregate queue
  -- could be read.  Assert it under the authorization-state/epoch locks, but
  -- do not use it as the write scope.
  v_assertion := public.staxis_assert_authorization_scope_receipt(
    p_aggregate_receipt_id,
    p_account_id
  );
  if v_assertion -> 'ok' is distinct from 'true'::jsonb then
    return jsonb_build_object('ok', false);
  end if;

  select receipt.* into v_aggregate_receipt
  from public.authorization_scope_receipts receipt
  where receipt.id = p_aggregate_receipt_id
    and receipt.account_id = p_account_id
    and receipt.organization_id = p_organization_id
    and receipt.selector_type = 'all_authorized';
  if not found
     or v_aggregate_receipt.selected_property_ids
        is distinct from v_aggregate_receipt.authorized_property_ids
  then
    return jsonb_build_object('ok', false);
  end if;

  -- Mint the actual write scope from the locked, trusted target array.  The
  -- resolver is all-or-nothing, so a single unauthorized hotel denies the
  -- whole verdict without revealing which target failed.
  v_exact_resolution := public.staxis_resolve_authorization_scope(
    p_account_id,
    p_organization_id,
    'property_subset',
    null,
    to_jsonb(v_affected_property_ids),
    120
  );
  if v_exact_resolution -> 'ok' is distinct from 'true'::jsonb
     or jsonb_typeof(v_exact_resolution -> 'receipt') is distinct from 'object'
  then
    return jsonb_build_object('ok', false);
  end if;
  begin
    v_exact_receipt_id := (v_exact_resolution #>> '{receipt,id}')::uuid;
  exception when others then
    return jsonb_build_object('ok', false);
  end;

  v_assertion := public.staxis_assert_authorization_scope_receipt(
    v_exact_receipt_id,
    p_account_id
  );
  if v_assertion -> 'ok' is distinct from 'true'::jsonb then
    return jsonb_build_object('ok', false);
  end if;

  select receipt.* into v_exact_receipt
  from public.authorization_scope_receipts receipt
  where receipt.id = v_exact_receipt_id
    and receipt.account_id = p_account_id
    and receipt.organization_id = p_organization_id
    and receipt.selector_type = 'property_subset';
  if not found
     or v_exact_receipt.requested_property_ids is distinct from v_affected_property_ids
     or v_exact_receipt.selected_property_ids is distinct from v_affected_property_ids
     or not (v_affected_property_ids <@ v_exact_receipt.authorized_property_ids)
  then
    return jsonb_build_object('ok', false);
  end if;

  -- Closed company-family policy.  Legacy rows have no semantic_family and
  -- are admitted only by their exact detector id.  Pattern rows must carry the
  -- exact detector/family pair.  Any new or contradictory family abstains
  -- until 0405 is deliberately extended.
  if v_finding.semantic_family is null
     and v_finding.detector_id = 'portfolio_supply_spend_gap'
  then
    v_required_capabilities := array['manage_inventory_orders', 'view_financials'];
  elsif v_finding.semantic_family = 'supply_spend_control'
     and v_finding.detector_id = 'portfolio_supply_spend_gap'
  then
    v_required_capabilities := array['manage_inventory_orders', 'view_financials'];
  elsif v_finding.semantic_family is null
     and v_finding.detector_id = 'portfolio_activity_stopped'
  then
    v_required_capabilities := array['run_reports'];
  elsif v_finding.semantic_family = 'portfolio_activity_stopped'
     and v_finding.detector_id = 'portfolio_activity_stopped'
  then
    v_required_capabilities := array['run_reports'];
  else
    return jsonb_build_object('ok', false);
  end if;

  v_required_capabilities := v_required_capabilities || case p_action
    when 'resolved' then array['manage_checklists']
    else array['manage_notifications']
  end;
  select array_agg(distinct capability order by capability)
    into v_required_capabilities
  from unnest(v_required_capabilities) required(capability);

  -- Re-read current standing after the exact receipt was minted.  Its account
  -- version and organization epoch locks persist to commit.  Every affected
  -- hotel independently needs a manager role and explicit mutation capacity.
  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  if v_access -> 'ok' is distinct from 'true'::jsonb
     or v_access -> 'all' is distinct from 'false'::jsonb
     or jsonb_typeof(v_access -> 'propertyStandings') is distinct from 'array'
  then
    return jsonb_build_object('ok', false);
  end if;

  -- SHARE prevents a concurrent override insert/update/delete from committing
  -- between an absent/allowed read and the verdict.  Row locks alone cannot
  -- protect the absence of a future deny row.
  lock table public.capability_overrides in share mode;

  foreach v_property_id in array v_affected_property_ids
  loop
    select count(*)::integer, min(standing.value ->> 'operationalRole')
      into v_standing_count, v_operational_role
    from jsonb_array_elements(v_access -> 'propertyStandings') standing(value)
    where standing.value ->> 'propertyId' = v_property_id::text
      and standing.value -> 'hotelMutationAllowed' = 'true'::jsonb
      and standing.value ->> 'operationalRole' in (
        'admin', 'owner', 'general_manager'
      );
    if v_standing_count <> 1 then
      return jsonb_build_object('ok', false);
    end if;

    -- Admin is override-proof for hotel-facing capabilities.  Owner/GM follow
    -- the registry default-allow model, with any explicit false row denying.
    if v_operational_role <> 'admin' then
      foreach v_capability in array v_required_capabilities
      loop
        if exists (
          select 1
          from public.capability_overrides override_row
          where override_row.property_id = v_property_id
            and override_row.capability = v_capability
            and override_row.role = v_operational_role
            and override_row.allowed is not true
        ) then
          return jsonb_build_object('ok', false);
        end if;
      end loop;
    end if;
  end loop;

  -- Receipt scope is organization-bound.  This independent current-primary
  -- projection makes the target topology explicit at the write boundary.
  select count(distinct relationship.property_id) into v_topology_count
  from public._staxis_current_primary_property_relationships() relationship
  where relationship.organization_id = p_organization_id
    and relationship.property_id = any(v_affected_property_ids)
    and relationship.active_primary_count = 1;
  if v_topology_count <> cardinality(v_affected_property_ids) then
    return jsonb_build_object('ok', false);
  end if;

  -- Do not call staxis_property_section_enabled: service_role is intentionally
  -- exempt there.  Lock each properties row and reproduce the strict data rule:
  -- SQL NULL or missing `staxis` defaults on; explicit key only JSON true;
  -- malformed/non-object/false/null denies.  The locks make a concurrent
  -- section disable wait until this transaction commits.
  for v_property in
    select property.id, property.enabled_sections
    from public.properties property
    where property.id = any(v_affected_property_ids)
    order by property.id
    for share of property
  loop
    v_locked_property_count := v_locked_property_count + 1;
    if v_property.enabled_sections is not null
       and (
         jsonb_typeof(v_property.enabled_sections) is distinct from 'object'
         or (
           v_property.enabled_sections ? 'staxis'
           and v_property.enabled_sections -> 'staxis' is distinct from 'true'::jsonb
         )
       )
    then
      return jsonb_build_object('ok', false);
    end if;
  end loop;
  if v_locked_property_count <> cardinality(v_affected_property_ids) then
    return jsonb_build_object('ok', false);
  end if;

  -- Only now, after every fresh policy read and lock, may a retry return the
  -- already-committed result. It neither increments revision nor appends a
  -- duplicate event.
  if v_same_current_action or v_lost_response_retry then
    return jsonb_build_object(
      'ok', true,
      'status', p_action,
      'verdictRevision', v_finding.verdict_revision,
      'alreadyApplied', true
    );
  end if;

  -- The locked row plus expected revision is a compare-and-swap contract for
  -- stale screens and concurrent verdict requests.  Only one request with the
  -- presented revision can produce the next revision and its audit event.
  v_write_token := gen_random_uuid();
  insert into public.company_finding_verdict_write_tokens (
    token, backend_pid, transaction_id, organization_id, finding_id,
    actor_account_id, action, prior_verdict_revision,
    resulting_verdict_revision
  ) values (
    v_write_token, pg_backend_pid(), txid_current(), p_organization_id,
    p_finding_id, p_account_id, p_action, p_expected_verdict_revision,
    p_expected_verdict_revision + 1
  );
  perform set_config(
    'staxis.company_finding_verdict_token', v_write_token::text, true
  );
  update public.company_findings finding
  set status = p_action,
      verdict_revision = finding.verdict_revision + 1,
      status_changed_at = v_now,
      status_changed_by = p_account_id,
      resolved_at = case when p_action = 'resolved' then v_now else null end,
      silenced_at_magnitude = case
        when p_action in ('known_problem', 'muted') then v_finding.magnitude
        else v_finding.silenced_at_magnitude
      end
  where finding.organization_id = p_organization_id
    and finding.id = p_finding_id
    and finding.verdict_revision = p_expected_verdict_revision
  returning finding.verdict_revision into v_committed_revision;
  if not found or v_committed_revision <> p_expected_verdict_revision + 1 then
    delete from public.company_finding_verdict_write_tokens
    where token = v_write_token;
    perform set_config('staxis.company_finding_verdict_token', '', true);
    return jsonb_build_object('ok', false);
  end if;
  delete from public.company_finding_verdict_write_tokens
  where token = v_write_token;
  perform set_config('staxis.company_finding_verdict_token', '', true);

  insert into public.company_finding_verdict_events (
    organization_id, finding_id, detector_id, semantic_family,
    actor_account_id, aggregate_read_receipt_id, exact_scope_receipt_id,
    action, prior_status, resulting_status,
    prior_verdict_revision, resulting_verdict_revision,
    affected_property_ids, required_capabilities, authority_snapshot,
    occurred_at
  ) values (
    p_organization_id, p_finding_id, v_finding.detector_id,
    v_finding.semantic_family, p_account_id, p_aggregate_receipt_id,
    v_exact_receipt_id, p_action, v_finding.status, p_action,
    p_expected_verdict_revision, v_committed_revision,
    v_affected_property_ids, v_required_capabilities,
    jsonb_build_object(
      'authorityMode', v_exact_receipt.authority_mode,
      'selectorType', v_exact_receipt.selector_type,
      'authorizationHash', v_exact_receipt.authorization_hash,
      'scopeHash', v_exact_receipt.scope_hash,
      'accountAuthorizationVersion', v_exact_receipt.account_authorization_version,
      'organizationAccessEpoch', v_exact_receipt.organization_access_epoch
    ),
    v_now
  );

  return jsonb_build_object(
    'ok', true,
    'status', p_action,
    'verdictRevision', v_committed_revision,
    'alreadyApplied', false
  );
end
$$;

revoke all on function public.staxis_set_company_finding_status_authorized(
  uuid, uuid, text, uuid, uuid, bigint
) from public, anon, authenticated, service_role;
grant execute on function public.staxis_set_company_finding_status_authorized(
  uuid, uuid, text, uuid, uuid, bigint
) to service_role;

comment on function public.staxis_set_company_finding_status_authorized(
  uuid, uuid, text, uuid, uuid, bigint
) is
  'Atomic service-role company finding verdict. Aggregate queue reach is read-only: the RPC mints an exact affected-hotel receipt, checks fresh standing/topology/strict section and a closed family+action capability policy under locks, CASes verdict_revision, and appends an immutable audit event. Every denial has the same closed shape.';

insert into public.applied_migrations(version, description)
values (
  '0405',
  'Atomic audited company queue verdict with exact affected-hotel receipt, current standing/topology/section/capability locks, CAS revision, and legacy direct-write fence.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
