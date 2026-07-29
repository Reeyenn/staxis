-- 0388_active_primary_relationship_transfer_guard.sql
--
-- Forward hardening for the platform-admin hotel transfer primitive created in
-- 0325. The canonical authorization resolver considers a relationship active
-- when starts_at <= now() and (ends_at is null or ends_at > now()). The older
-- writer considered only ends_at is null, so a schema-valid scheduled-ending
-- primary could survive a transfer and temporarily authorize two companies.
--
-- This replacement uses the canonical window for discovery, locks and closes
-- the exact active primary, fails closed if historical/manual data contains
-- more than one active primary, and verifies the postcondition before commit.

begin;

do $$
begin
  if to_regprocedure('public.staxis_set_primary_property_organization(uuid,uuid,uuid,text)') is null
     or to_regprocedure('public._staxis_preview_admin_hotel_relationship(uuid,uuid,uuid,text,text)') is null
     or to_regclass('public.organization_access_events') is null
  then
    raise exception '0388 requires organization access foundation 0325 and admin lifecycle 0384';
  end if;
end
$$;

-- Serialize all direct relationship writes on the hotel row and reject any
-- current-or-future overlap between primary owner/operator windows. This is a
-- write boundary, not a cleanup migration: pre-existing overlap remains in
-- place for the fail-closed resolver and platform-admin repair workflow.
create or replace function public._staxis_guard_primary_relationship_window_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  for v_property_id in
    select distinct candidate.property_id
    from unnest(case
      when tg_op = 'UPDATE' then array[old.property_id, new.property_id]
      else array[new.property_id]
    end) candidate(property_id)
    where candidate.property_id is not null
    order by candidate.property_id
  loop
    perform 1
    from public.properties property
    where property.id = v_property_id
    for update;
    if not found then
      raise exception 'property not found' using errcode = '23503';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(v_property_id::text, 0));
  end loop;

  -- Ending/demoting a row is always permitted so an existing ambiguous state
  -- can be repaired without disabling this guard.
  if new.is_primary_grouping is not true
     or new.relationship_type not in ('operator', 'owner')
     or (new.ends_at is not null and new.ends_at <= v_now)
  then
    return new;
  end if;

  if exists (
    select 1
    from public.organization_property_relationships existing
    where existing.property_id = new.property_id
      and existing.id is distinct from new.id
      and existing.is_primary_grouping is true
      and existing.relationship_type in ('operator', 'owner')
      and (existing.ends_at is null or existing.ends_at > v_now)
      and greatest(existing.starts_at, new.starts_at, v_now)
        < least(
            coalesce(existing.ends_at, 'infinity'::timestamptz),
            coalesce(new.ends_at, 'infinity'::timestamptz)
          )
  ) then
    raise exception 'primary owner/operator relationship window overlaps another relationship'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public._staxis_guard_primary_relationship_window_overlap()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_organization_property_relationships_primary_window_guard
  on public.organization_property_relationships;
create trigger trg_organization_property_relationships_primary_window_guard
  before insert or update of property_id, relationship_type,
    is_primary_grouping, starts_at, ends_at
  on public.organization_property_relationships
  for each row execute function public._staxis_guard_primary_relationship_window_overlap();

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
  v_ending_relationship_ids uuid[] := '{}'::uuid[];
  v_lock_organization_id uuid;
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

  -- Serialize every lifecycle mutation for this hotel before inspecting its
  -- temporal topology. The property row and advisory lock are the same first
  -- two locks used by the 0325 function, preserving lock compatibility.
  perform 1 from public.properties property
    where property.id = p_property_id for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_property_id::text, 0));
  perform set_config('staxis.actor_account_id', p_actor_account_id::text, true);

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

  -- A future-start primary is not current authorization, but it would collide
  -- with an immediate replacement through the older NULL-only unique index.
  -- No product workflow schedules these rows, so surface the unsupported state
  -- instead of silently deleting a future governance decision.
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

  -- Lock the current active primary, requested destination, and existing hidden
  -- Independent anchor in deterministic UUID order. Reconcile takes the same
  -- anchor lock reentrantly and cannot change what another transfer sees.
  for v_lock_organization_id in
    select affected.organization_id
    from (
      select p_organization_id as organization_id
      union
      select relationship.organization_id
      from public.organization_property_relationships relationship
      where relationship.property_id = p_property_id
        and relationship.is_primary_grouping is true
        and relationship.relationship_type in ('operator', 'owner')
        and relationship.starts_at <= v_now
        and (relationship.ends_at is null or relationship.ends_at > v_now)
      union
      select anchor.id
      from public.organizations anchor
      where anchor.organization_type = 'single_hotel'
        and anchor.legacy_property_id = p_property_id
    ) affected
    where affected.organization_id is not null
    order by affected.organization_id
  loop
    perform public._staxis_lock_organization(v_lock_organization_id);
  end loop;

  if p_organization_id is not null and not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.status = 'active'
      and organization.organization_type <> 'single_hotel'
  ) then
    raise exception 'target organization is unavailable or is a system-managed single-hotel anchor'
      using errcode = '23503';
  end if;

  -- The legacy reconciler tests NULL-ended primaries. Normalize the sole
  -- current primary to NULL-ended inside this transaction first, so reconcile
  -- cannot transiently promote the Independent anchor beside it. The write
  -- guard therefore remains absolute even inside this repair primitive.
  update public.organization_property_relationships relationship
     set ends_at = null,
         updated_by_account_id = p_actor_account_id
   where relationship.property_id = p_property_id
     and relationship.is_primary_grouping is true
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= v_now
     and relationship.ends_at > v_now;

  -- Ensure the hidden Independent anchor and its legacy compatibility facts
  -- exist without ever creating a second primary window.
  perform public._staxis_reconcile_legacy_organization_access(
    p_property_id,
    p_actor_account_id
  );

  update public.organization_property_relationships anchor_relationship
     set is_primary_grouping = false,
         updated_by_account_id = p_actor_account_id
    from public.organizations anchor
   where anchor_relationship.organization_id = anchor.id
     and anchor_relationship.property_id = p_property_id
     and anchor_relationship.is_primary_grouping is true
     and anchor_relationship.relationship_type in ('operator', 'owner')
     and anchor_relationship.starts_at <= v_now
     and (anchor_relationship.ends_at is null or anchor_relationship.ends_at > v_now)
     and anchor.organization_type = 'single_hotel'
     and (
       p_organization_id is not null
       or exists (
         select 1
         from public.organization_property_relationships real_relationship
         join public.organizations real_organization
           on real_organization.id = real_relationship.organization_id
          and real_organization.organization_type <> 'single_hotel'
         where real_relationship.property_id = p_property_id
           and real_relationship.is_primary_grouping is true
           and real_relationship.relationship_type in ('operator', 'owner')
           and real_relationship.starts_at <= v_now
           and (real_relationship.ends_at is null or real_relationship.ends_at > v_now)
       )
     );

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

  select coalesce(array_agg(relationship.id order by relationship.id), '{}'::uuid[])
    into v_ending_relationship_ids
  from public.organization_property_relationships relationship
  join public.organizations organization on organization.id = relationship.organization_id
  where relationship.property_id = p_property_id
    and relationship.is_primary_grouping is true
    and relationship.relationship_type in ('operator', 'owner')
    and relationship.starts_at <= v_now
    and (relationship.ends_at is null or relationship.ends_at > v_now)
    and organization.organization_type <> 'single_hotel'
    and (
      p_organization_id is null
      or relationship.organization_id <> p_organization_id
      or relationship.relationship_type <> p_relationship_type
    );

  if cardinality(v_ending_relationship_ids) > 0 then
    update public.organization_access_grants grant_row
       set status = 'revoked',
           revoked_at = v_now,
           revoked_by_account_id = p_actor_account_id,
           revocation_reason = 'Hotel relationship ended',
           version = grant_row.version + 1
     where grant_row.property_relationship_id = any(v_ending_relationship_ids)
       and grant_row.status = 'active';

    update public.organization_invitations invitation
       set status = 'revoked',
           revoked_at = v_now,
           revoked_by_account_id = p_actor_account_id
     where invitation.property_relationship_id = any(v_ending_relationship_ids)
       and invitation.status = 'pending';

    update public.organization_access_requests request_row
       set status = 'cancelled',
           reviewed_at = v_now,
           reviewed_by_account_id = p_actor_account_id,
           review_note = 'Hotel relationship ended before review',
           resulting_grant_id = null
     where request_row.property_relationship_id = any(v_ending_relationship_ids)
       and request_row.status = 'pending';

    delete from public.portfolio_properties assignment
     where assignment.property_relationship_id = any(v_ending_relationship_ids)
       and assignment.removed_at is null
       and assignment.assigned_at >= v_now;

    update public.portfolio_properties assignment
       set removed_at = v_now,
           removed_by_account_id = p_actor_account_id
     where assignment.property_relationship_id = any(v_ending_relationship_ids)
       and assignment.removed_at is null
       and assignment.assigned_at < v_now;
  end if;

  update public.organization_property_relationships relationship
     set starts_at = least(relationship.starts_at, v_now - interval '1 microsecond'),
         ends_at = v_now,
         updated_by_account_id = p_actor_account_id
   where relationship.id = any(v_ending_relationship_ids);

  if p_organization_id is null then
    select relationship.id into v_relationship_id
    from public.organization_property_relationships relationship
    join public.organizations anchor
      on anchor.id = relationship.organization_id
     and anchor.organization_type = 'single_hotel'
     and anchor.legacy_property_id = p_property_id
    where relationship.property_id = p_property_id
      and relationship.relationship_type in ('operator', 'owner')
      and relationship.starts_at <= v_now
      and (relationship.ends_at is null or relationship.ends_at > v_now)
    order by relationship.starts_at desc, relationship.id
    limit 1
    for update of relationship;
    if v_relationship_id is null then
      raise exception 'independent hotel anchor relationship is unavailable'
        using errcode = '23514';
    end if;
    update public.organization_property_relationships relationship
       set is_primary_grouping = true,
           ends_at = null,
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
      raise exception 'target company has multiple active relationships for this hotel'
        using errcode = '23514';
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
         set is_primary_grouping = true,
             ends_at = null,
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

revoke all on function public.staxis_set_primary_property_organization(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.staxis_set_primary_property_organization(
  uuid, uuid, uuid, text
) to service_role;

insert into public.applied_migrations(version, description)
values (
  '0388',
  'Serialize direct primary owner/operator window writes, reject current/future overlap, and align platform-admin transfers with the same invariant without rewriting existing ambiguity.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
