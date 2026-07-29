-- ═══════════════════════════════════════════════════════════════════════════
-- 0408 — Exact, bounded read models for the company queue.
--
-- A company queue used to issue the findings-ledger reads once per hotel. A
-- plain PostgREST `property_id in (...)` query is not an equivalent rewrite:
-- its LIMIT is global, so one noisy hotel can consume the page and make an
-- older problem at a quieter hotel disappear. The same trap applies to "the
-- latest run" and "the latest action", which are top-N questions PER hotel or
-- PER finding.
--
-- These functions put the partition at the database boundary. LATERAL
-- top-N reads let the existing/new per-tenant indexes stop at each partition
-- instead of ranking the hotel ledgers' entire history. Their
-- array-size guards are part of the contract, not merely performance hints:
-- one call can return at most 60 * 100 findings, 60 runs, and one action for
-- each of at most 60 * 100 finding ids. The caller still supplies the exact
-- company-derived hotel ids; every SELECT below repeats that property filter.
--
-- Service-role only, like the underlying findings tables. SECURITY INVOKER is
-- deliberate: these functions do not create a second privilege boundary.
-- ═══════════════════════════════════════════════════════════════════════════

create index if not exists findings_portfolio_queue_idx
  on public.findings (property_id, last_seen_at desc, id);

create index if not exists finding_actions_finding_latest_live_idx
  on public.finding_actions (finding_id, proposed_at desc, id);

create or replace function public.staxis_portfolio_queue_findings(
  p_property_ids uuid[],
  p_statuses text[],
  p_limit_per_property integer
)
returns setof public.findings
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(cardinality(p_property_ids), 0) > 60 then
    raise exception 'portfolio queue accepts at most 60 properties'
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_statuses), 0) > 6 then
    raise exception 'portfolio queue accepts at most 6 finding statuses'
      using errcode = '22023';
  end if;
  if p_limit_per_property is null
     or p_limit_per_property < 1
     or p_limit_per_property > 100 then
    raise exception 'portfolio queue per-property finding limit must be 1..100'
      using errcode = '22023';
  end if;

  return query
  select f.*
  from (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ) requested
  cross join lateral (
    select candidate.*
    from public.findings candidate
    where candidate.property_id = requested.property_id
      and candidate.status = any(coalesce(p_statuses, '{}'::text[]))
    order by candidate.last_seen_at desc, candidate.id asc
    limit p_limit_per_property
  ) f
  order by f.property_id asc, f.last_seen_at desc, f.id asc;
end;
$$;

create or replace function public.staxis_portfolio_queue_latest_runs(
  p_property_ids uuid[]
)
returns setof public.finding_runs
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(cardinality(p_property_ids), 0) > 60 then
    raise exception 'portfolio queue accepts at most 60 properties'
      using errcode = '22023';
  end if;

  return query
  select fr.*
  from (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ) requested
  cross join lateral (
    select candidate.*
    from public.finding_runs candidate
    where candidate.property_id = requested.property_id
    order by candidate.run_at desc, candidate.id asc
    limit 1
  ) fr
  order by fr.property_id asc;
end;
$$;

create or replace function public.staxis_portfolio_queue_actions(
  p_property_ids uuid[],
  p_finding_ids uuid[],
  p_states text[]
)
returns setof public.finding_actions
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if coalesce(cardinality(p_property_ids), 0) > 60 then
    raise exception 'portfolio queue accepts at most 60 properties'
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_finding_ids), 0) > 6000 then
    raise exception 'portfolio queue accepts at most 6000 findings'
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_states), 0) > 8 then
    raise exception 'portfolio queue accepts at most 8 action states'
      using errcode = '22023';
  end if;

  return query
  select a.*
  from (
    select distinct unnest(coalesce(p_finding_ids, '{}'::uuid[])) as finding_id
  ) requested
  cross join lateral (
    select candidate.*
    from public.finding_actions candidate
    where candidate.finding_id = requested.finding_id
      and candidate.property_id = any(coalesce(p_property_ids, '{}'::uuid[]))
      and candidate.state = any(coalesce(p_states, '{}'::text[]))
    order by
      candidate.proposed_at desc,
      case when candidate.state = 'proposed' then 1 else 0 end asc,
      candidate.id asc
    limit 1
  ) a
  order by a.finding_id asc;
end;
$$;

revoke all on function public.staxis_portfolio_queue_findings(uuid[], text[], integer)
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_queue_latest_runs(uuid[])
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_queue_actions(uuid[], uuid[], text[])
  from public, anon, authenticated;

grant execute on function public.staxis_portfolio_queue_findings(uuid[], text[], integer)
  to service_role;
grant execute on function public.staxis_portfolio_queue_latest_runs(uuid[])
  to service_role;
grant execute on function public.staxis_portfolio_queue_actions(uuid[], uuid[], text[])
  to service_role;

comment on function public.staxis_portfolio_queue_findings(uuid[], text[], integer) is
  'Exact top-N findings per hotel for the company queue. Service-role only; callers must pass company-authorized property ids.';
comment on function public.staxis_portfolio_queue_latest_runs(uuid[]) is
  'Exact latest finding run per hotel for the company queue. Service-role only; callers must pass company-authorized property ids.';
comment on function public.staxis_portfolio_queue_actions(uuid[], uuid[], text[]) is
  'Exact latest live action per selected finding for the company queue. Service-role only; property ids are rechecked in the query.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Portfolio Ask Staxis read model.
--
-- The tool layer used to issue one PostgREST request per hotel. A plain
-- cross-property `.in()` is not safe enough: it trusts the supplied ids, and a
-- global response limit lets one noisy hotel hide another. These readers take
-- the company id too, re-intersect every requested hotel with the CURRENT live
-- primary operator/owner relationship, and return one JSON array per hotel.
-- One outer row per hotel also keeps PostgREST's global row ceiling from
-- truncating the middle of a portfolio while preserving a per-hotel sentinel
-- row (`limit + 1`) for honest lower-bound reporting.
-- Row-returning tool buckets accept at most 50 payload rows plus that sentinel,
-- and refuse an individual bucket once its full (untruncated) JSON exceeds
-- 64 KiB. The explicit `bucket_available = false, rows_json = null` marker lets
-- the adapter make only that hotel unavailable without shipping partial policy
-- evidence or failing the other authorized hotels.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.staxis_portfolio_tool_hotels(
  p_organization_id uuid,
  p_property_ids uuid[]
)
returns table (
  property_id uuid,
  name text,
  total_rooms integer,
  timezone text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is null then
    raise exception 'portfolio tool organization is required' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_property_ids), 0) > 50 then
    raise exception 'portfolio tools accept at most 50 properties' using errcode = '22023';
  end if;

  return query
  with requested as (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ), authorized as (
    select requested.property_id
    from requested
    join public.organization_property_relationships relationship
      on relationship.property_id = requested.property_id
     and relationship.organization_id = p_organization_id
     and relationship.is_primary_grouping
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= statement_timestamp()
     and (relationship.ends_at is null or relationship.ends_at > statement_timestamp())
  )
  select hotel.id, hotel.name, hotel.total_rooms, hotel.timezone
  from authorized
  join public.properties hotel on hotel.id = authorized.property_id
  order by hotel.id asc;
end;
$$;

create or replace function public.staxis_portfolio_tool_findings(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_statuses text[],
  p_limit_per_property integer
)
returns table (property_id uuid, rows_json jsonb, bucket_available boolean)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is null then
    raise exception 'portfolio tool organization is required' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_property_ids), 0) > 50 then
    raise exception 'portfolio tools accept at most 50 properties' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_statuses), 0) > 6 then
    raise exception 'portfolio tool finding status limit exceeded' using errcode = '22023';
  end if;
  if p_limit_per_property is null
     or p_limit_per_property < 1
     or p_limit_per_property > 51 then
    raise exception 'portfolio tool per-property row limit must be 1..51'
      using errcode = '22023';
  end if;

  return query
  with requested as (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ), authorized as (
    select requested.property_id
    from requested
    join public.organization_property_relationships relationship
      on relationship.property_id = requested.property_id
     and relationship.organization_id = p_organization_id
     and relationship.is_primary_grouping
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= statement_timestamp()
     and (relationship.ends_at is null or relationship.ends_at > statement_timestamp())
  )
  select authorized.property_id,
         case
           when octet_length(candidate_bucket.rows_json::text) <= 65536
             then candidate_bucket.rows_json
           else null
         end as rows_json,
         octet_length(candidate_bucket.rows_json::text) <= 65536 as bucket_available
  from authorized
  cross join lateral (
    select coalesce(
      jsonb_agg(to_jsonb(selected_row)
                order by selected_row.last_seen_at desc, selected_row.id asc),
      '[]'::jsonb
    ) as rows_json
    from (
      select candidate.id,
             candidate.property_id,
             candidate.detector_id,
             candidate.summary,
             candidate.judged_summary_en,
             candidate.judged_summary_es,
             candidate.evidence,
             candidate.severity,
             candidate.disposition,
             candidate.status,
             candidate.price_low_cents,
             candidate.price_high_cents,
             candidate.price_currency,
             candidate.price_basis,
             candidate.first_seen_at,
             candidate.last_seen_at
      from public.findings candidate
      where candidate.property_id = authorized.property_id
        and candidate.status = any(coalesce(p_statuses, '{}'::text[]))
      order by candidate.last_seen_at desc, candidate.id asc
      limit p_limit_per_property
    ) selected_row
  ) candidate_bucket
  order by authorized.property_id asc;
end;
$$;

create or replace function public.staxis_portfolio_tool_finding_counts(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_statuses text[]
)
returns table (
  property_id uuid,
  open_count bigint,
  needs_decision_count bigint
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is null then
    raise exception 'portfolio tool organization is required' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_property_ids), 0) > 50 then
    raise exception 'portfolio tools accept at most 50 properties' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_statuses), 0) > 6 then
    raise exception 'portfolio tool finding status limit exceeded' using errcode = '22023';
  end if;

  return query
  with requested as (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ), authorized as (
    select requested.property_id
    from requested
    join public.organization_property_relationships relationship
      on relationship.property_id = requested.property_id
     and relationship.organization_id = p_organization_id
     and relationship.is_primary_grouping
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= statement_timestamp()
     and (relationship.ends_at is null or relationship.ends_at > statement_timestamp())
  )
  select authorized.property_id,
         count(candidate.id)::bigint as open_count,
         count(candidate.id) filter (
           where coalesce(candidate.judged_disposition, candidate.disposition) = 'propose'
         )::bigint as needs_decision_count
  from authorized
  left join public.findings candidate
    on candidate.property_id = authorized.property_id
   and candidate.status = any(coalesce(p_statuses, '{}'::text[]))
  group by authorized.property_id
  order by authorized.property_id asc;
end;
$$;

create or replace function public.staxis_portfolio_tool_work_orders(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_financial_property_ids uuid[],
  p_since timestamptz
)
returns table (
  property_id uuid,
  opened_count bigint,
  still_open_count bigint,
  urgent_open_count bigint,
  high_open_count bigint,
  normal_open_count bigint,
  low_open_count bigint,
  ungraded_open_count bigint,
  repair_cost_sum numeric,
  repair_cost_samples bigint
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is null or p_since is null then
    raise exception 'portfolio tool organization and since timestamp are required'
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_property_ids), 0) > 50
     or coalesce(cardinality(p_financial_property_ids), 0) > 50 then
    raise exception 'portfolio tools accept at most 50 properties' using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_financial_property_ids, '{}'::uuid[])) financial_id
    where not (financial_id = any(coalesce(p_property_ids, '{}'::uuid[])))
  ) then
    raise exception 'financial properties must be a subset of requested properties'
      using errcode = '22023';
  end if;
  return query
  with requested as (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ), authorized as (
    select requested.property_id
    from requested
    join public.organization_property_relationships relationship
      on relationship.property_id = requested.property_id
     and relationship.organization_id = p_organization_id
     and relationship.is_primary_grouping
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= statement_timestamp()
     and (relationship.ends_at is null or relationship.ends_at > statement_timestamp())
  )
  select authorized.property_id,
         count(candidate.id)::bigint as opened_count,
         count(candidate.id) filter (
           where coalesce(candidate.status, 'submitted') <> 'resolved'
         )::bigint as still_open_count,
         count(candidate.id) filter (
           where coalesce(candidate.status, 'submitted') <> 'resolved'
             and lower(trim(coalesce(candidate.severity, ''))) in ('urgent', 'critical')
         )::bigint as urgent_open_count,
         count(candidate.id) filter (
           where coalesce(candidate.status, 'submitted') <> 'resolved'
             and lower(trim(coalesce(candidate.severity, ''))) in ('major', 'high')
         )::bigint as high_open_count,
         count(candidate.id) filter (
           where coalesce(candidate.status, 'submitted') <> 'resolved'
             and lower(trim(coalesce(candidate.severity, ''))) in ('medium', 'normal', 'moderate')
         )::bigint as normal_open_count,
         count(candidate.id) filter (
           where coalesce(candidate.status, 'submitted') <> 'resolved'
             and lower(trim(coalesce(candidate.severity, ''))) in ('low', 'minor')
         )::bigint as low_open_count,
         count(candidate.id) filter (
           where coalesce(candidate.status, 'submitted') <> 'resolved'
             and lower(trim(coalesce(candidate.severity, ''))) not in (
               'urgent', 'critical', 'major', 'high',
               'medium', 'normal', 'moderate', 'low', 'minor'
             )
         )::bigint as ungraded_open_count,
         case
           when authorized.property_id = any(coalesce(p_financial_property_ids, '{}'::uuid[]))
             then sum(candidate.repair_cost) filter (where candidate.repair_cost > 0)
           else null
         end as repair_cost_sum,
         case
           when authorized.property_id = any(coalesce(p_financial_property_ids, '{}'::uuid[]))
             then count(candidate.id) filter (where candidate.repair_cost > 0)
           else 0
         end::bigint as repair_cost_samples
  from authorized
  left join public.work_orders candidate
    on candidate.property_id = authorized.property_id
   and candidate.created_at >= p_since
  group by authorized.property_id
  order by authorized.property_id asc;
end;
$$;

create or replace function public.staxis_portfolio_tool_work_order_counts(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_since timestamptz
)
returns table (property_id uuid, metric_count bigint)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is null or p_since is null then
    raise exception 'portfolio tool organization and since timestamp are required'
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_property_ids), 0) > 50 then
    raise exception 'portfolio tools accept at most 50 properties' using errcode = '22023';
  end if;

  return query
  with requested as (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ), authorized as (
    select requested.property_id
    from requested
    join public.organization_property_relationships relationship
      on relationship.property_id = requested.property_id
     and relationship.organization_id = p_organization_id
     and relationship.is_primary_grouping
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= statement_timestamp()
     and (relationship.ends_at is null or relationship.ends_at > statement_timestamp())
  )
  select authorized.property_id,
         (select count(*)::bigint
            from public.work_orders candidate
           where candidate.property_id = authorized.property_id
             and candidate.created_at >= p_since) as metric_count
  from authorized
  order by authorized.property_id asc;
end;
$$;

create or replace function public.staxis_portfolio_tool_inventory_orders(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_since timestamptz,
  p_limit_per_property integer
)
returns table (property_id uuid, rows_json jsonb, bucket_available boolean)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is null or p_since is null then
    raise exception 'portfolio tool organization and since timestamp are required'
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_property_ids), 0) > 50 then
    raise exception 'portfolio tools accept at most 50 properties' using errcode = '22023';
  end if;
  if p_limit_per_property is null
     or p_limit_per_property < 1
     or p_limit_per_property > 51 then
    raise exception 'portfolio tool per-property row limit must be 1..51'
      using errcode = '22023';
  end if;

  return query
  with requested as (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ), authorized as (
    select requested.property_id
    from requested
    join public.organization_property_relationships relationship
      on relationship.property_id = requested.property_id
     and relationship.organization_id = p_organization_id
     and relationship.is_primary_grouping
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= statement_timestamp()
     and (relationship.ends_at is null or relationship.ends_at > statement_timestamp())
  )
  select authorized.property_id,
         case
           when octet_length(candidate_bucket.rows_json::text) <= 65536
             then candidate_bucket.rows_json
           else null
         end as rows_json,
         octet_length(candidate_bucket.rows_json::text) <= 65536 as bucket_available
  from authorized
  cross join lateral (
    select coalesce(
      jsonb_agg(to_jsonb(selected_row)
                order by selected_row.received_at desc, selected_row.id asc),
      '[]'::jsonb
    ) as rows_json
    from (
      select candidate.id,
             candidate.property_id,
             candidate.total_cost,
             candidate.unit_cost,
             candidate.quantity,
             candidate.received_at
      from public.inventory_orders candidate
      where candidate.property_id = authorized.property_id
        and candidate.received_at >= p_since
      order by candidate.received_at desc, candidate.id asc
      limit p_limit_per_property
    ) selected_row
  ) candidate_bucket
  order by authorized.property_id asc;
end;
$$;

create or replace function public.staxis_portfolio_tool_inventory(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_limit_per_property integer
)
returns table (property_id uuid, rows_json jsonb, bucket_available boolean)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is null then
    raise exception 'portfolio tool organization is required' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_property_ids), 0) > 50 then
    raise exception 'portfolio tools accept at most 50 properties' using errcode = '22023';
  end if;
  if p_limit_per_property is null
     or p_limit_per_property < 1
     or p_limit_per_property > 51 then
    raise exception 'portfolio tool per-property row limit must be 1..51'
      using errcode = '22023';
  end if;

  return query
  with requested as (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ), authorized as (
    select requested.property_id
    from requested
    join public.organization_property_relationships relationship
      on relationship.property_id = requested.property_id
     and relationship.organization_id = p_organization_id
     and relationship.is_primary_grouping
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= statement_timestamp()
     and (relationship.ends_at is null or relationship.ends_at > statement_timestamp())
  )
  select authorized.property_id,
         case
           when octet_length(candidate_bucket.rows_json::text) <= 65536
             then candidate_bucket.rows_json
           else null
         end as rows_json,
         octet_length(candidate_bucket.rows_json::text) <= 65536 as bucket_available
  from authorized
  cross join lateral (
    select coalesce(
      jsonb_agg(to_jsonb(selected_row) order by selected_row.id asc),
      '[]'::jsonb
    ) as rows_json
    from (
      select candidate.id,
             candidate.property_id,
             candidate.name,
             candidate.current_stock,
             candidate.par_level,
             candidate.unit,
             candidate.archived_at
      from public.inventory candidate
      where candidate.property_id = authorized.property_id
      order by candidate.id asc
      limit p_limit_per_property
    ) selected_row
  ) candidate_bucket
  order by authorized.property_id asc;
end;
$$;

-- The portfolio prompt needs only one narrow slice of PMS status: whether a
-- hotel is live/manual/onboarding and the timestamp/source behind its as-of
-- line. Calling the full hotel feed-status helper also reads dashboard tiles
-- and today's reservations, even though the portfolio prompt never consumes
-- them. This RPC returns only the raw facts needed to preserve the existing
-- health -> legacy fallback order in TypeScript.
--
-- Manual hotels are represented by a RETURNED bucket with session_present =
-- false. A requested hotel omitted here is therefore unambiguously outside the
-- current live company/property intersection, never a manual hotel.
create or replace function public.staxis_portfolio_feed_pulses(
  p_organization_id uuid,
  p_property_ids uuid[]
)
returns table (
  property_id uuid,
  health_rows jsonb,
  session_present boolean,
  active_knowledge_present boolean,
  snapshot_captured_at timestamptz,
  session_last_successful_read_at timestamptz,
  room_status_last_synced_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_organization_id is null then
    raise exception 'portfolio feed pulse organization is required' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_property_ids), 0) > 50 then
    raise exception 'portfolio feed pulses accept at most 50 properties' using errcode = '22023';
  end if;

  return query
  with requested as (
    select distinct unnest(coalesce(p_property_ids, '{}'::uuid[])) as property_id
  ), authorized as (
    select distinct requested.property_id
    from requested
    join public.organization_property_relationships relationship
      on relationship.property_id = requested.property_id
     and relationship.organization_id = p_organization_id
     and relationship.is_primary_grouping
     and relationship.relationship_type in ('operator', 'owner')
     and relationship.starts_at <= statement_timestamp()
     and (relationship.ends_at is null or relationship.ends_at > statement_timestamp())
  )
  select authorized.property_id,
         coalesce((
           select jsonb_agg(
             jsonb_build_object(
               'property_id', health.property_id,
               'feed_key', health.feed_key,
               'required', health.required,
               'enabled', health.enabled,
               'last_signal_at', health.last_signal_at,
               'state', health.state
             )
             order by health.feed_key asc
           )
           from public.pms_feed_health_v1 health
           where health.property_id = authorized.property_id
         ), '[]'::jsonb) as health_rows,
         (session.property_id is not null) as session_present,
         (
           session.property_id is not null
           and exists (
             select 1
             from public.pms_knowledge_files knowledge
             where knowledge.pms_family = session.pms_family
               and knowledge.status = 'active'
               and knowledge.deleted_at is null
           )
         ) as active_knowledge_present,
         snapshot.captured_at as snapshot_captured_at,
         session.last_successful_read_at as session_last_successful_read_at,
         room_status.last_synced_at as room_status_last_synced_at
  from authorized
  left join public.property_sessions session
    on session.property_id = authorized.property_id
  left join lateral (
    select current_snapshot.captured_at
    from public.pms_in_house_snapshot current_snapshot
    where current_snapshot.property_id = authorized.property_id
    order by current_snapshot.captured_at desc
    limit 1
  ) snapshot on true
  left join lateral (
    select max(status_row.last_synced_at) as last_synced_at
    from public.pms_room_status_log status_row
    where status_row.property_id = authorized.property_id
  ) room_status on true
  order by authorized.property_id asc;
end;
$$;

revoke all on function public.staxis_portfolio_tool_hotels(uuid, uuid[])
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_tool_findings(uuid, uuid[], text[], integer)
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_tool_finding_counts(uuid, uuid[], text[])
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_tool_work_orders(uuid, uuid[], uuid[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_tool_work_order_counts(uuid, uuid[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_tool_inventory_orders(uuid, uuid[], timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_tool_inventory(uuid, uuid[], integer)
  from public, anon, authenticated;
revoke all on function public.staxis_portfolio_feed_pulses(uuid, uuid[])
  from public, anon, authenticated;

grant execute on function public.staxis_portfolio_tool_hotels(uuid, uuid[])
  to service_role;
grant execute on function public.staxis_portfolio_tool_findings(uuid, uuid[], text[], integer)
  to service_role;
grant execute on function public.staxis_portfolio_tool_finding_counts(uuid, uuid[], text[])
  to service_role;
grant execute on function public.staxis_portfolio_tool_work_orders(uuid, uuid[], uuid[], timestamptz)
  to service_role;
grant execute on function public.staxis_portfolio_tool_work_order_counts(uuid, uuid[], timestamptz)
  to service_role;
grant execute on function public.staxis_portfolio_tool_inventory_orders(uuid, uuid[], timestamptz, integer)
  to service_role;
grant execute on function public.staxis_portfolio_tool_inventory(uuid, uuid[], integer)
  to service_role;
grant execute on function public.staxis_portfolio_feed_pulses(uuid, uuid[])
  to service_role;

comment on function public.staxis_portfolio_tool_hotels(uuid, uuid[]) is
  'Company-intersected hotel metadata for Portfolio Ask Staxis. Service-role only; at most 50 requested hotels.';
comment on function public.staxis_portfolio_tool_findings(uuid, uuid[], text[], integer) is
  'Company-intersected per-hotel finding buckets for Portfolio Ask Staxis. Service-role only; at most 50 x 51 rows and 64 KiB per bucket including sentinels.';
comment on function public.staxis_portfolio_tool_finding_counts(uuid, uuid[], text[]) is
  'Exact company-intersected live finding and decision counts per hotel for the Portfolio Ask Staxis snapshot.';
comment on function public.staxis_portfolio_tool_work_orders(uuid, uuid[], uuid[], timestamptz) is
  'Exact company-intersected per-hotel work-order backlog and severity totals. Repair cost is emitted only for the separately authorized financial hotel subset.';
comment on function public.staxis_portfolio_tool_work_order_counts(uuid, uuid[], timestamptz) is
  'Exact company-intersected work-order counts per hotel for portfolio comparison.';
comment on function public.staxis_portfolio_tool_inventory_orders(uuid, uuid[], timestamptz, integer) is
  'Company-intersected per-hotel inventory-order buckets for financially authorized portfolio reads, capped at 51 rows and 64 KiB each.';
comment on function public.staxis_portfolio_tool_inventory(uuid, uuid[], integer) is
  'Company-intersected per-hotel inventory buckets for Portfolio Ask Staxis, capped at 51 rows and 64 KiB each.';
comment on function public.staxis_portfolio_feed_pulses(uuid, uuid[]) is
  'Exact company-intersected PMS mode/freshness inputs for the portfolio prompt. Service-role only; omitted buckets are unavailable, never manual hotels.';

insert into public.applied_migrations (version, description)
values (
  '0408',
  'Exact bounded portfolio queue and Portfolio Ask Staxis read models. Per-hotel partitions and PMS freshness inputs stay exact while company navigation and aggregate tools avoid hotel-scaled request fan-out.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
