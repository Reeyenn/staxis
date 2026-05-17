-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0138: staxis_bulk_update_room_status — CUA pull-data-saver
--
-- Audit follow-up — CUA P1 (2026-05-17): cua-service/src/pull-data-saver.ts
-- looped over args.data.roomStatus running one UPDATE per room. The audit
-- flagged it as "documented trade-off (~50ms at 100 rooms)" — but inspecting
-- prod confirmed the loop was ALSO silently broken: it filtered by
-- `room_number` (column is `number`) and wrote `last_synced_at` (column
-- doesn't exist), so every iteration errored at PostgREST and roomStatusUpdates
-- stayed at zero. Both bugs are fixed by routing through this RPC, which:
--   1. Uses the correct column names.
--   2. Scopes the update to (property_id, date) so it can't accidentally
--      touch yesterday's rows.
--   3. Preserves 'in_progress' and 'inspected' status the same way
--      staxis_refresh_rooms_from_pms does — those states are owned by the
--      housekeeper app, not PMS, and PMS state isn't authoritative for them.
--   4. Does the work in a single bulk UPDATE … FROM (VALUES …) — one
--      round-trip instead of N.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.staxis_bulk_update_room_status(
  p_property uuid,
  p_date     date,
  p_updates  jsonb        -- array of { number, status }
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_updated integer := 0;
begin
  with want as (
    select
      e->>'number'  as number,
      e->>'status'  as new_status
    from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) e
    where coalesce(e->>'number', '') <> ''
      and (e->>'status') in ('dirty', 'clean')   -- in_progress + inspected are app-only
  ),
  updated as (
    update public.rooms r
    set status = case
                   when r.status = 'in_progress'                          then 'in_progress'
                   when r.status = 'inspected' and w.new_status = 'clean' then 'inspected'
                   else w.new_status
                 end
    from want w
    where r.property_id = p_property
      and r.date        = p_date
      and r.number      = w.number
    returning 1
  )
  select count(*) into v_updated from updated;

  return jsonb_build_object('updated_count', v_updated);
end;
$$;

comment on function public.staxis_bulk_update_room_status is
  'Bulk-updates rooms.status for a property/date in one round-trip, preserving in_progress and inspected states. Replaces the silently-broken per-row UPDATE loop at cua-service/src/pull-data-saver.ts (audit CUA P1, 2026-05-17).';

revoke execute on function public.staxis_bulk_update_room_status(uuid, date, jsonb) from public;
revoke execute on function public.staxis_bulk_update_room_status(uuid, date, jsonb) from anon, authenticated;
grant  execute on function public.staxis_bulk_update_room_status(uuid, date, jsonb) to   service_role;

insert into public.applied_migrations (version, description)
values ('0138', 'staxis_bulk_update_room_status RPC — CUA per-row UPDATE loop fix + perf (audit CUA P1)')
on conflict (version) do nothing;
