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
  v_existing_numbers text[];
  v_existing_count integer;
  v_mirror_count integer;
  v_expected_count integer;
  v_missing_count integer;
  v_inserted integer;
  v_run_id uuid;
  v_source_captured_at timestamptz;
begin
  -- The property id is the only tenant boundary accepted by this service
  -- operation. Room rows never supply their own property_id.
  select * into v_property
    from public.properties
   where id = p_property_id
   for update;

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
  v_expected_count := coalesce(array_length(v_expected, 1), 0);

  -- The service caller must use the same explicit stable roster as the seed
  -- path. This prevents an accidental test-only RPC call from manufacturing
  -- a different identity set.
  if p_room_numbers is distinct from v_expected then
    raise exception
      '0425: room roster does not match the configured deterministic test roster for property %',
      p_property_id;
  end if;

  -- A non-empty mirror is safe only when it is the exact deterministic prefix
  -- that the canonical table already contains. This is the proven T-50 state:
  -- room_inventory is 101-410 and pms_rooms_inventory contains exactly 101-410.
  -- Empty mirrors are allowed while the canonical table is an equal or shorter
  -- deterministic prefix, because this function will fill the mirror after it
  -- inserts the missing canonical identities.
  v_mirror_count := coalesce(array_length(v_property.room_inventory, 1), 0);
  if v_mirror_count > v_expected_count
     or (
       v_mirror_count > 0
       and v_property.room_inventory is distinct from v_expected[1:v_mirror_count]
     ) then
    raise notice '0425: property % has a non-generated or out-of-order room mirror; no rows written', p_property_id;
    return 0;
  end if;

  select coalesce(array_agg(existing.room_number order by existing.room_number), '{}'::text[])
    into v_existing_numbers
    from public.pms_rooms_inventory existing
   where existing.property_id = p_property_id;
  v_existing_count := coalesce(array_length(v_existing_numbers, 1), 0);

  if v_existing_count > v_expected_count
     or (
       v_existing_count > 0
       and v_existing_numbers is distinct from v_expected[1:v_existing_count]
     ) then
    raise notice '0425: property % has a non-generated or non-prefix canonical roster; no rows written', p_property_id;
    return 0;
  end if;

  if v_mirror_count > 0
     and (
       v_existing_count <> v_mirror_count
       or v_existing_numbers is distinct from v_property.room_inventory
     ) then
    raise notice '0425: property % has a room mirror inconsistent with its canonical prefix; no rows written', p_property_id;
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

  -- Complete canonical data is already truthful. A valid empty or partial
  -- deterministic mirror is completed; a custom mirror was rejected above.
  if v_missing_count = 0 then
    update public.properties
       set room_inventory = v_expected
     where id = p_property_id
       and room_inventory is distinct from v_expected;
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

  -- Keep the valid deterministic mirror aligned with the canonical identities.
  -- The validation above prevents this from replacing an operator-supplied
  -- custom list.
  update public.properties
     set room_inventory = v_expected
   where id = p_property_id
     and room_inventory is distinct from v_expected;

  return v_inserted;
end;
$$;

comment on function public.staxis_restore_test_room_roster(uuid, text[]) is
  'Service-only, idempotent restoration of the deterministic canonical roster for an is_test property. Inserts missing pms_rooms_inventory natural keys with 0425 lineage and never mutates existing rooms or workflow status.';

revoke all on function public.staxis_restore_test_room_roster(uuid, text[]) from public, anon, authenticated;
grant execute on function public.staxis_restore_test_room_roster(uuid, text[]) to service_role;

create or replace function public.staxis_create_test_property_with_roster(
  p_owner_id uuid,
  p_name text,
  p_total_rooms integer,
  p_timezone text,
  p_pms_type text,
  p_brand text,
  p_property_kind text,
  p_room_numbers text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_property public.properties%rowtype;
  v_inserted integer;
begin
  if p_owner_id is null
     or p_name is null
     or length(btrim(p_name)) < 3
     or length(p_name) > 100
     or p_total_rooms is null
     or p_total_rooms < 1
     or p_total_rooms > 2000
     or p_room_numbers is null then
    raise exception '0425: explicit deterministic test-property inputs are invalid'
      using errcode = '22023';
  end if;

  -- The shell starts with an empty mirror so the canonical restore function
  -- owns both sides of the consistency boundary inside this transaction.
  insert into public.properties (
    owner_id,
    name,
    total_rooms,
    timezone,
    pms_type,
    brand,
    property_kind,
    is_test,
    onboarding_source,
    onboarding_state,
    room_inventory
  ) values (
    p_owner_id,
    btrim(p_name),
    p_total_rooms,
    p_timezone,
    p_pms_type,
    p_brand,
    p_property_kind,
    true,
    'admin',
    jsonb_build_object('step', 1),
    '{}'::text[]
  ) returning * into v_property;

  v_inserted := public.staxis_restore_test_room_roster(
    v_property.id,
    p_room_numbers
  );
  if v_inserted <> p_total_rooms then
    raise exception '0425: atomic test-property roster did not create the configured canonical count'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'id', v_property.id,
    'name', v_property.name,
    'created_at', v_property.created_at
  );
end;
$$;

comment on function public.staxis_create_test_property_with_roster(uuid, text, integer, text, text, text, text, text[]) is
  'Service-only atomic creation of an explicit deterministic is_test property shell and its canonical roster. A roster failure rolls back the shell and every related row.';

revoke all on function public.staxis_create_test_property_with_roster(uuid, text, integer, text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.staxis_create_test_property_with_roster(uuid, text, integer, text, text, text, text, text[]) to service_role;

do $$
declare
  property_row record;
begin
  -- This is a one-time allowlist from the QA seed manifest and the verified
  -- production sweep. Counts are an eligibility guard, not the allowlist.
  -- Future test properties use the service boundary explicitly; they are not
  -- silently swept by this migration.
  for property_row in
    select property_row_source.id, property_row_source.total_rooms
      from (
        values
          ('c7ec4be3-ba00-4ff0-bc69-c7e09d8e4f8f'::uuid, 50),
          ('96a26a7f-7129-47db-8855-b7b34407b843'::uuid, 62),
          ('cc000003-0000-4000-8000-000000000003'::uuid, 74)
      ) as eligible(property_id, configured_total)
      join public.properties property_row_source
        on property_row_source.id = eligible.property_id
       and property_row_source.total_rooms = eligible.configured_total
       and property_row_source.is_test is true
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
