-- 0400_privileged_rpc_tenant_boundaries.sql
--
-- Final-schema RPC privilege correction. Several early SECURITY DEFINER
-- bridges trusted a caller-supplied property/user/run id or retained PostgreSQL
-- default PUBLIC execution. That turns a valid browser session into a confused
-- deputy: it can read another company's live room/reservation data or invoke a
-- global mutation directly. Browser-facing today reads now bind auth.uid() to
-- the same authoritative property standing used by the server. Fleet/model/
-- walkthrough/cleanup functions are service-only because every real caller is
-- already a CRON_SECRET/API-authorized server route or ML service.

begin;

do $$
begin
  if to_regprocedure('public._staxis_authoritative_property_standing_for_auth_user(uuid,uuid)') is null
     or to_regprocedure('public.today_room_work_v1(uuid,date)') is null
     or to_regprocedure('public.today_property_counts_v1(uuid,date)') is null
  then
    raise exception '0400 requires authoritative standing migration 0396 and PMS bridge migration 0224';
  end if;
end
$$;

create or replace function public.today_room_work_v1(
  p_property_id uuid,
  p_date date
)
returns table (
  room_number text,
  stay_type text,
  housekeeper text,
  stayover_day int
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with authorized as (
    select 1
    where coalesce(auth.role(), '') = 'service_role'
       or public._staxis_authoritative_property_standing_for_auth_user(
            auth.uid(), p_property_id
          ) is not null
  ),
  latest_status as (
    select distinct on (room_status.room_number)
      room_status.room_number, room_status.status
    from public.pms_room_status_log room_status
    cross join authorized
    where room_status.property_id = p_property_id
    order by room_status.room_number, room_status.changed_at desc
  ),
  today_res as (
    select reservation.room_number,
      case
        when reservation.departure_date = p_date then 'C/O'
        when reservation.arrival_date <= p_date and reservation.departure_date > p_date then 'Stay'
        else null
      end as stay_type,
      greatest(1, (p_date - reservation.arrival_date) + 1) as stayover_day
    from public.pms_reservations reservation
    cross join authorized
    where reservation.property_id = p_property_id
      and reservation.arrival_date <= p_date
      and reservation.departure_date >= p_date
  ),
  plan as (
    select assignment.room_number, assignment.housekeeper_name
    from public.pms_housekeeping_assignments assignment
    cross join authorized
    where assignment.property_id = p_property_id and assignment.date = p_date
  ),
  work as (
    select room_work.room_number, room_work.assigned_staff_id
    from public.room_work room_work
    cross join authorized
    where room_work.property_id = p_property_id and room_work.date = p_date
  ),
  today_assign as (
    select
      coalesce(work.room_number, plan.room_number) as room_number,
      coalesce(staff.name, plan.housekeeper_name) as housekeeper_name
    from plan
    full outer join work on work.room_number = plan.room_number
    left join public.staff staff
      on staff.id = work.assigned_staff_id
     and staff.property_id = p_property_id
  )
  select status.room_number, reservation.stay_type,
         assignment.housekeeper_name, reservation.stayover_day
  from latest_status status
  left join today_res reservation on reservation.room_number = status.room_number
  left join today_assign assignment on assignment.room_number = status.room_number
  order by status.room_number;
$$;

create or replace function public.today_property_counts_v1(
  p_property_id uuid,
  p_date date
)
returns table (
  checkouts int,
  stayovers int,
  vacant_clean int,
  vacant_dirty int,
  ooo int,
  total_rooms int,
  total_checkouts_today int,
  in_house int
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with authorized as (
    select 1
    where coalesce(auth.role(), '') = 'service_role'
       or public._staxis_authoritative_property_standing_for_auth_user(
            auth.uid(), p_property_id
          ) is not null
  ),
  ihs as (
    select snapshot.*
    from public.pms_in_house_snapshot snapshot
    cross join authorized
    where snapshot.property_id = p_property_id
  ),
  res as (
    select
      count(*) filter (where reservation.departure_date = p_date) as checkouts,
      count(*) filter (
        where reservation.arrival_date <= p_date
          and reservation.departure_date > p_date
      ) as stayovers
    from authorized
    left join public.pms_reservations reservation
      on reservation.property_id = p_property_id
     and reservation.arrival_date <= p_date
     and reservation.departure_date >= p_date
  ),
  rooms as (
    select count(inventory.*) as total
    from authorized
    left join public.pms_rooms_inventory inventory
      on inventory.property_id = p_property_id
  )
  select
    res.checkouts::int,
    res.stayovers::int,
    coalesce(ihs.total_vacant_clean, 0)::int,
    coalesce(ihs.total_vacant_dirty, 0)::int,
    coalesce(ihs.total_ooo, 0)::int,
    coalesce(rooms.total, 0)::int,
    res.checkouts::int,
    coalesce(ihs.total_occupied_rooms, 0)::int
  from authorized
  cross join res
  cross join rooms
  left join ihs on true;
$$;

comment on function public.today_room_work_v1(uuid,date) is
  'Browser PMS room-work bridge. 0400 binds auth.uid to a fresh authoritative property standing; service_role remains supported. Unauthorized/anonymous property IDs return no rows.';
comment on function public.today_property_counts_v1(uuid,date) is
  'Browser PMS day-count bridge. 0400 binds auth.uid to a fresh authoritative property standing; service_role remains supported. Unauthorized/anonymous property IDs return no rows.';

revoke all on function public.today_room_work_v1(uuid,date)
  from public, anon, authenticated, service_role;
revoke all on function public.today_property_counts_v1(uuid,date)
  from public, anon, authenticated, service_role;
grant execute on function public.today_room_work_v1(uuid,date)
  to authenticated, service_role;
grant execute on function public.today_property_counts_v1(uuid,date)
  to authenticated, service_role;

-- The following functions have no browser caller and either enumerate fleet
-- state or mutate global/service-owned rows. Revoke PostgreSQL's default PUBLIC
-- execution as well as any historical explicit anon/authenticated grants.
revoke all on function public.project_property_counts_v1(uuid,date)
  from public, anon, authenticated, service_role;
grant execute on function public.project_property_counts_v1(uuid,date) to service_role;

revoke all on function public.staxis_active_property_ids_for_nudges(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_active_property_ids_for_nudges(integer) to service_role;

revoke all on function public.staxis_install_demand_supply_cold_start(uuid,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_install_demand_supply_cold_start(uuid,text,text,jsonb,jsonb)
  to service_role;

revoke all on function public.staxis_walkthrough_start(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_walkthrough_start(uuid,uuid,text) to service_role;

revoke all on function public.staxis_walkthrough_step(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_walkthrough_step(uuid,uuid,uuid) to service_role;

revoke all on function public.staxis_walkthrough_end(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_walkthrough_end(uuid,text) to service_role;

revoke all on function public.staxis_walkthrough_heal_stale(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.staxis_walkthrough_heal_stale(boolean) to service_role;

revoke all on function public.cleanup_idempotency_log()
  from public, anon, authenticated, service_role;
grant execute on function public.cleanup_idempotency_log() to service_role;

insert into public.applied_migrations(version, description)
values (
  '0400',
  'Bind browser PMS bridge RPCs to fresh authoritative property reach and make fleet/model/walkthrough/cleanup SECURITY DEFINER RPCs service-role-only.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
