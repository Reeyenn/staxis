-- Round 18 (2026-05-15): atomic "insert schedule if absent" for the
-- schedule-auto-fill cron.
--
-- Why this exists:
--
-- The original cron implementation did a separate read ("does a row
-- exist for this property+date?") and then an upsert at the end. Codex
-- adversarial review flagged the obvious race: between the read and the
-- write, Maria's UI auto-save can land — and the cron's upsert then
-- silently overwrites her manual schedule via the
-- `on conflict (property_id, date) do update` clause.
--
-- This RPC collapses the existence check and the insert into a single
-- atomic statement using `on conflict do nothing`. Postgres' MVCC
-- guarantees that two concurrent inserts targeting the same primary
-- key result in exactly one winner. Return value tells the caller
-- whether THIS call was the winner:
--   true  → row was inserted (cron filled the slot)
--   false → row already existed (Maria's save, or a prior cron run,
--           got there first — leave it alone, never overwrite)
--
-- Callers MUST treat `false` as "skipped, do not modify the row."
-- Re-trying with `upsert` would re-introduce the race.

create or replace function public.staxis_schedule_auto_fill_if_absent(
  p_property uuid,
  p_date date,
  p_room_assignments jsonb,
  p_crew uuid[],
  p_staff_names jsonb,
  p_csv_room_snapshot jsonb,
  p_csv_pulled_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_inserted int;
begin
  insert into public.schedule_assignments (
    property_id, date, room_assignments, crew, staff_names,
    csv_room_snapshot, csv_pulled_at, updated_at
  )
  values (
    p_property, p_date, p_room_assignments, p_crew, p_staff_names,
    p_csv_room_snapshot, p_csv_pulled_at, now()
  )
  on conflict (property_id, date) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke all on function public.staxis_schedule_auto_fill_if_absent(
  uuid, date, jsonb, uuid[], jsonb, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.staxis_schedule_auto_fill_if_absent(
  uuid, date, jsonb, uuid[], jsonb, jsonb, timestamptz
) to service_role;

insert into public.applied_migrations (version, description)
values ('0129', 'staxis_schedule_auto_fill_if_absent — atomic insert for the cron, no overwrite race')
on conflict (version) do nothing;
