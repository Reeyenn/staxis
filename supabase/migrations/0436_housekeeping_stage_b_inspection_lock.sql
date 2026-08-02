-- 0436: Stage B canonical inspection lock, plan outcome, and inspection-view safety.
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

-- Keep a canonical inspection failure visible even while the workflow row is
-- still in progress. The Stage B inspection RPC writes correction_pending,
-- high priority, and notes atomically; the read model must not hide those
-- fields behind the generic in_progress status.
create or replace view public.room_work_plan_v1 as
select
  coalesce(w.id, public.housekeeping_plan_id(a.property_id, a.date, a.room_number)) as room_work_id,
  coalesce(w.legacy_task_id, w.id, public.housekeeping_plan_id(a.property_id, a.date, a.room_number)) as id,
  w.legacy_task_id,
  coalesce(w.property_id, a.property_id) as property_id,
  coalesce(w.date, a.date) as business_date,
  coalesce(w.room_number, a.room_number) as room_number,
  coalesce(w.plan_dedupe_key, coalesce(w.room_number, a.room_number) || '::' || coalesce(w.date, a.date)::text) as dedupe_key,
  case coalesce(w.plan_cleaning_type, a.cleaning_type, 'no_clean')
    when 'departure' then 'departure'
    when 'departure_deep' then 'departure_deep'
    when 'stayover' then 'stayover'
    when 'refresh' then 'refresh'
    when 'deep' then 'deep'
    when 'room_check' then 'room_check'
    when 'inspection_only' then 'inspection_only'
    when 'no_clean' then 'no_clean'
    when 'inspection' then 'inspection_only'
    when 'arrival' then 'no_clean'
    else 'no_clean'
  end as cleaning_type,
  coalesce(w.plan_priority, 'normal') as priority,
  w.plan_due_by as due_by,
  w.plan_estimated_minutes as estimated_minutes,
  coalesce(w.plan_requires_inspection, false) as requires_inspection,
  coalesce(w.plan_extras, '[]'::jsonb) as extras,
  w.plan_notes as notes,
  coalesce(w.plan_rules_fired, '[]'::jsonb) as rules_fired,
  w.plan_rule_inputs as rule_inputs,
  case
    when w.plan_status = 'correction_pending' then 'correction_pending'
    when w.status = 'in_progress' and w.is_paused then 'paused'
    when w.status = 'in_progress' then 'in_progress'
    when w.status = 'completed' and w.plan_status in (
      'inspection_pending', 'inspected_pass', 'inspected_fail',
      'correction_pending', 'correction_complete', 'check_pending',
      'check_complete'
    ) then w.plan_status
    when w.status = 'completed' then 'completed'
    when w.status = 'skipped' and w.plan_status in ('cancelled', 'superseded') then w.plan_status
    when w.status = 'skipped' then 'skipped'
    when w.status = 'refused' then coalesce(w.plan_status, 'deferred')
    else coalesce(w.plan_status, 'scheduled')
  end as status,
  w.assigned_staff_id as assignee_id,
  w.plan_source_pms_reservation_id as source_pms_reservation_id,
  w.plan_source_engine_run_id as source_engine_run_id,
  w.plan_source_property_timezone as source_property_timezone,
  coalesce(w.plan_scheduled_at, a.scheduled_time) as scheduled_at,
  w.started_at,
  w.paused_at,
  w.completed_at,
  w.inspected_at,
  coalesce(w.plan_last_evaluated_at, w.updated_at, a.updated_at) as last_evaluated_at,
  coalesce(w.created_at, a.created_at) as created_at,
  coalesce(w.updated_at, a.updated_at) as updated_at,
  w.assignment_queue_order as queue_order,
  w.assignment_assigned_at as assigned_at,
  w.assignment_assigned_by as assigned_by,
  w.assignment_assigned_by_user_id as assigned_by_user_id,
  w.assignment_reason as assignment_reason,
  w.assignment_score as assignment_score,
  a.housekeeper_name as pms_housekeeper_name,
  a.cleaning_type as pms_cleaning_type,
  a.dnd_active as pms_dnd_active,
  a.notes as pms_notes,
  a.raw as pms_raw,
  a.ingest_run_id as pms_ingest_run_id
from public.room_work w
full outer join public.pms_housekeeping_assignments a
  on a.property_id = w.property_id
 and a.date = w.date
 and a.room_number = w.room_number
where w.plan_cleaning_type is not null
   or a.id is not null;

revoke all on public.room_work_plan_v1 from public, anon, authenticated;
grant select on public.room_work_plan_v1 to service_role;

-- The 0435 function already performs the canonical mutation and locking. Keep
-- that implementation intact, but expose distinct result semantics to the
-- Stage B rules engine. A no-op on a still-mutable plan is not a skipped
-- in-progress workflow; only a non-mutable row reports that outcome.
alter function public.upsert_room_work_plan(uuid, jsonb)
  rename to _upsert_room_work_plan_stage_a;

create or replace function public.upsert_room_work_plan(
  p_property_id uuid,
  p_rows jsonb
)
returns table (
  dedupe_key text,
  task_id uuid,
  outcome text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_result record;
  v_input record;
  v_key record;
  v_work public.room_work;
  v_mutable boolean;
  v_same_payload boolean;
begin
  if jsonb_typeof(v_rows) <> 'array' then
    raise exception 'E_BAD_PLAN_ROWS: p_rows must be a JSON array' using errcode = 'check_violation';
  end if;

  -- The Stage A implementation is still the sole canonical writer. Its
  -- result rows retain input order, so pair them with the submitted rows
  -- before classifying skipped results.
  create temp table if not exists staxis_housekeeping_plan_contract_inputs (
    input_order bigint primary key,
    row_data jsonb not null
  ) on commit drop;
  truncate table pg_temp.staxis_housekeeping_plan_contract_inputs;
  insert into pg_temp.staxis_housekeeping_plan_contract_inputs(input_order, row_data)
  select value.ordinality, value.value
    from jsonb_array_elements(v_rows) with ordinality as value(value, ordinality);

  -- Keep the caller-visible writer contract explicit: the component-set lock
  -- is acquired before delegating to the preserved Stage A implementation.
  -- The delegate repeats the same idempotent lock as a defense in depth.
  for v_key in
    select input.business_date, array_agg(input.room_number order by input.room_number) as room_numbers
      from jsonb_to_recordset(v_rows) as input(room_number text, business_date date)
     where input.room_number is not null
       and input.business_date is not null
     group by input.business_date
     order by input.business_date
  loop
    perform public._lock_room_work_component_set(
      p_property_id,
      v_key.business_date,
      v_key.room_numbers
    );
  end loop;

  for v_result in
    select result.*
      from public._upsert_room_work_plan_stage_a(p_property_id, v_rows)
        with ordinality as result(dedupe_key, task_id, outcome, input_order)
     order by result.input_order
  loop
    select x.*
      into v_input
      from pg_temp.staxis_housekeeping_plan_contract_inputs input
      cross join lateral jsonb_to_record(input.row_data) as x(
        room_number text,
        business_date date,
        dedupe_key text,
        cleaning_type text,
        priority text,
        due_by timestamptz,
        estimated_minutes integer,
        requires_inspection boolean,
        extras jsonb,
        notes text,
        rules_fired jsonb,
        rule_inputs jsonb,
        status text,
        source_pms_reservation_id text,
        source_engine_run_id uuid,
        source_property_timezone text,
        scheduled_at timestamptz,
        last_evaluated_at timestamptz
      )
     where input.input_order = v_result.input_order;

    if v_result.outcome = 'skipped' then
      select *
        into v_work
        from public.room_work w
       where w.property_id = p_property_id
         and w.date = v_input.business_date
         and w.room_number = v_input.room_number;

      v_mutable := coalesce(v_work.status, 'not_started') = 'not_started'
        and not coalesce(v_work.is_paused, false)
        and coalesce(v_work.plan_status, 'scheduled') = any (array[
          'scheduled', 'ready_now', 'deferred', 'skipped', 'superseded'
        ]);
      v_same_payload := v_work.plan_dedupe_key is not distinct from coalesce(v_input.dedupe_key, v_input.room_number || '::' || v_input.business_date::text)
        and v_work.plan_cleaning_type is not distinct from v_input.cleaning_type
        and v_work.plan_priority is not distinct from v_input.priority
        and v_work.plan_due_by is not distinct from v_input.due_by
        and v_work.plan_estimated_minutes is not distinct from v_input.estimated_minutes
        and v_work.plan_requires_inspection is not distinct from coalesce(v_input.requires_inspection, false)
        and v_work.plan_extras is not distinct from coalesce(v_input.extras, '[]'::jsonb)
        and v_work.plan_notes is not distinct from v_input.notes
        and v_work.plan_rules_fired is not distinct from coalesce(v_input.rules_fired, '[]'::jsonb)
        and v_work.plan_rule_inputs is not distinct from v_input.rule_inputs
        and v_work.plan_status is not distinct from v_input.status
        and v_work.plan_source_pms_reservation_id is not distinct from v_input.source_pms_reservation_id
        and v_work.plan_source_engine_run_id is not distinct from v_input.source_engine_run_id
        and v_work.plan_source_property_timezone is not distinct from v_input.source_property_timezone
        and v_work.plan_scheduled_at is not distinct from v_input.scheduled_at
        and (
          v_input.last_evaluated_at is null
          or v_work.plan_last_evaluated_at is not distinct from v_input.last_evaluated_at
        );
      if v_mutable and v_same_payload then
        v_result.outcome := 'unchanged';
      else
        v_result.outcome := 'skipped_non_mutable';
      end if;
    end if;

    dedupe_key := v_result.dedupe_key;
    task_id := v_result.task_id;
    outcome := v_result.outcome;
    return next;
  end loop;
end;
$function$;

revoke all on function public._upsert_room_work_plan_stage_a(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.upsert_room_work_plan(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_room_work_plan(uuid, jsonb) to service_role;

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
  'Stage B canonical plan outcomes, correction visibility, and inspection lock ordering; non-destructive function replacements.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
