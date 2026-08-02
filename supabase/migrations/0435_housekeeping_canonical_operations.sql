-- 0435: add canonical housekeeping operations without breaking the deployed
-- legacy application.
--
-- This is the expand stage. cleaning_tasks and hk_assignments remain physical
-- writable tables, and their old readers/writers keep working until the exact
-- canonical application is live. Migration 0434 installed the bounded one-way
-- legacy-to-canonical bridge before reconciliation; this stage preserves those
-- triggers without adding a reverse path.

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

-- Every canonical room-work mutation takes the same lock set: one bounded
-- property/date advisory lock followed by the natural parent key plus its
-- exact direct component children, all in one sorted room-number order. The
-- coarse advisory lock prevents an unbounded per-room advisory-lock footprint
-- for rules-engine batches; the sorted row locks cover existing rows. Callers
-- must invoke this helper before their room_work INSERT/UPDATE statement.
create or replace function public._lock_room_work_component_set(
  p_property_id uuid,
  p_date date,
  p_room_numbers text[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_room_number text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    format('staxis.housekeeping-plan-batch:%s:%s', p_property_id, p_date),
    0
  ));

  for v_room_number in
    select lock_keys.room_number
      from (
        select btrim(input.room_number) as room_number
          from unnest(coalesce(p_room_numbers, array[]::text[])) as input(room_number)
         where input.room_number is not null
           and btrim(input.room_number) <> ''
        union
        select btrim(child.value) as room_number
          from unnest(coalesce(p_room_numbers, array[]::text[])) as input(room_number)
          join public.component_rooms c
            on c.property_id = p_property_id
           and c.parent_room_number = btrim(input.room_number)
          cross join lateral jsonb_array_elements_text(c.child_room_numbers) child(value)
         where jsonb_typeof(c.child_room_numbers) = 'array'
           and btrim(child.value) <> ''
      ) lock_keys
     order by lock_keys.room_number
  loop
    perform 1
      from public.room_work w
     where w.property_id = p_property_id
       and w.date = p_date
       and w.room_number = v_room_number
     for update;
  end loop;
end;
$function$;

-- PostgreSQL takes the target tuple lock before a BEFORE row trigger runs.
-- Therefore there is intentionally no room_work lock trigger here: every
-- canonical writer must call _lock_room_work_component_set before its first
-- room_work INSERT/UPDATE statement. The legacy-table bridges intentionally
-- retain their old single-row behavior during Stage A; only the dormant
-- canonical RPCs below use this component-set seam.
drop trigger if exists room_work_lock_component_set on public.room_work;
drop function if exists public._room_work_lock_component_set();

-- Dormant canonical writer seam for the post-expand housekeeper and room-action
-- callers. The service-role RPC acquires the complete component set before
-- the first room_work statement, then applies only the explicitly supplied
-- workflow fields. A completed parent fans out to its exact direct children
-- here, in the same transaction; no room_work row trigger is required.
-- Identity columns are deliberately not accepted here.
-- p_check_expected_status preserves the existing optimistic status race
-- behavior used by applyRoomUpdate; a false result means no row was changed.
create or replace function public.write_room_work_atomic(
  p_property_id uuid,
  p_date date,
  p_room_number text,
  p_patch jsonb,
  p_expected_status text default null,
  p_check_expected_status boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_patch public.room_work;
  v_work public.room_work;
  v_patch_keys text[];
  v_children jsonb;
  v_child text;
begin
  if p_property_id is null or p_date is null or p_room_number is null or btrim(p_room_number) = '' then
    raise exception 'E_BAD_ROOM_WORK_KEY: property, date, and room number are required'
      using errcode = 'not_null_violation';
  end if;
  if jsonb_typeof(coalesce(p_patch, '{}'::jsonb)) <> 'object' then
    raise exception 'E_BAD_ROOM_WORK_PATCH: patch must be a JSON object'
      using errcode = 'check_violation';
  end if;

  select array_agg(key order by key)
    into v_patch_keys
    from jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) as keys(key)
   where key not in (
     'assigned_staff_id', 'assigned_source',
     'status', 'started_at', 'completed_at', 'time_spent_minutes',
     'is_paused', 'paused_at', 'total_paused_seconds',
     'checklist_template_id', 'checklist_progress',
     'exception_type', 'exception_note', 'exception_at',
     'dnd_active', 'dnd_note',
     'manager_notes', 'manager_notes_at', 'manager_notes_by_account_id',
     'housekeeper_note', 'housekeeper_note_at',
     'is_rush', 'rush_due_by', 'rush_set_at', 'rush_set_by',
     'rush_requested_by_account_id', 'rush_duration_label',
     'marked_for_inspection_at', 'inspected_by', 'inspected_at',
     'issue_note', 'help_requested'
   );
  if v_patch_keys is not null then
    raise exception 'E_BAD_ROOM_WORK_PATCH: unsupported fields: %', array_to_string(v_patch_keys, ', ')
      using errcode = 'invalid_parameter_value';
  end if;

  -- This is intentionally the first room_work access in the function.
  -- PostgreSQL takes a tuple lock before a BEFORE row trigger, so lock
  -- acquisition cannot be delegated to a row trigger.
  perform public._lock_room_work_component_set(
    p_property_id,
    p_date,
    array[p_room_number]::text[]
  );

  if p_check_expected_status then
    select * into v_work
      from public.room_work w
     where w.property_id = p_property_id
       and w.date = p_date
       and w.room_number = p_room_number
     for update;
    if not found or v_work.status is distinct from p_expected_status then
      return false;
    end if;
  else
    insert into public.room_work(property_id, date, room_number)
    values (p_property_id, p_date, p_room_number)
    on conflict (property_id, date, room_number) do nothing;

    select * into v_work
      from public.room_work w
     where w.property_id = p_property_id
       and w.date = p_date
       and w.room_number = p_room_number
     for update;
  end if;

  v_patch := jsonb_populate_record(null::public.room_work, coalesce(p_patch, '{}'::jsonb));

  if p_patch is not null and p_patch <> '{}'::jsonb then
    update public.room_work w
       set assigned_staff_id = case when p_patch ? 'assigned_staff_id' then v_patch.assigned_staff_id else w.assigned_staff_id end,
           assigned_source = case when p_patch ? 'assigned_source' then v_patch.assigned_source else w.assigned_source end,
           status = case when p_patch ? 'status' then v_patch.status else w.status end,
           started_at = case when p_patch ? 'started_at' then v_patch.started_at else w.started_at end,
           completed_at = case when p_patch ? 'completed_at' then v_patch.completed_at else w.completed_at end,
           time_spent_minutes = case when p_patch ? 'time_spent_minutes' then v_patch.time_spent_minutes else w.time_spent_minutes end,
           is_paused = case when p_patch ? 'is_paused' then v_patch.is_paused else w.is_paused end,
           paused_at = case when p_patch ? 'paused_at' then v_patch.paused_at else w.paused_at end,
           total_paused_seconds = case when p_patch ? 'total_paused_seconds' then v_patch.total_paused_seconds else w.total_paused_seconds end,
           checklist_template_id = case when p_patch ? 'checklist_template_id' then v_patch.checklist_template_id else w.checklist_template_id end,
           checklist_progress = case when p_patch ? 'checklist_progress' then v_patch.checklist_progress else w.checklist_progress end,
           exception_type = case when p_patch ? 'exception_type' then v_patch.exception_type else w.exception_type end,
           exception_note = case when p_patch ? 'exception_note' then v_patch.exception_note else w.exception_note end,
           exception_at = case when p_patch ? 'exception_at' then v_patch.exception_at else w.exception_at end,
           dnd_active = case when p_patch ? 'dnd_active' then v_patch.dnd_active else w.dnd_active end,
           dnd_note = case when p_patch ? 'dnd_note' then v_patch.dnd_note else w.dnd_note end,
           manager_notes = case when p_patch ? 'manager_notes' then v_patch.manager_notes else w.manager_notes end,
           manager_notes_at = case when p_patch ? 'manager_notes_at' then v_patch.manager_notes_at else w.manager_notes_at end,
           manager_notes_by_account_id = case when p_patch ? 'manager_notes_by_account_id' then v_patch.manager_notes_by_account_id else w.manager_notes_by_account_id end,
           housekeeper_note = case when p_patch ? 'housekeeper_note' then v_patch.housekeeper_note else w.housekeeper_note end,
           housekeeper_note_at = case when p_patch ? 'housekeeper_note_at' then v_patch.housekeeper_note_at else w.housekeeper_note_at end,
           is_rush = case when p_patch ? 'is_rush' then v_patch.is_rush else w.is_rush end,
           rush_due_by = case when p_patch ? 'rush_due_by' then v_patch.rush_due_by else w.rush_due_by end,
           rush_set_at = case when p_patch ? 'rush_set_at' then v_patch.rush_set_at else w.rush_set_at end,
           rush_set_by = case when p_patch ? 'rush_set_by' then v_patch.rush_set_by else w.rush_set_by end,
           rush_requested_by_account_id = case when p_patch ? 'rush_requested_by_account_id' then v_patch.rush_requested_by_account_id else w.rush_requested_by_account_id end,
           rush_duration_label = case when p_patch ? 'rush_duration_label' then v_patch.rush_duration_label else w.rush_duration_label end,
           marked_for_inspection_at = case when p_patch ? 'marked_for_inspection_at' then v_patch.marked_for_inspection_at else w.marked_for_inspection_at end,
           inspected_by = case when p_patch ? 'inspected_by' then v_patch.inspected_by else w.inspected_by end,
           inspected_at = case when p_patch ? 'inspected_at' then v_patch.inspected_at else w.inspected_at end,
           issue_note = case when p_patch ? 'issue_note' then v_patch.issue_note else w.issue_note end,
           help_requested = case when p_patch ? 'help_requested' then v_patch.help_requested else w.help_requested end
     where w.property_id = p_property_id
       and w.date = p_date
       and w.room_number = p_room_number
       and (
         (p_patch ? 'assigned_staff_id' and w.assigned_staff_id is distinct from v_patch.assigned_staff_id)
         or (p_patch ? 'assigned_source' and w.assigned_source is distinct from v_patch.assigned_source)
         or (p_patch ? 'status' and w.status is distinct from v_patch.status)
         or (p_patch ? 'started_at' and w.started_at is distinct from v_patch.started_at)
         or (p_patch ? 'completed_at' and w.completed_at is distinct from v_patch.completed_at)
         or (p_patch ? 'time_spent_minutes' and w.time_spent_minutes is distinct from v_patch.time_spent_minutes)
         or (p_patch ? 'is_paused' and w.is_paused is distinct from v_patch.is_paused)
         or (p_patch ? 'paused_at' and w.paused_at is distinct from v_patch.paused_at)
         or (p_patch ? 'total_paused_seconds' and w.total_paused_seconds is distinct from v_patch.total_paused_seconds)
         or (p_patch ? 'checklist_template_id' and w.checklist_template_id is distinct from v_patch.checklist_template_id)
         or (p_patch ? 'checklist_progress' and w.checklist_progress is distinct from v_patch.checklist_progress)
         or (p_patch ? 'exception_type' and w.exception_type is distinct from v_patch.exception_type)
         or (p_patch ? 'exception_note' and w.exception_note is distinct from v_patch.exception_note)
         or (p_patch ? 'exception_at' and w.exception_at is distinct from v_patch.exception_at)
         or (p_patch ? 'dnd_active' and w.dnd_active is distinct from v_patch.dnd_active)
         or (p_patch ? 'dnd_note' and w.dnd_note is distinct from v_patch.dnd_note)
         or (p_patch ? 'manager_notes' and w.manager_notes is distinct from v_patch.manager_notes)
         or (p_patch ? 'manager_notes_at' and w.manager_notes_at is distinct from v_patch.manager_notes_at)
         or (p_patch ? 'manager_notes_by_account_id' and w.manager_notes_by_account_id is distinct from v_patch.manager_notes_by_account_id)
         or (p_patch ? 'housekeeper_note' and w.housekeeper_note is distinct from v_patch.housekeeper_note)
         or (p_patch ? 'housekeeper_note_at' and w.housekeeper_note_at is distinct from v_patch.housekeeper_note_at)
         or (p_patch ? 'is_rush' and w.is_rush is distinct from v_patch.is_rush)
         or (p_patch ? 'rush_due_by' and w.rush_due_by is distinct from v_patch.rush_due_by)
         or (p_patch ? 'rush_set_at' and w.rush_set_at is distinct from v_patch.rush_set_at)
         or (p_patch ? 'rush_set_by' and w.rush_set_by is distinct from v_patch.rush_set_by)
         or (p_patch ? 'rush_requested_by_account_id' and w.rush_requested_by_account_id is distinct from v_patch.rush_requested_by_account_id)
         or (p_patch ? 'rush_duration_label' and w.rush_duration_label is distinct from v_patch.rush_duration_label)
         or (p_patch ? 'marked_for_inspection_at' and w.marked_for_inspection_at is distinct from v_patch.marked_for_inspection_at)
         or (p_patch ? 'inspected_by' and w.inspected_by is distinct from v_patch.inspected_by)
         or (p_patch ? 'inspected_at' and w.inspected_at is distinct from v_patch.inspected_at)
         or (p_patch ? 'issue_note' and w.issue_note is distinct from v_patch.issue_note)
         or (p_patch ? 'help_requested' and w.help_requested is distinct from v_patch.help_requested)
       );
  end if;

  if p_patch ? 'status'
     and v_patch.status = 'completed'
     and coalesce(current_setting('staxis.housekeeping_legacy_inspection', true), 'off') <> 'on' then
    select c.child_room_numbers
      into v_children
      from public.component_rooms c
     where c.property_id = p_property_id
       and c.parent_room_number = p_room_number;

    if v_children is not null and jsonb_typeof(v_children) = 'array' then
      for v_child in
        select distinct value
          from jsonb_array_elements_text(v_children)
         where value is not null and btrim(value) <> ''
         order by value
      loop
        update public.room_work w
           set status = 'completed',
               started_at = coalesce(w.started_at, v_patch.started_at, v_work.started_at),
               completed_at = coalesce(w.completed_at, v_patch.completed_at, now()),
               is_paused = false,
               paused_at = null
         where w.property_id = p_property_id
           and w.date = p_date
           and w.room_number = v_child
           and (w.status is null or w.status in ('not_started', 'in_progress'));

        if not found then
          insert into public.room_work (
            property_id, date, room_number, status,
            started_at, completed_at, is_paused, paused_at
          ) values (
            p_property_id, p_date, v_child, 'completed',
            coalesce(v_patch.started_at, v_work.started_at),
            coalesce(v_patch.completed_at, now()), false, null
          )
          on conflict (property_id, date, room_number) do nothing;
        end if;
      end loop;
    end if;
  end if;

  return true;
end;
$function$;

revoke all on function public.write_room_work_atomic(uuid, date, text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.write_room_work_atomic(uuid, date, text, jsonb, text, boolean) to service_role;

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
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_row record;
  v_key record;
  v_work public.room_work;
  v_task_id uuid;
  v_outcome text;
  v_update_count integer;
begin
  if jsonb_typeof(v_rows) <> 'array' then
    raise exception 'E_BAD_PLAN_ROWS: p_rows must be a JSON array' using errcode = 'check_violation';
  end if;

  -- Materialize first, then lock every affected canonical key in date/room
  -- order before any mutation. The advisory lock also covers a missing row,
  -- so two concurrent batches cannot choose different insert orderings.
  create temp table if not exists staxis_housekeeping_plan_batch (
    input_order bigint not null,
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
  ) on commit drop;
  create temp table if not exists staxis_housekeeping_plan_batch_results (
    input_order bigint primary key,
    dedupe_key text,
    task_id uuid,
    outcome text
  ) on commit drop;
  truncate table pg_temp.staxis_housekeeping_plan_batch;
  truncate table pg_temp.staxis_housekeeping_plan_batch_results;

  insert into pg_temp.staxis_housekeeping_plan_batch (
    input_order, property_id, room_number, business_date, dedupe_key,
    cleaning_type, priority, due_by, estimated_minutes, requires_inspection,
    extras, notes, rules_fired, rule_inputs, status,
    source_pms_reservation_id, source_engine_run_id,
    source_property_timezone, scheduled_at, last_evaluated_at
  )
  select element.ordinality, x.*
    from jsonb_array_elements(v_rows) with ordinality as element(value, ordinality)
    cross join lateral jsonb_to_record(element.value) as x(
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
    );

  for v_row in
    select * from pg_temp.staxis_housekeeping_plan_batch order by input_order
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
  end loop;

  if exists (
    select 1
      from pg_temp.staxis_housekeeping_plan_batch
     group by business_date, room_number
    having count(*) > 1
  ) then
    raise exception 'E_DUPLICATE_PLAN_ROW: a batch cannot contain two rows for one property/date/room'
      using errcode = 'unique_violation';
  end if;

  for v_key in
    select business_date, array_agg(room_number order by room_number) as room_numbers
      from pg_temp.staxis_housekeeping_plan_batch
     group by business_date
     order by business_date
  loop
    perform public._lock_room_work_component_set(
      p_property_id,
      v_key.business_date,
      v_key.room_numbers
    );
  end loop;

  for v_row in
    select *
      from pg_temp.staxis_housekeeping_plan_batch
     order by business_date, room_number, input_order
  loop
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
      update public.room_work w
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
             plan_last_evaluated_at = case
               when v_row.last_evaluated_at is not null then v_row.last_evaluated_at
               else w.plan_last_evaluated_at
             end
       where w.property_id = p_property_id
         and w.date = v_row.business_date
         and w.room_number = v_row.room_number
         and (
           w.plan_dedupe_key is distinct from coalesce(v_row.dedupe_key, v_row.room_number || '::' || v_row.business_date::text)
           or w.plan_cleaning_type is distinct from v_row.cleaning_type
           or w.plan_priority is distinct from v_row.priority
           or w.plan_due_by is distinct from v_row.due_by
           or w.plan_estimated_minutes is distinct from v_row.estimated_minutes
           or w.plan_requires_inspection is distinct from coalesce(v_row.requires_inspection, false)
           or w.plan_extras is distinct from coalesce(v_row.extras, '[]'::jsonb)
           or w.plan_notes is distinct from v_row.notes
           or w.plan_rules_fired is distinct from coalesce(v_row.rules_fired, '[]'::jsonb)
           or w.plan_rule_inputs is distinct from v_row.rule_inputs
           or w.plan_status is distinct from v_row.status
           or w.plan_source_pms_reservation_id is distinct from v_row.source_pms_reservation_id
           or w.plan_source_engine_run_id is distinct from v_row.source_engine_run_id
           or w.plan_source_property_timezone is distinct from v_row.source_property_timezone
           or w.plan_scheduled_at is distinct from v_row.scheduled_at
           or (
             v_row.last_evaluated_at is not null
             and w.plan_last_evaluated_at is distinct from v_row.last_evaluated_at
           )
         );
      get diagnostics v_update_count = row_count;
      if v_update_count > 0 then
        select * into v_work
          from public.room_work w
         where w.property_id = p_property_id
           and w.date = v_row.business_date
           and w.room_number = v_row.room_number;
        v_outcome := 'updated';
      else
        v_outcome := 'skipped';
      end if;
    else
      if v_row.last_evaluated_at is not null
         and v_work.plan_last_evaluated_at is distinct from v_row.last_evaluated_at then
        update public.room_work
           set plan_last_evaluated_at = v_row.last_evaluated_at
         where property_id = p_property_id
           and date = v_row.business_date
           and room_number = v_row.room_number;
        select * into v_work
          from public.room_work w
         where w.property_id = p_property_id
           and w.date = v_row.business_date
           and w.room_number = v_row.room_number;
      end if;
      v_outcome := 'skipped';
    end if;

    v_task_id := coalesce(v_work.legacy_task_id, v_work.id);
    insert into pg_temp.staxis_housekeeping_plan_batch_results(input_order, dedupe_key, task_id, outcome)
    values (v_row.input_order, coalesce(v_work.plan_dedupe_key, v_row.dedupe_key), v_task_id, v_outcome);
  end loop;

  return query
    select r.dedupe_key, r.task_id, r.outcome
      from pg_temp.staxis_housekeeping_plan_batch_results r
     order by r.input_order;
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
  v_room_numbers text[];
begin
  select array_agg(w.room_number order by w.room_number)
    into v_room_numbers
    from public.room_work w
   where w.property_id = p_property_id
     and w.date = p_date
     and w.plan_dedupe_key = any(coalesce(p_dedupe_keys, array[]::text[]));

  if v_room_numbers is null then
    return 0;
  end if;

  perform public._lock_room_work_component_set(p_property_id, p_date, v_room_numbers);

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
  v_current jsonb;
  v_status text;
  v_task_id uuid;
  v_source text;
  v_by text;
  v_assignment_id uuid;
  v_now timestamptz;
  v_lock_date date;
  v_lock_room text;
begin
  -- Discover the natural key without taking its row lock. The shared helper
  -- must acquire the parent plus direct children first, in sorted order.
  select w.date, w.room_number
    into v_lock_date, v_lock_room
    from public.room_work w
   where w.property_id = p_property_id
     and (w.id = p_task_id or w.legacy_task_id = p_task_id)
   limit 1;

  if not found then
    select a.date, a.room_number, a.cleaning_type, a.scheduled_time, a.notes
      into v_pms
      from public.pms_housekeeping_assignments a
     where a.property_id = p_property_id
       and public.housekeeping_plan_id(a.property_id, a.date, a.room_number) = p_task_id;

    if not found then
      raise exception 'task not found' using errcode = 'P0002';
    end if;
    v_lock_date := v_pms.date;
    v_lock_room := v_pms.room_number;
  end if;

  perform public._lock_room_work_component_set(
    p_property_id,
    v_lock_date,
    array[v_lock_room]::text[]
  );

  select * into v_work
    from public.room_work w
   where w.property_id = p_property_id
     and (w.id = p_task_id or w.legacy_task_id = p_task_id
       or (w.date = v_lock_date and w.room_number = v_lock_room))
   for update;

  if not found then
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

  select s.property_id, s.department, coalesce(s.is_active, true) as is_active
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
  v_now := now();
  v_assignment_id := gen_random_uuid();

  select e.snapshot
    into v_current
    from jsonb_array_elements(coalesce(v_work.assignment_history, '[]'::jsonb)) with ordinality e(snapshot, position)
   where e.snapshot->>'id' is not null
     and e.snapshot->>'property_id' = v_work.property_id::text
     and e.snapshot->>'cleaning_task_id' = coalesce(v_work.legacy_task_id, v_work.id)::text
     and e.snapshot->>'housekeeper_id' = v_work.assigned_staff_id::text
     and e.snapshot ? 'queue_order'
     and e.snapshot ? 'assigned_at'
     and e.snapshot ? 'assigned_by'
     and e.snapshot ? 'assigned_by_user_id'
     and e.snapshot ? 'reason'
     and e.snapshot ? 'score'
     and e.snapshot ? 'created_at'
     and e.snapshot ? 'updated_at'
     and coalesce((e.snapshot->>'is_active')::boolean, false)
   order by e.position desc
   limit 1;

  update public.room_work
     set assignment_history = case
           when assigned_staff_id is null then assignment_history
           else assignment_history || jsonb_build_array(
             coalesce(v_current, jsonb_build_object(
               'id', gen_random_uuid(),
               'property_id', property_id,
               'cleaning_task_id', coalesce(legacy_task_id, id),
               'housekeeper_id', assigned_staff_id,
               'queue_order', assignment_queue_order,
               'is_active', true,
               'assigned_at', assignment_assigned_at,
               'assigned_by', assignment_assigned_by,
               'assigned_by_user_id', assignment_assigned_by_user_id,
               'reason', assignment_reason,
               'score', assignment_score,
               'created_at', coalesce(created_at, v_now),
               'updated_at', coalesce(updated_at, v_now)
             )) || jsonb_build_object(
               'is_active', false,
               'event', 'superseded',
               'changed_at', v_now,
               'updated_at', v_now
             )
           )
         end || jsonb_build_array(jsonb_build_object(
           'id', v_assignment_id,
           'property_id', property_id,
           'cleaning_task_id', coalesce(legacy_task_id, id),
           'housekeeper_id', p_to_housekeeper_id,
           'queue_order', greatest(coalesce(p_queue_order, 0), 0),
           'is_active', true,
           'assigned_at', v_now,
           'assigned_by', v_by,
           'assigned_by_user_id', p_assigned_by_user,
           'reason', coalesce(p_reason, 'assigned'),
           'score', p_score,
           'created_at', v_now,
           'updated_at', v_now,
           'event', 'assigned',
           'changed_at', v_now
         )),
         assigned_staff_id = p_to_housekeeper_id,
         assigned_source = v_source,
         assignment_queue_order = greatest(coalesce(p_queue_order, 0), 0),
         assignment_assigned_at = v_now,
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
  v_key record;
  v_current jsonb;
  v_cleared integer := 0;
  v_status text;
  v_now timestamptz;
begin
  -- Take all row and advisory locks in the same sorted order as the batch
  -- plan upsert. This prevents reverse-order callers from deadlocking while
  -- they overlap on a suite's component rooms.
  for v_key in
    select w.date, array_agg(w.room_number order by w.room_number) as room_numbers
      from public.room_work w
     where w.property_id = p_property_id
       and w.date = p_date
       and w.assigned_staff_id is not null
       and (
         p_task_id is null
         or w.id = p_task_id
         or w.legacy_task_id = p_task_id
       )
     group by w.date
     order by w.date
  loop
    perform public._lock_room_work_component_set(
      p_property_id,
      v_key.date,
      v_key.room_numbers
    );
  end loop;

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
     order by w.date, w.room_number
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

    v_current := null;
    select e.snapshot
      into v_current
      from jsonb_array_elements(coalesce(v_work.assignment_history, '[]'::jsonb)) with ordinality e(snapshot, position)
     where e.snapshot->>'id' is not null
       and e.snapshot->>'property_id' = v_work.property_id::text
       and e.snapshot->>'cleaning_task_id' = coalesce(v_work.legacy_task_id, v_work.id)::text
       and e.snapshot->>'housekeeper_id' = v_work.assigned_staff_id::text
       and e.snapshot ? 'queue_order'
       and e.snapshot ? 'assigned_at'
       and e.snapshot ? 'assigned_by'
       and e.snapshot ? 'assigned_by_user_id'
       and e.snapshot ? 'reason'
       and e.snapshot ? 'score'
       and e.snapshot ? 'created_at'
       and e.snapshot ? 'updated_at'
       and coalesce((e.snapshot->>'is_active')::boolean, false)
     order by e.position desc
     limit 1;
    v_now := now();

    update public.room_work
       set assignment_history = assignment_history || jsonb_build_array(
             coalesce(v_current, jsonb_build_object(
               'id', gen_random_uuid(),
               'property_id', v_work.property_id,
               'cleaning_task_id', coalesce(v_work.legacy_task_id, v_work.id),
               'housekeeper_id', v_work.assigned_staff_id,
               'queue_order', v_work.assignment_queue_order,
               'is_active', true,
               'assigned_at', v_work.assignment_assigned_at,
               'assigned_by', v_work.assignment_assigned_by,
               'assigned_by_user_id', v_work.assignment_assigned_by_user_id,
               'reason', v_work.assignment_reason,
               'score', v_work.assignment_score,
               'created_at', coalesce(v_work.created_at, v_now),
               'updated_at', coalesce(v_work.updated_at, v_now)
             )) || jsonb_build_object(
               'is_active', false,
               'event', 'unassigned',
               'changed_at', v_now,
               'updated_at', v_now
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

  -- Resolve the natural key without a row lock, then take the shared
  -- parent/component lock set before re-reading the canonical row. This keeps
  -- the fallback inspection seam in the same lock order as every other
  -- room_work writer.
  select * into v_work
   from public.room_work w
   where w.property_id = p_property_id
     and (w.id = p_task_id or w.legacy_task_id = p_task_id);
  if not found then
    raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning plan % does not belong to property %', p_task_id, p_property_id
      using errcode = 'no_data_found';
  end if;

  perform public._lock_room_work_component_set(
    v_work.property_id,
    v_work.date,
    array[v_work.room_number]::text[]
  );

  select * into v_work
    from public.room_work w
   where w.property_id = v_work.property_id
     and w.date = v_work.date
     and w.room_number = v_work.room_number
   for update;
  if not found then
    raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning plan % disappeared during lock acquisition', p_task_id
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

-- Dormant canonical component completion for Stage B. The function body keeps
-- parent and exact direct-child updates in one transaction when invoked by the
-- explicit canonical writer; Stage A deliberately installs no room_work row
-- trigger.
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
  if pg_trigger_depth() > 1
     or new.status is distinct from 'completed'
     or current_setting('staxis.housekeeping_legacy_inspection', true) = 'on' then
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
     order by value
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

-- Dormant canonical audit capture for Stage B. The existing legacy activity
-- triggers remain authoritative during Stage A, so applying 0434-0435 does not
-- change visible audit counts or labels before the app cutover.
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
  -- When Stage B installs this dormant function, legacy table activity triggers
  -- already record old-app writes. Skip duplicate parent events while allowing
  -- component-only room_work rows to be audited.
  if (
       current_setting('staxis.housekeeping_legacy_bridge', true) = 'on'
       or current_setting('staxis.housekeeping_legacy_inspection', true) = 'on'
     )
     and (
       new.legacy_task_id is not null
       or (
         current_setting('staxis.housekeeping_legacy_inspection', true) = 'on'
         and pg_trigger_depth() = 1
       )
     ) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.plan_cleaning_type is not null then
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
    elsif new.status = 'completed' then
      -- A component-only child can be materialized by the completion trigger
      -- with no manager plan metadata. It still represents an auditable
      -- housekeeping completion and must not be lost from the timeline.
      perform public._activity_log_write(
        new.property_id, coalesce(new.completed_at, new.updated_at, new.created_at),
        'housekeeping', 'cleaning_task_completed',
        new.assigned_staff_id, new.assignment_assigned_by_user_id,
        'cleaning_task', v_target::text, 'Room ' || new.room_number,
        format('Component room %s completed', new.room_number),
        'housekeeper_app', v_target,
        jsonb_build_object(
          'room_number', new.room_number,
          'business_date', new.date,
          'status', new.status,
          'component_only', true
        )
      );
    end if;
  elsif tg_op = 'UPDATE' then
    if old.status is distinct from new.status or old.plan_status is distinct from new.plan_status then
      v_status := case
        when new.status = 'in_progress' and new.is_paused then 'paused'
        when new.status = 'in_progress' then 'in_progress'
        when new.status = 'completed' and new.plan_status in (
          'inspection_pending', 'inspected_pass', 'inspected_fail',
          'correction_pending', 'correction_complete', 'check_pending',
          'check_complete'
        ) then new.plan_status
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

revoke all on function public._room_work_complete_components() from public, anon, authenticated;
revoke all on function public._activity_log_on_room_work_change() from public, anon, authenticated;
revoke all on function public._lock_room_work_component_set(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public._room_work_complete_components() to service_role;
grant execute on function public._activity_log_on_room_work_change() to service_role;
grant execute on function public._lock_room_work_component_set(uuid, date, text[]) to service_role;

-- Preserve the deployed inspection RPC signature and response behavior during
-- the expand window. Its room_work and cleaning_tasks side-effects are marked
-- transactionally so canonical audit capture does not emit a duplicate parent event.
create or replace function public.complete_inspection_atomic(
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
  v_row    public.inspections;
  v_count  integer;
  v_date   date;
begin
  if p_result not in ('pass','fail') then
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

  -- 1) Update the inspections row.
  update public.inspections
     set result                    = p_result,
         failed_items              = coalesce(p_failed_items, '[]'::jsonb),
         passed_items              = coalesce(p_passed_items, '[]'::jsonb),
         notes                     = p_notes,
         escalated                 = coalesce(p_escalated, false),
         escalation_reason         = p_escalation_reason,
         correction_notice_sent_at = p_correction_notice_sent_at,
         completed_at              = now()
   where id = p_inspection_id
   returning * into v_row;

  -- Mark both room_work and cleaning_tasks side-effects as the preserved old
  -- inspection path. Stage A has no canonical room_work audit trigger, while
  -- the legacy parent event remains emitted by the old table triggers.
  perform set_config('staxis.housekeeping_legacy_inspection', 'on', true);

  -- 2) cleaning_tasks side-effect (unchanged). This must precede every
  --    room_work side-effect: the deployed reassignment RPC locks the task,
  --    then its hk_assignments bridge locks room_work.
  if v_row.cleaning_task_id is not null then
    if p_result = 'pass' then
      update public.cleaning_tasks
         set status        = 'inspected_pass',
             inspected_at  = now()
       where id          = v_row.cleaning_task_id
         and property_id = p_property_id;
    else  -- fail
      update public.cleaning_tasks
         set status   = 'correction_pending',
             priority = 'high',
             notes    = p_correction_note
       where id          = v_row.cleaning_task_id
         and property_id = p_property_id;
    end if;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning_task % does not belong to property % (rows affected: %)',
        v_row.cleaning_task_id, p_property_id, v_count
        using errcode = 'no_data_found';
    end if;
  end if;

  -- 3) Work side-effect → room_work. Target the latest work or plan date ON
  --    OR BEFORE the inspection's own date, so a pre-loaded FUTURE plan can
  --    never be mutated by today's inspection.
  if v_row.room_number is not null then
    select max(d) into v_date from (
      select w.date as d from public.room_work w
       where w.property_id = p_property_id and w.room_number = v_row.room_number
         and w.date <= coalesce((v_row.started_at)::date, current_date)
      union all
      select a.date from public.pms_housekeeping_assignments a
       where a.property_id = p_property_id and a.room_number = v_row.room_number
         and a.date <= coalesce((v_row.started_at)::date, current_date)
    ) candidates;

    v_date := coalesce(v_date, (v_row.started_at)::date, current_date);

    if p_result = 'pass' then
      insert into public.room_work (property_id, date, room_number, status, completed_at, inspected_at)
      values (p_property_id, v_date, v_row.room_number, 'completed', now(), now())
      on conflict (property_id, date, room_number) do update
        set status       = 'completed',
            completed_at = coalesce(room_work.completed_at, now()),
            inspected_at = now();
    else  -- fail
      insert into public.room_work (property_id, date, room_number, status, completed_at, inspected_at, issue_note)
      values (p_property_id, v_date, v_row.room_number, 'not_started', null, null, p_correction_note)
      on conflict (property_id, date, room_number) do update
        set status       = 'not_started',
            completed_at = null,
            inspected_at = null,
            issue_note   = p_correction_note;
    end if;
  end if;

  -- 4) Re-check parent link (unchanged).
  if v_row.parent_inspection_id is not null then
    update public.inspections
       set recheck_inspection_id = v_row.id
     where id          = v_row.parent_inspection_id
       and property_id = p_property_id;
  end if;

  perform set_config('staxis.housekeeping_legacy_inspection', 'off', true);

  return v_row;
end;
$function$;

revoke all on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.complete_inspection_atomic(uuid, uuid, text, jsonb, jsonb, text, boolean, text, timestamptz, text) to service_role;

-- Add the canonical inspection operation alongside the preserved old RPC.
-- The deployed app still calls complete_inspection_atomic; the canonical app
-- can adopt this operation after Stage A without changing the old contract.
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
  v_has_plan_work boolean;
  v_has_pms_plan boolean;
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

    perform public._lock_room_work_component_set(
      p_property_id,
      v_date,
      array[v_row.room_number]::text[]
    );

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
    -- Resolve the exact canonical task room without a row lock first. The
    -- shared helper must own the complete parent/component lock order before
    -- this task row is re-read and locked.
    select * into v_plan_work
      from public.room_work w
     where w.property_id = p_property_id
       and (w.legacy_task_id = v_row.cleaning_task_id or w.id = v_row.cleaning_task_id)
     order by w.date desc
     limit 1;
    v_has_plan_work := found;

    if v_has_plan_work then
      v_task_date := v_plan_work.date;
      v_task_room := v_plan_work.room_number;
      perform public._lock_room_work_component_set(
        v_plan_work.property_id,
        v_task_date,
        array[v_task_room]::text[]
      );

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
    end if;

    if not v_has_plan_work then
      select a.date, a.room_number
        into v_task_date, v_task_room
        from public.pms_housekeeping_assignments a
       where a.property_id = p_property_id
         and public.housekeeping_plan_id(a.property_id, a.date, a.room_number) = v_row.cleaning_task_id
       order by a.date desc
       limit 1;
      v_has_pms_plan := found;
      if v_has_pms_plan then
        perform public._lock_room_work_component_set(
          p_property_id,
          v_task_date,
          array[v_task_room]::text[]
        );

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
        if not found then
          raise exception 'E_TASK_PROPERTY_MISMATCH: cleaning plan % disappeared during lock acquisition', v_row.cleaning_task_id
            using errcode = 'no_data_found';
        end if;
      end if;
    end if;

    if (not coalesce(v_has_plan_work, false) and not coalesce(v_has_pms_plan, false))
       or v_plan_work.property_id is distinct from p_property_id then
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
