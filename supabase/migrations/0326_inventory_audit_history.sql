-- 0326: durable, append-only inventory audit history.
--
-- Operational source tables remain authoritative.  This ledger gives the
-- manager History surface one cursor-paged timeline without making mutable
-- catalog rows or caller-supplied display names the audit authority.
-- Financial before/after evidence stays service-role-only; the read RPC emits
-- it only when the already-existing view_financials capability has passed in
-- the API gate.

begin;

do $$
begin
  if to_regclass('public.inventory') is null
     or to_regclass('public.inventory_counts') is null
     or to_regclass('public.inventory_orders') is null
     or to_regprocedure('public.staxis_save_inventory_count(uuid,uuid,timestamptz,text,jsonb)') is null
     or to_regprocedure('public.staxis_receive_inventory_delivery(uuid,uuid,timestamptz,text,text,jsonb)') is null
  then
    raise exception 'inventory audit history requires migration 0324';
  end if;
end
$$;

create sequence if not exists public.inventory_audit_event_sequence;

-- @rls: service-role-only -- private before/after states can contain costs.
create table if not exists public.inventory_audit_events (
  id                uuid primary key default gen_random_uuid(),
  sequence          bigint not null default nextval('public.inventory_audit_event_sequence'),
  property_id       uuid not null references public.properties(id) on delete cascade,
  action            text not null check (action in (
    'item.created','item.updated','item.archived',
    'count.saved','delivery.received','order_intent.recorded','loss.recorded','reconciliation.recorded',
    'delivery.corrected','delivery.voided','opening_adjustment.recorded',
    'month.started','month.closed',
    'vendor.created','vendor.updated','vendor.inactivated',
    'budget.created','budget.updated','budget.deleted',
    'category.created','category.updated','category.deleted',
    'budget_section.created','budget_section.updated','budget_section.deleted',
    'config.updated'
  )),
  entity_type       text not null check (entity_type in (
    'item','count','delivery','loss','reconciliation','delivery_correction',
    'opening_adjustment','month','vendor','budget','category','budget_section','config'
  )),
  entity_id         uuid,
  entity_key        text not null,
  source_table      text not null,
  source_id         text not null,
  request_id        text,
  occurred_at       timestamptz not null,
  actor_user_id     uuid,
  actor_name        text,
  summary           jsonb not null default '{}'::jsonb,
  details           jsonb not null default '{}'::jsonb,
  financial_details jsonb not null default '{}'::jsonb,
  before_state      jsonb,
  after_state       jsonb,
  dedupe_key        text,
  created_at        timestamptz not null default clock_timestamp(),
  unique (sequence),
  check (jsonb_typeof(summary) = 'object'),
  check (jsonb_typeof(details) = 'object'),
  check (jsonb_typeof(financial_details) = 'object')
);

create unique index if not exists inventory_audit_events_dedupe_uq
  on public.inventory_audit_events(dedupe_key)
  where dedupe_key is not null;
create index if not exists inventory_audit_events_property_cursor_idx
  on public.inventory_audit_events(property_id, sequence desc);
create index if not exists inventory_audit_events_property_occurred_idx
  on public.inventory_audit_events(property_id, occurred_at desc, id desc);

alter table public.inventory_audit_events enable row level security;
drop policy if exists inventory_audit_events_deny_browser on public.inventory_audit_events;
create policy inventory_audit_events_deny_browser
  on public.inventory_audit_events for all to anon, authenticated
  using (false) with check (false);
revoke all on public.inventory_audit_events from public, anon, authenticated, service_role;
grant select on public.inventory_audit_events to service_role;
revoke all on sequence public.inventory_audit_event_sequence from public, anon, authenticated, service_role;

comment on table public.inventory_audit_events is
  'Append-only inventory change ledger. Private states are service-role-only; cursor reads expose capability-filtered summaries.';
comment on column public.inventory_audit_events.actor_user_id is
  'Supabase auth user UUID derived from auth.uid() for browser writes, or from a finance/API gate for service-role-only mutations.';
comment on column public.inventory_audit_events.dedupe_key is
  'Stable source-event key. Immutable source rows and migration backfill use it to make retries exactly-once.';

-- Future count/delivery rows retain an authenticated actor on their source
-- ledger too.  Existing caller-visible columns stay in place for compatibility.
alter table public.inventory_counts
  add column if not exists recorded_by_user_id uuid,
  add column if not exists recorded_by_name text;
alter table public.inventory_orders
  add column if not exists request_id uuid,
  add column if not exists recorded_by_user_id uuid,
  add column if not exists recorded_by_name text;
alter table public.inventory_reconciliations
  add column if not exists recorded_by_user_id uuid,
  add column if not exists recorded_by_name text;

-- Bind delivery lines to their request explicitly inside the atomic RPC's
-- transaction. Never infer a request from another unresolved receipt: two
-- concurrent requests may both be visible even when their item locks differ.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.staxis_receive_inventory_delivery(uuid,uuid,timestamptz,text,text,jsonb)'::regprocedure
  ) into v_def;
  if position('staxis.inventory_request_id' in v_def) > 0 then
    return;
  end if;
  v_new := replace(
    v_def,
$old$begin
  if coalesce(auth.role(), '') <> 'service_role' and ($old$,
$new$begin
  perform set_config('staxis.inventory_request_id', coalesce(p_request_id::text, ''), true);
  if coalesce(auth.role(), '') <> 'service_role' and ($new$
  );
  if v_new = v_def then
    raise exception '0326 could not bind the delivery request id to its transaction';
  end if;
  execute v_new;
end
$$;

-- The missed-opening-stock RPC emits both an opening-adjustment row and a
-- linked physical-count row. Carry its already-required actor through to the
-- generic count trigger as transaction-local trusted context.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.staxis_record_inventory_opening_adjustment(uuid,uuid,uuid,timestamptz,numeric,numeric,numeric,numeric,uuid,text)'::regprocedure
  ) into v_def;
  if position('staxis.inventory_actor_id' in v_def) > 0 then
    return;
  end if;
  v_new := replace(
    v_def,
$old$  if p_request_id is null or p_item_id is null or p_effective_at is null then$old$,
$new$  if p_actor_id is null then
    raise exception 'authenticated actor is required' using errcode = '22023';
  end if;
  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);
  if p_request_id is null or p_item_id is null or p_effective_at is null then$new$
  );
  if v_new = v_def then
    raise exception '0326 could not bind the opening-adjustment actor to its transaction';
  end if;
  execute v_new;
end
$$;

create or replace function public.staxis_inventory_audit_actor_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select coalesce(
    (
      select nullif(trim(a.display_name), '')
      from public.accounts a
      where a.data_user_id = p_user_id
      order by a.id
      limit 1
    ),
    (
      select nullif(trim(u.email), '')
      from auth.users u
      where u.id = p_user_id
    )
  )
$$;

revoke all on function public.staxis_inventory_audit_actor_name(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.staxis_append_inventory_audit_event(
  p_property_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_entity_key text,
  p_source_table text,
  p_source_id text,
  p_request_id text,
  p_occurred_at timestamptz,
  p_actor_user_id uuid,
  p_actor_name text,
  p_summary jsonb,
  p_details jsonb,
  p_financial_details jsonb,
  p_before_state jsonb,
  p_after_state jsonb,
  p_dedupe_key text
) returns uuid
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_event_id uuid;
  v_actor_id uuid;
  v_actor_name text;
  v_context_actor text;
begin
  -- An authenticated browser can never assert somebody else's audit actor.
  if coalesce(auth.role(), '') = 'authenticated' and auth.uid() is not null then
    v_actor_id := auth.uid();
    v_actor_name := public.staxis_inventory_audit_actor_name(v_actor_id);
  else
    v_context_actor := nullif(current_setting('staxis.inventory_actor_id', true), '');
    v_actor_id := coalesce(
      case when v_context_actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then v_context_actor::uuid else null end,
      p_actor_user_id
    );
    v_actor_name := coalesce(
      public.staxis_inventory_audit_actor_name(v_actor_id),
      nullif(current_setting('staxis.inventory_actor_name', true), ''),
      nullif(trim(p_actor_name), '')
    );
  end if;

  insert into public.inventory_audit_events (
    property_id, action, entity_type, entity_id, entity_key,
    source_table, source_id, request_id, occurred_at,
    actor_user_id, actor_name, summary, details, financial_details,
    before_state, after_state, dedupe_key
  ) values (
    p_property_id, p_action, p_entity_type, p_entity_id, p_entity_key,
    p_source_table, p_source_id, nullif(p_request_id, ''), coalesce(p_occurred_at, clock_timestamp()),
    v_actor_id, v_actor_name, coalesce(p_summary, '{}'::jsonb),
    coalesce(p_details, '{}'::jsonb), coalesce(p_financial_details, '{}'::jsonb),
    p_before_state, p_after_state, nullif(p_dedupe_key, '')
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_event_id;

  if v_event_id is null and p_dedupe_key is not null then
    select e.id into v_event_id
    from public.inventory_audit_events e
    where e.dedupe_key = p_dedupe_key;
  end if;
  return v_event_id;
end
$$;

revoke all on function public.staxis_append_inventory_audit_event(
  uuid,text,text,uuid,text,text,text,text,timestamptz,uuid,text,
  jsonb,jsonb,jsonb,jsonb,jsonb,text
) from public, anon, authenticated, service_role;

create or replace function public.staxis_stamp_inventory_count_actor()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_context_actor text;
begin
  if coalesce(auth.role(), '') = 'authenticated' and auth.uid() is not null then
    new.recorded_by_user_id := auth.uid();
    new.recorded_by_name := public.staxis_inventory_audit_actor_name(auth.uid());
    new.counted_by := coalesce(new.recorded_by_name, 'Authenticated user');
  else
    v_context_actor := nullif(current_setting('staxis.inventory_actor_id', true), '');
    if coalesce(auth.role(), '') = 'service_role'
       and v_context_actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      new.recorded_by_user_id := v_context_actor::uuid;
      new.recorded_by_name := coalesce(
        public.staxis_inventory_audit_actor_name(new.recorded_by_user_id),
        nullif(current_setting('staxis.inventory_actor_name', true), ''),
        nullif(trim(new.counted_by), '')
      );
      new.counted_by := coalesce(new.recorded_by_name, 'Authenticated user');
    elsif new.recorded_by_name is null then
      new.recorded_by_name := nullif(trim(new.counted_by), '');
    end if;
  end if;
  return new;
end
$$;

create or replace function public.staxis_stamp_inventory_order_actor()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_request_id text;
  v_context_actor text;
begin
  if coalesce(auth.role(), '') = 'authenticated' and auth.uid() is not null then
    new.recorded_by_user_id := auth.uid();
    new.recorded_by_name := public.staxis_inventory_audit_actor_name(auth.uid());
  else
    v_context_actor := nullif(current_setting('staxis.inventory_actor_id', true), '');
    if coalesce(auth.role(), '') = 'service_role'
       and v_context_actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      new.recorded_by_user_id := v_context_actor::uuid;
      new.recorded_by_name := coalesce(
        public.staxis_inventory_audit_actor_name(new.recorded_by_user_id),
        nullif(current_setting('staxis.inventory_actor_name', true), '')
      );
    end if;
  end if;

  -- The delivery RPC sets this transaction-local value before any line insert.
  -- It cannot bleed into a concurrent transaction or a later pooled request.
  if new.entry_kind = 'receipt' and new.request_id is null then
    v_request_id := nullif(current_setting('staxis.inventory_request_id', true), '');
    if v_request_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      new.request_id := v_request_id::uuid;
    end if;
  end if;
  return new;
end
$$;

create or replace function public.staxis_stamp_inventory_reconciliation_actor()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_context_actor text;
begin
  if coalesce(auth.role(), '') = 'authenticated' and auth.uid() is not null then
    new.recorded_by_user_id := auth.uid();
    new.recorded_by_name := public.staxis_inventory_audit_actor_name(auth.uid());
    new.reconciled_by := coalesce(new.recorded_by_name, 'Authenticated user');
  else
    v_context_actor := nullif(current_setting('staxis.inventory_actor_id', true), '');
    if coalesce(auth.role(), '') = 'service_role'
       and v_context_actor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      new.recorded_by_user_id := v_context_actor::uuid;
      new.recorded_by_name := coalesce(
        public.staxis_inventory_audit_actor_name(new.recorded_by_user_id),
        nullif(current_setting('staxis.inventory_actor_name', true), ''),
        nullif(trim(new.reconciled_by), '')
      );
      new.reconciled_by := coalesce(new.recorded_by_name, 'Authenticated user');
    elsif new.recorded_by_name is null then
      new.recorded_by_name := nullif(trim(new.reconciled_by), '');
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists inventory_counts_stamp_actor on public.inventory_counts;
create trigger inventory_counts_stamp_actor
  before insert on public.inventory_counts
  for each row execute function public.staxis_stamp_inventory_count_actor();
drop trigger if exists inventory_orders_stamp_actor on public.inventory_orders;
create trigger inventory_orders_stamp_actor
  before insert on public.inventory_orders
  for each row execute function public.staxis_stamp_inventory_order_actor();
drop trigger if exists inventory_reconciliations_stamp_actor on public.inventory_reconciliations;
create trigger inventory_reconciliations_stamp_actor
  before insert on public.inventory_reconciliations
  for each row execute function public.staxis_stamp_inventory_reconciliation_actor();

revoke all on function public.staxis_stamp_inventory_count_actor() from public, anon, authenticated, service_role;
revoke all on function public.staxis_stamp_inventory_order_actor() from public, anon, authenticated, service_role;
revoke all on function public.staxis_stamp_inventory_reconciliation_actor() from public, anon, authenticated, service_role;

-- Server-side tools already authenticate and property-scope the end user before
-- reaching Supabase with the service key. These wrappers carry that verified
-- auth-user UUID through the same transaction without changing either existing
-- browser RPC signature.
create or replace function public.staxis_save_inventory_count_for_actor(
  p_property_id uuid,
  p_request_id uuid,
  p_counted_at timestamptz,
  p_counted_by text,
  p_rows jsonb,
  p_actor_id uuid,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'actor-aware inventory count is service-role only' using errcode = '42501';
  end if;
  if p_actor_id is null then
    raise exception 'authenticated actor is required' using errcode = '22023';
  end if;
  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);
  return public.staxis_save_inventory_count(
    p_property_id, p_request_id, p_counted_at, p_counted_by, p_rows
  );
end
$$;

create or replace function public.staxis_receive_inventory_delivery_for_actor(
  p_property_id uuid,
  p_request_id uuid,
  p_received_at timestamptz,
  p_vendor_name text,
  p_notes text,
  p_lines jsonb,
  p_actor_id uuid,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'actor-aware inventory delivery is service-role only' using errcode = '42501';
  end if;
  if p_actor_id is null then
    raise exception 'authenticated actor is required' using errcode = '22023';
  end if;
  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);
  return public.staxis_receive_inventory_delivery(
    p_property_id, p_request_id, p_received_at, p_vendor_name, p_notes, p_lines
  );
end
$$;

revoke all on function public.staxis_save_inventory_count_for_actor(
  uuid,uuid,timestamptz,text,jsonb,uuid,text
) from public, anon, authenticated;
grant execute on function public.staxis_save_inventory_count_for_actor(
  uuid,uuid,timestamptz,text,jsonb,uuid,text
) to service_role;
revoke all on function public.staxis_receive_inventory_delivery_for_actor(
  uuid,uuid,timestamptz,text,text,jsonb,uuid,text
) from public, anon, authenticated;
grant execute on function public.staxis_receive_inventory_delivery_for_actor(
  uuid,uuid,timestamptz,text,text,jsonb,uuid,text
) to service_role;

alter table public.inventory_write_receipts
  drop constraint if exists inventory_write_receipts_operation_check;
alter table public.inventory_write_receipts
  add constraint inventory_write_receipts_operation_check
  check (operation in ('count', 'delivery', 'loss', 'delivery_correction', 'order_intent'));
comment on table public.inventory_write_receipts is
  'Append-only idempotency claims for atomic inventory count, delivery, and order-intent RPCs. Each UUID is bound to its operation and canonical JSON payload.';

create or replace function public.staxis_record_inventory_order_intent(
  p_property_id uuid,
  p_item_id uuid,
  p_request_id uuid,
  p_ordered_at timestamptz,
  p_actor_id uuid,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_before public.inventory%rowtype;
  v_after public.inventory%rowtype;
  v_receipt public.inventory_write_receipts%rowtype;
  v_ordered_at timestamptz := coalesce(p_ordered_at, clock_timestamp());
  v_payload jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory order intent is service-role only' using errcode = '42501';
  end if;
  if p_actor_id is null then
    raise exception 'authenticated actor is required' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'request id is required' using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'itemId', p_item_id,
    'orderedAt', v_ordered_at,
    'actorId', p_actor_id
  );
  insert into public.inventory_write_receipts(property_id,request_id,operation,payload)
  values (p_property_id,p_request_id,'order_intent',v_payload)
  on conflict (property_id,request_id) do nothing;
  if not found then
    select * into v_receipt
    from public.inventory_write_receipts r
    where r.property_id=p_property_id and r.request_id=p_request_id;
    if v_receipt.operation is distinct from 'order_intent'
       or v_receipt.payload is distinct from v_payload
    then
      raise exception 'request id was already used with a different order intent' using errcode = '23505';
    end if;
    if v_receipt.result is null then
      raise exception 'order-intent request is still processing' using errcode = '40001';
    end if;
    return v_receipt.result || jsonb_build_object('replayed',true);
  end if;

  select * into v_before
  from public.inventory i
  where i.id = p_item_id and i.property_id = p_property_id and i.archived_at is null
  for update;
  if not found then
    raise exception 'active inventory item not found for property' using errcode = 'P0002';
  end if;

  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);
  update public.inventory
  set last_ordered_at = v_ordered_at,
      updated_at = clock_timestamp()
  where id = p_item_id and property_id = p_property_id
  returning * into v_after;

  perform public.staxis_append_inventory_audit_event(
    p_property_id, 'order_intent.recorded', 'item', p_item_id, p_item_id::text,
    'inventory', p_request_id::text, p_request_id::text, v_ordered_at,
    p_actor_id, p_actor_name,
    jsonb_build_object(
      'label', v_after.name, 'secondaryLabel', 'order intent',
      'quantity', null, 'unit', v_after.unit, 'itemCount', 1,
      'changedFields', jsonb_build_array('last_ordered_at')
    ),
    jsonb_build_object(
      'itemId', p_item_id, 'orderedAt', v_ordered_at,
      'deliveryLogged', false, 'purchaseLogged', false
    ),
    '{}'::jsonb,
    jsonb_build_object('last_ordered_at', v_before.last_ordered_at),
    jsonb_build_object('last_ordered_at', v_after.last_ordered_at),
    'order-intent:' || p_property_id::text || ':' || p_request_id::text
  );
  v_result := jsonb_build_object(
    'requestId', p_request_id, 'itemId', p_item_id,
    'orderedAt', v_after.last_ordered_at, 'replayed', false
  );
  update public.inventory_write_receipts
  set result=v_result
  where property_id=p_property_id and request_id=p_request_id;
  return v_result;
end
$$;

revoke all on function public.staxis_record_inventory_order_intent(
  uuid,uuid,uuid,timestamptz,uuid,text
) from public, anon, authenticated;
grant execute on function public.staxis_record_inventory_order_intent(
  uuid,uuid,uuid,timestamptz,uuid,text
) to service_role;

-- One generic AFTER trigger keeps all writes -- including SQL/RPC paths not
-- known to the application -- on the same append-only audit surface.
create or replace function public.staxis_capture_inventory_audit_event()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_property_id uuid;
  v_entity_id uuid;
  v_entity_key text;
  v_source_id text;
  v_action text;
  v_entity_type text;
  v_request_id text;
  v_occurred_at timestamptz;
  v_actor_id uuid;
  v_actor_name text;
  v_summary jsonb := '{}'::jsonb;
  v_details jsonb := '{}'::jsonb;
  v_financial jsonb := '{}'::jsonb;
  v_dedupe text;
  v_changed_fields text[] := '{}'::text[];
  v_compare_old jsonb;
  v_compare_new jsonb;
  v_row jsonb := coalesce(v_new, v_old);
begin
  v_property_id := case when tg_table_name = 'properties'
    then (v_row->>'id')::uuid
    else (v_row->>'property_id')::uuid
  end;
  -- FK cascades do not expose a reliable trigger-depth distinction. Once the
  -- parent property is already gone, this is a whole-property teardown rather
  -- than a manager deleting one configuration row, so there is no surviving
  -- tenant timeline to append to (and the audit FK must not block the cascade).
  if tg_op = 'DELETE' and not exists (
    select 1 from public.properties p where p.id = v_property_id
  ) then
    return old;
  end if;
  v_source_id := coalesce(v_row->>'id', v_row->>'category', v_property_id::text);

  if tg_table_name = 'inventory' then
    v_entity_type := 'item';
    v_entity_id := (v_row->>'id')::uuid;
    v_entity_key := v_entity_id::text;
    if tg_op = 'INSERT' then
      v_action := 'item.created';
      v_actor_id := nullif(v_new->>'created_by', '')::uuid;
      v_occurred_at := (v_new->>'created_at')::timestamptz;
      v_dedupe := 'item:create:' || v_entity_id::text;
    elsif v_old->>'archived_at' is null and v_new->>'archived_at' is not null then
      v_action := 'item.archived';
      v_actor_id := nullif(v_new->>'archived_by', '')::uuid;
      v_occurred_at := (v_new->>'archived_at')::timestamptz;
      v_dedupe := 'item:archive:' || v_entity_id::text;
    else
      -- Stock/timestamp changes are represented by their count, delivery, loss,
      -- correction, or opening-adjustment source event. Metadata changes remain.
      v_compare_old := v_old - array[
        'updated_at','current_stock','last_counted_at','last_ordered_at','last_alerted_at',
        'opening_adjustment_quantity','opening_adjustment_unit_cost',
        'opening_adjustment_at','opening_adjustment_request_id'
      ];
      v_compare_new := v_new - array[
        'updated_at','current_stock','last_counted_at','last_ordered_at','last_alerted_at',
        'opening_adjustment_quantity','opening_adjustment_unit_cost',
        'opening_adjustment_at','opening_adjustment_request_id'
      ];
      select coalesce(array_agg(k order by k), '{}'::text[]) into v_changed_fields
      from (
        select key as k from jsonb_each(v_compare_old)
        union
        select key as k from jsonb_each(v_compare_new)
      ) keys
      where v_compare_old->k is distinct from v_compare_new->k;
      if cardinality(v_changed_fields) = 0 then return new; end if;
      v_action := 'item.updated';
      v_occurred_at := coalesce((v_new->>'updated_at')::timestamptz, clock_timestamp());
    end if;
    v_summary := jsonb_build_object(
      'label', v_row->>'name', 'secondaryLabel', v_row->>'category',
      'quantity', null, 'unit', v_row->>'unit', 'itemCount', null,
      'changedFields', to_jsonb(v_changed_fields)
    );
    v_details := jsonb_build_object(
      'category', v_row->>'category',
      'currentStock', nullif(v_row->>'current_stock', '')::numeric,
      'setAside', coalesce(nullif(v_row->>'set_aside', '')::numeric, 0),
      'archived', v_row->>'archived_at' is not null
    );
    v_financial := jsonb_build_object(
      'unitCostBefore', nullif(v_old->>'unit_cost', '')::numeric,
      'unitCostAfter', nullif(v_new->>'unit_cost', '')::numeric
    );

  elsif tg_table_name = 'inventory_counts' then
    v_action := 'count.saved'; v_entity_type := 'count';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_request_id := v_new->>'count_session_id';
    v_occurred_at := (v_new->>'counted_at')::timestamptz;
    v_actor_id := nullif(v_new->>'recorded_by_user_id', '')::uuid;
    v_actor_name := coalesce(v_new->>'recorded_by_name', v_new->>'counted_by');
    v_dedupe := 'count:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', v_new->>'item_name', 'secondaryLabel', null,
      'quantity', nullif(v_new->>'counted_stock', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id',
      'countedStock', nullif(v_new->>'counted_stock', '')::numeric,
      'estimatedStock', nullif(v_new->>'estimated_stock', '')::numeric,
      'variance', nullif(v_new->>'variance', '')::numeric,
      'notes', v_new->>'notes'
    );
    v_financial := jsonb_build_object(
      'unitCost', nullif(v_new->>'unit_cost', '')::numeric,
      'varianceValue', nullif(v_new->>'variance_value', '')::numeric
    );

  elsif tg_table_name = 'inventory_orders' then
    if coalesce(v_new->>'entry_kind', 'receipt') <> 'receipt' then return new; end if;
    v_action := 'delivery.received'; v_entity_type := 'delivery';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_request_id := v_new->>'request_id';
    v_occurred_at := (v_new->>'received_at')::timestamptz;
    v_actor_id := nullif(v_new->>'recorded_by_user_id', '')::uuid;
    v_actor_name := v_new->>'recorded_by_name';
    v_dedupe := 'delivery:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', v_new->>'item_name', 'secondaryLabel', v_new->>'vendor_name',
      'quantity', nullif(v_new->>'quantity', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id', 'vendorName', v_new->>'vendor_name',
      'quantity', nullif(v_new->>'quantity', '')::numeric,
      'quantityCases', nullif(v_new->>'quantity_cases', '')::numeric,
      'receivedAt', v_new->>'received_at', 'reference', v_new->>'notes'
    );
    v_financial := jsonb_build_object(
      'unitCost', nullif(v_new->>'unit_cost', '')::numeric,
      'totalCost', nullif(v_new->>'total_cost', '')::numeric
    );

  elsif tg_table_name = 'inventory_discards' then
    v_action := 'loss.recorded'; v_entity_type := 'loss';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_request_id := v_new->>'request_id';
    v_occurred_at := (v_new->>'discarded_at')::timestamptz;
    v_actor_id := nullif(v_new->>'recorded_by_user_id', '')::uuid;
    v_actor_name := v_new->>'discarded_by';
    v_dedupe := 'loss:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', v_new->>'item_name', 'secondaryLabel', v_new->>'reason',
      'quantity', nullif(v_new->>'quantity', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id', 'reason', v_new->>'reason',
      'quantity', nullif(v_new->>'quantity', '')::numeric,
      'stockBefore', nullif(v_new->>'stock_before', '')::numeric,
      'stockAfter', nullif(v_new->>'stock_after', '')::numeric,
      'notes', v_new->>'notes'
    );
    v_financial := jsonb_build_object(
      'unitCost', nullif(v_new->>'unit_cost', '')::numeric,
      'costValue', nullif(v_new->>'cost_value', '')::numeric
    );

  elsif tg_table_name = 'inventory_reconciliations' then
    v_action := 'reconciliation.recorded'; v_entity_type := 'reconciliation';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_occurred_at := (v_new->>'reconciled_at')::timestamptz;
    v_actor_id := nullif(v_new->>'recorded_by_user_id', '')::uuid;
    v_actor_name := coalesce(v_new->>'recorded_by_name', v_new->>'reconciled_by');
    v_dedupe := 'reconciliation:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', v_new->>'item_name', 'secondaryLabel', null,
      'quantity', nullif(v_new->>'physical_count', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id',
      'physicalCount', nullif(v_new->>'physical_count', '')::numeric,
      'systemEstimate', nullif(v_new->>'system_estimate', '')::numeric,
      'variance', nullif(v_new->>'unaccounted_variance', '')::numeric,
      'notes', v_new->>'notes'
    );
    v_financial := jsonb_build_object(
      'unitCost', nullif(v_new->>'unit_cost', '')::numeric,
      'varianceValue', nullif(v_new->>'unaccounted_variance_value', '')::numeric
    );

  elsif tg_table_name = 'inventory_delivery_corrections' then
    v_action := case when v_new->>'correction_kind' = 'void' then 'delivery.voided' else 'delivery.corrected' end;
    v_entity_type := 'delivery_correction';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'original_order_id';
    v_request_id := v_new->>'request_id';
    v_occurred_at := (v_new->>'corrected_at')::timestamptz;
    v_actor_id := nullif(v_new->>'corrected_by_user_id', '')::uuid;
    v_actor_name := v_new->>'corrected_by';
    v_dedupe := 'delivery-correction:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', coalesce(v_new->>'corrected_item_name', v_new->>'previous_item_name'),
      'secondaryLabel', v_new->>'correction_kind',
      'quantity', nullif(v_new->>'corrected_quantity', '')::numeric,
      'unit', null, 'itemCount', 1, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'originalOrderId', v_new->>'original_order_id', 'kind', v_new->>'correction_kind',
      'reason', v_new->>'reason',
      'previousQuantity', nullif(v_new->>'previous_quantity', '')::numeric,
      'correctedQuantity', nullif(v_new->>'corrected_quantity', '')::numeric,
      'stockEffect', coalesce(v_new->'stock_effect', '[]'::jsonb)
    );
    v_financial := jsonb_build_object(
      'previousUnitCost', nullif(v_new->>'previous_unit_cost', '')::numeric,
      'previousTotalCost', nullif(v_new->>'previous_total_cost', '')::numeric,
      'correctedUnitCost', nullif(v_new->>'corrected_unit_cost', '')::numeric,
      'correctedTotalCost', nullif(v_new->>'corrected_total_cost', '')::numeric
    );

  elsif tg_table_name = 'inventory_opening_adjustments' then
    v_action := 'opening_adjustment.recorded'; v_entity_type := 'opening_adjustment';
    v_entity_id := (v_new->>'id')::uuid; v_entity_key := v_new->>'item_id';
    v_request_id := v_new->>'request_id';
    v_occurred_at := (v_new->>'effective_at')::timestamptz;
    v_actor_id := nullif(v_new->>'actor_id', '')::uuid;
    v_actor_name := v_new->>'actor_name';
    v_dedupe := 'opening-adjustment:' || v_entity_id::text;
    v_summary := jsonb_build_object(
      'label', (select i.name from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'secondaryLabel', null, 'quantity', nullif(v_new->>'quantity', '')::numeric,
      'unit', (select i.unit from public.inventory i where i.id = (v_new->>'item_id')::uuid and i.property_id = v_property_id),
      'itemCount', 1, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'itemId', v_new->>'item_id', 'quantity', nullif(v_new->>'quantity', '')::numeric,
      'stockBefore', nullif(v_new->>'stock_before', '')::numeric,
      'stockAfter', nullif(v_new->>'stock_after', '')::numeric
    );
    v_financial := jsonb_build_object(
      'unitCostCents', nullif(v_new->>'unit_cost_cents', '')::numeric,
      'valueCents', nullif(v_new->>'value_cents', '')::numeric
    );

  elsif tg_table_name = 'inventory_month_closes' then
    v_entity_type := 'month'; v_entity_id := (v_row->>'id')::uuid;
    v_entity_key := v_property_id::text || ':' || (v_row->>'month_start');
    if tg_op = 'INSERT' then
      v_action := 'month.started'; v_request_id := v_new->>'start_request_id';
      v_actor_id := nullif(v_new->>'opened_by', '')::uuid; v_actor_name := v_new->>'opened_by_name';
      v_occurred_at := (v_new->>'baseline_at')::timestamptz;
      v_dedupe := 'month:start:' || v_entity_id::text;
    elsif v_old->>'status' = 'open' and v_new->>'status' = 'closed' then
      v_action := 'month.closed'; v_request_id := v_new->>'close_request_id';
      v_actor_id := nullif(v_new->>'closed_by', '')::uuid; v_actor_name := v_new->>'closed_by_name';
      v_occurred_at := (v_new->>'closed_at')::timestamptz;
      v_dedupe := 'month:close:' || v_entity_id::text;
    else
      return new;
    end if;
    v_summary := jsonb_build_object(
      'label', v_row->>'month_start', 'secondaryLabel', v_row->>'status',
      'quantity', null, 'unit', null, 'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object(
      'month', v_row->>'month_start', 'status', v_row->>'status',
      'partial', coalesce((v_row->>'is_partial')::boolean, false),
      'purchaseSource', v_row->>'purchase_source'
    );
    v_financial := jsonb_build_object(
      'beginningValueCents', nullif(v_row->>'beginning_value_cents', '')::numeric,
      'purchaseCents', nullif(v_row->>'confirmed_purchase_cents', '')::numeric,
      'endingValueCents', nullif(v_row->>'ending_value_cents', '')::numeric,
      'actualUsageCents', nullif(v_row->>'actual_usage_cents', '')::numeric
    );

  elsif tg_table_name = 'vendors' then
    v_entity_type := 'vendor'; v_entity_id := (v_row->>'id')::uuid; v_entity_key := v_entity_id::text;
    if tg_op = 'INSERT' then v_action := 'vendor.created';
    elsif coalesce((v_old->>'is_active')::boolean, true) and not coalesce((v_new->>'is_active')::boolean, true)
      then v_action := 'vendor.inactivated';
    else v_action := 'vendor.updated'; end if;
    v_occurred_at := case when tg_op = 'DELETE' then clock_timestamp() else
      coalesce((v_row->>'updated_at')::timestamptz, (v_row->>'created_at')::timestamptz, clock_timestamp()) end;
    v_dedupe := case when tg_op = 'INSERT' then 'vendor:create:' || v_entity_id::text else null end;
    v_summary := jsonb_build_object(
      'label', v_row->>'name', 'secondaryLabel', null, 'quantity', null,
      'unit', null, 'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object('active', coalesce((v_row->>'is_active')::boolean, true));
    v_financial := jsonb_build_object('accountNumber', v_row->>'account_number');

  elsif tg_table_name = 'inventory_budgets' then
    v_entity_type := 'budget'; v_entity_id := null;
    v_entity_key := v_property_id::text || ':' || (v_row->>'category') || ':' || (v_row->>'month_start') || ':' || coalesce(v_row->>'basis', 'purchases');
    v_source_id := v_entity_key;
    v_action := case tg_op when 'INSERT' then 'budget.created' when 'UPDATE' then 'budget.updated' else 'budget.deleted' end;
    v_occurred_at := case when tg_op = 'DELETE' then clock_timestamp() else
      coalesce((v_row->>'updated_at')::timestamptz, (v_row->>'created_at')::timestamptz, clock_timestamp()) end;
    v_summary := jsonb_build_object(
      'label', v_row->>'category', 'secondaryLabel', v_row->>'month_start',
      'quantity', null, 'unit', null, 'itemCount', null, 'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object('month', v_row->>'month_start', 'basis', coalesce(v_row->>'basis', 'purchases'));
    v_financial := jsonb_build_object('budgetCents', nullif(v_row->>'budget_cents', '')::numeric);

  elsif tg_table_name = 'inventory_custom_categories' then
    v_entity_type := 'category'; v_entity_id := (v_row->>'id')::uuid; v_entity_key := v_entity_id::text;
    v_action := case tg_op when 'INSERT' then 'category.created' when 'UPDATE' then 'category.updated' else 'category.deleted' end;
    v_occurred_at := case when tg_op = 'DELETE' then clock_timestamp() else
      coalesce((v_row->>'updated_at')::timestamptz, (v_row->>'created_at')::timestamptz, clock_timestamp()) end;
    v_summary := jsonb_build_object(
      'label', v_row->>'name', 'secondaryLabel', null, 'quantity', null,
      'unit', null, 'itemCount', null, 'changedFields', '[]'::jsonb
    );

  elsif tg_table_name = 'inventory_budget_sections' then
    v_entity_type := 'budget_section'; v_entity_id := (v_row->>'id')::uuid; v_entity_key := v_entity_id::text;
    v_action := case tg_op when 'INSERT' then 'budget_section.created' when 'UPDATE' then 'budget_section.updated' else 'budget_section.deleted' end;
    v_occurred_at := case when tg_op = 'DELETE' then clock_timestamp() else
      coalesce((v_row->>'updated_at')::timestamptz, (v_row->>'created_at')::timestamptz, clock_timestamp()) end;
    v_summary := jsonb_build_object(
      'label', v_row->>'name', 'secondaryLabel', null, 'quantity', null,
      'unit', null, 'itemCount', coalesce(jsonb_array_length(coalesce(v_row->'item_ids', '[]'::jsonb)), 0),
      'changedFields', '[]'::jsonb
    );
    v_details := jsonb_build_object('itemCount', coalesce(jsonb_array_length(coalesce(v_row->'item_ids', '[]'::jsonb)), 0));

  elsif tg_table_name = 'properties' then
    v_entity_type := 'config'; v_entity_id := v_property_id; v_entity_key := v_property_id::text;
    v_source_id := v_property_id::text; v_action := 'config.updated';
    v_occurred_at := clock_timestamp();
    if v_old->'inventory_tab_layout' is distinct from v_new->'inventory_tab_layout' then
      v_changed_fields := array_append(v_changed_fields, 'inventory_tab_layout');
    end if;
    if v_old->'inventory_budget_mode' is distinct from v_new->'inventory_budget_mode' then
      v_changed_fields := array_append(v_changed_fields, 'inventory_budget_mode');
    end if;
    if cardinality(v_changed_fields) = 0 then return new; end if;
    v_summary := jsonb_build_object(
      'label', v_new->>'name', 'secondaryLabel', null, 'quantity', null,
      'unit', null, 'itemCount', null, 'changedFields', to_jsonb(v_changed_fields)
    );
    v_details := jsonb_build_object(
      'budgetMode', v_new->>'inventory_budget_mode',
      'tabLayout', coalesce(v_new->'inventory_tab_layout', '{}'::jsonb)
    );
    v_old := jsonb_build_object(
      'inventory_budget_mode', v_old->'inventory_budget_mode',
      'inventory_tab_layout', v_old->'inventory_tab_layout'
    );
    v_new := jsonb_build_object(
      'inventory_budget_mode', v_new->'inventory_budget_mode',
      'inventory_tab_layout', v_new->'inventory_tab_layout'
    );
  else
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  perform public.staxis_append_inventory_audit_event(
    v_property_id, v_action, v_entity_type, v_entity_id, v_entity_key,
    tg_table_name, v_source_id, v_request_id, v_occurred_at,
    v_actor_id, v_actor_name, v_summary, v_details, v_financial,
    v_old, v_new, v_dedupe
  );
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

revoke all on function public.staxis_capture_inventory_audit_event()
  from public, anon, authenticated, service_role;

drop trigger if exists inventory_capture_audit on public.inventory;
create trigger inventory_capture_audit after insert or update on public.inventory
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_counts_capture_audit on public.inventory_counts;
create trigger inventory_counts_capture_audit after insert on public.inventory_counts
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_orders_capture_audit on public.inventory_orders;
create trigger inventory_orders_capture_audit after insert on public.inventory_orders
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_discards_capture_audit on public.inventory_discards;
create trigger inventory_discards_capture_audit after insert on public.inventory_discards
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_reconciliations_capture_audit on public.inventory_reconciliations;
create trigger inventory_reconciliations_capture_audit after insert on public.inventory_reconciliations
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_delivery_corrections_capture_audit on public.inventory_delivery_corrections;
create trigger inventory_delivery_corrections_capture_audit after insert on public.inventory_delivery_corrections
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_opening_adjustments_capture_audit on public.inventory_opening_adjustments;
create trigger inventory_opening_adjustments_capture_audit after insert on public.inventory_opening_adjustments
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_month_closes_capture_audit on public.inventory_month_closes;
create trigger inventory_month_closes_capture_audit after insert or update on public.inventory_month_closes
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists vendors_capture_inventory_audit on public.vendors;
create trigger vendors_capture_inventory_audit after insert or update on public.vendors
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_budgets_capture_audit on public.inventory_budgets;
create trigger inventory_budgets_capture_audit after insert or update or delete on public.inventory_budgets
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_custom_categories_capture_audit on public.inventory_custom_categories;
create trigger inventory_custom_categories_capture_audit after insert or update or delete on public.inventory_custom_categories
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists inventory_budget_sections_capture_audit on public.inventory_budget_sections;
create trigger inventory_budget_sections_capture_audit after insert or update or delete on public.inventory_budget_sections
  for each row execute function public.staxis_capture_inventory_audit_event();
drop trigger if exists properties_capture_inventory_config_audit on public.properties;
create trigger properties_capture_inventory_config_audit
  after update of inventory_tab_layout, inventory_budget_mode on public.properties
  for each row execute function public.staxis_capture_inventory_audit_event();

-- Service-role vendor/config writes use transaction-local actor context, so
-- their source mutation and audit row either commit together or both roll back.
create or replace function public.staxis_create_inventory_vendor(
  p_property_id uuid,
  p_name text,
  p_email text,
  p_phone text,
  p_account_number text,
  p_notes text,
  p_is_active boolean,
  p_actor_id uuid,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare v_vendor public.vendors%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory vendor writes are service-role only' using errcode = '42501';
  end if;
  if p_actor_id is null then raise exception 'authenticated actor is required' using errcode = '22023'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then
    raise exception 'vendor name is required' using errcode = '22023';
  end if;
  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);
  insert into public.vendors(property_id,name,email,phone,account_number,notes,is_active)
  values (
    p_property_id, trim(p_name), nullif(trim(p_email), ''), nullif(trim(p_phone), ''),
    nullif(trim(p_account_number), ''), nullif(trim(p_notes), ''), coalesce(p_is_active, true)
  ) returning * into v_vendor;
  return to_jsonb(v_vendor);
end
$$;

create or replace function public.staxis_update_inventory_vendor(
  p_property_id uuid,
  p_vendor_id uuid,
  p_patch jsonb,
  p_actor_id uuid,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare v_vendor public.vendors%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory vendor writes are service-role only' using errcode = '42501';
  end if;
  if p_actor_id is null then raise exception 'authenticated actor is required' using errcode = '22023'; end if;
  if jsonb_typeof(p_patch) <> 'object' then raise exception 'vendor patch must be an object' using errcode = '22023'; end if;
  if p_patch ? 'name' and length(trim(coalesce(p_patch->>'name', ''))) not between 1 and 120 then
    raise exception 'vendor name is required' using errcode = '22023';
  end if;
  if p_patch ? 'isActive' and jsonb_typeof(p_patch->'isActive') <> 'boolean' then
    raise exception 'isActive must be boolean' using errcode = '22023';
  end if;
  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);
  update public.vendors
  set name = case when p_patch ? 'name' then trim(p_patch->>'name') else name end,
      email = case when p_patch ? 'email' then nullif(trim(p_patch->>'email'), '') else email end,
      phone = case when p_patch ? 'phone' then nullif(trim(p_patch->>'phone'), '') else phone end,
      account_number = case when p_patch ? 'accountNumber' then nullif(trim(p_patch->>'accountNumber'), '') else account_number end,
      notes = case when p_patch ? 'notes' then nullif(trim(p_patch->>'notes'), '') else notes end,
      is_active = case when p_patch ? 'isActive' then (p_patch->>'isActive')::boolean else is_active end,
      updated_at = clock_timestamp()
  where id = p_vendor_id and property_id = p_property_id
  returning * into v_vendor;
  if not found then return null; end if;
  return to_jsonb(v_vendor);
end
$$;

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
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory property config writes are service-role only' using errcode = '42501';
  end if;
  if p_actor_id is null then raise exception 'authenticated actor is required' using errcode = '22023'; end if;
  if p_tab_layout is null and p_budget_mode is null then
    raise exception 'nothing to update' using errcode = '22023';
  end if;
  if p_budget_mode is not null and p_budget_mode not in ('total','sections') then
    raise exception 'invalid inventory budget mode' using errcode = '22023';
  end if;
  perform set_config('staxis.inventory_actor_id', p_actor_id::text, true);
  perform set_config('staxis.inventory_actor_name', coalesce(p_actor_name, ''), true);
  update public.properties
  set inventory_tab_layout = coalesce(p_tab_layout, inventory_tab_layout),
      inventory_budget_mode = coalesce(p_budget_mode, inventory_budget_mode)
  where id = p_property_id;
  return found;
end
$$;

revoke all on function public.staxis_create_inventory_vendor(uuid,text,text,text,text,text,boolean,uuid,text)
  from public, anon, authenticated;
grant execute on function public.staxis_create_inventory_vendor(uuid,text,text,text,text,text,boolean,uuid,text)
  to service_role;
revoke all on function public.staxis_update_inventory_vendor(uuid,uuid,jsonb,uuid,text)
  from public, anon, authenticated;
grant execute on function public.staxis_update_inventory_vendor(uuid,uuid,jsonb,uuid,text)
  to service_role;
revoke all on function public.staxis_update_inventory_property_config(uuid,jsonb,text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.staxis_update_inventory_property_config(uuid,jsonb,text,uuid,text)
  to service_role;

-- Force future vendor mutations through the actor-aware functions above.
revoke insert, update, delete on public.vendors from service_role;

-- Day-one backfill.  Stable source keys make this safe to re-run; a staging
-- table lets the initial sequence follow historical occurrence order.
create temporary table staxis_inventory_audit_backfill (
  property_id uuid, action text, entity_type text, entity_id uuid, entity_key text,
  source_table text, source_id text, request_id text, occurred_at timestamptz,
  actor_user_id uuid, actor_name text, summary jsonb, details jsonb,
  financial_details jsonb, before_state jsonb, after_state jsonb, dedupe_key text
) on commit drop;

insert into staxis_inventory_audit_backfill
select i.property_id, 'item.created', 'item', i.id, i.id::text,
  'inventory', i.id::text, null, item_history.first_seen_at, i.created_by,
  public.staxis_inventory_audit_actor_name(i.created_by),
  jsonb_build_object('label',i.name,'secondaryLabel',i.category,'quantity',null,'unit',i.unit,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object(
    'category',i.category,'currentStock',i.current_stock,
    'setAside',coalesce(i.set_aside,0),'archived',i.archived_at is not null,
    'baseline',i.created_at is null,'inferredOccurredAt',i.created_at is null
  ),
  jsonb_build_object('unitCostAfter',i.unit_cost), null, to_jsonb(i), 'item:create:' || i.id::text
from public.inventory i
cross join lateral (
  -- created_at was introduced after the first inventory rollout, so legacy
  -- rows legitimately contain null. For those rows, use the earliest retained
  -- item evidence instead of inventing an exact creation date. updated_at is
  -- non-null and guarantees every baseline event still has a stable timestamp.
  select coalesce(i.created_at, min(evidence.occurred_at), i.updated_at, clock_timestamp()) as first_seen_at
  from (
    select i.updated_at as occurred_at
    union all select i.last_counted_at
    union all select i.last_ordered_at
    union all select i.archived_at
    union all
      select c.counted_at from public.inventory_counts c
      where c.property_id=i.property_id and c.item_id=i.id
    union all
      select o.received_at from public.inventory_orders o
      where o.property_id=i.property_id and o.item_id=i.id
    union all
      select d.discarded_at from public.inventory_discards d
      where d.property_id=i.property_id and d.item_id=i.id
    union all
      select r.reconciled_at from public.inventory_reconciliations r
      where r.property_id=i.property_id and r.item_id=i.id
    union all
      select a.effective_at from public.inventory_opening_adjustments a
      where a.property_id=i.property_id and a.item_id=i.id
    union all
      select c.corrected_at from public.inventory_delivery_corrections c
      where c.property_id=i.property_id
        and (c.previous_item_id=i.id or c.corrected_item_id=i.id)
  ) evidence
) item_history;

insert into staxis_inventory_audit_backfill
select i.property_id, 'item.archived', 'item', i.id, i.id::text,
  'inventory', i.id::text, null, i.archived_at, i.archived_by,
  public.staxis_inventory_audit_actor_name(i.archived_by),
  jsonb_build_object('label',i.name,'secondaryLabel',i.category,'quantity',null,'unit',i.unit,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('category',i.category,'currentStock',i.current_stock,'setAside',coalesce(i.set_aside,0),'archived',true),
  jsonb_build_object('unitCostAfter',i.unit_cost), null, to_jsonb(i), 'item:archive:' || i.id::text
from public.inventory i where i.archived_at is not null;

-- Before 0326, the assistant's order-only action persisted only this item
-- timestamp. Preserve one explicit cutover event so that visible manager
-- history does not disappear; repeated future intents use request-bound rows.
insert into staxis_inventory_audit_backfill
select i.property_id, 'order_intent.recorded', 'item', i.id, i.id::text,
  'inventory', i.id::text || ':last_ordered_at', null, i.last_ordered_at,
  null, null,
  jsonb_build_object(
    'label',i.name,'secondaryLabel','legacy order marker','quantity',null,
    'unit',i.unit,'itemCount',1,'changedFields',jsonb_build_array('last_ordered_at')
  ),
  jsonb_build_object(
    'itemId',i.id,'orderedAt',i.last_ordered_at,'baseline',true,
    'inferredFromLastOrderedAt',true
  ),
  '{}'::jsonb, null,
  jsonb_build_object('last_ordered_at',i.last_ordered_at),
  'order-intent:baseline:' || i.id::text
from public.inventory i
where i.last_ordered_at is not null;

insert into staxis_inventory_audit_backfill
select c.property_id, 'count.saved', 'count', c.id, c.item_id::text,
  'inventory_counts', c.id::text, c.count_session_id::text, c.counted_at,
  c.recorded_by_user_id, coalesce(c.recorded_by_name,c.counted_by),
  jsonb_build_object('label',c.item_name,'secondaryLabel',null,'quantity',c.counted_stock,'unit',i.unit,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('itemId',c.item_id,'countedStock',c.counted_stock,'estimatedStock',c.estimated_stock,'variance',c.variance,'notes',c.notes),
  jsonb_build_object('unitCost',c.unit_cost,'varianceValue',c.variance_value), null, to_jsonb(c), 'count:' || c.id::text
from public.inventory_counts c join public.inventory i on i.id=c.item_id and i.property_id=c.property_id;

insert into staxis_inventory_audit_backfill
select o.property_id, 'delivery.received', 'delivery', o.id, o.item_id::text,
  'inventory_orders', o.id::text, o.request_id::text, o.received_at,
  o.recorded_by_user_id, o.recorded_by_name,
  jsonb_build_object('label',o.item_name,'secondaryLabel',o.vendor_name,'quantity',o.quantity,'unit',i.unit,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('itemId',o.item_id,'vendorName',o.vendor_name,'quantity',o.quantity,'quantityCases',o.quantity_cases,'receivedAt',o.received_at,'reference',o.notes),
  jsonb_build_object('unitCost',o.unit_cost,'totalCost',o.total_cost), null, to_jsonb(o), 'delivery:' || o.id::text
from public.inventory_orders o join public.inventory i on i.id=o.item_id and i.property_id=o.property_id
where coalesce(o.entry_kind,'receipt')='receipt';

insert into staxis_inventory_audit_backfill
select d.property_id, 'loss.recorded', 'loss', d.id, d.item_id::text,
  'inventory_discards', d.id::text, d.request_id::text, d.discarded_at,
  d.recorded_by_user_id, coalesce(public.staxis_inventory_audit_actor_name(d.recorded_by_user_id),d.discarded_by),
  jsonb_build_object('label',d.item_name,'secondaryLabel',d.reason,'quantity',d.quantity,'unit',i.unit,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('itemId',d.item_id,'reason',d.reason,'quantity',d.quantity,'stockBefore',d.stock_before,'stockAfter',d.stock_after,'notes',d.notes),
  jsonb_build_object('unitCost',d.unit_cost,'costValue',d.cost_value), null, to_jsonb(d), 'loss:' || d.id::text
from public.inventory_discards d join public.inventory i on i.id=d.item_id and i.property_id=d.property_id;

insert into staxis_inventory_audit_backfill
select r.property_id, 'reconciliation.recorded', 'reconciliation', r.id, r.item_id::text,
  'inventory_reconciliations', r.id::text, null, r.reconciled_at,
  r.recorded_by_user_id, coalesce(r.recorded_by_name,r.reconciled_by),
  jsonb_build_object('label',r.item_name,'secondaryLabel',null,'quantity',r.physical_count,'unit',i.unit,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('itemId',r.item_id,'physicalCount',r.physical_count,'systemEstimate',r.system_estimate,'variance',r.unaccounted_variance,'notes',r.notes),
  jsonb_build_object('unitCost',r.unit_cost,'varianceValue',r.unaccounted_variance_value),
  null, to_jsonb(r), 'reconciliation:' || r.id::text
from public.inventory_reconciliations r
join public.inventory i on i.id=r.item_id and i.property_id=r.property_id;

insert into staxis_inventory_audit_backfill
select c.property_id,
  case when c.correction_kind='void' then 'delivery.voided' else 'delivery.corrected' end,
  'delivery_correction', c.id, c.original_order_id::text,
  'inventory_delivery_corrections', c.id::text, c.request_id::text, c.corrected_at,
  c.corrected_by_user_id, coalesce(public.staxis_inventory_audit_actor_name(c.corrected_by_user_id),c.corrected_by),
  jsonb_build_object('label',coalesce(c.corrected_item_name,c.previous_item_name),'secondaryLabel',c.correction_kind,'quantity',c.corrected_quantity,'unit',null,'itemCount',1,'changedFields','[]'::jsonb),
  jsonb_build_object('originalOrderId',c.original_order_id,'kind',c.correction_kind,'reason',c.reason,'previousQuantity',c.previous_quantity,'correctedQuantity',c.corrected_quantity,'stockEffect',c.stock_effect),
  jsonb_build_object('previousUnitCost',c.previous_unit_cost,'previousTotalCost',c.previous_total_cost,'correctedUnitCost',c.corrected_unit_cost,'correctedTotalCost',c.corrected_total_cost),
  null, to_jsonb(c), 'delivery-correction:' || c.id::text
from public.inventory_delivery_corrections c;

insert into staxis_inventory_audit_backfill
select c.property_id, 'month.started', 'month', c.id, c.property_id::text || ':' || c.month_start::text,
  'inventory_month_closes', c.id::text, c.start_request_id::text, c.baseline_at,
  c.opened_by, coalesce(public.staxis_inventory_audit_actor_name(c.opened_by),c.opened_by_name),
  jsonb_build_object('label',c.month_start,'secondaryLabel','open','quantity',null,'unit',null,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('month',c.month_start,'status','open','partial',c.is_partial,'purchaseSource',null),
  jsonb_build_object('beginningValueCents',c.beginning_value_cents), null, to_jsonb(c), 'month:start:' || c.id::text
from public.inventory_month_closes c;

insert into staxis_inventory_audit_backfill
select c.property_id, 'month.closed', 'month', c.id, c.property_id::text || ':' || c.month_start::text,
  'inventory_month_closes', c.id::text, c.close_request_id::text, c.closed_at,
  c.closed_by, coalesce(public.staxis_inventory_audit_actor_name(c.closed_by),c.closed_by_name),
  jsonb_build_object('label',c.month_start,'secondaryLabel','closed','quantity',null,'unit',null,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('month',c.month_start,'status','closed','partial',c.is_partial,'purchaseSource',c.purchase_source),
  jsonb_build_object('beginningValueCents',c.beginning_value_cents,'purchaseCents',c.confirmed_purchase_cents,'endingValueCents',c.ending_value_cents,'actualUsageCents',c.actual_usage_cents),
  null, to_jsonb(c), 'month:close:' || c.id::text
from public.inventory_month_closes c where c.status='closed';

insert into staxis_inventory_audit_backfill
select a.property_id, 'opening_adjustment.recorded', 'opening_adjustment', a.id, a.item_id::text,
  'inventory_opening_adjustments', a.id::text, a.request_id::text, a.effective_at,
  a.actor_id, coalesce(public.staxis_inventory_audit_actor_name(a.actor_id),a.actor_name),
  jsonb_build_object('label',i.name,'secondaryLabel',null,'quantity',a.quantity,'unit',i.unit,'itemCount',1,'changedFields','[]'::jsonb),
  jsonb_build_object('itemId',a.item_id,'quantity',a.quantity,'stockBefore',a.stock_before,'stockAfter',a.stock_after),
  jsonb_build_object('unitCostCents',a.unit_cost_cents,'valueCents',a.value_cents), null, to_jsonb(a), 'opening-adjustment:' || a.id::text
from public.inventory_opening_adjustments a join public.inventory i on i.id=a.item_id and i.property_id=a.property_id;

insert into staxis_inventory_audit_backfill
select v.property_id, 'vendor.created', 'vendor', v.id, v.id::text,
  'vendors', v.id::text, null, v.created_at, null, null,
  jsonb_build_object('label',v.name,'secondaryLabel',null,'quantity',null,'unit',null,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('active',v.is_active,'baseline',true),
  jsonb_build_object('accountNumber',v.account_number), null, to_jsonb(v), 'vendor:create:' || v.id::text
from public.vendors v;

insert into staxis_inventory_audit_backfill
select b.property_id, 'budget.created', 'budget', null,
  b.property_id::text || ':' || b.category || ':' || b.month_start::text || ':' || b.basis,
  'inventory_budgets', b.property_id::text || ':' || b.category || ':' || b.month_start::text || ':' || b.basis,
  null, b.created_at, null, null,
  jsonb_build_object('label',b.category,'secondaryLabel',b.month_start,'quantity',null,'unit',null,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('month',b.month_start,'basis',b.basis,'baseline',true),
  jsonb_build_object('budgetCents',b.budget_cents), null, to_jsonb(b),
  'budget:create:' || b.property_id::text || ':' || b.category || ':' || b.month_start::text || ':' || b.basis
from public.inventory_budgets b;

insert into staxis_inventory_audit_backfill
select c.property_id, 'category.created', 'category', c.id, c.id::text,
  'inventory_custom_categories', c.id::text, null, c.created_at, null, null,
  jsonb_build_object('label',c.name,'secondaryLabel',null,'quantity',null,'unit',null,'itemCount',null,'changedFields','[]'::jsonb),
  jsonb_build_object('baseline',true), '{}'::jsonb, null, to_jsonb(c), 'category:create:' || c.id::text
from public.inventory_custom_categories c;

insert into staxis_inventory_audit_backfill
select s.property_id, 'budget_section.created', 'budget_section', s.id, s.id::text,
  'inventory_budget_sections', s.id::text, null, s.created_at, null, null,
  jsonb_build_object('label',s.name,'secondaryLabel',null,'quantity',null,'unit',null,'itemCount',cardinality(s.item_ids),'changedFields','[]'::jsonb),
  jsonb_build_object('itemCount',cardinality(s.item_ids),'baseline',true),
  '{}'::jsonb, null, to_jsonb(s), 'budget-section:create:' || s.id::text
from public.inventory_budget_sections s;

insert into staxis_inventory_audit_backfill
select p.id, 'config.updated', 'config', p.id, p.id::text,
  'properties', p.id::text, null, coalesce(p.updated_at,p.created_at,clock_timestamp()), null, null,
  jsonb_build_object(
    'label',p.name,'secondaryLabel',null,'quantity',null,'unit',null,'itemCount',null,
    'changedFields',jsonb_build_array('inventory_tab_layout','inventory_budget_mode')
  ),
  jsonb_build_object(
    'budgetMode',p.inventory_budget_mode,
    'tabLayout',coalesce(p.inventory_tab_layout,'{}'::jsonb),
    'baseline',true
  ),
  '{}'::jsonb, null,
  jsonb_build_object(
    'inventory_budget_mode',p.inventory_budget_mode,
    'inventory_tab_layout',p.inventory_tab_layout
  ),
  'config:baseline:' || p.id::text
from public.properties p;

insert into public.inventory_audit_events (
  property_id,action,entity_type,entity_id,entity_key,source_table,source_id,
  request_id,occurred_at,actor_user_id,actor_name,summary,details,
  financial_details,before_state,after_state,dedupe_key
)
select property_id,action,entity_type,entity_id,entity_key,source_table,source_id,
  request_id,occurred_at,actor_user_id,actor_name,summary,details,
  financial_details,before_state,after_state,dedupe_key
from staxis_inventory_audit_backfill
-- Legacy items without created_at borrow their earliest retained evidence
-- timestamp.  When that timestamp ties the count/delivery/archive row that
-- supplied it, the inferred baseline must receive the lower sequence so the
-- descending History feed shows the real evidence above the baseline.
order by occurred_at,
  case
    when action = 'item.created'
      and source_table = 'inventory'
      and details @> '{"baseline":true,"inferredOccurredAt":true}'::jsonb
    then 0
    else 1
  end,
  dedupe_key
on conflict (dedupe_key) where dedupe_key is not null do nothing;

create or replace function public.staxis_reject_inventory_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old; -- permit the explicit whole-property cascade only
  end if;
  raise exception 'inventory audit events are immutable' using errcode = '23514';
end
$$;

drop trigger if exists inventory_audit_events_immutable on public.inventory_audit_events;
create trigger inventory_audit_events_immutable
  before update or delete on public.inventory_audit_events
  for each row execute function public.staxis_reject_inventory_audit_mutation();
revoke all on function public.staxis_reject_inventory_audit_mutation()
  from public, anon, authenticated, service_role;

create or replace function public.staxis_list_inventory_audit_events(
  p_property_id uuid,
  p_before_sequence bigint,
  p_limit integer,
  p_include_financials boolean
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory audit history is service-role only' using errcode = '42501';
  end if;

  with page as materialized (
    select e.*
    from public.inventory_audit_events e
    where e.property_id = p_property_id
      and (p_before_sequence is null or e.sequence < p_before_sequence)
    order by e.sequence desc
    limit v_limit + 1
  ), visible as (
    select * from page order by sequence desc limit v_limit
  )
  select jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id,
        'action', v.action,
        'entityType', v.entity_type,
        'entityId', v.entity_id,
        'occurredAt', v.occurred_at,
        'actorName', v.actor_name,
        'requestId', v.request_id,
        'summary', v.summary,
        'details', v.details || case when coalesce(p_include_financials, false)
          then v.financial_details else '{}'::jsonb end
      ) order by v.sequence desc)
      from visible v
    ), '[]'::jsonb),
    'nextSequence', case when (select count(*) from page) > v_limit
      then (select min(v.sequence)::text from visible v)
      else null end
  ) into v_result;
  return v_result;
end
$$;

revoke all on function public.staxis_list_inventory_audit_events(uuid,bigint,integer,boolean)
  from public, anon, authenticated;
grant execute on function public.staxis_list_inventory_audit_events(uuid,bigint,integer,boolean)
  to service_role;

insert into public.applied_migrations(version, description)
values ('0326', 'append-only inventory audit ledger with auth-derived actors, complete operational backfill, and capability-filtered cursor history')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
