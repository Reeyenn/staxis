-- 0324: Inventory operational corrections.
--
-- Hotels need three honest, retry-safe ways to repair everyday mistakes:
--   * record missing/damaged/lost stock and decrement on-hand in one commit;
--   * correct or void a saved delivery without rewriting its original row;
--   * archive zero-stock items without inventing an evidence-free ending zero.
--
-- Delivery corrections are compensating inventory_orders rows.  The original
-- receipt and every correction event remain immutable evidence, while every
-- existing SUM(quantity/total_cost) naturally resolves to the corrected fact.

begin;

do $$
begin
  if to_regprocedure('public.staxis_parse_finite_numeric(text,text)') is null
     or to_regprocedure('public.staxis_receive_inventory_delivery(uuid,uuid,timestamptz,text,text,jsonb)') is null
  then
    raise exception 'inventory operational corrections require migration 0312';
  end if;
  if to_regprocedure('public.staxis_close_inventory_month_close(uuid,date,uuid,text,bigint,uuid,text,text)') is null then
    raise exception 'inventory operational corrections require migration 0322';
  end if;
end
$$;

-- Transaction timestamps are fixed when a transaction starts, so they can be
-- older than work that actually acquired the hotel lock and committed first.
-- A database sequence allocated only after that lock gives every count/order/
-- loss a durable stock-activity order for stale-count and close validation.
create sequence if not exists public.inventory_activity_sequence;

alter table public.inventory_counts add column if not exists activity_sequence bigint;
alter table public.inventory_orders add column if not exists activity_sequence bigint;
alter table public.inventory_discards add column if not exists activity_sequence bigint;

-- These three existing triggers reject writes whose business timestamp belongs
-- to a closed month. Assigning a provenance-only sequence does not change that
-- historical business fact, so disable only those guards for the backfill and
-- restore them immediately. Any failure rolls the whole transaction back,
-- including trigger state.
alter table public.inventory_counts
  disable trigger inventory_counts_month_close_guard;
alter table public.inventory_orders
  disable trigger inventory_orders_month_close_guard;
alter table public.inventory_discards
  disable trigger inventory_discards_month_close_guard;

create temporary table staxis_inventory_activity_backfill on commit drop as
select event_kind, id,
  row_number() over (order by created_at, event_kind, id)::bigint as activity_sequence
from (
  select 'count'::text as event_kind, c.id, c.created_at from public.inventory_counts c
  union all
  select 'order'::text, o.id, o.created_at from public.inventory_orders o
  union all
  select 'discard'::text, d.id, d.created_at from public.inventory_discards d
) events;

update public.inventory_counts c
set activity_sequence = b.activity_sequence
from staxis_inventory_activity_backfill b
where b.event_kind = 'count' and b.id = c.id and c.activity_sequence is null;
update public.inventory_orders o
set activity_sequence = b.activity_sequence
from staxis_inventory_activity_backfill b
where b.event_kind = 'order' and b.id = o.id and o.activity_sequence is null;
update public.inventory_discards d
set activity_sequence = b.activity_sequence
from staxis_inventory_activity_backfill b
where b.event_kind = 'discard' and b.id = d.id and d.activity_sequence is null;

alter table public.inventory_counts
  enable trigger inventory_counts_month_close_guard;
alter table public.inventory_orders
  enable trigger inventory_orders_month_close_guard;
alter table public.inventory_discards
  enable trigger inventory_discards_month_close_guard;

-- Sequence state is non-transactional. Never rewind it if a deployment is
-- retried after newer activity already allocated values and a later statement
-- in the retry fails. Include both the stored rows and existing sequence state;
-- the correction table participates on a post-0324 retry when it exists.
do $$
declare
  v_last_value bigint;
  v_was_called boolean;
  v_row_max bigint;
  v_correction_max bigint := 0;
  v_target bigint;
  v_has_allocated_value boolean;
begin
  select last_value, is_called
    into v_last_value, v_was_called
  from public.inventory_activity_sequence;

  select greatest(
    coalesce((select max(b.activity_sequence) from staxis_inventory_activity_backfill b), 0),
    coalesce((select max(c.activity_sequence) from public.inventory_counts c), 0),
    coalesce((select max(o.activity_sequence) from public.inventory_orders o), 0),
    coalesce((select max(d.activity_sequence) from public.inventory_discards d), 0)
  ) into v_row_max;

  if to_regclass('public.inventory_delivery_corrections') is not null then
    execute 'select coalesce(max(activity_sequence), 0) from public.inventory_delivery_corrections'
      into v_correction_max;
  end if;

  v_target := greatest(v_last_value, v_row_max, v_correction_max, 1);
  v_has_allocated_value := v_was_called or v_row_max > 0 or v_correction_max > 0;
  perform pg_catalog.setval(
    'public.inventory_activity_sequence'::regclass,
    v_target,
    v_has_allocated_value
  );
end
$$;

alter table public.inventory_counts
  alter column activity_sequence set default nextval('public.inventory_activity_sequence'),
  alter column activity_sequence set not null;
alter table public.inventory_orders
  alter column activity_sequence set default nextval('public.inventory_activity_sequence'),
  alter column activity_sequence set not null;
alter table public.inventory_discards
  alter column activity_sequence set default nextval('public.inventory_activity_sequence'),
  alter column activity_sequence set not null;

create index if not exists inventory_counts_item_activity_idx
  on public.inventory_counts(property_id,item_id,activity_sequence desc);
create index if not exists inventory_orders_item_activity_idx
  on public.inventory_orders(property_id,item_id,activity_sequence desc);
create index if not exists inventory_discards_item_activity_idx
  on public.inventory_discards(property_id,item_id,activity_sequence desc);

-- Delivery dates are hotel calendar dates represented at local noon. The
-- older month-close trigger treated noon as a future instant before midday and
-- rejected a valid same-day invoice. Keep exact-time protection for counts and
-- losses, but validate delivery rows by the property's local calendar date.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.staxis_inventory_close_activity_guard()'::regprocedure
  ) into v_def;
  v_new := replace(v_def,
$old$  v_property_id uuid;
  v_activity_at timestamptz;
  v_open record;$old$,
$new$  v_property_id uuid;
  v_activity_at timestamptz;
  v_property_timezone text;
  v_open record;$new$);
  if v_new = v_def then
    raise exception '0324 could not add hotel timezone to the inventory activity guard';
  end if;
  v_def := v_new;

  v_new := replace(v_def,
$old$  perform 1 from public.properties p where p.id = v_property_id for update;
  if not found then
    raise exception 'inventory activity property not found' using errcode = '23503';
  end if;$old$,
$new$  select nullif(trim(p.timezone), '')
    into v_property_timezone
  from public.properties p
  where p.id = v_property_id
  for update;
  if not found then
    raise exception 'inventory activity property not found' using errcode = '23503';
  end if;$new$);
  if v_new = v_def then
    raise exception '0324 could not load hotel timezone in the inventory activity guard';
  end if;
  v_def := v_new;

  v_new := replace(v_def,
$old$  if tg_op = 'INSERT' and v_activity_at > now() + interval '5 minutes' then
    raise exception 'inventory activity timestamp cannot be in the future' using errcode = '22023';
  end if;$old$,
$new$  if tg_op = 'INSERT' and tg_table_name = 'inventory_orders' then
    if v_property_timezone is null or not exists (
      select 1 from pg_catalog.pg_timezone_names t where t.name = v_property_timezone
    ) then
      raise exception 'property timezone is missing or invalid; set a valid IANA timezone before receiving inventory'
        using errcode = '22023';
    end if;
    if (v_activity_at at time zone v_property_timezone)::date
       > (now() at time zone v_property_timezone)::date
    then
      raise exception 'inventory delivery date cannot be a future hotel date'
        using errcode = '22023';
    end if;
  elsif tg_op = 'INSERT' and v_activity_at > now() + interval '5 minutes' then
    raise exception 'inventory activity timestamp cannot be in the future' using errcode = '22023';
  end if;$new$);
  if v_new = v_def then
    raise exception '0324 could not install hotel-calendar delivery date validation';
  end if;
  execute v_new;
end
$$;

-- Preserve item-master metadata before the first delivery-derived cache write.
-- If every effective receipt is later moved/voided, correction can restore the
-- hotel's original configured cost/vendor instead of erasing it or retaining
-- the mistaken delivery values.
alter table public.inventory
  add column if not exists delivery_cache_active boolean not null default false,
  add column if not exists delivery_baseline_unit_cost numeric,
  add column if not exists delivery_baseline_vendor_name text,
  add column if not exists delivery_baseline_last_ordered_at timestamptz;

-- Pre-0324 delivery receipts already wrote their latest values into the item
-- cache. Their original pre-delivery metadata cannot be reconstructed, so mark
-- that cache as derived with an explicit unknown baseline. Voiding every root
-- will then clear it instead of leaving a voided invoice's values live.
update public.inventory i
set delivery_cache_active = true,
    delivery_baseline_unit_cost = null,
    delivery_baseline_vendor_name = null,
    delivery_baseline_last_ordered_at = null
where not i.delivery_cache_active
  and i.archived_at is null
  and exists (
    select 1 from public.inventory_orders o
    where o.property_id = i.property_id
      and o.item_id = i.id
  );

create or replace function public.staxis_capture_inventory_delivery_baseline()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if current_user in ('authenticated','anon') then
      new.delivery_cache_active := false;
      new.delivery_baseline_unit_cost := null;
      new.delivery_baseline_vendor_name := null;
      new.delivery_baseline_last_ordered_at := null;
    end if;
    return new;
  end if;

  if current_user in ('authenticated','anon') and (
    new.delivery_cache_active is distinct from old.delivery_cache_active
    or new.delivery_baseline_unit_cost is distinct from old.delivery_baseline_unit_cost
    or new.delivery_baseline_vendor_name is distinct from old.delivery_baseline_vendor_name
    or new.delivery_baseline_last_ordered_at is distinct from old.delivery_baseline_last_ordered_at
  ) then
    raise exception 'inventory delivery-cache provenance is database-owned'
      using errcode = '42501';
  end if;

  -- A manager editing the displayed item master while a receipt cache is
  -- active is intentionally changing the value we must restore after void.
  if current_user in ('authenticated','anon') and old.delivery_cache_active then
    if new.unit_cost is distinct from old.unit_cost then
      new.delivery_baseline_unit_cost := new.unit_cost;
    end if;
    if new.vendor_name is distinct from old.vendor_name then
      new.delivery_baseline_vendor_name := new.vendor_name;
    end if;
  end if;

  if old.archived_at is null
     and not old.delivery_cache_active
     and new.current_stock > old.current_stock
     and new.last_ordered_at is distinct from old.last_ordered_at
  then
    new.delivery_cache_active := true;
    new.delivery_baseline_unit_cost := old.unit_cost;
    new.delivery_baseline_vendor_name := old.vendor_name;
    new.delivery_baseline_last_ordered_at := old.last_ordered_at;
  end if;
  return new;
end
$$;

drop trigger if exists inventory_delivery_cache_baseline on public.inventory;
create trigger inventory_delivery_cache_baseline
  before insert or update on public.inventory
  for each row execute function public.staxis_capture_inventory_delivery_baseline();

-- Existing count and delivery RPCs used to lock an inventory row before the
-- 0322 inventory trigger locked its property. Loss/correction/close take the
-- opposite order, which can deadlock two otherwise valid hotel saves. Pin the
-- shared property lock before any item row is touched.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.staxis_save_inventory_count(uuid,uuid,timestamptz,text,jsonb)'::regprocedure
  ) into v_def;
  v_new := replace(v_def,
$old$  end if;
  if p_request_id is null then raise exception 'request id is required'; end if;$old$,
$new$  end if;
  perform 1 from public.properties p where p.id = p_property_id for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;
  if p_request_id is null then raise exception 'request id is required'; end if;$new$);
  if v_new = v_def then
    raise exception '0324 could not establish count property-first locking';
  end if;
  execute v_new;

  select pg_get_functiondef(
    'public.staxis_receive_inventory_delivery(uuid,uuid,timestamptz,text,text,jsonb)'::regprocedure
  ) into v_def;
  v_new := replace(v_def,
$old$  end if;
  if p_request_id is null then raise exception 'request id is required'; end if;$old$,
$new$  end if;
  select nullif(trim(p.timezone), '')
    into v_property_timezone
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;
  if v_property_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names t where t.name = v_property_timezone
  ) then
    raise exception 'property timezone is missing or invalid; set a valid IANA timezone before receiving inventory'
      using errcode = '22023';
  end if;
  if p_received_at is not null
     and (p_received_at at time zone v_property_timezone)::date
       > (now() at time zone v_property_timezone)::date
  then
    raise exception 'received_at cannot be a future hotel date' using errcode = '22023';
  end if;
  if p_request_id is null then raise exception 'request id is required'; end if;$new$);
  if v_new = v_def then
    raise exception '0324 could not establish delivery property-first locking';
  end if;
  v_def := v_new;
  v_new := replace(v_def,
$old$        unit_cost, vendor_name, last_ordered_at, last_counted_at
      ) values (
        p_property_id, v_name, v_category, v_quantity, v_par, v_unit,
        v_unit_cost, nullif(trim(p_vendor_name), ''), coalesce(p_received_at, now()), coalesce(p_received_at, now())$old$,
$new$        unit_cost, vendor_name, last_ordered_at, last_counted_at,
        delivery_cache_active
      ) values (
        p_property_id, v_name, v_category, v_quantity, v_par, v_unit,
        v_unit_cost, nullif(trim(p_vendor_name), ''), coalesce(p_received_at, now()), coalesce(p_received_at, now()),
        true$new$);
  if v_new = v_def then
    raise exception '0324 could not mark delivery-created inventory metadata provenance';
  end if;
  v_def := v_new;
  v_new := replace(v_def,
$old$      coalesce(v_unit_cost, v_item.unit_cost),
      case when coalesce(v_unit_cost, v_item.unit_cost) is null then null
           else round(v_quantity * coalesce(v_unit_cost, v_item.unit_cost), 2) end,$old$,
$new$      case when r.value ? 'unit_cost' then v_unit_cost else v_item.unit_cost end,
      case
        when r.value ? 'unit_cost' then
          case when v_unit_cost is null then null else round(v_quantity * v_unit_cost, 2) end
        when v_item.unit_cost is null then null
        else round(v_quantity * v_item.unit_cost, 2)
      end,$new$);
  if v_new = v_def then
    raise exception '0324 could not preserve explicit unknown delivery cost';
  end if;
  v_def := v_new;
  v_new := replace(v_def,
$old$  v_unit text;
  v_par numeric;
  v_saved integer := 0;$old$,
$new$  v_unit text;
  v_par numeric;
  v_property_timezone text;
  v_custom_category_id uuid;
  v_set_aside numeric;
  v_saved integer := 0;$new$);
  if v_new = v_def then
    raise exception '0324 could not add delivery-created item field parsing';
  end if;
  v_def := v_new;
  v_new := replace(v_def,
$old$      if v_name = '' or v_unit = '' or v_category not in ('housekeeping','maintenance','breakfast') or v_par < 0 then
        raise exception 'invalid new inventory item in delivery';
      end if;$old$,
$new$      v_custom_category_id := nullif(r.value->>'custom_category_id', '')::uuid;
      v_set_aside := case
        when r.value ? 'set_aside' and r.value->'set_aside' <> 'null'::jsonb
          then public.staxis_parse_finite_numeric(r.value->>'set_aside', 'set aside')
        else 0
      end;
      if v_name = '' or v_unit = '' or v_category not in ('housekeeping','maintenance','breakfast')
         or v_par < 0 or v_set_aside < 0 or trunc(v_set_aside) <> v_set_aside
         or v_set_aside > v_quantity
      then
        raise exception 'invalid new inventory item in delivery';
      end if;
      if v_custom_category_id is not null and not exists (
        select 1 from public.inventory_custom_categories c
        where c.id = v_custom_category_id and c.property_id = p_property_id
      ) then
        raise exception 'custom inventory category does not belong to this property'
          using errcode = '23503';
      end if;$new$);
  if v_new = v_def then
    raise exception '0324 could not validate delivery-created item fields';
  end if;
  v_def := v_new;
  v_new := replace(v_def,
$old$        unit_cost, vendor_name, last_ordered_at, last_counted_at,
        delivery_cache_active
      ) values (
        p_property_id, v_name, v_category, v_quantity, v_par, v_unit,
        v_unit_cost, nullif(trim(p_vendor_name), ''), coalesce(p_received_at, now()), coalesce(p_received_at, now()),
        true$old$,
$new$        unit_cost, vendor_name, last_ordered_at, last_counted_at,
        delivery_cache_active, custom_category_id, set_aside
      ) values (
        p_property_id, v_name, v_category, v_quantity, v_par, v_unit,
        v_unit_cost, nullif(trim(p_vendor_name), ''), coalesce(p_received_at, now()), coalesce(p_received_at, now()),
        true, v_custom_category_id, v_set_aside$new$);
  if v_new = v_def then
    raise exception '0324 could not persist delivery-created item fields';
  end if;
  execute v_new;

  select pg_get_functiondef(
    'public.staxis_receive_po_lines_v2(uuid,uuid,jsonb)'::regprocedure
  ) into v_def;
  v_new := replace(v_def,
$old$  if jsonb_typeof(p_lines) <> 'array' then raise exception 'PO receive lines must be an array'; end if;

  select * into v_po$old$,
$new$  if jsonb_typeof(p_lines) <> 'array' then raise exception 'PO receive lines must be an array'; end if;

  perform 1 from public.properties p where p.id = p_property_id for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;

  select * into v_po$new$);
  if v_new = v_def then
    raise exception '0324 could not establish PO receive property-first locking';
  end if;
  execute v_new;
end
$$;

-- Financial month boundaries must come from a real stored IANA timezone. A
-- blank/misspelled value is a configuration error, never America/Chicago.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.staxis_start_inventory_month_close(uuid,date,uuid,uuid,text)'::regprocedure
  ) into v_def;
  v_new := replace(v_def,
$old$  select coalesce(nullif(trim(p.timezone), ''), 'America/Chicago')
    into v_timezone
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;$old$,
$new$  select nullif(trim(p.timezone), '')
    into v_timezone
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;
  if v_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names t where t.name = v_timezone
  ) then
    raise exception 'property timezone is missing or invalid; set a valid IANA timezone before month close'
      using errcode = '22023';
  end if;$new$);
  if v_new = v_def then
    raise exception '0324 could not install the month-start timezone guard';
  end if;
  execute v_new;
end
$$;

-- The same durable request-id ledger now owns losses and delivery corrections.
alter table public.inventory_write_receipts
  drop constraint if exists inventory_write_receipts_operation_check,
  add constraint inventory_write_receipts_operation_check
    check (operation in ('count', 'delivery', 'loss', 'delivery_correction'));

-- Retry receipts contain the exact caller payload, including delivery and
-- correction costs. They are an internal idempotency ledger; the application
-- never reads them directly, and SECURITY DEFINER write RPCs can replay safely
-- without exposing payloads through PostgREST or Realtime.
revoke select on public.inventory_write_receipts from authenticated, anon;

-- Mirrors the server capability rule: financial inventory evidence is manager
-- floor (owner/GM), can be denied per hotel, and is always available to the
-- internal admin/service role. Keeping this in Postgres prevents a caller from
-- bypassing a hidden UI column with a direct REST query.
create or replace function public.staxis_user_can_view_inventory_financials(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or exists (
      select 1
      from public.accounts a
      where a.data_user_id = auth.uid()
        and (
          a.role = 'admin'
          or (
            a.role in ('owner', 'general_manager')
            and p_property_id = any(a.property_access)
            and not exists (
              select 1
              from public.capability_overrides o
              where o.property_id = p_property_id
                and o.capability = 'view_financials'
                and o.role = a.role
                and o.allowed = false
            )
          )
        )
    );
$$;

revoke all on function public.staxis_user_can_view_inventory_financials(uuid) from public, anon;
grant execute on function public.staxis_user_can_view_inventory_financials(uuid)
  to authenticated, service_role;

-- Operational staff may receive quantities without seeing or asserting money.
-- Their caller must send an explicit JSON null cost, which the receipt ledger
-- preserves as unresolved for later manager review. Missing keys retain the
-- legacy manager-only catalog-cost fallback.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.staxis_receive_inventory_delivery(uuid,uuid,timestamptz,text,text,jsonb)'::regprocedure
  ) into v_def;
  v_new := replace(v_def,
$old$  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'delivery lines must be a non-empty array';
  end if;

  v_payload := jsonb_build_object($old$,
$new$  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'delivery lines must be a non-empty array';
  end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.staxis_user_can_view_inventory_financials(p_property_id)
     and exists (
       select 1 from jsonb_array_elements(p_lines) line
       where not (line ? 'unit_cost') or line->'unit_cost' <> 'null'::jsonb
     )
  then
    raise exception 'not authorized to set inventory delivery cost; send unit_cost null for manager review'
      using errcode = '42501';
  end if;

  v_payload := jsonb_build_object($new$);
  if v_new = v_def then
    raise exception '0324 could not enforce nonfinancial delivery cost input';
  end if;
  execute v_new;
end
$$;

-- ─── Atomic missing / damaged / lost stock ───────────────────────────────

alter table public.inventory_discards
  drop constraint if exists inventory_discards_reason_check,
  add constraint inventory_discards_reason_check
    check (reason in ('missing','stained','damaged','lost','theft','other')),
  add column if not exists request_id uuid,
  add column if not exists expected_stock numeric,
  add column if not exists stock_before numeric,
  add column if not exists stock_after numeric,
  add column if not exists recorded_by_user_id uuid;

alter table public.inventory_discards
  drop constraint if exists inventory_discards_recorded_by_user_id_fkey,
  add constraint inventory_discards_recorded_by_user_id_fkey
    foreign key (recorded_by_user_id) references auth.users(id) on delete set null;

create unique index if not exists inventory_discards_property_request_uq
  on public.inventory_discards(property_id, request_id)
  where request_id is not null;

comment on column public.inventory_discards.request_id is
  'Caller UUID for retry-safe atomic stock-loss recording. NULL only on legacy rows.';
comment on column public.inventory_discards.stock_before is
  'Locked on-hand quantity immediately before this loss was applied.';
comment on column public.inventory_discards.stock_after is
  'On-hand quantity immediately after this loss was applied.';

-- Direct inserts used to create a discard row without changing current_stock.
-- Route every new loss through the atomic RPC instead.
drop policy if exists "owner insert inventory_discards" on public.inventory_discards;
revoke insert, update, delete on public.inventory_discards from authenticated, anon;

create or replace function public.staxis_record_inventory_loss(
  p_property_id uuid,
  p_request_id uuid,
  p_recorded_at timestamptz,
  p_recorded_by text,
  p_item_id uuid,
  p_expected_stock numeric,
  p_quantity numeric,
  p_reason text,
  p_notes text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed uuid;
  v_receipt public.inventory_write_receipts%rowtype;
  v_payload jsonb;
  v_result jsonb;
  v_item public.inventory%rowtype;
  v_loss_id uuid;
  v_after numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    auth.uid() is null
    or not public.user_owns_property(p_property_id)
    or not public.mfa_verified_or_grace()
    or exists (
      select 1
      from public.accounts a
      join public.capability_overrides o
        on o.property_id = p_property_id
       and o.capability = 'manage_inventory_orders'
       and o.role = a.role
       and o.allowed = false
      where a.data_user_id = auth.uid() and a.role <> 'admin'
    )
  ) then
    raise exception 'not authorized to record inventory loss for this property'
      using errcode = '42501';
  end if;
  if p_request_id is null then raise exception 'request id is required' using errcode = '22023'; end if;
  if p_item_id is null then raise exception 'inventory item id is required' using errcode = '22023'; end if;
  if p_recorded_at is not null and p_recorded_at > now() + interval '5 minutes' then
    raise exception 'recorded_at cannot be in the future' using errcode = '22023';
  end if;
  if p_reason not in ('missing','stained','damaged','lost','theft','other') then
    raise exception 'invalid inventory loss reason' using errcode = '22023';
  end if;
  p_expected_stock := public.staxis_parse_finite_numeric(
    p_expected_stock::text, 'expected stock'
  );
  p_quantity := public.staxis_parse_finite_numeric(
    p_quantity::text, 'loss quantity'
  );
  if p_expected_stock is null or p_expected_stock < 0 then
    raise exception 'expected stock must be nonnegative' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 or trunc(p_quantity) <> p_quantity then
    raise exception 'loss quantity must be a positive whole number' using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'recorded_at', p_recorded_at,
    'recorded_by', nullif(trim(p_recorded_by), ''),
    'item_id', p_item_id,
    'expected_stock', p_expected_stock,
    'quantity', p_quantity,
    'reason', p_reason,
    'notes', nullif(trim(p_notes), '')
  );
  insert into public.inventory_write_receipts(property_id, request_id, operation, payload)
  values (p_property_id, p_request_id, 'loss', v_payload)
  on conflict do nothing
  returning request_id into v_claimed;
  if v_claimed is null then
    select * into v_receipt
    from public.inventory_write_receipts
    where property_id = p_property_id and request_id = p_request_id;
    if v_receipt.operation is distinct from 'loss' or v_receipt.payload is distinct from v_payload then
      raise exception 'inventory request id was already used for a different operation or payload'
        using errcode = '22023';
    end if;
    return coalesce(v_receipt.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
  end if;

  -- Serialize stock movements and month-close transitions for this hotel.
  perform 1 from public.properties p where p.id = p_property_id for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;

  select * into v_item
  from public.inventory i
  where i.id = p_item_id
    and i.property_id = p_property_id
    and i.archived_at is null
  for update;
  if not found then
    raise exception 'active inventory item % not found for property', p_item_id using errcode = 'P0002';
  end if;
  if v_item.current_stock is distinct from p_expected_stock then
    raise exception 'inventory item changed after this loss form was opened; refresh and try again'
      using errcode = '40001';
  end if;
  if p_quantity > v_item.current_stock then
    raise exception 'loss quantity cannot exceed current stock; count the item first'
      using errcode = '22023';
  end if;
  v_after := v_item.current_stock - p_quantity;
  if v_after < coalesce(v_item.set_aside, 0) then
    raise exception 'loss would leave on-hand below set-aside stock; reduce set aside first'
      using errcode = '22023';
  end if;

  insert into public.inventory_discards (
    property_id, item_id, item_name, quantity, reason,
    cost_value, unit_cost, discarded_at, discarded_by, notes,
    request_id, expected_stock, stock_before, stock_after, recorded_by_user_id
  ) values (
    p_property_id, v_item.id, v_item.name, p_quantity::integer, p_reason,
    case when v_item.unit_cost is null then null else p_quantity * v_item.unit_cost end,
    v_item.unit_cost, coalesce(p_recorded_at, now()), nullif(trim(p_recorded_by), ''),
    nullif(trim(p_notes), ''), p_request_id, p_expected_stock,
    v_item.current_stock, v_after, auth.uid()
  ) returning id into v_loss_id;

  update public.inventory
  set current_stock = v_after
  where id = v_item.id and property_id = p_property_id;

  v_result := jsonb_build_object(
    'replayed', false,
    'lossId', v_loss_id,
    'itemId', v_item.id,
    'stockBefore', v_item.current_stock,
    'stockAfter', v_after
  );
  update public.inventory_write_receipts
  set result = v_result
  where property_id = p_property_id and request_id = p_request_id;
  return v_result;
end
$$;

revoke all on function public.staxis_record_inventory_loss(
  uuid, uuid, timestamptz, text, uuid, numeric, numeric, text, text
) from public, anon;
grant execute on function public.staxis_record_inventory_loss(
  uuid, uuid, timestamptz, text, uuid, numeric, numeric, text, text
) to authenticated, service_role;

-- ─── Append-only delivery correction / void evidence ─────────────────────

alter table public.inventory_orders
  add column if not exists entry_kind text not null default 'receipt',
  add column if not exists corrects_order_id uuid,
  add column if not exists correction_event_id uuid;

alter table public.inventory_orders
  drop constraint if exists inventory_orders_entry_kind_check,
  add constraint inventory_orders_entry_kind_check
    check (entry_kind in ('receipt','correction')),
  drop constraint if exists inventory_orders_quantity_check,
  add constraint inventory_orders_quantity_check check (
    (entry_kind = 'receipt' and quantity >= 0)
    or entry_kind = 'correction'
  ),
  drop constraint if exists inventory_orders_corrects_order_property_fkey,
  add constraint inventory_orders_corrects_order_property_fkey
    foreign key (corrects_order_id, property_id)
    references public.inventory_orders(id, property_id)
    on delete no action deferrable initially deferred;

create index if not exists inventory_orders_corrects_order_idx
  on public.inventory_orders(property_id, corrects_order_id, created_at)
  where corrects_order_id is not null;

-- @rls: authenticated hotel users may read the audit; only the correction RPC writes it.
create table public.inventory_delivery_corrections (
  id                    uuid primary key default gen_random_uuid(),
  property_id           uuid not null references public.properties(id) on delete cascade,
  request_id            uuid not null,
  line_key              text not null,
  original_order_id     uuid not null,
  prior_correction_id   uuid,
  correction_kind       text not null check (correction_kind in ('correction','void')),
  reason                text not null check (length(trim(reason)) between 1 and 1000),
  corrected_at          timestamptz not null,
  corrected_by          text,
  corrected_by_user_id  uuid references auth.users(id) on delete set null,
  previous_item_id      uuid not null,
  previous_item_name    text not null,
  previous_quantity     numeric not null check (previous_quantity >= 0),
  previous_unit_cost    numeric,
  previous_total_cost   numeric,
  corrected_item_id     uuid,
  corrected_item_name   text,
  corrected_quantity    numeric not null check (corrected_quantity >= 0),
  corrected_unit_cost   numeric,
  corrected_total_cost  numeric,
  stock_effect          jsonb not null default '[]'::jsonb,
  activity_sequence     bigint not null default nextval('public.inventory_activity_sequence'),
  created_at            timestamptz not null default now(),
  unique (id, property_id),
  unique (property_id, request_id, line_key),
  foreign key (original_order_id, property_id)
    references public.inventory_orders(id, property_id) on delete no action deferrable initially deferred,
  foreign key (prior_correction_id, property_id)
    references public.inventory_delivery_corrections(id, property_id) on delete no action deferrable initially deferred,
  foreign key (previous_item_id, property_id)
    references public.inventory(id, property_id) on delete no action deferrable initially deferred,
  foreign key (corrected_item_id, property_id)
    references public.inventory(id, property_id) on delete no action deferrable initially deferred,
  check (
    (corrected_quantity = 0 and corrected_item_id is null and corrected_item_name is null and corrected_total_cost is null)
    or
    (corrected_quantity > 0 and corrected_item_id is not null and corrected_item_name is not null)
  )
);

alter table public.inventory_orders
  drop constraint if exists inventory_orders_correction_event_property_fkey,
  add constraint inventory_orders_correction_event_property_fkey
    foreign key (correction_event_id, property_id)
    references public.inventory_delivery_corrections(id, property_id)
    on delete no action deferrable initially deferred,
  add constraint inventory_orders_correction_shape_check check (
    (entry_kind = 'receipt' and corrects_order_id is null and correction_event_id is null)
    or
    (entry_kind = 'correction' and corrects_order_id is not null and correction_event_id is not null)
  ) not valid;

create index inventory_delivery_corrections_order_idx
  on public.inventory_delivery_corrections(property_id, original_order_id, created_at desc);
create unique index inventory_delivery_corrections_prior_uq
  on public.inventory_delivery_corrections(property_id, prior_correction_id)
  where prior_correction_id is not null;

alter table public.inventory_delivery_corrections enable row level security;
create policy "owner read inventory_delivery_corrections"
  on public.inventory_delivery_corrections for select to authenticated
  using (
    public.user_owns_property(property_id)
    and public.mfa_verified_or_grace()
    and public.staxis_user_can_view_inventory_financials(property_id)
  );
revoke all on public.inventory_delivery_corrections from anon;
revoke select, insert, update, delete on public.inventory_delivery_corrections from authenticated;
grant select on public.inventory_delivery_corrections to service_role;

comment on table public.inventory_delivery_corrections is
  'Immutable before/after evidence for delivery corrections. Stock and purchase-ledger compensation is committed atomically by staxis_correct_inventory_delivery.';
comment on column public.inventory_orders.entry_kind is
  'receipt = original saved delivery; correction = compensating append-only row linked to immutable correction evidence.';

-- A numbered invoice remains deduplicated while any receipt line is live. If
-- every line has been immutably voided, the same invoice number may be entered
-- again and this row preserves the replacement link instead of weakening the
-- duplicate guarantee globally.
-- @rls: service-role-only — immutable audited numbered-invoice replacement links are written/read only by the delivery RPC/service role.
create table public.inventory_delivery_reentries (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references public.properties(id) on delete cascade,
  delivery_key           text not null,
  prior_request_id       uuid,
  replacement_request_id uuid not null,
  reentered_by_user_id   uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  unique (property_id, delivery_key, replacement_request_id),
  foreign key (property_id, delivery_key)
    references public.inventory_delivery_keys(property_id, delivery_key)
    on delete no action,
  foreign key (property_id, replacement_request_id)
    references public.inventory_write_receipts(property_id, request_id)
    on delete no action deferrable initially deferred
);

alter table public.inventory_delivery_reentries enable row level security;
create policy "inventory delivery reentries deny browser"
  on public.inventory_delivery_reentries for all to anon, authenticated
  using (false) with check (false);
revoke all on public.inventory_delivery_reentries from public, anon, authenticated;
grant select, insert on public.inventory_delivery_reentries to service_role;

comment on table public.inventory_delivery_reentries is
  'Immutable link proving a numbered invoice was re-entered only after every prior receipt line for that invoice was voided.';

do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.staxis_receive_inventory_delivery(uuid,uuid,timestamptz,text,text,jsonb)'::regprocedure
  ) into v_def;
  v_new := replace(v_def,
$old$  v_key_claimed text;
  v_item public.inventory%rowtype;$old$,
$new$  v_key_claimed text;
  v_previous_delivery_request_id uuid;
  v_item public.inventory%rowtype;$new$);
  if v_new = v_def then
    raise exception '0324 could not add audited invoice re-entry state';
  end if;
  v_def := v_new;
  v_new := replace(v_def,
$old$    if v_key_claimed is null then
      raise exception 'this numbered invoice was already received for the property'
        using errcode = '23505';
    end if;$old$,
$new$    if v_key_claimed is null then
      select k.request_id into v_previous_delivery_request_id
      from public.inventory_delivery_keys k
      where k.property_id = p_property_id and k.delivery_key = v_delivery_key
      for update;

      if not exists (
        select 1 from public.inventory_orders root
        where root.property_id = p_property_id
          and root.entry_kind = 'receipt'
          and lower(trim(coalesce(root.notes, ''))) = v_delivery_key
      ) or exists (
        select 1 from public.inventory_orders root
        where root.property_id = p_property_id
          and root.entry_kind = 'receipt'
          and lower(trim(coalesce(root.notes, ''))) = v_delivery_key
          and not exists (
            select 1 from public.inventory_delivery_corrections tip
            where tip.property_id = p_property_id
              and tip.original_order_id = root.id
              and tip.correction_kind = 'void'
              and not exists (
                select 1 from public.inventory_delivery_corrections child
                where child.property_id = tip.property_id
                  and child.prior_correction_id = tip.id
              )
          )
      ) then
        raise exception 'this numbered invoice was already received for the property'
          using errcode = '23505';
      end if;

      insert into public.inventory_delivery_reentries(
        property_id, delivery_key, prior_request_id,
        replacement_request_id, reentered_by_user_id
      ) values (
        p_property_id, v_delivery_key, v_previous_delivery_request_id,
        p_request_id, auth.uid()
      );
      update public.inventory_delivery_keys
      set request_id = p_request_id
      where property_id = p_property_id and delivery_key = v_delivery_key;
    end if;$new$);
  if v_new = v_def then
    raise exception '0324 could not install audited voided-invoice re-entry';
  end if;
  execute v_new;
end
$$;

-- One JSON value avoids PostgREST's 1,000-row response cap. Nonfinancial
-- callers receive the operational audit with every cost field removed; a
-- request for costs is rejected in Postgres, not merely hidden by the client.
create or replace function public.staxis_list_inventory_delivery_corrections(
  p_property_id uuid,
  p_root_order_ids uuid[],
  p_include_financials boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    auth.uid() is null
    or not public.user_owns_property(p_property_id)
    or not public.mfa_verified_or_grace()
  ) then
    raise exception 'not authorized to read inventory delivery corrections for this property'
      using errcode = '42501';
  end if;
  if coalesce(p_include_financials, false)
     and not public.staxis_user_can_view_inventory_financials(p_property_id)
  then
    raise exception 'not authorized to view inventory delivery costs for this property'
      using errcode = '42501';
  end if;
  if coalesce(cardinality(p_root_order_ids), 0) > 500 then
    raise exception 'at most 500 delivery roots may be requested' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
    case when coalesce(p_include_financials, false) then to_jsonb(c)
      else to_jsonb(c) - array[
        'previous_unit_cost','previous_total_cost',
        'corrected_unit_cost','corrected_total_cost'
      ]::text[]
    end
    order by c.created_at, c.id
  ), '[]'::jsonb)
  into v_result
  from public.inventory_delivery_corrections c
  where c.property_id = p_property_id
    and c.original_order_id = any(coalesce(p_root_order_ids, '{}'::uuid[]));
  return v_result;
end
$$;

revoke all on function public.staxis_list_inventory_delivery_corrections(uuid,uuid[],boolean)
  from public, anon;
grant execute on function public.staxis_list_inventory_delivery_corrections(uuid,uuid[],boolean)
  to authenticated, service_role;

-- inventory.unit_cost/vendor_name/last_ordered_at are live caches populated by
-- delivery receipt. If the latest receipt is corrected, recompute them from
-- the latest still-effective root. An older correction never overwrites a
-- genuinely newer delivery.
create or replace function public.staxis_refresh_inventory_delivery_metadata(
  p_property_id uuid,
  p_item_id uuid,
  p_changed_root_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed_activity_sequence bigint;
  v_has_newer boolean;
  v_latest record;
  v_latest_found boolean;
  v_latest_known_unit_cost numeric;
begin
  select o.activity_sequence into v_changed_activity_sequence
  from public.inventory_orders o
  where o.id = p_changed_root_id
    and o.property_id = p_property_id
    and o.entry_kind = 'receipt';
  if not found then return; end if;

  with effective as (
    select
      root.id,
      root.activity_sequence,
      case when tip.id is null then root.item_id else tip.corrected_item_id end as item_id,
      case when tip.id is null then root.quantity else tip.corrected_quantity end as quantity
    from public.inventory_orders root
    left join lateral (
      select c.*
      from public.inventory_delivery_corrections c
      where c.property_id = root.property_id
        and c.original_order_id = root.id
        and not exists (
          select 1 from public.inventory_delivery_corrections child
          where child.property_id = c.property_id and child.prior_correction_id = c.id
        )
      limit 1
    ) tip on true
    where root.property_id = p_property_id and root.entry_kind = 'receipt'
  )
  select exists (
    select 1 from effective e
    where e.item_id = p_item_id and e.quantity > 0
      and e.activity_sequence > v_changed_activity_sequence
  ) into v_has_newer;
  if v_has_newer then return; end if;

  select
    root.id as root_id,
    root.received_at,
    root.vendor_name,
    case when tip.id is null then coalesce(
      root.unit_cost,
      case when root.quantity > 0 and root.total_cost is not null
        then root.total_cost / root.quantity else null end
    ) else tip.corrected_unit_cost end as unit_cost
  into v_latest
  from public.inventory_orders root
  left join lateral (
    select c.*
    from public.inventory_delivery_corrections c
    where c.property_id = root.property_id
      and c.original_order_id = root.id
      and not exists (
        select 1 from public.inventory_delivery_corrections child
        where child.property_id = c.property_id and child.prior_correction_id = c.id
      )
    limit 1
  ) tip on true
  where root.property_id = p_property_id
    and root.entry_kind = 'receipt'
    and (case when tip.id is null then root.item_id else tip.corrected_item_id end) = p_item_id
    and (case when tip.id is null then root.quantity else tip.corrected_quantity end) > 0
  order by root.activity_sequence desc
  limit 1;

  v_latest_found := found;
  if v_latest_found then
    select case when tip.id is null then coalesce(
      root.unit_cost,
      case when root.quantity > 0 and root.total_cost is not null
        then root.total_cost / root.quantity else null end
    ) else tip.corrected_unit_cost end
    into v_latest_known_unit_cost
    from public.inventory_orders root
    left join lateral (
      select c.*
      from public.inventory_delivery_corrections c
      where c.property_id = root.property_id
        and c.original_order_id = root.id
        and not exists (
          select 1 from public.inventory_delivery_corrections child
          where child.property_id = c.property_id and child.prior_correction_id = c.id
        )
      limit 1
    ) tip on true
    where root.property_id = p_property_id
      and root.entry_kind = 'receipt'
      and (case when tip.id is null then root.item_id else tip.corrected_item_id end) = p_item_id
      and (case when tip.id is null then root.quantity else tip.corrected_quantity end) > 0
      and (case when tip.id is null then coalesce(
        root.unit_cost,
        case when root.quantity > 0 and root.total_cost is not null
          then root.total_cost / root.quantity else null end
      ) else tip.corrected_unit_cost end) is not null
    order by root.activity_sequence desc
    limit 1;

    update public.inventory
    set delivery_baseline_unit_cost = case
          when delivery_cache_active then delivery_baseline_unit_cost else unit_cost end,
        delivery_baseline_vendor_name = case
          when delivery_cache_active then delivery_baseline_vendor_name else vendor_name end,
        delivery_baseline_last_ordered_at = case
          when delivery_cache_active then delivery_baseline_last_ordered_at else last_ordered_at end,
        delivery_cache_active = true,
        -- An explicitly unknown invoice cost is truthful ledger evidence, but
        -- it must not erase the hotel's saved planning estimate. Prefer the
        -- newest still-effective known receipt cost, then the pre-delivery
        -- master value captured by the provenance trigger.
        unit_cost = coalesce(
          v_latest_known_unit_cost,
          case when delivery_cache_active then delivery_baseline_unit_cost else unit_cost end
        ),
        vendor_name = v_latest.vendor_name,
        last_ordered_at = v_latest.received_at
    where id = p_item_id and property_id = p_property_id and archived_at is null;
  else
    update public.inventory
    set unit_cost = delivery_baseline_unit_cost,
        vendor_name = delivery_baseline_vendor_name,
        last_ordered_at = delivery_baseline_last_ordered_at,
        delivery_cache_active = false,
        delivery_baseline_unit_cost = null,
        delivery_baseline_vendor_name = null,
        delivery_baseline_last_ordered_at = null
    where id = p_item_id
      and property_id = p_property_id
      and archived_at is null
      and delivery_cache_active;
  end if;
end
$$;

revoke all on function public.staxis_refresh_inventory_delivery_metadata(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.staxis_correct_inventory_delivery(
  p_property_id uuid,
  p_request_id uuid,
  p_corrected_at timestamptz,
  p_corrected_by text,
  p_reason text,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  v_claimed uuid;
  v_receipt public.inventory_write_receipts%rowtype;
  v_payload jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_seen_keys text[] := '{}';
  v_seen_orders uuid[] := '{}';
  v_line_key text;
  v_order_id uuid;
  v_root public.inventory_orders%rowtype;
  v_prior public.inventory_delivery_corrections%rowtype;
  v_previous_item public.inventory%rowtype;
  v_corrected_item public.inventory%rowtype;
  v_expected_item_id uuid;
  v_expected_quantity numeric;
  v_expected_unit_cost numeric;
  v_corrected_item_id uuid;
  v_corrected_quantity numeric;
  v_corrected_unit_cost numeric;
  v_previous_total numeric;
  v_corrected_total numeric;
  v_stock_delta numeric;
  v_stock_effect jsonb;
  v_correction_id uuid;
  v_kind text;
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    auth.uid() is null
    or not public.user_owns_property(p_property_id)
    or not public.mfa_verified_or_grace()
    or not public.staxis_user_can_view_inventory_financials(p_property_id)
    or exists (
      select 1
      from public.accounts a
      join public.capability_overrides o
        on o.property_id = p_property_id
       and o.capability = 'manage_inventory_orders'
       and o.role = a.role
       and o.allowed = false
      where a.data_user_id = auth.uid() and a.role <> 'admin'
    )
  ) then
    raise exception 'not authorized to correct inventory deliveries for this property'
      using errcode = '42501';
  end if;
  if p_request_id is null then raise exception 'request id is required' using errcode = '22023'; end if;
  if p_corrected_at is not null and p_corrected_at > now() + interval '5 minutes' then
    raise exception 'corrected_at cannot be in the future' using errcode = '22023';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'a correction reason is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'delivery correction lines must be a non-empty array' using errcode = '22023';
  end if;

  v_payload := jsonb_build_object(
    'corrected_at', p_corrected_at,
    'corrected_by', nullif(trim(p_corrected_by), ''),
    'reason', trim(p_reason),
    'lines', p_lines
  );
  insert into public.inventory_write_receipts(property_id, request_id, operation, payload)
  values (p_property_id, p_request_id, 'delivery_correction', v_payload)
  on conflict do nothing
  returning request_id into v_claimed;
  if v_claimed is null then
    select * into v_receipt
    from public.inventory_write_receipts
    where property_id = p_property_id and request_id = p_request_id;
    if v_receipt.operation is distinct from 'delivery_correction'
       or v_receipt.payload is distinct from v_payload
    then
      raise exception 'inventory request id was already used for a different operation or payload'
        using errcode = '22023';
    end if;
    return coalesce(v_receipt.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
  end if;

  -- One property lock makes multi-line stock effects deterministic and keeps
  -- the request ordered against month close and every activity guard.
  perform 1 from public.properties p where p.id = p_property_id for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;

  for r in select value from jsonb_array_elements(p_lines)
  loop
    v_prior := null;
    v_previous_item := null;
    v_corrected_item := null;
    v_line_key := trim(coalesce(r.value->>'line_key', ''));
    if v_line_key = '' or v_line_key = any(v_seen_keys) then
      raise exception 'delivery correction line keys must be non-empty and unique' using errcode = '22023';
    end if;
    v_seen_keys := array_append(v_seen_keys, v_line_key);

    v_order_id := nullif(r.value->>'order_id', '')::uuid;
    if v_order_id is null or v_order_id = any(v_seen_orders) then
      raise exception 'delivery correction order ids must be non-empty and unique' using errcode = '22023';
    end if;
    v_seen_orders := array_append(v_seen_orders, v_order_id);

    select * into v_root
    from public.inventory_orders o
    where o.id = v_order_id
      and o.property_id = p_property_id
      and o.entry_kind = 'receipt'
    for update;
    if not found then
      raise exception 'original delivery line % not found for property', v_order_id using errcode = 'P0002';
    end if;

    select * into v_prior
    from public.inventory_delivery_corrections c
    where c.property_id = p_property_id
      and c.original_order_id = v_order_id
      and not exists (
        select 1 from public.inventory_delivery_corrections child
        where child.property_id = p_property_id
          and child.prior_correction_id = c.id
      )
    limit 1;

    if found then
      if v_prior.correction_kind = 'void' then
        raise exception 'this delivery line is already voided; add a new delivery instead'
          using errcode = '23514';
      end if;
      v_expected_item_id := v_prior.corrected_item_id;
      v_expected_quantity := v_prior.corrected_quantity;
      v_expected_unit_cost := v_prior.corrected_unit_cost;
      v_previous_total := v_prior.corrected_total_cost;
      if v_expected_item_id is not null then
        select * into v_previous_item
        from public.inventory i
        where i.id = v_expected_item_id and i.property_id = p_property_id
        for update;
      end if;
    else
      v_expected_item_id := v_root.item_id;
      v_expected_quantity := v_root.quantity;
      v_expected_unit_cost := coalesce(
        v_root.unit_cost,
        case when v_root.quantity > 0 and v_root.total_cost is not null
          then v_root.total_cost / v_root.quantity else null end
      );
      v_previous_total := coalesce(
        v_root.total_cost,
        case when v_root.unit_cost is not null then v_root.quantity * v_root.unit_cost else null end
      );
      select * into v_previous_item
      from public.inventory i
      where i.id = v_root.item_id and i.property_id = p_property_id
      for update;
    end if;

    if (nullif(r.value->>'expected_item_id', '')::uuid is distinct from v_expected_item_id)
       or public.staxis_parse_finite_numeric(r.value->>'expected_quantity', 'expected effective quantity')
          is distinct from v_expected_quantity
       or (
         case when r.value ? 'expected_unit_cost' and r.value->'expected_unit_cost' <> 'null'::jsonb
           then public.staxis_parse_finite_numeric(r.value->>'expected_unit_cost', 'expected effective unit cost')
           else null end
       ) is distinct from v_expected_unit_cost
    then
      raise exception 'delivery changed after this correction was opened; refresh and try again'
        using errcode = '40001';
    end if;

    v_corrected_quantity := public.staxis_parse_finite_numeric(
      r.value->>'corrected_quantity', 'corrected quantity'
    );
    if v_corrected_quantity < 0 then
      raise exception 'corrected quantity must be nonnegative' using errcode = '22023';
    end if;
    v_corrected_item_id := nullif(r.value->>'corrected_item_id', '')::uuid;
    if v_corrected_quantity = 0 then
      if v_corrected_item_id is not null then
        raise exception 'a voided delivery must not name a corrected item' using errcode = '22023';
      end if;
      v_corrected_unit_cost := null;
      v_corrected_total := null;
      v_kind := 'void';
    else
      if v_corrected_item_id is null then
        raise exception 'a corrected delivery with stock needs an item' using errcode = '22023';
      end if;
      if r.value ? 'corrected_unit_cost' and r.value->'corrected_unit_cost' <> 'null'::jsonb then
        v_corrected_unit_cost := public.staxis_parse_finite_numeric(
          r.value->>'corrected_unit_cost', 'corrected unit cost'
        );
        if v_corrected_unit_cost < 0 then
          raise exception 'corrected unit cost must be nonnegative' using errcode = '22023';
        end if;
      else
        v_corrected_unit_cost := null;
      end if;
      v_corrected_total := case when v_corrected_unit_cost is null then null
        else round(v_corrected_quantity * v_corrected_unit_cost, 2) end;
      v_kind := 'correction';

      select * into v_corrected_item
      from public.inventory i
      where i.id = v_corrected_item_id
        and i.property_id = p_property_id
        -- Managers may still repair the invoice dollars/quantity attached to
        -- the same archived root. Never allow a correction to move stock into
        -- some other archived catalog item.
        and (i.archived_at is null or i.id = v_expected_item_id)
      for update;
      if not found then
        raise exception 'corrected inventory item % is not available for this property', v_corrected_item_id
          using errcode = 'P0002';
      end if;
    end if;

    if v_expected_item_id is not distinct from v_corrected_item_id
       and v_expected_quantity is not distinct from v_corrected_quantity
       and v_expected_unit_cost is not distinct from v_corrected_unit_cost
    then
      raise exception 'delivery correction does not change the saved delivery' using errcode = '22023';
    end if;

    v_stock_effect := '[]'::jsonb;
    if v_expected_item_id is not null and v_expected_item_id = v_corrected_item_id then
      v_stock_delta := v_corrected_quantity - v_expected_quantity;
      if v_stock_delta <> 0 and (
        v_previous_item.archived_at is null
        and not exists (
          select 1 from public.inventory_counts c
          where c.property_id = p_property_id
            and c.item_id = v_expected_item_id
            and (
              c.activity_sequence > v_root.activity_sequence
              or (
                v_expected_item_id is distinct from v_root.item_id
                and c.counted_at >= coalesce(v_root.received_at, v_root.created_at)
              )
            )
        )
      ) then
        if v_previous_item.current_stock + v_stock_delta < coalesce(v_previous_item.set_aside, 0) then
          raise exception 'delivery correction would leave on-hand below set-aside stock; reduce set aside first'
            using errcode = '22023';
        end if;
        update public.inventory
        set current_stock = current_stock + v_stock_delta
        where id = v_expected_item_id and property_id = p_property_id;
        v_stock_effect := v_stock_effect || jsonb_build_array(jsonb_build_object(
          'itemId', v_expected_item_id, 'delta', v_stock_delta, 'applied', true,
          'stockBefore', v_previous_item.current_stock,
          'stockAfter', v_previous_item.current_stock + v_stock_delta
        ));
      elsif v_stock_delta <> 0 then
        v_stock_effect := v_stock_effect || jsonb_build_array(jsonb_build_object(
          'itemId', v_expected_item_id, 'delta', v_stock_delta, 'applied', false,
          'reason', case when v_previous_item.archived_at is not null
            then 'archived_item_supersedes_receipt'
            else 'newer_count_supersedes_receipt' end
        ));
      end if;
    else
      if v_expected_item_id is not null and v_expected_quantity > 0 then
        if v_previous_item.archived_at is null
           and not exists (
             select 1 from public.inventory_counts c
             where c.property_id = p_property_id
               and c.item_id = v_expected_item_id
               and (
                 c.activity_sequence > v_root.activity_sequence
                 or (
                   v_expected_item_id is distinct from v_root.item_id
                   and c.counted_at >= coalesce(v_root.received_at, v_root.created_at)
                 )
               )
           )
        then
          if v_previous_item.current_stock - v_expected_quantity < coalesce(v_previous_item.set_aside, 0) then
            raise exception 'delivery correction would leave on-hand below set-aside stock; reduce set aside first'
              using errcode = '22023';
          end if;
          update public.inventory
          set current_stock = current_stock - v_expected_quantity
          where id = v_expected_item_id and property_id = p_property_id;
          v_stock_effect := v_stock_effect || jsonb_build_array(jsonb_build_object(
            'itemId', v_expected_item_id, 'delta', -v_expected_quantity, 'applied', true,
            'stockBefore', v_previous_item.current_stock,
            'stockAfter', v_previous_item.current_stock - v_expected_quantity
          ));
        else
          v_stock_effect := v_stock_effect || jsonb_build_array(jsonb_build_object(
            'itemId', v_expected_item_id, 'delta', -v_expected_quantity, 'applied', false,
            'reason', case when v_previous_item.archived_at is not null
              then 'archived_item_supersedes_receipt'
              else 'newer_count_supersedes_receipt' end
          ));
        end if;
      end if;
      if v_corrected_item_id is not null and v_corrected_quantity > 0 then
        if not exists (
          select 1 from public.inventory_counts c
          where c.property_id = p_property_id
            and c.item_id = v_corrected_item_id
            and (
              c.activity_sequence > v_root.activity_sequence
              or (
                v_corrected_item_id is distinct from v_root.item_id
                and c.counted_at >= coalesce(v_root.received_at, v_root.created_at)
              )
            )
        ) then
          update public.inventory
          set current_stock = current_stock + v_corrected_quantity,
              last_ordered_at = greatest(coalesce(last_ordered_at, v_root.received_at), v_root.received_at)
          where id = v_corrected_item_id and property_id = p_property_id;
          v_stock_effect := v_stock_effect || jsonb_build_array(jsonb_build_object(
            'itemId', v_corrected_item_id, 'delta', v_corrected_quantity, 'applied', true,
            'stockBefore', v_corrected_item.current_stock,
            'stockAfter', v_corrected_item.current_stock + v_corrected_quantity
          ));
        else
          v_stock_effect := v_stock_effect || jsonb_build_array(jsonb_build_object(
            'itemId', v_corrected_item_id, 'delta', v_corrected_quantity, 'applied', false,
            'reason', 'newer_count_supersedes_receipt'
          ));
        end if;
      end if;
    end if;

    insert into public.inventory_delivery_corrections (
      property_id, request_id, line_key, original_order_id, prior_correction_id,
      correction_kind, reason, corrected_at, corrected_by, corrected_by_user_id,
      previous_item_id, previous_item_name, previous_quantity,
      previous_unit_cost, previous_total_cost,
      corrected_item_id, corrected_item_name, corrected_quantity,
      corrected_unit_cost, corrected_total_cost, stock_effect
    ) values (
      p_property_id, p_request_id, v_line_key, v_root.id, v_prior.id,
      v_kind, trim(p_reason), coalesce(p_corrected_at, now()), nullif(trim(p_corrected_by), ''), auth.uid(),
      v_expected_item_id, coalesce(v_previous_item.name, v_root.item_name), v_expected_quantity,
      v_expected_unit_cost, v_previous_total,
      v_corrected_item_id, case when v_corrected_item_id is null then null else v_corrected_item.name end,
      v_corrected_quantity, v_corrected_unit_cost, v_corrected_total, v_stock_effect
    ) returning id into v_correction_id;

    -- Reverse the previously effective delivery state, then append its replacement.
    -- Both rows retain the original received_at, so an already-closed month rejects
    -- the whole transaction before any correction can rewrite frozen accounting.
    if v_expected_item_id is not null and v_expected_quantity > 0 then
      insert into public.inventory_orders (
        property_id, item_id, item_name, quantity, quantity_cases,
        unit_cost, total_cost, vendor_name, ordered_at, received_at, notes,
        entry_kind, corrects_order_id, correction_event_id
      ) values (
        p_property_id, v_expected_item_id, coalesce(v_previous_item.name, v_root.item_name),
        -v_expected_quantity, null, v_expected_unit_cost,
        case when v_previous_total is null then null else -v_previous_total end,
        v_root.vendor_name, v_root.ordered_at, v_root.received_at,
        'Delivery correction reversal · ' || trim(p_reason),
        'correction', v_root.id, v_correction_id
      );
    end if;
    if v_corrected_item_id is not null and v_corrected_quantity > 0 then
      insert into public.inventory_orders (
        property_id, item_id, item_name, quantity, quantity_cases,
        unit_cost, total_cost, vendor_name, ordered_at, received_at, notes,
        entry_kind, corrects_order_id, correction_event_id
      ) values (
        p_property_id, v_corrected_item_id, v_corrected_item.name,
        v_corrected_quantity, null, v_corrected_unit_cost, v_corrected_total,
        v_root.vendor_name, v_root.ordered_at, v_root.received_at,
        'Delivery correction replacement · ' || trim(p_reason),
        'correction', v_root.id, v_correction_id
      );
    end if;

    perform public.staxis_refresh_inventory_delivery_metadata(
      p_property_id, v_expected_item_id, v_root.id
    );
    if v_corrected_item_id is not null
       and v_corrected_item_id is distinct from v_expected_item_id
    then
      perform public.staxis_refresh_inventory_delivery_metadata(
        p_property_id, v_corrected_item_id, v_root.id
      );
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'orderId', v_root.id,
      'correctionId', v_correction_id,
      'kind', v_kind,
      'stockEffects', v_stock_effect
    ));
  end loop;

  v_result := jsonb_build_object('replayed', false, 'corrected', v_results);
  update public.inventory_write_receipts
  set result = v_result
  where property_id = p_property_id and request_id = p_request_id;
  return v_result;
end
$$;

revoke all on function public.staxis_correct_inventory_delivery(
  uuid, uuid, timestamptz, text, text, jsonb
) from public, anon;
grant execute on function public.staxis_correct_inventory_delivery(
  uuid, uuid, timestamptz, text, text, jsonb
) to authenticated, service_role;

-- A backdated stock write committed after the selected opening count must not
-- slip through merely because its business timestamp sorts earlier. Compare
-- every item against the selected count row's durable activity sequence. A
-- cost-only correction has no applied stock effect and therefore needs no
-- recount; missing/loss stock and a later count always do.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(
    'public.staxis_start_inventory_month_close(uuid,date,uuid,uuid,text)'::regprocedure
  ) into v_def;
  v_new := replace(v_def,
$old$  if exists (
    select 1 from public.inventory_orders o
    where o.property_id = p_property_id and o.received_at >= v_baseline_at
  ) or exists (
    select 1 from public.inventory_discards d
    where d.property_id = p_property_id and d.discarded_at >= v_baseline_at
  ) then
    raise exception 'inventory activity occurred after the complete opening count; count again'
      using errcode = '22023';
  end if;$old$,
$new$  if exists (
    select 1
    from public.inventory_counts bc
    join public.inventory i
      on i.id = bc.item_id
     and i.property_id = p_property_id
     and i.archived_at is null
    where bc.property_id = p_property_id
      and bc.count_session_id = v_count_session_id
      and (
        exists (
          select 1
          from public.inventory_orders o
          where o.property_id = p_property_id
            and o.item_id = bc.item_id
            and (
              o.received_at >= bc.counted_at
              or o.activity_sequence > bc.activity_sequence
            )
            and (
              o.entry_kind = 'receipt'
              or (
                o.entry_kind = 'correction'
                and exists (
                  select 1
                  from public.inventory_delivery_corrections correction,
                       jsonb_array_elements(correction.stock_effect) effect
                  where correction.id = o.correction_event_id
                    and correction.property_id = o.property_id
                    and effect->>'itemId' = bc.item_id::text
                    and coalesce((effect->>'applied')::boolean, false)
                )
              )
            )
        )
        or exists (
          select 1
          from public.inventory_discards d
          where d.property_id = p_property_id
            and d.item_id = bc.item_id
            and (
              d.discarded_at >= bc.counted_at
              or d.activity_sequence > bc.activity_sequence
            )
        )
        or exists (
          select 1
          from public.inventory_counts later_count
          where later_count.property_id = p_property_id
            and later_count.item_id = bc.item_id
            and later_count.activity_sequence > bc.activity_sequence
        )
      )
  ) then
    raise exception 'inventory activity occurred after the complete opening count; count again'
      using errcode = '22023';
  end if;$new$);
  if v_new = v_def then
    raise exception '0324 could not install durable opening-count activity checks';
  end if;
  execute v_new;
end
$$;

-- ─── Corrections remain valid inputs to month-close accounting ───────────

alter table public.inventory_month_close_purchases
  drop constraint if exists inventory_month_close_purchases_quantity_check,
  add constraint inventory_month_close_purchases_quantity_check check (quantity <> 0),
  drop constraint if exists inventory_month_close_purchases_value_cents_check,
  add constraint inventory_month_close_purchases_value_cents_check check (value_cents is not null);

-- Patch the large, audited 0322 close function in place. Exact-expression
-- replacements fail the migration if the reviewed 0322 body ever drifts,
-- preserving every untouched boundary and authorization invariant.
do $$
declare
  v_def text;
  v_old text;
begin
  select pg_get_functiondef(
    'public.staxis_close_inventory_month_close(uuid,date,uuid,text,bigint,uuid,text,text)'::regprocedure
  ) into v_def;

  v_old := v_def;
  v_def := replace(v_def,
$old$  select coalesce(nullif(trim(p.timezone), ''), 'America/Chicago')
    into v_timezone
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;$old$,
$new$  select nullif(trim(p.timezone), '')
    into v_timezone
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;
  if v_timezone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names t where t.name = v_timezone
  ) then
    raise exception 'property timezone is missing or invalid; set a valid IANA timezone before month close'
      using errcode = '22023';
  end if;$new$);
  if v_def = v_old then
    raise exception '0324 could not install the month-close timezone guard';
  end if;

  v_old := v_def;
  v_def := replace(v_def,
$old$    count(*)::integer,
    count(*) filter (
      where o.quantity <= 0
         or coalesce(o.total_cost, o.quantity * o.unit_cost) is null
         or coalesce(o.total_cost, o.quantity * o.unit_cost) < 0
    )::integer,
    coalesce(sum(
      case
        when o.quantity > 0 and coalesce(o.total_cost, o.quantity * o.unit_cost) >= 0
          then round(coalesce(o.total_cost, o.quantity * o.unit_cost) * 100)::bigint
        else 0
      end
    ), 0)::bigint$old$,
$new$    count(*) filter (where o.entry_kind = 'receipt')::integer,
    count(*) filter (
      where (o.entry_kind = 'receipt'
             and not exists (
               select 1
               from public.inventory_delivery_corrections c
               where c.property_id = o.property_id
                 and c.original_order_id = o.id
             )
             and (
               o.quantity <= 0
               or coalesce(o.total_cost, o.quantity * o.unit_cost) is null
               or coalesce(o.total_cost, o.quantity * o.unit_cost) < 0
             ))
         or (o.entry_kind = 'correction'
             and o.quantity > 0
             and o.total_cost is null
             and exists (
               select 1
               from public.inventory_delivery_corrections c
               where c.id = o.correction_event_id
                 and c.property_id = o.property_id
                 and not exists (
                   select 1
                   from public.inventory_delivery_corrections child
                   where child.property_id = c.property_id
                     and child.prior_correction_id = c.id
                 )
             ))
    )::integer,
    coalesce(sum(
      case
        when o.entry_kind = 'receipt'
             and o.quantity > 0
             and coalesce(o.total_cost, o.quantity * o.unit_cost) >= 0
          then round(coalesce(o.total_cost, o.quantity * o.unit_cost) * 100)::bigint
        when o.entry_kind = 'correction' and o.total_cost is not null
          then round(o.total_cost * 100)::bigint
        else 0
      end
    ), 0)::bigint$new$);
  if v_def = v_old then
    raise exception '0324 could not patch inventory close delivery validation';
  end if;

  v_old := v_def;
  v_def := replace(v_def,
$old$      and o.quantity > 0
      and coalesce(o.total_cost, o.quantity * o.unit_cost) >= 0
    group by o.item_id$old$,
$new$      and (
        (o.entry_kind = 'receipt' and o.quantity > 0
          and coalesce(o.total_cost, o.quantity * o.unit_cost) >= 0)
        or (o.entry_kind = 'correction' and o.total_cost is not null)
      )
    group by o.item_id$new$);
  if v_def = v_old then
    raise exception '0324 could not patch inventory close purchase aggregation';
  end if;

  v_old := v_def;
  v_def := replace(v_def,
$old$    where o.property_id = p_property_id
      and o.received_at >= v_close.activity_start_at
      and o.received_at < v_close.end_at;
  end if;$old$,
$new$    where o.property_id = p_property_id
      and o.received_at >= v_close.activity_start_at
      and o.received_at < v_close.end_at
      and (
        (o.entry_kind = 'receipt' and o.quantity > 0
          and coalesce(o.total_cost, o.quantity * o.unit_cost) >= 0)
        or (o.entry_kind = 'correction' and o.total_cost is not null)
      );
  end if;$new$);
  if v_def = v_old then
    raise exception '0324 could not patch inventory close frozen purchase rows';
  end if;

  v_old := v_def;
  v_def := replace(v_def,
$old$  select
    c.item_id, c.id as count_id, c.counted_stock, c.unit_cost, c.counted_at
  from public.inventory_counts c$old$,
$new$  select
    c.item_id, c.id as count_id, c.counted_stock, c.unit_cost, c.counted_at,
    c.activity_sequence as count_activity_sequence
  from public.inventory_counts c$new$);
  if v_def = v_old then
    raise exception '0324 could not attach durable count commit order';
  end if;

  v_old := v_def;
  v_def := replace(v_def,
$old$    where ec.counted_at < v_close.end_at
      and (
        exists (
          select 1 from public.inventory_orders o
          where o.property_id = p_property_id and o.item_id = ec.item_id
            and o.received_at >= ec.counted_at and o.received_at < v_close.end_at
        )
        or exists (
          select 1 from public.inventory_discards d
          where d.property_id = p_property_id and d.item_id = ec.item_id
            and d.discarded_at >= ec.counted_at and d.discarded_at < v_close.end_at
        )
      )$old$,
$new$    where ec.counted_at < v_close.end_at
      and (
        exists (
          select 1 from public.inventory_orders o
          where o.property_id = p_property_id and o.item_id = ec.item_id
            and (
              (
                o.received_at >= v_close.activity_start_at
                and o.received_at < v_close.end_at
                and o.received_at >= ec.counted_at
              )
              or (
                o.activity_sequence > ec.count_activity_sequence
                and o.received_at < v_close.end_at
              )
            )
            and (
              o.entry_kind = 'receipt'
              or (
                o.entry_kind = 'correction' and exists (
                  select 1
                  from public.inventory_delivery_corrections correction,
                       jsonb_array_elements(correction.stock_effect) effect
                  where correction.id = o.correction_event_id
                    and correction.property_id = o.property_id
                    and effect->>'itemId' = ec.item_id::text
                    and coalesce((effect->>'applied')::boolean, false)
                )
              )
            )
        )
        or exists (
          select 1 from public.inventory_discards d
          where d.property_id = p_property_id and d.item_id = ec.item_id
            and (
              (d.discarded_at >= v_close.activity_start_at
                and d.discarded_at < v_close.end_at
                and d.discarded_at >= ec.counted_at)
              or (
                d.activity_sequence > ec.count_activity_sequence
                and d.discarded_at < v_close.end_at
              )
            )
        )
        or exists (
          select 1 from public.inventory_counts later_count
          where later_count.property_id = p_property_id
            and later_count.item_id = ec.item_id
            and later_count.activity_sequence > ec.count_activity_sequence
            and later_count.counted_at < v_close.end_at
        )
      )$new$);
  if v_def = v_old then
    raise exception '0324 could not install durable post-count movement checks';
  end if;

  v_old := v_def;
  v_def := replace(v_def,
$old$    where ec.counted_at >= v_close.end_at
      and (
        exists (
          select 1 from public.inventory_orders o
          where o.property_id = p_property_id and o.item_id = ec.item_id
            and o.received_at >= v_close.end_at and o.received_at < ec.counted_at
        )
        or exists (
          select 1 from public.inventory_discards d
          where d.property_id = p_property_id and d.item_id = ec.item_id
            and d.discarded_at >= v_close.end_at and d.discarded_at < ec.counted_at
        )
      )$old$,
$new$    where ec.counted_at >= v_close.end_at
      and (
        exists (
          select 1 from public.inventory_orders o
          where o.property_id = p_property_id and o.item_id = ec.item_id
            and (
              (o.received_at >= v_close.end_at and o.received_at < ec.counted_at)
              or (
                o.activity_sequence > ec.count_activity_sequence
                and o.received_at <= ec.counted_at
              )
            )
            and (
              o.entry_kind = 'receipt'
              or (
                o.entry_kind = 'correction' and exists (
                  select 1
                  from public.inventory_delivery_corrections correction,
                       jsonb_array_elements(correction.stock_effect) effect
                  where correction.id = o.correction_event_id
                    and correction.property_id = o.property_id
                    and effect->>'itemId' = ec.item_id::text
                    and coalesce((effect->>'applied')::boolean, false)
                )
              )
            )
        )
        or exists (
          select 1 from public.inventory_discards d
          where d.property_id = p_property_id and d.item_id = ec.item_id
            and (
              (d.discarded_at >= v_close.end_at and d.discarded_at < ec.counted_at)
              or (
                d.activity_sequence > ec.count_activity_sequence
                and d.discarded_at <= ec.counted_at
              )
            )
        )
        or exists (
          select 1 from public.inventory_counts later_count
          where later_count.property_id = p_property_id
            and later_count.item_id = ec.item_id
            and later_count.activity_sequence > ec.count_activity_sequence
            and later_count.counted_at <= ec.counted_at
        )
      )$new$);
  if v_def = v_old then
    raise exception '0324 could not install durable grace-count movement checks';
  end if;

  execute v_def;
end
$$;

-- ─── Archive is inactive stock, never an evidence-free synthetic zero ─────

alter table public.inventory_discards
  drop constraint if exists inventory_discards_id_property_id_key,
  add constraint inventory_discards_id_property_id_key unique (id, property_id);

alter table public.inventory_month_close_snapshot_items
  add column if not exists inventory_discard_id uuid,
  add column if not exists inventory_delivery_correction_id uuid,
  drop constraint if exists inventory_month_close_snapshot_items_discard_property_fkey,
  add constraint inventory_month_close_snapshot_items_discard_property_fkey
    foreign key (inventory_discard_id, property_id)
    references public.inventory_discards(id, property_id)
    on delete no action deferrable initially deferred,
  drop constraint if exists inventory_month_close_snapshot_items_correction_property_fkey,
  add constraint inventory_month_close_snapshot_items_correction_property_fkey
    foreign key (inventory_delivery_correction_id, property_id)
    references public.inventory_delivery_corrections(id, property_id)
    on delete no action deferrable initially deferred;

alter table public.inventory_month_close_snapshot_items
  drop constraint if exists inventory_month_close_snapshot_items_valuation_method_check,
  add constraint inventory_month_close_snapshot_items_valuation_method_check check (
    valuation_method in (
      'baseline_saved_cost','periodic_weighted_average','opening_cost',
      'physical_count_cost','archived_zero','archived_count',
      'archived_loss_zero','archived_correction_zero','archived_never_stocked'
    )
  );

create or replace function public.staxis_inventory_has_stock_evidence(
  p_property_id uuid,
  p_item_id uuid
) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.inventory i
    where i.property_id = p_property_id and i.id = p_item_id and i.current_stock > 0
    union all
    select 1 from public.inventory_counts c
    where c.property_id = p_property_id and c.item_id = p_item_id and c.counted_stock > 0
    union all
    select 1 from public.inventory_orders o
    where o.property_id = p_property_id and o.item_id = p_item_id and o.quantity > 0
    union all
    select 1 from public.inventory_discards d
    where d.property_id = p_property_id and d.item_id = p_item_id
      and (d.quantity > 0 or coalesce(d.stock_before, 0) > 0)
    union all
    select 1 from public.inventory_reconciliations r
    where r.property_id = p_property_id and r.item_id = p_item_id
      and r.physical_count > 0
    union all
    select 1 from public.inventory_month_close_snapshot_items si
    where si.property_id = p_property_id and si.item_id = p_item_id and si.quantity > 0
    union all
    select 1 from public.inventory_opening_adjustments a
    where a.property_id = p_property_id and a.item_id = p_item_id and a.quantity > 0
  );
$$;

revoke all on function public.staxis_inventory_has_stock_evidence(uuid,uuid)
  from public, anon, authenticated;

-- A stocked item can be archived only when its latest durable stock-changing
-- evidence ends at zero. A saved zero count and an atomic loss whose recorded
-- stock_after is zero are both truthful evidence; an older zero is not.
create or replace function public.staxis_inventory_archive_zero_evidence(
  p_property_id uuid,
  p_item_id uuid
) returns table (
  evidence_kind text,
  evidence_id uuid,
  evidence_at timestamptz,
  activity_sequence bigint,
  unit_cost numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidate as (
    select 'count'::text as evidence_kind, c.id as evidence_id,
      c.counted_at as evidence_at, c.activity_sequence, c.unit_cost
    from public.inventory_counts c
    where c.property_id = p_property_id
      and c.item_id = p_item_id
      and c.counted_stock = 0
    union all
    select 'loss'::text, d.id, d.discarded_at, d.activity_sequence, d.unit_cost
    from public.inventory_discards d
    where d.property_id = p_property_id
      and d.item_id = p_item_id
      and d.stock_after = 0
    union all
    select 'correction'::text, correction.id, correction.corrected_at,
      coalesce((
        select max(o.activity_sequence)
        from public.inventory_orders o
        where o.property_id = correction.property_id
          and o.correction_event_id = correction.id
          and o.item_id = p_item_id
      ), correction.activity_sequence),
      correction.previous_unit_cost
    from public.inventory_delivery_corrections correction
    cross join lateral jsonb_array_elements(correction.stock_effect) effect
    where correction.property_id = p_property_id
      and effect->>'itemId' = p_item_id::text
      and coalesce((effect->>'applied')::boolean, false)
      and coalesce((effect->>'delta')::numeric, 0) < 0
      and (effect->>'stockAfter')::numeric = 0
    order by activity_sequence desc
    limit 1
  )
  select e.evidence_kind, e.evidence_id, e.evidence_at,
    e.activity_sequence, e.unit_cost
  from candidate e
  join public.inventory i
    on i.property_id = p_property_id and i.id = p_item_id
  where i.current_stock = 0
    and coalesce(i.set_aside, 0) = 0
    and not exists (
      select 1 from public.inventory_counts c
      where c.property_id = p_property_id and c.item_id = p_item_id
        and c.activity_sequence > e.activity_sequence
    )
    and not exists (
      select 1 from public.inventory_orders o
      where o.property_id = p_property_id and o.item_id = p_item_id
        and o.activity_sequence > e.activity_sequence
        and (
          o.entry_kind = 'receipt'
          or (
            o.entry_kind = 'correction' and exists (
              select 1
              from public.inventory_delivery_corrections correction,
                   jsonb_array_elements(correction.stock_effect) effect
              where correction.id = o.correction_event_id
                and correction.property_id = o.property_id
                and effect->>'itemId' = p_item_id::text
                and coalesce((effect->>'applied')::boolean, false)
            )
          )
        )
    )
    and not exists (
      select 1 from public.inventory_discards d
      where d.property_id = p_property_id and d.item_id = p_item_id
        and d.activity_sequence > e.activity_sequence
    )
    and not exists (
      select 1 from public.inventory_reconciliations r
      where r.property_id = p_property_id and r.item_id = p_item_id
        and r.physical_count > 0
        and (r.reconciled_at >= e.evidence_at or r.created_at >= e.evidence_at)
    );
$$;

revoke all on function public.staxis_inventory_archive_zero_evidence(uuid,uuid)
  from public, anon, authenticated;

-- Service preview for the finance-gated month-close API. It returns only
-- readiness/provenance labels, never costs, and uses the exact helper the
-- snapshot trigger uses so the preview cannot advertise a synthetic zero.
create or replace function public.staxis_list_inventory_archive_readiness(
  p_property_id uuid,
  p_item_ids uuid[]
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory archive readiness is service-role only' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_item_ids), 0) > 500 then
    raise exception 'at most 500 archived inventory items may be checked' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', i.id,
    'valid', (
      evidence.evidence_kind is not null
      or (
        i.current_stock = 0
        and coalesce(i.set_aside, 0) = 0
        and not public.staxis_inventory_has_stock_evidence(i.property_id, i.id)
      )
    ),
    'evidenceKind', coalesce(
      evidence.evidence_kind,
      case when i.current_stock = 0
             and coalesce(i.set_aside, 0) = 0
             and not public.staxis_inventory_has_stock_evidence(i.property_id, i.id)
        then 'never_stocked' else 'invalid' end
    )
  ) order by i.id), '[]'::jsonb)
  into v_result
  from (
    select distinct requested_id
    from unnest(coalesce(p_item_ids, '{}'::uuid[])) requested_id
  ) requested
  join public.inventory i
    on i.property_id = p_property_id and i.id = requested.requested_id
  left join lateral public.staxis_inventory_archive_zero_evidence(i.property_id, i.id)
    evidence on true;
  return v_result;
end
$$;

revoke all on function public.staxis_list_inventory_archive_readiness(uuid,uuid[])
  from public, anon, authenticated;
grant execute on function public.staxis_list_inventory_archive_readiness(uuid,uuid[])
  to service_role;

create or replace function public.staxis_require_inventory_archive_zero_evidence()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evidence record;
  v_had_stock boolean;
begin
  if old.archived_at is not null or new.archived_at is null then return new; end if;
  if exists (
    select 1 from public.inventory_month_closes c
    where c.property_id = old.property_id
      and c.status = 'open'
      and c.end_at <= clock_timestamp()
      and c.grace_end_at > clock_timestamp()
  ) then
    raise exception 'finish the open inventory month close before archiving items'
      using errcode = '23514';
  end if;
  if coalesce(old.current_stock, 0) > 0 then
    raise exception 'count inventory stock to zero before archiving' using errcode = '23514';
  end if;
  if coalesce(old.set_aside, 0) > 0 then
    raise exception 'reduce set-aside stock to zero before archiving' using errcode = '23514';
  end if;

  v_had_stock := public.staxis_inventory_has_stock_evidence(old.property_id, old.id);

  if not v_had_stock then return new; end if;

  select * into v_evidence
  from public.staxis_inventory_archive_zero_evidence(old.property_id, old.id);
  if not found then
    raise exception 'archive needs latest evidence ending at zero from a saved count, stock loss, or delivery correction; verify stock before archiving'
      using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists inventory_archive_zero_evidence on public.inventory;
create trigger inventory_archive_zero_evidence
  before update of archived_at on public.inventory
  for each row execute function public.staxis_require_inventory_archive_zero_evidence();

create or replace function public.staxis_attach_archived_inventory_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evidence record;
begin
  if new.valuation_method <> 'archived_zero' then return new; end if;
  select * into v_evidence
  from public.staxis_inventory_archive_zero_evidence(new.property_id, new.item_id);
  if not found then
    if not public.staxis_inventory_has_stock_evidence(new.property_id, new.item_id)
       and exists (
         select 1 from public.inventory i
         where i.property_id = new.property_id and i.id = new.item_id
           and i.current_stock = 0 and coalesce(i.set_aside, 0) = 0
       )
    then
      new.valuation_method := 'archived_never_stocked';
      return new;
    end if;
    raise exception 'archived inventory item lacks latest zero-stock evidence; it cannot become synthetic usage'
      using errcode = '23514';
  end if;
  new.inventory_count_id := case when v_evidence.evidence_kind = 'count'
    then v_evidence.evidence_id else null end;
  new.inventory_discard_id := case when v_evidence.evidence_kind = 'loss'
    then v_evidence.evidence_id else null end;
  new.inventory_delivery_correction_id := case when v_evidence.evidence_kind = 'correction'
    then v_evidence.evidence_id else null end;
  new.counted_at := v_evidence.evidence_at;
  new.physical_unit_cost_cents := case when v_evidence.unit_cost is null then null
    else round(v_evidence.unit_cost * 100, 6) end;
  new.valuation_method := case
    when v_evidence.evidence_kind = 'loss' then 'archived_loss_zero'
    when v_evidence.evidence_kind = 'correction' then 'archived_correction_zero'
    else 'archived_count'
  end;
  return new;
end
$$;

drop trigger if exists inventory_snapshot_attach_archived_count
  on public.inventory_month_close_snapshot_items;
create trigger inventory_snapshot_attach_archived_count
  before insert on public.inventory_month_close_snapshot_items
  for each row execute function public.staxis_attach_archived_inventory_count();

-- Explicit recovery for legacy rows archived before zero-evidence enforcement.
-- A manager must physically verify the already-archived item is zero; the RPC
-- appends a normal immutable count row and never rewrites old stock history.
create or replace function public.staxis_verify_legacy_archived_inventory_zero(
  p_property_id uuid,
  p_request_id uuid,
  p_item_id uuid,
  p_expected_archived_at timestamptz,
  p_verified_by text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.inventory%rowtype;
  v_existing public.inventory_counts%rowtype;
  v_count_id uuid;
  v_notes text;
  v_verified_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' and (
    auth.uid() is null
    or not public.user_owns_property(p_property_id)
    or not public.mfa_verified_or_grace()
    or not public.staxis_user_can_view_inventory_financials(p_property_id)
    or exists (
      select 1
      from public.accounts a
      join public.capability_overrides o
        on o.property_id = p_property_id
       and o.capability = 'manage_inventory_orders'
       and o.role = a.role
       and o.allowed = false
      where a.data_user_id = auth.uid() and a.role <> 'admin'
    )
  ) then
    raise exception 'not authorized to verify archived inventory for this property'
      using errcode = '42501';
  end if;
  if p_request_id is null or p_item_id is null then
    raise exception 'request and item are required' using errcode = '22023';
  end if;
  if nullif(trim(p_verified_by), '') is null or nullif(trim(p_reason), '') is null then
    raise exception 'verifier and verification reason are required' using errcode = '22023';
  end if;
  v_notes := 'Legacy archived zero verification · ' || trim(p_reason);
  v_verified_at := clock_timestamp();

  perform 1 from public.properties p where p.id = p_property_id for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;

  select * into v_existing
  from public.inventory_counts c
  where c.property_id = p_property_id and c.count_session_id = p_request_id
  order by c.id
  limit 1;
  if found then
    if v_existing.item_id is distinct from p_item_id
       or v_existing.counted_stock is distinct from 0::numeric
       or v_existing.counted_by is distinct from trim(p_verified_by)
       or v_existing.notes is distinct from v_notes
    then
      raise exception 'archive verification request id was reused with different values'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'replayed', true, 'itemId', v_existing.item_id,
      'countId', v_existing.id, 'verifiedAt', v_existing.counted_at
    );
  end if;

  select * into v_item
  from public.inventory i
  where i.property_id = p_property_id and i.id = p_item_id
  for update;
  if not found then raise exception 'inventory item not found for property' using errcode = 'P0002'; end if;
  if v_item.archived_at is null
     or v_item.archived_at is distinct from p_expected_archived_at
  then
    raise exception 'archived inventory changed after verification opened; refresh and try again'
      using errcode = '40001';
  end if;
  if v_item.current_stock <> 0 or coalesce(v_item.set_aside, 0) <> 0 then
    raise exception 'legacy archived inventory must have zero on-hand and zero set-aside before verification'
      using errcode = '23514';
  end if;

  insert into public.inventory_counts(
    property_id, count_session_id, item_id, item_name,
    counted_stock, estimated_stock, variance, variance_value, unit_cost,
    counted_at, counted_by, notes
  ) values (
    p_property_id, p_request_id, v_item.id, v_item.name,
    0, 0, 0, 0, v_item.unit_cost,
    v_verified_at, trim(p_verified_by), v_notes
  ) returning id into v_count_id;

  return jsonb_build_object(
    'replayed', false, 'itemId', v_item.id,
    'countId', v_count_id, 'verifiedAt', v_verified_at
  );
end
$$;

revoke all on function public.staxis_verify_legacy_archived_inventory_zero(
  uuid,uuid,uuid,timestamptz,text,text
) from public, anon;
grant execute on function public.staxis_verify_legacy_archived_inventory_zero(
  uuid,uuid,uuid,timestamptz,text,text
) to authenticated, service_role;

-- Deployment preflight: legacy stocked archives stay hidden from active totals,
-- but close remains fail-closed until support records truthful zero evidence.
-- Never-stocked zero items are safe and use archived_never_stocked instead.
do $$
declare
  v_missing integer;
  v_item_ids text;
  v_unrepairable integer;
  v_unrepairable_ids text;
begin
  select count(*)::integer, string_agg(i.id::text, ', ' order by i.id)
    into v_unrepairable, v_unrepairable_ids
  from public.inventory i
  where i.archived_at is not null
    and (i.current_stock <> 0 or coalesce(i.set_aside, 0) <> 0);
  if v_unrepairable > 0 then
    raise warning '0324 preflight: % archived inventory item(s) still carry on-hand or set-aside stock. Migration will continue, but affected property month-close remains fail-closed until audited support repair. Item IDs: %',
      v_unrepairable, v_unrepairable_ids;
  end if;

  with invalid as (
    select i.id
    from public.inventory i
    where i.archived_at is not null
      and public.staxis_inventory_has_stock_evidence(i.property_id, i.id)
      and not exists (
        select 1
        from public.staxis_inventory_archive_zero_evidence(i.property_id, i.id)
      )
  )
  select count(*)::integer, string_agg(id::text, ', ' order by id)
    into v_missing, v_item_ids
  from invalid;
  if v_missing > 0 then
    raise warning '0324 preflight: % legacy archived inventory item(s) need staxis_verify_legacy_archived_inventory_zero after physical verification before month close. Item IDs: %',
      v_missing, v_item_ids;
  end if;
end
$$;

-- Replace the old warning's wording as the open period transitions to closed.
-- Historical usage remains historical; the item no longer appears in live
-- stock totals, and its zero now points to an actual count instead of archive.
create or replace function public.staxis_enforce_inventory_month_close_header()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.status = 'closed' then
    raise exception 'closed inventory months are immutable' using errcode = '23514';
  end if;
  if new.id is distinct from old.id
     or new.property_id is distinct from old.property_id
     or new.month_start is distinct from old.month_start
     or new.timezone is distinct from old.timezone
     or new.month_start_at is distinct from old.month_start_at
     or new.end_at is distinct from old.end_at
     or new.grace_end_at is distinct from old.grace_end_at
     or new.count_window_start_at is distinct from old.count_window_start_at
     or new.activity_start_at is distinct from old.activity_start_at
     or new.opening_snapshot_id is distinct from old.opening_snapshot_id
     or new.start_request_id is distinct from old.start_request_id
  then
    raise exception 'inventory month-close period identity is immutable' using errcode = '23514';
  end if;
  if new.status <> 'closed' then
    raise exception 'an open inventory month may only transition to closed' using errcode = '23514';
  end if;
  if jsonb_typeof(new.quality_flags) = 'array' then
    select coalesce(jsonb_agg(
      case when flag->>'code' = 'archived_item_zero_ending'
        then (flag - 'code' - 'message') || jsonb_build_object(
          'code', 'archived_item_evidenced_zero',
          'message', 'Items archived during the period use a saved zero count, an atomic loss/delivery correction ending at zero, or a verified never-stocked state. They are excluded from active totals; archiving itself does not create usage.'
        )
        else flag end
    ), '[]'::jsonb)
    into new.quality_flags
    from jsonb_array_elements(new.quality_flags) flag;
  end if;
  new.updated_at := now();
  return new;
end
$$;

-- The operational ledgers are append-only for browser users.  Correction
-- rows need INSERT only through the security-definer function.
revoke insert, update, delete on public.inventory_orders from authenticated, anon;

insert into public.applied_migrations(version, description)
values (
  '0324',
  'inventory operational corrections: atomic stock loss, append-only delivery correction/void, cost/metadata repair, strict hotel timezones, and evidenced archive handling'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
