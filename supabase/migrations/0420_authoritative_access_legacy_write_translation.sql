-- 0420_authoritative_access_legacy_write_translation.sql
--
-- Stage A compatibility bridge for the still-live legacy hotel writer.
-- `accounts.property_access` remains the current application's authority. A
-- successful, unambiguous write is copied to the topology-bound bridge; an
-- ambiguous, inactive, cross-company, stale, or unlinked write aborts the
-- transaction. No array is rewritten, cleared, or used as a fallback here.

begin;

do $$
begin
  if to_regclass('public.account_access_cutover_status') is null
     or to_regclass('public.account_property_authorization_bridges') is null
     or to_regclass('public.account_access_cutover_legacy_snapshots') is null
     or to_regprocedure('public._staxis_current_primary_property_relationships()') is null
  then
    raise exception '0420 requires the Stage A status, snapshot, topology, and bridge migrations';
  end if;
end
$$;

-- @rls: service-role-only — compatibility write history contains cross-tenant scope and is retained for rollout audit only.
create table if not exists public.account_access_cutover_legacy_write_events (
  id                    uuid primary key default gen_random_uuid(),
  account_id            uuid not null references public.accounts(id) on delete cascade,
  operation             text not null check (operation in ('INSERT', 'UPDATE')),
  previous_property_ids uuid[],
  next_property_ids     uuid[] not null default '{}'::uuid[],
  previous_scope_hash   text,
  next_scope_hash       text not null,
  bridged_count         integer not null default 0 check (bridged_count >= 0),
  retired_bridge_count  integer not null default 0 check (retired_bridge_count >= 0),
  reason                text not null,
  created_at            timestamptz not null default clock_timestamp()
);

alter table public.account_access_cutover_legacy_write_events enable row level security;
revoke all on public.account_access_cutover_legacy_write_events
  from public, anon, authenticated, service_role;

comment on table public.account_access_cutover_legacy_write_events is
  'Stage A service-only audit of successful legacy property_access writes. The event is transactional and records compatibility translation without becoming authorization authority.';

create or replace function public.staxis_translate_legacy_property_access(
  p_account_id uuid,
  p_previous_property_ids uuid[] default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_account public.accounts%rowtype;
  v_state public.account_authorization_state%rowtype;
  v_new_property_ids uuid[];
  v_previous_property_ids uuid[];
  v_next_scope_hash text;
  v_previous_scope_hash text;
  v_property_id uuid;
  v_relationship_count integer;
  v_current_relationship_count integer;
  v_relationship_id uuid;
  v_organization_id uuid;
  v_organization_type text;
  v_bridged_count integer := 0;
  v_retired_bridge_count integer := 0;
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'legacy property_access write'), 500);
begin
  if p_account_id is null then
    raise exception 'legacy property_access translation requires an account id'
      using errcode = '22023';
  end if;

  select account.* into v_account
  from public.accounts account
  where account.id = p_account_id
  for update;
  if not found then
    raise exception 'legacy property_access translation account is unavailable'
      using errcode = '23514';
  end if;

  -- The trigger that invokes this helper runs after the existing authorization
  -- refresh trigger, so every normal account row has a state. Refusing to
  -- manufacture one here keeps an unlinked account fail-closed.
  select state.* into v_state
  from public.account_authorization_state state
  where state.account_id = p_account_id
  for update;
  if not found then
    raise exception 'legacy property_access translation authorization state is unavailable'
      using errcode = '23514';
  end if;

  v_new_property_ids := array(
    select property_id
    from (
      select distinct property_id
      from unnest(coalesce(v_account.property_access, '{}'::uuid[])) ids(property_id)
      order by property_id
    ) normalized
  );
  v_previous_property_ids := p_previous_property_ids;

  if array_position(coalesce(v_account.property_access, '{}'::uuid[]), null) is not null then
    raise exception 'legacy property_access translation rejects null property ids'
      using errcode = '23514';
  end if;
  if cardinality(coalesce(v_account.property_access, '{}'::uuid[]))
       <> cardinality(coalesce(v_new_property_ids, '{}'::uuid[])) then
    raise exception 'legacy property_access translation rejects duplicate property ids'
      using errcode = '23514';
  end if;

  v_next_scope_hash := encode(sha256(convert_to(coalesce((
    select string_agg(property_id::text, ',' order by property_id::text)
    from unnest(coalesce(v_new_property_ids, '{}'::uuid[])) property_id
  ), ''), 'UTF8')), 'hex');
  v_previous_scope_hash := case
    when v_previous_property_ids is null then null
    else encode(sha256(convert_to(coalesce((
      select string_agg(property_id::text, ',' order by property_id::text)
      from unnest(coalesce(v_previous_property_ids, '{}'::uuid[])) property_id
    ), ''), 'UTF8')), 'hex')
  end;

  -- A normalized account's array is already non-authoritative. Preserve the
  -- old profile/People writer's current operation and audit the compatibility
  -- write, but do not translate it, retire normalized bridges, or let it
  -- affect canonical access. Stage B will remove this writer seam after the
  -- application has moved to the canonical RPCs.
  if v_state.authority_mode = 'normalized' then
    insert into public.account_access_cutover_legacy_write_events (
      account_id, operation, previous_property_ids, next_property_ids,
      previous_scope_hash, next_scope_hash, reason
    ) values (
      p_account_id,
      case when p_previous_property_ids is null then 'INSERT' else 'UPDATE' end,
      p_previous_property_ids,
      coalesce(v_new_property_ids, '{}'::uuid[]),
      v_previous_scope_hash,
      v_next_scope_hash,
      'normalized account compatibility array write: canonical authority unchanged'
    );
    return jsonb_build_object(
      'ok', true,
      'stage', 'A',
      'accountId', p_account_id,
      'legacyPropertyIds', to_jsonb(coalesce(v_new_property_ids, '{}'::uuid[])),
      'bridgedCount', 0,
      'retiredBridgeCount', 0,
      'arraysPreserved', true,
      'authorityMode', v_state.authority_mode,
      'canonicalAuthorityChanged', false
    );
  end if;

  -- Platform administrators are a separate global realm. Their role, not the
  -- legacy hotel array, is the authority for customer-context operations, so
  -- preserve an existing array write for the current app and audit it without
  -- manufacturing a customer bridge or rejecting an explicit admin context.
  if v_account.role = 'admin' then
    insert into public.account_access_cutover_legacy_write_events (
      account_id, operation, previous_property_ids, next_property_ids,
      previous_scope_hash, next_scope_hash, reason
    ) values (
      p_account_id,
      case when p_previous_property_ids is null then 'INSERT' else 'UPDATE' end,
      p_previous_property_ids,
      coalesce(v_new_property_ids, '{}'::uuid[]),
      v_previous_scope_hash,
      v_next_scope_hash,
      'platform admin compatibility array write: global authority unchanged'
    );
    return jsonb_build_object(
      'ok', true,
      'stage', 'A',
      'accountId', p_account_id,
      'legacyPropertyIds', to_jsonb(coalesce(v_new_property_ids, '{}'::uuid[])),
      'bridgedCount', 0,
      'retiredBridgeCount', 0,
      'arraysPreserved', true,
      'authorityMode', v_state.authority_mode,
      'canonicalAuthorityChanged', false
    );
  end if;

  -- Empty access is a safe lifecycle state and is intentionally allowed for
  -- existing account creation/profile flows. A non-empty legacy scope,
  -- however, cannot be attached to an inactive account or an account with no
  -- verified Auth identity.
  if cardinality(coalesce(v_new_property_ids, '{}'::uuid[])) > 0 then
    if v_account.active is not true then
      raise exception 'legacy property_access translation rejects inactive account access'
        using errcode = '42501';
    end if;
    if v_account.role is null or v_account.role not in (
      'owner', 'general_manager', 'front_desk', 'housekeeping', 'maintenance', 'staff'
    ) then
      raise exception 'legacy property_access translation rejects invalid account role'
        using errcode = '23514';
    end if;
    if v_account.data_user_id is null or not exists (
      select 1 from auth.users auth_user where auth_user.id = v_account.data_user_id
    ) then
      raise exception 'legacy property_access translation rejects unlinked Auth identity'
        using errcode = '23514';
    end if;
    if v_state.authority_mode = 'normalized' then
      raise exception 'legacy property_access translation rejects normalized-account array authority'
        using errcode = '42501';
    end if;
  end if;

  -- Validate every target before inserting anything. A failure rolls back the
  -- caller's array write, which is the required fail-closed behavior.
  foreach v_property_id in array coalesce(v_new_property_ids, '{}'::uuid[])
  loop
    if not exists (
      select 1 from public.properties property where property.id = v_property_id
    ) then
      raise exception 'legacy property_access translation property is unavailable: %', v_property_id
        using errcode = '42501';
    end if;

    select count(*)::integer into v_current_relationship_count
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id;
    if v_current_relationship_count = 0 then
      raise exception 'legacy property_access translation property topology is missing: %', v_property_id
        using errcode = '42501';
    end if;
    if v_current_relationship_count > 1 then
      raise exception 'legacy property_access translation property topology is ambiguous: %', v_property_id
        using errcode = '42501';
    end if;

    select count(*)::integer,
           (array_agg(relationship.id order by relationship.id))[1],
           (array_agg(relationship.organization_id order by relationship.id))[1],
           (array_agg(organization.organization_type order by relationship.id))[1]
      into v_relationship_count, v_relationship_id, v_organization_id,
           v_organization_type
    from public._staxis_current_primary_property_relationships() relationship
    join public.organizations organization
      on organization.id = relationship.organization_id
     and organization.status = 'active'
    where relationship.property_id = v_property_id
      and relationship.active_primary_count = 1;
    if v_relationship_count <> 1 or v_organization_type is null then
      raise exception 'legacy property_access translation governing organization is unavailable: %', v_property_id
        using errcode = '42501';
    end if;

    if v_organization_type <> 'single_hotel'
       and exists (
         select 1
         from public._staxis_cutover_real_account_organizations() real_org
         where real_org.account_id = p_account_id
       )
       and not exists (
         select 1
         from public._staxis_cutover_real_account_organizations() real_org
         where real_org.account_id = p_account_id
           and real_org.organization_id = v_organization_id
       )
    then
      raise exception 'legacy property_access translation crosses company boundary: %', v_property_id
        using errcode = '42501';
    end if;

    if exists (
      select 1
      from public.account_property_authorization_bridges bridge
      where bridge.account_id = p_account_id
        and bridge.property_id = v_property_id
        and bridge.status = 'active'
        and (
          bridge.cutover_relationship_id is distinct from v_relationship_id
          or bridge.cutover_organization_id is distinct from v_organization_id
        )
    ) then
      raise exception 'legacy property_access translation encountered a stale topology-bound bridge: %', v_property_id
        using errcode = '42501';
    end if;
  end loop;

  -- Keep the bridge as an explicit mirror of the still-authoritative legacy
  -- row. Retiring a bridge for an explicitly removed legacy ID does not revoke
  -- the current app's access; it prevents a future normalized stage from
  -- mistaking the removed legacy row for a live grant.
  update public.account_property_authorization_bridges bridge
     set status = 'retired',
         retired_at = clock_timestamp(),
         retirement_reason = left(v_reason || ': legacy property_access removal', 500)
   where bridge.account_id = p_account_id
     and bridge.status = 'active'
     and not (bridge.property_id = any(coalesce(v_new_property_ids, '{}'::uuid[])));
  get diagnostics v_retired_bridge_count = row_count;

  foreach v_property_id in array coalesce(v_new_property_ids, '{}'::uuid[])
  loop
    select relationship.id, relationship.organization_id
      into v_relationship_id, v_organization_id
    from public._staxis_current_primary_property_relationships() relationship
    where relationship.property_id = v_property_id
      and relationship.active_primary_count = 1;

    insert into public.account_property_authorization_bridges (
      account_id, property_id, cutover_organization_id,
      cutover_relationship_id, topology_bound_at,
      source_legacy_scope_hash, cutover_reason
    ) values (
      p_account_id, v_property_id, v_organization_id, v_relationship_id,
      clock_timestamp(), v_next_scope_hash, v_reason
    )
    on conflict (account_id, property_id) where status = 'active' do nothing;
    if found then v_bridged_count := v_bridged_count + 1; end if;
  end loop;

  insert into public.account_access_cutover_legacy_write_events (
    account_id, operation, previous_property_ids, next_property_ids,
    previous_scope_hash, next_scope_hash, bridged_count,
    retired_bridge_count, reason
  ) values (
    p_account_id,
    case when p_previous_property_ids is null then 'INSERT' else 'UPDATE' end,
    p_previous_property_ids,
    coalesce(v_new_property_ids, '{}'::uuid[]),
    v_previous_scope_hash,
    v_next_scope_hash,
    v_bridged_count,
    v_retired_bridge_count,
    v_reason
  );

  return jsonb_build_object(
    'ok', true,
    'stage', 'A',
    'accountId', p_account_id,
    'legacyPropertyIds', to_jsonb(coalesce(v_new_property_ids, '{}'::uuid[])),
    'bridgedCount', v_bridged_count,
    'retiredBridgeCount', v_retired_bridge_count,
    'arraysPreserved', true,
    'authorityMode', v_state.authority_mode,
    'canonicalAuthorityChanged', false
  );
end;
$$;

revoke all on function public.staxis_translate_legacy_property_access(uuid, uuid[], text)
  from public, anon, authenticated;
grant execute on function public.staxis_translate_legacy_property_access(uuid, uuid[], text)
  to service_role;

create or replace function public._staxis_translate_legacy_property_access_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform public.staxis_translate_legacy_property_access(
    new.id,
    case when tg_op = 'UPDATE' then old.property_access else null end,
    'accounts.property_access compatibility translation'
  );
  return new;
end;
$$;

revoke all on function public._staxis_translate_legacy_property_access_trigger()
  from public, anon, authenticated, service_role;

-- PostgreSQL orders same-event triggers by name. `authorization_refresh` runs
-- first and creates/locks the state; this translator then validates the exact
-- row before the older organization projection trigger runs.
drop trigger if exists trg_accounts_authorization_translate_legacy_property_access
  on public.accounts;
create trigger trg_accounts_authorization_translate_legacy_property_access
  after insert or update of property_access on public.accounts
  for each row execute function public._staxis_translate_legacy_property_access_trigger();

insert into public.applied_migrations (version, description)
values (
  '0420',
  'Stage A transactional legacy property_access translation into topology-bound shadow bridges; ambiguous writes fail closed and arrays remain authoritative.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
