-- 0271 — Repoint the two live-caller room RPCs off the legacy `rooms` table
-- onto pms_housekeeping_assignments (the single source).
--
-- Context: dropping `rooms` (migration 0272) would leave these two functions
-- referencing a non-existent table and erroring at call time. They are
-- CREATE OR REPLACE'd here with identical signatures + return types, so the
-- current callers (inspections/correction-loop.ts, send-shift-confirmations)
-- keep working unchanged — and start writing the pms_* schema instead of the
-- empty `rooms` stub (a strict improvement). Backward-compatible: safe to
-- apply to prod ahead of the 0272 drop.
--
-- The other rooms-touching functions (staxis_refresh_rooms_from_pms,
-- staxis_bulk_update_room_status, staxis_apply_shift_assignments,
-- staxis_checklist_toggle) have no live callers and are DROPPED in 0272.

-- ─── complete_inspection_atomic ─────────────────────────────────────────────
-- Identical to the prior version except the room side-effect: it now updates
-- pms_housekeeping_assignments by (property_id, room_number) on the latest
-- plan date instead of public.rooms by id. The inspection's room_id was a
-- uuid FK to rooms (now gone); room_number (always set) is the stable key.
-- The strict "exactly 1 row" guard is dropped — property_id + room_number
-- already prevents cross-property writes, and a room not on a current HK plan
-- legitimately matches 0 rows (the inspection record stays authoritative; the
-- housekeeper board re-derives on its next poll).
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
begin
  if p_result not in ('pass','fail') then
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

  -- 2) Room side-effect → pms_housekeeping_assignments (latest plan date).
  if v_row.room_number is not null then
    if p_result = 'pass' then
      update public.pms_housekeeping_assignments a
         set status       = 'completed',
             inspected_at = now()
       where a.property_id = p_property_id
         and a.room_number = v_row.room_number
         and a.date = (
           select max(date) from public.pms_housekeeping_assignments
            where property_id = p_property_id and room_number = v_row.room_number
         );
    else  -- fail
      update public.pms_housekeeping_assignments a
         set status       = 'not_started',
             completed_at = null,
             inspected_at = null,
             issue_note   = p_correction_note
       where a.property_id = p_property_id
         and a.room_number = v_row.room_number
         and a.date = (
           select max(date) from public.pms_housekeeping_assignments
            where property_id = p_property_id and room_number = v_row.room_number
         );
    end if;
  end if;

  -- 3) cleaning_tasks side-effect (unchanged — cleaning_tasks is kept).
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

  -- 4) Re-check parent link (unchanged).
  if v_row.parent_inspection_id is not null then
    update public.inspections
       set recheck_inspection_id = v_row.id
     where id          = v_row.parent_inspection_id
       and property_id = p_property_id;
  end if;

  return v_row;
end;
$function$;

-- ─── staxis_seed_shift_assignments ──────────────────────────────────────────
-- Writes the housekeeper assignment onto pms_housekeeping_assignments
-- (housekeeper_name, keyed by property_id+date+room_number) instead of
-- public.rooms.assigned_to/assigned_name. cleaning_type is seeded from the
-- plan only on insert; existing CUA-owned cleaning_type/status are preserved.
-- The schedule_assignments rebuild (steps 5-6) is unchanged.
create or replace function public.staxis_seed_shift_assignments(
  p_property uuid,
  p_date date,
  p_plan_rooms jsonb,
  p_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_created       integer := 0;
  v_updated       integer := 0;
  v_cleared       integer := 0;
  v_room_map      jsonb;
  v_room_assigns  jsonb;
  v_staff_names   jsonb;
  v_crew          uuid[];
begin
  -- 1. Reshape p_assignments into a flat (number → who) map.
  select coalesce(jsonb_object_agg(
           room_number,
           jsonb_build_object('staff_id', e->>'staff_id', 'staff_name', e->>'staff_name')
         ), '{}'::jsonb)
    into v_room_map
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e,
       jsonb_array_elements_text(coalesce(e->'rooms', '[]'::jsonb)) room_number;

  -- 2. Insert assignment rows that don't exist yet for (property, date).
  with want as (
    select
      n.number,
       v_room_map->n.number->>'staff_name'          as staff_name,
      case
        when exists (
          select 1 from jsonb_array_elements(coalesce(p_plan_rooms, '[]'::jsonb)) p
          where p->>'number' = n.number and p->>'stay_type' = 'Stay'
        ) then 'stayover'
        else 'departure'
      end as cleaning_type
    from jsonb_object_keys(v_room_map) as n(number)
  ),
  inserted as (
    insert into public.pms_housekeeping_assignments
      (property_id, date, room_number, housekeeper_name, cleaning_type, status)
    select p_property, p_date, w.number, w.staff_name, w.cleaning_type, 'not_started'
    from want w
    where not exists (
      select 1 from public.pms_housekeeping_assignments a
      where a.property_id = p_property and a.date = p_date and a.room_number = w.number
    )
    returning 1
  )
  select count(*) into v_created from inserted;

  -- 3. Update existing rows whose housekeeper changed (preserve cleaning_type/status).
  with want as (
    select n.number, v_room_map->n.number->>'staff_name' as staff_name
    from jsonb_object_keys(v_room_map) as n(number)
  ),
  updated as (
    update public.pms_housekeeping_assignments a
    set housekeeper_name = w.staff_name
    from want w
    where a.property_id = p_property
      and a.date = p_date
      and a.room_number = w.number
      and a.housekeeper_name is distinct from w.staff_name
    returning 1
  )
  select count(*) into v_updated from updated;

  -- 4. Clear the housekeeper on assignments no longer in the map.
  with cleared as (
    update public.pms_housekeeping_assignments a
    set housekeeper_name = null
    where a.property_id = p_property
      and a.date = p_date
      and a.housekeeper_name is not null
      and not (v_room_map ? a.room_number)
    returning 1
  )
  select count(*) into v_cleared from cleared;

  -- 5. Rebuild schedule_assignments room_assignments / crew / staff_names.
  select coalesce(jsonb_object_agg(
           (p_date::text || '_' || k), v_room_map->k->>'staff_id'
         ), '{}'::jsonb)
    into v_room_assigns
  from jsonb_object_keys(v_room_map) as k;

  select coalesce(jsonb_object_agg(
           e->>'staff_id', e->>'staff_name'
         ), '{}'::jsonb)
    into v_staff_names
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e;

  select coalesce(array_agg((e->>'staff_id')::uuid), '{}'::uuid[])
    into v_crew
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e;

  -- 6. Upsert schedule_assignments row.
  insert into public.schedule_assignments
    (property_id, date, room_assignments, crew, staff_names, updated_at)
  values
    (p_property, p_date, v_room_assigns, v_crew, v_staff_names, now())
  on conflict (property_id, date) do update
    set room_assignments = excluded.room_assignments,
        crew             = excluded.crew,
        staff_names      = excluded.staff_names,
        updated_at       = excluded.updated_at;

  return jsonb_build_object(
    'created_count', v_created,
    'updated_count', v_updated,
    'cleared_count', v_cleared
  );
end;
$function$;

insert into applied_migrations (version, description)
values ('0271', 'repoint complete_inspection_atomic + staxis_seed_shift_assignments off rooms onto pms_housekeeping_assignments')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
