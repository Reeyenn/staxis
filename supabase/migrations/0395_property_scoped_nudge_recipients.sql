-- 0395_property_scoped_nudge_recipients.sql
--
-- Nudge delivery is a hotel-scoped operation.  The application previously
-- enumerated every active owner/GM in accounts, then called the account-scoped
-- authorization resolver once per identity.  Besides fleet-size fan-out, that
-- query exposed identities from unrelated tenants to the application process
-- before the hotel boundary was applied.
--
-- This migration moves the boundary into one service-only, property-keyed RPC.
-- Candidate discovery starts from the requested property's legacy scope,
-- property hat/grant, bridge, or explicit subscription.  Every candidate is
-- then checked against the canonical current standing.  Company-only oversight
-- hats, platform admins, inactive accounts, revoked/transferred entitlements,
-- and cross-tenant subscription IDs are excluded.

begin;

do $requirements$
begin
  if to_regclass('public.properties') is null
     or to_regclass('public.accounts') is null
     or to_regclass('public.agent_nudges') is null
     or to_regclass('public.account_authorization_state') is null
     or to_regprocedure('public.staxis_list_account_authorized_properties(uuid)') is null
     or to_regprocedure('public.mfa_verified_or_grace()') is null
  then
    raise exception '0395 requires properties, accounts, and authoritative access migration 0376';
  end if;
end
$requirements$;

-- Candidate discovery runs once per active property on the cron cadence. Keep
-- both normalized property-hat and bridge lookups property-first; the legacy
-- arm already has accounts_property_access_gin_idx from migration 0121 and
-- access grants have a (property_id, membership_id) index from 0325.
create index if not exists organization_memberships_nudge_property_gin_idx
  on public.organization_memberships using gin (covered_property_ids)
  where status = 'active'
    and ended_at is null
    and membership_scope = 'property'
    and staxis_role = 'general_manager';

create index if not exists account_authorization_bridges_nudge_property_idx
  on public.account_property_authorization_bridges (property_id, account_id)
  where status = 'active';

-- One definition of nudge eligibility, shared by the write-time subscription
-- guard and the read-time projection.  The canonical resolver owns all
-- authority-mode, topology, bridge, and winning-entitlement semantics; this
-- helper only selects the exact hotel's standing and applies the nudge policy.
create or replace function public._staxis_account_is_current_nudge_recipient(
  p_account_id uuid,
  p_property_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_access jsonb;
  v_standing jsonb;
begin
  if p_account_id is null or p_property_id is null then return false; end if;

  v_access := public.staxis_list_account_authorized_properties(p_account_id);
  if v_access->>'ok' <> 'true' or v_access->>'all' = 'true' then
    return false;
  end if;

  select standing
    into v_standing
  from pg_catalog.jsonb_array_elements(
    coalesce(v_access->'propertyStandings', '[]'::jsonb)
  ) standing
  where standing->>'propertyId' = p_property_id::text
  limit 1;

  return v_standing is not null
    and v_standing->>'operationalRole' in ('owner', 'general_manager')
    and coalesce((v_standing->>'hotelMutationAllowed')::boolean, false);
end;
$$;

revoke all on function public._staxis_account_is_current_nudge_recipient(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Close the projection->insert revocation race at the read boundary too. A
-- nudge row may be written milliseconds after a manager loses hotel standing;
-- it must not remain readable merely because user_id still maps to their login.
-- The browser wrapper is not an identity oracle: it only answers for the one
-- account attached to auth.uid().
create or replace function public.staxis_current_user_can_receive_property_nudge(
  p_account_id uuid,
  p_property_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with identity as (
    select coalesce(array_agg(account.id order by account.id), '{}'::uuid[]) as account_ids
    from public.accounts account
    where account.data_user_id = auth.uid()
      and account.active is true
  )
  select case
    -- The unique index should make duplicates impossible, but corrupt or
    -- partially restored identity state must not turn one login into a union
    -- of two tenants.
    when cardinality(identity.account_ids) = 1
      and identity.account_ids[1] = p_account_id
    then public._staxis_account_is_current_nudge_recipient(
      p_account_id, p_property_id
    )
    else false
  end
  from identity;
$$;

revoke all on function public.staxis_current_user_can_receive_property_nudge(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_current_user_can_receive_property_nudge(uuid, uuid)
  to authenticated;

alter policy "agent_nudges_select_own" on public.agent_nudges
  using (
    public.mfa_verified_or_grace()
    and public.staxis_current_user_can_receive_property_nudge(
      agent_nudges.user_id, agent_nudges.property_id
    )
  );

alter policy "agent_nudges_update_own_status" on public.agent_nudges
  using (
    public.mfa_verified_or_grace()
    and public.staxis_current_user_can_receive_property_nudge(
      agent_nudges.user_id, agent_nudges.property_id
    )
  )
  with check (
    public.mfa_verified_or_grace()
    and public.staxis_current_user_can_receive_property_nudge(
      agent_nudges.user_id, agent_nudges.property_id
    )
  );

-- Replace the legacy-array subscription trigger.  Runtime projection remains
-- authoritative (a recipient can be revoked after this write), but rejecting
-- invalid configuration here prevents a normalized hotel from storing a
-- cross-tenant identity or a company-only/read-only recipient in the first
-- place.  Explicit lists are fixed-size so neither trigger nor delivery can be
-- turned into an authorization-resolver fan-out.
create or replace function public.staxis_validate_nudge_recipients()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_recipients jsonb;
  v_recipient_text text;
  v_recipient_id uuid;
begin
  if new.nudge_subscription is null then return new; end if;
  if pg_catalog.jsonb_typeof(new.nudge_subscription) <> 'object' then
    raise exception 'nudge_subscription must be a JSON object'
      using errcode = '23514';
  end if;

  if new.nudge_subscription ? 'enabled'
     and pg_catalog.jsonb_typeof(new.nudge_subscription->'enabled') <> 'boolean' then
    raise exception 'nudge_subscription.enabled must be boolean'
      using errcode = '23514';
  end if;

  v_recipients := new.nudge_subscription->'recipient_account_ids';
  if v_recipients is null then return new; end if;
  if pg_catalog.jsonb_typeof(v_recipients) <> 'array' then
    raise exception 'nudge_subscription.recipient_account_ids must be an array'
      using errcode = '23514';
  end if;
  if pg_catalog.jsonb_array_length(v_recipients) > 64 then
    raise exception 'nudge_subscription.recipient_account_ids exceeds the 64-recipient limit'
      using errcode = '23514';
  end if;
  if (
    select count(*) <> count(distinct recipient.value)
    from pg_catalog.jsonb_array_elements_text(v_recipients) recipient(value)
  ) then
    raise exception 'nudge_subscription.recipient_account_ids contains duplicates'
      using errcode = '23514';
  end if;

  -- A disabled subscription emits nothing, so dormant recipient IDs cannot
  -- disclose data. They will be revalidated if the property is re-enabled.
  if coalesce((new.nudge_subscription->>'enabled')::boolean, true) is false then
    return new;
  end if;

  for v_recipient_text in
    select recipient.value
    from pg_catalog.jsonb_array_elements_text(v_recipients) recipient(value)
  loop
    begin
      v_recipient_id := v_recipient_text::uuid;
    exception when invalid_text_representation then
      raise exception 'nudge_subscription.recipient_account_ids contains an invalid UUID'
        using errcode = '23514';
    end;

    if not public._staxis_account_is_current_nudge_recipient(
      v_recipient_id, new.id
    ) then
      raise exception
        'nudge_subscription recipient % lacks current hotel-manager standing for property %',
        v_recipient_id, new.id
        using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function public.staxis_validate_nudge_recipients()
  from public, anon, authenticated, service_role;

drop trigger if exists staxis_validate_nudge_recipients on public.properties;
create trigger staxis_validate_nudge_recipients
  before insert or update of nudge_subscription on public.properties
  for each row execute function public.staxis_validate_nudge_recipients();

-- Return a deliberately narrow JSON document rather than account rows.  The
-- application receives account IDs needed for agent_nudges.user_id and no
-- names, emails, roles, or identities from any other hotel.  Candidate work is
-- capped at 128 and output at 64.  Overflow fails closed instead of silently
-- selecting an arbitrary subset of managers.
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

  select property.nudge_subscription
    into v_subscription
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
      'ok', true,
      'propertyId', p_property_id,
      'subscriptionMode', 'disabled',
      'recipientAccountIds', '[]'::jsonb,
      'candidateCount', 0,
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
        from pg_catalog.jsonb_array_elements_text(
          v_subscription->'recipient_account_ids'
        ) recipient(value);
      exception when invalid_text_representation then
        return jsonb_build_object('ok', false, 'reason', 'invalid_subscription');
      end;
    end if;
  end if;

  if v_mode = 'default' then
    -- Every arm starts with p_property_id. There is no global active-account
    -- enumeration and no company-wide/portfolio identity materialization.
    with candidate_ids as (
      -- Legacy/shadow authority: the exact indexed UUID-array membership.
      select account.id
      from public.accounts account
      join public.account_authorization_state state
        on state.account_id = account.id
       and state.authority_mode in ('legacy', 'shadow')
      where account.active is true
        and account.role in ('owner', 'general_manager')
        and account.property_access @> array[p_property_id]::uuid[]

      union

      -- Normalized explicit property GM hats under the hotel's current
      -- governing company. Company owner/VP/finance hats are intentionally not
      -- candidates: their hotelMutationAllowed standing is false.
      select membership.account_id
      from public._staxis_current_primary_property_relationships() relationship
      join public.organization_memberships membership
        on membership.organization_id = relationship.organization_id
       and membership.membership_scope = 'property'
       and membership.staxis_role = 'general_manager'
       and membership.covered_property_ids @> array[p_property_id]::uuid[]
       and membership.status = 'active'
       and membership.starts_at <= now()
       and membership.ended_at is null
      join public.account_authorization_state state
        on state.account_id = membership.account_id
       and state.authority_mode = 'normalized'
      join public.accounts account
        on account.id = membership.account_id
       and account.active is true
       and account.role <> 'admin'
      join public.organizations organization
        on organization.id = relationship.organization_id
       and organization.status = 'active'
       and organization.organization_type <> 'single_hotel'
      where relationship.property_id = p_property_id
        and relationship.active_primary_count = 1

      union

      -- A property_manager access profile produces a GM-equivalent mutable
      -- standing only when the grant itself is exact-property scoped.
      select membership.account_id
      from public._staxis_current_primary_property_relationships() relationship
      join public.organization_access_grants grant_row
        on grant_row.property_relationship_id = relationship.id
       and grant_row.organization_id = relationship.organization_id
       and grant_row.property_id = relationship.property_id
       and grant_row.scope_type = 'property'
       and grant_row.access_profile = 'property_manager'
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
      join public.account_authorization_state state
        on state.account_id = membership.account_id
       and state.authority_mode = 'normalized'
      join public.accounts account
        on account.id = membership.account_id
       and account.active is true
       and account.role <> 'admin'
      join public.organizations organization
        on organization.id = relationship.organization_id
       and organization.status = 'active'
       and organization.organization_type <> 'single_hotel'
      where relationship.property_id = p_property_id
        and relationship.active_primary_count = 1

      union

      -- Cutover bridges remain potential manager standings only while their
      -- exact topology is still valid; the canonical helper below makes that
      -- final decision and prevents a transferred bridge from surviving.
      select bridge.account_id
      from public.account_property_authorization_bridges bridge
      join public.account_authorization_state state
        on state.account_id = bridge.account_id
       and state.authority_mode = 'normalized'
      join public.accounts account
        on account.id = bridge.account_id
       and account.active is true
       and account.role in ('owner', 'general_manager')
      where bridge.property_id = p_property_id
        and bridge.status = 'active'
    ), bounded as (
      select candidate.id
      from candidate_ids candidate
      order by candidate.id
      limit v_candidate_limit + 1
    )
    select coalesce(array_agg(bounded.id order by bounded.id), '{}'::uuid[])
      into v_candidate_ids
    from bounded;

    if cardinality(v_candidate_ids) > v_candidate_limit then
      return jsonb_build_object(
        'ok', false,
        'reason', 'candidate_limit_exceeded',
        'candidateLimit', v_candidate_limit
      );
    end if;
  end if;

  foreach v_candidate_id in array v_candidate_ids
  loop
    if public._staxis_account_is_current_nudge_recipient(
      v_candidate_id, p_property_id
    ) then
      v_recipient_ids := array_append(v_recipient_ids, v_candidate_id);
      if cardinality(v_recipient_ids) > v_recipient_limit then
        return jsonb_build_object(
          'ok', false,
          'reason', 'recipient_limit_exceeded',
          'recipientLimit', v_recipient_limit
        );
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'propertyId', p_property_id,
    'subscriptionMode', v_mode,
    'recipientAccountIds', to_jsonb(v_recipient_ids),
    'candidateCount', cardinality(v_candidate_ids),
    'recipientLimit', v_recipient_limit
  );
end;
$$;

revoke all on function public.staxis_list_property_nudge_recipients(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_list_property_nudge_recipients(uuid)
  to service_role;

comment on function public.staxis_list_property_nudge_recipients(uuid) is
  'Service-only, property-keyed nudge recipient projection. Returns at most 64 active owner/GM account IDs with current mutable standing at exactly p_property_id; never enumerates global account identities.';

comment on column public.properties.nudge_subscription is
  'Per-property nudge override. NULL or an empty recipient list uses current mutable owner/GM hotel standings; enabled=false disables delivery; a non-empty recipient_account_ids list is capped at 64 and revalidated against current standing at write and delivery time.';

insert into public.applied_migrations(version, description)
values (
  '0395',
  'Property-keyed bounded nudge recipient projection with current-authority subscription validation and no global account enumeration.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
