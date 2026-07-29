-- ===========================================================================
-- 0404 — Ordered, retry-safe inventory tab-layout writes.
--
-- A browser timeout is not proof that a mutation failed.  The old route wrote
-- properties.inventory_tab_layout directly and then reconciled with an
-- immediate GET.  That GET could observe the old row while the timed-out write
-- was still waiting upstream; a later edit could then be overwritten when the
-- old request finally reached Postgres.
--
-- This migration moves the ordering guarantee into the database:
--   * every layout write carries a stable operation UUID;
--   * expected_revision is a compare-and-swap fence on the property row;
--   * exact operation retries replay their recorded result;
--   * reusing an operation UUID with different input is an explicit conflict;
--   * a property row lock serializes different operations for one hotel;
--   * advisory locking serializes accidental cross-hotel operation UUID reuse;
--   * lock and statement time are bounded, so contention has a terminal error.
--
-- PostgREST's default db-hoisted-tx-settings includes statement_timeout. It
-- reads this function setting from the schema cache and installs it before the
-- main RPC statement begins. That hoisting is important: plain PostgreSQL only
-- installs a function SET value on function entry, after the top-level command
-- has arrived. The config reload at the bottom makes the hoisted value visible
-- immediately after this migration is applied.
--
-- Existing rows remain valid.  Their public {order,hidden} value is revision
-- zero.  New rows retain those public keys and add private `_staxis` metadata;
-- API/client parsers strip that metadata before exposing the layout to the UI.
-- ===========================================================================

begin;

-- @rls: service-role-only — private idempotency/CAS receipts are reachable
-- only from the management-gated property-config API through the RPC below.
create table if not exists public.inventory_tab_layout_operations (
  operation_id       uuid primary key,
  property_id        uuid not null references public.properties(id) on delete cascade,
  expected_revision  bigint not null check (expected_revision >= 0),
  requested_layout   jsonb not null,
  requested_budget_mode text check (
    requested_budget_mode is null or requested_budget_mode in ('total', 'sections')
  ),
  applied_revision   bigint not null check (applied_revision > 0),
  applied_layout     jsonb not null,
  actor_id            uuid not null,
  created_at          timestamptz not null default now()
);

create index if not exists inventory_tab_layout_operations_property_created_idx
  on public.inventory_tab_layout_operations (property_id, created_at desc);

alter table public.inventory_tab_layout_operations enable row level security;
revoke all on table public.inventory_tab_layout_operations
  from public, anon, authenticated, service_role;
grant select on table public.inventory_tab_layout_operations to service_role;

comment on table public.inventory_tab_layout_operations is
  'Service-only receipts for ordered inventory tab-layout writes. operation_id freezes exact input and applied revision so ambiguous browser retries are idempotent.';

create or replace function public.staxis_write_inventory_tab_layout_ordered(
  p_property_id uuid,
  p_tab_layout jsonb,
  p_expected_revision bigint,
  p_operation_id uuid,
  p_budget_mode text,
  p_actor_id uuid,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
set lock_timeout = '4s'
set statement_timeout = '8s'
as $$
declare
  v_stored jsonb;
  v_current_layout jsonb;
  v_requested_layout jsonb;
  v_current_revision bigint := 0;
  v_next_revision bigint;
  v_existing public.inventory_tab_layout_operations%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory tab layout writes are service-role only' using errcode = '42501';
  end if;
  if p_property_id is null or p_operation_id is null or p_actor_id is null then
    raise exception 'property, operation, and actor are required' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'expected revision must be a non-negative integer' using errcode = '22023';
  end if;
  if p_tab_layout is null
     or jsonb_typeof(p_tab_layout -> 'order') <> 'array'
     or jsonb_typeof(p_tab_layout -> 'hidden') <> 'array'
     or exists (
       select 1 from jsonb_array_elements(p_tab_layout -> 'order') value
       where jsonb_typeof(value) <> 'string'
     )
     or exists (
       select 1 from jsonb_array_elements(p_tab_layout -> 'hidden') value
       where jsonb_typeof(value) <> 'string'
     ) then
    raise exception 'invalid inventory tab layout' using errcode = '22023';
  end if;
  if p_budget_mode is not null and p_budget_mode not in ('total', 'sections') then
    raise exception 'invalid inventory budget mode' using errcode = '22023';
  end if;

  -- Normalize away any caller-supplied metadata.  Only these two public keys
  -- participate in idempotency and only the database can write `_staxis`.
  v_requested_layout := jsonb_build_object(
    'order', p_tab_layout -> 'order',
    'hidden', p_tab_layout -> 'hidden'
  );

  -- A UUID is normally unique across the fleet.  This lock also makes a bad
  -- reuse across two properties deterministic instead of leaking a 23505 race.
  perform pg_advisory_xact_lock(
    hashtextextended('staxis.inventory-tab-layout:' || p_operation_id::text, 0)
  );

  select p.inventory_tab_layout
    into v_stored
    from public.properties p
   where p.id = p_property_id
   for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  v_stored := coalesce(v_stored, '{}'::jsonb);
  v_current_layout := jsonb_build_object(
    'order', case
      when jsonb_typeof(v_stored -> 'order') = 'array' then v_stored -> 'order'
      else '[]'::jsonb
    end,
    'hidden', case
      when jsonb_typeof(v_stored -> 'hidden') = 'array' then v_stored -> 'hidden'
      else '[]'::jsonb
    end
  );

  -- Legacy rows are revision zero.  Malformed/private metadata from an
  -- interrupted historical rollout also fails closed to zero rather than
  -- making the property unreadable.
  begin
    if jsonb_typeof(v_stored #> '{_staxis,revision}') = 'number' then
      v_current_revision := (v_stored #>> '{_staxis,revision}')::bigint;
    end if;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      v_current_revision := 0;
  end;
  if v_current_revision < 0 then v_current_revision := 0; end if;

  select op.*
    into v_existing
    from public.inventory_tab_layout_operations op
   where op.operation_id = p_operation_id;

  if found then
    if v_existing.property_id = p_property_id
       and v_existing.expected_revision = p_expected_revision
       and v_existing.requested_layout = v_requested_layout
       and v_existing.requested_budget_mode is not distinct from p_budget_mode
       and v_existing.actor_id = p_actor_id then
      return jsonb_build_object(
        'status', 'replayed',
        'operationId', p_operation_id,
        'operationRevision', v_existing.applied_revision,
        'revision', v_current_revision,
        'tabLayout', v_current_layout
      );
    end if;

    return jsonb_build_object(
      'status', 'operation_conflict',
      'operationId', p_operation_id,
      'revision', v_current_revision,
      'tabLayout', v_current_layout
    );
  end if;

  if p_expected_revision <> v_current_revision then
    return jsonb_build_object(
      'status', 'revision_conflict',
      'operationId', p_operation_id,
      'revision', v_current_revision,
      'tabLayout', v_current_layout
    );
  end if;

  -- The API carries revisions as JavaScript numbers.  Refuse the unreachable
  -- unsafe-integer boundary instead of ever weakening the CAS by rounding.
  if v_current_revision >= 9007199254740991 then
    raise exception 'inventory tab layout revision exhausted' using errcode = '22003';
  end if;
  v_next_revision := v_current_revision + 1;

  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);

  update public.properties
     set inventory_tab_layout = v_requested_layout || jsonb_build_object(
           '_staxis', jsonb_build_object(
             'revision', v_next_revision,
             'operationId', p_operation_id
           )
         ),
         inventory_budget_mode = coalesce(p_budget_mode, inventory_budget_mode)
   where id = p_property_id;

  insert into public.inventory_tab_layout_operations (
    operation_id,
    property_id,
    expected_revision,
    requested_layout,
    requested_budget_mode,
    applied_revision,
    applied_layout,
    actor_id
  ) values (
    p_operation_id,
    p_property_id,
    p_expected_revision,
    v_requested_layout,
    p_budget_mode,
    v_next_revision,
    v_requested_layout,
    p_actor_id
  );

  return jsonb_build_object(
    'status', 'applied',
    'operationId', p_operation_id,
    'operationRevision', v_next_revision,
    'revision', v_next_revision,
    'tabLayout', v_requested_layout
  );
end
$$;

-- Keep the old property-config RPC available for budget-mode writes, but make
-- it impossible for a stale server instance to bypass the ordered boundary by
-- passing p_tab_layout. This is deliberately CREATE OR REPLACE with the same
-- signature so migration-first and rolling deployments fail old layout writes
-- closed while budget saves continue to work.
create or replace function public.staxis_update_inventory_property_config(
  p_property_id uuid,
  p_tab_layout jsonb,
  p_budget_mode text,
  p_actor_id uuid,
  p_actor_name text
) returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_temp
set lock_timeout = '4s'
set statement_timeout = '8s'
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory property config writes are service-role only' using errcode = '42501';
  end if;
  if p_actor_id is null then
    raise exception 'authenticated actor is required' using errcode = '22023';
  end if;
  if p_tab_layout is not null then
    raise exception 'inventory tab layout requires ordered operation contract' using errcode = '22023';
  end if;
  if p_budget_mode is null then
    raise exception 'nothing to update' using errcode = '22023';
  end if;
  if p_budget_mode not in ('total', 'sections') then
    raise exception 'invalid inventory budget mode' using errcode = '22023';
  end if;

  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);
  update public.properties
     set inventory_budget_mode = p_budget_mode
   where id = p_property_id;
  return found;
end
$$;

revoke all on function public.staxis_write_inventory_tab_layout_ordered(
  uuid, jsonb, bigint, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.staxis_write_inventory_tab_layout_ordered(
  uuid, jsonb, bigint, uuid, text, uuid, text
) to service_role;
revoke all on function public.staxis_update_inventory_property_config(
  uuid, jsonb, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.staxis_update_inventory_property_config(
  uuid, jsonb, text, uuid, text
) to service_role;

insert into public.applied_migrations (version, description)
values (
  '0404',
  'Ordered inventory tab-layout writes: operation-id receipts, expected-revision CAS, row/advisory locking, and bounded database execution.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
notify pgrst, 'reload config';
