-- 0436: Stage B canonical inspection lock safety.
--
-- This migration is non-destructive. It follows the live 0434/0435 expand
-- release and precedes the future Stage C contract migration (0437). Legacy
-- cleaning_tasks/hk_assignments tables and their one-way bridges remain
-- physical and writable. Component/audit triggers remain dormant until a
-- later, explicitly approved activation boundary.
--
-- The canonical inspection operation first discovers every affected
-- property/date/room key without a room_work row lock, then invokes the
-- existing component-set helper in ascending date order. This closes the
-- two-date advisory-lock inversion without changing the inspection result,
-- authorization, retry, or side-effect contract.

begin;

create or replace function public.complete_inspection_atomic_canonical(
  p_inspection_id              uuid,
  p_property_id                uuid,
  p_result                     text,
  p_failed_items               jsonb,
  p_passed_items               jsonb,
  p_notes                      text,
  p_escalated                  boolean,
  p_escalation_reason          text,
  p_correction_notice_sent_at  timestamptz,
  p_correction_note            text
)
returns public.inspections
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_row public.inspections;
  v_date date;
  v_task_date date;
  v_task_room text;
  v_plan_work public.room_work;
  v_task_id uuid;
  v_count integer;
  v_has_plan_work boolean := false;
  v_has_pms_plan boolean := false;
begin
  if p_result not in ('pass', 'fail') then
    raise exception 'E_BAD_RESULT: p_result must be pass or fail, got %', p_result
      using errcode = 'check_violation';
  end if;

  select * into v_row
    from public.inspections
   where id = p_inspection_id
   order by id
   limit 1
   for update;
  if not found then
    raise exception 'E_NOT_FOUND: inspection % not found', p_inspection_id
      using errcode = 'no_data_found';
  end if;
  if v_row.property_id is distinct from p_property_id then
    raise exception 'E_NOT_FOUND: inspection % does not belong to property %', p_inspection_id, p_property_id
      using errcode = 'no_data_found';
  end if;
  if v_row.result <> 'in_progress' then
    raise exception 'E_ALREADY_FINALIZED: inspection % already %', p_inspection_id, v_row.result
      using errcode = 'invalid_parameter_value';
  end if;

  update public.inspections
     set result = p_result,
         failed_items = coalesce(p_failed_items, '[]'::jsonb),
         passed_items = coalesce(p_passed_items, '[]'::jsonb),
         notes = p_notes,
         escalated = coalesce(p_escalated, false),
         escalation_reason = p_escalation_reason,
         correction_notice_sent_at = p_correction_notice_sent_at,
         completed_at = now()
   where id = p_inspection_id
   returning * into v_row;

  -- Discover the inspection room's effective work date without locking a
  -- room_work row. This preserves the old "latest date on or before the
  -- inspection date" rule and keeps the date available for the global lock
  -- order below.
  if v_row.room_number is not null then
    select max(candidate_date) into v_date
      from (
        select w.date as candidate_date
          from public.room_work w
         where w.property_id = p_property_id
           and w.room_number = v_row.room_number
        union all
        select a.date as candidate_date
          from public.pms_housekeeping_assignments a
         where a.property_id = p_property_id
           and a.room_number = v_row.room_number
      ) candidates
     where candidate_date <= coalesce(v_row.started_at::date, current_date);
    v_date := coalesce(v_date, v_row.started_at::date, current_date);
  end if;

  -- Discover the linked canonical task room/date without locking it. The
  -- deterministic pick is the same one used by the 0435 operation.
  if v_row.cleaning_task_id is not null then
    select w.date, w.room_number
      into v_task_date, v_task_room
      from public.room_work w
     where w.property_id = p_property_id
       and (w.legacy_task_id = v_row.cleaning_task_id or w.id = v_row.cleaning_task_id)
     order by w.date desc, w.id
     limit 1;
    v_has_plan_work := found;

    if not v_has_plan_work then
      select a.date, a.room_number
        into v_task_date, v_task_room
        from public.pms_housekeeping_assignments a
       where a.property_id = p_property_id
         and public.housekeeping_plan_id(a.property_id, a.date, a.room_number) = v_row.cleaning_task_id
       order by a.date desc, a.room_number
       limit 1;
      v_has_pms_plan := found;
    end if;
  end if;

  -- Lock every involved component set before the first room_work mutation.
  -- When both effects share a date, one helper call covers both exact parent
  -- rooms and their direct children. When dates differ, ascending dates are
  -- always acquired first, so reverse inspection/task discovery cannot invert
  -- the advisory-lock order.
  if v_date is not null and v_task_date is not null and v_date = v_task_date then
    perform public._lock_room_work_component_set(
      p_property_id,
      v_date,
      array[v_row.room_number, v_task_room]::text[]
    );
  elsif v_date is not null and (v_task_date is null or v_date < v_task_date) then
    perform public._lock_room_work_component_set(
      p_property_id,
      v_date,
      array[v_row.room_number]::text[]
    );
    if v_task_date is not null then
      perform public._lock_room_work_component_set(
        p_property_id,
        v_task_date,
        array[v_task_room]::text[]
      );
    end if;
  elsif v_task_date is not null and (v_date is null or v_task_date < v_date) then
    perform public._lock_room_work_component_set(
      p_property_id,
      v_task_date,
      array[v_task_room]::text[]
    );
    if v_date is not null then
      perform public._lock_room_work_component_set(
        p_property_id,
        v_date,
        array[v_row.room_number]::text[]
      );
    end if;
  end if;

  -- Preserve the canonical operation's existing inspection-room behavior.
  -- The locks above mean this insert/upsert cannot race an assignment or
  -- component completion on either affected date.
  if v_row.room_number is not null then
    if p_result = 'pass' then
      insert into public.room_work (
        property_id, date, room_number, status,
        completed_at, inspected_at, is_paused
      ) values (
        p_property_id, v_date, v_row.room_number, 'completed', now(), now(), false
      )
      on conflict (property_id, date, room_number) do update
        set status = 'completed',
            completed_at = coalesce(public.room_work.completed_at, excluded.completed_at),
            inspected_at = excluded.inspected_at,
            is_paused = false,
            paused_at = null;
    else
      insert into public.room_work (
        property_id, date, room_number, status,
        completed_at, inspected_at, issue_note, is_paused
      ) values (
        p_property_id, v_date, v_row.room_number, 'not_started', null, null, p_correction_note, false
      )
      on conflict (property_id, date, room_number) do update
        set status = 'not_started',
            completed_at = null,
            inspected_at = null,
            issue_note = excluded.issue_note,
            is_paused = false,
            paused_at = null;
    end if;
  end if;

  -- Resolve and lock the linked task row again after the component-set
  -- protocol. A PMS-only plan is materialized with the deterministic canonical
  -- id exactly as in 0435.
  if v_row.cleaning_task_id is not null then
    if v_task_date is null or v_task_room is null then
      raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning plan % does not belong to property %', v_row.cleaning_task_id, p_property_id
        using errcode = 'no_data_found';
    end if;

    if not v_has_plan_work and v_has_pms_plan then
      insert into public.room_work (
        id, property_id, date, room_number, plan_status
      ) values (
        public.housekeeping_plan_id(p_property_id, v_task_date, v_task_room),
        p_property_id, v_task_date, v_task_room, 'scheduled'
      ) on conflict (property_id, date, room_number) do nothing;
    end if;

    select * into v_plan_work
      from public.room_work w
     where w.property_id = p_property_id
       and w.date = v_task_date
       and w.room_number = v_task_room
     for update;
    if not found then
      raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning plan % disappeared during lock acquisition', v_row.cleaning_task_id
        using errcode = 'no_data_found';
    end if;

    v_task_id := v_plan_work.id;
    if p_result = 'pass' then
      update public.room_work
         set plan_status = 'inspected_pass',
             inspected_at = now()
       where property_id = p_property_id
         and id = v_task_id;
    else
      update public.room_work
         set plan_status = 'correction_pending',
             plan_priority = 'high',
             plan_notes = p_correction_note,
             issue_note = p_correction_note
       where property_id = p_property_id
         and id = v_task_id;
    end if;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning plan % does not belong to property %', v_row.cleaning_task_id, p_property_id
        using errcode = 'no_data_found';
    end if;
  end if;

  if v_row.parent_inspection_id is not null then
    update public.inspections
       set recheck_inspection_id = v_row.id
     where id = v_row.parent_inspection_id
       and property_id = p_property_id;
  end if;

  return v_row;
end;
$function$;

revoke all on function public.complete_inspection_atomic_canonical(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.complete_inspection_atomic_canonical(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) to service_role;

insert into public.applied_migrations (version, description)
values (
  '0436',
  'Stage B canonical inspection lock ordering; non-destructive function replacement.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
