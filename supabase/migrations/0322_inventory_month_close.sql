-- 0322 — Hotel-style inventory month close.
--
-- Financial usage is a period close, not the live stock card:
--   actual usage = beginning owned inventory + confirmed purchases - ending owned inventory
--
-- The close keeps immutable item/category/budget-section snapshots.  Browser
-- roles cannot read these finance tables directly; the finance-gated server API
-- uses service_role.  All aggregate money is integer cents.  Per-unit WAC is
-- numeric because it can contain fractional cents.

begin;

-- A direct/manual catalog insert can seed stock that was already physically
-- present. These immutable fields classify that balance as opening inventory;
-- delivery RPCs deliberately leave them NULL and write inventory_orders.
alter table public.inventory
  add column opening_adjustment_quantity numeric,
  add column opening_adjustment_unit_cost numeric,
  add column opening_adjustment_at timestamptz,
  add column opening_adjustment_request_id uuid,
  add constraint inventory_opening_adjustment_all_or_none check (
    (opening_adjustment_quantity is null
      and opening_adjustment_unit_cost is null
      and opening_adjustment_at is null
      and opening_adjustment_request_id is null)
    or
    (opening_adjustment_quantity > 0
      and opening_adjustment_unit_cost >= 0
      and opening_adjustment_at is not null
      and opening_adjustment_request_id is not null)
  );

-- @rls: service-role-only — immutable audit event generated from an inventory insert.
create table public.inventory_opening_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null,
  item_id            uuid not null,
  quantity           numeric not null check (quantity > 0),
  unit_cost_cents    numeric not null check (unit_cost_cents >= 0),
  value_cents        bigint not null check (value_cents >= 0),
  effective_at       timestamptz not null,
  request_id         uuid not null,
  reason             text not null default 'preexisting_on_hand'
    check (reason = 'preexisting_on_hand'),
  stock_before       numeric not null check (stock_before >= 0),
  stock_after        numeric not null check (stock_after >= 0),
  actor_id           uuid,
  actor_name         text,
  created_at         timestamptz not null default now(),
  unique (property_id, request_id),
  foreign key (item_id, property_id)
    references public.inventory(id, property_id) on delete no action deferrable initially deferred
);

create index inventory_opening_adjustments_property_idx
  on public.inventory_opening_adjustments(property_id, effective_at, item_id);

-- ─── Immutable evidence tables ───────────────────────────────────────────

-- @rls: service-role-only — immutable financial snapshot headers; finance-gated API only.
create table public.inventory_month_close_snapshots (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  kind         text not null check (kind in ('baseline', 'ending')),
  captured_at  timestamptz not null,
  created_at   timestamptz not null default now(),
  unique (id, property_id)
);

create index inventory_close_snapshots_property_idx
  on public.inventory_month_close_snapshots(property_id, captured_at desc);

-- @rls: service-role-only — immutable item valuation evidence; finance-gated API only.
create table public.inventory_month_close_snapshot_items (
  snapshot_id                 uuid not null,
  property_id                 uuid not null,
  item_id                     uuid not null,
  item_name                   text not null,
  category                    text not null check (category in ('housekeeping','maintenance','breakfast')),
  custom_category_id          uuid,
  custom_category_name        text,
  budget_key                  text not null,
  budget_section_ids          uuid[] not null default '{}',
  multiple_budget_sections    boolean not null default false,
  archived_at                 timestamptz,
  quantity                    numeric not null check (quantity >= 0),
  set_aside                   numeric not null default 0 check (set_aside >= 0),
  unit_cost_cents             numeric,
  physical_unit_cost_cents    numeric,
  value_cents                 bigint,
  inventory_count_id          uuid,
  counted_at                  timestamptz,
  valuation_method            text not null check (
    valuation_method in ('baseline_saved_cost','periodic_weighted_average','opening_cost','physical_count_cost','archived_zero')
  ),
  purchase_quantity           numeric,
  purchase_value_cents        bigint,
  actual_usage_cents          bigint,
  opening_adjustment_quantity numeric not null default 0 check (opening_adjustment_quantity >= 0),
  opening_adjustment_unit_cost_cents numeric,
  opening_adjustment_value_cents bigint not null default 0 check (opening_adjustment_value_cents >= 0),
  opening_adjustment_at       timestamptz,
  created_at                  timestamptz not null default now(),
  primary key (snapshot_id, item_id),
  foreign key (snapshot_id, property_id)
    references public.inventory_month_close_snapshots(id, property_id) on delete cascade,
  foreign key (item_id, property_id)
    references public.inventory(id, property_id) on delete no action deferrable initially deferred,
  foreign key (inventory_count_id, property_id)
    references public.inventory_counts(id, property_id) on delete no action deferrable initially deferred
);

create index inventory_close_snapshot_items_property_idx
  on public.inventory_month_close_snapshot_items(property_id, item_id);

-- @rls: service-role-only — inventory close finance headers; finance-gated API only.
create table public.inventory_month_closes (
  id                              uuid primary key default gen_random_uuid(),
  property_id                     uuid not null references public.properties(id) on delete cascade,
  month_start                     date not null check (month_start = date_trunc('month', month_start)::date),
  timezone                        text not null,
  status                          text not null default 'open' check (status in ('open','closed')),
  month_start_at                  timestamptz not null,
  end_at                          timestamptz not null,
  grace_end_at                    timestamptz not null,
  count_window_start_at           timestamptz not null,
  activity_start_at               timestamptz not null,
  is_partial                      boolean not null,
  budget_comparison_available     boolean not null,
  opening_snapshot_id             uuid not null,
  ending_snapshot_id              uuid,
  purchase_source                 text check (purchase_source in ('logged_deliveries','manual_total','zero')),
  allocation_mode                 text check (allocation_mode in ('itemized','total_only')),
  manual_purchase_cents           bigint,
  known_logged_purchase_cents     bigint not null default 0,
  logged_purchase_cents           bigint,
  confirmed_purchase_cents        bigint,
  logged_delivery_count           integer not null default 0,
  uncosted_delivery_count         integer not null default 0,
  beginning_value_cents           bigint,
  opening_adjustment_cents        bigint not null default 0 check (opening_adjustment_cents >= 0),
  ending_value_cents              bigint,
  actual_usage_cents              bigint,
  by_category                     jsonb,
  by_item                         jsonb,
  by_budget_key                   jsonb,
  quality_flags                   jsonb not null default '[]'::jsonb,
  baseline_at                     timestamptz not null,
  opened_by                       uuid,
  opened_by_name                  text,
  closed_at                       timestamptz,
  closed_by                       uuid,
  closed_by_name                  text,
  notes                           text,
  start_request_id                uuid,
  close_request_id                uuid,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  unique (property_id, month_start),
  unique (id, property_id),
  foreign key (opening_snapshot_id, property_id)
    references public.inventory_month_close_snapshots(id, property_id) on delete no action,
  foreign key (ending_snapshot_id, property_id)
    references public.inventory_month_close_snapshots(id, property_id) on delete no action,
  check (activity_start_at >= month_start_at and activity_start_at < end_at),
  check (end_at > month_start_at and grace_end_at > end_at and count_window_start_at < end_at),
  check (manual_purchase_cents is null or manual_purchase_cents > 0),
  check (
    (status = 'open' and ending_snapshot_id is null and closed_at is null)
    or
    (status = 'closed' and ending_snapshot_id is not null and purchase_source is not null
      and allocation_mode is not null and confirmed_purchase_cents is not null
      and beginning_value_cents is not null and ending_value_cents is not null
      and actual_usage_cents is not null and closed_at is not null)
  )
);

create unique index inventory_month_closes_start_request_uq
  on public.inventory_month_closes(property_id, start_request_id)
  where start_request_id is not null;
create unique index inventory_month_closes_close_request_uq
  on public.inventory_month_closes(property_id, close_request_id)
  where close_request_id is not null;
create index inventory_month_closes_history_idx
  on public.inventory_month_closes(property_id, month_start desc);

-- Composite ledger keys keep every snapshotted source tenant-verifiable.
alter table public.inventory_orders
  drop constraint if exists inventory_orders_id_property_id_key,
  add constraint inventory_orders_id_property_id_key unique (id, property_id);

-- @rls: service-role-only — snapshotted purchase costs; finance-gated API only.
create table public.inventory_month_close_purchases (
  close_id                    uuid not null,
  property_id                 uuid not null,
  source_order_id             uuid not null,
  item_id                     uuid not null,
  item_name                   text not null,
  category                    text not null check (category in ('housekeeping','maintenance','breakfast')),
  custom_category_id          uuid,
  custom_category_name        text,
  budget_key                  text not null,
  budget_section_ids          uuid[] not null default '{}',
  multiple_budget_sections    boolean not null default false,
  received_at                 timestamptz not null,
  quantity                    numeric not null check (quantity > 0),
  unit_cost_cents             numeric not null check (unit_cost_cents >= 0),
  value_cents                 bigint not null check (value_cents >= 0),
  vendor_name                 text,
  created_at                  timestamptz not null default now(),
  primary key (close_id, source_order_id),
  unique (source_order_id),
  foreign key (close_id, property_id)
    references public.inventory_month_closes(id, property_id) on delete cascade,
  foreign key (item_id, property_id)
    references public.inventory(id, property_id) on delete no action deferrable initially deferred,
  foreign key (source_order_id, property_id)
    references public.inventory_orders(id, property_id) on delete no action deferrable initially deferred
);

create index inventory_close_purchases_property_idx
  on public.inventory_month_close_purchases(property_id, received_at);

comment on table public.inventory_month_closes is
  'Service-role-only period-close headers. Values and allocation maps are frozen when closed; opening snapshots are either an explicit first baseline or the exact prior ending snapshot.';
comment on table public.inventory_month_close_snapshot_items is
  'Immutable physical-count and valuation evidence. quantity is total owned stock; set_aside is retained as disclosure and is never subtracted from owned value.';
comment on column public.inventory_month_closes.logged_purchase_cents is
  'NULL when any logged line in the window lacks cost. known_logged_purchase_cents remains the explicitly incomplete subtotal.';
comment on table public.inventory_opening_adjustments is
  'Immutable audit evidence for pre-existing stock discovered after a baseline. It adjusts beginning inventory and is never a purchase.';

-- ─── RLS: finance evidence is server-only ────────────────────────────────

alter table public.inventory_month_close_snapshots enable row level security;
alter table public.inventory_opening_adjustments enable row level security;
alter table public.inventory_month_close_snapshot_items enable row level security;
alter table public.inventory_month_closes enable row level security;
alter table public.inventory_month_close_purchases enable row level security;

create policy "inventory close snapshots deny browser"
  on public.inventory_month_close_snapshots for all to anon, authenticated
  using (false) with check (false);
create policy "inventory opening adjustments deny browser"
  on public.inventory_opening_adjustments for all to anon, authenticated
  using (false) with check (false);
create policy "inventory close snapshot items deny browser"
  on public.inventory_month_close_snapshot_items for all to anon, authenticated
  using (false) with check (false);
create policy "inventory month closes deny browser"
  on public.inventory_month_closes for all to anon, authenticated
  using (false) with check (false);
create policy "inventory close purchases deny browser"
  on public.inventory_month_close_purchases for all to anon, authenticated
  using (false) with check (false);

revoke all on public.inventory_month_close_snapshots from public, anon, authenticated;
revoke all on public.inventory_opening_adjustments from public, anon, authenticated;
revoke all on public.inventory_month_close_snapshot_items from public, anon, authenticated;
revoke all on public.inventory_month_closes from public, anon, authenticated;
revoke all on public.inventory_month_close_purchases from public, anon, authenticated;
grant select, insert, update, delete on public.inventory_month_close_snapshots to service_role;
grant select, insert, update, delete on public.inventory_opening_adjustments to service_role;
grant select, insert, update, delete on public.inventory_month_close_snapshot_items to service_role;
grant select, insert, update, delete on public.inventory_month_closes to service_role;
grant select, insert, update, delete on public.inventory_month_close_purchases to service_role;

-- ─── Immutability and serialization ─────────────────────────────────────

create or replace function public.staxis_reject_inventory_close_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'inventory month-close evidence is immutable' using errcode = '23514';
end
$$;

create trigger inventory_close_snapshots_immutable
  before update or delete on public.inventory_month_close_snapshots
  for each row execute function public.staxis_reject_inventory_close_evidence_mutation();
create trigger inventory_close_snapshot_items_immutable
  before update or delete on public.inventory_month_close_snapshot_items
  for each row execute function public.staxis_reject_inventory_close_evidence_mutation();
create trigger inventory_close_purchases_immutable
  before update or delete on public.inventory_month_close_purchases
  for each row execute function public.staxis_reject_inventory_close_evidence_mutation();
create trigger inventory_opening_adjustments_immutable
  before update or delete on public.inventory_opening_adjustments
  for each row execute function public.staxis_reject_inventory_close_evidence_mutation();

create or replace function public.staxis_capture_inventory_opening_adjustment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.opening_adjustment_quantity is null then return new; end if;
  if new.opening_adjustment_at > now() + interval '5 minutes' then
    raise exception 'inventory opening-adjustment timestamp cannot be in the future'
      using errcode = '22023';
  end if;
  insert into public.inventory_opening_adjustments (
    property_id, item_id, quantity, unit_cost_cents,
    value_cents, effective_at, request_id, stock_before, stock_after
  ) values (
    new.property_id, new.id, new.opening_adjustment_quantity,
    round(new.opening_adjustment_unit_cost * 100, 6),
    round(new.opening_adjustment_quantity * new.opening_adjustment_unit_cost * 100)::bigint,
    new.opening_adjustment_at, new.opening_adjustment_request_id,
    0, new.current_stock
  );
  return new;
end
$$;

create trigger inventory_capture_opening_adjustment
  after insert on public.inventory
  for each row execute function public.staxis_capture_inventory_opening_adjustment();

-- A manager may discover stock that existed before the baseline but was
-- omitted from it. Record that classification and the resulting count in one
-- idempotent transaction. It is beginning inventory, never a delivery row.
create or replace function public.staxis_record_inventory_opening_adjustment(
  p_property_id uuid,
  p_item_id uuid,
  p_request_id uuid,
  p_effective_at timestamptz,
  p_expected_stock numeric,
  p_resulting_stock numeric,
  p_adjustment_quantity numeric,
  p_unit_cost numeric,
  p_actor_id uuid,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.inventory%rowtype;
  v_existing public.inventory_opening_adjustments%rowtype;
  v_close_id uuid;
  v_value_cents bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory opening adjustments are service-role only' using errcode = '42501';
  end if;
  if p_request_id is null or p_item_id is null or p_effective_at is null then
    raise exception 'item, request, and effective timestamp are required' using errcode = '22023';
  end if;
  if p_effective_at > now() + interval '5 minutes' then
    raise exception 'opening-adjustment timestamp cannot be in the future' using errcode = '22023';
  end if;
  if p_expected_stock is null or p_resulting_stock is null
     or p_adjustment_quantity is null or p_unit_cost is null
     or p_expected_stock::text in ('NaN','Infinity','-Infinity')
     or p_resulting_stock::text in ('NaN','Infinity','-Infinity')
     or p_adjustment_quantity::text in ('NaN','Infinity','-Infinity')
     or p_unit_cost::text in ('NaN','Infinity','-Infinity')
     or p_expected_stock < 0 or p_resulting_stock < 0
     or p_adjustment_quantity <= 0 or p_unit_cost < 0
     or p_adjustment_quantity > p_resulting_stock
  then
    raise exception 'opening-adjustment quantities and cost are invalid' using errcode = '22023';
  end if;

  perform 1 from public.properties p where p.id = p_property_id for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;

  select * into v_existing
  from public.inventory_opening_adjustments a
  where a.property_id = p_property_id and a.request_id = p_request_id;
  if found then
    if v_existing.item_id is distinct from p_item_id
       or v_existing.quantity is distinct from p_adjustment_quantity
       or v_existing.unit_cost_cents is distinct from round(p_unit_cost * 100, 6)
       or v_existing.effective_at is distinct from p_effective_at
       or v_existing.stock_before is distinct from p_expected_stock
       or v_existing.stock_after is distinct from p_resulting_stock
    then
      raise exception 'opening-adjustment request id was reused with different values'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'replayed', true, 'itemId', v_existing.item_id,
      'stock', v_existing.stock_after, 'adjustmentQuantity', v_existing.quantity
    );
  end if;

  select c.id into v_close_id
  from public.inventory_month_closes c
  where c.property_id = p_property_id
    and c.status = 'open'
    and p_effective_at >= c.activity_start_at
    and p_effective_at < c.grace_end_at
  order by c.month_start desc
  limit 1;
  if v_close_id is null then
    raise exception 'opening stock can only be corrected during an open tracked inventory period'
      using errcode = '22023';
  end if;

  select * into v_item
  from public.inventory i
  where i.id = p_item_id and i.property_id = p_property_id and i.archived_at is null
  for update;
  if not found then raise exception 'active inventory item not found' using errcode = 'P0002'; end if;
  if v_item.current_stock is distinct from p_expected_stock then
    raise exception 'inventory item changed; refresh before recording missed opening stock'
      using errcode = '40001';
  end if;

  v_value_cents := round(p_adjustment_quantity * p_unit_cost * 100)::bigint;
  insert into public.inventory_opening_adjustments (
    property_id, item_id, quantity, unit_cost_cents, value_cents,
    effective_at, request_id, stock_before, stock_after, actor_id, actor_name
  ) values (
    p_property_id, p_item_id, p_adjustment_quantity,
    round(p_unit_cost * 100, 6), v_value_cents,
    p_effective_at, p_request_id, p_expected_stock, p_resulting_stock,
    p_actor_id, nullif(trim(p_actor_name), '')
  );

  insert into public.inventory_counts (
    property_id, count_session_id, item_id, item_name,
    counted_stock, estimated_stock, variance, variance_value, unit_cost,
    counted_at, counted_by, notes
  ) values (
    p_property_id, p_request_id, v_item.id, v_item.name,
    p_resulting_stock, p_expected_stock, p_resulting_stock - p_expected_stock,
    (p_resulting_stock - p_expected_stock) * p_unit_cost, p_unit_cost,
    p_effective_at, nullif(trim(p_actor_name), ''),
    'Missed opening inventory — pre-existing stock, not a purchase'
  );

  update public.inventory
  set current_stock = p_resulting_stock,
      unit_cost = p_unit_cost,
      last_counted_at = greatest(coalesce(last_counted_at, p_effective_at), p_effective_at)
  where id = p_item_id and property_id = p_property_id;

  return jsonb_build_object(
    'replayed', false, 'itemId', p_item_id,
    'stock', p_resulting_stock, 'adjustmentQuantity', p_adjustment_quantity
  );
end
$$;

revoke all on function public.staxis_record_inventory_opening_adjustment(
  uuid, uuid, uuid, timestamptz, numeric, numeric, numeric, numeric, uuid, text
) from public, anon, authenticated;
grant execute on function public.staxis_record_inventory_opening_adjustment(
  uuid, uuid, uuid, timestamptz, numeric, numeric, numeric, numeric, uuid, text
) to service_role;

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
  new.updated_at := now();
  return new;
end
$$;

create trigger inventory_month_close_header_guard
  before update or delete on public.inventory_month_closes
  for each row execute function public.staxis_enforce_inventory_month_close_header();

-- Every stock/count/delivery/discard mutation takes the same property row lock
-- as baseline/close.  This gives a total order without trusting application
-- timing, and closed-period backfills fail before their transaction commits.
create or replace function public.staxis_inventory_close_activity_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id uuid;
  v_activity_at timestamptz;
  v_open record;
begin
  v_property_id := case when tg_op = 'DELETE' then old.property_id else new.property_id end;
  perform 1 from public.properties p where p.id = v_property_id for update;
  if not found then
    raise exception 'inventory activity property not found' using errcode = '23503';
  end if;

  if tg_table_name = 'inventory_orders' then
    if tg_op <> 'INSERT' then
      v_activity_at := old.received_at;
    else
      v_activity_at := new.received_at;
    end if;
  elsif tg_table_name = 'inventory_counts' then
    if tg_op <> 'INSERT' then
      v_activity_at := old.counted_at;
    else
      v_activity_at := new.counted_at;
    end if;
  elsif tg_table_name = 'inventory_discards' then
    if tg_op <> 'INSERT' then
      v_activity_at := old.discarded_at;
    else
      v_activity_at := new.discarded_at;
    end if;
  else
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' and v_activity_at > now() + interval '5 minutes' then
    raise exception 'inventory activity timestamp cannot be in the future' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.inventory_month_closes c
    where c.property_id = v_property_id
      and c.status = 'closed'
      and v_activity_at >= c.month_start_at
      and v_activity_at < c.end_at
  ) then
    raise exception 'inventory activity cannot be written into a closed month' using errcode = '23514';
  end if;

  -- A first partial baseline deliberately excludes earlier purchases/counts.
  -- Reject later backdating into that excluded part because the resulting stock
  -- mutation could no longer be reconciled by the period equation.
  select c.month_start_at, c.activity_start_at into v_open
  from public.inventory_month_closes c
  where c.property_id = v_property_id
    and c.status = 'open'
    and c.is_partial
    and v_activity_at >= c.month_start_at
    and v_activity_at < c.activity_start_at
  order by c.month_start desc
  limit 1;
  if found then
    raise exception 'inventory activity predates this month''s opening baseline' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger inventory_orders_month_close_guard
  before insert or update or delete on public.inventory_orders
  for each row execute function public.staxis_inventory_close_activity_guard();
create trigger inventory_counts_month_close_guard
  before insert or update or delete on public.inventory_counts
  for each row execute function public.staxis_inventory_close_activity_guard();
create trigger inventory_discards_month_close_guard
  before insert or update or delete on public.inventory_discards
  for each row execute function public.staxis_inventory_close_activity_guard();

create or replace function public.staxis_inventory_close_property_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property_id uuid;
begin
  v_property_id := case when tg_op = 'DELETE' then old.property_id else new.property_id end;
  perform 1 from public.properties p where p.id = v_property_id for update;
  if tg_table_name = 'inventory' and tg_op = 'UPDATE' then
    if new.opening_adjustment_quantity is distinct from old.opening_adjustment_quantity
       or new.opening_adjustment_unit_cost is distinct from old.opening_adjustment_unit_cost
       or new.opening_adjustment_at is distinct from old.opening_adjustment_at
       or new.opening_adjustment_request_id is distinct from old.opening_adjustment_request_id
    then
      raise exception 'inventory opening-adjustment provenance is immutable'
        using errcode = '23514';
    end if;
    if old.archived_at is null and new.archived_at is not null
       and coalesce(old.current_stock, 0) > 0
    then
      raise exception 'count inventory stock to zero before archiving'
        using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger inventory_item_month_close_lock
  before insert or update or delete on public.inventory
  for each row execute function public.staxis_inventory_close_property_lock();
create trigger inventory_budget_section_month_close_lock
  before insert or update or delete on public.inventory_budget_sections
  for each row execute function public.staxis_inventory_close_property_lock();
create trigger inventory_custom_category_month_close_lock
  before insert or update or delete on public.inventory_custom_categories
  for each row execute function public.staxis_inventory_close_property_lock();

-- At commit, every positive item first created after an open baseline must be
-- explained by either immutable pre-existing-stock evidence or a genuine
-- received line written in the same delivery transaction.
create or replace function public.staxis_require_positive_inventory_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_activity_start timestamptz;
  v_provenance_end timestamptz;
  v_current_stock numeric;
begin
  select i.current_stock into v_current_stock
  from public.inventory i
  where i.id = new.id and i.property_id = new.property_id;
  if not found or coalesce(v_current_stock, 0) <= 0 then return new; end if;

  select c.activity_start_at, c.grace_end_at into v_activity_start, v_provenance_end
  from public.inventory_month_closes c
  where c.property_id = new.property_id
    and c.status = 'open'
    and coalesce(new.created_at, now()) >= c.activity_start_at
    and coalesce(new.created_at, now()) < c.grace_end_at
  order by c.month_start desc
  limit 1;
  if not found then return new; end if;

  if exists (
    select 1 from public.inventory_opening_adjustments a
    where a.property_id = new.property_id and a.item_id = new.id
      and a.effective_at >= v_activity_start and a.effective_at < v_provenance_end
  ) then return new; end if;

  if exists (
    select 1 from public.inventory_orders o
    where o.property_id = new.property_id and o.item_id = new.id
      and o.quantity > 0
      and o.received_at >= v_activity_start and o.received_at < v_provenance_end
  ) then return new; end if;

  raise exception 'positive starting stock requires an opening-inventory adjustment or a received delivery line'
    using errcode = '23514';
end
$$;

create constraint trigger inventory_positive_creation_provenance
  after insert on public.inventory
  deferrable initially deferred
  for each row execute function public.staxis_require_positive_inventory_provenance();

-- ─── First baseline ──────────────────────────────────────────────────────

create or replace function public.staxis_start_inventory_month_close(
  p_property_id uuid,
  p_month_start date,
  p_request_id uuid,
  p_actor_id uuid,
  p_actor_name text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_timezone text;
  v_month_start_at timestamptz;
  v_end_at timestamptz;
  v_grace_end_at timestamptz;
  v_count_window_start_at timestamptz;
  v_snapshot_id uuid;
  v_close_id uuid;
  v_existing record;
  v_count_session_id uuid;
  v_baseline_at timestamptz;
  v_active_item_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory month close is service-role only' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request id is required' using errcode = '22023';
  end if;
  if p_month_start is null or p_month_start <> date_trunc('month', p_month_start)::date then
    raise exception 'month_start must be the first calendar day' using errcode = '22023';
  end if;

  select coalesce(nullif(trim(p.timezone), ''), 'America/Chicago')
    into v_timezone
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;

  if p_month_start <> date_trunc('month', timezone(v_timezone, now()))::date then
    raise exception 'a new baseline may only start in the property''s current local month'
      using errcode = '22023';
  end if;

  v_month_start_at := p_month_start::timestamp at time zone v_timezone;
  v_end_at := (p_month_start + interval '1 month')::timestamp at time zone v_timezone;
  v_grace_end_at := (p_month_start + interval '1 month 3 days')::timestamp at time zone v_timezone;
  v_count_window_start_at := (p_month_start + interval '1 month' - interval '1 day')::timestamp at time zone v_timezone;

  select c.id, c.month_start into v_existing
  from public.inventory_month_closes c
  where c.property_id = p_property_id and c.start_request_id = p_request_id;
  if found then
    if v_existing.month_start <> p_month_start then
      raise exception 'request id is already bound to a different month' using errcode = '22023';
    end if;
    return v_existing.id;
  end if;

  select c.id, c.status into v_existing
  from public.inventory_month_closes c
  where c.property_id = p_property_id and c.month_start = p_month_start;
  if found then
    if v_existing.status = 'open' then return v_existing.id; end if;
    raise exception 'inventory month is already closed' using errcode = '23514';
  end if;

  select count(*)::integer into v_active_item_count
  from public.inventory i
  where i.property_id = p_property_id and i.archived_at is null;
  if v_active_item_count = 0 then
    raise exception 'add at least one inventory item before starting monthly tracking'
      using errcode = '22023';
  end if;

  -- One complete atomic count session is mandatory. Independent per-item or
  -- quick/category counts from different dates must never masquerade as a full
  -- opening inventory. last_counted_at is intentionally ignored because old
  -- invoice-created items stamped it without creating count evidence.
  select c.count_session_id, max(c.counted_at)
    into v_count_session_id, v_baseline_at
  from public.inventory_counts c
  join public.inventory i
    on i.id = c.item_id and i.property_id = p_property_id and i.archived_at is null
  where c.property_id = p_property_id
    and c.count_session_id is not null
    and c.counted_at >= v_month_start_at
    and c.counted_at < v_end_at
  group by c.count_session_id
  having count(distinct c.item_id) = v_active_item_count
     and bool_and(c.counted_stock is not distinct from i.current_stock)
  order by max(c.counted_at) desc, c.count_session_id desc
  limit 1;
  if v_count_session_id is null then
    raise exception 'one current complete physical-count session is required for every active item'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.inventory_orders o
    where o.property_id = p_property_id and o.received_at >= v_baseline_at
  ) or exists (
    select 1 from public.inventory_discards d
    where d.property_id = p_property_id and d.discarded_at >= v_baseline_at
  ) then
    raise exception 'inventory activity occurred after the complete opening count; count again'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.inventory i
    where i.property_id = p_property_id
      and i.archived_at is null
      and i.unit_cost is null
  ) then
    raise exception 'a saved unit cost is required for every active item'
      using errcode = '22023';
  end if;

  insert into public.inventory_month_close_snapshots(property_id, kind, captured_at)
  values (p_property_id, 'baseline', v_baseline_at)
  returning id into v_snapshot_id;

  insert into public.inventory_month_close_snapshot_items (
    snapshot_id, property_id, item_id, item_name, category,
    custom_category_id, custom_category_name, budget_key,
    budget_section_ids, multiple_budget_sections, archived_at,
    quantity, set_aside, unit_cost_cents, physical_unit_cost_cents,
    value_cents, inventory_count_id, counted_at, valuation_method
  )
  select
    v_snapshot_id, p_property_id, i.id, i.name, i.category,
    i.custom_category_id, cc.name,
    case when bm.winner_id is null then i.category else 'section:' || bm.winner_id::text end,
    coalesce(bm.section_ids, '{}'::uuid[]), coalesce(bm.section_count, 0) > 1,
    i.archived_at, lc.counted_stock, coalesce(i.set_aside, 0),
    round(i.unit_cost * 100, 6),
    case when lc.unit_cost is null then null else round(lc.unit_cost * 100, 6) end,
    round(lc.counted_stock * i.unit_cost * 100)::bigint,
    lc.id, lc.counted_at, 'baseline_saved_cost'
  from public.inventory i
  join lateral (
    select c.id, c.counted_stock, c.unit_cost, c.counted_at
    from public.inventory_counts c
    where c.property_id = p_property_id
      and c.item_id = i.id
      and c.count_session_id = v_count_session_id
  ) lc on true
  left join public.inventory_custom_categories cc
    on cc.id = i.custom_category_id and cc.property_id = p_property_id
  left join lateral (
    select
      (array_agg(s.id order by s.sort, s.id))[1] as winner_id,
      array_agg(s.id order by s.sort, s.id) as section_ids,
      count(*)::integer as section_count
    from public.inventory_budget_sections s
    where s.property_id = p_property_id and i.id = any(s.item_ids)
  ) bm on true
  where i.property_id = p_property_id and i.archived_at is null;

  insert into public.inventory_month_closes (
    property_id, month_start, timezone, status,
    month_start_at, end_at, grace_end_at, count_window_start_at,
    activity_start_at, is_partial, budget_comparison_available,
    opening_snapshot_id, beginning_value_cents, baseline_at,
    opened_by, opened_by_name, start_request_id,
    quality_flags
  )
  select
    p_property_id, p_month_start, v_timezone, 'open',
    v_month_start_at, v_end_at, v_grace_end_at, v_count_window_start_at,
    v_baseline_at, true, false,
    v_snapshot_id, coalesce(sum(si.value_cents), 0)::bigint, v_baseline_at,
    p_actor_id, nullif(trim(p_actor_name), ''), p_request_id,
    case when bool_or(si.multiple_budget_sections)
      then jsonb_build_array(jsonb_build_object(
        'code', 'multiple_budget_sections',
        'message', 'One or more items map to multiple budget sections; the lowest sort/id won deterministically.'
      ))
      else '[]'::jsonb
    end
  from public.inventory_month_close_snapshot_items si
  where si.snapshot_id = v_snapshot_id
  returning id into v_close_id;

  return v_close_id;
end
$$;

revoke all on function public.staxis_start_inventory_month_close(uuid, date, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.staxis_start_inventory_month_close(uuid, date, uuid, uuid, text)
  to service_role;

-- ─── Atomic close + exact carry-forward ──────────────────────────────────

create or replace function public.staxis_close_inventory_month_close(
  p_property_id uuid,
  p_month_start date,
  p_request_id uuid,
  p_purchase_source text,
  p_manual_purchase_cents bigint,
  p_actor_id uuid,
  p_actor_name text,
  p_notes text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_timezone text;
  v_close public.inventory_month_closes%rowtype;
  v_existing public.inventory_month_closes%rowtype;
  v_ending_snapshot_id uuid;
  v_logged_count integer := 0;
  v_uncosted_count integer := 0;
  v_known_logged_cents bigint := 0;
  v_logged_cents bigint;
  v_confirmed_cents bigint;
  v_beginning_cents bigint;
  v_opening_adjustment_cents bigint := 0;
  v_ending_cents bigint;
  v_actual_cents bigint;
  v_by_category jsonb;
  v_by_item jsonb;
  v_by_budget_key jsonb;
  v_quality_flags jsonb;
  v_next_month date;
  v_ending_count_session_id uuid;
  v_close_item_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'inventory month close is service-role only' using errcode = '42501';
  end if;
  if p_request_id is null then raise exception 'request id is required' using errcode = '22023'; end if;
  if p_month_start is null or p_month_start <> date_trunc('month', p_month_start)::date then
    raise exception 'month_start must be the first calendar day' using errcode = '22023';
  end if;
  if p_purchase_source not in ('logged_deliveries','manual_total','zero') then
    raise exception 'purchase_source must be logged_deliveries, manual_total, or zero'
      using errcode = '22023';
  end if;
  if p_purchase_source = 'manual_total' then
    if p_manual_purchase_cents is null or p_manual_purchase_cents <= 0 then
      raise exception 'manual total must be positive; use zero for an explicit $0 month'
        using errcode = '22023';
    end if;
  elsif p_manual_purchase_cents is not null then
    raise exception 'manual total is only valid with manual_total' using errcode = '22023';
  end if;

  -- Shared serialization point with stock/count/delivery/discard triggers.
  select coalesce(nullif(trim(p.timezone), ''), 'America/Chicago')
    into v_timezone
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found then raise exception 'property not found' using errcode = 'P0002'; end if;

  select * into v_existing
  from public.inventory_month_closes c
  where c.property_id = p_property_id and c.close_request_id = p_request_id;
  if found then
    if v_existing.month_start <> p_month_start
       or v_existing.purchase_source is distinct from p_purchase_source
       or v_existing.manual_purchase_cents is distinct from p_manual_purchase_cents
    then
      raise exception 'request id is already bound to a different close payload'
        using errcode = '22023';
    end if;
    return v_existing.id;
  end if;

  select * into v_close
  from public.inventory_month_closes c
  where c.property_id = p_property_id and c.month_start = p_month_start
  for update;
  if not found then raise exception 'start monthly tracking before closing' using errcode = 'P0002'; end if;
  if v_close.status = 'closed' then return v_close.id; end if;
  if now() < v_close.end_at then
    raise exception 'this month cannot close before the property-local month boundary'
      using errcode = '22023';
  end if;

  -- A timezone edit cannot silently move the boundaries of an already-open
  -- accounting period. The frozen period timezone wins; the next carried
  -- period uses the current property timezone only when it is created later.
  if v_close.timezone is distinct from v_timezone then
    raise exception 'property timezone changed after this period opened; rebaseline the current month'
      using errcode = '23514';
  end if;

  select
    count(*)::integer,
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
    ), 0)::bigint
  into v_logged_count, v_uncosted_count, v_known_logged_cents
  from public.inventory_orders o
  where o.property_id = p_property_id
    and o.received_at >= v_close.activity_start_at
    and o.received_at < v_close.end_at;

  v_logged_cents := case when v_uncosted_count > 0 then null else v_known_logged_cents end;
  if p_purchase_source = 'logged_deliveries' then
    if v_logged_count = 0 then
      raise exception 'no logged deliveries exist; explicitly choose zero instead'
        using errcode = '22023';
    end if;
    if v_uncosted_count > 0 then
      raise exception 'one or more logged deliveries have no usable cost'
        using errcode = '22023';
    end if;
    v_confirmed_cents := v_logged_cents;
  elsif p_purchase_source = 'manual_total' then
    v_confirmed_cents := p_manual_purchase_cents;
  else
    if v_logged_count > 0 then
      raise exception 'logged deliveries exist; zero purchases cannot be confirmed'
        using errcode = '22023';
    end if;
    v_confirmed_cents := 0;
  end if;

  create temporary table staxis_month_close_items (
    item_id uuid primary key,
    requires_count boolean not null default false
  ) on commit drop;

  insert into staxis_month_close_items(item_id)
  select si.item_id
  from public.inventory_month_close_snapshot_items si
  where si.snapshot_id = v_close.opening_snapshot_id
  union
  select i.id
  from public.inventory i
  where i.property_id = p_property_id
    and (
      coalesce(i.created_at, '-infinity'::timestamptz) < v_close.end_at
      or exists (
        select 1 from public.inventory_opening_adjustments oa
        where oa.property_id = p_property_id and oa.item_id = i.id
          and oa.effective_at >= v_close.activity_start_at
          and oa.effective_at < v_close.grace_end_at
      )
    )
    and (
      i.archived_at is null
      or i.archived_at >= v_close.end_at
      or (i.archived_at >= v_close.activity_start_at and i.archived_at < v_close.end_at)
    )
  union
  select o.item_id
  from public.inventory_orders o
  where o.property_id = p_property_id
    and o.received_at >= v_close.activity_start_at
    and o.received_at < v_close.end_at
  on conflict do nothing;

  -- Items archived inside the measured period are no longer available in the
  -- count UI. Treat archival as zero ending on-hand (a write-off/usage event),
  -- preserve archived_at as evidence, and warn. Items that were still active
  -- at the local boundary remain count-required, even if archived afterward.
  update staxis_month_close_items ci
  set requires_count = i.archived_at is null or i.archived_at >= v_close.end_at
  from public.inventory i
  where i.id = ci.item_id and i.property_id = p_property_id;

  select count(*)::integer into v_close_item_count
  from staxis_month_close_items where requires_count;
  if v_close_item_count > 0 then
    select c.count_session_id
      into v_ending_count_session_id
    from public.inventory_counts c
    join staxis_month_close_items ci on ci.item_id = c.item_id and ci.requires_count
    where c.property_id = p_property_id
      and c.count_session_id is not null
      and c.counted_at >= greatest(v_close.count_window_start_at, v_close.activity_start_at)
      and c.counted_at < v_close.grace_end_at
    group by c.count_session_id
    having count(distinct c.item_id) = v_close_item_count
    order by max(c.counted_at) desc, c.count_session_id desc
    limit 1;

    if v_ending_count_session_id is null then
      raise exception 'one complete physical-count session must cover every active period-end item in the ending-count window'
        using errcode = '22023';
    end if;
  end if;

  create temporary table staxis_month_close_counts on commit drop as
  select
    c.item_id, c.id as count_id, c.counted_stock, c.unit_cost, c.counted_at
  from public.inventory_counts c
  join staxis_month_close_items ci on ci.item_id = c.item_id and ci.requires_count
  where c.property_id = p_property_id
    and c.count_session_id = v_ending_count_session_id
    and c.counted_at >= greatest(v_close.count_window_start_at, v_close.activity_start_at)
    and c.counted_at < v_close.grace_end_at;
  create unique index staxis_month_close_counts_item_uq
    on staxis_month_close_counts(item_id);

  if exists (
    select 1
    from staxis_month_close_items ci
    left join staxis_month_close_counts ec on ec.item_id = ci.item_id
    where ci.requires_count and ec.item_id is null
  ) then
    raise exception 'every period item needs a physical count on the final local calendar day or in the three-day grace window'
      using errcode = '22023';
  end if;

  -- Fail closed around the selected physical count.  A count within the month
  -- must be after its final closing-month movement. A grace-period count must
  -- happen before any next-month movement, otherwise it no longer represents
  -- the prior month ending balance.
  if exists (
    select 1
    from staxis_month_close_counts ec
    where ec.counted_at < v_close.end_at
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
      )
  ) then
    raise exception 'a closing-month delivery or discard occurred after the selected ending count'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from staxis_month_close_counts ec
    where ec.counted_at >= v_close.end_at
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
      )
  ) then
    raise exception 'next-month activity occurred before a grace-period ending count'
      using errcode = '22023';
  end if;

  -- A missed-opening-stock adjustment changes owned quantity just like a
  -- physical discovery. The selected ending count must include it. Unlike a
  -- next-month delivery, a grace-period adjustment is intentionally assigned
  -- to the closing period, so it is valid when recorded before that count.
  if exists (
    select 1
    from staxis_month_close_counts ec
    where exists (
      select 1 from public.inventory_opening_adjustments oa
      where oa.property_id = p_property_id and oa.item_id = ec.item_id
        and oa.effective_at > ec.counted_at
        and oa.effective_at < v_close.grace_end_at
        and oa.effective_at >= v_close.activity_start_at
    )
  ) then
    raise exception 'missed opening stock was recorded after the selected ending count; count again'
      using errcode = '22023';
  end if;

  create temporary table staxis_month_close_values on commit drop as
  with purchase_by_item as (
    select
      o.item_id,
      sum(o.quantity)::numeric as purchase_quantity,
      sum(round(coalesce(o.total_cost, o.quantity * o.unit_cost) * 100)::bigint)::bigint as purchase_value_cents
    from public.inventory_orders o
    where o.property_id = p_property_id
      and o.received_at >= v_close.activity_start_at
      and o.received_at < v_close.end_at
      and o.quantity > 0
      and coalesce(o.total_cost, o.quantity * o.unit_cost) >= 0
    group by o.item_id
  ), opening_adjustment_by_item as (
    select
      oa.item_id,
      sum(oa.quantity)::numeric as quantity,
      sum(oa.value_cents)::bigint as value_cents,
      case when sum(oa.quantity) > 0
        then sum(oa.value_cents)::numeric / sum(oa.quantity)
        else null
      end as unit_cost_cents,
      max(oa.effective_at) as effective_at
    from public.inventory_opening_adjustments oa
    where oa.property_id = p_property_id
      and oa.effective_at >= v_close.activity_start_at
      and oa.effective_at < v_close.grace_end_at
    group by oa.item_id
  ), dimensions as (
    select
      ci.item_id,
      coalesce(i.name, os.item_name) as item_name,
      coalesce(i.category, os.category) as category,
      coalesce(i.custom_category_id, os.custom_category_id) as custom_category_id,
      coalesce(cc.name, os.custom_category_name) as custom_category_name,
      case when bm.winner_id is null then i.category else 'section:' || bm.winner_id::text end as budget_key,
      coalesce(bm.section_ids, '{}'::uuid[]) as budget_section_ids,
      coalesce(bm.section_count, 0) > 1 as multiple_budget_sections,
      ci.requires_count,
      i.archived_at,
      (coalesce(os.quantity, 0) + coalesce(oa.quantity, 0))::numeric
        as opening_quantity,
      case
        when coalesce(os.quantity, 0) + coalesce(oa.quantity, 0) > 0
          then (coalesce(os.value_cents, 0) + coalesce(oa.value_cents, 0))::numeric
            / (coalesce(os.quantity, 0) + coalesce(oa.quantity, 0))
        else coalesce(os.unit_cost_cents, oa.unit_cost_cents)
      end as opening_unit_cost_cents,
      (coalesce(os.value_cents, 0) + coalesce(oa.value_cents, 0))::bigint
        as opening_value_cents,
      coalesce(oa.quantity, 0)::numeric as opening_adjustment_quantity,
      oa.unit_cost_cents as opening_adjustment_unit_cost_cents,
      coalesce(oa.value_cents, 0)::bigint as opening_adjustment_value_cents,
      oa.effective_at as opening_adjustment_at,
      case when ci.requires_count then coalesce(i.set_aside, 0) else 0 end::numeric as ending_set_aside,
      ec.count_id,
      case when ci.requires_count then ec.counted_stock else 0 end::numeric as ending_quantity,
      case when ec.unit_cost is null then null else round(ec.unit_cost * 100, 6) end as physical_unit_cost_cents,
      ec.counted_at,
      coalesce(pb.purchase_quantity, 0)::numeric as logged_purchase_quantity,
      coalesce(pb.purchase_value_cents, 0)::bigint as logged_purchase_value_cents
    from staxis_month_close_items ci
    join public.inventory i on i.id = ci.item_id and i.property_id = p_property_id
    left join staxis_month_close_counts ec
      on ec.item_id = ci.item_id and ci.requires_count
    left join public.inventory_month_close_snapshot_items os
      on os.snapshot_id = v_close.opening_snapshot_id and os.item_id = ci.item_id
    left join opening_adjustment_by_item oa on oa.item_id = ci.item_id
    left join purchase_by_item pb on pb.item_id = ci.item_id
    left join public.inventory_custom_categories cc
      on cc.id = i.custom_category_id and cc.property_id = p_property_id
    left join lateral (
      select
        (array_agg(s.id order by s.sort, s.id))[1] as winner_id,
        array_agg(s.id order by s.sort, s.id) as section_ids,
        count(*)::integer as section_count
      from public.inventory_budget_sections s
      where s.property_id = p_property_id and i.id = any(s.item_ids)
    ) bm on true
  ), costed as (
    select d.*,
      case
        when p_purchase_source = 'manual_total' and d.requires_count then d.physical_unit_cost_cents
        when p_purchase_source = 'manual_total' then d.opening_unit_cost_cents
        when p_purchase_source = 'zero' then d.opening_unit_cost_cents
        when d.opening_quantity + d.logged_purchase_quantity > 0 then
          (d.opening_value_cents + d.logged_purchase_value_cents)::numeric
            / (d.opening_quantity + d.logged_purchase_quantity)
        else null
      end as ending_unit_cost_cents,
      case
        when p_purchase_source = 'logged_deliveries' then d.logged_purchase_quantity
        when p_purchase_source = 'zero' then 0::numeric
        else null
      end as selected_purchase_quantity,
      case
        when p_purchase_source = 'logged_deliveries' then d.logged_purchase_value_cents
        when p_purchase_source = 'zero' then 0::bigint
        else null
      end as selected_purchase_value_cents
    from dimensions d
  ), valued as (
    select c.*,
      case when not c.requires_count then 0::bigint
        when c.ending_quantity = 0 then 0::bigint
        when c.ending_unit_cost_cents is null then null
        else round(c.ending_quantity * c.ending_unit_cost_cents)::bigint
      end as ending_value_cents
    from costed c
  )
  select v.*,
    case when p_purchase_source = 'manual_total' then null
      else v.opening_value_cents + v.selected_purchase_value_cents - v.ending_value_cents
    end::bigint as item_actual_usage_cents
  from valued v;

  if exists (
    select 1 from staxis_month_close_values v
    where v.requires_count
      and (v.ending_value_cents is null or (v.ending_quantity > 0 and v.ending_unit_cost_cents is null))
  ) then
    if p_purchase_source = 'manual_total' then
      raise exception 'every ending count needs its snapshotted unit cost for a manual-total close'
        using errcode = '22023';
    end if;
    raise exception 'opening inventory and logged purchases do not provide a complete valuation cost'
      using errcode = '22023';
  end if;

  if p_purchase_source <> 'manual_total' and exists (
    select 1 from staxis_month_close_values v where v.item_actual_usage_cents < 0
  ) then
    raise exception 'one or more items have negative actual usage; verify item counts and logged deliveries'
      using errcode = '22023';
  end if;

  select
    coalesce(sum(v.opening_value_cents), 0)::bigint,
    coalesce(sum(v.opening_adjustment_value_cents), 0)::bigint,
    coalesce(sum(v.ending_value_cents), 0)::bigint
  into v_beginning_cents, v_opening_adjustment_cents, v_ending_cents
  from staxis_month_close_values v;
  v_actual_cents := v_beginning_cents + v_confirmed_cents - v_ending_cents;
  if v_actual_cents < 0 then
    raise exception 'actual usage is negative; verify the ending count and purchase source'
      using errcode = '22023';
  end if;

  if p_purchase_source = 'manual_total' then
    v_by_category := null;
    v_by_item := null;
    v_by_budget_key := null;
  else
    select coalesce(jsonb_object_agg(x.category, x.cents), '{}'::jsonb)
      into v_by_category
    from (
      select v.category, sum(v.item_actual_usage_cents)::bigint as cents
      from staxis_month_close_values v group by v.category
    ) x;
    select coalesce(jsonb_object_agg(v.item_id::text, v.item_actual_usage_cents), '{}'::jsonb)
      into v_by_item
    from staxis_month_close_values v;
    select coalesce(jsonb_object_agg(x.budget_key, x.cents), '{}'::jsonb)
      into v_by_budget_key
    from (
      select v.budget_key, sum(v.item_actual_usage_cents)::bigint as cents
      from staxis_month_close_values v group by v.budget_key
    ) x;
  end if;

  v_quality_flags := coalesce(v_close.quality_flags, '[]'::jsonb);
  if exists (select 1 from staxis_month_close_values v where v.multiple_budget_sections) then
    v_quality_flags := v_quality_flags || jsonb_build_array(jsonb_build_object(
      'code', 'multiple_budget_sections',
      'message', 'One or more items map to multiple budget sections; the snapshotted lowest sort/id key won.'
    ));
  end if;
  if exists (select 1 from staxis_month_close_values v where not v.requires_count) then
    v_quality_flags := v_quality_flags || jsonb_build_array(jsonb_build_object(
      'code', 'archived_item_zero_ending',
      'message', 'Items archived during the period were snapshotted at zero ending on-hand and included in actual usage.',
      'count', (select count(*) from staxis_month_close_values v where not v.requires_count)
    ));
  end if;
  if exists (select 1 from staxis_month_close_values v where v.opening_adjustment_quantity > 0) then
    v_quality_flags := v_quality_flags || jsonb_build_array(jsonb_build_object(
      'code', 'opening_inventory_adjustment',
      'message', 'Pre-existing shelf stock was added to beginning inventory. It was not treated as a purchase or usage.',
      'count', (select count(*) from staxis_month_close_values v where v.opening_adjustment_quantity > 0),
      'amountCents', v_opening_adjustment_cents
    ));
  end if;

  insert into public.inventory_month_close_snapshots(property_id, kind, captured_at)
  values (p_property_id, 'ending', now())
  returning id into v_ending_snapshot_id;

  insert into public.inventory_month_close_snapshot_items (
    snapshot_id, property_id, item_id, item_name, category,
    custom_category_id, custom_category_name, budget_key,
    budget_section_ids, multiple_budget_sections, archived_at,
    quantity, set_aside, unit_cost_cents, physical_unit_cost_cents,
    value_cents, inventory_count_id, counted_at, valuation_method,
    purchase_quantity, purchase_value_cents, actual_usage_cents,
    opening_adjustment_quantity, opening_adjustment_unit_cost_cents,
    opening_adjustment_value_cents, opening_adjustment_at
  )
  select
    v_ending_snapshot_id, p_property_id, v.item_id, v.item_name, v.category,
    v.custom_category_id, v.custom_category_name, v.budget_key,
    v.budget_section_ids, v.multiple_budget_sections, v.archived_at,
    v.ending_quantity, v.ending_set_aside, v.ending_unit_cost_cents,
    v.physical_unit_cost_cents, v.ending_value_cents, v.count_id,
    v.counted_at,
    case
      when not v.requires_count then 'archived_zero'
      when p_purchase_source = 'logged_deliveries' then 'periodic_weighted_average'
      when p_purchase_source = 'zero' then 'opening_cost'
      else 'physical_count_cost'
    end,
    v.selected_purchase_quantity, v.selected_purchase_value_cents,
    v.item_actual_usage_cents,
    v.opening_adjustment_quantity, v.opening_adjustment_unit_cost_cents,
    v.opening_adjustment_value_cents, v.opening_adjustment_at
  from staxis_month_close_values v;

  if p_purchase_source = 'logged_deliveries' then
    insert into public.inventory_month_close_purchases (
      close_id, property_id, source_order_id, item_id, item_name, category,
      custom_category_id, custom_category_name, budget_key,
      budget_section_ids, multiple_budget_sections,
      received_at, quantity, unit_cost_cents, value_cents, vendor_name
    )
    select
      v_close.id, p_property_id, o.id, o.item_id, v.item_name, v.category,
      v.custom_category_id, v.custom_category_name, v.budget_key,
      v.budget_section_ids, v.multiple_budget_sections,
      o.received_at, o.quantity,
      case when o.unit_cost is not null then round(o.unit_cost * 100, 6)
        else round((o.total_cost / o.quantity) * 100, 6)
      end,
      round(coalesce(o.total_cost, o.quantity * o.unit_cost) * 100)::bigint,
      o.vendor_name
    from public.inventory_orders o
    join staxis_month_close_values v on v.item_id = o.item_id
    where o.property_id = p_property_id
      and o.received_at >= v_close.activity_start_at
      and o.received_at < v_close.end_at;
  end if;

  update public.inventory_month_closes
  set status = 'closed',
      ending_snapshot_id = v_ending_snapshot_id,
      purchase_source = p_purchase_source,
      allocation_mode = case when p_purchase_source = 'manual_total' then 'total_only' else 'itemized' end,
      manual_purchase_cents = case when p_purchase_source = 'manual_total' then p_manual_purchase_cents else null end,
      known_logged_purchase_cents = v_known_logged_cents,
      logged_purchase_cents = v_logged_cents,
      confirmed_purchase_cents = v_confirmed_cents,
      logged_delivery_count = v_logged_count,
      uncosted_delivery_count = v_uncosted_count,
      beginning_value_cents = v_beginning_cents,
      opening_adjustment_cents = v_opening_adjustment_cents,
      ending_value_cents = v_ending_cents,
      actual_usage_cents = v_actual_cents,
      by_category = v_by_category,
      by_item = v_by_item,
      by_budget_key = v_by_budget_key,
      quality_flags = v_quality_flags,
      closed_at = now(),
      closed_by = p_actor_id,
      closed_by_name = nullif(trim(p_actor_name), ''),
      notes = nullif(trim(p_notes), ''),
      close_request_id = p_request_id
  where id = v_close.id and property_id = p_property_id;

  -- Exact carry-forward: the immutable ending snapshot is the next opening.
  -- ON CONFLICT preserves a deliberate rebaseline/gap repair if one already
  -- exists; an old missed month therefore never strands the current month.
  v_next_month := (p_month_start + interval '1 month')::date;
  insert into public.inventory_month_closes (
    property_id, month_start, timezone, status,
    month_start_at, end_at, grace_end_at, count_window_start_at,
    activity_start_at, is_partial, budget_comparison_available,
    opening_snapshot_id, beginning_value_cents, baseline_at,
    opened_by, opened_by_name, quality_flags
  ) values (
    p_property_id, v_next_month, v_timezone, 'open',
    v_close.end_at,
    (v_next_month + interval '1 month')::timestamp at time zone v_timezone,
    (v_next_month + interval '1 month 3 days')::timestamp at time zone v_timezone,
    (v_next_month + interval '1 month' - interval '1 day')::timestamp at time zone v_timezone,
    v_close.end_at, false, true,
    v_ending_snapshot_id, v_ending_cents, now(),
    p_actor_id, nullif(trim(p_actor_name), ''),
    case when exists (select 1 from staxis_month_close_values v where v.multiple_budget_sections)
      then jsonb_build_array(jsonb_build_object(
        'code', 'multiple_budget_sections',
        'message', 'Opening snapshot contains an item assigned to multiple budget sections.'
      ))
      else '[]'::jsonb
    end
  )
  on conflict (property_id, month_start) do nothing;

  return v_close.id;
end
$$;

revoke all on function public.staxis_close_inventory_month_close(uuid, date, uuid, text, bigint, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.staxis_close_inventory_month_close(uuid, date, uuid, text, bigint, uuid, text, text)
  to service_role;

insert into public.applied_migrations(version, description)
values (
  '0322',
  'Inventory month close: immutable baseline/ending/purchase/opening-adjustment evidence; property-local periods; usage equation; explicit purchase source; final-local-day + three-day-grace counts; exact carry-forward and idempotent atomic RPCs.'
)
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
