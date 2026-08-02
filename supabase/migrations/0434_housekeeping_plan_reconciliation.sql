-- 0434: move the manager cleaning plan into room_work.
--
-- room_work is the Staxis-owned workflow row. The PMS assignment table stays
-- the report-owned plan fact source. This migration adds the manager plan
-- metadata and assignment audit fields to room_work, then reconciles every
-- existing cleaning_tasks and hk_assignments row while the old application
-- remains in service. The physical legacy tables stay writable through this
-- compatibility window; their retirement belongs to a later contract stage.
--
-- Release gate: Access Stage A (0418-0433) must be applied and verified Live
-- in production before Cleaning Stage A (0434-0435) is applied, merged, or
-- deployed. This is an ordered release gate, not a database dependency; the
-- parent release owner and Claude safety review must also approve this lane.

begin;

create or replace function public.housekeeping_plan_id(
  p_property_id uuid,
  p_date date,
  p_room_number text
)
returns uuid
language sql
immutable
strict
parallel safe
set search_path = public, pg_temp
as $$
  select md5(p_property_id::text || ':' || p_date::text || ':' || p_room_number)::uuid;
$$;

comment on function public.housekeeping_plan_id(uuid, date, text) is
  'Stable canonical room-work identifier for a property/date/room plan key.';

revoke all on function public.housekeeping_plan_id(uuid, date, text) from public, anon, authenticated;
grant execute on function public.housekeeping_plan_id(uuid, date, text) to service_role;

alter table public.room_work add column if not exists id uuid;
alter table public.room_work add column if not exists legacy_task_id uuid;

alter table public.room_work add column if not exists plan_dedupe_key text;
alter table public.room_work add column if not exists plan_cleaning_type text;
alter table public.room_work add column if not exists plan_priority text;
alter table public.room_work add column if not exists plan_due_by timestamptz;
alter table public.room_work add column if not exists plan_estimated_minutes integer;
alter table public.room_work add column if not exists plan_requires_inspection boolean;
alter table public.room_work add column if not exists plan_extras jsonb;
alter table public.room_work add column if not exists plan_notes text;
alter table public.room_work add column if not exists plan_rules_fired jsonb;
alter table public.room_work add column if not exists plan_rule_inputs jsonb;
alter table public.room_work add column if not exists plan_status text;
alter table public.room_work add column if not exists plan_source_pms_reservation_id text;
alter table public.room_work add column if not exists plan_source_engine_run_id uuid;
alter table public.room_work add column if not exists plan_source_property_timezone text;
alter table public.room_work add column if not exists plan_scheduled_at timestamptz;
alter table public.room_work add column if not exists plan_last_evaluated_at timestamptz;

alter table public.room_work add column if not exists assignment_queue_order integer;
alter table public.room_work add column if not exists assignment_assigned_at timestamptz;
alter table public.room_work add column if not exists assignment_assigned_by text;
alter table public.room_work add column if not exists assignment_assigned_by_user_id uuid;
alter table public.room_work add column if not exists assignment_reason text;
alter table public.room_work add column if not exists assignment_score numeric;
alter table public.room_work add column if not exists assignment_history jsonb;

update public.room_work
   set id = public.housekeeping_plan_id(property_id, date, room_number)
 where id is null;

update public.room_work
   set plan_dedupe_key = room_number || '::' || date::text
 where plan_dedupe_key is null;

update public.room_work
   set plan_requires_inspection = false
 where plan_requires_inspection is null;

update public.room_work
   set plan_extras = '[]'::jsonb
 where plan_extras is null;

update public.room_work
   set plan_rules_fired = '[]'::jsonb
 where plan_rules_fired is null;

update public.room_work
   set assignment_queue_order = 0
 where assignment_queue_order is null;

update public.room_work
   set assignment_history = '[]'::jsonb
 where assignment_history is null;

alter table public.room_work alter column id set not null;
alter table public.room_work alter column plan_requires_inspection set default false;
alter table public.room_work alter column plan_requires_inspection set not null;
alter table public.room_work alter column plan_extras set default '[]'::jsonb;
alter table public.room_work alter column plan_extras set not null;
alter table public.room_work alter column plan_rules_fired set default '[]'::jsonb;
alter table public.room_work alter column plan_rules_fired set not null;
alter table public.room_work alter column assignment_queue_order set default 0;
alter table public.room_work alter column assignment_queue_order set not null;
alter table public.room_work alter column assignment_history set default '[]'::jsonb;
alter table public.room_work alter column assignment_history set not null;

create unique index if not exists room_work_id_unique
  on public.room_work (id);
create unique index if not exists room_work_legacy_task_id_unique
  on public.room_work (legacy_task_id)
  where legacy_task_id is not null;
create index if not exists room_work_plan_property_date_idx
  on public.room_work (property_id, date, plan_status);

create or replace function public._room_work_fill_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expected_id uuid;
begin
  v_expected_id := public.housekeeping_plan_id(new.property_id, new.date, new.room_number);
  if new.id is null then
    new.id := v_expected_id;
  elsif new.id is distinct from v_expected_id then
    raise exception
      'E_ROOM_WORK_IDENTITY_MISMATCH: room_work.id must equal housekeeping_plan_id(property, date, room)'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.plan_dedupe_key is null then
    new.plan_dedupe_key := new.room_number || '::' || new.date::text;
  end if;
  return new;
end;
$$;

drop trigger if exists room_work_fill_identity on public.room_work;
create trigger room_work_fill_identity
  before insert or update on public.room_work
  for each row execute function public._room_work_fill_identity();

revoke all on function public._room_work_fill_identity() from public, anon, authenticated;
grant execute on function public._room_work_fill_identity() to service_role;

do $$
declare
  invalid_ids bigint;
begin
  select count(*)
    into invalid_ids
    from public.room_work w
   where w.id is not null
     and w.id is distinct from public.housekeeping_plan_id(w.property_id, w.date, w.room_number);

  if invalid_ids > 0 then
    raise exception
      '0434 preflight: % room_work row(s) have an id that does not match property/date/room; refusing to reconcile',
      invalid_ids;
  end if;
end;
$$;

do $$
declare
  invalid_assignments bigint;
  invalid_active_targets bigint;
begin
  -- Validate the complete assignment history before any filtered backfill.
  -- This must include inactive rows: silently omitting a historical
  -- cross-property row would make the canonical audit incomplete.
  select count(*)
    into invalid_assignments
    from public.hk_assignments a
    left join public.cleaning_tasks t on t.id = a.cleaning_task_id
    left join public.staff s on s.id = a.housekeeper_id
   where t.id is null
      or s.id is null
      or a.property_id is distinct from t.property_id
      or s.property_id is distinct from t.property_id
      or s.property_id is distinct from a.property_id;

  if invalid_assignments > 0 then
    raise exception
      '0434 preflight: % assignment history row(s) cross a task/staff property boundary or reference a missing row; refusing to reconcile',
      invalid_assignments;
  end if;

  -- These are active-state requirements only. Historical rows may point to a
  -- former or inactive housekeeper, but an active assignment may not.
  select count(*)
    into invalid_active_targets
    from public.hk_assignments a
    join public.staff s on s.id = a.housekeeper_id
   where a.is_active
     and (s.department is distinct from 'housekeeping' or coalesce(s.is_active, true) = false);

  if invalid_active_targets > 0 then
    raise exception
      '0434 preflight: % active assignment(s) target a non-housekeeping or inactive staff row; refusing to reconcile',
      invalid_active_targets;
  end if;
end;
$$;

do $$
declare
  duplicate_natural_keys bigint;
begin
  -- room_work has one canonical row per property/date/room. The legacy table
  -- only guaranteed property/dedupe uniqueness, so refuse an ambiguous
  -- natural-key group before INSERT ... ON CONFLICT could discard a task.
  select count(*)
    into duplicate_natural_keys
    from (
      select property_id, business_date, room_number
        from public.cleaning_tasks
       group by property_id, business_date, room_number
      having count(*) > 1
    ) conflicts;

  if duplicate_natural_keys > 0 then
    raise exception
      '0434 preflight: % cleaning_tasks natural-key group(s) contain multiple rows for the same property/date/room; refusing to reconcile',
      duplicate_natural_keys;
  end if;
end;
$$;

do $$
declare
  invalid_cache bigint;
  invalid_work bigint;
  invalid_legacy_links bigint;
  invalid_history bigint;
  invalid_active_history bigint;
  ambiguous_sources bigint;
begin
  select count(*)
    into invalid_cache
    from public.cleaning_tasks t
    left join public.staff s on s.id = t.assignee_id
   where t.assignee_id is not null
     and (
       s.id is null
       or s.property_id is distinct from t.property_id
       or s.department is distinct from 'housekeeping'
       or coalesce(s.is_active, true) = false
     );
  if invalid_cache > 0 then
    raise exception
      '0434 preflight: % cleaning_tasks assignee cache row(s) do not target an active same-property housekeeping staff row; refusing to reconcile',
      invalid_cache;
  end if;

  select count(*)
    into invalid_work
   from public.room_work w
    left join public.staff s on s.id = w.assigned_staff_id
   where w.assigned_staff_id is not null
     and (
       s.id is null
       or s.property_id is distinct from w.property_id
       or s.department is distinct from 'housekeeping'
       or coalesce(s.is_active, true) = false
     );
  if invalid_work > 0 then
    raise exception
      '0434 preflight: % room_work assignment row(s) do not target an active same-property housekeeping staff row; refusing to reconcile',
      invalid_work;
  end if;

  select count(*)
    into invalid_legacy_links
    from public.room_work w
    left join public.cleaning_tasks t on t.id = w.legacy_task_id
   where w.legacy_task_id is not null
     and (
       t.id is null
       or t.property_id is distinct from w.property_id
       or t.business_date is distinct from w.date
       or t.room_number is distinct from w.room_number
     );
  if invalid_legacy_links > 0 then
    raise exception
      '0434 preflight: % room_work legacy task link(s) are ambiguous or cross property/date/room; refusing to reconcile',
      invalid_legacy_links;
  end if;

  select count(*)
    into invalid_history
    from public.room_work w
   where jsonb_typeof(w.assignment_history) is distinct from 'array';
  if invalid_history > 0 then
    raise exception
      '0434 preflight: % existing room_work assignment history value(s) are not arrays; refusing to reconcile',
      invalid_history;
  end if;

  select count(*)
    into invalid_history
   from public.room_work w
    cross join lateral jsonb_array_elements(w.assignment_history) h
    left join public.staff s on s.id::text = h->>'housekeeper_id'
    left join public.cleaning_tasks t on t.id::text = h->>'cleaning_task_id'
   where (
        jsonb_typeof(h) is distinct from 'object'
      )
      or (
        h->>'property_id' is not null
        and h->>'property_id' is distinct from w.property_id::text
      )
      or (
        h->>'housekeeper_id' is not null
        and (s.id is null or s.property_id is distinct from w.property_id)
      )
      or (
        h->>'cleaning_task_id' is not null
        and (
          (
            t.id is null
            and (
              h->>'cleaning_task_id' is distinct from w.id::text
              or (
                w.legacy_task_id is not null
                and h->>'cleaning_task_id' is distinct from w.legacy_task_id::text
              )
            )
          )
          or (
            t.id is not null
            and (
              t.property_id is distinct from w.property_id
              or t.business_date is distinct from w.date
              or t.room_number is distinct from w.room_number
              or (
                w.legacy_task_id is not null
                and t.id is distinct from w.legacy_task_id
              )
            )
          )
        )
      );
  if invalid_history > 0 then
    raise exception
      '0434 preflight: % existing room_work assignment history snapshot(s) are malformed or cross property; refusing to reconcile',
      invalid_history;
  end if;

  -- Assignment history is append-only, so an old active receipt may be
  -- followed by an inactive/deactivated/superseded receipt for the same
  -- assignment id. Normalize by array position before any current-source or
  -- eligibility query; all receipts remain in room_work.assignment_history.
  create temporary table phase5_latest_room_work_assignment_history
  on commit drop
  as
  select w.id as work_id,
         w.property_id,
         w.date,
         w.room_number,
         h.snapshot,
         h.position,
         row_number() over (
           partition by w.id, h.snapshot->>'id'
           order by h.position desc
         ) as latest_position
    from public.room_work w
    cross join lateral jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
      with ordinality h(snapshot, position);

  create index phase5_latest_room_work_assignment_history_idx
    on phase5_latest_room_work_assignment_history (work_id, latest_position, position desc);

  select count(*)
    into invalid_active_history
    from phase5_latest_room_work_assignment_history latest
    join public.room_work w on w.id = latest.work_id
    left join public.cleaning_tasks t on t.id::text = latest.snapshot->>'cleaning_task_id'
    left join public.staff s on s.id::text = latest.snapshot->>'housekeeper_id'
   where latest.latest_position = 1
     and coalesce((latest.snapshot->>'is_active')::boolean, false)
     and (
       latest.snapshot->>'id' is null
       or latest.snapshot->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or latest.snapshot->>'property_id' is distinct from w.property_id::text
       or latest.snapshot->>'cleaning_task_id' is null
       or latest.snapshot->>'cleaning_task_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (
         t.id is null
         and (
           latest.snapshot->>'cleaning_task_id' is distinct from w.id::text
           or w.legacy_task_id is not null
         )
       )
       or (
         t.id is not null
         and (
           t.property_id is distinct from w.property_id
           or t.business_date is distinct from w.date
           or t.room_number is distinct from w.room_number
           or (
             w.legacy_task_id is not null
             and t.id is distinct from w.legacy_task_id
           )
         )
       )
       or latest.snapshot->>'housekeeper_id' is null
       or latest.snapshot->>'housekeeper_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or s.id is null
       or s.property_id is distinct from w.property_id
       or s.department is distinct from 'housekeeping'
       or coalesce(s.is_active, true) = false
       or not (latest.snapshot ? 'queue_order')
       or not (latest.snapshot ? 'assigned_at')
       or not (latest.snapshot ? 'assigned_by')
       or latest.snapshot->>'assigned_by' is null
       or latest.snapshot->>'assigned_by' not in (
         'auto', 'manual', 'rebalance', 'manager', 'pms_import',
         'alias_exact', 'alias_first_name', 'room_work'
       )
       or not (latest.snapshot ? 'assigned_by_user_id')
       or (
         latest.snapshot->>'assigned_by_user_id' is not null
         and latest.snapshot->>'assigned_by_user_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       or not (latest.snapshot ? 'reason')
       or not (latest.snapshot ? 'score')
       or not (latest.snapshot ? 'created_at')
       or not (latest.snapshot ? 'updated_at')
       or (
         latest.snapshot->>'assigned_source' is not null
         and latest.snapshot->>'assigned_source' not in ('manager', 'auto', 'alias_exact', 'alias_first_name', 'pms_import')
       )
     );
  if invalid_active_history > 0 then
    raise exception
      '0434 preflight: % latest active room_work assignment history snapshot(s) are incomplete, invalid, or target an ineligible same-property housekeeping staff row; refusing to reconcile',
      invalid_active_history;
  end if;

  with source_staff as (
    select t.property_id, t.business_date, t.room_number, t.assignee_id as staff_id
      from public.cleaning_tasks t
     where t.assignee_id is not null
    union all
    select t.property_id, t.business_date, t.room_number, a.housekeeper_id
      from public.cleaning_tasks t
      join public.hk_assignments a on a.cleaning_task_id = t.id
     where a.is_active
    union all
    select w.property_id, w.date, w.room_number, w.assigned_staff_id
      from public.room_work w
     where w.assigned_staff_id is not null
    union all
    select latest.property_id, latest.date, latest.room_number, s.id
      from phase5_latest_room_work_assignment_history latest
      join public.staff s on s.id::text = latest.snapshot->>'housekeeper_id'
     where latest.latest_position = 1
       and coalesce((latest.snapshot->>'is_active')::boolean, false)
  ), conflicts as (
    select property_id, business_date, room_number
      from source_staff
     group by property_id, business_date, room_number
    having count(distinct staff_id) > 1
  )
  select count(*) into ambiguous_sources from conflicts;

  if ambiguous_sources > 0 then
    raise exception
      '0434 preflight: % property/date/room assignment source group(s) disagree across hk_assignments, cleaning_tasks, and room_work; refusing to reconcile',
      ambiguous_sources;
  end if;
end;
$$;

-- Keep the old-write compatibility bridge on the legacy single-row
-- serialization protocol during the expand window. The old application may
-- already hold a room_work row lock before it writes a legacy table, so this
-- bridge must not introduce the dormant canonical component-set lock order.
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

-- Install the old-write bridge before the reconciliation so the old
-- application cannot commit a task or assignment into the gap between 0434
-- and 0435. The bridge remains installed through the compatibility window;
-- the later contract stage removes it after the canonical app is live.
create or replace function public._legacy_cleaning_task_to_room_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_work public.room_work;
  v_owner public.room_work;
  v_current jsonb;
  v_cache_snapshot jsonb;
  v_active_staff uuid;
  v_cache_staff record;
  v_workflow_status text;
  v_cache_now timestamptz;
  v_has_work boolean;
  v_assignee_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_assignee_changed := true;
  else
    v_assignee_changed := old.assignee_id is distinct from new.assignee_id;
  end if;

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

  -- Old task writers update status, inspection, and rules metadata without
  -- changing the denormalized assignee cache. Do not revalidate an unchanged
  -- archived assignee; only a new or changed cache target needs eligibility
  -- validation during the compatibility window.
  if v_assignee_changed and new.assignee_id is not null then
    select s.property_id, s.department, coalesce(s.is_active, true) as is_active
      into v_cache_staff
      from public.staff s
     where s.id = new.assignee_id;
    if not found then
      raise exception
        'E_LEGACY_ASSIGNMENT_INVALID_TARGET: task cache assignee must be an active same-property housekeeper'
        using errcode = 'check_violation';
    end if;
    if v_cache_staff.property_id is distinct from new.property_id
       or v_cache_staff.department is distinct from 'housekeeping'
       or v_cache_staff.is_active = false then
      raise exception
        'E_LEGACY_ASSIGNMENT_INVALID_TARGET: task cache assignee must be an active same-property housekeeper'
        using errcode = 'check_violation';
    end if;
  end if;

  select * into v_owner
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
      new.id using errcode = 'integrity_constraint_violation';
  end if;

  select * into v_work
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
      v_work.legacy_task_id using errcode = 'integrity_constraint_violation';
  end if;

  if exists (
    select 1 from public.room_work w
     where w.property_id = new.property_id
       and w.plan_dedupe_key = new.dedupe_key
       and (w.date, w.room_number) is distinct from (new.business_date, new.room_number)
  ) then
    raise exception
      'E_LEGACY_PLAN_AMBIGUOUS: duplicate dedupe key % in property %',
      new.dedupe_key, new.property_id using errcode = 'unique_violation';
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
    ) returning * into v_work;
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
           paused_at = case when new.status = 'paused' then coalesce(new.paused_at, v_work.paused_at) else v_work.paused_at end,
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

  select a.housekeeper_id into v_active_staff
    from public.hk_assignments a
   where a.property_id = new.property_id
     and a.cleaning_task_id = new.id
     and a.is_active
   order by a.assigned_at desc, a.created_at desc, a.id desc
   limit 1;

  if v_assignee_changed
     and new.assignee_id is not null
     and v_active_staff is not null
     and v_active_staff is distinct from new.assignee_id then
    raise exception
      'E_LEGACY_ASSIGNMENT_MISMATCH: task cache does not match active assignment'
      using errcode = 'integrity_constraint_violation';
  end if;

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

  if not v_assignee_changed then
    return new;
  end if;

  -- A cache-only old write may create an assignment when no active legacy row
  -- exists. If canonical state already names another person, fail closed
  -- rather than overwriting a canonical manager decision with stale cache data.
  if new.assignee_id is not null and v_active_staff is null then
    if v_work.assigned_staff_id is not null
       and v_work.assigned_staff_id is distinct from new.assignee_id
       and not (
         tg_op = 'UPDATE'
         and old.assignee_id is not null
         and old.assignee_id = v_work.assigned_staff_id
       ) then
      raise exception
        'E_LEGACY_ASSIGNMENT_MISMATCH: task cache does not match canonical assignment'
        using errcode = 'integrity_constraint_violation';
    end if;

    if v_work.assigned_staff_id is null
       or v_work.assigned_staff_id is distinct from new.assignee_id then
      v_cache_now := now();
      v_cache_snapshot := jsonb_build_object(
        'id', gen_random_uuid(),
        'property_id', new.property_id,
        'cleaning_task_id', new.id,
        'housekeeper_id', new.assignee_id,
        'queue_order', coalesce(v_work.assignment_queue_order, 0),
        'is_active', true,
        'assigned_at', v_cache_now,
        'assigned_by', 'pms_import',
        'assigned_source', 'pms_import',
        'assigned_by_user_id', null,
        'reason', 'legacy cache',
        'score', null,
        'created_at', v_cache_now,
        'updated_at', v_cache_now,
        'event', 'legacy_cache_assigned',
        'changed_at', v_cache_now
      );
      perform set_config('staxis.housekeeping_legacy_bridge', 'on', true);
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
               'assigned_source', assigned_source,
               'assigned_by_user_id', assignment_assigned_by_user_id,
               'reason', assignment_reason,
               'score', assignment_score,
               'created_at', coalesce(created_at, v_cache_now),
               'updated_at', coalesce(updated_at, v_cache_now)
             )) || jsonb_build_object(
               'is_active', false,
               'event', 'superseded',
               'changed_at', v_cache_now,
               'updated_at', v_cache_now
             )
           )
         end || jsonb_build_array(v_cache_snapshot),
             assigned_staff_id = new.assignee_id,
             assigned_source = 'pms_import',
             assignment_queue_order = coalesce(assignment_queue_order, 0),
             assignment_assigned_at = v_cache_now,
             assignment_assigned_by = null,
             assignment_assigned_by_user_id = null,
             assignment_reason = null,
             assignment_score = null
       where property_id = new.property_id
         and date = new.business_date
         and room_number = new.room_number;
      perform set_config('staxis.housekeeping_legacy_bridge', 'off', true);
    end if;
  elsif new.assignee_id is null
        and v_active_staff is null
        and v_work.assigned_staff_id is not null then
    -- An INSERT with a null cache carries no unassignment transition. Keep
    -- any already-canonical room-work assignment intact.
    if tg_op <> 'UPDATE' or old.assignee_id is null then
      return new;
    end if;
    if old.assignee_id is distinct from v_work.assigned_staff_id then
      raise exception
        'E_LEGACY_ASSIGNMENT_MISMATCH: null task cache does not match canonical assignment'
        using errcode = 'integrity_constraint_violation';
    end if;

    perform set_config('staxis.housekeeping_legacy_bridge', 'on', true);
    update public.room_work
       set assignment_history = assignment_history || jsonb_build_array(
         coalesce(v_current, jsonb_build_object(
           'id', gen_random_uuid(),
           'property_id', new.property_id,
           'cleaning_task_id', new.id,
           'housekeeper_id', assigned_staff_id,
           'queue_order', assignment_queue_order,
           'is_active', true,
           'assigned_at', assignment_assigned_at,
           'assigned_by', assignment_assigned_by,
           'assigned_source', assigned_source,
           'assigned_by_user_id', assignment_assigned_by_user_id,
           'reason', assignment_reason,
           'score', assignment_score,
           'created_at', now(),
           'updated_at', now()
         )) || jsonb_build_object(
           'is_active', false,
           'event', 'legacy_cache_unassigned',
           'changed_at', now(),
           'updated_at', now()
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
  v_latest jsonb;
  v_current jsonb;
  v_snapshot jsonb;
  v_same_payload boolean;
  v_clear boolean;
begin
  if tg_op = 'UPDATE'
     and (
       old.id is distinct from new.id
       or old.property_id is distinct from new.property_id
       or old.cleaning_task_id is distinct from new.cleaning_task_id
       or old.housekeeper_id is distinct from new.housekeeper_id
     ) then
    raise exception
      'E_LEGACY_ASSIGNMENT_IDENTITY_MUTATION: assignment id, property, task, and housekeeper identity cannot change in place'
      using errcode = 'integrity_constraint_violation';
  end if;

  select t.property_id, t.business_date, t.room_number into v_task
    from public.cleaning_tasks t where t.id = new.cleaning_task_id;
  if not found then
    raise exception 'E_LEGACY_ASSIGNMENT_ORPHAN: cleaning task % does not exist', new.cleaning_task_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_task.property_id is distinct from new.property_id then
    raise exception 'E_LEGACY_ASSIGNMENT_CROSS_PROPERTY: assignment and task properties differ'
      using errcode = 'foreign_key_violation';
  end if;

  select s.property_id, s.department, coalesce(s.is_active, true) as is_active into v_staff
    from public.staff s where s.id = new.housekeeper_id;
  if not found or v_staff.property_id is distinct from new.property_id then
    raise exception 'E_LEGACY_ASSIGNMENT_CROSS_PROPERTY: housekeeper is not at the task property'
      using errcode = 'foreign_key_violation';
  end if;
  if new.is_active and (v_staff.department is distinct from 'housekeeping' or v_staff.is_active = false) then
    raise exception 'E_LEGACY_ASSIGNMENT_INVALID_TARGET: active assignment target is not an active housekeeper'
      using errcode = 'check_violation';
  end if;

  select * into v_work
    from public.room_work w
   where w.property_id = new.property_id
     and w.date = v_task.business_date
     and w.room_number = v_task.room_number
   for update;
  if not found or (v_work.legacy_task_id is not null and v_work.legacy_task_id is distinct from new.cleaning_task_id) then
    raise exception 'E_LEGACY_ASSIGNMENT_AMBIGUOUS: canonical room-work row is missing or belongs to another task'
      using errcode = 'integrity_constraint_violation';
  end if;

  select e.snapshot into v_latest
    from jsonb_array_elements(coalesce(v_work.assignment_history, '[]'::jsonb)) with ordinality e(snapshot, position)
   where e.snapshot->>'id' = new.id::text
   order by e.position desc
   limit 1;
    select e.snapshot into v_current
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

  v_snapshot := jsonb_build_object(
    'id', new.id,
    'property_id', new.property_id,
    'cleaning_task_id', new.cleaning_task_id,
    'housekeeper_id', new.housekeeper_id,
    'queue_order', new.queue_order,
    'is_active', new.is_active,
    'assigned_at', new.assigned_at,
    'assigned_by', new.assigned_by,
    'assigned_source', case when new.assigned_by = 'auto' then 'auto' else 'manager' end,
    'assigned_by_user_id', new.assigned_by_user_id,
    'reason', new.reason,
    'score', new.score,
    'created_at', new.created_at,
    'updated_at', new.updated_at,
    'event', case
      when not new.is_active then 'deactivated'
      when v_latest is null then 'assigned'
      when coalesce((v_latest->>'is_active')::boolean, false) then 'updated'
      else 'reactivated'
    end,
    'changed_at', now()
  );
  v_same_payload := v_latest is not null
    and v_latest ? 'property_id'
    and v_latest ? 'cleaning_task_id'
    and v_latest ? 'housekeeper_id'
    and v_latest ? 'queue_order'
    and v_latest ? 'is_active'
    and v_latest ? 'assigned_at'
    and v_latest ? 'assigned_by'
    and v_latest ? 'assigned_by_user_id'
    and v_latest ? 'reason'
    and v_latest ? 'score'
    and v_latest ? 'created_at'
    and v_latest ? 'updated_at'
    and jsonb_build_object(
      'id', v_latest->>'id',
      'property_id', v_latest->>'property_id',
      'cleaning_task_id', v_latest->>'cleaning_task_id',
      'housekeeper_id', v_latest->>'housekeeper_id',
      'queue_order', (v_latest->>'queue_order')::integer,
      'is_active', (v_latest->>'is_active')::boolean,
      'assigned_at', (v_latest->>'assigned_at')::timestamptz,
      'assigned_by', v_latest->>'assigned_by',
      'assigned_source', coalesce(
        v_latest->>'assigned_source',
        case
          when v_latest->>'assigned_by' = 'auto' then 'auto'
          when v_latest->>'assigned_by' in ('manual', 'rebalance') then 'manager'
          else null
        end
      ),
      'assigned_by_user_id', (v_latest->>'assigned_by_user_id')::uuid,
      'reason', v_latest->>'reason',
      'score', (v_latest->>'score')::numeric,
      'created_at', (v_latest->>'created_at')::timestamptz,
      'updated_at', (v_latest->>'updated_at')::timestamptz
    ) = jsonb_build_object(
      'id', new.id,
      'property_id', new.property_id,
      'cleaning_task_id', new.cleaning_task_id,
      'housekeeper_id', new.housekeeper_id,
      'queue_order', new.queue_order,
      'is_active', new.is_active,
      'assigned_at', new.assigned_at,
      'assigned_by', new.assigned_by,
      'assigned_source', case when new.assigned_by = 'auto' then 'auto' else 'manager' end,
      'assigned_by_user_id', new.assigned_by_user_id,
      'reason', new.reason,
      'score', new.score,
      'created_at', new.created_at,
      'updated_at', new.updated_at
    );
  -- hk_assignments inherits the deployed _pms_set_updated_at BEFORE trigger,
  -- so a retry changes only updated_at even when the caller repeats the exact
  -- same payload. Keep updated_at in the full comparator above, but treat
  -- this one server-generated timestamp as an exact retry when every other
  -- identity/payload field is byte-for-byte unchanged.
  if not v_same_payload
     and v_latest is not null
     and v_latest ? 'updated_at'
     and (v_latest - 'event' - 'changed_at' - 'updated_at')
       = (v_snapshot - 'event' - 'changed_at' - 'updated_at') then
    v_same_payload := true;
  end if;
  v_clear := not new.is_active
    and v_work.assigned_staff_id = new.housekeeper_id
    and (v_latest is null or coalesce((v_latest->>'is_active')::boolean, false));

  perform set_config('staxis.housekeeping_legacy_bridge', 'on', true);
  if new.is_active then
    update public.room_work
       set assignment_history = case
         when v_work.assigned_staff_id is not null
              and (
                v_work.assigned_staff_id is distinct from new.housekeeper_id
                or v_current is null
                or v_current->>'id' is distinct from new.id::text
              )
           then assignment_history || jsonb_build_array(
             coalesce(v_current, jsonb_build_object(
               'id', gen_random_uuid(),
               'property_id', new.property_id,
               'cleaning_task_id', new.cleaning_task_id,
               'housekeeper_id', assigned_staff_id,
               'queue_order', assignment_queue_order,
               'is_active', true,
               'assigned_at', assignment_assigned_at,
               'assigned_by', assignment_assigned_by,
               'assigned_source', assigned_source,
               'assigned_by_user_id', assignment_assigned_by_user_id,
               'reason', assignment_reason,
               'score', assignment_score,
               'created_at', now(),
               'updated_at', now()
             )) || jsonb_build_object(
               'is_active', false,
               'event', 'superseded',
               'changed_at', now(),
               'updated_at', now()
             )
           )
         else assignment_history
       end || case when not v_same_payload then jsonb_build_array(v_snapshot) else '[]'::jsonb end,
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
  elsif not v_same_payload then
    update public.room_work
       set assignment_history = assignment_history || jsonb_build_array(v_snapshot),
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
  elsif v_clear then
    update public.room_work
       set assigned_staff_id = null,
           assigned_source = null,
           assignment_queue_order = 0,
           assignment_assigned_at = null,
           assignment_assigned_by = null,
           assignment_assigned_by_user_id = null,
           assignment_reason = null,
           assignment_score = null
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
revoke all on function public._lock_room_work_component_set(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public._legacy_cleaning_task_to_room_work() to service_role;
grant execute on function public._legacy_hk_assignment_to_room_work() to service_role;
grant execute on function public._lock_room_work_component_set(uuid, date, text[]) to service_role;

drop trigger if exists trg_legacy_cleaning_task_to_room_work on public.cleaning_tasks;
create trigger trg_legacy_cleaning_task_to_room_work
  after insert or update on public.cleaning_tasks
  for each row execute function public._legacy_cleaning_task_to_room_work();

drop trigger if exists trg_legacy_hk_assignment_to_room_work on public.hk_assignments;
create trigger trg_legacy_hk_assignment_to_room_work
  after insert or update on public.hk_assignments
  for each row execute function public._legacy_hk_assignment_to_room_work();

-- Every legacy task gets a canonical row. Existing room-work state wins for
-- workflow fields; the task row supplies only the manager plan metadata and
-- fills missing workflow timestamps. This prevents a stale rules row from
-- moving an already-started housekeeper clean backwards.
insert into public.room_work (
  id,
  legacy_task_id,
  property_id,
  date,
  room_number,
  plan_dedupe_key,
  plan_cleaning_type,
  plan_priority,
  plan_due_by,
  plan_estimated_minutes,
  plan_requires_inspection,
  plan_extras,
  plan_notes,
  plan_rules_fired,
  plan_rule_inputs,
  plan_status,
  plan_source_pms_reservation_id,
  plan_source_engine_run_id,
  plan_source_property_timezone,
  plan_scheduled_at,
  plan_last_evaluated_at,
  started_at,
  paused_at,
  completed_at,
  inspected_at,
  is_paused,
  status,
  created_at
)
select
  public.housekeeping_plan_id(t.property_id, t.business_date, t.room_number),
  t.id,
  t.property_id,
  t.business_date,
  t.room_number,
  t.dedupe_key,
  t.cleaning_type,
  t.priority,
  t.due_by,
  t.estimated_minutes,
  t.requires_inspection,
  t.extras,
  t.notes,
  t.rules_fired,
  t.rule_inputs,
  t.status,
  t.source_pms_reservation_id,
  t.source_engine_run_id,
  t.source_property_timezone,
  t.scheduled_at,
  t.last_evaluated_at,
  case when t.status in ('in_progress', 'paused') then t.started_at end,
  case when t.status = 'paused' then t.paused_at end,
  case when t.status = 'completed' then t.completed_at end,
  case when t.status in ('inspected_pass', 'inspected_fail') then t.inspected_at end,
  t.status = 'paused',
  case
    when t.status in ('in_progress', 'paused') then 'in_progress'
    when t.status = 'completed' then 'completed'
    when t.status in ('skipped', 'cancelled', 'superseded') then 'skipped'
    else 'not_started'
  end,
  t.created_at
from public.cleaning_tasks t
on conflict (property_id, date, room_number) do nothing;

update public.room_work w
   set legacy_task_id = t.id,
       plan_dedupe_key = t.dedupe_key,
       plan_cleaning_type = t.cleaning_type,
       plan_priority = t.priority,
       plan_due_by = t.due_by,
       plan_estimated_minutes = t.estimated_minutes,
       plan_requires_inspection = t.requires_inspection,
       plan_extras = t.extras,
       plan_notes = t.notes,
       plan_rules_fired = t.rules_fired,
       plan_rule_inputs = t.rule_inputs,
       plan_status = t.status,
       plan_source_pms_reservation_id = t.source_pms_reservation_id,
       plan_source_engine_run_id = t.source_engine_run_id,
       plan_source_property_timezone = t.source_property_timezone,
       plan_scheduled_at = t.scheduled_at,
       plan_last_evaluated_at = t.last_evaluated_at,
       started_at = coalesce(w.started_at, t.started_at),
       paused_at = coalesce(w.paused_at, t.paused_at),
       completed_at = coalesce(w.completed_at, t.completed_at),
       inspected_at = coalesce(w.inspected_at, t.inspected_at),
       is_paused = case
         when w.status in ('in_progress', 'completed', 'refused', 'skipped') then w.is_paused
         when t.status = 'paused' then true
         else w.is_paused
       end
  from public.cleaning_tasks t
 where w.property_id = t.property_id
   and w.date = t.business_date
   and w.room_number = t.room_number
   and (
     w.legacy_task_id is distinct from t.id
     or w.plan_dedupe_key is distinct from t.dedupe_key
     or w.plan_cleaning_type is distinct from t.cleaning_type
     or w.plan_priority is distinct from t.priority
     or w.plan_due_by is distinct from t.due_by
     or w.plan_estimated_minutes is distinct from t.estimated_minutes
     or w.plan_requires_inspection is distinct from t.requires_inspection
     or w.plan_extras is distinct from t.extras
     or w.plan_notes is distinct from t.notes
     or w.plan_rules_fired is distinct from t.rules_fired
     or w.plan_rule_inputs is distinct from t.rule_inputs
     or w.plan_status is distinct from t.status
     or w.plan_source_pms_reservation_id is distinct from t.source_pms_reservation_id
     or w.plan_source_engine_run_id is distinct from t.source_engine_run_id
     or w.plan_source_property_timezone is distinct from t.source_property_timezone
     or w.plan_scheduled_at is distinct from t.scheduled_at
     or w.plan_last_evaluated_at is distinct from t.last_evaluated_at
     or (w.started_at is null and t.started_at is not null)
     or (w.paused_at is null and t.paused_at is not null)
     or (w.completed_at is null and t.completed_at is not null)
     or (w.inspected_at is null and t.inspected_at is not null)
     or (t.status = 'paused' and w.is_paused is distinct from true)
   );

do $$
declare
  duplicate_count bigint;
begin
  -- The legacy pair enforced this invariant on cleaning_tasks. Check the
  -- reconciled canonical values before installing the equivalent constraint.
  select count(*)
    into duplicate_count
    from (
      select property_id, plan_dedupe_key
        from public.room_work
       where plan_dedupe_key is not null
       group by property_id, plan_dedupe_key
      having count(*) > 1
    ) conflicts;

  if duplicate_count > 0 then
    raise exception
      '0434 preflight: % conflicting canonical (property_id, plan_dedupe_key) group(s); refusing to reconcile',
      duplicate_count;
  end if;
end;
$$;

create unique index if not exists room_work_plan_dedupe_unique
  on public.room_work (property_id, plan_dedupe_key)
  where plan_dedupe_key is not null;

-- The pre-0434 constraint does not know the canonical auto assignment source.
-- Remove it before the assignment snapshot is populated, then install the
-- expanded constraint below after every row has its source value.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_assigned_source_chk'
  ) then
    alter table public.room_work drop constraint room_work_assigned_source_chk;
  end if;
end;
$$;

-- Preserve every pre-existing room_work snapshot and merge the full legacy
-- assignment history into it. A matching assignment id/payload is retained
-- only once, while a metadata/status change is appended as a new receipt.
with assignment_merges as (
  select w.id,
         coalesce((
         select jsonb_agg(snapshot order by sort_created, sort_id)
           from (
             select jsonb_build_object(
               'id', a.id,
               'property_id', a.property_id,
               'cleaning_task_id', a.cleaning_task_id,
               'housekeeper_id', a.housekeeper_id,
               'queue_order', a.queue_order,
               'is_active', a.is_active,
               'assigned_at', a.assigned_at,
               'assigned_by', a.assigned_by,
               'assigned_source', case when a.assigned_by = 'auto' then 'auto' else 'manager' end,
               'assigned_by_user_id', a.assigned_by_user_id,
               'reason', a.reason,
               'score', a.score,
               'created_at', a.created_at,
               'updated_at', a.updated_at,
               'event', 'reconciled_hk_assignment'
             ) as snapshot,
             a.created_at as sort_created,
             a.id as sort_id
               from public.hk_assignments a
              where a.property_id = w.property_id
                and a.cleaning_task_id = w.legacy_task_id
                and not exists (
                  select 1
                    from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb)) h
                   where h->>'id' = a.id::text
                     and h ? 'property_id'
                     and h ? 'cleaning_task_id'
                     and h ? 'housekeeper_id'
                     and h ? 'queue_order'
                     and h ? 'is_active'
                     and h ? 'assigned_at'
                     and h ? 'assigned_by'
                     and h ? 'assigned_by_user_id'
                     and h ? 'reason'
                     and h ? 'score'
                     and h ? 'created_at'
                     and h ? 'updated_at'
                     and jsonb_build_object(
                       'id', h->>'id',
                       'property_id', h->>'property_id',
                       'cleaning_task_id', h->>'cleaning_task_id',
                       'housekeeper_id', h->>'housekeeper_id',
                       'queue_order', (h->>'queue_order')::integer,
                       'is_active', (h->>'is_active')::boolean,
                       'assigned_at', (h->>'assigned_at')::timestamptz,
                       'assigned_by', h->>'assigned_by',
                       'assigned_source', coalesce(
                         h->>'assigned_source',
                         case
                           when h->>'assigned_by' = 'auto' then 'auto'
                           when h->>'assigned_by' in ('manual', 'rebalance') then 'manager'
                           else null
                         end
                       ),
                       'assigned_by_user_id', (h->>'assigned_by_user_id')::uuid,
                       'reason', h->>'reason',
                       'score', (h->>'score')::numeric,
                       'created_at', (h->>'created_at')::timestamptz,
                       'updated_at', (h->>'updated_at')::timestamptz
                     ) = jsonb_build_object(
                       'id', a.id,
                       'property_id', a.property_id,
                       'cleaning_task_id', a.cleaning_task_id,
                       'housekeeper_id', a.housekeeper_id,
                       'queue_order', a.queue_order,
                       'is_active', a.is_active,
                       'assigned_at', a.assigned_at,
                       'assigned_by', a.assigned_by,
                       'assigned_source', case when a.assigned_by = 'auto' then 'auto' else 'manager' end,
                       'assigned_by_user_id', a.assigned_by_user_id,
                       'reason', a.reason,
                       'score', a.score,
                       'created_at', a.created_at,
                       'updated_at', a.updated_at
                     )
                )
           ) snapshots
       ), '[]'::jsonb) as appended_history
    from public.room_work w
   where w.legacy_task_id is not null
)
update public.room_work w
   set assignment_history = coalesce(w.assignment_history, '[]'::jsonb) || m.appended_history
  from assignment_merges m
 where w.id = m.id
   and coalesce(w.assignment_history, '[]'::jsonb) is distinct from
       coalesce(w.assignment_history, '[]'::jsonb) || m.appended_history;

-- Reconcile the current assignment from all four proven sources. The
-- preflight above guarantees that every non-null candidate agrees, so source
-- priority is deterministic rather than a hidden conflict resolver. A
-- complete active history snapshot is last: it restores current state only
-- when hk_assignments, the task cache, and room_work current columns are all
-- absent, while preserving every history receipt. The null-safe full-payload
-- guard below is important: an unchanged reconciliation must not fire
-- room_work's set_updated_at trigger.
update public.room_work w
   set assigned_staff_id = coalesce(s.active_staff_id, s.cache_staff_id, w.assigned_staff_id, s.history_staff_id),
       assigned_source = case
         when s.active_staff_id is not null then case
           when s.active_assigned_by = 'auto' then 'auto'
           else 'manager'
         end
         when s.cache_staff_id is not null then coalesce(w.assigned_source, 'pms_import')
         when w.assigned_staff_id is not null then w.assigned_source
         when s.history_staff_id is not null then coalesce(
           s.history_assigned_source,
           case
             when s.history_assigned_by = 'auto' then 'auto'
             when s.history_assigned_by in ('manual', 'rebalance', 'manager') then 'manager'
             when s.history_assigned_by in ('pms_import', 'alias_exact', 'alias_first_name') then s.history_assigned_by
             else coalesce(w.assigned_source, 'manager')
           end
         )
         else w.assigned_source
       end,
       assignment_queue_order = case
         when s.active_staff_id is not null then s.active_queue_order
         when s.cache_staff_id is not null or w.assigned_staff_id is not null then w.assignment_queue_order
         when s.history_staff_id is not null then s.history_queue_order
         else w.assignment_queue_order
       end,
       assignment_assigned_at = case
         when s.active_staff_id is not null then s.active_assigned_at
         when s.cache_staff_id is not null or w.assigned_staff_id is not null then w.assignment_assigned_at
         when s.history_staff_id is not null then s.history_assigned_at
         else w.assignment_assigned_at
       end,
       assignment_assigned_by = case
         when s.active_staff_id is not null then s.active_assigned_by
         when s.cache_staff_id is not null or w.assigned_staff_id is not null then w.assignment_assigned_by
         when s.history_staff_id is not null
           then case
             when s.history_assigned_by in ('auto', 'manual', 'rebalance') then s.history_assigned_by
             else null
           end
         else w.assignment_assigned_by
       end,
       assignment_assigned_by_user_id = case
         when s.active_staff_id is not null then s.active_assigned_by_user_id
         when s.cache_staff_id is not null or w.assigned_staff_id is not null then w.assignment_assigned_by_user_id
         when s.history_staff_id is not null then s.history_assigned_by_user_id
         else w.assignment_assigned_by_user_id
       end,
       assignment_reason = case
         when s.active_staff_id is not null then s.active_reason
         when s.cache_staff_id is not null or w.assigned_staff_id is not null then w.assignment_reason
         when s.history_staff_id is not null then s.history_reason
         else w.assignment_reason
       end,
       assignment_score = case
         when s.active_staff_id is not null then s.active_score
         when s.cache_staff_id is not null or w.assigned_staff_id is not null then w.assignment_score
         when s.history_staff_id is not null then s.history_score
         else w.assignment_score
       end
  from (
    select w0.id,
           w0.assigned_staff_id as current_assigned_staff_id,
           w0.assigned_source as current_assigned_source,
           w0.assignment_queue_order as current_assignment_queue_order,
           w0.assignment_assigned_at as current_assignment_assigned_at,
           w0.assignment_assigned_by as current_assignment_assigned_by,
           w0.assignment_assigned_by_user_id as current_assignment_assigned_by_user_id,
           w0.assignment_reason as current_assignment_reason,
           w0.assignment_score as current_assignment_score,
           t.assignee_id as cache_staff_id,
           a.housekeeper_id as active_staff_id,
           a.queue_order as active_queue_order,
           a.assigned_at as active_assigned_at,
           a.assigned_by as active_assigned_by,
           a.assigned_by_user_id as active_assigned_by_user_id,
           a.reason as active_reason,
           a.score as active_score,
           history.history_staff_id,
           history.history_queue_order,
           history.history_assigned_at,
           history.history_assigned_by,
           history.history_assigned_by_user_id,
           history.history_reason,
           history.history_score,
           history.history_assigned_source
      from public.room_work w0
      left join public.cleaning_tasks t on t.id = w0.legacy_task_id
      left join lateral (
        select a.housekeeper_id, a.queue_order, a.assigned_at, a.assigned_by,
               a.assigned_by_user_id, a.reason, a.score
          from public.hk_assignments a
         where a.property_id = w0.property_id
           and a.cleaning_task_id = w0.legacy_task_id
           and a.is_active
         order by a.assigned_at desc, a.created_at desc, a.id desc
         limit 1
      ) a on true
      left join lateral (
        select
          (h.snapshot->>'housekeeper_id')::uuid as history_staff_id,
          (h.snapshot->>'queue_order')::integer as history_queue_order,
          (h.snapshot->>'assigned_at')::timestamptz as history_assigned_at,
          h.snapshot->>'assigned_by' as history_assigned_by,
          (h.snapshot->>'assigned_by_user_id')::uuid as history_assigned_by_user_id,
          h.snapshot->>'reason' as history_reason,
          (h.snapshot->>'score')::numeric as history_score,
          h.snapshot->>'assigned_source' as history_assigned_source
          from phase5_latest_room_work_assignment_history h
         where h.work_id = w0.id
           and h.latest_position = 1
           and h.snapshot->>'property_id' = w0.property_id::text
           and h.snapshot->>'cleaning_task_id' = coalesce(w0.legacy_task_id, w0.id)::text
           and h.snapshot->>'housekeeper_id' is not null
           and coalesce((h.snapshot->>'is_active')::boolean, false)
         order by h.position desc
         limit 1
      ) history on true
  ) s
  cross join lateral (
    select
      coalesce(s.active_staff_id, s.cache_staff_id, s.current_assigned_staff_id, s.history_staff_id) as next_assigned_staff_id,
      case
        when s.active_staff_id is not null then case
          when s.active_assigned_by = 'auto' then 'auto'
          else 'manager'
        end
        when s.cache_staff_id is not null then coalesce(s.current_assigned_source, 'pms_import')
        when s.current_assigned_staff_id is not null then s.current_assigned_source
        when s.history_staff_id is not null then coalesce(
          s.history_assigned_source,
          case
            when s.history_assigned_by = 'auto' then 'auto'
            when s.history_assigned_by in ('manual', 'rebalance', 'manager') then 'manager'
            when s.history_assigned_by in ('pms_import', 'alias_exact', 'alias_first_name') then s.history_assigned_by
            else coalesce(s.current_assigned_source, 'manager')
          end
        )
        else s.current_assigned_source
      end as next_assigned_source,
      case
        when s.active_staff_id is not null then s.active_queue_order
        when s.cache_staff_id is not null or s.current_assigned_staff_id is not null then s.current_assignment_queue_order
        when s.history_staff_id is not null then s.history_queue_order
        else s.current_assignment_queue_order
      end as next_assignment_queue_order,
      case
        when s.active_staff_id is not null then s.active_assigned_at
        when s.cache_staff_id is not null or s.current_assigned_staff_id is not null then s.current_assignment_assigned_at
        when s.history_staff_id is not null then s.history_assigned_at
        else s.current_assignment_assigned_at
      end as next_assignment_assigned_at,
      case
        when s.active_staff_id is not null then s.active_assigned_by
        when s.cache_staff_id is not null or s.current_assigned_staff_id is not null then s.current_assignment_assigned_by
        when s.history_staff_id is not null then case
          when s.history_assigned_by in ('auto', 'manual', 'rebalance') then s.history_assigned_by
          else null
        end
        else s.current_assignment_assigned_by
      end as next_assignment_assigned_by,
      case
        when s.active_staff_id is not null then s.active_assigned_by_user_id
        when s.cache_staff_id is not null or s.current_assigned_staff_id is not null then s.current_assignment_assigned_by_user_id
        when s.history_staff_id is not null then s.history_assigned_by_user_id
        else s.current_assignment_assigned_by_user_id
      end as next_assignment_assigned_by_user_id,
      case
        when s.active_staff_id is not null then s.active_reason
        when s.cache_staff_id is not null or s.current_assigned_staff_id is not null then s.current_assignment_reason
        when s.history_staff_id is not null then s.history_reason
        else s.current_assignment_reason
      end as next_assignment_reason,
      case
        when s.active_staff_id is not null then s.active_score
        when s.cache_staff_id is not null or s.current_assigned_staff_id is not null then s.current_assignment_score
        when s.history_staff_id is not null then s.history_score
        else s.current_assignment_score
      end as next_assignment_score
  ) d
 where w.id = s.id
   and (w.assigned_staff_id,
        w.assigned_source,
        w.assignment_queue_order,
        w.assignment_assigned_at,
        w.assignment_assigned_by,
        w.assignment_assigned_by_user_id,
        w.assignment_reason,
        w.assignment_score) is distinct from
       (d.next_assigned_staff_id,
        d.next_assigned_source,
        d.next_assignment_queue_order,
        d.next_assignment_assigned_at,
        d.next_assignment_assigned_by,
        d.next_assignment_assigned_by_user_id,
        d.next_assignment_reason,
        d.next_assignment_score);

-- A valid cache-only or room_work-only assignment has no hk_assignments row
-- to supply a receipt. Materialize one complete current snapshot instead of
-- leaving the assignment without an auditable history entry. The comparator
-- below is null-safe and covers the complete current payload; a stale active
-- receipt therefore receives one distinct append, while an exact retry is
-- suppressed.
with desired as (
  select w.id as work_id,
         jsonb_build_object(
           'property_id', w.property_id,
           'cleaning_task_id', coalesce(w.legacy_task_id, w.id),
           'housekeeper_id', w.assigned_staff_id,
           'queue_order', w.assignment_queue_order,
           'is_active', true,
           'assigned_at', w.assignment_assigned_at,
           'assigned_by', coalesce(
             w.assignment_assigned_by,
             case
               when t.assignee_id is not null then 'pms_import'
               else latest.snapshot->>'assigned_by'
             end,
             'room_work'
           ),
           'assigned_source', coalesce(
             w.assigned_source,
             case
               when t.assignee_id is not null then 'pms_import'
               else latest.snapshot->>'assigned_source'
             end,
             case
               when t.assignee_id is not null then 'pms_import'
               when latest.snapshot->>'assigned_by' = 'auto' then 'auto'
               else 'manager'
             end
           ),
           'assigned_by_user_id', w.assignment_assigned_by_user_id,
           'reason', w.assignment_reason,
           'score', w.assignment_score,
           'created_at', coalesce((latest.snapshot->>'created_at')::timestamptz, w.created_at, now()),
           'updated_at', coalesce((latest.snapshot->>'updated_at')::timestamptz, w.updated_at, now())
         ) as payload
    from public.room_work w
    join public.cleaning_tasks t on t.id = w.legacy_task_id
    left join lateral (
      select h.snapshot
        from (
          select h0.snapshot,
                 h0.position,
                 row_number() over (
                   partition by h0.snapshot->>'id'
                   order by h0.position desc
                 ) as latest_position
            from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
              with ordinality h0(snapshot, position)
       ) h
      where h.latest_position = 1
         and coalesce((h.snapshot->>'is_active')::boolean, false)
       order by h.position desc
       limit 1
    ) latest on true
   where w.assigned_staff_id is not null
), appended as (
  select d.work_id,
         d.payload || jsonb_build_object(
           'id', gen_random_uuid(),
           'event', 'reconciled_task_cache',
           'changed_at', now()
         ) as snapshot,
         d.payload
    from desired d
)
update public.room_work w
   set assignment_history = w.assignment_history || jsonb_build_array(a.snapshot)
  from appended a
 where w.id = a.work_id
   and not exists (
     select 1
       from (
         select h0.snapshot,
                h0.position,
                row_number() over (
                  partition by h0.snapshot->>'id'
                  order by h0.position desc
                ) as latest_position
           from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
             with ordinality h0(snapshot, position)
       ) h
      where h.latest_position = 1
        and coalesce((h.snapshot->>'is_active')::boolean, false)
        and h.snapshot->>'property_id' = w.property_id::text
        and h.snapshot->>'cleaning_task_id' = coalesce(w.legacy_task_id, w.id)::text
        and h.snapshot->>'housekeeper_id' = w.assigned_staff_id::text
        and jsonb_build_object(
          'property_id', h.snapshot->>'property_id',
          'cleaning_task_id', h.snapshot->>'cleaning_task_id',
          'housekeeper_id', h.snapshot->>'housekeeper_id',
          'queue_order', (h.snapshot->>'queue_order')::integer,
          'is_active', (h.snapshot->>'is_active')::boolean,
          'assigned_at', (h.snapshot->>'assigned_at')::timestamptz,
          'assigned_by', h.snapshot->>'assigned_by',
          'assigned_source', coalesce(
            h.snapshot->>'assigned_source',
            case
              when h.snapshot->>'assigned_by' = 'auto' then 'auto'
              when h.snapshot->>'assigned_by' in ('manual', 'rebalance', 'manager') then 'manager'
              when h.snapshot->>'assigned_by' in ('pms_import', 'alias_exact', 'alias_first_name') then h.snapshot->>'assigned_by'
              else null
            end
          ),
          'assigned_by_user_id', (h.snapshot->>'assigned_by_user_id')::uuid,
          'reason', h.snapshot->>'reason',
          'score', (h.snapshot->>'score')::numeric,
          'created_at', (h.snapshot->>'created_at')::timestamptz,
          'updated_at', (h.snapshot->>'updated_at')::timestamptz
        ) = a.payload
   );

with desired as (
  select w.id as work_id,
         jsonb_build_object(
           'property_id', w.property_id,
           'cleaning_task_id', coalesce(w.legacy_task_id, w.id),
           'housekeeper_id', w.assigned_staff_id,
           'queue_order', w.assignment_queue_order,
           'is_active', true,
           'assigned_at', w.assignment_assigned_at,
           'assigned_by', coalesce(w.assignment_assigned_by, latest.snapshot->>'assigned_by', 'room_work'),
           'assigned_source', coalesce(
             w.assigned_source,
             latest.snapshot->>'assigned_source',
             case when latest.snapshot->>'assigned_by' = 'auto' then 'auto' else 'manager' end
           ),
           'assigned_by_user_id', w.assignment_assigned_by_user_id,
           'reason', w.assignment_reason,
           'score', w.assignment_score,
           'created_at', coalesce((latest.snapshot->>'created_at')::timestamptz, w.created_at, now()),
           'updated_at', coalesce((latest.snapshot->>'updated_at')::timestamptz, w.updated_at, now())
         ) as payload
    from public.room_work w
    left join lateral (
      select h.snapshot
        from (
          select h0.snapshot,
                 h0.position,
                 row_number() over (
                   partition by h0.snapshot->>'id'
                   order by h0.position desc
                 ) as latest_position
            from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
              with ordinality h0(snapshot, position)
        ) h
       where h.latest_position = 1
         and coalesce((h.snapshot->>'is_active')::boolean, false)
       order by h.position desc
       limit 1
    ) latest on true
   where w.assigned_staff_id is not null
     and w.legacy_task_id is null
), appended as (
  select d.work_id,
         d.payload || jsonb_build_object(
           'id', gen_random_uuid(),
           'event', 'reconciled_room_work',
           'changed_at', now()
         ) as snapshot,
         d.payload
    from desired d
)
update public.room_work w
   set assignment_history = w.assignment_history || jsonb_build_array(a.snapshot)
  from appended a
 where w.id = a.work_id
   and not exists (
     select 1
       from (
         select h0.snapshot,
                h0.position,
                row_number() over (
                  partition by h0.snapshot->>'id'
                  order by h0.position desc
                ) as latest_position
           from jsonb_array_elements(coalesce(w.assignment_history, '[]'::jsonb))
             with ordinality h0(snapshot, position)
       ) h
      where h.latest_position = 1
        and coalesce((h.snapshot->>'is_active')::boolean, false)
        and h.snapshot->>'property_id' = w.property_id::text
        and h.snapshot->>'cleaning_task_id' = coalesce(w.legacy_task_id, w.id)::text
        and h.snapshot->>'housekeeper_id' = w.assigned_staff_id::text
        and jsonb_build_object(
          'property_id', h.snapshot->>'property_id',
          'cleaning_task_id', h.snapshot->>'cleaning_task_id',
          'housekeeper_id', h.snapshot->>'housekeeper_id',
          'queue_order', (h.snapshot->>'queue_order')::integer,
          'is_active', (h.snapshot->>'is_active')::boolean,
          'assigned_at', (h.snapshot->>'assigned_at')::timestamptz,
          'assigned_by', h.snapshot->>'assigned_by',
          'assigned_source', coalesce(
            h.snapshot->>'assigned_source',
            case
              when h.snapshot->>'assigned_by' = 'auto' then 'auto'
              when h.snapshot->>'assigned_by' in ('manual', 'rebalance', 'manager') then 'manager'
              when h.snapshot->>'assigned_by' in ('pms_import', 'alias_exact', 'alias_first_name') then h.snapshot->>'assigned_by'
              else null
            end
          ),
          'assigned_by_user_id', (h.snapshot->>'assigned_by_user_id')::uuid,
          'reason', h.snapshot->>'reason',
          'score', (h.snapshot->>'score')::numeric,
          'created_at', (h.snapshot->>'created_at')::timestamptz,
          'updated_at', (h.snapshot->>'updated_at')::timestamptz
        ) = a.payload
   );

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_plan_cleaning_type_chk'
  ) then
    alter table public.room_work add constraint room_work_plan_cleaning_type_chk
      check (plan_cleaning_type is null or plan_cleaning_type = any (array[
        'departure', 'departure_deep', 'stayover', 'refresh', 'deep',
        'room_check', 'inspection_only', 'no_clean'
      ]));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_plan_priority_chk'
  ) then
    alter table public.room_work add constraint room_work_plan_priority_chk
      check (plan_priority is null or plan_priority = any (array['urgent', 'high', 'normal', 'low']));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_plan_status_chk'
  ) then
    alter table public.room_work add constraint room_work_plan_status_chk
      check (plan_status is null or plan_status = any (array[
        'scheduled', 'ready_now', 'in_progress', 'paused', 'completed',
        'inspection_pending', 'inspected_pass', 'inspected_fail',
        'correction_pending', 'correction_complete', 'check_pending',
        'check_complete', 'deferred', 'skipped', 'cancelled', 'superseded'
      ]));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_plan_minutes_chk'
  ) then
    alter table public.room_work add constraint room_work_plan_minutes_chk
      check (plan_estimated_minutes is null or plan_estimated_minutes >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_assignment_by_chk'
  ) then
    alter table public.room_work add constraint room_work_assignment_by_chk
      check (assignment_assigned_by is null or assignment_assigned_by = any (array['auto', 'manual', 'rebalance']));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_assignment_queue_chk'
  ) then
    alter table public.room_work add constraint room_work_assignment_queue_chk
      check (assignment_queue_order >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_assignment_history_chk'
  ) then
    alter table public.room_work add constraint room_work_assignment_history_chk
      check (jsonb_typeof(assignment_history) = 'array');
  end if;

  -- 0355 predated auto as an assigned_source value. Keep the source
  -- distinction in the canonical row rather than flattening auto work into
  -- manager work.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.room_work'::regclass
       and conname = 'room_work_assigned_source_chk'
  ) then
    alter table public.room_work drop constraint room_work_assigned_source_chk;
  end if;
  alter table public.room_work add constraint room_work_assigned_source_chk
    check (
      (assigned_source is null or assigned_source = any (array['manager', 'auto', 'alias_exact', 'alias_first_name', 'pms_import']))
      and (assigned_staff_id is null or assigned_source is not null)
    );
end;
$$;

comment on column public.room_work.legacy_task_id is
  'Historical cleaning_tasks.id retained for inspection references and the read-only compatibility projection.';
comment on column public.room_work.plan_status is
  'Rules-engine/inspection status. Workflow status remains the housekeeper state in room_work.status.';
comment on column public.room_work.assignment_history is
  'Append-only JSON audit snapshots migrated from hk_assignments and extended by canonical assignment RPCs.';

insert into public.applied_migrations (version, description)
values (
  '0434',
  'Housekeeping canonical plan metadata and assignment history reconciled into room_work.'
)
on conflict (version) do nothing;

commit;
