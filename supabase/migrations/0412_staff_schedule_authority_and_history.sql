-- 0412: Staff pilot authority, privacy, and history boundaries.
--
-- * Managers retain the full schedule/time-off read needed by the planning UI.
-- * Ordinary employees can read only their own visible shifts, visible open
--   shifts in their department, and their own time-off requests.
-- * Time-off approval and removal of a conflicting shift commit together.
-- * Removing a person archives the staff identity, preserves historical rows,
--   and turns current/future assignments into explicit open coverage.

begin;

create or replace function public.staxis_user_can_read_full_staff_schedule(
  p_property_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_standing jsonb;
  v_role text;
begin
  if coalesce(auth.role(), '') = 'service_role' then return true; end if;
  v_standing := public._staxis_authoritative_property_standing_for_auth_user(
    auth.uid(), p_property_id
  );
  v_role := v_standing->>'operationalRole';
  return public.staxis_property_section_enabled(p_property_id, 'staff')
    and v_role in ('admin', 'owner', 'general_manager')
    and (
      v_role = 'admin' or not exists (
        select 1
        from public.capability_overrides override_row
        where override_row.property_id = p_property_id
          and override_row.capability = 'manage_shifts'
          and override_row.role = v_role
          and override_row.allowed is false
      )
    );
end;
$$;

create or replace function public.staxis_user_can_read_staff_schedule_row(
  p_property_id uuid,
  p_staff_id uuid,
  p_department text,
  p_kind text,
  p_status text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff_id uuid;
  v_department text;
begin
  if public.staxis_user_can_read_full_staff_schedule(p_property_id) then
    return true;
  end if;
  if p_status not in ('published', 'sent', 'confirmed') then return false; end if;

  select staff_link.staff_id, staff_row.department
    into v_staff_id, v_department
  from public.accounts account
  join public.account_property_staff_links staff_link
    on staff_link.account_id = account.id
   and staff_link.property_id = p_property_id
   and staff_link.is_active is true
  join public.staff staff_row
    on staff_row.id = staff_link.staff_id
   and staff_row.property_id = staff_link.property_id
   and staff_row.is_active is true
  where account.data_user_id = auth.uid()
    and account.active is true
  limit 1;

  if v_staff_id is null then return false; end if;
  return (p_kind = 'shift' and p_staff_id = v_staff_id)
    or (p_kind = 'open' and p_staff_id is null and p_department = v_department);
end;
$$;

create or replace function public.staxis_user_can_read_time_off_row(
  p_property_id uuid,
  p_staff_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff_id uuid;
begin
  if public.staxis_user_can_read_full_staff_schedule(p_property_id) then
    return true;
  end if;

  select staff_link.staff_id into v_staff_id
  from public.accounts account
  join public.account_property_staff_links staff_link
    on staff_link.account_id = account.id
   and staff_link.property_id = p_property_id
   and staff_link.is_active is true
  join public.staff staff_row
    on staff_row.id = staff_link.staff_id
   and staff_row.property_id = staff_link.property_id
   and staff_row.is_active is true
  where account.data_user_id = auth.uid()
    and account.active is true
  limit 1;

  return v_staff_id is not null and p_staff_id = v_staff_id;
end;
$$;

revoke all on function public.staxis_user_can_read_full_staff_schedule(uuid)
  from public, anon;
revoke all on function public.staxis_user_can_read_staff_schedule_row(uuid, uuid, text, text, text)
  from public, anon;
revoke all on function public.staxis_user_can_read_time_off_row(uuid, uuid)
  from public, anon;
grant execute on function public.staxis_user_can_read_full_staff_schedule(uuid)
  to authenticated, service_role;
grant execute on function public.staxis_user_can_read_staff_schedule_row(uuid, uuid, text, text, text)
  to authenticated, service_role;
grant execute on function public.staxis_user_can_read_time_off_row(uuid, uuid)
  to authenticated, service_role;

drop policy if exists scheduled_shifts_select on public.scheduled_shifts;
create policy scheduled_shifts_select on public.scheduled_shifts
  for select to authenticated
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'staff')
    and public.staxis_user_can_read_staff_schedule_row(
      property_id, staff_id, department, kind, status
    )
  );

drop policy if exists time_off_requests_select on public.time_off_requests;
create policy time_off_requests_select on public.time_off_requests
  for select to authenticated
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_property_section_enabled(property_id, 'staff')
    and public.staxis_user_can_read_time_off_row(property_id, staff_id)
  );

-- Staff identities are historical dimensions. Managers archive through the
-- service-only RPC below; direct browser deletes are explicitly denied.
drop policy if exists staff_manage_delete on public.staff;
drop policy if exists staff_archive_instead_of_delete on public.staff;
create policy staff_archive_instead_of_delete on public.staff
  for delete to authenticated
  using (false);

-- Browser roster edits may change details on an active person, but lifecycle
-- changes go only through the service-role archive RPC. USING evaluates the
-- stored row and blocks reactivation; WITH CHECK evaluates the proposed row
-- and blocks deactivation. New browser-created profiles must start active.
drop policy if exists staff_manage_insert on public.staff;
create policy staff_manage_insert
  on public.staff
  for insert to authenticated
  with check (
    public.staxis_user_can_manage_staff(property_id)
    and public.mfa_verified_or_grace()
    and is_active is true
  );

drop policy if exists staff_manage_update on public.staff;
create policy staff_manage_update
  on public.staff
  for update to authenticated
  using (
    public.staxis_user_can_manage_staff(property_id)
    and public.mfa_verified_or_grace()
    and is_active is true
  )
  with check (
    public.staxis_user_can_manage_staff(property_id)
    and public.mfa_verified_or_grace()
    and is_active is true
  );

-- Preserve every request row while collapsing pre-existing duplicate live
-- requests to one deterministic winner (approved first, then earliest). This
-- allows a partial unique index to make concurrent employee submissions
-- idempotent at the database boundary.
with ranked_live_requests as (
  select request_row.id,
         row_number() over (
           partition by request_row.property_id,
                        request_row.staff_id,
                        request_row.request_date
           order by case when request_row.status = 'approved' then 0 else 1 end,
                    request_row.submitted_at,
                    request_row.id
         ) as live_rank
  from public.time_off_requests request_row
  where request_row.status in ('pending', 'approved')
)
update public.time_off_requests request_row
   set status = 'cancelled',
       decided_at = coalesce(request_row.decided_at, clock_timestamp()),
       deny_reason = coalesce(
         nullif(btrim(request_row.deny_reason), ''),
         'Duplicate live request retired during schedule integrity migration'
       )
  from ranked_live_requests ranked
 where ranked.id = request_row.id
   and ranked.live_rank > 1;

create unique index if not exists time_off_requests_one_live_per_staff_date
  on public.time_off_requests(property_id, staff_id, request_date)
  where status in ('pending', 'approved');

-- Only the manager bulk-fill flow may deliberately place someone on a day
-- with approved leave. Persist that explicit choice so later harmless edits
-- can retain it, while every ordinary assignment path is forced to false.
alter table public.scheduled_shifts
  add column if not exists time_off_override boolean not null default false;
alter table public.scheduled_shifts
  drop constraint if exists scheduled_shifts_time_off_override_assigned_check;
alter table public.scheduled_shifts
  add constraint scheduled_shifts_time_off_override_assigned_check
  check (
    time_off_override is false
    or (kind = 'shift' and staff_id is not null)
  );

-- Repair live assignments left behind by the pre-0412 read/write race. There
-- was no explicit-override marker before this migration, so approved leave
-- wins for each property's local today/future. Historical assignments remain
-- immutable evidence even when an old approved request overlaps them.
do $repair_live_leave_conflicts$
declare
  v_property record;
  v_today date;
begin
  for v_property in
    select property.id, nullif(btrim(property.timezone), '') as timezone
    from public.properties property
  loop
    begin
      v_today := (
        clock_timestamp() at time zone coalesce(v_property.timezone, 'UTC')
      )::date;
    exception when invalid_parameter_value then
      v_today := (clock_timestamp() at time zone 'UTC')::date;
    end;

    delete from public.scheduled_shifts shift_row
    using public.time_off_requests request_row
    where shift_row.property_id = v_property.id
      and shift_row.shift_date >= v_today
      and request_row.property_id = shift_row.property_id
      and request_row.staff_id = shift_row.staff_id
      and request_row.request_date = shift_row.shift_date
      and request_row.status = 'approved'
      and shift_row.kind = 'shift'
      and exists (
        select 1
        from public.staff staff_row
        where staff_row.id = shift_row.staff_id
          and staff_row.property_id = shift_row.property_id
          and staff_row.is_active is true
      );

    -- The old browser checkbox could deactivate a person without running the
    -- archive cleanup. Repair those ghost live assignments with the same open
    -- coverage/history semantics as the archive RPC below.
    update public.scheduled_shifts shift_row
       set staff_id = null,
           kind = 'open',
           time_off_override = false,
           status = case when shift_row.status = 'draft' then 'draft' else 'published' end,
           reason = coalesce(
             nullif(btrim(shift_row.reason), ''),
             'Coverage reopened for an inactive staff profile during schedule integrity migration'
           ),
           filled_by_history = coalesce(shift_row.filled_by_history, '[]'::jsonb)
             || jsonb_build_array(shift_row.staff_id::text)
      from public.staff staff_row
     where shift_row.property_id = v_property.id
       and shift_row.shift_date >= v_today
       and shift_row.kind = 'shift'
       and shift_row.staff_id = staff_row.id
       and staff_row.property_id = shift_row.property_id
       and staff_row.is_active is false;

    delete from public.shift_confirmations confirmation
    using public.staff staff_row
    where confirmation.property_id = v_property.id
      and confirmation.shift_date >= v_today
      and confirmation.staff_id = staff_row.id
      and staff_row.property_id = confirmation.property_id
      and staff_row.is_active is false;
  end loop;

  update public.time_off_requests request_row
     set status = 'cancelled',
         decided_at = coalesce(request_row.decided_at, clock_timestamp()),
         deny_reason = coalesce(
           nullif(btrim(request_row.deny_reason), ''),
           'Inactive staff profile repaired during schedule integrity migration'
         )
    from public.staff staff_row
   where request_row.staff_id = staff_row.id
     and request_row.property_id = staff_row.property_id
     and request_row.status = 'pending'
     and staff_row.is_active is false;

  update public.account_property_staff_links staff_link
     set is_active = false,
         deactivated_at = coalesce(staff_link.deactivated_at, clock_timestamp()),
         deactivated_by_account_id = null,
         updated_at = clock_timestamp()
    from public.staff staff_row
   where staff_link.staff_id = staff_row.id
     and staff_link.property_id = staff_row.property_id
     and staff_link.is_active is true
     and staff_row.is_active is false;

  update public.accounts account
     set staff_id = null,
         updated_at = clock_timestamp()
   where account.staff_id in (
     select staff_row.id
     from public.staff staff_row
     where staff_row.is_active is false
   );
end;
$repair_live_leave_conflicts$;

-- Assigned shifts and approved leave share a transaction-scoped advisory lock
-- for (property, staff, date). The staff row lock also serializes assignment
-- against staxis_archive_staff_member's FOR UPDATE lock. Whichever transaction
-- commits second must observe and honor the first one's state.
create or replace function public.staxis_guard_scheduled_shift_assignment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff_active boolean;
begin
  if new.kind <> 'shift' or new.staff_id is null then
    new.time_off_override := false;
    return new;
  end if;

  -- An update that leaves assignment identity and override intent untouched
  -- cannot create either race. Avoid taking locks for notes/status/hours.
  if tg_op = 'UPDATE'
     and new.property_id is not distinct from old.property_id
     and new.staff_id is not distinct from old.staff_id
     and new.shift_date is not distinct from old.shift_date
     and new.kind is not distinct from old.kind
     and new.time_off_override is not distinct from old.time_off_override
  then
    return new;
  end if;

  select staff_row.is_active into v_staff_active
  from public.staff staff_row
  where staff_row.id = new.staff_id
    and staff_row.property_id = new.property_id
  for key share;
  if not found or v_staff_active is not true then
    raise exception using
      errcode = '23514',
      message = 'Cannot assign an inactive staff member',
      constraint = 'scheduled_shifts_active_staff_guard';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'staxis:staff-schedule:'
      || new.property_id::text || ':'
      || new.staff_id::text || ':'
      || new.shift_date::text,
    0
  ));

  if new.time_off_override is false and exists (
    select 1
    from public.time_off_requests request_row
    where request_row.property_id = new.property_id
      and request_row.staff_id = new.staff_id
      and request_row.request_date = new.shift_date
      and request_row.status = 'approved'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Cannot assign a staff member on approved time off',
      constraint = 'scheduled_shifts_approved_time_off_guard';
  end if;

  return new;
end;
$$;

revoke all on function public.staxis_guard_scheduled_shift_assignment()
  from public, anon, authenticated;
grant execute on function public.staxis_guard_scheduled_shift_assignment()
  to service_role;

drop trigger if exists staxis_guard_scheduled_shift_assignment
  on public.scheduled_shifts;
create trigger staxis_guard_scheduled_shift_assignment
  before insert or update of property_id, staff_id, shift_date, kind, time_off_override
  on public.scheduled_shifts
  for each row execute function public.staxis_guard_scheduled_shift_assignment();

-- Once an archived person's assignment is historical, its identity is
-- immutable evidence. Serialize against archive through the staff-row lock,
-- then reject deletion or reassignment/opening/date moves. Harmless note/hour
-- corrections do not invoke this narrowly-columned update trigger.
create or replace function public.staxis_protect_archived_shift_history()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff_active boolean;
  v_timezone text;
  v_today date;
begin
  if old.kind <> 'shift' or old.staff_id is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select staff_row.is_active into v_staff_active
  from public.staff staff_row
  where staff_row.id = old.staff_id
    and staff_row.property_id = old.property_id
  for key share;
  if not found or v_staff_active is not false then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select nullif(btrim(property.timezone), '') into v_timezone
  from public.properties property
  where property.id = old.property_id;
  begin
    v_today := (clock_timestamp() at time zone coalesce(v_timezone, 'UTC'))::date;
  exception when invalid_parameter_value then
    v_today := (clock_timestamp() at time zone 'UTC')::date;
  end;

  if old.shift_date < v_today then
    if tg_op = 'DELETE' then
      raise exception using
        errcode = '23514',
        message = 'Cannot erase an archived historical shift assignment',
        constraint = 'scheduled_shifts_archived_history_guard';
    end if;
    if new.property_id is distinct from old.property_id
       or new.staff_id is distinct from old.staff_id
       or new.shift_date is distinct from old.shift_date
       or new.kind is distinct from old.kind
    then
      raise exception using
        errcode = '23514',
        message = 'Cannot erase an archived historical shift assignment',
        constraint = 'scheduled_shifts_archived_history_guard';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.staxis_protect_archived_shift_history()
  from public, anon, authenticated;
grant execute on function public.staxis_protect_archived_shift_history()
  to service_role;

drop trigger if exists staxis_protect_archived_shift_history
  on public.scheduled_shifts;
create trigger staxis_protect_archived_shift_history
  before delete or update of property_id, staff_id, shift_date, kind
  on public.scheduled_shifts
  for each row execute function public.staxis_protect_archived_shift_history();

-- A staff request submitted from a stale active-link snapshot follows the
-- same staff-row serialization rule as assignment. Insert-before-archive is
-- subsequently cancelled by the archive transaction; archive-before-insert
-- is rejected here.
create or replace function public.staxis_guard_time_off_request_staff()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff_active boolean;
begin
  if tg_op = 'UPDATE'
     and new.property_id is not distinct from old.property_id
     and new.staff_id is not distinct from old.staff_id
  then
    return new;
  end if;

  select staff_row.is_active into v_staff_active
  from public.staff staff_row
  where staff_row.id = new.staff_id
    and staff_row.property_id = new.property_id
  for key share;
  if not found or v_staff_active is not true then
    raise exception using
      errcode = '23514',
      message = 'Cannot request time off for an inactive staff member',
      constraint = 'time_off_requests_active_staff_guard';
  end if;

  return new;
end;
$$;

revoke all on function public.staxis_guard_time_off_request_staff()
  from public, anon, authenticated;
grant execute on function public.staxis_guard_time_off_request_staff()
  to service_role;

drop trigger if exists staxis_guard_time_off_request_staff
  on public.time_off_requests;
create trigger staxis_guard_time_off_request_staff
  before insert or update of property_id, staff_id
  on public.time_off_requests
  for each row execute function public.staxis_guard_time_off_request_staff();

-- Service-role only. Route/tool callers authorize the actor before invoking the
-- function; PostgreSQL supplies the transaction so approval and unassignment
-- can never diverge.
create or replace function public.staxis_apply_time_off_decision(
  p_property_id uuid,
  p_request_id uuid,
  p_decision text,
  p_deny_reason text,
  p_decided_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.time_off_requests%rowtype;
  v_timezone text;
  v_today date;
  v_removed integer := 0;
begin
  if p_property_id is null
     or p_request_id is null
     or p_decision not in ('approve', 'deny')
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select request_row.* into v_request
  from public.time_off_requests request_row
  where request_row.id = p_request_id
    and request_row.property_id = p_property_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_request.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided');
  end if;

  if p_decision = 'approve' then
    select nullif(btrim(property.timezone), '') into v_timezone
    from public.properties property
    where property.id = p_property_id;
    begin
      v_today := (clock_timestamp() at time zone coalesce(v_timezone, 'UTC'))::date;
    exception when invalid_parameter_value then
      v_today := (clock_timestamp() at time zone 'UTC')::date;
    end;
    if v_request.request_date < v_today then
      return jsonb_build_object('ok', false, 'reason', 'past_date');
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
      'staxis:staff-schedule:'
        || v_request.property_id::text || ':'
        || v_request.staff_id::text || ':'
        || v_request.request_date::text,
      0
    ));
  end if;

  update public.time_off_requests request_row
     set status = case when p_decision = 'approve' then 'approved' else 'denied' end,
         decided_at = clock_timestamp(),
         decided_by = p_decided_by,
         deny_reason = case
           when p_decision = 'deny' then nullif(btrim(coalesce(p_deny_reason, '')), '')
           else null
         end
   where request_row.id = v_request.id
     and request_row.property_id = p_property_id
     and request_row.status = 'pending';
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'already_decided');
  end if;

  if p_decision = 'approve' then
    delete from public.scheduled_shifts shift_row
    where shift_row.property_id = p_property_id
      and shift_row.staff_id = v_request.staff_id
      and shift_row.shift_date = v_request.request_date
      and shift_row.kind = 'shift';
    get diagnostics v_removed = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'removedShift', v_removed > 0,
    'staffId', v_request.staff_id,
    'requestDate', v_request.request_date
  );
end;
$$;

revoke all on function public.staxis_apply_time_off_decision(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_apply_time_off_decision(uuid, uuid, text, text, uuid)
  to service_role;

-- Service-role only. The manager route validates the bounded JSON payload and
-- authorizes the actor first; this function re-resolves every staff/leave fact
-- and applies the entire multi-day replacement plus its publication stamps in
-- one transaction. Any row trigger, FK, or publication failure rolls back the
-- whole board save instead of leaving a half-replaced week.
create or replace function public.staxis_replace_staff_schedule_days(
  p_property_id uuid,
  p_days jsonb,
  p_published_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_day jsonb;
  v_shift jsonb;
  v_date date;
  v_dates date[] := array[]::date[];
  v_week_start date;
  v_week_starts date[] := array[]::date[];
  v_desired_staff uuid[];
  v_staff_id uuid;
  v_department text;
  v_start_time time;
  v_end_time time;
  v_note text;
  v_override_time_off boolean;
  v_staff_active boolean;
  v_staff_found boolean;
  v_has_approved_leave boolean;
  v_existing public.scheduled_shifts%rowtype;
  v_has_existing boolean;
  v_next_override boolean;
  v_next_status text;
  v_changed boolean;
  v_delta integer;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_skipped_time_off integer := 0;
  v_skipped_unknown integer := 0;
begin
  if p_property_id is null
     or p_days is null
     or jsonb_typeof(p_days) <> 'array'
     or jsonb_array_length(p_days) not between 1 and 7
  then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  perform 1
  from public.properties property
  where property.id = p_property_id
  for key share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  for v_day in
    select day_row.value
    from jsonb_array_elements(p_days) day_row(value)
    order by day_row.value ->> 'date'
  loop
    if jsonb_typeof(v_day) <> 'object'
       or coalesce(v_day ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
    then
      raise exception 'Invalid schedule replacement payload'
        using errcode = '22023';
    end if;
    if coalesce(jsonb_typeof(v_day -> 'shifts'), 'null') <> 'array'
       or jsonb_array_length(v_day -> 'shifts') > 60
    then
      raise exception 'Invalid schedule replacement payload'
        using errcode = '22023';
    end if;

    begin
      v_date := (v_day ->> 'date')::date;
    exception when others then
      raise exception 'Invalid schedule replacement payload'
        using errcode = '22023';
    end;
    if to_char(v_date, 'YYYY-MM-DD') <> (v_day ->> 'date')
       or v_date = any(v_dates)
    then
      raise exception 'Invalid schedule replacement payload'
        using errcode = '22023';
    end if;
    v_dates := array_append(v_dates, v_date);

    -- Two board saves for the same hotel/day serialize before either computes
    -- its diff. The per-staff/date lock below is the same one used by leave
    -- approval and the assignment trigger.
    perform pg_advisory_xact_lock(hashtextextended(
      'staxis:schedule-replace:' || p_property_id::text || ':' || v_date::text,
      0
    ));
    v_desired_staff := array[]::uuid[];

    for v_shift in
      select shift_row.value
      from jsonb_array_elements(v_day -> 'shifts') shift_row(value)
    loop
      if jsonb_typeof(v_shift) <> 'object'
         or coalesce(v_shift ->> 'staffId', '') = ''
         or coalesce(v_shift ->> 'department', '') = ''
         or coalesce(v_shift ->> 'startTime', '') = ''
         or coalesce(v_shift ->> 'endTime', '') = ''
         or (
           v_shift ? 'overrideTimeOff'
           and jsonb_typeof(v_shift -> 'overrideTimeOff') <> 'boolean'
         )
      then
        raise exception 'Invalid schedule replacement payload'
          using errcode = '22023';
      end if;

      begin
        v_staff_id := (v_shift ->> 'staffId')::uuid;
        v_department := v_shift ->> 'department';
        v_start_time := (v_shift ->> 'startTime')::time;
        v_end_time := (v_shift ->> 'endTime')::time;
        v_override_time_off := coalesce((v_shift ->> 'overrideTimeOff')::boolean, false);
      exception when others then
        raise exception 'Invalid schedule replacement payload'
          using errcode = '22023';
      end;
      if v_department not in ('housekeeping', 'front_desk', 'maintenance', 'other')
         or v_start_time = v_end_time
      then
        raise exception 'Invalid schedule replacement payload'
          using errcode = '22023';
      end if;

      v_note := nullif(btrim(v_shift ->> 'note'), '');
      if v_note is not null then
        v_note := left(v_note, 300);
      end if;

      -- The route's board invariant is first accepted row per staff/day. A
      -- skipped leave row can still be followed by an explicit override for
      -- that person, matching the former in-process Map behavior.
      if v_staff_id = any(v_desired_staff) then
        continue;
      end if;

      v_staff_active := null;
      select staff_row.is_active into v_staff_active
      from public.staff staff_row
      where staff_row.id = v_staff_id
        and staff_row.property_id = p_property_id
      for key share;
      v_staff_found := found;
      if not v_staff_found or v_staff_active is not true then
        v_skipped_unknown := v_skipped_unknown + 1;
        continue;
      end if;

      perform pg_advisory_xact_lock(hashtextextended(
        'staxis:staff-schedule:'
          || p_property_id::text || ':'
          || v_staff_id::text || ':'
          || v_date::text,
        0
      ));

      v_existing := null;
      select shift_row.* into v_existing
      from public.scheduled_shifts shift_row
      where shift_row.property_id = p_property_id
        and shift_row.staff_id = v_staff_id
        and shift_row.shift_date = v_date
        and shift_row.kind = 'shift'
      order by shift_row.id
      limit 1
      for update;
      v_has_existing := found;

      select exists (
        select 1
        from public.time_off_requests request_row
        where request_row.property_id = p_property_id
          and request_row.staff_id = v_staff_id
          and request_row.request_date = v_date
          and request_row.status = 'approved'
      ) into v_has_approved_leave;

      if v_has_approved_leave
         and not v_has_existing
         and not v_override_time_off
      then
        v_skipped_time_off := v_skipped_time_off + 1;
        continue;
      end if;
      v_desired_staff := array_append(v_desired_staff, v_staff_id);

      if not v_has_existing then
        insert into public.scheduled_shifts (
          property_id, staff_id, department, shift_date, start_time, end_time,
          kind, status, note, time_off_override
        ) values (
          p_property_id, v_staff_id, v_department, v_date,
          v_start_time, v_end_time, 'shift', 'published', v_note,
          v_has_approved_leave and v_override_time_off
        );
        v_inserted := v_inserted + 1;
        continue;
      end if;

      v_next_override := v_has_approved_leave
        and (v_existing.time_off_override or v_override_time_off);
      v_changed := v_existing.department is distinct from v_department
        or v_existing.start_time is distinct from v_start_time
        or v_existing.end_time is distinct from v_end_time
        or v_existing.note is distinct from v_note
        or v_existing.time_off_override is distinct from v_next_override;
      v_next_status := case
        when not v_changed and v_existing.status in ('sent', 'confirmed')
          then v_existing.status
        else 'published'
      end;

      if v_changed or v_existing.status is distinct from v_next_status then
        update public.scheduled_shifts shift_row
           set department = v_department,
               start_time = v_start_time,
               end_time = v_end_time,
               status = v_next_status,
               note = v_note,
               time_off_override = v_next_override
         where shift_row.id = v_existing.id
           and shift_row.property_id = p_property_id;
        v_updated := v_updated + 1;
      end if;
    end loop;

    -- Omitted active/unknown assigned rows are replaced. Inactive roster rows
    -- are intentionally excluded so past archive attribution remains intact.
    delete from public.scheduled_shifts shift_row
    where shift_row.property_id = p_property_id
      and shift_row.shift_date = v_date
      and shift_row.kind = 'shift'
      and (
        shift_row.staff_id is null
        or not (shift_row.staff_id = any(v_desired_staff))
      )
      and not exists (
        select 1
        from public.staff inactive_staff
        where inactive_staff.id = shift_row.staff_id
          and inactive_staff.property_id = p_property_id
          and inactive_staff.is_active is false
      );
    get diagnostics v_delta = row_count;
    v_deleted := v_deleted + v_delta;

    v_week_start := v_date - extract(dow from v_date)::integer;
    if not (v_week_start = any(v_week_starts)) then
      v_week_starts := array_append(v_week_starts, v_week_start);
    end if;
  end loop;

  foreach v_week_start in array v_week_starts
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'staxis:schedule-publication:'
        || p_property_id::text || ':' || v_week_start::text,
      0
    ));
    insert into public.week_publications (property_id, week_start, published_by)
    select p_property_id, v_week_start, p_published_by
    where not exists (
      select 1
      from public.week_publications publication
      where publication.property_id = p_property_id
        and publication.week_start = v_week_start
    );
  end loop;

  return jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'updated', v_updated,
    'deleted', v_deleted,
    'skippedTimeOff', v_skipped_time_off,
    'skippedUnknown', v_skipped_unknown
  );
end;
$$;

revoke all on function public.staxis_replace_staff_schedule_days(uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_replace_staff_schedule_days(uuid, jsonb, uuid)
  to service_role;

comment on function public.staxis_replace_staff_schedule_days(uuid, jsonb, uuid) is
  'Atomically replace up to seven validated staff-schedule days and stamp their Sunday-keyed publication weeks. Rechecks active staff and approved leave inside the write transaction; preserves inactive historical assignments. Added 0412.';

-- Service-role only. Past assignments keep their staff FK and remain fully
-- attributable. Current/future work becomes open coverage in the same atomic
-- operation that archives the person.
create or replace function public.staxis_archive_staff_member(
  p_property_id uuid,
  p_staff_id uuid,
  p_archived_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_staff public.staff%rowtype;
  v_timezone text;
  v_today date;
  v_opened integer := 0;
  v_cancelled_confirmations integer := 0;
  v_cancelled_time_off integer := 0;
  v_deactivated_links integer := 0;
  v_cleared_legacy_links integer := 0;
begin
  if p_property_id is null or p_staff_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_request');
  end if;

  select staff_row.* into v_staff
  from public.staff staff_row
  where staff_row.id = p_staff_id
    and staff_row.property_id = p_property_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select nullif(btrim(property.timezone), '') into v_timezone
  from public.properties property
  where property.id = p_property_id;
  begin
    v_today := (clock_timestamp() at time zone coalesce(v_timezone, 'UTC'))::date;
  exception when invalid_parameter_value then
    v_today := (clock_timestamp() at time zone 'UTC')::date;
  end;

  update public.scheduled_shifts shift_row
     set staff_id = null,
         kind = 'open',
         time_off_override = false,
         status = case when shift_row.status = 'draft' then 'draft' else 'published' end,
         reason = coalesce(
           nullif(btrim(shift_row.reason), ''),
           'Coverage reopened when a staff profile was archived'
         ),
         filled_by_history = coalesce(shift_row.filled_by_history, '[]'::jsonb)
           || jsonb_build_array(v_staff.id::text)
   where shift_row.property_id = p_property_id
     and shift_row.staff_id = p_staff_id
     and shift_row.kind = 'shift'
     and shift_row.shift_date >= v_today;
  get diagnostics v_opened = row_count;

  delete from public.shift_confirmations confirmation
  where confirmation.property_id = p_property_id
    and confirmation.staff_id = p_staff_id
    and confirmation.shift_date >= v_today;
  get diagnostics v_cancelled_confirmations = row_count;

  update public.time_off_requests request_row
     set status = 'cancelled',
         decided_at = clock_timestamp(),
         decided_by = p_archived_by,
         deny_reason = coalesce(
           nullif(btrim(request_row.deny_reason), ''),
           'Staff profile archived'
         )
   where request_row.property_id = p_property_id
     and request_row.staff_id = p_staff_id
     and request_row.status = 'pending';
  get diagnostics v_cancelled_time_off = row_count;

  -- Keep both identity models consistent in the same transaction. The
  -- account-wide pointer is compatibility-only; canonical employee identity
  -- is the per-property link and must not remain active for archived staff.
  perform set_config(
    'staxis.actor_account_id',
    coalesce(p_archived_by::text, ''),
    true
  );
  update public.accounts account
     set staff_id = null,
         updated_at = clock_timestamp()
   where account.staff_id = p_staff_id;
  get diagnostics v_cleared_legacy_links = row_count;

  update public.account_property_staff_links staff_link
     set is_active = false,
         deactivated_at = clock_timestamp(),
         deactivated_by_account_id = p_archived_by,
         updated_at = clock_timestamp()
   where staff_link.property_id = p_property_id
     and staff_link.staff_id = p_staff_id
     and staff_link.is_active is true;
  get diagnostics v_deactivated_links = row_count;

  update public.staff staff_row
     set is_active = false
   where staff_row.id = p_staff_id
     and staff_row.property_id = p_property_id;

  return jsonb_build_object(
    'ok', true,
    'alreadyArchived', v_staff.is_active is false,
    'openedShifts', v_opened,
    'cancelledConfirmations', v_cancelled_confirmations,
    'cancelledTimeOffRequests', v_cancelled_time_off,
    'deactivatedLinks', v_deactivated_links,
    'clearedLegacyLinks', v_cleared_legacy_links
  );
end;
$$;

revoke all on function public.staxis_archive_staff_member(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.staxis_archive_staff_member(uuid, uuid, uuid)
  to service_role;

insert into public.applied_migrations (version, description)
values (
  '0412',
  'Staff schedule authority/privacy, atomic multi-day replacement, serialized assignment and leave, and history-preserving staff archival'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
