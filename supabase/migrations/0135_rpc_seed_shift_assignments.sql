-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0135: staxis_seed_shift_assignments — atomic Send-button writes
--
-- DB-access audit finding P0.1 (2026-05-17):
--   /api/send-shift-confirmations writes to rooms (insert + per-row update)
--   and schedule_assignments in three separate phases with no transaction.
--   A failure between phases leaves rooms updated but schedule_assignments
--   stale — the Housekeeping → Schedule tab and the housekeeper personal
--   page then disagree on who's assigned to which rooms.
--
-- This RPC bundles all three writes into one transaction. If any step
-- fails the whole thing rolls back, and the caller gets a clean 500.
--
-- Signature mirrors the inline logic in route.ts so the TS side just
-- swaps the inline writes for one .rpc() call.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.staxis_seed_shift_assignments(
  p_property     uuid,
  p_date         date,
  p_plan_rooms   jsonb,    -- array of { number, stay_type } from plan_snapshot
  p_assignments  jsonb     -- array of { staff_id, staff_name, rooms: [number, …] }
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_created       integer := 0;
  v_updated       integer := 0;
  v_cleared       integer := 0;
  v_room_map      jsonb;     -- room_number → { staff_id, staff_name }
  v_room_assigns  jsonb;     -- "{date}_{number}" → staff_id  (schedule_assignments shape)
  v_staff_names   jsonb;     -- staff_id → staff_name        (schedule_assignments shape)
  v_crew          uuid[];
begin
  -- ── 1. Reshape p_assignments into a flat (number → who) map ─────────────
  -- Input is grouped by staff; we want it grouped by room number for the
  -- rooms-table writes.
  select coalesce(jsonb_object_agg(
           room_number,
           jsonb_build_object('staff_id', e->>'staff_id', 'staff_name', e->>'staff_name')
         ), '{}'::jsonb)
    into v_room_map
  from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb)) e,
       jsonb_array_elements_text(coalesce(e->'rooms', '[]'::jsonb)) room_number;

  -- ── 2. Insert any rooms that don't exist yet for this (property, date) ─
  -- Derive `type` from plan_snapshot (Stay→stayover, else checkout). New
  -- seeded rows go in as dirty + standard, matching the inline TS behaviour.
  with want as (
    select
      n.number,
      (v_room_map->n.number->>'staff_id')::uuid     as staff_id,
       v_room_map->n.number->>'staff_name'          as staff_name,
      case
        when exists (
          select 1 from jsonb_array_elements(coalesce(p_plan_rooms, '[]'::jsonb)) p
          where p->>'number' = n.number and p->>'stay_type' = 'Stay'
        ) then 'stayover'
        else 'checkout'
      end as room_type
    from jsonb_object_keys(v_room_map) as n(number)
  ),
  inserted as (
    insert into public.rooms (property_id, number, date, type, status, priority, assigned_to, assigned_name)
    select p_property, w.number, p_date, w.room_type, 'dirty', 'standard', w.staff_id, w.staff_name
    from want w
    where not exists (
      select 1 from public.rooms r
      where r.property_id = p_property and r.date = p_date and r.number = w.number
    )
    returning 1
  )
  select count(*) into v_created from inserted;

  -- ── 3. Update existing rooms whose assignment has changed ──────────────
  -- Skip rows where assigned_to is already the requested staff (no-op).
  with want as (
    select
      n.number,
      (v_room_map->n.number->>'staff_id')::uuid as staff_id,
       v_room_map->n.number->>'staff_name'      as staff_name
    from jsonb_object_keys(v_room_map) as n(number)
  ),
  updated as (
    update public.rooms r
    set assigned_to = w.staff_id, assigned_name = w.staff_name
    from want w
    where r.property_id = p_property
      and r.date = p_date
      and r.number = w.number
      and r.assigned_to is distinct from w.staff_id
    returning 1
  )
  select count(*) into v_updated from updated;

  -- ── 4. Clear assignments on rooms that used to be assigned but aren't ──
  with cleared as (
    update public.rooms r
    set assigned_to = null, assigned_name = null
    where r.property_id = p_property
      and r.date = p_date
      and r.assigned_to is not null
      and not (v_room_map ? r.number)
    returning 1
  )
  select count(*) into v_cleared from cleared;

  -- ── 5. Rebuild schedule_assignments room_assignments / crew / staff_names ─
  -- Key shape is "{date}_{number}" → staff_id, matching the original TS
  -- format (back-compat with clients still reading the old Firestore-era
  -- shape).
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

  -- ── 6. Upsert schedule_assignments row ─────────────────────────────────
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
$$;

comment on function public.staxis_seed_shift_assignments is
  'Atomically seeds/updates per-room assignments and mirrors them into schedule_assignments. Replaces the inline writes at /api/send-shift-confirmations (audit P0.1, 2026-05-17). All writes succeed or all roll back — eliminates the split-brain bug where rooms updated but schedule_assignments did not.';

-- ─── Lock down — service_role only (matches 0037/0039 pattern) ──────────
revoke execute on function public.staxis_seed_shift_assignments(uuid, date, jsonb, jsonb) from public;
revoke execute on function public.staxis_seed_shift_assignments(uuid, date, jsonb, jsonb) from anon, authenticated;
grant  execute on function public.staxis_seed_shift_assignments(uuid, date, jsonb, jsonb) to   service_role;

insert into public.applied_migrations (version, description)
values ('0135', 'staxis_seed_shift_assignments RPC — atomic Send-button writes (audit P0.1)')
on conflict (version) do nothing;
