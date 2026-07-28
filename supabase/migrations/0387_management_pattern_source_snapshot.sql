-- 0387_management_pattern_source_snapshot.sql
--
-- One MVCC-consistent, organization-scoped source read for the deterministic
-- management-company pattern runner. It deliberately returns evidence instead
-- of deciding findings: TypeScript applies the versioned normalization,
-- cohort, statistics, consolidation, and scope policies.
--
-- The function reads only the target organization's governing relationship
-- snapshot. It never accepts a caller-provided property list. Monetary input
-- comes from three explicitly closed inventory periods; room-sold denominator
-- input comes from sealed daily closing photos with stated provenance. Raw
-- inventory-order weeks are intentionally not a comparison source.

create index if not exists organization_property_relationships_historical_scope_idx
  on public.organization_property_relationships
    (organization_id, starts_at, ends_at, property_id)
  where is_primary_grouping and relationship_type in ('operator', 'owner');

create index if not exists portfolio_properties_historical_scope_idx
  on public.portfolio_properties
    (organization_id, assigned_at, removed_at, property_id, portfolio_id);

-- Relationship moves store the destination organization on the audit row and
-- the source organization only inside before_state. These partial expression
-- indexes keep historical tenant discovery and the same-property exclusivity
-- guard bounded without exposing cross-company payloads to the caller.
create index if not exists organization_access_events_relationship_before_scope_idx
  on public.organization_access_events (
    (before_state->>'organization_id'), (before_state->>'property_id'),
    occurred_at, target_id
  ) where target_type = 'organization_property_relationships';
create index if not exists organization_access_events_relationship_after_scope_idx
  on public.organization_access_events (
    (after_state->>'organization_id'), (after_state->>'property_id'),
    occurred_at, target_id
  ) where target_type = 'organization_property_relationships';
create index if not exists organization_access_events_relationship_before_property_idx
  on public.organization_access_events (
    (before_state->>'property_id'), occurred_at, target_id
  ) where target_type = 'organization_property_relationships';
create index if not exists organization_access_events_relationship_after_property_idx
  on public.organization_access_events (
    (after_state->>'property_id'), occurred_at, target_id
  ) where target_type = 'organization_property_relationships';
create index if not exists organization_access_events_portfolio_property_before_scope_idx
  on public.organization_access_events (
    (before_state->>'organization_id'), (before_state->>'property_id'),
    (before_state->>'portfolio_id'), occurred_at, target_id
  ) where target_type = 'portfolio_properties';
create index if not exists organization_access_events_portfolio_property_after_scope_idx
  on public.organization_access_events (
    (after_state->>'organization_id'), (after_state->>'property_id'),
    (after_state->>'portfolio_id'), occurred_at, target_id
  ) where target_type = 'portfolio_properties';

-- Migration 0387 intentionally precedes the durable evidence plane that
-- creates management_pattern_property_profiles.  Keep the source reader
-- independently installable and fail closed during that short deployment
-- interval: the dynamic lookup returns no profile while the relation is
-- absent, which makes the affected property ineligible for comparison.  A
-- fixed TABLE signature still gives the outer reader a typed, reviewable
-- contract; no caller (including service_role) may invoke this helper
-- directly.
create or replace function public.management_pattern_profile_at_v1(
  p_organization_id uuid,
  p_property_id uuid,
  p_property_relationship_id uuid,
  p_topology_as_of timestamptz,
  p_source_as_of timestamptz
)
returns table (
  id uuid,
  profile_version integer,
  effective_from timestamptz,
  effective_to timestamptz,
  source_kind text,
  source_reference text,
  created_at timestamptz,
  room_count integer,
  timezone_name text,
  business_date_cutoff_hour integer,
  service_level text,
  market_type text,
  brand_class text,
  location_type text,
  operating_model text,
  amenity_tags text[],
  currency_code text,
  currency_minor_unit_exponent smallint,
  comparison_attributes jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  return query execute $profile$
    select
      mp.id,
      mp.profile_version,
      mp.effective_from,
      mp.effective_to,
      mp.source_kind,
      mp.source_reference,
      mp.created_at,
      mp.room_count,
      mp.timezone_name,
      mp.business_date_cutoff_hour,
      mp.service_level,
      mp.market_type,
      mp.brand_class,
      mp.location_type,
      mp.operating_model,
      mp.amenity_tags,
      mp.currency_code,
      mp.currency_minor_unit_exponent::smallint,
      mp.comparison_attributes
    from public.management_pattern_property_profiles mp
    where mp.organization_id = $1
      and mp.property_id = $2
      and mp.property_relationship_id = $3
      and mp.effective_from <= $4
      and (mp.effective_to is null or mp.effective_to > $4)
      and mp.created_at <= $5
    order by mp.effective_from desc, mp.profile_version desc, mp.id
    limit 1
  $profile$
  using p_organization_id, p_property_id, p_property_relationship_id,
        p_topology_as_of, p_source_as_of;
exception
  when undefined_table then
    -- Expected only while 0387 is installed before 0390.  Returning no row is
    -- deliberately conservative: the outer reader cannot invent a cohort
    -- profile from mutable or cross-tenant data.
    return;
end
$$;

revoke all on function public.management_pattern_profile_at_v1(
  uuid,uuid,uuid,timestamptz,timestamptz
) from public, anon, authenticated, service_role;

-- Remove the pre-split as-of draft overload if this development migration was
-- exercised before source_as_of/topology_as_of became explicit. Leaving it
-- callable would preserve a weaker historical-tenant boundary.
drop function if exists public.load_management_pattern_source_snapshot(
  uuid,timestamptz,date,date,integer,integer
);

create or replace function public.load_management_pattern_source_snapshot(
  p_organization_id uuid,
  p_evaluation_at timestamptz,
  p_source_as_of timestamptz,
  p_topology_as_of timestamptz,
  p_supply_window_start date,
  p_supply_window_end date,
  p_activity_history_days integer default 98,
  p_max_properties integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_organization record;
  v_result jsonb;
begin
  if p_organization_id is null or p_evaluation_at is null
     or p_source_as_of is null or p_topology_as_of is null then
    raise exception 'organization_id and all as-of instants are required' using errcode = '22023';
  end if;
  if p_topology_as_of > p_source_as_of or p_source_as_of > p_evaluation_at then
    raise exception 'require topology_as_of <= source_as_of <= evaluation_at'
      using errcode = '22023';
  end if;
  if p_supply_window_start is null or p_supply_window_end is null
     or p_supply_window_end < p_supply_window_start then
    raise exception 'supply window is invalid' using errcode = '22023';
  end if;
  if p_supply_window_start <> date_trunc('month', p_supply_window_start)::date
     or p_supply_window_end <> (date_trunc('month', p_supply_window_end) + interval '1 month - 1 day')::date then
    raise exception 'supply window must contain complete calendar months' using errcode = '22023';
  end if;
  if p_activity_history_days < 28 or p_activity_history_days > 366 then
    raise exception 'activity_history_days must be between 28 and 366' using errcode = '22023';
  end if;
  if p_max_properties <> 50 then
    raise exception 'management pattern v1 supports exactly the fixed 50-property ceiling' using errcode = '22023';
  end if;
  if (
    extract(year from age(p_supply_window_end + 1, p_supply_window_start)) * 12
    + extract(month from age(p_supply_window_end + 1, p_supply_window_start))
  )::integer <> 3 then
    raise exception 'management pattern v1 requires exactly three complete supply months' using errcode = '22023';
  end if;

  select o.id, o.organization_type, o.status, o.legacy_property_id, o.updated_at
    into v_organization
  from public.organizations o
  where o.id = p_organization_id;

  if not found then
    raise exception 'organization not found' using errcode = 'P0002';
  end if;
  if v_organization.status <> 'active'
     or v_organization.organization_type not in ('management_company', 'ownership_group')
     or v_organization.legacy_property_id is not null then
    raise exception 'organization is not an active management portfolio' using errcode = '22023';
  end if;
  if v_organization.updated_at > p_topology_as_of then
    raise exception 'organization metadata is newer than topology_as_of' using errcode = '22023';
  end if;

  -- Resolve the target company's property IDs first, then guard every primary
  -- relationship for those properties (including relationships owned by a
  -- different company). This is an exclusivity check only: cross-company state
  -- is never returned or used as a benchmark input.
  if exists (
    with tenant_properties(property_id) as (
      select r.property_id::text
      from public.organization_property_relationships r
      where r.organization_id = p_organization_id
      union
      select state.value->>'property_id'
      from public.organization_access_events e
      cross join lateral (values (e.before_state), (e.after_state)) state(value)
      where e.target_type = 'organization_property_relationships'
        and state.value is not null
        and state.value->>'organization_id' = p_organization_id::text
        and state.value->>'property_id' is not null
    )
    select 1
    from public.organization_property_relationships r
    join tenant_properties target on target.property_id = r.property_id::text
    where r.is_primary_grouping
      and r.relationship_type in ('operator', 'owner')
      and r.created_at <= p_topology_as_of
      and r.updated_at > p_topology_as_of
      and not exists (
        select 1 from public.organization_access_events e
        where e.target_type = 'organization_property_relationships'
          and e.target_id = r.id::text
      )
  ) then
    raise exception 'relationship topology history is unavailable at topology_as_of'
      using errcode = '55000';
  end if;

  -- occurred_at is transaction time in the existing access ledger. Two
  -- mutations of one relationship in a transaction therefore have no durable
  -- causal ordering. An unchanged current row is authoritative after that
  -- transaction; at any earlier/deleted cutoff we must fail closed instead of
  -- breaking ties by random UUID.
  if exists (
    with tenant_properties(property_id) as (
      select r.property_id::text
      from public.organization_property_relationships r
      where r.organization_id = p_organization_id
      union
      select state.value->>'property_id'
      from public.organization_access_events e
      cross join lateral (values (e.before_state), (e.after_state)) state(value)
      where e.target_type = 'organization_property_relationships'
        and state.value is not null
        and state.value->>'organization_id' = p_organization_id::text
        and state.value->>'property_id' is not null
    ), relevant_events as (
      select e.*
      from public.organization_access_events e
      where e.target_type = 'organization_property_relationships'
        and e.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and exists (
          select 1 from tenant_properties target
          where target.property_id = e.before_state->>'property_id'
             or target.property_id = e.after_state->>'property_id'
        )
    )
    select 1
    from relevant_events e
    where not exists (
      select 1
      from public.organization_property_relationships current_row
      where current_row.id::text = e.target_id
        and current_row.created_at <= p_topology_as_of
        and current_row.updated_at <= p_topology_as_of
    )
    group by e.target_id, e.occurred_at
    having count(*) > 1
  ) then
    raise exception 'relationship topology history order is unavailable at topology_as_of'
      using errcode = '55000';
  end if;

  with
  tenant_relationship_targets as (
    select r.id::text as target_id, r.property_id::text as property_id
    from public.organization_property_relationships r
    where r.organization_id = p_organization_id
    union
    select e.target_id, state.value->>'property_id'
    from public.organization_access_events e
    cross join lateral (values (e.before_state), (e.after_state)) state(value)
    where e.target_type = 'organization_property_relationships'
      and e.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and state.value is not null
      and state.value->>'organization_id' = p_organization_id::text
      and state.value->>'property_id' is not null
  ),
  tenant_property_targets as (
    select distinct target.property_id
    from tenant_relationship_targets target
  ),
  relationship_targets as (
    select r.id::text as target_id
    from public.organization_property_relationships r
    join tenant_property_targets target on target.property_id = r.property_id::text
    union
    select e.target_id
    from public.organization_access_events e
    where e.target_type = 'organization_property_relationships'
      and e.target_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and exists (
        select 1 from tenant_property_targets target
        where target.property_id = e.before_state->>'property_id'
           or target.property_id = e.after_state->>'property_id'
      )
  ),
  relationship_state_receipts as (
    select
      target.target_id::uuid as id,
      chosen.state,
      chosen.proof_kind,
      chosen.proof_at
    from relationship_targets target
    cross join lateral (
      select option.state, option.proof_kind, option.proof_at
      from (
        (
          select to_jsonb(current_row) as state, 'unchanged_current_row'::text as proof_kind,
            current_row.updated_at as proof_at, 1 as priority
          from public.organization_property_relationships current_row
          where current_row.id::text = target.target_id
            and current_row.created_at <= p_topology_as_of
            and current_row.updated_at <= p_topology_as_of
        )
        union all
        (
          select e.after_state as state, 'event_at_or_before'::text as proof_kind,
            e.occurred_at as proof_at, 2 as priority
          from public.organization_access_events e
          where e.target_type = 'organization_property_relationships'
            and e.target_id = target.target_id
            and e.occurred_at <= p_topology_as_of
          order by e.occurred_at desc, e.id desc
          limit 1
        )
        union all
        (
          select e.before_state as state, 'event_after_before_state'::text,
            e.occurred_at, 3
          from public.organization_access_events e
          where e.target_type = 'organization_property_relationships'
            and e.target_id = target.target_id
            and e.occurred_at > p_topology_as_of
          order by e.occurred_at, e.id
          limit 1
        )
      ) option
      order by option.priority
      limit 1
    ) chosen
  ),
  relationship_base as (
    select
      receipt.id,
      (receipt.state->>'organization_id')::uuid as organization_id,
      (receipt.state->>'property_id')::uuid as property_id,
      receipt.state->>'relationship_type' as relationship_type,
      (receipt.state->>'is_primary_grouping')::boolean as is_primary_grouping,
      (receipt.state->>'starts_at')::timestamptz as starts_at,
      nullif(receipt.state->>'ends_at', '')::timestamptz as ends_at,
      (receipt.state->>'created_at')::timestamptz as created_at,
      (receipt.state->>'updated_at')::timestamptz as updated_at,
      receipt.proof_kind as history_proof_kind,
      receipt.proof_at as history_proof_at
    from relationship_state_receipts receipt
    where receipt.state is not null
      and (receipt.state->>'is_primary_grouping')::boolean
      and receipt.state->>'relationship_type' in ('operator', 'owner')
      and (receipt.state->>'starts_at')::timestamptz <= p_topology_as_of
      and (
        nullif(receipt.state->>'ends_at', '') is null
        or (receipt.state->>'ends_at')::timestamptz > p_topology_as_of
      )
  ),
  relationship_counts as (
    select
      r.*,
      count(*) over (partition by r.organization_id, r.property_id)::integer
        as organization_relationship_count,
      count(*) over (partition by r.property_id)::integer as global_relationship_count
    from relationship_base r
  ),
  organization_relationships as (
    select
      r.*,
      row_number() over (
        partition by r.property_id
        order by r.starts_at desc, r.id
      ) as relationship_rank
    from relationship_counts r
    where r.organization_id = p_organization_id
  ),
  governed as (
    select
      r.id as relationship_id,
      r.property_id,
      r.relationship_type,
      r.starts_at as relationship_starts_at,
      r.ends_at as relationship_ends_at,
      r.history_proof_kind as relationship_history_proof_kind,
      r.history_proof_at as relationship_history_proof_at,
      r.organization_relationship_count,
      r.global_relationship_count
    from organization_relationships r
    where r.relationship_rank = 1
  ),
  governed_source_access as (
    select
      g.*,
      transition.membership_loss_at as audited_membership_loss_at,
      transition.proof_at as audited_membership_loss_proof_at,
      transition.proof_kind as audited_membership_loss_proof_kind,
      case
        when g.relationship_ends_at is not null
          and g.relationship_ends_at <= p_source_as_of
          and (
            transition.membership_loss_at is null
            or g.relationship_ends_at <= transition.membership_loss_at
          ) then g.relationship_ends_at
        when transition.membership_loss_at is not null
          and transition.membership_loss_at <= p_source_as_of
          then transition.membership_loss_at
        else p_source_as_of
      end as effective_source_cutoff,
      case
        when g.relationship_ends_at is not null
          and g.relationship_ends_at <= p_source_as_of
          and (
            transition.membership_loss_at is null
            or g.relationship_ends_at <= transition.membership_loss_at
          ) then true
        when transition.membership_loss_at is not null
          and transition.membership_loss_at <= p_source_as_of then true
        else false
      end as effective_source_cutoff_is_exclusive,
      case
        when g.relationship_ends_at is not null
          and g.relationship_ends_at <= p_source_as_of
          and (
            transition.membership_loss_at is null
            or g.relationship_ends_at <= transition.membership_loss_at
          ) then 'relationship_interval_end'
        when transition.membership_loss_at is not null
          and transition.membership_loss_at <= p_source_as_of
          then 'audited_membership_loss'
        else 'requested_source_as_of'
      end as effective_source_cutoff_reason,
      case
        when g.relationship_ends_at is not null
          and g.relationship_ends_at <= p_source_as_of
          and (
            transition.membership_loss_at is null
            or g.relationship_ends_at <= transition.membership_loss_at
          ) then 'relationship_state'
        when transition.membership_loss_at is not null
          and transition.membership_loss_at <= p_source_as_of
          then transition.proof_kind
        else 'request'
      end as effective_source_cutoff_proof_kind,
      case
        when g.relationship_ends_at is not null
          and g.relationship_ends_at <= p_source_as_of
          and (
            transition.membership_loss_at is null
            or g.relationship_ends_at <= transition.membership_loss_at
          ) then g.relationship_history_proof_at
        when transition.membership_loss_at is not null
          and transition.membership_loss_at <= p_source_as_of
          then transition.proof_at
        else p_source_as_of
      end as effective_source_cutoff_proof_at
    from governed g
    left join lateral (
      select candidate.membership_loss_at, candidate.proof_at, candidate.proof_kind
      from (
        select
          e.id::text as proof_id,
          e.occurred_at as proof_at,
          'organization_access_event'::text as proof_kind,
          case
            when e.after_state is null
              or e.after_state->>'organization_id' is distinct from p_organization_id::text
              or e.after_state->>'property_id' is distinct from g.property_id::text
              or coalesce((e.after_state->>'is_primary_grouping')::boolean, false) is false
              or coalesce(e.after_state->>'relationship_type', '')
                not in ('operator','owner')
              or nullif(e.after_state->>'starts_at', '') is null
              or (e.after_state->>'starts_at')::timestamptz > e.occurred_at
              then e.occurred_at
            when nullif(e.after_state->>'ends_at', '') is not null
              then (e.after_state->>'ends_at')::timestamptz
            else null::timestamptz
          end as membership_loss_at
        from public.organization_access_events e
        where e.target_type = 'organization_property_relationships'
          and e.target_id = g.relationship_id::text
          and e.occurred_at > p_topology_as_of
        union all
        select
          e.id::text,
          e.occurred_at,
          'organization_access_event'::text,
          (e.after_state->>'starts_at')::timestamptz
        from public.organization_access_events e
        where e.target_type = 'organization_property_relationships'
          and e.target_id is distinct from g.relationship_id::text
          and e.occurred_at > p_topology_as_of
          and e.after_state is not null
          and e.after_state->>'property_id' = g.property_id::text
          and e.after_state->>'organization_id' is distinct from p_organization_id::text
          and coalesce((e.after_state->>'is_primary_grouping')::boolean, false)
          and e.after_state->>'relationship_type' in ('operator','owner')
          and nullif(e.after_state->>'starts_at', '') is not null
          and (
            nullif(e.after_state->>'ends_at', '') is null
            or (e.after_state->>'ends_at')::timestamptz > p_topology_as_of
          )
        union all
        select
          other.id::text,
          other.created_at,
          'relationship_state'::text,
          other.starts_at
        from public.organization_property_relationships other
        where other.id <> g.relationship_id
          and other.property_id = g.property_id
          and other.organization_id <> p_organization_id
          and other.is_primary_grouping
          and other.relationship_type in ('operator','owner')
          and (
            other.starts_at > p_topology_as_of
            or other.created_at > p_topology_as_of
          )
          and (other.ends_at is null or other.ends_at > p_topology_as_of)
      ) candidate
      where candidate.membership_loss_at is not null
      order by candidate.membership_loss_at, candidate.proof_at, candidate.proof_id
      limit 1
    ) transition on true
  ),
  property_current as (
    select
      g.*,
      case
        when p.updated_at <= p_topology_as_of then p.name
        -- properties has no immutable history ledger.  Keep the historical
        -- hotel in scope, but never expose a post-cutoff rename to the former
        -- governing company during a backfill.
        else 'Historical property ' || left(p.id::text, 8)
      end as property_name,
      p.total_rooms,
      nullif(btrim(p.timezone), '') as property_timezone,
      p.business_date_cutoff_hour as property_business_date_cutoff_hour,
      p.property_kind,
      p.brand,
      p.region as property_region,
      p.updated_at as property_updated_at
    from governed_source_access g
    join public.properties p on p.id = g.property_id
  ),
  resolved as (
    select
      pc.*,
      prof.id as profile_id,
      prof.profile_version,
      prof.effective_from as profile_effective_from,
      prof.effective_to as profile_effective_to,
      prof.source_kind as profile_source_kind,
      prof.source_reference as profile_source_reference,
      prof.created_at as profile_created_at,
      coalesce(
        prof.room_count,
        case when pc.property_updated_at <= p_topology_as_of then nullif(pc.total_rooms, 0) end
      ) as resolved_room_count,
      coalesce(
        prof.timezone_name,
        case when pc.property_updated_at <= p_topology_as_of then pc.property_timezone end
      ) as resolved_timezone,
      coalesce(
        prof.business_date_cutoff_hour,
        case when pc.property_updated_at <= p_topology_as_of
          then pc.property_business_date_cutoff_hour end
      ) as resolved_cutoff_hour,
      -- properties.property_kind was historically backfilled with a default;
      -- it is not proof of a fair-comparison service level. Only a versioned
      -- profile may supply this non-relaxable cohort dimension.
      prof.service_level as resolved_service_level,
      prof.market_type,
      prof.brand_class,
      prof.location_type,
      prof.operating_model,
      prof.amenity_tags,
      prof.currency_code,
      prof.currency_minor_unit_exponent,
      prof.comparison_attributes,
      exists (
        select 1 from pg_catalog.pg_timezone_names tz
        where tz.name = coalesce(
          prof.timezone_name,
          case when pc.property_updated_at <= p_topology_as_of then pc.property_timezone end
        )
      ) as timezone_valid
    from property_current pc
    left join lateral public.management_pattern_profile_at_v1(
      p_organization_id,
      pc.property_id,
      pc.relationship_id,
      p_topology_as_of,
      p_source_as_of
    ) prof on true
  ),
  resolved_windows as (
    select
      r.*,
      case when r.timezone_valid then r.resolved_timezone end as query_timezone,
      p_supply_window_start as inventory_window_start_date,
      p_supply_window_end as inventory_window_end_date,
      p_supply_window_start as occupancy_window_start_date,
      p_supply_window_end as occupancy_window_end_date,
      case when r.timezone_valid then
        p_supply_window_start::timestamp at time zone r.resolved_timezone
      end as inventory_window_start_utc,
      case when r.timezone_valid then
        (p_supply_window_end + 1)::timestamp at time zone r.resolved_timezone
      end as inventory_window_end_utc,
      case when r.timezone_valid and r.resolved_cutoff_hour is not null then
        (p_supply_window_start::timestamp
          + r.resolved_cutoff_hour * interval '1 hour')
          at time zone r.resolved_timezone
      end as occupancy_window_start_utc,
      case when r.timezone_valid and r.resolved_cutoff_hour is not null then
        ((p_supply_window_end + 1)::timestamp
          + r.resolved_cutoff_hour * interval '1 hour')
          at time zone r.resolved_timezone
      end as occupancy_window_end_utc
    from resolved r
  ),
  portfolio_size as (
    select count(*)::integer as property_count from resolved_windows
  ),
  activity_bounds as (
    select
      min(
        ((p_topology_as_of at time zone r.query_timezone)
          - (r.resolved_cutoff_hour * interval '1 hour'))::date - 1
      ) as end_date
    from resolved_windows r, portfolio_size ps
    where r.timezone_valid
      and r.resolved_cutoff_hour is not null
      and r.organization_relationship_count = 1
      and r.global_relationship_count = 1
      and ps.property_count <= p_max_properties
  ),
  group_rows as (
    select
      pp.property_id,
      jsonb_agg(
        jsonb_build_object(
          'group_id', pf.id,
          'name', pf.name,
          'kind', case
            when pf.portfolio_type = 'region' then 'region'
            when pf.portfolio_type in ('portfolio', 'division') then 'portfolio'
            else 'operating_group'
          end,
          'portfolio_type', pf.portfolio_type,
          'parent_id', pf.parent_id,
          'group_updated_at', pf.updated_at,
          'assigned_at', pp.assigned_at,
          'removed_at', pp.removed_at,
          'assignment_updated_at', pp.updated_at
        ) order by pf.portfolio_type, pf.id
      ) as groups
    from public.portfolio_properties pp
    join public.portfolios pf
      on pf.id = pp.portfolio_id
     and pf.organization_id = pp.organization_id
    join resolved_windows r
      on r.property_id = pp.property_id
     and r.relationship_id = pp.property_relationship_id
    where pp.organization_id = p_organization_id
      and pp.assigned_at <= p_topology_as_of
      and (pp.removed_at is null or pp.removed_at > p_topology_as_of)
      and pp.created_at <= p_topology_as_of
      and pp.updated_at <= p_topology_as_of
      and pf.status = 'active'
      and pf.created_at <= p_topology_as_of
      and pf.updated_at <= p_topology_as_of
    group by pp.property_id
  ),
  portfolio_assignment_history_refs as (
    select pp.organization_id, pp.portfolio_id, pp.property_id,
      pp.property_relationship_id
    from public.portfolio_properties pp
    where pp.organization_id = p_organization_id
    union
    select
      (state.value->>'organization_id')::uuid,
      (state.value->>'portfolio_id')::uuid,
      (state.value->>'property_id')::uuid,
      (state.value->>'property_relationship_id')::uuid
    from public.organization_access_events event_row
    cross join lateral (
      values (event_row.before_state), (event_row.after_state)
    ) state(value)
    where event_row.target_type = 'portfolio_properties'
      and state.value is not null
      and state.value->>'organization_id' = p_organization_id::text
  ),
  group_history_issues as (
    -- Group tables are mutable, not temporal. A row that changed after the
    -- topology cutoff cannot be reconstructed and therefore cannot support
    -- region/group scope, even if its current values look applicable.
    select distinct pp.property_id
    from public.portfolio_properties pp
    join public.portfolios pf
      on pf.id = pp.portfolio_id and pf.organization_id = pp.organization_id
    join resolved_windows r
      on r.property_id = pp.property_id
     and r.relationship_id = pp.property_relationship_id
    where pp.organization_id = p_organization_id
      and pp.assigned_at <= p_topology_as_of
      and (pp.removed_at is null or pp.removed_at > p_topology_as_of)
      and (
        pp.created_at > p_topology_as_of
        or pp.updated_at > p_topology_as_of
        or pf.created_at > p_topology_as_of
        or pf.updated_at > p_topology_as_of
      )
    union
    select distinct (coalesce(e.before_state, e.after_state)->>'property_id')::uuid
    from public.organization_access_events e
    where e.target_type = 'portfolio_properties'
      and e.occurred_at > p_topology_as_of
      and coalesce(e.before_state, e.after_state)->>'organization_id'
        = p_organization_id::text
      and coalesce(e.before_state, e.after_state)->>'property_id' is not null
    union
    select distinct assignment.property_id
    from public.organization_access_events e
    join portfolio_assignment_history_refs assignment
      on assignment.organization_id = p_organization_id
     and assignment.portfolio_id::text = e.target_id
    where e.target_type = 'portfolios'
      and e.occurred_at > p_topology_as_of
      and (
        e.organization_id = p_organization_id
        or e.before_state->>'organization_id' = p_organization_id::text
        or e.after_state->>'organization_id' = p_organization_id::text
      )
  ),
  supply_close_rows as (
    select
      c.property_id,
      c.id,
      c.month_start,
      c.timezone,
      c.status,
      c.month_start_at,
      c.end_at,
      c.is_partial,
      c.purchase_source,
      c.allocation_mode,
      c.confirmed_purchase_cents,
      c.logged_purchase_cents,
      c.manual_purchase_cents,
      c.logged_delivery_count,
      c.uncosted_delivery_count,
      case when pg_column_size(c.quality_flags) <= 16384 then c.quality_flags end as quality_flags,
      (pg_column_size(c.quality_flags) > 16384) as quality_flags_oversize,
      (
        c.timezone = r.resolved_timezone
        and c.month_start_at = c.month_start::timestamp at time zone r.query_timezone
        and c.end_at = (c.month_start + interval '1 month')::timestamp
          at time zone r.query_timezone
      ) as source_window_compatible,
      c.closed_at,
      c.created_at,
      c.updated_at
    from public.inventory_month_closes c
    join resolved_windows r on r.property_id = c.property_id
    cross join portfolio_size ps
    where ps.property_count <= p_max_properties
      and r.organization_relationship_count = 1
      and r.global_relationship_count = 1
      and r.timezone_valid
      and r.relationship_starts_at <= r.inventory_window_start_utc
      and (
        r.relationship_ends_at is null
        or r.relationship_ends_at >= r.inventory_window_end_utc
      )
      and r.relationship_starts_at <= c.month_start_at
      and (r.relationship_ends_at is null or c.end_at <= r.relationship_ends_at)
      and c.month_start >= p_supply_window_start
      and c.month_start <= p_supply_window_end
      -- The header is mutable while open. If it changed after the requested
      -- as-of instant there is no version from which to reconstruct its prior
      -- state, so historical evaluation must treat it as unavailable.
      and c.created_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or c.created_at < r.effective_source_cutoff)
      and c.updated_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or c.updated_at < r.effective_source_cutoff)
      and (
        c.closed_at is null
        or (
          c.closed_at <= r.effective_source_cutoff
          and (not r.effective_source_cutoff_is_exclusive
            or c.closed_at < r.effective_source_cutoff)
        )
      )
  ),
  supply_by_property as (
    select
      c.property_id,
      count(*)::integer as observed_periods,
      count(*) filter (where not c.source_window_compatible)::integer
        as incompatible_periods,
      count(*) filter (where c.quality_flags_oversize)::integer
        as oversized_quality_periods,
      count(*) filter (
        where c.status = 'closed'
          and not c.is_partial
          and c.source_window_compatible
          and not c.quality_flags_oversize
          and c.confirmed_purchase_cents is not null
          and c.closed_at is not null
      )::integer as usable_periods,
      sum(c.confirmed_purchase_cents) filter (
        where c.status = 'closed'
          and not c.is_partial
          and c.source_window_compatible
          and not c.quality_flags_oversize
          and c.confirmed_purchase_cents is not null
          and c.closed_at is not null
      ) as confirmed_purchase_storage_cents,
      max(c.closed_at) as fresh_through,
      jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'month_start', c.month_start,
          'timezone', c.timezone,
          'status', c.status,
          'month_start_at', c.month_start_at,
          'end_at', c.end_at,
          'is_partial', c.is_partial,
          'purchase_source', c.purchase_source,
          'allocation_mode', c.allocation_mode,
          'confirmed_purchase_storage_cents', c.confirmed_purchase_cents,
          'logged_purchase_storage_cents', c.logged_purchase_cents,
          'manual_purchase_storage_cents', c.manual_purchase_cents,
          'logged_delivery_count', c.logged_delivery_count,
          'uncosted_delivery_count', c.uncosted_delivery_count,
          'quality_flags', c.quality_flags,
          'quality_flags_oversize', c.quality_flags_oversize,
          'source_window_compatible', c.source_window_compatible,
          'closed_at', c.closed_at,
          'created_at', c.created_at,
          'updated_at', c.updated_at
        ) order by c.month_start
      ) as periods
    from supply_close_rows c
    group by c.property_id
  ),
  room_sold_rows as (
    select
      d.property_id,
      d.date,
      d.rooms_sold,
      d.occupancy_source,
      d.sealed_at,
      d.seal_version,
      case when pg_column_size(d.source_completeness) <= 16384
        then d.source_completeness end as source_completeness,
      coalesce(pg_column_size(d.source_completeness) > 16384, false)
        as source_completeness_oversize,
      d.created_at,
      d.updated_at,
      coalesce((
        d.rooms_sold is not null
        and d.rooms_sold >= 0
        and d.occupancy_source in ('pms_report', 'operator')
        and pg_column_size(d.source_completeness) <= 16384
        and (
          d.source_completeness->>'occupancy_complete' = 'true'
          or d.source_completeness->'buckets'->>'occupancy'
            in ('pms_report','operator','complete')
        )
      ), false) as denominator_complete
    from public.daily_logs d
    join resolved_windows r on r.property_id = d.property_id
    cross join portfolio_size ps
    where ps.property_count <= p_max_properties
      and r.organization_relationship_count = 1
      and r.global_relationship_count = 1
      and r.timezone_valid
      and r.resolved_cutoff_hour is not null
      and d.date between p_supply_window_start and p_supply_window_end
      and r.relationship_starts_at <= (
        (d.date::timestamp + r.resolved_cutoff_hour * interval '1 hour')
          at time zone r.query_timezone
      )
      and (
        r.relationship_ends_at is null
        or r.relationship_ends_at >= (
          ((d.date + 1)::timestamp + r.resolved_cutoff_hour * interval '1 hour')
            at time zone r.query_timezone
        )
      )
      and d.sealed_at is not null
      and d.created_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or d.created_at < r.effective_source_cutoff)
      and d.sealed_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or d.sealed_at < r.effective_source_cutoff)
      and d.updated_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or d.updated_at < r.effective_source_cutoff)
  ),
  rooms_by_property as (
    select
      d.property_id,
      count(*)::integer as sealed_days,
      count(*) filter (
        where d.denominator_complete
      )::integer as observed_days,
      sum(d.rooms_sold) filter (
        where d.denominator_complete
      ) as room_nights_sold,
      count(*) filter (
        where d.rooms_sold is not null
          and d.rooms_sold >= 0
          and d.occupancy_source in ('pms_report', 'operator')
          and not d.denominator_complete
      )::integer as partial_days,
      max(d.updated_at) as fresh_through,
      jsonb_agg(
        jsonb_build_object(
          'date', d.date,
          'rooms_sold', d.rooms_sold,
          'occupancy_source', d.occupancy_source,
          'sealed_at', d.sealed_at,
          'seal_version', d.seal_version,
          'source_completeness', d.source_completeness,
          'source_completeness_oversize', d.source_completeness_oversize,
          'denominator_complete', d.denominator_complete,
          'created_at', d.created_at,
          'updated_at', d.updated_at
        ) order by d.date
      ) as days
    from room_sold_rows d
    group by d.property_id
  ),
  inventory_activity as (
    select
      i.property_id,
      array_agg(distinct (
        ((i.counted_at at time zone r.query_timezone)
          - r.resolved_cutoff_hour * interval '1 hour')::date
      )::text order by (
        ((i.counted_at at time zone r.query_timezone)
          - r.resolved_cutoff_hour * interval '1 hour')::date
      )::text) as event_dates,
      count(distinct coalesce(
        i.count_session_id::text,
        'legacy-date:' || (
          ((i.counted_at at time zone r.query_timezone)
            - r.resolved_cutoff_hour * interval '1 hour')::date
        )::text
      ))::integer as source_event_count,
      max(i.created_at) as source_revision_at
    from public.inventory_counts i
    join resolved_windows r on r.property_id = i.property_id
    cross join portfolio_size ps
    cross join activity_bounds b
    where ps.property_count <= p_max_properties
      and b.end_date is not null
      and r.organization_relationship_count = 1
      and r.global_relationship_count = 1
      and r.timezone_valid
      and r.resolved_cutoff_hour is not null
      and i.created_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or i.created_at < r.effective_source_cutoff)
      and i.counted_at >= r.relationship_starts_at
      and (r.relationship_ends_at is null or i.counted_at < r.relationship_ends_at)
      and i.counted_at >= (
        (b.end_date - (p_activity_history_days - 1))::timestamp
          + r.resolved_cutoff_hour * interval '1 hour'
      ) at time zone r.query_timezone
      and i.counted_at < (
        (b.end_date + 1)::timestamp
          + r.resolved_cutoff_hour * interval '1 hour'
      ) at time zone r.query_timezone
    group by i.property_id
  ),
  daily_log_activity as (
    select
      d.property_id,
      array_agg(d.date::text order by d.date) as event_dates,
      count(*)::integer as source_event_count,
      max(d.sealed_at) as source_revision_at
    from public.daily_logs d
    join resolved_windows r on r.property_id = d.property_id
    cross join portfolio_size ps
    cross join activity_bounds b
    where ps.property_count <= p_max_properties
      and b.end_date is not null
      and r.organization_relationship_count = 1
      and r.global_relationship_count = 1
      and r.timezone_valid
      and r.resolved_cutoff_hour is not null
      and d.date between b.end_date - (p_activity_history_days - 1) and b.end_date
      and r.relationship_starts_at <= (
        (d.date::timestamp + r.resolved_cutoff_hour * interval '1 hour')
          at time zone r.query_timezone
      )
      and (
        r.relationship_ends_at is null
        or r.relationship_ends_at >= (
          ((d.date + 1)::timestamp + r.resolved_cutoff_hour * interval '1 hour')
            at time zone r.query_timezone
        )
      )
      and d.sealed_at is not null
      and d.created_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or d.created_at < r.effective_source_cutoff)
      and d.sealed_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or d.sealed_at < r.effective_source_cutoff)
      and d.updated_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or d.updated_at < r.effective_source_cutoff)
    group by d.property_id
  ),
  work_order_activity as (
    select
      w.property_id,
      array_agg(distinct (
        ((w.created_at at time zone r.query_timezone)
          - r.resolved_cutoff_hour * interval '1 hour')::date
      )::text order by (
        ((w.created_at at time zone r.query_timezone)
          - r.resolved_cutoff_hour * interval '1 hour')::date
      )::text) as event_dates,
      count(*)::integer as source_event_count,
      -- updated_at is mutable and has no revision history. Rows changed after
      -- source_as_of are excluded; created_at is the only immutable watermark
      -- this schema can honestly expose.
      max(w.created_at) as source_revision_at
    from public.work_orders w
    join resolved_windows r on r.property_id = w.property_id
    cross join portfolio_size ps
    cross join activity_bounds b
    where ps.property_count <= p_max_properties
      and b.end_date is not null
      and r.organization_relationship_count = 1
      and r.global_relationship_count = 1
      and r.timezone_valid
      and r.resolved_cutoff_hour is not null
      and w.created_at is not null
      and w.created_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or w.created_at < r.effective_source_cutoff)
      and w.updated_at <= r.effective_source_cutoff
      and (not r.effective_source_cutoff_is_exclusive
        or w.updated_at < r.effective_source_cutoff)
      and w.created_at >= r.relationship_starts_at
      and (r.relationship_ends_at is null or w.created_at < r.relationship_ends_at)
      and w.created_at >= (
        (b.end_date - (p_activity_history_days - 1))::timestamp
          + r.resolved_cutoff_hour * interval '1 hour'
      ) at time zone r.query_timezone
      and w.created_at < (
        (b.end_date + 1)::timestamp
          + r.resolved_cutoff_hour * interval '1 hour'
      ) at time zone r.query_timezone
    group by w.property_id
  ),
  property_quality as (
    select
      r.*,
      b.end_date as activity_end_date,
      case when r.timezone_valid and r.resolved_cutoff_hour is not null
        and b.end_date is not null then
        ((b.end_date - (p_activity_history_days - 1))::timestamp
          + r.resolved_cutoff_hour * interval '1 hour')
          at time zone r.query_timezone
      end as activity_window_start_utc,
      case when r.timezone_valid and r.resolved_cutoff_hour is not null
        and b.end_date is not null then
        ((b.end_date + 1)::timestamp
          + r.resolved_cutoff_hour * interval '1 hour')
          at time zone r.query_timezone
      end as activity_window_end_utc,
      coalesce(
        r.timezone_valid
        and r.relationship_starts_at <= r.inventory_window_start_utc
        and (r.relationship_ends_at is null
          or r.relationship_ends_at >= r.inventory_window_end_utc),
        false
      ) as relationship_covers_inventory_window,
      coalesce(
        r.timezone_valid
        and r.relationship_starts_at <= r.occupancy_window_start_utc
        and (r.relationship_ends_at is null
          or r.relationship_ends_at >= r.occupancy_window_end_utc),
        false
      ) as relationship_covers_occupancy_window,
      coalesce(
        r.timezone_valid
        and r.profile_id is not null
        and r.profile_effective_from <= least(
          r.inventory_window_start_utc, r.occupancy_window_start_utc
        )
        and (
          r.profile_effective_to is null
          or r.profile_effective_to >= greatest(
            r.inventory_window_end_utc, r.occupancy_window_end_utc
          )
        ),
        false
      ) as profile_covers_supply_windows,
      coalesce(
        r.timezone_valid
        and r.inventory_window_start_date = r.occupancy_window_start_date
        and r.inventory_window_end_date = r.occupancy_window_end_date
        and r.query_timezone = r.resolved_timezone
        and r.inventory_window_start_utc is not null
        and r.inventory_window_end_utc is not null
        and r.occupancy_window_start_utc is not null
        and r.occupancy_window_end_utc is not null,
        false
      ) as normalization_windows_align,
      coalesce(
        r.organization_relationship_count = 1
        and r.global_relationship_count = 1
        and r.timezone_valid
        and r.resolved_cutoff_hour is not null
        and r.property_updated_at <= p_topology_as_of
        and b.end_date is not null,
        false
      ) as activity_query_prerequisites_met,
      coalesce(pg_column_size(r.comparison_attributes) > 65536, false)
        as comparison_attributes_oversize,
      coalesce(cardinality(r.amenity_tags) > 100, false) as amenity_tags_oversize
    from resolved_windows r
    cross join activity_bounds b
  ),
  property_payloads as (
    select
      r.property_id,
      jsonb_build_object(
        'property_id', r.property_id,
        'property_name', r.property_name,
        'relationship', jsonb_build_object(
          'id', r.relationship_id,
          'relationship_type', r.relationship_type,
          'starts_at', r.relationship_starts_at,
          'ends_at', r.relationship_ends_at,
          'history_proof_kind', r.relationship_history_proof_kind,
          'history_proof_at', r.relationship_history_proof_at,
          'organization_active_count', r.organization_relationship_count,
          'exclusive_governing_relationship', r.global_relationship_count = 1,
          'source_access', jsonb_build_object(
            'effective_source_cutoff', r.effective_source_cutoff,
            'effective_source_cutoff_is_exclusive',
              r.effective_source_cutoff_is_exclusive,
            'effective_source_cutoff_reason', r.effective_source_cutoff_reason,
            'effective_source_cutoff_proof_kind',
              r.effective_source_cutoff_proof_kind,
            'effective_source_cutoff_proof_at',
              r.effective_source_cutoff_proof_at
          )
        ),
        'property_source', jsonb_build_object(
          'updated_at', r.property_updated_at,
          'total_rooms', case when r.property_updated_at <= p_topology_as_of
            then r.total_rooms end,
          'timezone', case when r.property_updated_at <= p_topology_as_of
            then r.property_timezone end,
          'business_date_cutoff_hour', case when r.property_updated_at <= p_topology_as_of
            then r.property_business_date_cutoff_hour end,
          'property_kind', case when r.property_updated_at <= p_topology_as_of
            then r.property_kind end,
          'brand', case when r.property_updated_at <= p_topology_as_of
            then r.brand end,
          'region', case when r.property_updated_at <= p_topology_as_of
            then r.property_region end
        ),
        'profile', jsonb_build_object(
          'id', r.profile_id,
          'profile_version', r.profile_version,
          'effective_from', r.profile_effective_from,
          'effective_to', r.profile_effective_to,
          'source_kind', r.profile_source_kind,
          'source_reference', r.profile_source_reference,
          'created_at', r.profile_created_at,
          'room_count', r.resolved_room_count,
          'timezone', r.resolved_timezone,
          'business_date_cutoff_hour', r.resolved_cutoff_hour,
          'service_level', r.resolved_service_level,
          'market_type', r.market_type,
          'brand_class', r.brand_class,
          'location_type', r.location_type,
          'operating_model', r.operating_model,
          -- Preserve unknown (null) separately from a verified empty set. The
          -- cohort matcher must never turn missing comparison evidence into a
          -- universal empty-tag match.
          'amenity_tags', case when r.amenity_tags_oversize then null
            else to_jsonb(r.amenity_tags) end,
          'currency_code', r.currency_code,
          'currency_minor_unit_exponent', r.currency_minor_unit_exponent,
          'comparison_attributes', case when r.comparison_attributes_oversize then null
            else r.comparison_attributes end
        ),
        'groups', case when ghi.property_id is null
          then coalesce(gr.groups, '[]'::jsonb) else '[]'::jsonb end,
        'group_scope_historically_reconstructable', ghi.property_id is null,
        'group_scope_exclusion_codes', case when ghi.property_id is null
          then '[]'::jsonb else jsonb_build_array('group_history_unavailable') end,
        'windows', jsonb_build_object(
          'supply_inventory', jsonb_build_object(
            'start_date', p_supply_window_start,
            'end_date', p_supply_window_end,
            'timezone', r.resolved_timezone,
            'date_basis', 'property_local_calendar_month',
            'business_date_cutoff_hour', 0,
            'start_utc', r.inventory_window_start_utc,
            'end_utc', r.inventory_window_end_utc
          ),
          'supply_occupancy', jsonb_build_object(
            'start_date', p_supply_window_start,
            'end_date', p_supply_window_end,
            'timezone', r.resolved_timezone,
            'date_basis', 'property_business_date',
            'business_date_cutoff_hour', r.resolved_cutoff_hour,
            'start_utc', r.occupancy_window_start_utc,
            'end_utc', r.occupancy_window_end_utc
          ),
          'activity', jsonb_build_object(
            'start_date', r.activity_end_date - (p_activity_history_days - 1),
            'end_date', r.activity_end_date,
            'timezone', r.resolved_timezone,
            'business_date_cutoff_hour', r.resolved_cutoff_hour,
            'start_utc', r.activity_window_start_utc,
            'end_utc', r.activity_window_end_utc
          )
        ),
        'run_exclusion_codes', to_jsonb(array_remove(array[
          case when r.organization_relationship_count <> 1 or r.global_relationship_count <> 1
            then 'topology_ambiguous' end,
          case when not r.timezone_valid then 'timezone_missing_or_invalid' end,
          case when r.property_updated_at > p_topology_as_of
            then 'property_metadata_not_historical' end,
          case when ps.property_count > p_max_properties then 'portfolio_property_budget_exceeded' end
        ]::text[], null)),
        'supply', jsonb_build_object(
          'query_id', 'management_pattern_inventory_month_closes',
          'query_version', 'management-pattern-source-snapshot.v1',
          'query_executed', true,
          'exclusion_codes', to_jsonb(array_remove(array[
            case when not r.relationship_covers_inventory_window
              then 'relationship_does_not_cover_inventory_window' end,
            case when r.resolved_cutoff_hour is null
              then 'business_date_cutoff_missing' end,
            case when not r.profile_covers_supply_windows
              then 'profile_does_not_cover_supply_windows' end,
            case when not r.normalization_windows_align
              then 'denominator_window_mismatch' end,
            case when r.amenity_tags_oversize then 'profile_amenity_tags_oversize' end,
            case when r.comparison_attributes_oversize
              then 'profile_comparison_attributes_oversize' end,
            case when coalesce(sb.incompatible_periods, 0) > 0
              then 'inventory_close_window_incompatible' end,
            case when coalesce(sb.oversized_quality_periods, 0) > 0
              then 'inventory_quality_payload_oversize' end,
            case when r.effective_source_cutoff_reason <> 'requested_source_as_of'
              then 'relationship_source_access_limited' end
          ]::text[], null)),
          'relationship_covers_inventory_window', r.relationship_covers_inventory_window,
          'profile_covers_inventory_and_occupancy_windows', r.profile_covers_supply_windows,
          'expected_periods', (
            extract(year from age(p_supply_window_end + 1, p_supply_window_start)) * 12
            + extract(month from age(p_supply_window_end + 1, p_supply_window_start))
          )::integer,
          'observed_periods', coalesce(sb.observed_periods, 0),
          'usable_periods', coalesce(sb.usable_periods, 0),
          'incompatible_periods', coalesce(sb.incompatible_periods, 0),
          'oversized_quality_periods', coalesce(sb.oversized_quality_periods, 0),
          'confirmed_purchase_storage_cents', sb.confirmed_purchase_storage_cents,
          'fresh_through', sb.fresh_through,
          'source_watermark', jsonb_build_object(
            'max_closed_at', sb.fresh_through,
            'source_as_of', r.effective_source_cutoff,
            'requested_source_as_of', p_source_as_of,
            'effective_source_cutoff', r.effective_source_cutoff,
            'effective_source_cutoff_is_exclusive',
              r.effective_source_cutoff_is_exclusive,
            'effective_source_cutoff_reason', r.effective_source_cutoff_reason,
            'effective_source_cutoff_proof_kind',
              r.effective_source_cutoff_proof_kind,
            'effective_source_cutoff_proof_at',
              r.effective_source_cutoff_proof_at
          ),
          'periods', coalesce(sb.periods, '[]'::jsonb)
        ),
        'rooms_sold', jsonb_build_object(
          'query_id', 'management_pattern_daily_log_occupancy',
          'query_version', 'management-pattern-source-snapshot.v1',
          'query_executed', true,
          'exclusion_codes', to_jsonb(array_remove(array[
            case when not r.relationship_covers_occupancy_window
              then 'relationship_does_not_cover_occupancy_window' end,
            case when r.resolved_cutoff_hour is null
              then 'business_date_cutoff_missing' end,
            case when not r.profile_covers_supply_windows
              then 'profile_does_not_cover_supply_windows' end,
            case when not r.normalization_windows_align
              then 'denominator_window_mismatch' end,
            case when r.effective_source_cutoff_reason <> 'requested_source_as_of'
              then 'relationship_source_access_limited' end
          ]::text[], null)),
          'relationship_covers_occupancy_window', r.relationship_covers_occupancy_window,
          'expected_days', (p_supply_window_end - p_supply_window_start + 1),
          'sealed_days', coalesce(rb.sealed_days, 0),
          'observed_days', coalesce(rb.observed_days, 0),
          'partial_days', coalesce(rb.partial_days, 0),
          'room_nights_sold', rb.room_nights_sold,
          'fresh_through', rb.fresh_through,
          'source_watermark', jsonb_build_object(
            'max_updated_at', rb.fresh_through,
            'source_as_of', r.effective_source_cutoff,
            'requested_source_as_of', p_source_as_of,
            'effective_source_cutoff', r.effective_source_cutoff,
            'effective_source_cutoff_is_exclusive',
              r.effective_source_cutoff_is_exclusive,
            'effective_source_cutoff_reason', r.effective_source_cutoff_reason,
            'effective_source_cutoff_proof_kind',
              r.effective_source_cutoff_proof_kind,
            'effective_source_cutoff_proof_at',
              r.effective_source_cutoff_proof_at
          ),
          'window_matches_inventory_numerator', r.normalization_windows_align,
          'normalization_alignment_basis', 'same_local_dates',
          'normalization_eligible', (
            r.relationship_covers_inventory_window
            and r.relationship_covers_occupancy_window
            and r.profile_covers_supply_windows
            and r.normalization_windows_align
            and coalesce(sb.usable_periods, 0) = 3
            and coalesce(sb.incompatible_periods, 0) = 0
            and coalesce(rb.observed_days, 0)
              = (p_supply_window_end - p_supply_window_start + 1)
            and coalesce(rb.partial_days, 0) = 0
          ),
          'days', coalesce(rb.days, '[]'::jsonb)
        ),
        'activity', jsonb_build_object(
          'relationship_covers_window', coalesce(
            r.activity_window_start_utc is not null
            and r.relationship_starts_at <= r.activity_window_start_utc
            and (r.relationship_ends_at is null
              or r.relationship_ends_at >= r.activity_window_end_utc), false
          ),
          'exclusion_codes', to_jsonb(array_remove(array[
            case when r.resolved_cutoff_hour is null
              then 'business_date_cutoff_missing' end,
            case when not coalesce(
              r.activity_window_start_utc is not null
              and r.relationship_starts_at <= r.activity_window_start_utc
              and (r.relationship_ends_at is null
                or r.relationship_ends_at >= r.activity_window_end_utc), false
            ) then 'relationship_does_not_cover_activity_window' end,
            case when r.effective_source_cutoff_reason <> 'requested_source_as_of'
              then 'relationship_source_access_limited' end
          ]::text[], null)),
          'inventory_counts', jsonb_build_object(
            'query_id', 'management_pattern_inventory_count_activity',
            'query_version', 'management-pattern-source-snapshot.v1',
            'query_executed', true,
            'query_coverage_status', 'not_evaluated',
            -- inventory_counts can be updated/deleted and is cascade-deleted
            -- with parent rows. Presence remains useful evidence, but the
            -- current table cannot prove historical absence. A future release
            -- may enable this only after an immutable ledger has a complete
            -- per-property watermark covering the whole activity window.
            'coverage_reason_codes', to_jsonb(array_remove(array[
              case when not r.activity_query_prerequisites_met
                then 'property_query_prerequisite_failed' end,
              'immutable_coverage_watermark_unavailable'
            ]::text[], null)),
            'absence_detection_eligible', false,
            'event_dates', coalesce(to_jsonb(ia.event_dates), '[]'::jsonb),
            'source_event_count', coalesce(ia.source_event_count, 0),
            'source_watermark', jsonb_build_object(
              'max_created_at', ia.source_revision_at,
              'row_count', coalesce(ia.source_event_count, 0),
              'source_as_of', r.effective_source_cutoff,
              'requested_source_as_of', p_source_as_of,
              'effective_source_cutoff', r.effective_source_cutoff,
              'effective_source_cutoff_is_exclusive',
                r.effective_source_cutoff_is_exclusive,
              'effective_source_cutoff_reason', r.effective_source_cutoff_reason,
              'effective_source_cutoff_proof_kind',
                r.effective_source_cutoff_proof_kind,
              'effective_source_cutoff_proof_at',
                r.effective_source_cutoff_proof_at
            )
          ),
          'daily_log_closings', jsonb_build_object(
            'query_id', 'management_pattern_daily_log_closing_activity',
            'query_version', 'management-pattern-source-snapshot.v1',
            'query_executed', true,
            'query_coverage_status', 'not_evaluated',
            -- daily_logs is mutable and has no row revision history. Its rows
            -- prove observed presence, but a current-row query cannot prove a
            -- historical absence after edits/deletes. Keep this disabled until
            -- a separately versioned daily-log ledger exists.
            'recording_flow_support', 'historical_mutability_unavailable',
            'coverage_reason_codes', to_jsonb(array_remove(array[
              case when not r.activity_query_prerequisites_met
                then 'property_query_prerequisite_failed' end,
              'mutable_rows_have_no_as_of_revision'
            ]::text[], null)),
            'absence_detection_eligible', false,
            'event_dates', coalesce(to_jsonb(da.event_dates), '[]'::jsonb),
            'source_event_count', coalesce(da.source_event_count, 0),
            'source_watermark', jsonb_build_object(
              'max_sealed_at', da.source_revision_at,
              'sealed_day_count', coalesce(da.source_event_count, 0),
              'source_as_of', r.effective_source_cutoff,
              'requested_source_as_of', p_source_as_of,
              'effective_source_cutoff', r.effective_source_cutoff,
              'effective_source_cutoff_is_exclusive',
                r.effective_source_cutoff_is_exclusive,
              'effective_source_cutoff_reason', r.effective_source_cutoff_reason,
              'effective_source_cutoff_proof_kind',
                r.effective_source_cutoff_proof_kind,
              'effective_source_cutoff_proof_at',
                r.effective_source_cutoff_proof_at
            )
          ),
          'work_order_flow', jsonb_build_object(
            'query_id', 'management_pattern_work_order_activity',
            'query_version', 'management-pattern-source-snapshot.v1',
            'query_executed', true,
            'query_coverage_status', 'not_evaluated',
            'recording_flow_support', 'historical_mutability_unavailable',
            'coverage_reason_codes', to_jsonb(array_remove(array[
              case when not r.activity_query_prerequisites_met
                then 'property_query_prerequisite_failed' end,
              'mutable_rows_have_no_as_of_revision'
            ]::text[], null)),
            'absence_detection_eligible', false,
            'event_dates', coalesce(to_jsonb(wa.event_dates), '[]'::jsonb),
            'source_event_count', coalesce(wa.source_event_count, 0),
            'source_watermark', jsonb_build_object(
              'max_created_at', wa.source_revision_at,
              'row_count', coalesce(wa.source_event_count, 0),
              'source_as_of', r.effective_source_cutoff,
              'requested_source_as_of', p_source_as_of,
              'effective_source_cutoff', r.effective_source_cutoff,
              'effective_source_cutoff_is_exclusive',
                r.effective_source_cutoff_is_exclusive,
              'effective_source_cutoff_reason', r.effective_source_cutoff_reason,
              'effective_source_cutoff_proof_kind',
                r.effective_source_cutoff_proof_kind,
              'effective_source_cutoff_proof_at',
                r.effective_source_cutoff_proof_at
            )
          )
        )
      ) as payload
    from property_quality r
    cross join portfolio_size ps
    left join group_rows gr on gr.property_id = r.property_id
    left join group_history_issues ghi on ghi.property_id = r.property_id
    left join supply_by_property sb on sb.property_id = r.property_id
    left join rooms_by_property rb on rb.property_id = r.property_id
    left join inventory_activity ia on ia.property_id = r.property_id
    left join daily_log_activity da on da.property_id = r.property_id
    left join work_order_activity wa on wa.property_id = r.property_id
  )
  select jsonb_build_object(
    'schema_version', 'management-pattern-source-snapshot.v1',
    'query_id', 'management_pattern_source_snapshot',
    'query_version', 'management-pattern-source-snapshot.v1',
    'organization', jsonb_build_object(
      'id', p_organization_id,
      'organization_type', v_organization.organization_type,
      'status', v_organization.status
    ),
    'evaluation_at', p_evaluation_at,
    'source_as_of', p_source_as_of,
    'topology_as_of', p_topology_as_of,
    'supply_window', jsonb_build_object(
      'start_date', p_supply_window_start,
      'end_date', p_supply_window_end
    ),
    'activity_window', jsonb_build_object(
      'start_date', b.end_date - (p_activity_history_days - 1),
      'end_date', b.end_date,
      'history_days', p_activity_history_days
    ),
    'property_count', ps.property_count,
    'max_properties', p_max_properties,
    'source_budget_exceeded', ps.property_count > p_max_properties,
    'properties', case when ps.property_count > p_max_properties then '[]'::jsonb else coalesce(
      (select jsonb_agg(pp.payload order by pp.property_id) from property_payloads pp),
      '[]'::jsonb
    ) end
  )
  into v_result
  from portfolio_size ps
  left join activity_bounds b on true;

  return v_result;
end
$$;

revoke all on function public.load_management_pattern_source_snapshot(
  uuid,timestamptz,timestamptz,timestamptz,date,date,integer,integer
) from public, anon, authenticated;
grant execute on function public.load_management_pattern_source_snapshot(
  uuid,timestamptz,timestamptz,timestamptz,date,date,integer,integer
) to service_role;

comment on function public.load_management_pattern_source_snapshot(
  uuid,timestamptz,timestamptz,timestamptz,date,date,integer,integer
) is
  'One organization-scoped MVCC source receipt for management-company patterns. topology_as_of selects governing relationship/profile/group state; source_as_of is the created/updated/sealed/closed knowledge cutoff; evaluation_at is the later decision instant. Every fact is clipped to its governing relationship, three complete inventory-close periods and complete room-sold denominators are distinguished from partial evidence, and local activity dates are bounded. Service-role only; never accepts a property-id list.';

insert into public.applied_migrations (version, description)
values (
  '0387',
  'Management-pattern source snapshot: service-role-only organization/as-of batch receipt for governing topology, versioned profiles/groups, complete inventory closes + sourced room-sold denominators, and bounded activity dates; historical-scope indexes support as-of evaluations without N+1 reads.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
