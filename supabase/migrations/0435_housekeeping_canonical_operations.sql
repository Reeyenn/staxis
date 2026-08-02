-- 0435: add canonical housekeeping operations without breaking the deployed
-- legacy application.
--
-- This is the expand stage. cleaning_tasks and hk_assignments remain physical
-- writable tables, and their old readers/writers keep working until the exact
-- canonical application is live. Legacy writes flow one way into room_work via
-- bounded AFTER triggers below. There is intentionally no reverse trigger.

begin;

-- One read model for all current plan facts. A room_work row with no plan
-- metadata is intentionally omitted unless the PMS also has a plan row; this
-- keeps component-only workflow rows out of the manager task board.
create or replace view public.room_work_plan_v1 as
select
  coalesce(w.id, public.housekeeping_plan_id(a.property_id, a.date, a.room_number)) as room_work_id,
  coalesce(w.legacy_task_id, w.id, public.housekeeping_plan_id(a.property_id, a.date, a.room_number)) as id,
  w.legacy_task_id,
  coalesce(w.property_id, a.property_id) as property_id,
  coalesce(w.date, a.date) as business_date,
  coalesce(w.room_number, a.room_number) as room_number,
  coalesce(w.plan_dedupe_key, coalesce(w.room_number, a.room_number) || '::' || coalesce(w.date, a.date)::text) as dedupe_key,
  coalesce(w.plan_cleaning_type, a.cleaning_type, 'no_clean') as cleaning_type,
  coalesce(w.plan_priority, 'normal') as priority,
  w.plan_due_by as due_by,
  w.plan_estimated_minutes as estimated_minutes,
  coalesce(w.plan_requires_inspection, false) as requires_inspection,
  coalesce(w.plan_extras, '[]'::jsonb) as extras,
  w.plan_notes as notes,
  coalesce(w.plan_rules_fired, '[]'::jsonb) as rules_fired,
  w.plan_rule_inputs as rule_inputs,
  case
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

-- During the old-app window, the physical legacy tables remain writable.
-- These triggers are a bounded one-way bridge: every old write locks and
-- reconciles its canonical room_work row in the same transaction. Canonical
-- writes never touch the legacy tables, so this cannot become bidirectional.
create or replace function public._legacy_cleaning_task_to_room_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_work public.room_work;
  v_owner public.room_work;
  v_active_staff uuid;
  v_workflow_status text;
  v_has_work boolean;
begin
  if tg_op = 'UPDATE'
     and (
       old.id is distinct from new.id
       or old.property_id is distinct from new.property_id
       or old.business_date is distinct from new.business_date
       or old.room_number is distinct from new.room_number
     ) then
    raise exception
      'E_LEGACY_IDENTITY_MUTATION: cleaning task identity cannot change during canonical cutover'
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.property_id is null
     or new.business_date is null
     or new.room_number is null
     or new.id is null then
    raise exception
      'E_LEGACY_PLAN_AMBIGUOUS: property, date, room, and task id are required'
      using errcode = 'not_null_violation';
  end if;

  -- The historical id and the natural room/date key must identify the same
  -- canonical row. Any collision is safer as a failed legacy write than as a
  -- second plan or a silent cross-property move.
  select *
    into v_owner
    from public.room_work w
   where w.legacy_task_id = new.id
   for update;
  if found and (
    v_owner.property_id is distinct from new.property_id
    or v_owner.date is distinct from new.business_date
    or v_owner.room_number is distinct from new.room_number
  ) then
    raise exception
      'E_LEGACY_PLAN_AMBIGUOUS: task id % maps to another property/date/room',
      new.id
      using errcode = 'integrity_constraint_violation';
  end if;

  select *
    into v_work
    from public.room_work w
   where w.property_id = new.property_id
     and w.date = new.business_date
     and w.room_number = new.room_number
   for update;
  v_has_work := found;

  if v_has_work and v_work.legacy_task_id is not null
     and v_work.legacy_task_id is distinct from new.id then
    raise exception
      'E_LEGACY_PLAN_AMBIGUOUS: property/date/room already belongs to task %',
      v_work.legacy_task_id
      using errcode = 'integrity_constraint_violation';
  end if;

  if exists (
    select 1
      from public.room_work w
     where w.property_id = new.property_id
       and w.plan_dedupe_key = new.dedupe_key
       and (w.date, w.room_number) is distinct from (new.business_date, new.room_number)
  ) then
    raise exception
      'E_LEGACY_PLAN_AMBIGUOUS: duplicate dedupe key % in property %',
      new.dedupe_key, new.property_id
      using errcode = 'unique_violation';
  end if;

  v_workflow_status := case
    when v_has_work and v_work.status in ('in_progress', 'completed', 'refused', 'skipped')
      then v_work.status
    when new.status in ('in_progress', 'paused') then 'in_progress'
    when new.status = 'completed' then 'completed'
    when new.status in ('skipped', 'cancelled', 'superseded') then 'skipped'
    else coalesce(v_work.status, 'not_started')
  end;

  perform set_config('staxis.housekeeping_legacy_bridge', 'on', true);
  if not v_has_work then
    insert into public.room_work (
      id, legacy_task_id, property_id, date, room_number,
      plan_dedupe_key, plan_cleaning_type, plan_priority,
      plan_due_by, plan_estimated_minutes, plan_requires_inspection,
      plan_extras, plan_notes, plan_rules_fired, plan_rule_inputs,
      plan_status, plan_source_pms_reservation_id, plan_source_engine_run_id,
      plan_source_property_timezone, plan_scheduled_at, plan_last_evaluated_at,
      started_at, paused_at, completed_at, inspected_at, is_paused, status,
      created_at
    ) values (
      public.housekeeping_plan_id(new.property_id, new.business_date, new.room_number),
      new.id, new.property_id, new.business_date, new.room_number,
      new.dedupe_key, new.cleaning_type, new.priority,
      new.due_by, new.estimated_minutes, new.requires_inspection,
      new.extras, new.notes, new.rules_fired, new.rule_inputs,
      new.status, new.source_pms_reservation_id, new.source_engine_run_id,
      new.source_property_timezone, new.scheduled_at, new.last_evaluated_at,
      case when new.status in ('in_progress', 'paused') then new.started_at end,
      case when new.status = 'paused' then new.paused_at end,
      case when new.status = 'completed' then new.completed_at end,
      case when new.status in ('inspected_pass', 'inspected_fail') then new.inspected_at end,
      new.status = 'paused', v_workflow_status, new.created_at
    )
    returning * into v_work;
  else
    update public.room_work
       set legacy_task_id = new.id,
           plan_dedupe_key = new.dedupe_key,
           plan_cleaning_type = new.cleaning_type,
           plan_priority = new.priority,
           plan_due_by = new.due_by,
           plan_estimated_minutes = new.estimated_minutes,
           plan_requires_inspection = new.requires_inspection,
           plan_extras = new.extras,
           plan_notes = new.notes,
           plan_rules_fired = new.rules_fired,
           plan_rule_inputs = new.rule_inputs,
           plan_status = new.status,
           plan_source_pms_reservation_id = new.source_pms_reservation_id,
           plan_source_engine_run_id = new.source_engine_run_id,
           plan_source_property_timezone = new.source_property_timezone,
           plan_scheduled_at = new.scheduled_at,
           plan_last_evaluated_at = new.last_evaluated_at,
           started_at = coalesce(v_work.started_at, new.started_at),
           paused_at = case
             when new.status = 'paused' then coalesce(new.paused_at, v_work.paused_at)
             else v_work.paused_at
           end,
           completed_at = coalesce(v_work.completed_at, new.completed_at),
           inspected_at = coalesce(v_work.inspected_at, new.inspected_at),
           is_paused = case
             when v_work.status in ('completed', 'refused', 'skipped') then v_work.is_paused
             when new.status = 'paused' then true
             when new.status in ('in_progress', 'completed', 'skipped', 'cancelled', 'superseded') then false
             else v_work.is_paused
           end,
           status = v_workflow_status
     where property_id = new.property_id
       and date = new.business_date
       and room_number = new.room_number
    returning * into v_work;
  end if;
  perform set_config('staxis.housekeeping_legacy_bridge', 'off', true);

  -- assignee_id is a legacy cache. The proven old writers change it only
  -- after changing hk_assignments; the assignment trigger above/below is the
  -- canonical assignment seam. A null cache never erases an active legacy
  -- assignment that is still present, while a non-null mismatch fails closed.
  select a.housekeeper_id
    into v_active_staff
    from public.hk_assignments a
   where a.property_id = new.property_id
     and a.cleaning_task_id = new.id
     and a.is_active
   order by a.assigned_at desc, a.created_at desc, a.id desc
   limit 1;
  if new.assignee_id is not null
     and v_active_staff is not null
     and v_active_staff is distinct from new.assignee_id then
    raise exception
      'E_LEGACY_ASSIGNMENT_MISMATCH: task cache does not match active assignment'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.assignee_id is null and v_active_staff is null
     and v_work.assigned_staff_id is not null then
    perform set_config('staxis.housekeeping_legacy_bridge', 'on', true);
    update public.room_work
       set assignment_history = assignment_history || jsonb_build_array(
         jsonb_build_object(
           'event', 'legacy_cache_unassigned',
           'is_active', false,
           'housekeeper_id', assigned_staff_id,
           'queue_order', assignment_queue_order,
           'assigned_at', assignment_assigned_at,
           'assigned_by', assignment_assigned_by,
           'assigned_by_user_id', assignment_assigned_by_user_id,
           'reason', assignment_reason,
           'score', assignment_score,
           'changed_at', now()
         )
       ),
           assigned_staff_id = null,
           assigned_source = null,
           assignment_queue_order = 0,
           assignment_assigned_at = null,
           assignment_assigned_by = null,
           assignment_assigned_by_user_id = null,
           assignment_reason = null,
           assignment_score = null
     where property_id = new.property_id
       and date = new.business_date
       and room_number = new.room_number;
    perform set_config('staxis.housekeeping_legacy_bridge', 'off', true);
  end if;

  return new;
end;
$function$;

create or replace function public._legacy_hk_assignment_to_room_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_task record;
  v_staff record;
  v_work public.room_work;
  v_seen boolean;
  v_seen_active boolean;
  v_seen_inactive boolean;
  v_clear boolean;
begin
  select t.property_id, t.business_date, t.room_number
    into v_task
    from public.cleaning_tasks t
   where t.id = new.cleaning_task_id;
  if not found then
    raise exception
      'E_LEGACY_ASSIGNMENT_ORPHAN: cleaning task % does not exist',
      new.cleaning_task_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_task.property_id is distinct from new.property_id then
    raise exception
      'E_LEGACY_ASSIGNMENT_CROSS_PROPERTY: assignment and task properties differ'
      using errcode = 'foreign_key_violation';
  end if;

  select s.property_id, s.department, coalesce(s.is_active, true) as is_active
    into v_staff
    from public.staff s
   where s.id = new.housekeeper_id;
  if not found or v_staff.property_id is distinct from new.property_id then
    raise exception
      'E_LEGACY_ASSIGNMENT_CROSS_PROPERTY: housekeeper is not at the task property'
      using errcode = 'foreign_key_violation';
  end if;
  if new.is_active and (
    v_staff.department is distinct from 'housekeeping'
    or v_staff.is_active = false
  ) then
    raise exception
      'E_LEGACY_ASSIGNMENT_INVALID_TARGET: active assignment target is not an active housekeeper'
      using errcode = 'check_violation';
  end if;

  select *
    into v_work
    from public.room_work w
   where w.property_id = new.property_id
     and w.date = v_task.business_date
     and w.room_number = v_task.room_number
   for update;
  if not found or (
    v_work.legacy_task_id is not null
    and v_work.legacy_task_id is distinct from new.cleaning_task_id
  ) then
    raise exception
      'E_LEGACY_ASSIGNMENT_AMBIGUOUS: canonical room-work row is missing or belongs to another task'
      using errcode = 'integrity_constraint_violation';
  end if;

  select exists (
    select 1
      from jsonb_array_elements(coalesce(v_work.assignment_history, '[]'::jsonb)) h
     where h->>'id' = new.id::text
  ) into v_seen;
  select exists (
    select 1
      from jsonb_array_elements(coalesce(v_work.assignment_history, '[]'::jsonb)) h
     where h->>'id' = new.id::text
       and coalesce((h->>'is_active')::boolean, false)
  ) into v_seen_active;
  select exists (
    select 1
      from jsonb_array_elements(coalesce(v_work.assignment_history, '[]'::jsonb)) h
     where h->>'id' = new.id::text
       and coalesce((h->>'is_active')::boolean, false) = false
  ) into v_seen_inactive;

  v_clear := not new.is_active
    and v_seen_active
    and v_work.assigned_staff_id = new.housekeeper_id;

  perform set_config('staxis.housekeeping_legacy_bridge', 'on', true);
  if new.is_active then
    update public.room_work
       set assignment_history =
         case
           when v_work.assigned_staff_id is not null
                and v_work.assigned_staff_id is distinct from new.housekeeper_id
             then assignment_history || jsonb_build_array(jsonb_build_object(
               'event', 'superseded',
               'is_active', false,
               'housekeeper_id', assigned_staff_id,
               'queue_order', assignment_queue_order,
               'assigned_at', assignment_assigned_at,
               'assigned_by', assignment_assigned_by,
               'assigned_by_user_id', assignment_assigned_by_user_id,
               'reason', assignment_reason,
               'score', assignment_score,
               'changed_at', now()
             ))
           else assignment_history
         end
         || case when not v_seen or not v_seen_active then jsonb_build_array(
           jsonb_build_object(
             'id', new.id,
             'property_id', new.property_id,
             'cleaning_task_id', new.cleaning_task_id,
             'housekeeper_id', new.housekeeper_id,
             'queue_order', new.queue_order,
             'is_active', true,
             'assigned_at', new.assigned_at,
             'assigned_by', new.assigned_by,
             'assigned_by_user_id', new.assigned_by_user_id,
             'reason', new.reason,
             'score', new.score,
             'created_at', new.created_at,
             'updated_at', new.updated_at,
             'event', case when v_seen_active then 'updated' else 'assigned' end
           )
         ) else '[]'::jsonb end,
           assigned_staff_id = new.housekeeper_id,
           assigned_source = case when new.assigned_by = 'auto' then 'auto' else 'manager' end,
           assignment_queue_order = new.queue_order,
           assignment_assigned_at = new.assigned_at,
           assignment_assigned_by = new.assigned_by,
           assignment_assigned_by_user_id = new.assigned_by_user_id,
           assignment_reason = new.reason,
           assignment_score = new.score
     where property_id = new.property_id
       and date = v_task.business_date
       and room_number = v_task.room_number;
  elsif not v_seen_inactive then
    update public.room_work
       set assignment_history = assignment_history || jsonb_build_array(
         jsonb_build_object(
           'id', new.id,
           'property_id', new.property_id,
           'cleaning_task_id', new.cleaning_task_id,
           'housekeeper_id', new.housekeeper_id,
           'queue_order', new.queue_order,
           'is_active', false,
           'assigned_at', new.assigned_at,
           'assigned_by', new.assigned_by,
           'assigned_by_user_id', new.assigned_by_user_id,
           'reason', new.reason,
           'score', new.score,
           'created_at', new.created_at,
           'updated_at', new.updated_at,
           'event', 'deactivated'
         )
       ),
           assigned_staff_id = case when v_clear then null else assigned_staff_id end,
           assigned_source = case when v_clear then null else assigned_source end,
           assignment_queue_order = case when v_clear then 0 else assignment_queue_order end,
           assignment_assigned_at = case when v_clear then null else assignment_assigned_at end,
           assignment_assigned_by = case when v_clear then null else assignment_assigned_by end,
           assignment_assigned_by_user_id = case when v_clear then null else assignment_assigned_by_user_id end,
           assignment_reason = case when v_clear then null else assignment_reason end,
           assignment_score = case when v_clear then null else assignment_score end
     where property_id = new.property_id
       and date = v_task.business_date
       and room_number = v_task.room_number;
  end if;
  perform set_config('staxis.housekeeping_legacy_bridge', 'off', true);

  return new;
end;
$function$;

revoke all on function public._legacy_cleaning_task_to_room_work() from public, anon, authenticated;
revoke all on function public._legacy_hk_assignment_to_room_work() from public, anon, authenticated;
grant execute on function public._legacy_cleaning_task_to_room_work() to service_role;
grant execute on function public._legacy_hk_assignment_to_room_work() to service_role;

drop trigger if exists trg_legacy_cleaning_task_to_room_work on public.cleaning_tasks;
create trigger trg_legacy_cleaning_task_to_room_work
  after insert or update on public.cleaning_tasks
  for each row execute function public._legacy_cleaning_task_to_room_work();

drop trigger if exists trg_legacy_hk_assignment_to_room_work on public.hk_assignments;
create trigger trg_legacy_hk_assignment_to_room_work
  after insert or update on public.hk_assignments
  for each row execute function public._legacy_hk_assignment_to_room_work();

-- Rules-engine persistence. The caller submits a property-scoped batch; the
-- function locks each natural row and refuses to overwrite workflow that has
-- started or finished. A missing room_work row is materialized, including a
-- PMS-only row that was visible through the canonical view.
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
  v_row record;
  v_work public.room_work;
  v_task_id uuid;
  v_outcome text;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'E_BAD_PLAN_ROWS: p_rows must be a JSON array' using errcode = 'check_violation';
  end if;

  for v_row in
    select *
      from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
        property_id uuid,
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
  loop
    if v_row.property_id is distinct from p_property_id then
      raise exception 'E_PROPERTY_MISMATCH: plan row is not in property %', p_property_id
        using errcode = 'invalid_parameter_value';
    end if;
    if v_row.room_number is null or v_row.business_date is null then
      raise exception 'E_BAD_PLAN_ROW: room_number and business_date are required'
        using errcode = 'not_null_violation';
    end if;
    if v_row.cleaning_type is null or v_row.priority is null or v_row.status is null then
      raise exception 'E_BAD_PLAN_ROW: cleaning_type, priority, and status are required'
        using errcode = 'not_null_violation';
    end if;

    select * into v_work
      from public.room_work w
     where w.property_id = p_property_id
       and w.date = v_row.business_date
       and w.room_number = v_row.room_number
     for update;

    if not found then
      insert into public.room_work (
        id, property_id, date, room_number,
        plan_dedupe_key, plan_cleaning_type, plan_priority,
        plan_due_by, plan_estimated_minutes, plan_requires_inspection,
        plan_extras, plan_notes, plan_rules_fired, plan_rule_inputs,
        plan_status, plan_source_pms_reservation_id, plan_source_engine_run_id,
        plan_source_property_timezone, plan_scheduled_at, plan_last_evaluated_at,
        status
      ) values (
        public.housekeeping_plan_id(p_property_id, v_row.business_date, v_row.room_number),
        p_property_id, v_row.business_date, v_row.room_number,
        coalesce(v_row.dedupe_key, v_row.room_number || '::' || v_row.business_date::text),
        v_row.cleaning_type, v_row.priority, v_row.due_by, v_row.estimated_minutes,
        coalesce(v_row.requires_inspection, false), coalesce(v_row.extras, '[]'::jsonb),
        v_row.notes, coalesce(v_row.rules_fired, '[]'::jsonb), v_row.rule_inputs,
        v_row.status, v_row.source_pms_reservation_id, v_row.source_engine_run_id,
        v_row.source_property_timezone, v_row.scheduled_at,
        coalesce(v_row.last_evaluated_at, now()), 'not_started'
      ) returning * into v_work;
      v_outcome := 'inserted';
    elsif coalesce(v_work.status, 'not_started') = 'not_started'
      and not v_work.is_paused
      and coalesce(v_work.plan_status, 'scheduled') = any (array[
        'scheduled', 'ready_now', 'deferred', 'skipped', 'superseded'
      ]) then
      update public.room_work
         set plan_dedupe_key = coalesce(v_row.dedupe_key, v_row.room_number || '::' || v_row.business_date::text),
             plan_cleaning_type = v_row.cleaning_type,
             plan_priority = v_row.priority,
             plan_due_by = v_row.due_by,
             plan_estimated_minutes = v_row.estimated_minutes,
             plan_requires_inspection = coalesce(v_row.requires_inspection, false),
             plan_extras = coalesce(v_row.extras, '[]'::jsonb),
             plan_notes = v_row.notes,
             plan_rules_fired = coalesce(v_row.rules_fired, '[]'::jsonb),
             plan_rule_inputs = v_row.rule_inputs,
             plan_status = v_row.status,
             plan_source_pms_reservation_id = v_row.source_pms_reservation_id,
             plan_source_engine_run_id = v_row.source_engine_run_id,
             plan_source_property_timezone = v_row.source_property_timezone,
             plan_scheduled_at = v_row.scheduled_at,
             plan_last_evaluated_at = coalesce(v_row.last_evaluated_at, now())
       where property_id = p_property_id
         and date = v_row.business_date
         and room_number = v_row.room_number
       returning * into v_work;
      v_outcome := 'updated';
    else
      update public.room_work
         set plan_last_evaluated_at = coalesce(v_row.last_evaluated_at, now())
       where property_id = p_property_id
         and date = v_row.business_date
         and room_number = v_row.room_number
       returning * into v_work;
      v_outcome := 'skipped';
    end if;

    v_task_id := coalesce(v_work.legacy_task_id, v_work.id);
    dedupe_key := coalesce(v_work.plan_dedupe_key, v_row.dedupe_key);
    task_id := v_task_id;
    outcome := v_outcome;
    return next;
  end loop;
end;
$function$;

revoke all on function public.upsert_room_work_plan(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_room_work_plan(uuid, jsonb) to service_role;

create or replace function public.touch_room_work_plan(
  p_property_id uuid,
  p_date date,
  p_dedupe_keys text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_count integer;
begin
  update public.room_work
     set plan_last_evaluated_at = now()
   where property_id = p_property_id
     and date = p_date
     and plan_dedupe_key = any(coalesce(p_dedupe_keys, array[]::text[]));
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function public.touch_room_work_plan(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public.touch_room_work_plan(uuid, date, text[]) to service_role;

-- Shared assignment operation for manager reassign and auto-assign. The
-- only_if_unassigned flag prevents a cron decision from clobbering a manager
-- assignment that arrived after the runner read the board.
create or replace function public.assign_room_work_atomic(
  p_property_id uuid,
  p_task_id uuid,
  p_to_housekeeper_id uuid,
  p_assigned_by_user uuid,
  p_reason text,
  p_queue_order integer default 0,
  p_score numeric default null,
  p_only_if_unassigned boolean default false,
  p_assigned_by text default null
)
returns table (
  task_id uuid,
  assignee_id uuid,
  noop boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_work public.room_work;
  v_pms record;
  v_status text;
  v_task_id uuid;
  v_source text;
  v_by text;
begin
  select * into v_work
    from public.room_work w
   where w.property_id = p_property_id
     and (w.id = p_task_id or w.legacy_task_id = p_task_id)
   for update;

  if not found then
    select a.date, a.room_number, a.cleaning_type, a.scheduled_time, a.notes
      into v_pms
      from public.pms_housekeeping_assignments a
     where a.property_id = p_property_id
       and public.housekeeping_plan_id(a.property_id, a.date, a.room_number) = p_task_id;

    if not found then
      raise exception 'task not found' using errcode = 'P0002';
    end if;

    insert into public.room_work (
      id, property_id, date, room_number, plan_status, plan_scheduled_at
    ) values (
      public.housekeeping_plan_id(p_property_id, v_pms.date, v_pms.room_number),
      p_property_id, v_pms.date, v_pms.room_number, 'scheduled', v_pms.scheduled_time
    ) on conflict (property_id, date, room_number) do nothing;

    select * into v_work
      from public.room_work w
     where w.property_id = p_property_id
       and w.date = v_pms.date
       and w.room_number = v_pms.room_number
     for update;
  end if;

  v_task_id := coalesce(v_work.legacy_task_id, v_work.id);
  v_status := case
    when v_work.status = 'in_progress' and v_work.is_paused then 'paused'
    when v_work.status = 'in_progress' then 'in_progress'
    when v_work.status = 'completed' then 'completed'
    when v_work.status = 'skipped' then 'skipped'
    when v_work.status = 'refused' then coalesce(v_work.plan_status, 'deferred')
    else coalesce(v_work.plan_status, 'scheduled')
  end;

  if v_status not in ('scheduled', 'ready_now', 'deferred') then
    raise exception 'task not reassignable in status %', v_status using errcode = 'P0001';
  end if;

  select s.property_id, s.department, coalesce(s.is_active, true)
    into v_pms
    from public.staff s
   where s.id = p_to_housekeeper_id;
  if not found then
    raise exception 'housekeeper not found' using errcode = 'P0002';
  end if;
  if v_pms.property_id is distinct from p_property_id then
    raise exception 'housekeeper not at property' using errcode = 'P0001';
  end if;
  if v_pms.department is distinct from 'housekeeping' then
    raise exception 'target is not housekeeping' using errcode = 'P0001';
  end if;
  if v_pms.is_active = false then
    raise exception 'housekeeper inactive' using errcode = 'P0001';
  end if;

  if v_work.assigned_staff_id = p_to_housekeeper_id
     or (p_only_if_unassigned and v_work.assigned_staff_id is not null) then
    return query select v_task_id, v_work.assigned_staff_id, true;
    return;
  end if;

  v_by := coalesce(p_assigned_by, case when p_only_if_unassigned then 'auto' else 'manual' end);
  if v_by not in ('auto', 'manual', 'rebalance') then
    raise exception 'invalid assignment source %', v_by using errcode = 'check_violation';
  end if;
  v_source := case when v_by = 'auto' then 'auto' else 'manager' end;

  update public.room_work
     set assignment_history = case
           when assigned_staff_id is null then assignment_history
           else assignment_history || jsonb_build_array(jsonb_build_object(
             'event', 'superseded',
             'is_active', false,
             'housekeeper_id', assigned_staff_id,
             'queue_order', assignment_queue_order,
             'assigned_at', assignment_assigned_at,
             'assigned_by', assignment_assigned_by,
             'assigned_by_user_id', assignment_assigned_by_user_id,
             'reason', assignment_reason,
             'score', assignment_score,
             'changed_at', now()
           ))
         end || jsonb_build_array(jsonb_build_object(
           'event', 'assigned',
           'is_active', true,
           'housekeeper_id', p_to_housekeeper_id,
           'queue_order', greatest(coalesce(p_queue_order, 0), 0),
           'assigned_at', now(),
           'assigned_by', v_by,
           'assigned_by_user_id', p_assigned_by_user,
           'reason', coalesce(p_reason, 'assigned'),
           'score', p_score,
           'changed_at', now()
         )),
         assigned_staff_id = p_to_housekeeper_id,
         assigned_source = v_source,
         assignment_queue_order = greatest(coalesce(p_queue_order, 0), 0),
         assignment_assigned_at = now(),
         assignment_assigned_by = v_by,
         assignment_assigned_by_user_id = p_assigned_by_user,
         assignment_reason = coalesce(p_reason, 'assigned'),
         assignment_score = p_score
   where property_id = p_property_id
     and id = v_work.id;

  return query select v_task_id, p_to_housekeeper_id, false;
end;
$function$;

revoke all on function public.assign_room_work_atomic(uuid, uuid, uuid, uuid, text, integer, numeric, boolean, text) from public, anon, authenticated;
grant execute on function public.assign_room_work_atomic(uuid, uuid, uuid, uuid, text, integer, numeric, boolean, text) to service_role;

create or replace function public.reset_room_work_assignments(
  p_property_id uuid,
  p_date date,
  p_task_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_work public.room_work;
  v_cleared integer := 0;
  v_status text;
begin
  for v_work in
    select *
      from public.room_work w
     where w.property_id = p_property_id
       and w.date = p_date
       and w.assigned_staff_id is not null
       and (
         p_task_id is null
         or w.id = p_task_id
         or w.legacy_task_id = p_task_id
       )
     for update
  loop
    v_status := case
      when v_work.status = 'in_progress' and v_work.is_paused then 'paused'
      when v_work.status = 'in_progress' then 'in_progress'
      when v_work.status = 'completed' then 'completed'
      when v_work.status = 'skipped' then 'skipped'
      when v_work.status = 'refused' then coalesce(v_work.plan_status, 'deferred')
      else coalesce(v_work.plan_status, 'scheduled')
    end;
    if v_status not in ('scheduled', 'ready_now', 'deferred') then
      continue;
    end if;

    update public.room_work
       set assignment_history = assignment_history || jsonb_build_array(jsonb_build_object(
             'event', 'unassigned',
             'is_active', false,
             'housekeeper_id', assigned_staff_id,
             'queue_order', assignment_queue_order,
             'assigned_at', assignment_assigned_at,
             'assigned_by', assignment_assigned_by,
             'assigned_by_user_id', assignment_assigned_by_user_id,
             'reason', assignment_reason,
             'score', assignment_score,
             'changed_at', now()
           )),
           assigned_staff_id = null,
           assigned_source = null,
           assignment_queue_order = 0,
           assignment_assigned_at = null,
           assignment_assigned_by = null,
           assignment_assigned_by_user_id = null,
           assignment_reason = null,
           assignment_score = null
     where property_id = p_property_id
       and id = v_work.id;
    v_cleared := v_cleared + 1;
  end loop;

  return v_cleared;
end;
$function$;

revoke all on function public.reset_room_work_assignments(uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.reset_room_work_assignments(uuid, date, uuid) to service_role;

-- Complete a rule plan row in one locked transaction. This is the only plan
-- writer used by the rules engine, so its update cannot race a workflow tap.
-- The status and priority semantics remain the old cleaning_tasks semantics.

-- Apply inspection pass/fail metadata for the legacy fallback path. The main
-- path uses complete_inspection_atomic below, but this operation keeps the
-- rollout fallback canonical and removes the last old-table writer.
create or replace function public.apply_inspection_cleaning_plan_side_effect(
  p_property_id uuid,
  p_task_id uuid,
  p_result text,
  p_correction_note text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_work public.room_work;
begin
  if p_result not in ('pass', 'fail') then
    raise exception 'E_BAD_RESULT: p_result must be pass or fail' using errcode = 'check_violation';
  end if;

  select * into v_work
    from public.room_work w
   where w.property_id = p_property_id
     and (w.id = p_task_id or w.legacy_task_id = p_task_id)
   for update;
  if not found then
    raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning plan % does not belong to property %', p_task_id, p_property_id
      using errcode = 'no_data_found';
  end if;

  if p_result = 'pass' then
    update public.room_work
       set plan_status = 'inspected_pass',
           inspected_at = now()
     where property_id = p_property_id and id = v_work.id;
  else
    update public.room_work
       set plan_status = 'correction_pending',
           plan_priority = 'high',
           plan_notes = p_correction_note,
           issue_note = p_correction_note
     where property_id = p_property_id and id = v_work.id;
  end if;
end;
$function$;

revoke all on function public.apply_inspection_cleaning_plan_side_effect(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.apply_inspection_cleaning_plan_side_effect(uuid, uuid, text, text) to service_role;

-- The protected complete-clean route still upserts room_work directly. This
-- AFTER trigger makes its parent completion and every exact component child
-- update one database transaction without changing that route.
create or replace function public._room_work_complete_components()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_children jsonb;
  v_child text;
begin
  if pg_trigger_depth() > 1 or new.status is distinct from 'completed' then
    return new;
  end if;

  select c.child_room_numbers
    into v_children
    from public.component_rooms c
   where c.property_id = new.property_id
     and c.parent_room_number = new.room_number;

  if v_children is null or jsonb_typeof(v_children) <> 'array' then
    return new;
  end if;

  for v_child in
    select distinct value
      from jsonb_array_elements_text(v_children)
     where value is not null and btrim(value) <> ''
  loop
    update public.room_work w
       set status = 'completed',
           started_at = coalesce(w.started_at, new.started_at),
           completed_at = coalesce(w.completed_at, new.completed_at, now()),
           is_paused = false,
           paused_at = null
     where w.property_id = new.property_id
       and w.date = new.date
       and w.room_number = v_child
       and (w.status is null or w.status in ('not_started', 'in_progress'));

    if not found then
      insert into public.room_work (
        property_id, date, room_number, status,
        started_at, completed_at, is_paused, paused_at
      ) values (
        new.property_id, new.date, v_child, 'completed',
        new.started_at, coalesce(new.completed_at, now()), false, null
      )
      on conflict (property_id, date, room_number) do update
        set status = case
          when public.room_work.status is null
            or public.room_work.status in ('not_started', 'in_progress')
            then 'completed'
          else public.room_work.status
        end,
        started_at = coalesce(public.room_work.started_at, excluded.started_at),
        completed_at = coalesce(public.room_work.completed_at, excluded.completed_at),
        is_paused = case
          when public.room_work.status is null
            or public.room_work.status in ('not_started', 'in_progress')
            then false
          else public.room_work.is_paused
        end,
        paused_at = case
          when public.room_work.status is null
            or public.room_work.status in ('not_started', 'in_progress')
            then null
          else public.room_work.paused_at
        end;
    end if;
  end loop;

  return new;
end;
$function$;

drop trigger if exists room_work_complete_components on public.room_work;
create trigger room_work_complete_components
  after insert or update of status on public.room_work
  for each row execute function public._room_work_complete_components();

-- Canonical audit capture replaces the two old-table trigger sources. The
-- existing activity_log rows remain intact, and future plan/status/assignment
-- changes are recorded against the canonical room_work identity.
create or replace function public._activity_log_on_room_work_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_target uuid := coalesce(new.legacy_task_id, new.id);
  v_status text;
begin
  -- Legacy table activity triggers already record the old-app write. Skip the
  -- duplicate parent event created by the one-way bridge, while still
  -- allowing component-only room_work rows to be audited.
  if current_setting('staxis.housekeeping_legacy_bridge', true) = 'on'
     and new.legacy_task_id is not null then
    return new;
  end if;

  if tg_op = 'INSERT' and new.plan_cleaning_type is not null then
    perform public._activity_log_write(
      new.property_id, new.created_at, 'housekeeping', 'cleaning_task_created',
      null, null, 'cleaning_task', v_target::text,
      'Room ' || new.room_number,
      format('Cleaning task created for room %s (%s, priority %s)', new.room_number, new.plan_cleaning_type, coalesce(new.plan_priority, 'normal')),
      'rules_engine', v_target,
      jsonb_build_object(
        'room_number', new.room_number,
        'business_date', new.date,
        'cleaning_type', new.plan_cleaning_type,
        'priority', new.plan_priority,
        'estimated_minutes', new.plan_estimated_minutes,
        'requires_inspection', new.plan_requires_inspection,
        'status', new.plan_status,
        'rules_fired', new.plan_rules_fired
      )
    );
  elsif tg_op = 'UPDATE' then
    if old.status is distinct from new.status or old.plan_status is distinct from new.plan_status then
      v_status := case
        when new.status = 'in_progress' and new.is_paused then 'paused'
        when new.status = 'in_progress' then 'in_progress'
        when new.status = 'completed' and new.plan_status is not null then new.plan_status
        when new.status = 'completed' then 'completed'
        else coalesce(new.plan_status, new.status, 'scheduled')
      end;
      perform public._activity_log_write(
        new.property_id, coalesce(new.completed_at, new.inspected_at, new.updated_at),
        'housekeeping', 'cleaning_task_' || v_status,
        new.assigned_staff_id, new.assignment_assigned_by_user_id,
        'cleaning_task', v_target::text, 'Room ' || new.room_number,
        format('Cleaning task for room %s changed status to %s', new.room_number, v_status),
        case when new.assigned_staff_id is not null then 'housekeeper_app' else 'rules_engine' end,
        v_target,
        jsonb_build_object(
          'room_number', new.room_number,
          'business_date', new.date,
          'cleaning_type', new.plan_cleaning_type,
          'old_status', old.status,
          'new_status', new.status,
          'old_plan_status', old.plan_status,
          'new_plan_status', new.plan_status,
          'assignee_id', new.assigned_staff_id
        )
      );
    elsif old.assigned_staff_id is distinct from new.assigned_staff_id then
      perform public._activity_log_write(
        new.property_id, coalesce(new.assignment_assigned_at, new.updated_at),
        'housekeeping', case when new.assigned_staff_id is null then 'assignment_deactivated' else 'assignment_created' end,
        new.assigned_staff_id, new.assignment_assigned_by_user_id,
        'cleaning_task', v_target::text, 'Room ' || new.room_number,
        case when new.assigned_staff_id is null then 'Unassigned room ' || new.room_number else 'Assigned room ' || new.room_number end,
        case when new.assignment_assigned_by = 'auto' then 'rules_engine' else 'manager_dashboard' end,
        v_target,
        jsonb_build_object(
          'room_number', new.room_number,
          'cleaning_task_id', v_target,
          'housekeeper_id', new.assigned_staff_id,
          'assigned_by', new.assignment_assigned_by,
          'queue_order', new.assignment_queue_order,
          'reason', new.assignment_reason,
          'score', new.assignment_score
        )
      );
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_activity_log_room_work_change on public.room_work;
create trigger trg_activity_log_room_work_change
  after insert or update of status, plan_status, assigned_staff_id on public.room_work
  for each row execute function public._activity_log_on_room_work_change();

-- Add the canonical inspection operation without replacing the old RPC yet.
-- The deployed app still calls complete_inspection_atomic, whose existing
-- legacy-table side effect is bridged into room_work by the triggers below.
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
begin
  if p_result not in ('pass', 'fail') then
    raise exception 'E_BAD_RESULT: p_result must be pass or fail, got %', p_result
      using errcode = 'check_violation';
  end if;

  select * into v_row
    from public.inspections
   where id = p_inspection_id
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

  -- Resolve the historical or deterministic task id to the same canonical
  -- row. A property mismatch is an integrity error, not a no-op.
  if v_row.cleaning_task_id is not null then
    select * into v_plan_work
      from public.room_work w
     where w.property_id = p_property_id
       and (w.legacy_task_id = v_row.cleaning_task_id or w.id = v_row.cleaning_task_id)
     order by w.date desc
     limit 1
     for update;

    if not found then
      select a.date, a.room_number
        into v_task_date, v_task_room
        from public.pms_housekeeping_assignments a
       where a.property_id = p_property_id
         and public.housekeeping_plan_id(a.property_id, a.date, a.room_number) = v_row.cleaning_task_id
       order by a.date desc
       limit 1;
      if found then
        insert into public.room_work (
          id, property_id, date, room_number, plan_status
        ) values (
          public.housekeeping_plan_id(p_property_id, v_task_date, v_task_room),
          p_property_id, v_task_date, v_task_room, 'scheduled'
        ) on conflict (property_id, date, room_number) do nothing;
        select * into v_plan_work
         from public.room_work w
         where w.property_id = p_property_id
           and w.date = v_task_date
           and w.room_number = v_task_room
         for update;
      end if;
    end if;

    if not found or v_plan_work.property_id is distinct from p_property_id then
      raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning plan % does not belong to property %', v_row.cleaning_task_id, p_property_id
        using errcode = 'no_data_found';
    end if;

    v_task_id := v_plan_work.id;
    if p_result = 'pass' then
      update public.room_work
         set plan_status = 'inspected_pass',
             inspected_at = now()
       where property_id = p_property_id and id = v_task_id;
    else
      update public.room_work
         set plan_status = 'correction_pending',
             plan_priority = 'high',
             plan_notes = p_correction_note,
             issue_note = p_correction_note
       where property_id = p_property_id and id = v_task_id;
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
  '0435',
  'Expand-only canonical room-work operations, legacy-to-canonical bridge, atomic component completion, and canonical inspection operation.'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
