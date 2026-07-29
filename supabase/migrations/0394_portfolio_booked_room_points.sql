-- 0394_portfolio_booked_room_points.sql
--
-- A booked-room pickup table contains a full curve (often 30+ as-of rows for
-- one stay date). A global LIMIT over current + baseline stay dates can be
-- consumed entirely by the current curve and hide every valid lead-zero
-- baseline. This service-only RPC returns at most one receipt-backed current
-- point plus one exact lead-zero point for each requested baseline date.

begin;

create or replace function public.staxis_portfolio_booked_room_points(
  p_property_id uuid,
  p_business_date date,
  p_baseline_dates date[] default '{}'::date[]
)
returns table (
  point_kind text,
  target_date date,
  pace_id uuid,
  as_of_date date,
  stay_date date,
  rooms_otb integer,
  rooms_available integer,
  observed_at timestamptz,
  ingest_run_id uuid,
  source_kind text,
  source_captured_at timestamptz,
  parser_name text,
  parser_version text,
  knowledge_file_id uuid,
  report_file_id uuid,
  run_status text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_property_id is null or p_business_date is null
     or p_baseline_dates is null
     or cardinality(p_baseline_dates) > 12
     or cardinality(p_baseline_dates) <> (
       select count(distinct requested.day)::integer
       from unnest(p_baseline_dates) requested(day)
     )
     or exists (
       select 1 from unnest(p_baseline_dates) requested(day)
       where requested.day is null or requested.day >= p_business_date
     )
  then
    raise exception 'invalid bounded booked-room point request'
      using errcode = '22023';
  end if;

  return query
  with requested as (
    select 'current'::text as kind, p_business_date as day
    union all
    select 'baseline'::text, requested_date.day
    from unnest(p_baseline_dates) requested_date(day)
  ), ranked as (
    select
      requested.kind,
      requested.day,
      pace.id as pace_id,
      pace.as_of_date,
      pace.stay_date,
      pace.rooms_otb,
      pace.rooms_available,
      pace.observed_at,
      run.id as ingest_run_id,
      run.source_kind,
      run.source_captured_at,
      run.parser_name,
      run.parser_version,
      run.knowledge_file_id,
      run.report_file_id,
      run.status as run_status,
      row_number() over (
        partition by requested.kind, requested.day
        order by
          pace.as_of_date desc,
          pace.observed_at desc nulls last,
          run.source_captured_at desc,
          pace.id desc
      ) as position
    from requested
    join public.pms_booking_pace pace
      on pace.property_id = p_property_id
     and pace.stay_date = requested.day
     and (
       (requested.kind = 'current' and pace.as_of_date <= p_business_date)
       or (requested.kind = 'baseline' and pace.as_of_date = requested.day)
     )
    join public.pms_ingest_runs run
      on run.id = pace.ingest_run_id
     and run.property_id = p_property_id
     and run.status in ('succeeded', 'promoted')
  )
  select
    ranked.kind,
    ranked.day,
    ranked.pace_id,
    ranked.as_of_date,
    ranked.stay_date,
    ranked.rooms_otb,
    ranked.rooms_available,
    ranked.observed_at,
    ranked.ingest_run_id,
    ranked.source_kind,
    ranked.source_captured_at,
    ranked.parser_name,
    ranked.parser_version,
    ranked.knowledge_file_id,
    ranked.report_file_id,
    ranked.run_status
  from ranked
  where ranked.position = 1
  order by case when ranked.kind = 'current' then 0 else 1 end, ranked.day desc;
end
$$;

comment on function public.staxis_portfolio_booked_room_points(uuid, date, date[]) is
  'Bounded property-scoped booked-room evidence: one newest successful current point and one exact lead-zero point per requested baseline date. Prevents pickup-curve row limits from hiding comparison history. Added 0394.';

revoke all on function public.staxis_portfolio_booked_room_points(uuid, date, date[])
  from public, anon, authenticated;
grant execute on function public.staxis_portfolio_booked_room_points(uuid, date, date[])
  to service_role;

insert into public.applied_migrations(version, description)
values (
  '0394',
  'Bounded receipt-backed current and exact lead-zero booked-room points for portfolio comparisons.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
