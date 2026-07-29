-- 0382_admin_hotel_relationship_lifecycle.sql
--
-- Safe platform-admin hotel lifecycle management for the existing /company
-- Hotels tab. This wraps the established serialized primary-relationship move
-- in a bounded read projection and preview/fingerprint/confirmation protocol.
-- Customer company roles never enter this realm. Every RPC rechecks the
-- actor's live accounts.role='admin' and active flag in the database.

begin;

do $$
begin
  if to_regclass('public.account_authorization_state') is null
     or to_regclass('public.organization_access_epochs') is null
     or to_regclass('public.organization_access_events') is null
     or to_regprocedure('public.staxis_set_primary_property_organization(uuid,uuid,uuid,text)') is null
  then
    raise exception '0382 requires organization access foundation 0325 and authoritative access 0376';
  end if;
end
$$;

-- @rls: service-role-only — exact idempotent responses contain internal
-- authorization and mutation receipts and are available only through the
-- SECURITY DEFINER commit RPC.
create table if not exists public.admin_hotel_relationship_mutation_requests (
  id                   uuid primary key default gen_random_uuid(),
  actor_account_id     uuid not null references public.accounts(id) on delete restrict,
  idempotency_key      uuid not null,
  request_fingerprint  text not null,
  property_id          uuid not null references public.properties(id) on delete restrict,
  response             jsonb not null,
  created_at           timestamptz not null default now(),

  constraint admin_hotel_relationship_mutation_actor_key
    unique (actor_account_id, idempotency_key),
  constraint admin_hotel_relationship_mutation_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint admin_hotel_relationship_mutation_response_check
    check (jsonb_typeof(response) = 'object')
);

create index if not exists admin_hotel_relationship_mutation_created_idx
  on public.admin_hotel_relationship_mutation_requests (created_at desc);

alter table public.admin_hotel_relationship_mutation_requests enable row level security;
revoke all on public.admin_hotel_relationship_mutation_requests
  from public, anon, authenticated, service_role;

create or replace function public._staxis_assert_active_platform_admin(
  p_actor_account_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_actor_account_id is null or not exists (
    select 1
    from public.accounts actor
    where actor.id = p_actor_account_id
      and actor.active is true
      and actor.role = 'admin'
  ) then
    raise exception 'only an active Staxis platform administrator may manage hotel relationships'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public._staxis_assert_active_platform_admin(uuid)
  from public, anon, authenticated, service_role;

-- Immutable digest of all state that the established move RPC may consume or
-- mutate for this hotel. Including dependent grants/invitations/requests and
-- portfolio rows makes a preview stale when its exact revocation impact moves.
create or replace function public._staxis_admin_hotel_relationship_revision(
  p_property_id uuid
)
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'admin-hotel-relationship-v1',
    'property', (
      select jsonb_build_array(property.id, property.name, property.subscription_status)
      from public.properties property
      where property.id = p_property_id
    ),
    'primaryRelationships', coalesce((
      select jsonb_agg(jsonb_build_array(
        relationship.id,
        relationship.organization_id,
        relationship.relationship_type,
        relationship.is_primary_grouping,
        relationship.starts_at,
        relationship.ends_at,
        relationship.updated_at
      ) order by relationship.id)
      from public.organization_property_relationships relationship
      where relationship.property_id = p_property_id
        and relationship.is_primary_grouping is true
        and relationship.starts_at <= now()
        and (relationship.ends_at is null or relationship.ends_at > now())
    ), '[]'::jsonb),
    'propertyGrants', coalesce((
      select jsonb_agg(jsonb_build_array(
        grant_row.id, grant_row.organization_id, grant_row.membership_id,
        grant_row.status, grant_row.version, grant_row.starts_at,
        grant_row.expires_at, grant_row.updated_at
      ) order by grant_row.id)
      from public.organization_access_grants grant_row
      where grant_row.property_id = p_property_id
        and grant_row.property_relationship_id in (
          select relationship.id
          from public.organization_property_relationships relationship
          where relationship.property_id = p_property_id
            and relationship.is_primary_grouping is true
            and relationship.starts_at <= now()
            and (relationship.ends_at is null or relationship.ends_at > now())
        )
        and grant_row.status = 'active'
    ), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(jsonb_build_array(
        invitation.id, invitation.organization_id, invitation.status,
        invitation.expires_at, invitation.updated_at
      ) order by invitation.id)
      from public.organization_invitations invitation
      where invitation.property_id = p_property_id
        and invitation.property_relationship_id in (
          select relationship.id
          from public.organization_property_relationships relationship
          where relationship.property_id = p_property_id
            and relationship.is_primary_grouping is true
            and relationship.starts_at <= now()
            and (relationship.ends_at is null or relationship.ends_at > now())
        )
        and invitation.status = 'pending'
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_array(
        request_row.id, request_row.organization_id, request_row.status,
        request_row.requested_at, request_row.updated_at
      ) order by request_row.id)
      from public.organization_access_requests request_row
      where request_row.property_id = p_property_id
        and request_row.property_relationship_id in (
          select relationship.id
          from public.organization_property_relationships relationship
          where relationship.property_id = p_property_id
            and relationship.is_primary_grouping is true
            and relationship.starts_at <= now()
            and (relationship.ends_at is null or relationship.ends_at > now())
        )
        and request_row.status = 'pending'
    ), '[]'::jsonb),
    'portfolioAssignments', coalesce((
      select jsonb_agg(jsonb_build_array(
        assignment.id, assignment.organization_id, assignment.portfolio_id,
        assignment.property_relationship_id, assignment.assigned_at,
        assignment.removed_at, assignment.updated_at
      ) order by assignment.id)
      from public.portfolio_properties assignment
      where assignment.property_id = p_property_id
        and assignment.property_relationship_id in (
          select relationship.id
          from public.organization_property_relationships relationship
          where relationship.property_id = p_property_id
            and relationship.is_primary_grouping is true
            and relationship.starts_at <= now()
            and (relationship.ends_at is null or relationship.ends_at > now())
        )
        and assignment.removed_at is null
    ), '[]'::jsonb)
  )::text, 'UTF8')), 'hex');
$$;

revoke all on function public._staxis_admin_hotel_relationship_revision(uuid)
  from public, anon, authenticated, service_role;

-- Bounded company search plus the exact selected hotel's primary lifecycle.
-- No customer memberships, grants, emails, or account identifiers are exposed.
create or replace function public.staxis_admin_hotel_relationship_projection(
  p_actor_account_id uuid,
  p_property_id uuid,
  p_organization_query text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_property record;
  v_current record;
  v_query text := btrim(coalesce(p_organization_query, ''));
  v_organizations jsonb := '[]'::jsonb;
  v_truncated boolean := false;
  v_revision text;
  v_active_primary_count integer := 0;
begin
  perform public._staxis_assert_active_platform_admin(p_actor_account_id);
  if p_property_id is null or char_length(v_query) > 120 then
    raise exception 'invalid hotel relationship projection input' using errcode = '22023';
  end if;

  select property.id, coalesce(property.name, 'Hotel') as name,
         coalesce(property.subscription_status, 'unknown') as status
    into v_property
  from public.properties property
  where property.id = p_property_id;
  if not found then raise exception 'hotel not found' using errcode = 'P0002'; end if;

  select count(*)::integer into v_active_primary_count
  from public.organization_property_relationships relationship
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= now()
    and (relationship.ends_at is null or relationship.ends_at > now());
  if v_active_primary_count > 1 then
    raise exception 'hotel has multiple active primary relationships; repair is required'
      using errcode = '23514';
  end if;

  select relationship.id, relationship.organization_id,
         organization.name as organization_name,
         organization.organization_type,
         relationship.relationship_type, relationship.starts_at
    into v_current
  from public.organization_property_relationships relationship
  join public.organizations organization on organization.id = relationship.organization_id
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= now()
    and (relationship.ends_at is null or relationship.ends_at > now())
    and organization.organization_type in ('management_company', 'ownership_group')
  order by relationship.starts_at desc, relationship.id
  limit 1;

  with matches as (
    select organization.id, organization.name, organization.organization_type,
           row_number() over (order by lower(organization.name), organization.id) as ordinal
    from public.organizations organization
    where organization.status = 'active'
      and organization.organization_type in ('management_company', 'ownership_group')
      and (v_query = '' or position(lower(v_query) in lower(organization.name)) > 0)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', matches.id,
           'name', matches.name,
           'type', matches.organization_type,
           'status', 'active'
         ) order by matches.ordinal) filter (where matches.ordinal <= 100), '[]'::jsonb),
         coalesce(bool_or(matches.ordinal > 100), false)
    into v_organizations, v_truncated
  from matches
  where matches.ordinal <= 101;

  v_revision := public._staxis_admin_hotel_relationship_revision(p_property_id);
  return jsonb_build_object(
    'schemaVersion', 'admin-hotel-relationship-v1',
    'generatedAt', clock_timestamp(),
    'property', jsonb_build_object(
      'id', v_property.id,
      'name', v_property.name,
      'status', v_property.status
    ),
    'lifecycleStatus', case when v_current.id is null then 'independent' else 'company_managed' end,
    'currentRelationship', case when v_current.id is null then null else jsonb_build_object(
      'id', v_current.id,
      'organizationId', v_current.organization_id,
      'organizationName', v_current.organization_name,
      'organizationType', v_current.organization_type,
      'relationshipType', v_current.relationship_type,
      'status', 'active',
      'startsAt', v_current.starts_at
    ) end,
    'relationshipRevision', v_revision,
    'organizationQuery', v_query,
    'organizations', v_organizations,
    'organizationResultLimit', 100,
    'organizationResultsTruncated', v_truncated
  );
end;
$$;

revoke all on function public.staxis_admin_hotel_relationship_projection(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_admin_hotel_relationship_projection(uuid, uuid, text)
  to service_role;

create or replace function public._staxis_preview_admin_hotel_relationship(
  p_actor_account_id uuid,
  p_property_id uuid,
  p_target_organization_id uuid,
  p_relationship_type text,
  p_expected_relationship_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_name text;
  v_current record;
  v_target record;
  v_revision text;
  v_changed boolean;
  v_grants integer := 0;
  v_invitations integer := 0;
  v_requests integer := 0;
  v_assignments integer := 0;
  v_fingerprint text;
  v_active_primary_count integer := 0;
begin
  perform public._staxis_assert_active_platform_admin(p_actor_account_id);
  if p_property_id is null
     or p_expected_relationship_revision is null
     or p_expected_relationship_revision !~ '^[0-9a-f]{64}$'
     or (p_target_organization_id is null and p_relationship_type is not null)
     or (p_target_organization_id is not null and p_relationship_type not in ('operator', 'owner'))
  then
    raise exception 'invalid hotel relationship preview' using errcode = '22023';
  end if;

  select coalesce(property.name, 'Hotel') into v_property_name
  from public.properties property where property.id = p_property_id;
  if not found then raise exception 'hotel not found' using errcode = 'P0002'; end if;

  select count(*)::integer into v_active_primary_count
  from public.organization_property_relationships relationship
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= now()
    and (relationship.ends_at is null or relationship.ends_at > now());
  if v_active_primary_count > 1 then
    raise exception 'hotel has multiple active primary relationships; repair is required'
      using errcode = '23514';
  end if;

  v_revision := public._staxis_admin_hotel_relationship_revision(p_property_id);
  if v_revision <> p_expected_relationship_revision then
    raise exception 'hotel relationship changed; reload before confirming'
      using errcode = '40001';
  end if;

  select relationship.id, relationship.organization_id,
         organization.name as organization_name,
         organization.organization_type,
         relationship.relationship_type, relationship.starts_at
    into v_current
  from public.organization_property_relationships relationship
  join public.organizations organization on organization.id = relationship.organization_id
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= now()
    and (relationship.ends_at is null or relationship.ends_at > now())
    and organization.organization_type in ('management_company', 'ownership_group')
  order by relationship.starts_at desc, relationship.id
  limit 1;

  -- A PL/pgSQL record that was never assigned cannot be dereferenced. Give
  -- the explicit Independent target a typed null row before fingerprinting.
  select null::uuid as id, null::text as name, null::text as organization_type
    into v_target;
  if p_target_organization_id is not null then
    select organization.id, organization.name, organization.organization_type
      into v_target
    from public.organizations organization
    where organization.id = p_target_organization_id
      and organization.status = 'active'
      and organization.organization_type in ('management_company', 'ownership_group');
    if not found then
      raise exception 'target company not found or unavailable' using errcode = '23503';
    end if;
  end if;

  v_changed := case
    when v_current.id is null then p_target_organization_id is not null
    when p_target_organization_id is null then true
    else v_current.organization_id <> p_target_organization_id
      or v_current.relationship_type <> p_relationship_type
  end;

  if v_changed and v_current.id is not null then
    select count(*)::integer into v_grants
    from public.organization_access_grants grant_row
    where grant_row.property_relationship_id = v_current.id
      and grant_row.status = 'active';

    select count(*)::integer into v_invitations
    from public.organization_invitations invitation
    where invitation.property_relationship_id = v_current.id
      and invitation.status = 'pending';

    select count(*)::integer into v_requests
    from public.organization_access_requests request_row
    where request_row.property_relationship_id = v_current.id
      and request_row.status = 'pending';

    select count(*)::integer into v_assignments
    from public.portfolio_properties assignment
    where assignment.property_relationship_id = v_current.id
      and assignment.removed_at is null;
  end if;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'admin-hotel-relationship-v1',
    'actorAccountId', p_actor_account_id,
    'propertyId', p_property_id,
    'propertyName', v_property_name,
    'currentRelationshipId', v_current.id,
    'currentOrganizationId', v_current.organization_id,
    'currentRelationshipType', v_current.relationship_type,
    'targetOrganizationId', p_target_organization_id,
    'targetOrganizationName', v_target.name,
    'relationshipType', p_relationship_type,
    'expectedRelationshipRevision', p_expected_relationship_revision,
    'changed', v_changed,
    'revokedPropertyGrantCount', v_grants,
    'revokedInvitationCount', v_invitations,
    'cancelledRequestCount', v_requests,
    'removedPortfolioAssignmentCount', v_assignments
  )::text, 'UTF8')), 'hex');

  return jsonb_build_object(
    'schemaVersion', 'admin-hotel-relationship-v1',
    'propertyId', p_property_id,
    'propertyName', v_property_name,
    'targetOrganizationId', p_target_organization_id,
    'relationshipType', p_relationship_type,
    'expectedRelationshipRevision', p_expected_relationship_revision,
    'currentRelationship', case when v_current.id is null then null else jsonb_build_object(
      'id', v_current.id,
      'organizationId', v_current.organization_id,
      'organizationName', v_current.organization_name,
      'organizationType', v_current.organization_type,
      'relationshipType', v_current.relationship_type,
      'status', 'active',
      'startsAt', v_current.starts_at
    ) end,
    'targetOrganization', case when p_target_organization_id is null then null else jsonb_build_object(
      'id', v_target.id,
      'name', v_target.name,
      'type', v_target.organization_type,
      'status', 'active'
    ) end,
    'lifecycleAfter', case when p_target_organization_id is null then 'independent' else 'company_managed' end,
    'changed', v_changed,
    'accessChangesImmediately', true,
    'impact', jsonb_build_object(
      'revokedPropertyGrantCount', v_grants,
      'revokedInvitationCount', v_invitations,
      'cancelledRequestCount', v_requests,
      'removedPortfolioAssignmentCount', v_assignments
    ),
    'previewFingerprint', v_fingerprint
  );
end;
$$;

revoke all on function public._staxis_preview_admin_hotel_relationship(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public._staxis_preview_admin_hotel_relationship(
  uuid, uuid, uuid, text, text
) to service_role;

create or replace function public.staxis_commit_admin_hotel_relationship(
  p_actor_account_id uuid,
  p_property_id uuid,
  p_target_organization_id uuid,
  p_relationship_type text,
  p_expected_relationship_revision text,
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
  v_cached public.admin_hotel_relationship_mutation_requests%rowtype;
  v_request_fingerprint text;
  v_preview jsonb;
  v_lock_organization_id uuid;
  v_relationship_id uuid;
  v_current_organization_id uuid;
  v_current_relationship_type text;
  v_changed boolean;
  v_response jsonb;
begin
  -- This check intentionally precedes idempotency replay: removing the admin
  -- role invalidates an open/stale browser immediately, even for an old key.
  perform public._staxis_assert_active_platform_admin(p_actor_account_id);
  if p_property_id is null
     or p_expected_relationship_revision is null
     or p_expected_relationship_revision !~ '^[0-9a-f]{64}$'
     or p_preview_fingerprint is null
     or p_preview_fingerprint !~ '^[0-9a-f]{64}$'
     or p_confirmed is not true
     or p_idempotency_key is null
     or (p_target_organization_id is null and p_relationship_type is not null)
     or (p_target_organization_id is not null and p_relationship_type not in ('operator', 'owner'))
  then
    raise exception 'explicit preview confirmation and idempotency key are required'
      using errcode = '22023';
  end if;

  v_request_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'schemaVersion', 'admin-hotel-relationship-v1',
    'actorAccountId', p_actor_account_id,
    'propertyId', p_property_id,
    'targetOrganizationId', p_target_organization_id,
    'relationshipType', p_relationship_type,
    'expectedRelationshipRevision', p_expected_relationship_revision,
    'previewFingerprint', p_preview_fingerprint,
    'confirmed', p_confirmed
  )::text, 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    'staxis.admin-hotel-relationship-idempotency:'
      || p_actor_account_id::text || ':' || p_idempotency_key::text, 0
  ));
  select * into v_cached
  from public.admin_hotel_relationship_mutation_requests request_row
  where request_row.actor_account_id = p_actor_account_id
    and request_row.idempotency_key = p_idempotency_key;
  if found then
    if v_cached.request_fingerprint <> v_request_fingerprint then
      raise exception 'idempotency key is already bound to a different request'
        using errcode = '23505';
    end if;
    return jsonb_set(v_cached.response, '{idempotentReplay}', 'true'::jsonb, true);
  end if;

  -- Match the established move RPC lock order: property row, property advisory
  -- lock, then all affected organizations in UUID order.
  perform 1 from public.properties property where property.id = p_property_id for update;
  if not found then raise exception 'hotel not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));

  for v_lock_organization_id in
    select affected.organization_id
    from (
      select p_target_organization_id as organization_id
      union
      select relationship.organization_id
      from public.organization_property_relationships relationship
      where relationship.property_id = p_property_id
        and relationship.is_primary_grouping is true
        and relationship.starts_at <= now()
        and (relationship.ends_at is null or relationship.ends_at > now())
    ) affected
    where affected.organization_id is not null
    order by affected.organization_id
  loop
    perform public._staxis_lock_organization(v_lock_organization_id);
    perform 1 from public.organizations organization
      where organization.id = v_lock_organization_id for share;
  end loop;

  -- Recheck the live role after waiting on every lock, then recompute the
  -- impact under those locks. No UI/session role is trusted.
  perform public._staxis_assert_active_platform_admin(p_actor_account_id);
  v_preview := public._staxis_preview_admin_hotel_relationship(
    p_actor_account_id,
    p_property_id,
    p_target_organization_id,
    p_relationship_type,
    p_expected_relationship_revision
  );
  if v_preview->>'previewFingerprint' <> p_preview_fingerprint then
    raise exception 'hotel relationship preview is stale or does not match this change'
      using errcode = '40001';
  end if;
  v_changed := (v_preview->>'changed')::boolean;

  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);
  perform set_config('staxis.request_id', p_idempotency_key::text, true);

  if v_changed then
    select public.staxis_set_primary_property_organization(
      p_actor_account_id,
      p_property_id,
      p_target_organization_id,
      coalesce(p_relationship_type, 'operator')
    ) into v_relationship_id;
  else
    select relationship.id into v_relationship_id
    from public.organization_property_relationships relationship
    join public.organizations organization on organization.id = relationship.organization_id
    where relationship.property_id = p_property_id
      and relationship.is_primary_grouping is true
      and relationship.relationship_type in ('operator', 'owner')
      and relationship.starts_at <= now()
      and (relationship.ends_at is null or relationship.ends_at > now())
      and organization.organization_type in ('management_company', 'ownership_group')
    limit 1;
  end if;

  select relationship.organization_id, relationship.relationship_type
    into v_current_organization_id, v_current_relationship_type
  from public.organization_property_relationships relationship
  join public.organizations organization on organization.id = relationship.organization_id
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    -- `staxis_set_primary_property_organization` closes at clock_timestamp().
    -- Transaction-start `now()` would still classify that just-closed row as
    -- active while this commit function builds its response.
    and relationship.starts_at <= clock_timestamp()
    and (relationship.ends_at is null or relationship.ends_at > clock_timestamp())
    and organization.organization_type in ('management_company', 'ownership_group')
  limit 1;

  -- One immutable summary per affected customer organization makes both the
  -- source and destination audit timelines explain the exact same transfer.
  insert into public.organization_access_events (
    organization_id, actor_account_id, actor_kind, event_type, target_type,
    target_id, request_id, before_state, after_state, metadata
  )
  select affected.organization_id, p_actor_account_id, 'staxis_admin',
         'admin_hotel_relationship.commit', 'property', p_property_id::text,
         p_idempotency_key,
         jsonb_build_object(
           'organizationId', v_preview->'currentRelationship'->'organizationId',
           'relationshipType', v_preview->'currentRelationship'->'relationshipType'
         ),
         jsonb_build_object(
           'organizationId', to_jsonb(p_target_organization_id),
           'relationshipType', to_jsonb(p_relationship_type),
           'lifecycleStatus', v_preview->'lifecycleAfter'
         ),
         jsonb_build_object(
           'previewFingerprint', p_preview_fingerprint,
           'changed', v_changed,
           'impact', v_preview->'impact',
           'accessChangesImmediately', true
         )
  from (
    select nullif(v_preview->'currentRelationship'->>'organizationId', '')::uuid as organization_id
    union
    select p_target_organization_id
  ) affected
  where affected.organization_id is not null
  union all
  select null, p_actor_account_id, 'staxis_admin',
         'admin_hotel_relationship.commit', 'property', p_property_id::text,
         p_idempotency_key,
         jsonb_build_object('organizationId', null, 'relationshipType', null),
         jsonb_build_object('organizationId', null, 'relationshipType', null,
                            'lifecycleStatus', 'independent'),
         jsonb_build_object('previewFingerprint', p_preview_fingerprint,
                            'changed', false, 'impact', v_preview->'impact',
                            'accessChangesImmediately', true)
  where v_preview->'currentRelationship' is null
    and p_target_organization_id is null;

  v_response := jsonb_build_object(
    'schemaVersion', 'admin-hotel-relationship-v1',
    'propertyId', p_property_id,
    'relationshipId', v_relationship_id,
    'organizationId', v_current_organization_id,
    'relationshipType', v_current_relationship_type,
    'lifecycleStatus', case when v_current_organization_id is null then 'independent' else 'company_managed' end,
    'relationshipRevision', public._staxis_admin_hotel_relationship_revision(p_property_id),
    'changed', v_changed,
    'idempotentReplay', false,
    'auditRequestId', p_idempotency_key
  );

  insert into public.admin_hotel_relationship_mutation_requests (
    actor_account_id, idempotency_key, request_fingerprint, property_id, response
  ) values (
    p_actor_account_id, p_idempotency_key, v_request_fingerprint, p_property_id, v_response
  );

  return v_response;
end;
$$;

revoke all on function public.staxis_commit_admin_hotel_relationship(
  uuid, uuid, uuid, text, text, text, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.staxis_commit_admin_hotel_relationship(
  uuid, uuid, uuid, text, text, text, boolean, uuid
) to service_role;

insert into public.applied_migrations(version, description)
values (
  '0382',
  'Platform-admin-only preview-bound hotel company relationship lifecycle management in the existing My Hotel Hotels tab.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
