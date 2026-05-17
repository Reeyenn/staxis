-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0136: staxis_refresh_rooms_from_pms — atomic PMS-refresh writes
--
-- DB-access audit finding P0.2 + P1.4 (2026-05-17):
--   /api/refresh-from-pms applies inserts, then N parallel per-row updates
--   (via Promise.allSettled — partial failure tolerated), then phantom-seeds
--   missing inventory rooms. No transaction wraps the three phases, so a
--   half-applied refresh leaves the rooms table in a state that disagrees
--   with PMS (the source of truth). Also: N parallel UPDATEs cost N
--   round-trips; a single bulk UPDATE via VALUES does it in one.
--
-- This RPC bundles all three phases plus the bulk-update batching into one
-- transaction. If any step fails everything rolls back. Returns counts so
-- the caller can render the toast.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.staxis_refresh_rooms_from_pms(
  p_property   uuid,
  p_date       date,
  p_rooms      jsonb,        -- array of { number, condition, service, is_dnd }
  p_inventory  text[]        -- room_inventory for phantom-seed step
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_created          integer := 0;
  v_updated          integer := 0;
  v_phantom_created  integer := 0;
begin
  -- ── 1. Stage incoming rows in a temp table with derived type/status ────
  -- Compute the new type/status from PMS state, deferring the
  -- preserve-existing-status logic to the merge step below.
  --
  -- newType: 'stayover' if service matches /stay\s*over/i, else 'checkout'
  --          when condition='dirty', else 'vacant'.
  create temporary table _pms_rooms on commit drop as
  select
    e->>'number'                              as number,
    case
      when (e->>'service') ~* 'stay\s*over'  then 'stayover'
      when (e->>'condition') = 'dirty'        then 'checkout'
      else                                         'vacant'
    end                                       as new_type,
    e->>'condition'                           as raw_status,    -- 'clean' | 'dirty'
    coalesce((e->>'is_dnd')::boolean, false)  as is_dnd
  from jsonb_array_elements(coalesce(p_rooms, '[]'::jsonb)) e
  where coalesce(e->>'number', '') <> '';

  -- Snapshot which numbers ALREADY exist for (property, date), BEFORE we
  -- insert anything. Used to partition the _pms_rooms set into inserts
  -- (numbers not in snapshot) vs updates (numbers in snapshot) — without
  -- this, the UPDATE would also match rows we just inserted and inflate
  -- updated_count to rooms.length. The original inline TS treated created
  -- and updated as mutually exclusive; we mirror that here.
  create temporary table _existing_room_numbers on commit drop as
  select number from public.rooms
   where property_id = p_property and date = p_date;

  -- ── 2. Insert rooms that don't exist yet ────────────────────────────────
  -- For new inserts the status is just the PMS condition (clean/dirty);
  -- there's no prior state to preserve.
  with inserted as (
    insert into public.rooms
      (property_id, number, date, type, status, priority, is_dnd)
    select
      p_property, p.number, p_date, p.new_type, p.raw_status, 'standard', p.is_dnd
    from _pms_rooms p
    where p.number not in (select number from _existing_room_numbers)
    returning 1
  )
  select count(*) into v_created from inserted;

  -- ── 3. Bulk-update existing rooms (single round-trip via UPDATE … FROM) ─
  -- Preserve 'inspected' when incoming is 'clean' (supervisor sign-off
  -- sticks until next dirty). Preserve 'in_progress' always — that state
  -- is owned by the housekeeper app, not PMS. When new status flips to
  -- 'dirty' from a completed state, clear timestamps so the next clean
  -- records fresh duration. Scoped to rooms that existed BEFORE step 2.
  with updated as (
    update public.rooms r
    set
      type    = p.new_type,
      is_dnd  = p.is_dnd,
      status  = case
                  when r.status = 'in_progress'                              then 'in_progress'
                  when r.status = 'inspected' and p.raw_status = 'clean'     then 'inspected'
                  else p.raw_status
                end,
      started_at = case
                     when r.status in ('clean','inspected') and p.raw_status = 'dirty'
                       then null
                     else r.started_at
                   end,
      completed_at = case
                       when r.status in ('clean','inspected') and p.raw_status = 'dirty'
                         then null
                       else r.completed_at
                     end
    from _pms_rooms p
    where r.property_id = p_property
      and r.date        = p_date
      and r.number      = p.number
      and p.number in (select number from _existing_room_numbers)
    returning 1
  )
  select count(*) into v_updated from updated;

  -- ── 4. Phantom-seed inventory rooms missing from both PMS pull and DB ──
  -- These are vacant-clean rooms CA's HK Center page omits. Inserting them
  -- as vacant+clean lets the Rooms tab show the full board. Use ON CONFLICT
  -- DO NOTHING so a parallel request that already wrote a row doesn't
  -- error us out.
  if array_length(p_inventory, 1) is not null then
    with phantom as (
      insert into public.rooms
        (property_id, number, date, type, status, priority, is_dnd)
      select p_property, n, p_date, 'vacant', 'clean', 'standard', false
      from unnest(p_inventory) as n
      where n is not null and n <> ''
        and not exists (select 1 from _pms_rooms p where p.number = n)
        and not exists (
          select 1 from public.rooms r
          where r.property_id = p_property and r.date = p_date and r.number = n
        )
      on conflict (property_id, date, number) do nothing
      returning 1
    )
    select count(*) into v_phantom_created from phantom;
  end if;

  return jsonb_build_object(
    'created_count',   v_created,
    'updated_count',   v_updated,
    'phantom_created', v_phantom_created
  );
end;
$$;

comment on function public.staxis_refresh_rooms_from_pms is
  'Atomically refreshes the rooms table from a scraper pull: inserts new rooms, bulk-updates existing rooms (preserving inspected/in_progress states), and phantom-seeds any vacant-clean inventory rooms the PMS omitted. Replaces the three-phase inline writes at /api/refresh-from-pms (audit P0.2 + P1.4, 2026-05-17). All writes succeed or roll back.';

-- ─── Lock down — service_role only ──────────────────────────────────────
revoke execute on function public.staxis_refresh_rooms_from_pms(uuid, date, jsonb, text[]) from public;
revoke execute on function public.staxis_refresh_rooms_from_pms(uuid, date, jsonb, text[]) from anon, authenticated;
grant  execute on function public.staxis_refresh_rooms_from_pms(uuid, date, jsonb, text[]) to   service_role;

insert into public.applied_migrations (version, description)
values ('0136', 'staxis_refresh_rooms_from_pms RPC — atomic PMS refresh + bulk update (audit P0.2 + P1.4)')
on conflict (version) do nothing;
