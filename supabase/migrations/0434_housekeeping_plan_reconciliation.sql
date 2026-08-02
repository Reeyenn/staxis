-- 0434: move the manager cleaning plan into room_work.
--
-- room_work is the Staxis-owned workflow row. The PMS assignment table stays
-- the report-owned plan fact source. This migration adds the manager plan
-- metadata and assignment audit fields to room_work, then reconciles every
-- existing cleaning_tasks and hk_assignments row while the old application
-- remains in service. The physical legacy tables stay writable through this
-- compatibility window; their retirement belongs to a later contract stage.

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
begin
  if new.id is null then
    new.id := public.housekeeping_plan_id(new.property_id, new.date, new.room_number);
  end if;
  if new.plan_dedupe_key is null then
    new.plan_dedupe_key := new.room_number || '::' || new.date::text;
  end if;
  return new;
end;
$$;

drop trigger if exists room_work_fill_identity on public.room_work;
create trigger room_work_fill_identity
  before insert on public.room_work
  for each row execute function public._room_work_fill_identity();

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
    when t.status in ('skipped', 'cancelled') then 'skipped'
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
   and w.room_number = t.room_number;

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

-- Preserve the complete assignment history in canonical JSON. The current
-- active snapshot is duplicated into dedicated columns so manager reads do
-- not need to unpack history. Invalid cross-property rows were rejected by
-- the preflight above, and every history row is retained for audit.
update public.room_work w
   set assignment_history = coalesce((
         select jsonb_agg(
           jsonb_build_object(
             'id', a.id,
             'property_id', a.property_id,
             'cleaning_task_id', a.cleaning_task_id,
             'housekeeper_id', a.housekeeper_id,
             'queue_order', a.queue_order,
             'is_active', a.is_active,
             'assigned_at', a.assigned_at,
             'assigned_by', a.assigned_by,
             'assigned_by_user_id', a.assigned_by_user_id,
             'reason', a.reason,
             'score', a.score,
             'created_at', a.created_at,
             'updated_at', a.updated_at
           ) order by a.created_at, a.id
         )
           from public.hk_assignments a
          where a.property_id = w.property_id
            and a.cleaning_task_id = w.legacy_task_id
       ), '[]'::jsonb),
       assigned_staff_id = coalesce(
         (
           select a.housekeeper_id
             from public.hk_assignments a
            where a.property_id = w.property_id
              and a.cleaning_task_id = w.legacy_task_id
              and a.is_active
            order by a.assigned_at desc, a.created_at desc, a.id desc
            limit 1
         ),
         w.assigned_staff_id
       ),
       assigned_source = case
         when exists (
           select 1
             from public.hk_assignments a
            where a.property_id = w.property_id
              and a.cleaning_task_id = w.legacy_task_id
              and a.is_active
         ) then case
           when (
             select a.assigned_by
               from public.hk_assignments a
              where a.property_id = w.property_id
                and a.cleaning_task_id = w.legacy_task_id
                and a.is_active
              order by a.assigned_at desc, a.created_at desc, a.id desc
              limit 1
           ) = 'auto' then 'auto'
           else 'manager'
         end
         else w.assigned_source
       end,
       assignment_queue_order = coalesce(
         (
           select a.queue_order
             from public.hk_assignments a
            where a.property_id = w.property_id
              and a.cleaning_task_id = w.legacy_task_id
              and a.is_active
            order by a.assigned_at desc, a.created_at desc, a.id desc
            limit 1
         ),
         w.assignment_queue_order
       ),
       assignment_assigned_at = coalesce(
         (
           select a.assigned_at
             from public.hk_assignments a
            where a.property_id = w.property_id
              and a.cleaning_task_id = w.legacy_task_id
              and a.is_active
            order by a.assigned_at desc, a.created_at desc, a.id desc
            limit 1
         ),
         w.assignment_assigned_at
       ),
       assignment_assigned_by = coalesce(
         (
           select a.assigned_by
             from public.hk_assignments a
            where a.property_id = w.property_id
              and a.cleaning_task_id = w.legacy_task_id
              and a.is_active
            order by a.assigned_at desc, a.created_at desc, a.id desc
            limit 1
         ),
         w.assignment_assigned_by
       ),
       assignment_assigned_by_user_id = coalesce(
         (
           select a.assigned_by_user_id
             from public.hk_assignments a
            where a.property_id = w.property_id
              and a.cleaning_task_id = w.legacy_task_id
              and a.is_active
            order by a.assigned_at desc, a.created_at desc, a.id desc
            limit 1
         ),
         w.assignment_assigned_by_user_id
       ),
       assignment_reason = coalesce(
         (
           select a.reason
             from public.hk_assignments a
            where a.property_id = w.property_id
              and a.cleaning_task_id = w.legacy_task_id
              and a.is_active
            order by a.assigned_at desc, a.created_at desc, a.id desc
            limit 1
         ),
         w.assignment_reason
       ),
       assignment_score = coalesce(
         (
           select a.score
             from public.hk_assignments a
            where a.property_id = w.property_id
              and a.cleaning_task_id = w.legacy_task_id
              and a.is_active
            order by a.assigned_at desc, a.created_at desc, a.id desc
            limit 1
         ),
         w.assignment_score
       )
 where w.legacy_task_id is not null;

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
