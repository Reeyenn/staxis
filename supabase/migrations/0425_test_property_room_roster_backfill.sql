-- 0425 — Restore canonical rosters for repository-owned test properties.
--
-- This is deliberately data restoration, not a dashboard fallback. The
-- dashboard already renders one truthful tick per canonical room identity;
-- this migration supplies only the missing identities for is_test hotels.
-- Real customer properties are never selected here.
--
-- The room sequence is the same stable sequence emitted by
-- src/lib/test-room-roster.ts: ten rooms per floor, beginning at 101.
-- Existing canonical rows are preserved. Only missing natural keys are
-- inserted, with a manual-backfill receipt, and the operation is safe to
-- repeat. room_work and all status tables are intentionally untouched.

create or replace function public.staxis_restore_test_room_roster(
  p_property_id uuid,
  p_room_numbers text[]
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_property public.properties%rowtype;
  v_expected text[];
  v_existing_count integer;
  v_missing_count integer;
  v_inserted integer;
  v_run_id uuid;
  v_source_captured_at timestamptz;
begin
  -- The property id is the only tenant boundary accepted by this service
  -- operation. Room rows never supply their own property_id.
  select * into v_property
    from public.properties
   where id = p_property_id;

  if not found or coalesce(v_property.is_test, false) is not true then
    raise notice '0425: property % is not an is_test property; no roster written', p_property_id;
    return 0;
  end if;

  select array_agg(
           ((ordinal / 10 + 1)::text || lpad((ordinal % 10 + 1)::text, 2, '0'))
           order by ordinal
         )
    into v_expected
    from generate_series(0, v_property.total_rooms - 1) as generated(ordinal);

  -- The service caller must use the same explicit stable roster as the seed
  -- path. This prevents an accidental test-only RPC call from manufacturing
  -- a different identity set.
  if p_room_numbers is distinct from v_expected then
    raise exception
      '0425: room roster does not match the configured deterministic test roster for property %',
      p_property_id;
  end if;

  -- An existing onboarding roster is authoritative. Do not replace it when
  -- it differs from the test generator; leave that property for an explicit
  -- operator decision instead of creating a second identity set.
  if coalesce(array_length(v_property.room_inventory, 1), 0) > 0
     and v_property.room_inventory is distinct from v_expected then
    raise notice '0425: property % has a different non-empty onboarding roster; no rows written', p_property_id;
    return 0;
  end if;

  -- A non-generated canonical identity is evidence that this is not a safe
  -- prefix-extension case. Preserve it and do not manufacture a parallel
  -- roster.
  if exists (
    select 1
      from public.pms_rooms_inventory existing
     where existing.property_id = p_property_id
       and not (existing.room_number = any(v_expected))
  ) then
    raise notice '0425: property % has non-generated canonical room identities; no rows written', p_property_id;
    return 0;
  end if;

  select count(*)::integer into v_existing_count
    from public.pms_rooms_inventory
   where property_id = p_property_id;

  if v_existing_count > v_property.total_rooms then
    raise notice '0425: property % already has % canonical rooms for configured %; no rows written',
      p_property_id, v_existing_count, v_property.total_rooms;
    return 0;
  end if;

  select count(*)::integer into v_missing_count
    from unnest(v_expected) as expected(room_number)
   where not exists (
     select 1
       from public.pms_rooms_inventory existing
      where existing.property_id = p_property_id
        and existing.room_number = expected.room_number
   );

  -- Complete canonical data is already truthful. The room_inventory mirror is
  -- filled only when it was empty, never replaced when it contains data.
  if v_missing_count = 0 then
    update public.properties
       set room_inventory = v_expected
     where id = p_property_id
       and coalesce(array_length(room_inventory, 1), 0) = 0;
    return 0;
  end if;

  v_source_captured_at := clock_timestamp();

  -- This is the same service-only receipt boundary used by the canonical PMS
  -- writer. The source is explicit and replayable, and every inserted row is
  -- stamped with this run before it can enter pms_rooms_inventory.
  insert into public.pms_ingest_runs (
    property_id,
    source_kind,
    mode,
    parser_name,
    parser_version,
    source_captured_at,
    started_at,
    status,
    diff
  ) values (
    p_property_id,
    'manual_backfill',
    'replay',
    'staxis-test-room-roster',
    '0425-v1',
    v_source_captured_at,
    v_source_captured_at,
    'running',
    jsonb_build_object(
      'restoration', 'standard_test_room_roster',
      'configured_rooms', v_property.total_rooms,
      'missing_before', v_missing_count
    )
  ) returning id into v_run_id;

  -- Natural-key insert with no conflict update preserves every existing PMS
  -- metadata value and every status/workflow record.
  insert into public.pms_rooms_inventory (
    property_id,
    room_number,
    last_synced_at,
    ingest_run_id
  )
  select p_property_id, expected.room_number, v_source_captured_at, v_run_id
    from unnest(v_expected) as expected(room_number)
   where not exists (
     select 1
       from public.pms_rooms_inventory existing
      where existing.property_id = p_property_id
        and existing.room_number = expected.room_number
   )
  on conflict (property_id, room_number) do nothing;

  get diagnostics v_inserted = row_count;

  update public.pms_ingest_runs
     set finished_at = clock_timestamp(),
         status = 'succeeded',
         rows_written = v_inserted,
         diff = diff || jsonb_build_object('inserted', v_inserted)
   where id = v_run_id;

  -- Keep the existing property roster mirror aligned with the canonical
  -- identities, but only when it was empty. This update never alters a valid
  -- onboarding list supplied by an operator.
  update public.properties
     set room_inventory = v_expected
   where id = p_property_id
     and coalesce(array_length(room_inventory, 1), 0) = 0;

  return v_inserted;
end;
$$;

comment on function public.staxis_restore_test_room_roster(uuid, text[]) is
  'Service-only, idempotent restoration of the deterministic canonical roster for an is_test property. Inserts missing pms_rooms_inventory natural keys with 0425 lineage and never mutates existing rooms or workflow status.';

revoke all on function public.staxis_restore_test_room_roster(uuid, text[]) from public, anon, authenticated;
grant execute on function public.staxis_restore_test_room_roster(uuid, text[]) to service_role;

do $$
declare
  property_row record;
begin
  -- The migration supplies the exact same explicit roster accepted by the
  -- service function. Real properties never enter this loop.
  for property_row in
    select id, total_rooms
      from public.properties
     where coalesce(is_test, false) is true
       and total_rooms > 0
     order by id
  loop
    perform public.staxis_restore_test_room_roster(
      property_row.id,
      (
        select array_agg(
                 ((ordinal / 10 + 1)::text || lpad((ordinal % 10 + 1)::text, 2, '0'))
                 order by ordinal
               )
          from generate_series(0, property_row.total_rooms - 1) as generated(ordinal)
      )
    );
  end loop;
end;
$$;

insert into public.applied_migrations (version, description)
values (
  '0425',
  'Restore missing canonical room identities for is_test properties through the lineage-complete service roster path'
)
on conflict (version) do nothing;
